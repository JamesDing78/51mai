// @vitest-environment node

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Router } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import type { Pool } from 'mysql2/promise';
import { createApp } from '../app.js';
import { loadConfig, loadDatabaseConfig } from '../config.js';
import { startServer } from '../main.js';
import { migrate, orderMigrationFiles } from './migrate.js';
import { createPool } from './pool.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStaticFixture(): Promise<{ directory: string; indexFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), '51mai-task1-'));
  tempDirectories.push(directory);
  const indexFile = join(directory, 'index.html');
  await writeFile(indexFile, '<!doctype html><title>51mai</title>', 'utf8');
  await mkdir(join(directory, 'server'), { recursive: true });
  await writeFile(join(directory, 'server', 'main.ts'), 'source fixture', 'utf8');
  await writeFile(join(directory, '.env'), 'secret fixture', 'utf8');
  return { directory, indexFile };
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe('createApp', () => {
  it('keeps API errors JSON, rejects non-JSON and oversized bodies, and protects the SPA boundary', async () => {
    const { directory, indexFile } = await createStaticFixture();
    const apiRouter: Router = express.Router();
    apiRouter.post('/echo', (request, response) => response.json({ data: request.body }));
    const app = createApp({ apiRouter, staticDir: directory, indexFile });
    const { server, baseUrl } = await listen(app);

    try {
      const missingApi = await fetch(`${baseUrl}/api/does-not-exist`);
      expect(missingApi.status).toBe(404);
      expect(missingApi.headers.get('content-type')).toContain('application/json');
      await expect(missingApi.json()).resolves.toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });

      const wrongContentType = await fetch(`${baseUrl}/api/echo`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      });
      expect(wrongContentType.status).toBe(415);
      await expect(wrongContentType.json()).resolves.toEqual({
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' },
      });

      const malformedJson = await fetch(`${baseUrl}/api/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      expect(malformedJson.status).toBe(400);
      const malformedBody = await malformedJson.text();
      expect(malformedBody).not.toContain('SyntaxError');
      expect(malformedBody).not.toContain('at ');

      const oversized = await fetch(`${baseUrl}/api/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(17 * 1024) }),
      });
      expect(oversized.status).toBe(413);
      await expect(oversized.json()).resolves.toEqual({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
      });

      const spaFallback = await fetch(`${baseUrl}/catalog`);
      expect(spaFallback.status).toBe(200);
      expect(await spaFallback.text()).toContain('<title>51mai</title>');

      const sourceProbe = await fetch(`${baseUrl}/server/.env`);
      expect(sourceProbe.status).toBe(404);
      expect(await sourceProbe.text()).not.toContain('<title>51mai</title>');

      for (const encodedSourcePath of ['/server%2Fmain.ts', '/server%252Fmain.ts', '/%2e%2e/server/main.ts', '/.%65nv']) {
        const encodedSourceProbe = await fetch(`${baseUrl}${encodedSourcePath}`);
        expect(encodedSourceProbe.status).toBe(404);
        const encodedSourceBody = await encodedSourceProbe.text();
        expect(encodedSourceBody).not.toContain('source fixture');
        expect(encodedSourceBody).not.toContain('<title>51mai</title>');
      }

      expect(missingApi.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(missingApi.headers.get('x-content-type-options')).toBe('nosniff');
      expect(missingApi.headers.get('referrer-policy')).toBe('no-referrer');
      expect(missingApi.headers.get('strict-transport-security')).toBeNull();
    } finally {
      await close(server);
    }
  });
});

