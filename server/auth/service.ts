import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { hashPassword, PasswordHashBusyError, PasswordPolicyError, verifyLoginPassword } from './password.js';
import { PersistentRateLimiter } from './rate-limit.js';
import { SessionManager, type AuthRole, type AuthUser, type IssuedSession } from './sessions.js';
import {
  normalizeContact,
  type NormalizedContact,
  type VerificationService,
} from './verification.js';
import type { VerificationPurpose } from './sender.js';

export interface AuthPolicy {
  termsVersion: string;
  privacyVersion: string;
  termsUrl: string;
  privacyUrl: string;
}

export const DEFAULT_AUTH_POLICY: AuthPolicy = Object.freeze({
  termsVersion: 'terms-v1',
  privacyVersion: 'privacy-v1',
  termsUrl: '/terms',
  privacyUrl: '/privacy',
});

export interface RequestMeta {
  sourceIp: string;
  userAgent?: string;
  sessionCookie?: string;
}

export class AuthInputError extends Error {
  readonly code:
    | 'INVALID_REQUEST'
    | 'PASSWORD_LENGTH'
    | 'PASSWORD_MISMATCH'
    | 'CONSENT_REQUIRED'
    | 'INVALID_IDENTIFIER';
  readonly status = 400;

  constructor(
    code: AuthInputError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'AuthInputError';
    this.code = code;
  }
}

export class AuthServiceError extends Error {
  readonly code: 'RATE_LIMITED' | 'USERNAME_TAKEN' | 'AUTHENTICATION_FAILED' | 'SERVICE_UNAVAILABLE';
  readonly status: 401 | 409 | 429 | 503;
  readonly retryAfterSeconds?: number;

  constructor(
    code: AuthServiceError['code'],
    status: AuthServiceError['status'],
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AuthServiceError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type LoginIdentifier =
  | { kind: 'username'; value: string }
  | { kind: 'contact'; contact: NormalizedContact };

export interface RegisterInput {
  username: string;
  password: string;
  confirmPassword: string;
  termsVersion: string;
  privacyVersion: string;
  acceptTerms: boolean;
}

export interface LoginInput {
  identifier: LoginIdentifier;
  password: string;
  remember: boolean;
}

export interface CodeLoginInput {
  challengeId: string;
  target: NormalizedContact;
  code: string;
  termsVersion: string;
  privacyVersion: string;
  acceptTerms: boolean;
}

export interface ResetPasswordInput {
  challengeId: string;
  target: NormalizedContact;
  code: string;
  password: string;
  confirmPassword: string;
}

interface UserRow extends RowDataPacket {
  id: string;
  username_normalized: string;
  password_hash: string | null;
  account_status: 'active' | 'frozen' | 'disabled';
  role: AuthRole;
}

interface ContactUserRow extends UserRow {
  contact_id: string;
  contact_verified_at: string | Date | null;
}

interface ContactRow extends RowDataPacket {
  id: string;
  user_id: string;
  verified_at: string | Date | null;
}

export interface AuthServiceOptions {
  pool: Pool;
  sessions: SessionManager;
  limiter: PersistentRateLimiter;
  verification: VerificationService;
  policy?: AuthPolicy;
}

function isDuplicateError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

function publicUser(row: Pick<UserRow, 'id' | 'username_normalized' | 'role'>): AuthUser {
  return { id: row.id, username: row.username_normalized, role: row.role };
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string') throw new AuthInputError('PASSWORD_LENGTH', 'Password must be between 8 and 20 characters');
  const length = Array.from(password).length;
  if (length < 8 || length > 20) {
    throw new AuthInputError('PASSWORD_LENGTH', 'Password must be between 8 and 20 characters');
  }
}

function assertConsent(input: Pick<RegisterInput, 'termsVersion' | 'privacyVersion' | 'acceptTerms'>, policy: AuthPolicy): void {
  if (input.acceptTerms !== true || input.termsVersion !== policy.termsVersion || input.privacyVersion !== policy.privacyVersion) {
    throw new AuthInputError('CONSENT_REQUIRED', 'Current terms and privacy consent are required');
  }
}

export function normalizeUsername(input: unknown): string {
  if (typeof input !== 'string') throw new AuthInputError('INVALID_IDENTIFIER', 'Username is invalid');
  const normalized = input.normalize('NFKC').trim().toLowerCase();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > 64 ||
    /[\p{Cc}\p{White_Space}]/u.test(normalized) ||
    normalized.includes('@') ||
    /^(?:\+?86)?1[3-9][0-9]{9}$/.test(normalized)
  ) {
    throw new AuthInputError('INVALID_IDENTIFIER', 'Username is invalid');
  }
  return normalized;
}

export function normalizeLoginIdentifier(input: unknown): LoginIdentifier {
  if (typeof input !== 'string') throw new AuthInputError('INVALID_IDENTIFIER', 'Identifier is invalid');
  const normalized = input.normalize('NFKC').trim();
  if (!normalized) throw new AuthInputError('INVALID_IDENTIFIER', 'Identifier is invalid');
  if (normalized.includes('@') || /^(?:\+?86)?1[3-9][0-9]{9}$/.test(normalized)) {
    try {
      return { kind: 'contact', contact: normalizeContact(normalized) };
    } catch {
      throw new AuthInputError('INVALID_IDENTIFIER', 'Identifier is invalid');
    }
  }
  return { kind: 'username', value: normalizeUsername(normalized) };
}

function userAgentValue(userAgent: string | undefined): string | null {
  if (typeof userAgent !== 'string' || userAgent.length === 0) return null;
  return userAgent.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 255);
}

