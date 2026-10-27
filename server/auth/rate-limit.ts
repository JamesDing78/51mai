import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { hmacSha256, resolveAuthHmacKey } from './sessions.js';

export interface PersistentRateLimiterOptions {
  pool: Pool;
  authHmacKey: Buffer;
  windowSeconds: number;
  maxAttempts: number;
}

export interface RateLimitResult {
  allowed: boolean;
  attemptCount: number;
  retryAfterSeconds: number;
}

interface RateLimitRow extends RowDataPacket {
  attempt_count: number | string;
  retry_after_seconds: number | string;
}

function validateInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export class PersistentRateLimiter {
  private readonly pool: Pool;
  private readonly authHmacKey: Buffer;
  private readonly windowSeconds: number;
  private readonly maxAttempts: number;

  constructor(options: PersistentRateLimiterOptions) {
    this.pool = options.pool;
    this.authHmacKey = resolveAuthHmacKey(options.authHmacKey);
    this.windowSeconds = validateInteger('windowSeconds', options.windowSeconds, 1, 86_400);
    this.maxAttempts = validateInteger('maxAttempts', options.maxAttempts, 1, 1_000_000);
  }

  hashKey(parts: readonly string[]): Buffer {
    const canonical = parts.map((part) => String(part)).join('\u001f');
    return hmacSha256(this.authHmacKey, `51mai/auth/rate-limit/v1:${canonical}`);
  }

  async consume(parts: readonly string[]): Promise<RateLimitResult> {
    const keyHash = this.hashKey(parts);
    const ownConnection = await this.pool.getConnection();
    try {
      await ownConnection.beginTransaction();
      const result = await this.consumeOnConnection(ownConnection, keyHash);
      await ownConnection.commit();
      return result;
    } catch (error) {
      await ownConnection.rollback().catch(() => undefined);
      throw error;
    } finally {
      ownConnection.release();
    }
  }

  private async consumeOnConnection(connection: PoolConnection, keyHash: Buffer): Promise<RateLimitResult> {
    const windowSeconds = this.windowSeconds;
    await connection.execute(
      `INSERT INTO auth_rate_limits (rate_key_hmac, window_started_at, attempt_count)
       VALUES (?, UTC_TIMESTAMP(6), 1)
       ON DUPLICATE KEY UPDATE
         attempt_count = IF(
           window_started_at <= UTC_TIMESTAMP(6) - INTERVAL ${windowSeconds} SECOND,
           1,
           attempt_count + 1
         ),
         window_started_at = IF(
           window_started_at <= UTC_TIMESTAMP(6) - INTERVAL ${windowSeconds} SECOND,
           UTC_TIMESTAMP(6),
           window_started_at
         )`,
      [keyHash],
    );
    const [rows] = await connection.execute<RateLimitRow[]>(
      `SELECT attempt_count,
              GREATEST(
                0,
                CEIL(TIMESTAMPDIFF(
                  MICROSECOND,
                  UTC_TIMESTAMP(6),
                  DATE_ADD(window_started_at, INTERVAL ${windowSeconds} SECOND)
                ) / 1000000)
              ) AS retry_after_seconds
         FROM auth_rate_limits
        WHERE rate_key_hmac = ?
        FOR UPDATE`,
      [keyHash],
    );
    const row = rows[0];
    if (!row) throw new Error('Rate limit row was not persisted');
    const attemptCount = Number(row.attempt_count);
    return {
      allowed: attemptCount <= this.maxAttempts,
      attemptCount,
      retryAfterSeconds: Number(row.retry_after_seconds),
    };
  }
}