describe('production configuration and server startup', () => {
  const productionEnvironment = {
    NODE_ENV: 'production',
    ALLOWED_ORIGIN: 'https://51mai.marginpage.com',
    AUTH_HMAC_KEY: Buffer.alloc(32, 7).toString('base64url'),
    DB_USER: 'fixture-user',
    DB_PASSWORD: 'fixture-password',
    DB_NAME: 'fixture-db',
  };

  it('requires HTTPS origin, a valid __Host- cookie name, and a database password in production', () => {
    expect(() => loadConfig({ ...productionEnvironment, ALLOWED_ORIGIN: 'http://51mai.marginpage.com' })).toThrow(
      'ALLOWED_ORIGIN must use https in production',
    );
    expect(() => loadConfig({ ...productionEnvironment, SESSION_COOKIE_NAME: '51mai_session' })).toThrow(
      'SESSION_COOKIE_NAME must use a non-empty __Host- prefix in production',
    );
    expect(() => loadConfig({ ...productionEnvironment, SESSION_COOKIE_NAME: '__Host-bad name' })).toThrow(
      'SESSION_COOKIE_NAME must be a valid cookie token',
    );
    expect(() => loadConfig({ ...productionEnvironment, DB_PASSWORD: '' })).toThrow('DB_PASSWORD is required in production');

    const config = loadConfig({ ...productionEnvironment, SESSION_COOKIE_NAME: '__Host-fixture' });
    expect(config.cookieName).toBe('__Host-fixture');
    expect(config.allowOrigin).toBe('https://51mai.marginpage.com');
  });

  it('closes the pool when the startup database health check fails', async () => {
    let queried = false;
    let ended = false;
    const pool = {
      query: async (): Promise<never> => {
        queried = true;
        throw new Error('database unavailable');
      },
      end: async (): Promise<void> => {
        ended = true;
      },
    } as unknown as Pool;

    const config = loadConfig({ NODE_ENV: 'test', DB_USER: 'fixture-user', DB_NAME: 'fixture-db' });
    await expect(startServer(config, { createPool: () => pool })).rejects.toThrow('database unavailable');
    expect(queried).toBe(true);
    expect(ended).toBe(true);
  });
});

type QueryResult = [unknown, unknown];
type FakeMigrationState = { checksum: string; status: string; lastStep: number };
type FakeState = { migrations?: Record<string, FakeMigrationState>; applied?: FakeMigrationState; failAt?: number; failed?: boolean };

class FakeConnection {
  readonly executed: Array<{ sql: string; params?: unknown[] }> = [];
  readonly queries: string[] = [];
  readonly state: FakeState;

  constructor(state: FakeState) {
    this.state = state;
    this.state.migrations ??= {};
  }

  private migration(version: unknown): FakeMigrationState | undefined {
    return this.state.migrations?.[String(version)];
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.executed.push({ sql, params });
    if (sql.includes('GET_LOCK')) return [[{ lock_acquired: 1 }], []];
    if (sql.includes('RELEASE_LOCK')) return [[{ lock_released: 1 }], []];
    if (sql.includes('SELECT version, checksum, status, last_step')) {
      const version = String(params[0]);
      const record = this.migration(version);
      return [record ? [{ version, checksum: record.checksum, status: record.status, last_step: record.lastStep }] : [], []];
    }
    if (sql.includes('INSERT INTO schema_migrations')) {
      const version = String(params[0]);
      const record = { checksum: String(params[1]), status: 'applying', lastStep: 0 };
      this.state.migrations![version] = record;
      this.state.applied = record;
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes("SET status = 'applied'")) {
      const record = this.migration(params[1]);
      if (!record) throw new Error('migration row missing');
      record.status = 'applied';
      record.lastStep = Number(params[0]);
      this.state.applied = record;
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes("SET status = 'failed'")) {
      this.state.failed = true;
      const record = this.migration(params[1]);
      if (record) record.status = 'failed';
      if (record) this.state.applied = record;
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes('SET last_step')) {
      if (this.state.failAt && Number(params[0]) >= this.state.failAt) throw new Error('step marker failure');
      const record = this.migration(params[1]);
      if (record) record.lastStep = Number(params[0]);
      if (record) this.state.applied = record;
      return [{ affectedRows: 1 }, []];
    }
    return [[], []];
  }

  async query(sql: string): Promise<QueryResult> {
    this.queries.push(sql);
    if (sql.includes('CREATE TABLE')) {
      if (this.state.failAt === this.queries.length) throw new Error('DDL failure');
      return [[], []];
    }
    return [[], []];
  }

  release(): void {}
}