function begin(connection: PoolConnection): Promise<void> {
  return connection.beginTransaction();
}

async function rollback(connection: PoolConnection): Promise<void> {
  await connection.rollback().catch(() => undefined);
}

async function writeLoginLog(connection: PoolConnection, userId: string | null, succeeded: boolean, meta: RequestMeta): Promise<void> {
  await connection.execute(
    `INSERT INTO login_logs (id, user_id, succeeded, ip_address, user_agent)
     VALUES (?, ?, ?, INET6_ATON(?), ?)`,
    [randomUUID(), userId, succeeded ? 1 : 0, meta.sourceIp.slice(0, 255), userAgentValue(meta.userAgent)],
  );
}

async function writeConsent(connection: PoolConnection, userId: string, policy: AuthPolicy): Promise<void> {
  await connection.execute(
    `INSERT INTO registration_consents (id, user_id, terms_version, privacy_version)
     VALUES (?, ?, ?, ?)`,
    [randomUUID(), userId, policy.termsVersion, policy.privacyVersion],
  );
}

function mapPasswordError(error: unknown): AuthServiceError {
  if (error instanceof PasswordHashBusyError) {
    return new AuthServiceError('SERVICE_UNAVAILABLE', 503, 'Authentication service unavailable');
  }
  if (error instanceof PasswordPolicyError) {
    return new AuthServiceError('SERVICE_UNAVAILABLE', 503, 'Authentication service unavailable');
  }
  return new AuthServiceError('SERVICE_UNAVAILABLE', 503, 'Authentication service unavailable');
}

export class AuthService {
  private readonly pool: Pool;
  private readonly sessions: SessionManager;
  private readonly limiter: PersistentRateLimiter;
  private readonly verification: VerificationService;
  readonly policy: AuthPolicy;

  constructor(options: AuthServiceOptions) {
    this.pool = options.pool;
    this.sessions = options.sessions;
    this.limiter = options.limiter;
    this.verification = options.verification;
    this.policy = options.policy ?? DEFAULT_AUTH_POLICY;
  }

