// @vitest-environment node

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import type { Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyLoginPassword, verifyPassword } from './password.js';
import {
  resolveAuthHmacKey,
  SessionManager,
  type AuthUser,
  type IssuedSession,
  parseCookieHeader,
} from './sessions.js';
import { requireAdmin, requireAllowedOrigin, requireSession, requestSourceIp } from './guards.js';
import { PersistentRateLimiter } from './rate-limit.js';

describe('password security primitives', () => {
  it('hashes valid passwords with an independent salt and verifies only the original password', async () => {
    const first = await hashPassword('correct horse');
    const second = await hashPassword('correct horse');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt\$v1\$N=131072,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    await expect(verifyPassword('correct horse', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse', first)).resolves.toBe(false);
    await expect(verifyPassword('correct horse', second)).resolves.toBe(true);
    await expect(verifyPassword('correct horse', 'not-a-password-hash')).resolves.toBe(false);
    await expect(verifyPassword('correct horse', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  }, 30_000);

  it('enforces only the eight-to-twenty character password boundary without normalizing input', async () => {
    await expect(hashPassword('short')).rejects.toMatchObject({ code: 'PASSWORD_LENGTH' });
    await expect(hashPassword('123456789012345678901')).rejects.toMatchObject({ code: 'PASSWORD_LENGTH' });
    const hash = await hashPassword('  eight  ');
    await expect(verifyPassword('  eight  ', hash)).resolves.toBe(true);
    await expect(verifyPassword('eight', hash)).resolves.toBe(false);
  }, 30_000);

  it('uses the same login verification entry point for known and unknown accounts', async () => {
    const hash = await hashPassword('correct horse');

    await expect(verifyLoginPassword('correct horse', hash)).resolves.toBe(true);
    await expect(verifyLoginPassword('wrong horse', hash)).resolves.toBe(false);
    await expect(verifyLoginPassword('correct horse', null)).resolves.toBe(false);
    await expect(verifyLoginPassword('correct horse', 'not-a-password-hash')).resolves.toBe(false);
    await expect(verifyLoginPassword('correct horse', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
    await expect(verifyLoginPassword('short', null)).resolves.toBe(false);
  }, 30_000);

  it('fails closed when session and rate-limit HMAC keys are missing or too short', () => {
    const fakePool = {} as Pool;
    const commonSessionOptions = {
      pool: fakePool,
      cookieName: '51mai_test_session',
      secureCookie: false,
      sessionTtlSeconds: 60,
      rememberSessionTtlSeconds: 120,
    };

    expect(() => resolveAuthHmacKey(undefined)).toThrow(/at least 32 bytes/);
    expect(() => resolveAuthHmacKey(Buffer.alloc(31))).toThrow(/at least 32 bytes/);
    expect(() => new SessionManager({ ...commonSessionOptions, authHmacKey: undefined as unknown as Buffer })).toThrow(
      /at least 32 bytes/,
    );
    expect(() => new SessionManager({ ...commonSessionOptions, authHmacKey: Buffer.alloc(31) })).toThrow(
      /at least 32 bytes/,
    );
    expect(
      () =>
        new PersistentRateLimiter({
          pool: fakePool,
          authHmacKey: undefined as unknown as Buffer,
          windowSeconds: 60,
          maxAttempts: 5,
        }),
    ).toThrow(/at least 32 bytes/);
    expect(
      () =>
        new PersistentRateLimiter({
          pool: fakePool,
          authHmacKey: Buffer.alloc(31),
          windowSeconds: 60,
          maxAttempts: 5,
        }),
    ).toThrow(/at least 32 bytes/);
  });
});

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

let pool: Pool | undefined;
const createdUserIds = new Set<string>();
const createdRateKeys: Buffer[] = [];

async function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function cookiePair(issued: IssuedSession): string {
  return issued.cookieHeader.split(';', 1)[0] as string;
}

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  const id = overrides.id ?? randomUUID();
  const user: AuthUser = {
    id,
    username: overrides.username ?? `security_${id.replaceAll('-', '').slice(0, 24)}`,
    role: overrides.role ?? 'customer',
  };
  createdUserIds.add(id);
  return user;
}

async function insertUser(user: AuthUser, accountStatus: 'active' | 'frozen' | 'disabled' = 'active'): Promise<void> {
  if (!pool) throw new Error('integration pool is not initialized');
  await pool.execute(
    'INSERT INTO users (id, username_normalized, password_hash, account_status, role) VALUES (?, ?, ?, ?, ?)',
    [user.id, user.username, DUMMY_PASSWORD_HASH, accountStatus, user.role],
  );
}

describe.skipIf(!integrationRequested)('integration configuration guard', () => {
  it('requires an explicitly allowlisted database', () => {
    expect(integrationEnabled).toBe(true);
  });
});

describe.skipIf(!integrationEnabled)('session, guard, and persistent rate-limit security', () => {
  const authHmacKey = Buffer.alloc(32, 0x51);
  let sessions: SessionManager;

  beforeAll(async () => {
    if (!explicitTestDatabase) throw new Error('missing explicit test database name');
    pool = createPool({ ...loadDatabaseConfig(), database: explicitTestDatabase });
    sessions = new SessionManager({
      pool,
      cookieName: '51mai_test_session',
      secureCookie: false,
      authHmacKey,
      sessionTtlSeconds: 60,
      rememberSessionTtlSeconds: 120,
    });
  });

  afterEach(async () => {
    if (!pool) return;
    if (createdUserIds.size > 0) {
      const ids = [...createdUserIds];
      await pool.query(`DELETE FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      createdUserIds.clear();
    }
    for (const key of createdRateKeys.splice(0)) await pool.execute('DELETE FROM auth_rate_limits WHERE rate_key_hmac = ?', [key]);
  });

  afterAll(async () => {
    await pool?.end();
    pool = undefined;
  });

  it('persists sessions across manager instances and rejects expiry, revocation, and frozen users', async () => {
    if (!pool) throw new Error('integration pool is not initialized');
    const user = makeUser();
    await insertUser(user);
    const issued = await sessions.issueSession(user);
    expect(issued.cookieHeader).toContain('HttpOnly');
    expect(issued.cookieHeader).toContain('Path=/');
    expect(issued.cookieHeader).toContain('SameSite=Lax');
    expect(issued.cookieHeader).not.toContain('Domain=');

    const restarted = new SessionManager({
      pool,
      cookieName: '51mai_test_session',
      secureCookie: false,
      authHmacKey,
      sessionTtlSeconds: 60,
      rememberSessionTtlSeconds: 120,
    });
    const restored = await restarted.loadSession(cookiePair(issued));
    expect(restored?.user).toEqual(user);
    expect(restored?.csrfToken).toBe(issued.csrfToken);

    await pool.execute('UPDATE sessions SET expires_at = UTC_TIMESTAMP(6) WHERE token_hash = ?', [restored?.tokenHash]);
    await expect(restarted.loadSession(cookiePair(issued))).resolves.toBeNull();

    const transitioningUser = makeUser();
    await insertUser(transitioningUser);
    const transitioningSession = await sessions.issueSession(transitioningUser);
    await expect(sessions.loadSession(cookiePair(transitioningSession))).resolves.toMatchObject({ user: transitioningUser });
    await pool.execute('UPDATE users SET account_status = ? WHERE id = ?', ['frozen', transitioningUser.id]);
    await expect(sessions.loadSession(cookiePair(transitioningSession))).resolves.toBeNull();

    const second = await sessions.issueSession(user);
    await sessions.revokeSession(cookiePair(second));
    await expect(sessions.loadSession(cookiePair(second))).resolves.toBeNull();

    const frozenUser = makeUser();
    await insertUser(frozenUser, 'frozen');
    const frozen = await sessions.issueSession(frozenUser);
    await expect(sessions.loadSession(cookiePair(frozen))).resolves.toBeNull();
  });

  it('sets production cookie attributes and never exposes a domain attribute', async () => {
    if (!pool) throw new Error('integration pool is not initialized');
    const user = makeUser();
    await insertUser(user);
    const productionSessions = new SessionManager({
      pool,
      cookieName: '__Host-51mai_session',
      secureCookie: true,
      authHmacKey,
      sessionTtlSeconds: 60,
      rememberSessionTtlSeconds: 120,
    });
    const issued = await productionSessions.issueSession(user, { remember: true });
    expect(issued.cookieHeader).toContain('__Host-51mai_session=');
    expect(issued.cookieHeader).toContain('Max-Age=120');
    expect(issued.cookieHeader).toContain('Secure');
    expect(issued.cookieHeader).toContain('HttpOnly');
    expect(issued.cookieHeader).toContain('Path=/');
    expect(issued.cookieHeader).toContain('SameSite=Lax');
    expect(issued.cookieHeader).not.toContain('Domain=');
    expect(productionSessions.clearCookieHeader()).toContain('Max-Age=0');
  });

  it('writes explicit request auth, returns 401 for anonymous users, and 403 for customers at admin guards', async () => {
    if (!pool) throw new Error('integration pool is not initialized');
    const user = makeUser();
    await insertUser(user);
    const issued = await sessions.issueSession(user);
    const app = express();
    app.get('/private', requireSession(sessions), (request, response) => response.json({ user: request.auth?.user }));
    app.get('/admin', requireAdmin(sessions), (_request, response) => response.json({ ok: true }));
    const { server, baseUrl } = await listen(app);
    try {
      const anonymous = await fetch(`${baseUrl}/private`);
      expect(anonymous.status).toBe(401);
      const customer = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookiePair(issued) } });
      expect(customer.status).toBe(403);
      const privateResponse = await fetch(`${baseUrl}/private`, { headers: { Cookie: cookiePair(issued) } });
      expect(privateResponse.status).toBe(200);
      expect(privateResponse.headers.get('cache-control')).toBe('no-store');
      await expect(privateResponse.json()).resolves.toEqual({ user });
    } finally {
      await close(server);
    }
  });

  it('requires the session CSRF token on unsafe methods and rejects missing or evil origins for anonymous operations', async () => {
    if (!pool) throw new Error('integration pool is not initialized');
    const user = makeUser();
    await insertUser(user);
    const issued = await sessions.issueSession(user);
    const app = express();
    app.post('/change', requireSession(sessions), (_request, response) => response.status(204).end());
    app.post('/anonymous', requireAllowedOrigin('https://51mai.example.test'), (_request, response) => response.status(204).end());
    const { server, baseUrl } = await listen(app);
    try {
      const missingCsrf = await fetch(`${baseUrl}/change`, { method: 'POST', headers: { Cookie: cookiePair(issued) } });
      expect(missingCsrf.status).toBe(403);
      const wrongCsrf = await fetch(`${baseUrl}/change`, {
        method: 'POST',
        headers: { Cookie: cookiePair(issued), 'X-CSRF-Token': 'wrong' },
      });
      expect(wrongCsrf.status).toBe(403);
      const validCsrf = await fetch(`${baseUrl}/change`, {
        method: 'POST',
        headers: { Cookie: cookiePair(issued), 'X-CSRF-Token': issued.csrfToken },
      });
      expect(validCsrf.status).toBe(204);
      const missingOrigin = await fetch(`${baseUrl}/anonymous`, { method: 'POST' });
      expect(missingOrigin.status).toBe(403);
      const evilOrigin = await fetch(`${baseUrl}/anonymous`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example.test' },
      });
      expect(evilOrigin.status).toBe(403);
      const allowedOrigin = await fetch(`${baseUrl}/anonymous`, {
        method: 'POST',
        headers: { Origin: 'https://51mai.example.test' },
      });
      expect(allowedOrigin.status).toBe(204);
    } finally {
      await close(server);
    }
  });

  it('uses the server socket address when the app does not trust forwarded headers', async () => {
    const app = express();
    app.set('trust proxy', false);
    app.get('/source', (request, response) => response.json({ ip: requestSourceIp(request) }));
    const { server, baseUrl } = await listen(app);
    try {
      const result = await fetch(`${baseUrl}/source`, { headers: { 'X-Forwarded-For': '203.0.113.99' } });
      expect(result.status).toBe(200);
      const payload = (await result.json()) as { ip: string };
      expect(payload.ip).not.toBe('203.0.113.99');
    } finally {
      await close(server);
    }
  });

  it('updates a database-backed account key atomically under concurrent requests and persists the window', async () => {
    if (!pool) throw new Error('integration pool is not initialized');
    const limiter = new PersistentRateLimiter({ pool, authHmacKey, windowSeconds: 60, maxAttempts: 5 });
    const parts = ['login', 'account', `security-${randomUUID()}`];
    const key = limiter.hashKey(parts);
    createdRateKeys.push(key);
    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.consume(parts)));
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(new Set(results.map((result) => result.attemptCount)).size).toBe(10);

    const restartedLimiter = new PersistentRateLimiter({ pool, authHmacKey, windowSeconds: 60, maxAttempts: 5 });
    const persisted = await restartedLimiter.consume(parts);
    expect(persisted.allowed).toBe(false);
    expect(persisted.attemptCount).toBe(11);

    const independentParts = ['login', 'account', `rollback-${randomUUID()}`];
    createdRateKeys.push(limiter.hashKey(independentParts));
    const businessConnection = await pool.getConnection();
    try {
      await businessConnection.beginTransaction();
      await limiter.consume(independentParts);
      await businessConnection.rollback();
    } catch (error) {
      await businessConnection.rollback().catch(() => undefined);
      throw error;
    } finally {
      businessConnection.release();
    }
    const afterBusinessRollback = await limiter.consume(independentParts);
    expect(afterBusinessRollback.attemptCount).toBe(2);
  });

  it('parses only the session cookie and never treats another cookie as a session', () => {
    expect(parseCookieHeader('other=value; 51mai_test_session=token; malformed')).toEqual({
      other: 'value',
      '51mai_test_session': 'token',
    });
  });
});
