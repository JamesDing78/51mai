// @vitest-environment node

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import type { Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadDatabaseConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { PersistentRateLimiter } from './rate-limit.js';
import { registerAuth } from './routes.js';
import type { VerificationPurpose, VerificationSender, VerificationSendInput } from './sender.js';
import { normalizeUsername } from './service.js';

class MemorySender implements VerificationSender {
  readonly messages: VerificationSendInput[] = [];

  async send(input: VerificationSendInput): Promise<void> {
    this.messages.push({ ...input });
  }

  take(destination: string, purpose: VerificationPurpose): VerificationSendInput {
    const message = [...this.messages].reverse().find((candidate) => candidate.destination === destination && candidate.purpose === purpose);
    if (!message) throw new Error('test sender message missing');
    return message;
  }
}

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

async function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function cookiePair(response: Response): string {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

describe('authentication input boundaries', () => {
  it('normalizes usernames by NFKC, trimming, and lowercasing Unicode code points', () => {
    expect(normalizeUsername('  Ａlice  ')).toBe('alice');
  });
});

describe.skipIf(!integrationRequested)('integration configuration guard', () => {
  it('requires an explicitly allowlisted database', () => {
    expect(integrationEnabled).toBe(true);
  });
});

describe.skipIf(!integrationEnabled)('authentication HTTP API', () => {
  const allowOrigin = 'https://51mai.example.test';
  const authHmacKey = Buffer.alloc(32, 0x71);
  const sender = new MemorySender();
  const limiter = new PersistentRateLimiter({
    pool: {} as Pool,
    authHmacKey,
    windowSeconds: 60,
    maxAttempts: 5,
  });
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  const runTag = randomUUID().replaceAll('-', '').slice(0, 8);
  const ipBase = Number.parseInt(runTag.slice(0, 2), 16) % 254 + 1;
  const testIp = (suffix: number): string => `198.51.${ipBase}.${suffix}`;
  const localSourceIp = '127.0.0.1';
  const createdUserIds = new Set<string>();
  const createdChallengeIds = new Set<string>();
  const createdRateKeys = new Set<string>();

  function track(parts: readonly string[]): void {
    createdRateKeys.add(limiter.hashKey(parts).toString('hex'));
  }

  async function requestJson(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string; csrf?: string; origin?: string | null; ip?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Forwarded-For': options.ip ?? `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    };
    if (options.origin !== null) headers.Origin = options.origin ?? allowOrigin;
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.csrf) headers['X-CSRF-Token'] = options.csrf;
    return fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'POST',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  async function register(username: string, ip: string): Promise<{ response: Response; cookie: string; csrfToken: string; userId: string }> {
    track(['register', 'username', username]);
    track(['register', 'ip', localSourceIp]);
    const response = await requestJson('/api/auth/register', {
      body: {
        username,
        password: 'correct horse',
        confirmPassword: 'correct horse',
        termsVersion: 'terms-v1',
        privacyVersion: 'privacy-v1',
        acceptTerms: true,
      },
      ip,
    });
    const payload = (await response.json()) as { data?: { user?: { id?: string }; csrfToken?: string } };
    const userId = payload.data?.user?.id;
    if (userId) createdUserIds.add(userId);
    return { response, cookie: cookiePair(response), csrfToken: payload.data?.csrfToken ?? '', userId: userId ?? '' };
  }

  beforeAll(async () => {
    if (!explicitTestDatabase) throw new Error('missing explicit test database name');
    pool = createPool({ ...loadDatabaseConfig(), database: explicitTestDatabase });
    for (const parts of [
      ['register', 'ip', localSourceIp],
      ['login', 'ip', localSourceIp],
      ['challenge', 'code_login', 'ip', localSourceIp],
      ['challenge', 'reset_password', 'ip', localSourceIp],
      ['code-login', 'ip', localSourceIp],
      ['reset', 'ip', localSourceIp],
    ]) {
      await pool.execute('DELETE FROM auth_rate_limits WHERE rate_key_hmac = ?', [limiter.hashKey(parts)]);
    }
    const apiRouter = express.Router();
    registerAuth(apiRouter, {
      pool,
      allowOrigin,
      authHmacKey,
      cookieName: '51mai_test_session',
      secureCookie: false,
      sessionTtlSeconds: 3_600,
      rememberSessionTtlSeconds: 7_200,
      sender,
    });
    const app = createApp({ apiRouter });
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;
  });

  afterEach(async () => {
    if (createdChallengeIds.size > 0) {
      const ids = [...createdChallengeIds];
      await pool.query(
        `DELETE FROM verification_challenges WHERE challenge_id_hash IN (${ids.map(() => 'UNHEX(SHA2(?, 256))').join(',')})`,
        ids,
      );
      createdChallengeIds.clear();
    }
    if (createdUserIds.size > 0) {
      const ids = [...createdUserIds];
      await pool.query(`DELETE FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      createdUserIds.clear();
    }
    for (const key of createdRateKeys) await pool.execute('DELETE FROM auth_rate_limits WHERE rate_key_hmac = ?', [Buffer.from(key, 'hex')]);
    createdRateKeys.clear();
    sender.messages.splice(0);
  });

  afterAll(async () => {
    await close(server);
    await pool.end();
  });

  it('requires Origin, rejects unknown authorization fields, and returns a server session', async () => {
    const denied = await requestJson('/api/auth/register', {
      origin: null,
      body: {
        username: 'origin_guard',
        password: 'correct horse',
        confirmPassword: 'correct horse',
        termsVersion: 'terms-v1',
        privacyVersion: 'privacy-v1',
        acceptTerms: true,
      },
      ip: '198.51.100.10',
    });
    expect(denied.status).toBe(403);

    const unknown = await requestJson('/api/auth/register', {
      body: {
        username: 'unknown_field',
        password: 'correct horse',
        confirmPassword: 'correct horse',
        termsVersion: 'terms-v1',
        privacyVersion: 'privacy-v1',
        acceptTerms: true,
        role: 'admin',
      },
      ip: '198.51.100.11',
    });
    expect(unknown.status).toBe(400);

    const created = await register(`Origin_Guard_${runTag}`, testIp(12));
    expect(created.response.status).toBe(201);
    expect(created.cookie).toContain('51mai_test_session=');
    expect(created.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(created.response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(created.response.headers.get('set-cookie')).not.toContain('Domain=');

    const session = await requestJson('/api/auth/session', { method: 'GET', cookie: created.cookie, origin: null });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({ data: { user: { username: `origin_guard_${runTag}`.toLowerCase(), role: 'customer' } } });
  });

  it('uses generic password failure, rotates login cookies, and makes logout replay safe', async () => {
    const username = `login_rotate_${runTag}`;
    const created = await register(username, testIp(20));
    track(['login', 'account', username]);
    track(['login', 'ip', localSourceIp]);
    const wrong = await requestJson('/api/auth/login', {
      body: { identifier: 'LOGIN_ROTATE', password: 'wrong horse' },
      cookie: created.cookie,
      csrf: created.csrfToken,
      ip: testIp(21),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { code: 'AUTHENTICATION_FAILED', message: 'Invalid credentials' } });

    track(['login', 'account', username]);
    track(['login', 'ip', localSourceIp]);
    const loggedIn = await requestJson('/api/auth/login', {
      body: { identifier: username, password: 'correct horse' },
      cookie: created.cookie,
      csrf: created.csrfToken,
      ip: testIp(22),
    });
    expect(loggedIn.status).toBe(200);
    const rotatedCookie = cookiePair(loggedIn);
    expect(rotatedCookie).toContain('51mai_test_session=');
    expect(rotatedCookie).not.toBe(created.cookie);
    const oldSession = await requestJson('/api/auth/session', { method: 'GET', cookie: created.cookie, origin: null });
    expect(oldSession.status).toBe(401);

    const payload = (await loggedIn.json()) as { data: { csrfToken: string; user: { id: string } } };
    createdUserIds.add(payload.data.user.id);
    const logout = await requestJson('/api/auth/logout', {
      cookie: rotatedCookie,
      csrf: payload.data.csrfToken,
      ip: testIp(23),
    });
    expect(logout.status).toBe(204);
    const replay = await requestJson('/api/auth/logout', { cookie: rotatedCookie, ip: testIp(24) });
    expect(replay.status).toBe(204);
  });

  it('allows only one winner for concurrent registration of the same normalized username', async () => {
    const username = `concurrent_${runTag}`;
    track(['register', 'username', username]);
    track(['register', 'ip', localSourceIp]);
    const responses = await Promise.all(
      [testIp(25), testIp(26)].map((ip) =>
        requestJson('/api/auth/register', {
          body: {
            username: username.toUpperCase(),
            password: 'correct horse',
            confirmPassword: 'correct horse',
            termsVersion: 'terms-v1',
            privacyVersion: 'privacy-v1',
            acceptTerms: true,
          },
          ip,
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    for (const response of responses) {
      if (response.status === 201) {
        const payload = (await response.json()) as { data: { user: { id: string } } };
        createdUserIds.add(payload.data.user.id);
      } else {
        await response.text();
      }
    }
  });

  it('checks account status after the password KDF and rejects frozen accounts generically', async () => {
    const username = `frozen_login_${runTag}`;
    const created = await register(username, testIp(30));
    track(['login', 'account', username]);
    track(['login', 'ip', localSourceIp]);
    await pool.execute("UPDATE users SET account_status = 'frozen' WHERE id = ?", [created.userId]);
    const result = await requestJson('/api/auth/login', {
      body: { identifier: username, password: 'correct horse' },
      ip: testIp(31),
    });
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: { code: 'AUTHENTICATION_FAILED', message: 'Invalid credentials' } });

    const adminAttempt = await requestJson('/api/admin/login', {
      body: { identifier: username, password: 'correct horse' },
      ip: testIp(32),
    });
    expect(adminAttempt.status).toBe(401);
  });

  it('requires consent before code-login target lookup and keeps active, unknown, and frozen errors indistinguishable', async () => {
    const active = await register(`code_known_${runTag}`, testIp(33));
    const frozen = await register(`code_frozen_${runTag}`, testIp(34));
    const activeEmail = `code-known-${randomUUID().slice(0, 8)}@example.test`;
    const frozenEmail = `code-frozen-${randomUUID().slice(0, 8)}@example.test`;
    await pool.execute(
      `INSERT INTO user_contacts (id, user_id, kind, identifier_normalized, verified_at)
       VALUES (?, ?, 'email', ?, UTC_TIMESTAMP(6)), (?, ?, 'email', ?, UTC_TIMESTAMP(6))`,
      [randomUUID(), active.userId, activeEmail, randomUUID(), frozen.userId, frozenEmail],
    );
    await pool.execute("UPDATE users SET account_status = 'frozen' WHERE id = ?", [frozen.userId]);

    const identifiers = [activeEmail, `code-missing-${randomUUID().slice(0, 8)}@example.test`, frozenEmail];
    const responses: Response[] = [];
    for (const [index, identifier] of identifiers.entries()) {
      track(['code-login', 'target', identifier]);
      track(['code-login', 'ip', localSourceIp]);
      responses.push(
        await requestJson('/api/auth/code-login', {
          body: {
            challengeId: 'not-a-real-challenge',
            identifier,
            code: '000000',
            termsVersion: 'stale-terms',
            privacyVersion: 'stale-privacy',
            acceptTerms: false,
          },
          ip: testIp(35 + index),
        }),
      );
    }
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    const errors = await Promise.all(responses.map((response) => response.json()));
    expect(errors).toEqual([
      { error: { code: 'CONSENT_REQUIRED', message: 'Current terms and privacy consent are required' } },
      { error: { code: 'CONSENT_REQUIRED', message: 'Current terms and privacy consent are required' } },
      { error: { code: 'CONSENT_REQUIRED', message: 'Current terms and privacy consent are required' } },
    ]);
  });

  it('rotates an existing session during code-login', async () => {
    const created = await register(`code_rotate_${runTag}`, testIp(37));
    const email = `code-rotate-${randomUUID().slice(0, 8)}@example.test`;
    await pool.execute(
      `INSERT INTO user_contacts (id, user_id, kind, identifier_normalized, verified_at)
       VALUES (?, ?, 'email', ?, UTC_TIMESTAMP(6))`,
      [randomUUID(), created.userId, email],
    );
    track(['challenge', 'code_login', 'target', email]);
    track(['challenge', 'code_login', 'ip', localSourceIp]);
    const challenge = await requestJson('/api/auth/challenges', {
      body: { identifier: email, purpose: 'code_login' },
      cookie: created.cookie,
      csrf: created.csrfToken,
      ip: testIp(38),
    });
    expect(challenge.status).toBe(202);
    const challengeId = ((await challenge.json()) as { data: { challengeId: string } }).data.challengeId;
    createdChallengeIds.add(challengeId);
    const code = sender.take(email, 'code_login').code;
    track(['code-login', 'target', email]);
    track(['code-login', 'ip', localSourceIp]);
    const loggedIn = await requestJson('/api/auth/code-login', {
      body: {
        challengeId,
        identifier: email,
        code,
        termsVersion: 'terms-v1',
        privacyVersion: 'privacy-v1',
        acceptTerms: true,
      },
      cookie: created.cookie,
      csrf: created.csrfToken,
      ip: testIp(39),
    });
    expect(loggedIn.status).toBe(200);
    const rotatedCookie = cookiePair(loggedIn);
    expect(rotatedCookie).not.toBe(created.cookie);
    const oldSession = await requestJson('/api/auth/session', { method: 'GET', cookie: created.cookie, origin: null });
    const newSession = await requestJson('/api/auth/session', { method: 'GET', cookie: rotatedCookie, origin: null });
    expect(oldSession.status).toBe(401);
    expect(newSession.status).toBe(200);
  });

  it('requires consent for code-login auto-registration and consumes a challenge once', async () => {
    const identifier = `new-user-${randomUUID().slice(0, 8)}@example.test`;
    const ip = testIp(40);
    track(['challenge', 'code_login', 'target', identifier]);
    track(['challenge', 'code_login', 'ip', localSourceIp]);
    const challenge = await requestJson('/api/auth/challenges', {
      body: { identifier, purpose: 'code_login' },
      ip,
    });
    expect(challenge.status).toBe(202);
    const challengeId = ((await challenge.json()) as { data: { challengeId: string } }).data.challengeId;
    createdChallengeIds.add(challengeId);
    const code = sender.take(identifier, 'code_login').code;
    track(['code-login', 'target', identifier]);
    track(['code-login', 'ip', localSourceIp]);
    const missingConsent = await requestJson('/api/auth/code-login', {
      body: { challengeId, identifier, code },
      ip: testIp(41),
    });
    expect(missingConsent.status).toBe(400);

    const loggedIn = await requestJson('/api/auth/code-login', {
      body: {
        challengeId,
        identifier,
        code,
        termsVersion: 'terms-v1',
        privacyVersion: 'privacy-v1',
        acceptTerms: true,
      },
      ip: testIp(42),
    });
    expect(loggedIn.status).toBe(200);
    const payload = (await loggedIn.json()) as { data: { user: { id: string; username: string; role: string } } };
    createdUserIds.add(payload.data.user.id);
    expect(payload.data.user.username).not.toBe(identifier);
    expect(payload.data.user.role).toBe('customer');

    const replay = await requestJson('/api/auth/code-login', {
      body: { challengeId, identifier, code, termsVersion: 'terms-v1', privacyVersion: 'privacy-v1', acceptTerms: true },
      ip: testIp(43),
    });
    expect(replay.status).toBe(401);
  });

  it('rejects password reset for an unverified contact', async () => {
    const username = `unverified_reset_${runTag}`;
    const created = await register(username, testIp(45));
    const email = `unverified-${randomUUID().slice(0, 8)}@example.test`;
    await pool.execute(
      `INSERT INTO user_contacts (id, user_id, kind, identifier_normalized, verified_at)
       VALUES (?, ?, 'email', ?, NULL)`,
      [randomUUID(), created.userId, email],
    );
    track(['challenge', 'reset_password', 'target', email]);
    track(['challenge', 'reset_password', 'ip', localSourceIp]);
    const challenge = await requestJson('/api/auth/challenges', {
      body: { identifier: email, purpose: 'reset_password' },
      ip: testIp(46),
    });
    expect(challenge.status).toBe(202);
    const challengeId = ((await challenge.json()) as { data: { challengeId: string } }).data.challengeId;
    createdChallengeIds.add(challengeId);
    const code = sender.take(email, 'reset_password').code;
    track(['reset', 'target', email]);
    track(['reset', 'ip', localSourceIp]);
    const reset = await requestJson('/api/auth/reset-password', {
      body: { challengeId, identifier: email, code, password: 'new horse', confirmPassword: 'new horse' },
      ip: testIp(47),
    });
    expect(reset.status).toBe(401);
  });

  it('resets only a verified contact and revokes every old session', async () => {
    const username = `reset_account_${runTag}`;
    const created = await register(username, testIp(50));
    const email = `reset-${randomUUID().slice(0, 8)}@example.test`;
    await pool.execute(
      `INSERT INTO user_contacts (id, user_id, kind, identifier_normalized, verified_at)
       VALUES (?, ?, 'email', ?, UTC_TIMESTAMP(6))`,
      [randomUUID(), created.userId, email],
    );
    const secondLogin = await requestJson('/api/auth/login', {
      body: { identifier: username, password: 'correct horse' },
      ip: testIp(51),
    });
    expect(secondLogin.status).toBe(200);
    const secondCookie = cookiePair(secondLogin);

    const challengeIp = testIp(52);
    track(['challenge', 'reset_password', 'target', email]);
    track(['challenge', 'reset_password', 'ip', localSourceIp]);
    const challenge = await requestJson('/api/auth/challenges', {
      body: { identifier: email, purpose: 'reset_password' },
      ip: challengeIp,
    });
    expect(challenge.status).toBe(202);
    const challengeId = ((await challenge.json()) as { data: { challengeId: string } }).data.challengeId;
    createdChallengeIds.add(challengeId);
    const code = sender.take(email, 'reset_password').code;
    track(['reset', 'target', email]);
    track(['reset', 'ip', localSourceIp]);
    const reset = await requestJson('/api/auth/reset-password', {
      body: { challengeId, identifier: email, code, password: 'new horse', confirmPassword: 'new horse' },
      ip: testIp(53),
    });
    expect(reset.status).toBe(204);

    const oldOne = await requestJson('/api/auth/session', { method: 'GET', cookie: created.cookie, origin: null });
    const oldTwo = await requestJson('/api/auth/session', { method: 'GET', cookie: secondCookie, origin: null });
    expect(oldOne.status).toBe(401);
    expect(oldTwo.status).toBe(401);

    const newPassword = await requestJson('/api/auth/login', {
      body: { identifier: username, password: 'new horse' },
      ip: testIp(54),
    });
    expect(newPassword.status).toBe(200);
  });
});
