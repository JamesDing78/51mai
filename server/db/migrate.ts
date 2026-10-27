import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { loadDatabaseConfig } from '../config.js';
import { configureConnection, createPool } from './pool.js';

const MIGRATION_LOCK_NAME = '51mai:schema:migrations';
const MIGRATION_LOCK_TIMEOUT_SECONDS = 30;
const BOOTSTRAP_SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('applying', 'applied', 'failed') NOT NULL,
  last_step INT UNSIGNED NOT NULL DEFAULT 0,
  applied_at DATETIME(6) NULL,
  failed_at DATETIME(6) NULL,
  error_message VARCHAR(512) NULL,
  PRIMARY KEY (version)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;
`;

interface MigrationSource {
  version: string;
  source: string;
  checksum: string;
}

interface MigrationRecord {
  version: string;
  checksum: string;
  status: 'applying' | 'applied' | 'failed';
  last_step: number;
}

interface LockRow {
  lock_acquired?: number;
  lock_released?: number;
}

const MIGRATION_FILE_PATTERN = /^(\d+)_([a-z0-9-]+)\.sql$/i;

function asErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        current += character;
      }
      continue;
    }

    if (!quote && character === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (quote) {
      current += character;
      if (character === '\\' && next) {
        current += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }

    if (character === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

function configuredMigrationDirectory(): string | undefined {
  const configured = process.env.MIGRATIONS_DIR;
  if (configured === undefined) return undefined;
  if (!configured.trim()) throw new Error('MIGRATIONS_DIR must not be empty');
  return path.resolve(configured.trim());
}

function migrationDirectory(): string[] {
  const configured = configuredMigrationDirectory();
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [
    ...(configured ? [configured] : []),
    path.resolve(process.cwd(), 'server/db/migrations'),
    path.resolve(moduleDirectory, 'migrations'),
  ];
}

async function findMigrationDirectory(): Promise<string> {
  const configured = configuredMigrationDirectory();
  if (configured) {
    let files: string[];
    try {
      files = await readdir(configured);
    } catch {
      throw new Error(`MIGRATIONS_DIR is unavailable: ${configured}`);
    }
    if (!files.some((file) => MIGRATION_FILE_PATTERN.test(file))) {
      throw new Error(`MIGRATIONS_DIR contains no valid SQL migration files: ${configured}`);
    }
    return configured;
  }

  for (const directory of migrationDirectory()) {
    try {
      const files = await readdir(directory);
      if (files.some((file) => MIGRATION_FILE_PATTERN.test(file))) return directory;
    } catch {
      // Try the next default source/build location.
    }
  }
  throw new Error('No SQL migration directory was found');
}

export function orderMigrationFiles(files: string[]): string[] {
  const parsed = files.map((file) => {
    const match = MIGRATION_FILE_PATTERN.exec(file);
    if (!match) throw new Error(`Invalid migration file name: ${file}`);
    return { file, prefix: match[1], number: BigInt(match[1]) };
  });
  const widths = new Set(parsed.map(({ prefix }) => prefix.length));
  if (widths.size > 1) throw new Error('Migration version prefixes must use a consistent width');

  const seenNumbers = new Set<string>();
  for (const migration of parsed) {
    const number = migration.number.toString();
    if (seenNumbers.has(number)) throw new Error(`Duplicate migration version prefix: ${migration.prefix}`);
    seenNumbers.add(number);
  }

  return parsed
    .sort((left, right) => (left.number < right.number ? -1 : left.number > right.number ? 1 : left.file.localeCompare(right.file, 'en')))
    .map(({ file }) => file);
}

async function readMigrations(): Promise<MigrationSource[]> {
  const directory = await findMigrationDirectory();
  const files = (await readdir(directory))
    .filter((file) => MIGRATION_FILE_PATTERN.test(file));
  const orderedFiles = orderMigrationFiles(files);
  if (orderedFiles.length === 0) throw new Error('No SQL migration files were found');

  return Promise.all(
    orderedFiles.map(async (file) => {
      const source = await readFile(path.join(directory, file), 'utf8');
      const version = file.replace(/\.sql$/i, '');
      return { version, source, checksum: createHash('sha256').update(source, 'utf8').digest('hex') };
    }),
  );
}

async function execute<T>(connection: PoolConnection, sql: string, values: readonly unknown[] = []): Promise<T> {
  const [rows] = await connection.execute(sql, values as unknown[] as never[]);
  return rows as T;
}

async function query(connection: PoolConnection, sql: string): Promise<void> {
  await connection.query(sql);
}

async function applyMigration(connection: PoolConnection, migration: MigrationSource): Promise<void> {
  const rows = await execute<MigrationRecord[]>(
    connection,
    'SELECT version, checksum, status, last_step FROM schema_migrations WHERE version = ? FOR UPDATE',
    [migration.version],
  );
  const existing = rows[0];

  if (existing) {
    if (existing.checksum !== migration.checksum) {
      throw new Error(`Migration ${migration.version} checksum mismatch; explicit repair is required`);
    }
    if (existing.status === 'applied') return;
    if (existing.status === 'failed' || existing.status === 'applying') {
      throw new Error(`Migration ${migration.version} is ${existing.status} and requires explicit repair`);
    }
  }

  const statements = splitSqlStatements(migration.source);
  if (statements.length === 0) throw new Error(`Migration ${migration.version} is empty`);

  await execute(
    connection,
    `INSERT INTO schema_migrations (version, checksum, status, last_step)
     VALUES (?, ?, 'applying', 0)`,
    [migration.version, migration.checksum],
  );

  try {
    for (let index = 0; index < statements.length; index += 1) {
      await query(connection, statements[index]);
      await execute(
        connection,
        'UPDATE schema_migrations SET last_step = ?, error_message = NULL WHERE version = ?',
        [index + 1, migration.version],
      );
    }
    await execute(
      connection,
      `UPDATE schema_migrations
       SET status = 'applied', last_step = ?, applied_at = UTC_TIMESTAMP(6), failed_at = NULL, error_message = NULL
       WHERE version = ?`,
      [statements.length, migration.version],
    );
  } catch (error) {
    try {
      await execute(
        connection,
        `UPDATE schema_migrations
         SET status = 'failed', failed_at = UTC_TIMESTAMP(6), error_message = ?
         WHERE version = ?`,
        [asErrorMessage(error), migration.version],
      );
    } catch {
      // Preserve the original DDL error. The row may be unavailable after an implicit DDL commit.
    }
    throw error;
  }
}

export async function migrate(pool: Pool): Promise<void> {
  const migrations = await readMigrations();
  const connection = await pool.getConnection();
  let lockHeld = false;

  try {
    await configureConnection(connection);
    const lockRows = await execute<LockRow[]>(
      connection,
      'SELECT GET_LOCK(?, ?) AS lock_acquired',
      [MIGRATION_LOCK_NAME, MIGRATION_LOCK_TIMEOUT_SECONDS],
    );
    if (lockRows[0]?.lock_acquired !== 1) throw new Error('Could not acquire the schema migration lock');
    lockHeld = true;

    // MySQL DDL can implicitly commit, so migration state is recorded after every statement.
    await query(connection, BOOTSTRAP_SCHEMA_MIGRATIONS);
    for (const migration of migrations) await applyMigration(connection, migration);
  } finally {
    if (lockHeld) {
      try {
        await execute(connection, 'SELECT RELEASE_LOCK(?) AS lock_released', [MIGRATION_LOCK_NAME]);
      } catch {
        // Do not mask a migration error with an advisory-lock cleanup error.
      }
    }
    connection.release();
  }
}

async function runMigrationCommand(): Promise<void> {
  const pool = createPool(loadDatabaseConfig());
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  runMigrationCommand().catch((error: unknown) => {
    console.error(`Migration failed: ${asErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