class FakePool {
  readonly state: FakeState;
  readonly connection: FakeConnection;

  constructor(state: FakeState) {
    this.state = state;
    this.connection = new FakeConnection(state);
  }

  async getConnection(): Promise<FakeConnection> {
    return this.connection;
  }
}

describe('migrate', () => {
  it('applies the auth migration once and leaves a second run unchanged', async () => {
    const state: FakeState = {};
    const pool = new FakePool(state) as unknown as Pool;

    await migrate(pool);
    const firstDdlCount = (pool as unknown as FakePool).connection.queries.filter(
      (sql) => sql.includes('CREATE TABLE') && !sql.includes('schema_migrations'),
    ).length;
    expect(state.applied?.status).toBe('applied');
    expect(state.applied?.lastStep).toBeGreaterThan(0);

    await migrate(pool);
    const secondDdlCount = (pool as unknown as FakePool).connection.queries.filter(
      (sql) => sql.includes('CREATE TABLE') && !sql.includes('schema_migrations'),
    ).length;
    expect(secondDdlCount).toBe(firstDdlCount);
  });

  it('records a failed migration and refuses an automatic retry', async () => {
    const state: FakeState = { failAt: 3 };
    const pool = new FakePool(state) as unknown as Pool;

    await expect(migrate(pool)).rejects.toThrow('DDL failure');
    expect(state.failed).toBe(true);
    const ddlBeforeRetry = (pool as unknown as FakePool).connection.queries.filter(
      (sql) => sql.includes('CREATE TABLE') && !sql.includes('schema_migrations'),
    ).length;

    state.failAt = undefined;
    await expect(migrate(pool)).rejects.toThrow(/failed and requires explicit repair/i);
    expect(
      (pool as unknown as FakePool).connection.queries.filter(
        (sql) => sql.includes('CREATE TABLE') && !sql.includes('schema_migrations'),
      ).length,
    ).toBe(ddlBeforeRetry);
  });
});

describe('migration source selection', () => {
  it('orders numeric versions, rejects mixed widths, and rejects duplicate versions', () => {
    expect(orderMigrationFiles(['010_tenth.sql', '002_second.sql', '001_first.sql'])).toEqual([
      '001_first.sql',
      '002_second.sql',
      '010_tenth.sql',
    ]);
    expect(() => orderMigrationFiles(['001_first.sql', '10_tenth.sql'])).toThrow(
      'Migration version prefixes must use a consistent width',
    );
    expect(() => orderMigrationFiles(['001_first.sql', '001_second.sql'])).toThrow('Duplicate migration version prefix');
  });

  it('fails closed when an explicit MIGRATIONS_DIR is missing, empty, or blank', async () => {
    const emptyDirectory = await mkdtemp(join(tmpdir(), '51mai-empty-migrations-'));
    tempDirectories.push(emptyDirectory);
    const pool = new FakePool({}) as unknown as Pool;
    const previousDirectory = process.env.MIGRATIONS_DIR;

    try {
      process.env.MIGRATIONS_DIR = join(emptyDirectory, 'missing');
      await expect(migrate(pool)).rejects.toThrow('MIGRATIONS_DIR is unavailable');

      process.env.MIGRATIONS_DIR = emptyDirectory;
      await expect(migrate(pool)).rejects.toThrow('MIGRATIONS_DIR contains no valid SQL migration files');

      process.env.MIGRATIONS_DIR = '';
      await expect(migrate(pool)).rejects.toThrow('MIGRATIONS_DIR must not be empty');
    } finally {
      if (previousDirectory === undefined) delete process.env.MIGRATIONS_DIR;
      else process.env.MIGRATIONS_DIR = previousDirectory;
    }
  });
});

it('keeps the migration source present for the explicit migration command', async () => {
  const source = await readFile(new URL('./migrations/001_auth.sql', import.meta.url), 'utf8');
  expect(source).toContain('CREATE TABLE');
  expect(source).toContain('users');
  expect(source).toContain('verification_challenges');
});

interface TableRow extends RowDataPacket {
  TABLE_NAME: string;
}

