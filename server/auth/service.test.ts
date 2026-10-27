// @vitest-environment node

import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { hashPassword } from './password.js';
import { PersistentRateLimiter } from './rate-limit.js';
import { AuthService } from './service.js';
import { SessionManager, sha256 } from './sessions.js';
import {
  type NormalizedContact,
  normalizeContact,
  VerificationService,
} from './verification.js';
import type { VerificationPurpose, VerificationSender, VerificationSendInput } from './sender.js';

class TestSender implements VerificationSender {
  readonly messages: VerificationSendInput[] = [];

  async send(input: VerificationSendInput): Promise<void> {
    this.messages.push({ ...input });
  }

  latest(target: NormalizedContact, purpose: VerificationPurpose): VerificationSendInput {
    const message = [...this.messages]
      .reverse()
      .find((candidate) => candidate.destination === target.value && candidate.purpose === purpose);
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

describe.skipIf(!integrationRequested)('authentication service integration configuration guard', () => {
  it('requires an explicitly allowlisted database', () => {
    expect(integrationEnabled).toBe(true);
  });
});

describe.skipIf(!integrationEnabled)('authentication business transaction boundaries', () => {
  const authHmacKey = Buffer.alloc(32, 0x73);
  const cookieName = '51mai_fix1_session';
  let pool: Pool;
  let sender: TestSender;
  const challengeIds = new Set<string>();
  const rateKeys = new Set<string>();
  const userIds = new Set<string>();

  function trackRate(parts: readonly string[]): void {
    const limiter = new PersistentRateLimiter({ pool: {} as Pool, authHmacKey, windowSeconds: 60, maxAttempts: 5 });
    rateKeys.add(limiter.hashKey(parts).toString('hex'));
  }

  function makeSessions(): SessionManager {
    return new SessionManager({
      pool,
      cookieName,
      secureCookie: false,
      authHmacKey,
      sessionTtlSeconds: 3_600,
      rememberSessionTtlSeconds: 7_200,
    });
  }

  function makeService(sessions: SessionManager): AuthService {
    const limiter = new PersistentRateLimiter({ pool, authHmacKey, windowSeconds: 60, maxAttempts: 5 });
    const verification = new VerificationService({ pool, authHmacKey, sender });
    return new AuthService({ pool, sessions, limiter, verification });
  }

  beforeAll(async () => {
    if (!explicitTestDatabase) throw new Error('missing explicit test database name');
    pool = createPool({ ...loadDatabaseConfig(), database: explicitTestDatabase });
    sender = new TestSender();
  });

  afterEach(async () => {
    for (const challengeId of challengeIds) {
      await pool.execute('DELETE FROM verification_challenges WHERE challenge_id_hash = ?', [sha256(challengeId)]);
    }
    challengeIds.clear();
    if (userIds.size > 0) {
      const ids = [...userIds];
      await pool.query(`DELETE FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      userIds.clear();
    }
    for (const key of rateKeys) await pool.execute('DELETE FROM auth_rate_limits WHERE rate_key_hmac = ?', [Buffer.from(key, 'hex')]);
    rateKeys.clear();
    sender.messages.splice(0);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rolls back code-login contact, user, session, and challenge when session issuance fails', async () => {
    const sessions = makeSessions();
    const service = makeService(sessions);
    const target = normalizeContact(`atomic-code-${randomUUID().slice(0, 8)}@example.test`);
    const challengeIp = '198.51.100.201';
    const codeLoginIp = '198.51.100.202';
    trackRate(['challenge', 'code_login', 'target', target.value]);
    trackRate(['challenge', 'code_login', 'ip', challengeIp]);
    const challengeId = await service.requestChallenge(target, 'code_login', { sourceIp: challengeIp });
    challengeIds.add(challengeId);
    const code = sender.latest(target, 'code_login').code;

    let injectedUserId = '';
    const originalIssueSession = sessions.issueSession.bind(sessions);
    const injected = sessions as unknown as {
      issueSession: (...args: Parameters<SessionManager['issueSession']>) => ReturnType<SessionManager['issueSession']>;
    };
    injected.issueSession = async (...args) => {
      injectedUserId = args[0].id;
      await originalIssueSession(...args);
      throw new Error('injected session failure');
    };

    trackRate(['code-login', 'target', target.value]);
    trackRate(['code-login', 'ip', codeLoginIp]);
    await expect(
      service.codeLogin(
        {
          challengeId,
          target,
          code,
          termsVersion: 'terms-v1',
          privacyVersion: 'privacy-v1',
          acceptTerms: true,
        },
        { sourceIp: codeLoginIp },
      ),
    ).rejects.toThrow('injected session failure');

    const [users] = await pool.query<Array<{ id: string }>>('SELECT id FROM users WHERE id = ?', [injectedUserId]);
    const [contacts] = await pool.query<Array<{ id: string }>>(
      'SELECT id FROM user_contacts WHERE kind = ? AND identifier_normalized = ?',
      [target.kind, target.value],
    );
    const [sessionsRows] = await pool.query<Array<{ token_hash: Buffer }>>('SELECT token_hash FROM sessions WHERE user_id = ?', [injectedUserId]);
    const [challengeRows] = await pool.query<Array<{ consumed_at: string | null }>>(
      'SELECT consumed_at FROM verification_challenges WHERE challenge_id_hash = ?',
      [sha256(challengeId)],
    );
    expect(users).toHaveLength(0);
    expect(contacts).toHaveLength(0);
    expect(sessionsRows).toHaveLength(0);
    expect(challengeRows[0]?.consumed_at).toBeNull();
  });

  it('rolls back reset password and session revocation when the revoke operation fails', async () => {
    const sessions = makeSessions();
    const userId = randomUUID();
    const username = `atomic_reset_${randomUUID().slice(0, 8)}`;
    const target = normalizeContact(`atomic-reset-${randomUUID().slice(0, 8)}@example.test`);
    const oldPasswordHash = await hashPassword('old horse');
    userIds.add(userId);
    await pool.execute(
      `INSERT INTO users (id, username_normalized, password_hash, account_status, role)
       VALUES (?, ?, ?, 'active', 'customer')`,
      [userId, username, oldPasswordHash],
    );
    await pool.execute(
      `INSERT INTO user_contacts (id, user_id, kind, identifier_normalized, verified_at)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))`,
      [randomUUID(), userId, target.kind, target.value],
    );
    const issued = await sessions.issueSession({ id: userId, username, role: 'customer' });

    const originalRevokeAllSessions = sessions.revokeAllSessions.bind(sessions);
    const injected = sessions as unknown as {
      revokeAllSessions: (...args: Parameters<SessionManager['revokeAllSessions']>) => ReturnType<SessionManager['revokeAllSessions']>;
    };
    injected.revokeAllSessions = async (...args) => {
      await originalRevokeAllSessions(...args);
      throw new Error('injected revoke failure');
    };

    const service = makeService(sessions);
    const challengeIp = '198.51.100.203';
    const resetIp = '198.51.100.204';
    trackRate(['challenge', 'reset_password', 'target', target.value]);
    trackRate(['challenge', 'reset_password', 'ip', challengeIp]);
    const challengeId = await service.requestChallenge(target, 'reset_password', { sourceIp: challengeIp });
    challengeIds.add(challengeId);
    const code = sender.latest(target, 'reset_password').code;
    trackRate(['reset', 'target', target.value]);
    trackRate(['reset', 'ip', resetIp]);
    await expect(
      service.resetPassword(
        { challengeId, target, code, password: 'new horse', confirmPassword: 'new horse' },
        { sourceIp: resetIp },
      ),
    ).rejects.toThrow('injected revoke failure');

    const [userRows] = await pool.query<Array<{ password_hash: string }>>('SELECT password_hash FROM users WHERE id = ?', [userId]);
    expect(userRows[0]?.password_hash).toBe(oldPasswordHash);
    await expect(sessions.loadSession(issued.cookieHeader)).resolves.toMatchObject({ user: { id: userId } });
    const [challengeRows] = await pool.query<Array<{ consumed_at: string | null }>>(
      'SELECT consumed_at FROM verification_challenges WHERE challenge_id_hash = ?',
      [sha256(challengeId)],
    );
    expect(challengeRows[0]?.consumed_at).toBeNull();
  });
});
