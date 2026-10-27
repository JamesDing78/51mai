import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 20;
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;
const SCRYPT_CONCURRENCY = 1;
const MAX_PENDING_SCRYPTS = 64;

const HASH_PREFIX = `scrypt$${'v1'}$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$`;
const HASH_PATTERN = new RegExp(
  `^${HASH_PREFIX.replaceAll('$', '\\$')}([A-Za-z0-9_-]{22})\\$([A-Za-z0-9_-]{43})$`,
);

export const DUMMY_PASSWORD_HASH =
  `${HASH_PREFIX}AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

export class PasswordPolicyError extends Error {
  readonly code = 'PASSWORD_LENGTH';

  constructor() {
    super('Password length must be between 8 and 20 characters');
    this.name = 'PasswordPolicyError';
  }
}

export class PasswordHashBusyError extends Error {
  readonly code = 'PASSWORD_HASH_BUSY';

  constructor() {
    super('Password hashing is temporarily busy');
    this.name = 'PasswordHashBusyError';
  }
}

interface PendingJob<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

class ScryptQueue {
  private active = 0;
  private readonly pending: PendingJob<Buffer>[] = [];

  run(job: () => Promise<Buffer>): Promise<Buffer> {
    if (this.pending.length >= MAX_PENDING_SCRYPTS) return Promise.reject(new PasswordHashBusyError());
    return new Promise<Buffer>((resolve, reject) => {
      this.pending.push({ run: job, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < SCRYPT_CONCURRENCY && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) return;
      this.active += 1;
      void next
        .run()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}

const scryptQueue = new ScryptQueue();

function passwordLength(password: string): number {
  return Array.from(password).length;
}

function hasValidPasswordLength(password: unknown): password is string {
  return typeof password === 'string' && passwordLength(password) >= PASSWORD_MIN_LENGTH && passwordLength(password) <= PASSWORD_MAX_LENGTH;
}

function assertPasswordPolicy(password: string): void {
  if (!hasValidPasswordLength(password)) {
    throw new PasswordPolicyError();
  }
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return scryptQueue.run(async () => {
    return new Promise<Buffer>((resolve, reject) => {
      scryptCallback(
        password,
        salt,
        DERIVED_KEY_BYTES,
        {
          N: SCRYPT_N,
          r: SCRYPT_R,
          p: SCRYPT_P,
          maxmem: SCRYPT_MAX_MEMORY,
        },
        (error, derived) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(Buffer.from(derived));
        },
      );
    });
  });
}

function decodeHash(encoded: string): { salt: Buffer; expected: Buffer } | undefined {
  if (typeof encoded !== 'string') return undefined;
  const match = HASH_PATTERN.exec(encoded);
  if (!match) return undefined;
  const salt = Buffer.from(match[1], 'base64url');
  const expected = Buffer.from(match[2], 'base64url');
  if (salt.length !== SALT_BYTES || expected.length !== DERIVED_KEY_BYTES) return undefined;
  return { salt, expected };
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = await deriveKey(password, salt);
  return `${HASH_PREFIX}${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!hasValidPasswordLength(password)) {
    return false;
  }
  const decoded = decodeHash(encoded);
  if (!decoded) return false;
  try {
    const derived = await deriveKey(password, decoded.salt);
    return derived.length === decoded.expected.length && timingSafeEqual(derived, decoded.expected);
  } catch {
    return false;
  }
}

/**
 * Login verification entry point. Callers should use a null hash for an
 * unknown account so that every valid-length login attempt performs one
 * password KDF before the result is decided.
 */
export async function verifyLoginPassword(password: string, encoded: string | null | undefined): Promise<boolean> {
  if (!hasValidPasswordLength(password)) return false;
  const decoded = decodeHash(encoded ?? '');
  const target = decoded ?? decodeHash(DUMMY_PASSWORD_HASH);
  if (!target) throw new Error('Invalid dummy password hash');
  const derived = await deriveKey(password, target.salt);
  const matches = derived.length === target.expected.length && timingSafeEqual(derived, target.expected);
  return decoded !== undefined && matches;
}

export const passwordHashParameters = Object.freeze({
  version: 'v1',
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: SCRYPT_MAX_MEMORY,
  concurrency: SCRYPT_CONCURRENCY,
  maxPending: MAX_PENDING_SCRYPTS,
});