  async register(input: RegisterInput, meta: RequestMeta): Promise<IssuedSession> {
    const username = normalizeUsername(input.username);
    assertPassword(input.password);
    if (input.password !== input.confirmPassword) throw new AuthInputError('PASSWORD_MISMATCH', 'Passwords do not match');
    assertConsent(input, this.policy);
    await this.consumeLimits(['register', 'username', username], ['register', 'ip', meta.sourceIp]);

    let passwordHash: string;
    try {
      passwordHash = await hashPassword(input.password);
    } catch (error) {
      throw error instanceof PasswordPolicyError || error instanceof PasswordHashBusyError ? mapPasswordError(error) : error;
    }

    const connection = await this.pool.getConnection();
    let committed = false;
    try {
      await begin(connection);
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM users WHERE username_normalized = ? LIMIT 1 FOR UPDATE',
        [username],
      );
      if (existing[0]) {
        await rollback(connection);
        throw new AuthServiceError('USERNAME_TAKEN', 409, 'Username is already registered');
      }
      const userId = randomUUID();
      await connection.execute(
        `INSERT INTO users (id, username_normalized, password_hash, account_status, role)
         VALUES (?, ?, ?, 'active', 'customer')`,
        [userId, username, passwordHash],
      );
      await writeConsent(connection, userId, this.policy);
      const issued = await this.sessions.rotateSession(
        meta.sessionCookie,
        { id: userId, username, role: 'customer' },
        { connection },
      );
      await connection.commit();
      committed = true;
      return issued;
    } catch (error) {
      if (!committed) await rollback(connection);
      if (isDuplicateError(error)) throw new AuthServiceError('USERNAME_TAKEN', 409, 'Username is already registered');
      throw error;
    } finally {
      connection.release();
    }
  }

  async login(input: LoginInput, meta: RequestMeta, options: { adminOnly?: boolean } = {}): Promise<IssuedSession> {
    assertPassword(input.password);
    const accountKey = input.identifier.kind === 'username' ? input.identifier.value : input.identifier.contact.value;
    await this.consumeLimits(['login', 'account', accountKey], ['login', 'ip', meta.sourceIp]);

    const candidate = await this.findUser(input.identifier);
    const connection = await this.pool.getConnection();
    let committed = false;
    try {
      await begin(connection);
      let locked: UserRow | undefined;
      if (candidate) {
        const [rows] = await connection.execute<UserRow[]>('SELECT id, username_normalized, password_hash, account_status, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [candidate.id]);
        locked = rows[0];
      }
      let passwordMatches = false;
      try {
        passwordMatches = await verifyLoginPassword(input.password, locked?.password_hash ?? null);
      } catch (error) {
        throw mapPasswordError(error);
      }
      const succeeded = Boolean(
        locked &&
          locked.account_status === 'active' &&
          passwordMatches &&
          (!options.adminOnly || locked.role === 'admin'),
      );
      await writeLoginLog(connection, locked?.id ?? null, succeeded, meta);
      if (!succeeded || !locked) {
        await connection.commit();
        committed = true;
        throw new AuthServiceError('AUTHENTICATION_FAILED', 401, 'Invalid credentials');
      }
      const issued = await this.sessions.rotateSession(
        meta.sessionCookie,
        publicUser(locked),
        { remember: input.remember, connection },
      );
      await connection.commit();
      committed = true;
      return issued;
    } catch (error) {
      if (!committed) await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async requestChallenge(target: NormalizedContact, purpose: VerificationPurpose, meta: RequestMeta = { sourceIp: 'unknown' }): Promise<string> {
    await this.consumeLimits(['challenge', purpose, 'target', target.value], ['challenge', purpose, 'ip', meta.sourceIp]);
    try {
      return await this.verification.requestChallenge(target, purpose);
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      throw error;
    }
  }

  async codeLogin(input: CodeLoginInput, meta: RequestMeta): Promise<IssuedSession> {
    assertConsent(input, this.policy);
    await this.consumeLimits(['code-login', 'target', input.target.value], ['code-login', 'ip', meta.sourceIp]);
    try {
      return await this.verification.consumeWithTransaction(
        {
          challengeId: input.challengeId,
          target: input.target,
          code: input.code,
          purpose: 'code_login',
        },
        async (connection, consumed) => {
          const [contactRows] = await connection.execute<ContactRow[]>(
            `SELECT id, user_id, verified_at
               FROM user_contacts
              WHERE kind = ? AND identifier_normalized = ?
              LIMIT 1
              FOR UPDATE`,
            [input.target.kind, input.target.value],
          );
          const contact = contactRows[0];
          let user: AuthUser;
          if (contact) {
            if (consumed.contactId && consumed.contactId !== contact.id) {
              throw new AuthServiceError('AUTHENTICATION_FAILED', 401, 'Invalid credentials');
            }
            if (!contact.verified_at) {
              throw new AuthServiceError('AUTHENTICATION_FAILED', 401, 'Invalid credentials');
            }
            const [userRows] = await connection.execute<UserRow[]>(
              'SELECT id, username_normalized, password_hash, account_status, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
              [contact.user_id],
            );
            const row = userRows[0];
            if (!row || row.account_status !== 'active') {
              throw new AuthServiceError('AUTHENTICATION_FAILED', 401, 'Invalid credentials');
            }
            user = publicUser(row);
          } else {
            const userId = await this.insertGeneratedCodeUser(connection);
            const contactId = randomUUID();
            await connection.execute(
              `INSERT INTO user_contacts (id, user_id, kind, identifier_normalized, verified_at)
               VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))`,
              [contactId, userId, input.target.kind, input.target.value],
            );
            await writeConsent(connection, userId, this.policy);
            user = { id: userId, username: await this.readUsername(connection, userId), role: 'customer' };
          }
          return this.sessions.rotateSession(meta.sessionCookie, user, { connection });
        },
      );
    } catch (error) {
      if (isDuplicateError(error)) throw new AuthServiceError('AUTHENTICATION_FAILED', 401, 'Invalid credentials');
      throw error;
    }
  }

  async resetPassword(input: ResetPasswordInput, meta: RequestMeta): Promise<void> {
    assertPassword(input.password);
    if (input.password !== input.confirmPassword) throw new AuthInputError('PASSWORD_MISMATCH', 'Passwords do not match');
    await this.consumeLimits(['reset', 'target', input.target.value], ['reset', 'ip', meta.sourceIp]);
    try {
      return await this.verification.consumeWithTransaction(
        {
          challengeId: input.challengeId,
          target: input.target,
          code: input.code,
          purpose: 'reset_password',
        },
        async (connection, consumed) => {
          const [contactRows] = await connection.execute<ContactRow[]>(
            `SELECT id, user_id, verified_at
               FROM user_contacts
              WHERE kind = ? AND identifier_normalized = ? AND verified_at IS NOT NULL
              LIMIT 1
              FOR UPDATE`,
            [input.target.kind, input.target.value],
          );
          const contact = contactRows[0];
          if (!contact || (consumed.contactId && consumed.contactId !== contact.id)) {
            throw new AuthServiceError('AUTHENTICATION_FAILED', 401, 'Invalid credentials');
          }
          const [userRows] = await connection.execute<UserRow[]>(
            'SELECT id, username_normalized, password_hash, account_status, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
            [contact.user_id],
          );
          const user = userRows[0];
          if (!user || user.account_status !== 'active') {
            throw new AuthServiceError('AUTHENTICATION_FAILED', 401, 'Invalid credentials');
          }
          let passwordHash: string;
          try {
            passwordHash = await hashPassword(input.password);
          } catch (error) {
            throw error instanceof PasswordPolicyError || error instanceof PasswordHashBusyError ? mapPasswordError(error) : error;
          }
          await connection.execute(
            'UPDATE users SET password_hash = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [passwordHash, user.id],
          );
          await this.sessions.revokeAllSessions(user.id, connection);
        },
      );
    } catch (error) {
      throw error;
    }
  }

  private async findUser(identifier: LoginIdentifier): Promise<UserRow | undefined> {
    if (identifier.kind === 'username') {
      const [rows] = await this.pool.execute<UserRow[]>(
        `SELECT id, username_normalized, password_hash, account_status, role
           FROM users WHERE username_normalized = ? LIMIT 1`,
        [identifier.value],
      );
      return rows[0];
    }
    const [rows] = await this.pool.execute<ContactUserRow[]>(
      `SELECT u.id, u.username_normalized, u.password_hash, u.account_status, u.role,
              c.id AS contact_id, c.verified_at AS contact_verified_at
         FROM user_contacts AS c
         INNER JOIN users AS u ON u.id = c.user_id
        WHERE c.kind = ? AND c.identifier_normalized = ? AND c.verified_at IS NOT NULL
        LIMIT 1`,
      [identifier.contact.kind, identifier.contact.value],
    );
    return rows[0];
  }

  private async insertGeneratedCodeUser(connection: PoolConnection): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const userId = randomUUID();
      const username = `user_${randomBytes(18).toString('base64url')}`;
      try {
        await connection.execute(
          `INSERT INTO users (id, username_normalized, password_hash, account_status, role)
           VALUES (?, ?, NULL, 'active', 'customer')`,
          [userId, username],
        );
        return userId;
      } catch (error) {
        if (!isDuplicateError(error) || attempt === 2) throw error;
      }
    }
    throw new Error('Could not create code-login user');
  }

  private async readUsername(connection: PoolConnection, userId: string): Promise<string> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT username_normalized FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    const username = rows[0]?.username_normalized;
    if (typeof username !== 'string') throw new Error('Created user was not found');
    return username;
  }

  private async consumeLimits(account: readonly string[], source: readonly string[]): Promise<void> {
    const accountResult = await this.limiter.consume(account);
    if (!accountResult.allowed) {
      throw new AuthServiceError('RATE_LIMITED', 429, 'Too many requests', accountResult.retryAfterSeconds);
    }
    const sourceResult = await this.limiter.consume(source);
    if (!sourceResult.allowed) {
      throw new AuthServiceError('RATE_LIMITED', 429, 'Too many requests', sourceResult.retryAfterSeconds);
    }
  }
}
