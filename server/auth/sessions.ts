import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

export type AuthRole = 'customer' | 'admin';

export interface AuthUser {
  id: string;
  username: string;
  role: AuthRole;
}

export interface SessionContext {
  user: AuthUser;
  tokenHash: Buffer;
  csrfTokenHash: Buffer;
  csrfToken: string;
  expiresAt: string;
}

export interface IssuedSession {
  user: AuthUser;
  csrfToken: string;
  expiresAt: string;
  /** Internal Set-Cookie value. Never include this field in an API response or log. */
  cookieHeader: string;
}

export interface SessionManagerOptions {
  pool: Pool;
  cookieName: string;
  secureCookie: boolean;
  authHmacKey: Buffer;
  sessionTtlSeconds: number;
  rememberSessionTtlSeconds: number;
}

export interface IssueSessionOptions {
  remember?: boolean;
  connection?: PoolConnection;
}

export type SessionDbExecutor = Pool | PoolConnection;

interface SessionRow extends RowDataPacket {
  token_hash: Buffer;
  user_id: string;
  csrf_token_hash: Buffer;
  expires_at: string | Date;
  username_normalized: string;
  role: AuthRole;
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SESSION_TOKEN_BYTES = 32;
const AUTH_HMAC_DOMAIN = '51mai/auth/csrf/v1';

export function resolveAuthHmacKey(key?: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length < 32) {
    throw new Error('AUTH_HMAC_KEY must be at least 32 bytes');
  }
  return Buffer.from(key);
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

export function hmacSha256(key: Buffer, value: string | Buffer): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

export function deriveCsrfToken(sessionToken: string, authHmacKey: Buffer): string {
  const key = resolveAuthHmacKey(authHmacKey);
  return hmacSha256(key, `${AUTH_HMAC_DOMAIN}:${sessionToken}`).toString('base64url');
}

function formatUtcDate(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 19).replace('T', ' ')}.${iso.slice(20, 23)}000`;
}

function cookieEncode(value: string): string {
  return encodeURIComponent(value);
}

function cookieDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!COOKIE_NAME_PATTERN.test(name) || Object.prototype.hasOwnProperty.call(cookies, name)) continue;
    const value = cookieDecode(part.slice(separator + 1).trim());
    if (value !== undefined) cookies[name] = value;
  }
  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  options: { secure: boolean; maxAgeSeconds: number; expires?: string },
): string {
  if (!COOKIE_NAME_PATTERN.test(name)) throw new Error('Invalid session cookie name');
  const parts = [`${name}=${cookieEncode(value)}`, `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`];
  if (options.expires) parts.push(`Expires=${options.expires}`);
  parts.push('Path=/', 'HttpOnly', 'SameSite=Lax');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function tokenFromInput(input: string | undefined, cookieName: string): string | undefined {
  if (!input) return undefined;
  if (input.includes('=')) return parseCookieHeader(input)[cookieName];
  return input;
}

function isSafeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class SessionManager {
  private readonly pool: Pool;
  private readonly cookieName: string;
  private readonly secureCookie: boolean;
  private readonly authHmacKey: Buffer;
  private readonly sessionTtlSeconds: number;
  private readonly rememberSessionTtlSeconds: number;

  constructor(options: SessionManagerOptions) {
    this.pool = options.pool;
    this.cookieName = options.cookieName;
    this.secureCookie = options.secureCookie;
    this.authHmacKey = resolveAuthHmacKey(options.authHmacKey);
    this.sessionTtlSeconds = options.sessionTtlSeconds;
    this.rememberSessionTtlSeconds = options.rememberSessionTtlSeconds;
  }

  getCookieName(): string {
    return this.cookieName;
  }

  getToken(request: Request): string | undefined {
    return parseCookieHeader(request.headers.cookie)[this.cookieName];
  }

  setSessionCookie(response: Response, session: IssuedSession): void {
    response.append('Set-Cookie', session.cookieHeader);
  }

  clearSessionCookie(response: Response): void {
    response.append('Set-Cookie', this.clearCookieHeader());
  }

  clearCookieHeader(): string {
    return serializeCookie(this.cookieName, '', {
      secure: this.secureCookie,
      maxAgeSeconds: 0,
      expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
    });
  }

  async issueSession(user: AuthUser, options: IssueSessionOptions = {}): Promise<IssuedSession> {
    const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const csrfToken = deriveCsrfToken(sessionToken, this.authHmacKey);
    const tokenHash = sha256(sessionToken);
    const csrfTokenHash = sha256(csrfToken);
    const ttlSeconds = options.remember ? this.rememberSessionTtlSeconds : this.sessionTtlSeconds;
    const expiresAt = formatUtcDate(new Date(Date.now() + ttlSeconds * 1000));
    const executor = options.connection ?? this.pool;
    await executor.execute(
      'INSERT INTO sessions (token_hash, user_id, csrf_token_hash, expires_at) VALUES (?, ?, ?, ?)',
      [tokenHash, user.id, csrfTokenHash, expiresAt],
    );
    return {
      user,
      csrfToken,
      expiresAt,
      cookieHeader: serializeCookie(this.cookieName, sessionToken, {
        secure: this.secureCookie,
        maxAgeSeconds: ttlSeconds,
      }),
    };
  }

  async loadSession(input: string | undefined, connection?: PoolConnection): Promise<SessionContext | null> {
    const sessionToken = tokenFromInput(input, this.cookieName);
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
    const tokenHash = sha256(sessionToken);
    const executor = connection ?? this.pool;
    const [rows] = await executor.execute<SessionRow[]>(
      `SELECT s.token_hash, s.user_id, s.csrf_token_hash, s.expires_at,
              u.username_normalized, u.role
         FROM sessions AS s
         INNER JOIN users AS u ON u.id = s.user_id
        WHERE s.token_hash = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > UTC_TIMESTAMP(6)
          AND u.account_status = 'active'
        LIMIT 1`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;
    const csrfToken = deriveCsrfToken(sessionToken, this.authHmacKey);
    const csrfTokenHash = Buffer.from(row.csrf_token_hash);
    if (!isSafeEqual(sha256(csrfToken), csrfTokenHash)) return null;
    return {
      user: { id: row.user_id, username: row.username_normalized, role: row.role },
      tokenHash: Buffer.from(row.token_hash),
      csrfTokenHash,
      csrfToken,
      expiresAt: row.expires_at instanceof Date ? formatUtcDate(row.expires_at) : String(row.expires_at),
    };
  }

  async loadSessionFromRequest(request: Request, connection?: PoolConnection): Promise<SessionContext | null> {
    return this.loadSession(this.getToken(request), connection);
  }

  verifyCsrf(session: SessionContext, candidate: string | undefined): boolean {
    if (typeof candidate !== 'string') return false;
    return isSafeEqual(sha256(candidate), session.csrfTokenHash);
  }

  async revokeSession(input: string | undefined, connection?: PoolConnection): Promise<void> {
    const sessionToken = tokenFromInput(input, this.cookieName);
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return;
    const executor = connection ?? this.pool;
    await executor.execute(
      'UPDATE sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(6)) WHERE token_hash = ? AND revoked_at IS NULL',
      [sha256(sessionToken)],
    );
  }

  async revokeAllSessions(userId: string, connection?: PoolConnection): Promise<void> {
    const executor = connection ?? this.pool;
    await executor.execute(
      'UPDATE sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(6)) WHERE user_id = ? AND revoked_at IS NULL',
      [userId],
    );
  }

  async rotateSession(
    input: string | undefined,
    user: AuthUser,
    options: IssueSessionOptions = {},
  ): Promise<IssuedSession> {
    await this.revokeSession(input, options.connection);
    return this.issueSession(user, options);
  }
}