interface MigrationRow extends RowDataPacket {
  version: string;
  checksum: string;
  status: string;
  last_step: number;
}

const explicitTestDatabase = (process.env.TEST_DATABASE_NAME ?? process.env.TEST_DB_NAME)?.trim();
const testDatabaseAllowlist = new Set(
  (process.env.TEST_DATABASE_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const integrationRequested = Boolean(explicitTestDatabase || testDatabaseAllowlist.size > 0);
const integrationConfigurationError = integrationRequested
  ? !explicitTestDatabase
    ? 'TEST_DATABASE_NAME must explicitly name the integration database'
    : !testDatabaseAllowlist.has(explicitTestDatabase)
      ? 'TEST_DATABASE_NAME must be present in TEST_DATABASE_ALLOWLIST'
      : process.env.DB_NAME !== explicitTestDatabase
        ? 'DB_NAME must exactly match TEST_DATABASE_NAME for integration tests'
        : undefined
  : undefined;
const integrationEnabled = integrationRequested && !integrationConfigurationError;

it.skipIf(!integrationRequested)('rejects an ambiguous integration database configuration', () => {
  expect(integrationConfigurationError).toBeUndefined();
});

it.skipIf(!integrationEnabled)('migrates the explicitly allowlisted MySQL test database idempotently without clearing data', async () => {
  if (!explicitTestDatabase) throw new Error('missing explicit test database name');
  const pool = createPool({ ...loadDatabaseConfig(), database: explicitTestDatabase });
  try {
    const [beforeRows] = await pool.query<TableRow[]>(
      'SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [explicitTestDatabase],
    );
    const beforeTables = beforeRows.map((row) => row.TABLE_NAME);
    let sentinelUserId: string | undefined;
    if (beforeTables.includes('users')) {
      sentinelUserId = randomUUID();
      await pool.execute(
        "INSERT INTO users (id, username_normalized, password_hash, account_status, role) VALUES (?, ?, NULL, 'active', 'customer')",
        [sentinelUserId, `migration_sentinel_${sentinelUserId.slice(0, 8)}`],
      );
    }

    const [poolTimezoneRows] = await pool.query<RowDataPacket[]>('SELECT @@session.time_zone AS time_zone');
    expect(poolTimezoneRows[0]?.time_zone).toBe('+00:00');

    const connection = await pool.getConnection();
    try {
      const [timezoneRows] = await connection.query<RowDataPacket[]>('SELECT @@session.time_zone AS time_zone');
      expect(timezoneRows[0]?.time_zone).toBe('+00:00');
    } finally {
      connection.release();
    }

    await migrate(pool);
    const [firstTables] = await pool.query<TableRow[]>(
      'SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [explicitTestDatabase],
    );
    const [firstMigrations] = await pool.query<MigrationRow[]>(
      'SELECT version, checksum, status, last_step FROM schema_migrations ORDER BY version',
    );
    const authMigration = firstMigrations.find((row) => row.version === '001_auth');
    expect(authMigration?.status).toBe('applied');
    expect(authMigration?.last_step).toBeGreaterThan(0);
    if (sentinelUserId !== undefined) {
      const [sentinelRows] = await pool.query<RowDataPacket[]>('SELECT id FROM users WHERE id = ?', [sentinelUserId]);
      expect(sentinelRows).toHaveLength(1);
    }

    await migrate(pool);
    const [secondTables] = await pool.query<TableRow[]>(
      'SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [explicitTestDatabase],
    );
    const [secondMigrations] = await pool.query<MigrationRow[]>(
      'SELECT version, checksum, status, last_step FROM schema_migrations ORDER BY version',
    );
    expect(secondTables.map((row) => row.TABLE_NAME)).toEqual(firstTables.map((row) => row.TABLE_NAME));
    expect(secondMigrations).toEqual(firstMigrations);
  } finally {
    if (typeof sentinelUserId !== 'undefined') await pool.execute('DELETE FROM users WHERE id = ?', [sentinelUserId]).catch(() => undefined);
    await pool.end();
  }
});
