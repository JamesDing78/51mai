// @vitest-environment node

import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { sha256 } from './sessions.js';
import {
  normalizeContact,
  VerificationError,
  VerificationService,
  type NormalizedContact,
} from './verification.js';
import {
  UnavailableSender,
  VerificationSenderUnavailableError,
  type VerificationPurpose,
  type VerificationSender,
  type VerificationSendInput,
} from './sender.js';

class TestSender implements VerificationSender {
  readonly messages: VerificationSendInput[] = [];
  fail = false;

  async send(input: VerificationSendInput): Promise<void> {
    if (this.fail) throw new Error('provider failure');
    this.messages.push({ ...input });
  }

  latest(target: NormalizedContact, purpose: VerificationPurpose): VerificationSendInput {
    const message = [...this.messages].reverse().find((candidate) => candidate.destination === target.value && candidate.purpose === purpose);
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

describe('verification contact normalization', () => {
  it('normalizes supported mainland phone numbers to +86 form', () => {
    expect(normalizeContact('13800138000')).toEqual({ kind: 'phone', value: '+8613800138000' });
    expect(normalizeContact('+8613800138000')).toEqual({ kind: 'phone', value: '+8613800138000' });
    expect(normalizeContact('Name@Example.Test')).toEqual({ kind: 'email', value: 'name@example.test' });
    expect(() => normalizeContact('+14155550123')).toThrow(/Identifier is invalid/);
  });
});

describe.skipIf(!integrationRequested)('verification integration configuration guard', () => {
  it('requires an explicitly allowlisted database', () => {
    expect(integrationEnabled).toBe(true);
  });
});

describe.skipIf(!integrationEnabled)('verification challenge persistence', () => {
  const authHmacKey = Buffer.alloc(32, 0x72);
  let pool: Pool;
  let sender: TestSender;
  let service: VerificationService;
  const challengeIds = new Set<string>();

  beforeAll(async () => {
    if (!explicitTestDatabase) throw new Error('missing explicit test database name');
    pool = createPool({ ...loadDatabaseConfig(), database: explicitTestDatabase });
    sender = new TestSender();
    service = new VerificationService({ pool, authHmacKey, sender });
  });

  afterEach(async () => {
    for (const id of challengeIds) await pool.execute('DELETE FROM verification_challenges WHERE challenge_id_hash = ?', [sha256(id)]);
    challengeIds.clear();
    sender.messages.splice(0);
    sender.fail = false;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createChallenge(purpose: VerificationPurpose): Promise<{ target: NormalizedContact; challengeId: string; code: string }> {
    const target = normalizeContact(`${randomUUID().slice(0, 8)}@example.test`);
    const challengeId = await service.requestChallenge(target, purpose);
    challengeIds.add(challengeId);
    return { target, challengeId, code: sender.latest(target, purpose).code };
  }

  it('enforces a sixty-second cooldown per target and purpose', async () => {
    const target = normalizeContact(`${randomUUID().slice(0, 8)}@example.test`);
    const first = await service.requestChallenge(target, 'code_login');
    challengeIds.add(first);
    await expect(service.requestChallenge(target, 'code_login')).rejects.toMatchObject({ code: 'VERIFICATION_COOLDOWN' });
    expect(sender.messages).toHaveLength(1);
  });

  it('keeps cooldown after successful or exhausted consumption and isolates purposes', async () => {
    const consumed = await createChallenge('code_login');
    await service.consume({ challengeId: consumed.challengeId, target: consumed.target, code: consumed.code, purpose: 'code_login' });
    await expect(service.requestChallenge(consumed.target, 'code_login')).rejects.toMatchObject({ code: 'VERIFICATION_COOLDOWN' });

    const exhausted = await createChallenge('code_login');
    const wrongCode = exhausted.code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        service.consume({ challengeId: exhausted.challengeId, target: exhausted.target, code: wrongCode, purpose: 'code_login' }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_INVALID' });
    }
    await expect(service.requestChallenge(exhausted.target, 'code_login')).rejects.toMatchObject({ code: 'VERIFICATION_COOLDOWN' });

    const isolatedTarget = normalizeContact(`${randomUUID().slice(0, 8)}@example.test`);
    const codeLoginChallenge = await service.requestChallenge(isolatedTarget, 'code_login');
    const resetChallenge = await service.requestChallenge(isolatedTarget, 'reset_password');
    challengeIds.add(codeLoginChallenge);
    challengeIds.add(resetChallenge);
  });

  it('serializes concurrent challenge sends for the same target and purpose', async () => {
    const target = normalizeContact(`${randomUUID().slice(0, 8)}@example.test`);
    const results = await Promise.allSettled([
      service.requestChallenge(target, 'code_login'),
      service.requestChallenge(target, 'code_login'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const fulfilled = results.find((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled');
    if (fulfilled) challengeIds.add(fulfilled.value);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'VERIFICATION_COOLDOWN' },
    });
  });

  it('persists wrong-code attempts and consumes the challenge at five failures', async () => {
    const challenge = await createChallenge('code_login');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        service.consume({ challengeId: challenge.challengeId, target: challenge.target, code: '000000', purpose: 'code_login' }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_INVALID' });
      const [rows] = await pool.query<Array<{ failed_attempts: number; consumed_at: string | null }>>(
        'SELECT failed_attempts, consumed_at FROM verification_challenges WHERE challenge_id_hash = ?',
        [sha256(challenge.challengeId)],
      );
      expect(Number(rows[0]?.failed_attempts)).toBe(attempt);
    }
    await expect(
      service.consume({ challengeId: challenge.challengeId, target: challenge.target, code: challenge.code, purpose: 'code_login' }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_INVALID' });
  });

  it('rejects cross-purpose consumption without destroying the valid challenge', async () => {
    const challenge = await createChallenge('code_login');
    await expect(
      service.consume({ challengeId: challenge.challengeId, target: challenge.target, code: challenge.code, purpose: 'reset_password' }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_INVALID' });
    await expect(
      service.consume({ challengeId: challenge.challengeId, target: challenge.target, code: challenge.code, purpose: 'code_login' }),
    ).resolves.toMatchObject({ purpose: 'code_login' });
  });

  it('allows only one concurrent consumer and makes expiration terminal', async () => {
    const concurrent = await createChallenge('code_login');
    const results = await Promise.allSettled([
      service.consume({ challengeId: concurrent.challengeId, target: concurrent.target, code: concurrent.code, purpose: 'code_login' }),
      service.consume({ challengeId: concurrent.challengeId, target: concurrent.target, code: concurrent.code, purpose: 'code_login' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const expired = await createChallenge('reset_password');
    await pool.execute(
      'UPDATE verification_challenges SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE challenge_id_hash = ?',
      [sha256(expired.challengeId)],
    );
    await expect(
      service.consume({ challengeId: expired.challengeId, target: expired.target, code: expired.code, purpose: 'reset_password' }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_INVALID' });
  });

  it('rolls back callback business writes while keeping a successful challenge retryable', async () => {
    const challenge = await createChallenge('code_login');
    await expect(
      service.consumeWithTransaction(
        { challengeId: challenge.challengeId, target: challenge.target, code: challenge.code, purpose: 'code_login' },
        async (connection) => {
          await connection.execute(
            `INSERT INTO audit_logs (id, event_type, metadata_json)
             VALUES (?, 'task3.test.rollback', JSON_OBJECT('source', 'verification-test'))`,
            [randomUUID()],
          );
          throw new Error('injected business failure');
        },
      ),
    ).rejects.toThrow('injected business failure');
    const [challengeRows] = await pool.query<Array<{ consumed_at: string | null }>>(
      'SELECT consumed_at FROM verification_challenges WHERE challenge_id_hash = ?',
      [sha256(challenge.challengeId)],
    );
    expect(challengeRows[0]?.consumed_at).toBeNull();
    await expect(
      service.consume({ challengeId: challenge.challengeId, target: challenge.target, code: challenge.code, purpose: 'code_login' }),
    ).resolves.toMatchObject({ purpose: 'code_login' });
  });

  it('marks sender failure and the unavailable default as failed without returning a code', async () => {
    sender.fail = true;
    const failedTarget = normalizeContact(`${randomUUID().slice(0, 8)}@example.test`);
    await expect(service.requestChallenge(failedTarget, 'reset_password')).rejects.toBeInstanceOf(VerificationSenderUnavailableError);
    const [failedRows] = await pool.query<Array<{ send_status: string; consumed_at: string | null }>>(
      `SELECT send_status, consumed_at FROM verification_challenges
        WHERE target_hmac IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    );
    expect(failedRows[0]?.send_status).toBe('failed');

    const unavailable = new VerificationService({ pool, authHmacKey, sender: new UnavailableSender() });
    const unavailableTarget = normalizeContact(`${randomUUID().slice(0, 8)}@example.test`);
    await expect(unavailable.requestChallenge(unavailableTarget, 'code_login')).rejects.toBeInstanceOf(
      VerificationSenderUnavailableError,
    );
  });
});
