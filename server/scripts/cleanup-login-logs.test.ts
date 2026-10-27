// @vitest-environment node

import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDatabaseConfig, type AppConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import {
  assertApplyAllowed,
  cleanupLoginLogs,
  parseCleanupMode,
} from './cleanup-login-logs.js';

const explicitTestDatabase = (process.env.TEST_DATABASE_NAME ?? process.env.TEST_DB_NAME)?.trim();
const testDatabaseAllowlist = new Set(
  (process.env.TEST_DATABASE_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const integrationRequested = Boolean(explicitTestDatabase || testDatabaseAllowlist.size > 0);
const integrationEnabled =
  Boolean(explicitTestDatabase) &&
  testDatabaseAllowlist.has(explicitTestDatabase as string) &&
  process.env.DB_NAME === explicitTestDatabase;

const testNodeEnv: AppConfig['nodeEnv'] = process.env.NODE_ENV === 'production' ? 'production' : 'test';

describe('login-log cleanup safety', () => {
  it('defaults to dry-run and never issues a delete', async () => {
    const statements: string[] = [];
    const fakeConnection = {
      execute: async (sql: string): Promise<[unknown[], unknown[]]> => {
        statements.push(sql);
        if (sql.startsWith('SELECT UTC_TIMESTAMP')) return [[{ cutoff_at: '2026-09-23 00:00:00.000000' }], []];
        if (sql.startsWith('SELECT COUNT')) return [[{ matching_rows: '2' }], []];
        throw new Error(`unexpected statement: ${sql}`);
      },
    } as unknown as PoolConnection;

    const result = await cleanupLoginLogs(fakeConnection);

    expect(result).toEqual({
      mode: 'dry-run',
      cutoffAt: '2026-09-23 00:00:00.000000',
      matchedRows: 2,
      deletedRows: 0,
    });
    expect(statements.some((statement) => statement.startsWith('DELETE'))).toBe(false);
  });

  it('requires an explicit apply flag and rejects conflicting mode flags', () => {
    expect(parseCleanupMode([])).toBe('dry-run');
    expect(parseCleanupMode(['--dry-run'])).toBe('dry-run');
    expect(parseCleanupMode(['--apply'])).toBe('apply');
    expect(() => parseCleanupMode(['--apply', '--dry-run'])).toThrow('cleanup mode flags cannot be combined');
    expect(() => parseCleanupMode(['--unknown'])).toThrow('unknown argument');
  });

  it('rejects production apply before any database write', () => {
    expect(() =>
      assertApplyAllowed({
        nodeEnv: 'production',
        databaseName: '51mai_test',
        environment: {
          NODE_ENV: 'production',
          DB_NAME: '51mai_test',
          TEST_DATABASE_NAME: '51mai_test',
          TEST_DATABASE_ALLOWLIST: '51mai_test',
        },
      }),
    ).toThrow('disabled in production');
  });

  it('requires the current database to exactly match the explicit allowlisted test database', () => {
    expect(() =>
      assertApplyAllowed({
        nodeEnv: testNodeEnv,
        databaseName: '51mai_app',
        environment: {
          DB_NAME: '51mai_app',
          TEST_DATABASE_NAME: '51mai_test',
          TEST_DATABASE_ALLOWLIST: '51mai_test',
        },
      }),
    ).toThrow('explicitly allowlisted test database');
  });
});

describe.skipIf(!integrationRequested)('login-log cleanup integration configuration guard', () => {
  it('requires an explicitly named allowlisted database', () => {
    expect(integrationEnabled).toBe(true);
  });
});

describe.skipIf(!integrationEnabled)('login-log cleanup against the isolated test database', () => {
  let pool: Pool;

  afterAll(async () => {
    await pool?.end();
  });

  it('deletes only the 31-day fixture and retains the 29-day fixture, then rolls back', async () => {
    if (!explicitTestDatabase) throw new Error('missing explicit test database name');
    pool = createPool({ ...loadDatabaseConfig(), database: explicitTestDatabase });
    const connection = await pool.getConnection();
    const userId = randomUUID();
    const oldLogId = randomUUID();
    const newLogId = randomUUID();
    const username = `task5_retention_${randomUUID().slice(0, 8)}`;

    await connection.beginTransaction();
    try {
      await connection.execute(
        `INSERT INTO users (id, username_normalized, password_hash, account_status, role)
         VALUES (?, ?, NULL, 'active', 'customer')`,
        [userId, username],
      );
      await connection.execute(
        `INSERT INTO login_logs (id, user_id, succeeded, attempted_at, ip_address, user_agent)
         VALUES (?, ?, 1, UTC_TIMESTAMP(6) - INTERVAL 31 DAY, INET6_ATON('192.0.2.41'), 'task5-old-fixture'),
                (?, ?, 1, UTC_TIMESTAMP(6) - INTERVAL 29 DAY, INET6_ATON('192.0.2.42'), 'task5-new-fixture')`,
        [oldLogId, userId, newLogId, userId],
      );

      const result = await cleanupLoginLogs(connection, 'apply');
      expect(result.mode).toBe('apply');
      expect(result.matchedRows).toBe(1);
      expect(result.deletedRows).toBe(1);

      const [remainingRows] = await connection.query<Array<{ id: string }>>(
        'SELECT id FROM login_logs WHERE id IN (?, ?) ORDER BY id',
        [oldLogId, newLogId],
      );
      expect(remainingRows.map((row) => row.id)).toEqual([newLogId].sort());
    } finally {
      await connection.rollback();
      connection.release();
    }

    const [persistedRows] = await pool.query<Array<{ id: string }>>(
      'SELECT id FROM login_logs WHERE id IN (?, ?)',
      [oldLogId, newLogId],
    );
    expect(persistedRows).toHaveLength(0);
    const [persistedUsers] = await pool.query<Array<{ id: string }>>('SELECT id FROM users WHERE id = ?', [userId]);
    expect(persistedUsers).toHaveLength(0);
  });
});
