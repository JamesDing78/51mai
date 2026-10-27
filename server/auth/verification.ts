import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { hmacSha256, resolveAuthHmacKey, sha256 } from './sessions.js';
import {
  type VerificationPurpose,
  type VerificationSender,
  VerificationSenderUnavailableError,
} from './sender.js';

export type ContactKind = 'email' | 'phone';

export interface NormalizedContact {
  kind: ContactKind;
  value: string;
}

export class VerificationInputError extends Error {
  readonly code = 'INVALID_IDENTIFIER';

  constructor() {
    super('Identifier is invalid');
    this.name = 'VerificationInputError';
  }
}

export class VerificationError extends Error {
  readonly code: 'VERIFICATION_INVALID' | 'VERIFICATION_COOLDOWN';
  readonly status: 401 | 429;
  readonly retryAfterSeconds?: number;

  constructor(code: 'VERIFICATION_INVALID' | 'VERIFICATION_COOLDOWN', status: 401 | 429, retryAfterSeconds?: number) {
    super(code === 'VERIFICATION_COOLDOWN' ? 'Too many verification requests' : 'Verification failed');
    this.name = 'VerificationError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface ContactRow extends RowDataPacket {
  id: string;
  user_id: string;
  verified_at: string | Date | null;
}

interface ChallengeRow extends RowDataPacket {
  challenge_id_hash: Buffer;
  user_id: string | null;
  contact_id: string | null;
  target_kind: ContactKind;
  target_hmac: Buffer;
  purpose: VerificationPurpose;
  code_hmac: Buffer;
  expires_at: string | Date;
  failed_attempts: number | string;
  consumed_at: string | Date | null;
  send_status: 'pending' | 'sent' | 'failed';
}

export interface ConsumedChallenge {
  challengeIdHash: Buffer;
  userId: string | null;
  contactId: string | null;
  target: NormalizedContact;
  purpose: VerificationPurpose;
}

const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PHONE_PATTERN = /^1[3-9][0-9]{9}$/;
const INTERNATIONAL_PHONE_PATTERN = /^\+861[3-9][0-9]{9}$/;
const CHALLENGE_TTL_SECONDS = 300;
const CHALLENGE_COOLDOWN_SECONDS = 60;
const MAX_FAILED_ATTEMPTS = 5;

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function targetHmac(authHmacKey: Buffer, target: NormalizedContact): Buffer {
  return hmacSha256(authHmacKey, `51mai/auth/verification-target/v1:${target.kind}:${target.value}`);
}

function codeHmac(authHmacKey: Buffer, challengeId: string, purpose: VerificationPurpose, code: string): Buffer {
  return hmacSha256(authHmacKey, `51mai/auth/verification-code/v1:${purpose}:${challengeId}:${code}`);
}

function dateToMilliseconds(value: string | Date): number {
  if (value instanceof Date) return value.getTime();
  const isoLike = value.replace(' ', 'T').replace(/\.(\d{3})\d+$/, '.$1');
  return Date.parse(`${isoLike}Z`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function normalizeContact(input: unknown): NormalizedContact {
  if (typeof input !== 'string') throw new VerificationInputError();
  const value = input.normalize('NFKC').trim();
  if (!value || value.length > 320 || /[\p{Cc}\p{White_Space}]/u.test(value)) throw new VerificationInputError();

  if (EMAIL_PATTERN.test(value)) return { kind: 'email', value: value.toLowerCase() };
  if (PHONE_PATTERN.test(value)) return { kind: 'phone', value: `+86${value}` };
  if (INTERNATIONAL_PHONE_PATTERN.test(value)) return { kind: 'phone', value };
  throw new VerificationInputError();
}

export interface VerificationServiceOptions {
  pool: Pool;
  authHmacKey: Buffer;
  sender: VerificationSender;
  now?: () => number;
}

export class VerificationService {
  private readonly pool: Pool;
  private readonly authHmacKey: Buffer;
  private readonly sender: VerificationSender;
  private readonly now: () => number;

  constructor(options: VerificationServiceOptions) {
    this.pool = options.pool;
    this.authHmacKey = resolveAuthHmacKey(options.authHmacKey);
    this.sender = options.sender;
    this.now = options.now ?? Date.now;
  }

  async requestChallenge(target: NormalizedContact, purpose: VerificationPurpose): Promise<string> {
    const challengeId = randomBytes(32).toString('base64url');
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const targetDigest = targetHmac(this.authHmacKey, target);
    const challengeDigest = sha256(challengeId);
    const codeDigest = codeHmac(this.authHmacKey, challengeId, purpose, code);
    const connection = await this.pool.getConnection();
    const lockName = `51mai:v:${targetDigest.toString('hex').slice(0, 32)}:${purpose}`;
    let committed = false;
    let lockHeld = false;

    try {
      const [lockRows] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 5) AS lock_acquired', [lockName]);
      if (Number((lockRows[0] as { lock_acquired?: unknown } | undefined)?.lock_acquired) !== 1) {
        throw new VerificationSenderUnavailableError();
      }
      lockHeld = true;
      await connection.beginTransaction();
      const [cooldownRows] = await connection.execute<RowDataPacket[]>(
        `SELECT challenge_id_hash
           FROM verification_challenges
          WHERE target_hmac = ?
            AND purpose = ?
            AND send_status IN ('pending', 'sent')
            AND cooldown_until > UTC_TIMESTAMP(6)
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [targetDigest, purpose],
      );
      if (cooldownRows[0]) {
        await connection.rollback();
        throw new VerificationError('VERIFICATION_COOLDOWN', 429, CHALLENGE_COOLDOWN_SECONDS);
      }

      const [contactRows] = await connection.execute<ContactRow[]>(
        `SELECT id, user_id, verified_at
           FROM user_contacts
          WHERE kind = ? AND identifier_normalized = ?
          LIMIT 1
          FOR UPDATE`,
        [target.kind, target.value],
      );
      const contact = contactRows[0];
      const userId = contact?.verified_at ? contact.user_id : null;
      if (contact) {
        await connection.execute(
          `UPDATE verification_challenges
              SET consumed_at = COALESCE(consumed_at, UTC_TIMESTAMP(6))
            WHERE contact_id = ? AND purpose = ? AND consumed_at IS NULL`,
          [contact.id, purpose],
        );
      } else {
        await connection.execute(
          `UPDATE verification_challenges
              SET consumed_at = COALESCE(consumed_at, UTC_TIMESTAMP(6))
            WHERE target_hmac = ? AND purpose = ? AND consumed_at IS NULL`,
          [targetDigest, purpose],
        );
      }
      await connection.execute(
        `INSERT INTO verification_challenges
          (challenge_id_hash, user_id, contact_id, target_kind, target_hmac, purpose, code_hmac,
           expires_at, failed_attempts, send_status, cooldown_until)
         VALUES (?, ?, ?, ?, ?, ?, ?,
                 DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${CHALLENGE_TTL_SECONDS} SECOND),
                 0, 'pending',
                 DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${CHALLENGE_COOLDOWN_SECONDS} SECOND))`,
        [challengeDigest, userId, contact?.id ?? null, target.kind, targetDigest, purpose, codeDigest],
      );
      await connection.commit();
      committed = true;
    } catch (error) {
      if (!committed) await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      if (lockHeld) {
        await connection.execute('SELECT RELEASE_LOCK(?) AS lock_released', [lockName]).catch(() => undefined);
      }
      connection.release();
    }

    try {
      await this.sender.send({ destination: target.value, code, purpose });
    } catch {
      await this.markSendFailed(challengeDigest);
      throw new VerificationSenderUnavailableError();
    }

    const [result] = await this.pool.execute(
      `UPDATE verification_challenges
          SET send_status = 'sent'
        WHERE challenge_id_hash = ? AND send_status = 'pending' AND consumed_at IS NULL`,
      [challengeDigest],
    );
    if ((result as { affectedRows?: number }).affectedRows !== 1) {
      throw new VerificationSenderUnavailableError();
    }
    return challengeId;
  }

  async consumeWithTransaction<T>(
    input: {
      challengeId: string;
      target: NormalizedContact;
      code: string;
      purpose: VerificationPurpose;
    },
    callback: (connection: PoolConnection, consumed: ConsumedChallenge) => Promise<T>,
  ): Promise<T> {
    const challengeDigest = sha256(input.challengeId);
    const targetDigest = targetHmac(this.authHmacKey, input.target);
    const candidateCode = typeof input.code === 'string' ? input.code : String(input.code);
    const candidateCodeDigest = codeHmac(this.authHmacKey, input.challengeId, input.purpose, candidateCode);
    const connection = await this.pool.getConnection();
    let committed = false;

    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<ChallengeRow[]>(
        `SELECT challenge_id_hash, user_id, contact_id, target_kind, target_hmac, purpose, code_hmac,
                expires_at, failed_attempts, consumed_at, send_status
           FROM verification_challenges
          WHERE challenge_id_hash = ?
          LIMIT 1
          FOR UPDATE`,
        [challengeDigest],
      );
      const row = rows[0];
      const expired = row ? dateToMilliseconds(row.expires_at) <= this.now() : false;
      const active = Boolean(row && row.send_status === 'sent' && !row.consumed_at && !expired);
      const targetMatches = Boolean(row && safeEqual(Buffer.from(row.target_hmac), targetDigest));
      const purposeMatches = Boolean(row && row.purpose === input.purpose && row.target_kind === input.target.kind);
      const codeMatches = Boolean(row && safeEqual(Buffer.from(row.code_hmac), candidateCodeDigest));

      if (!active || !targetMatches || !purposeMatches || !codeMatches) {
        if (row && active) {
          const failedAttempts = Number(row.failed_attempts);
          const nextAttempts = Math.min(MAX_FAILED_ATTEMPTS, failedAttempts + 1);
          await connection.execute(
            `UPDATE verification_challenges
                SET failed_attempts = ?,
                    consumed_at = IF(? >= ?, UTC_TIMESTAMP(6), consumed_at)
              WHERE challenge_id_hash = ?`,
            [nextAttempts, nextAttempts, MAX_FAILED_ATTEMPTS, challengeDigest],
          );
        } else if (row && !row.consumed_at && expired) {
          await connection.execute(
            `UPDATE verification_challenges SET consumed_at = UTC_TIMESTAMP(6) WHERE challenge_id_hash = ?`,
            [challengeDigest],
          );
        }
        await connection.commit();
        committed = true;
        throw new VerificationError('VERIFICATION_INVALID', 401);
      }

      const consumed: ConsumedChallenge = {
        challengeIdHash: Buffer.from(row.challenge_id_hash),
        userId: row.user_id,
        contactId: row.contact_id,
        target: input.target,
        purpose: input.purpose,
      };
      const result = await callback(connection, consumed);
      await connection.execute(
        `UPDATE verification_challenges
            SET consumed_at = UTC_TIMESTAMP(6)
          WHERE challenge_id_hash = ? AND consumed_at IS NULL`,
        [challengeDigest],
      );
      await connection.commit();
      committed = true;
      return result;
    } catch (error) {
      if (!committed) await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async consume(input: {
    challengeId: string;
    target: NormalizedContact;
    code: string;
    purpose: VerificationPurpose;
  }): Promise<ConsumedChallenge> {
    return this.consumeWithTransaction(input, async (_connection, consumed) => consumed);
  }

  private async markSendFailed(challengeDigest: Buffer): Promise<void> {
    try {
      await this.pool.execute(
        `UPDATE verification_challenges
            SET send_status = 'failed', consumed_at = COALESCE(consumed_at, UTC_TIMESTAMP(6))
          WHERE challenge_id_hash = ? AND send_status = 'pending'`,
        [challengeDigest],
      );
    } catch {
      // The caller still receives a generic unavailable response. Do not expose provider or SQL details.
    }
  }
}

export const verificationPolicy = Object.freeze({
  ttlSeconds: CHALLENGE_TTL_SECONDS,
  cooldownSeconds: CHALLENGE_COOLDOWN_SECONDS,
  maxFailedAttempts: MAX_FAILED_ATTEMPTS,
});
