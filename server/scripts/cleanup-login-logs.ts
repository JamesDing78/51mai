import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { loadConfig, type AppConfig } from '../config.js';
import { createPool } from '../db/pool.js';

export type CleanupMode = 'dry-run' | 'apply';

export interface CleanupResult {
  mode: CleanupMode;
  cutoffAt: string;
  matchedRows: number;
  deletedRows: number;
}

type Environment = Record<string, string | undefined>;
type CleanupConnection = Pick<PoolConnection, 'execute'>;

interface CutoffRow extends RowDataPacket {
  cutoff_at: string | Date;
}

interface CountRow extends RowDataPacket {
  matching_rows: number | string;
}

function readAllowlist(environment: Environment): Set<string> {
  return new Set(
    (environment.TEST_DATABASE_ALLOWLIST ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * Apply is deliberately limited to an explicitly named, allowlisted test database.
 * Production writes remain disabled until a separately approved maintenance path exists.
 */
export function assertApplyAllowed(options: {
  nodeEnv: AppConfig['nodeEnv'];
  databaseName: string;
  environment?: Environment;
}): void {
  if (options.nodeEnv === 'production') {
    throw new Error('login-log cleanup apply is disabled in production');
  }

  const environment = options.environment ?? process.env;
  const explicitTestDatabase = (environment.TEST_DATABASE_NAME ?? environment.TEST_DB_NAME)?.trim();
  if (!explicitTestDatabase || !readAllowlist(environment).has(explicitTestDatabase) || options.databaseName !== explicitTestDatabase) {
    throw new Error('login-log cleanup apply requires the explicitly allowlisted test database');
  }
}

export function parseCleanupMode(argumentsList: readonly string[]): CleanupMode {
  let mode: CleanupMode = 'dry-run';
  let seenModeFlag: string | undefined;
  for (const argument of argumentsList) {
    if (argument === '--apply') {
      if (seenModeFlag) {
        throw new Error(seenModeFlag === '--apply' ? 'cleanup mode was specified more than once' : 'cleanup mode flags cannot be combined');
      }
      seenModeFlag = argument;
      mode = 'apply';
      continue;
    }
    if (argument === '--dry-run') {
      if (seenModeFlag) {
        throw new Error(seenModeFlag === '--dry-run' ? 'cleanup mode was specified more than once' : 'cleanup mode flags cannot be combined');
      }
      seenModeFlag = argument;
      mode = 'dry-run';
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return mode;
}

function safeCount(value: number | string | undefined): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('database returned an invalid login-log count');
  return count;
}

/**
 * Count or remove rows older than the server's UTC timestamp minus 30 days.
 * The caller owns transaction boundaries so tests can roll back all fixtures.
 */
export async function cleanupLoginLogs(connection: CleanupConnection, mode: CleanupMode = 'dry-run'): Promise<CleanupResult> {
  const [cutoffRows] = await connection.execute<CutoffRow[]>(
    'SELECT UTC_TIMESTAMP(6) - INTERVAL 30 DAY AS cutoff_at',
  );
  const cutoffValue = cutoffRows[0]?.cutoff_at;
  if (cutoffValue === undefined || cutoffValue === null) throw new Error('database did not return a UTC retention cutoff');
  const cutoffAt = cutoffValue instanceof Date ? cutoffValue.toISOString() : String(cutoffValue);

  const [countRows] = await connection.execute<CountRow[]>(
    'SELECT COUNT(*) AS matching_rows FROM login_logs WHERE attempted_at < ?',
    [cutoffAt],
  );
  const matchedRows = safeCount(countRows[0]?.matching_rows);
  let deletedRows = 0;
  if (mode === 'apply') {
    const [deleteResult] = await connection.execute<ResultSetHeader>(
      'DELETE FROM login_logs WHERE attempted_at < ?',
      [cutoffAt],
    );
    deletedRows = deleteResult.affectedRows;
  }

  return { mode, cutoffAt, matchedRows, deletedRows };
}

async function executeCleanup(pool: Pool, mode: CleanupMode): Promise<CleanupResult> {
  const connection = await pool.getConnection();
  let committed = false;
  try {
    if (mode === 'apply') await connection.beginTransaction();
    const result = await cleanupLoginLogs(connection, mode);
    if (mode === 'apply') {
      await connection.commit();
      committed = true;
    }
    return result;
  } finally {
    if (mode === 'apply' && !committed) await connection.rollback().catch(() => undefined);
    connection.release();
  }
}

export async function runCleanup(environment: Environment = process.env, argumentsList: readonly string[] = process.argv.slice(2)): Promise<CleanupResult> {
  const mode = parseCleanupMode(argumentsList);
  const config = loadConfig(environment);
  if (mode === 'apply') {
    assertApplyAllowed({ nodeEnv: config.nodeEnv, databaseName: config.database.database, environment });
  }

  const pool = createPool(config.database);
  try {
    return await executeCleanup(pool, mode);
  } finally {
    await pool.end();
  }
}

function printResult(result: CleanupResult): void {
  console.log(`mode=${result.mode}`);
  console.log(`cutoff_at=${result.cutoffAt}`);
  console.log(`matched_rows=${result.matchedRows}`);
  console.log(`deleted_rows=${result.deletedRows}`);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  runCleanup()
    .then(printResult)
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
