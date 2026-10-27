import type { Express, Request, RequestHandler, Response, Router } from 'express';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { PersistentRateLimiter } from './rate-limit.js';
import {
  AuthInputError,
  AuthService,
  AuthServiceError,
  DEFAULT_AUTH_POLICY,
  normalizeLoginIdentifier,
  type AuthPolicy,
  type CodeLoginInput,
  type LoginInput,
  type RegisterInput,
  type RequestMeta,
  type ResetPasswordInput,
} from './service.js';
import { SessionManager } from './sessions.js';
import { UnavailableSender, type VerificationPurpose, type VerificationSender, VerificationSenderUnavailableError } from './sender.js';
import { normalizeContact, VerificationError, VerificationInputError, VerificationService } from './verification.js';
import { noStore, requireAllowedOrigin, requestSourceIp } from './guards.js';

export interface AuthRouteDependencies {
  pool: Pool;
  allowOrigin: string;
  authHmacKey: Buffer;
  cookieName: string;
  secureCookie: boolean;
  sessionTtlSeconds: number;
  rememberSessionTtlSeconds: number;
  sender?: VerificationSender;
  policy?: AuthPolicy;
}

interface AuthRuntime {
  sessions: SessionManager;
  service: AuthService;
}

function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
  retryAfterSeconds?: number,
): void {
  if (retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  if (!response.headersSent) response.status(status).type('application/json').send({ error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBody(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new AuthInputError('INVALID_REQUEST', 'Request body is invalid');
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AuthInputError('INVALID_REQUEST', 'Request fields are invalid');
  }
  return value;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  if (typeof body[field] !== 'string') throw new AuthInputError('INVALID_REQUEST', 'Request fields are invalid');
  return body[field] as string;
}

function optionalBoolean(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  if (body[field] === undefined) return fallback;
  if (typeof body[field] !== 'boolean') throw new AuthInputError('INVALID_REQUEST', 'Request fields are invalid');
  return body[field] as boolean;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  if (body[field] === undefined) return undefined;
  if (typeof body[field] !== 'string') throw new AuthInputError('INVALID_REQUEST', 'Request fields are invalid');
  return body[field] as string;
}

function meta(request: Request): RequestMeta {
  return {
    sourceIp: requestSourceIp(request),
    userAgent: request.get('User-Agent') ?? undefined,
    sessionCookie: request.headers.cookie,
  };
}

async function requireExistingSessionCsrf(request: Request, response: Response, sessions: SessionManager): Promise<boolean> {
  const token = sessions.getToken(request);
  if (!token) return true;
  const session = await sessions.loadSessionFromRequest(request);
  if (!session) return true;
  if (!sessions.verifyCsrf(session, request.get('X-CSRF-Token'))) {
    sendError(response, 403, 'CSRF_INVALID', 'Invalid CSRF token');
    return false;
  }
  return true;
}

function handleError(error: unknown, response: Response, next: (error?: unknown) => void): void {
  if (error instanceof AuthInputError) {
    sendError(response, error.status, error.code, error.message);
    return;
  }
  if (error instanceof AuthServiceError) {
    sendError(response, error.status, error.code, error.message, error.retryAfterSeconds);
    return;
  }
  if (error instanceof VerificationInputError) {
    sendError(response, 400, error.code, error.message);
    return;
  }
  if (error instanceof VerificationError) {
    sendError(response, error.status, error.code, error.message, error.retryAfterSeconds);
    return;
  }
  if (error instanceof VerificationSenderUnavailableError) {
    sendError(response, 503, 'SERVICE_UNAVAILABLE', 'Verification service unavailable');
    return;
  }
  next(error);
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next): void => {
    void handler(request, response).catch((error: unknown) => handleError(error, response, next));
  };
}

function sendIssued(response: Response, runtime: AuthRuntime, issued: Awaited<ReturnType<AuthRuntime['service']['login']>>, status: number): void {
  runtime.sessions.setSessionCookie(response, issued);
  response.status(status).type('application/json').send({
    data: { user: issued.user, csrfToken: issued.csrfToken },
  });
}

function loginInput(body: Record<string, unknown>): LoginInput {
  return {
    identifier: normalizeLoginIdentifier(requiredString(body, 'identifier')),
    password: requiredString(body, 'password'),
    remember: optionalBoolean(body, 'remember', false),
  };
}

function isExpressApp(value: Express | Router): value is Express {
  return typeof (value as Express).listen === 'function';
}

function buildRuntime(deps: AuthRouteDependencies): AuthRuntime {
  const sessions = new SessionManager({
    pool: deps.pool,
    cookieName: deps.cookieName,
    secureCookie: deps.secureCookie,
    authHmacKey: deps.authHmacKey,
    sessionTtlSeconds: deps.sessionTtlSeconds,
    rememberSessionTtlSeconds: deps.rememberSessionTtlSeconds,
  });
  const limiter = new PersistentRateLimiter({
    pool: deps.pool,
    authHmacKey: deps.authHmacKey,
    windowSeconds: 60,
    maxAttempts: 5,
  });
  const verification = new VerificationService({
    pool: deps.pool,
    authHmacKey: deps.authHmacKey,
    sender: deps.sender ?? new UnavailableSender(),
  });
  return {
    sessions,
    service: new AuthService({
      pool: deps.pool,
      sessions,
      limiter,
      verification,
      policy: deps.policy ?? DEFAULT_AUTH_POLICY,
    }),
  };
}

function authRouter(runtime: AuthRuntime, deps: AuthRouteDependencies): Router {
  const router = express.Router();
  const origin = requireAllowedOrigin(deps.allowOrigin);
  router.use(noStore);

  router.get('/policies', noStore, (_request, response) => {
    response.type('application/json').send({ data: runtime.service.policy });
  });

  router.get(
    '/session',
    noStore,
    asyncRoute(async (request, response) => {
      const session = await runtime.sessions.loadSessionFromRequest(request);
      if (!session) {
        runtime.sessions.clearSessionCookie(response);
        sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required');
        return;
      }
      response.type('application/json').send({ data: { user: session.user, csrfToken: session.csrfToken } });
    }),
  );

  router.post(
    '/register',
    origin,
    asyncRoute(async (request, response) => {
      if (!(await requireExistingSessionCsrf(request, response, runtime.sessions))) return;
      const body = parseBody(request.body, [
        'username',
        'password',
        'confirmPassword',
        'termsVersion',
        'privacyVersion',
        'acceptTerms',
      ]);
      const input: RegisterInput = {
        username: requiredString(body, 'username'),
        password: requiredString(body, 'password'),
        confirmPassword: requiredString(body, 'confirmPassword'),
        termsVersion: requiredString(body, 'termsVersion'),
        privacyVersion: requiredString(body, 'privacyVersion'),
        acceptTerms: optionalBoolean(body, 'acceptTerms', false),
      };
      const issued = await runtime.service.register(input, meta(request));
      sendIssued(response, runtime, issued, 201);
    }),
  );

  router.post(
    '/login',
    origin,
    asyncRoute(async (request, response) => {
      if (!(await requireExistingSessionCsrf(request, response, runtime.sessions))) return;
      const body = parseBody(request.body, ['identifier', 'password', 'remember']);
      const issued = await runtime.service.login(loginInput(body), meta(request));
      sendIssued(response, runtime, issued, 200);
    }),
  );

  router.post(
    '/challenges',
    origin,
    asyncRoute(async (request, response) => {
      if (!(await requireExistingSessionCsrf(request, response, runtime.sessions))) return;
      const body = parseBody(request.body, ['identifier', 'purpose']);
      const purpose = requiredString(body, 'purpose') as VerificationPurpose;
      if (purpose !== 'code_login' && purpose !== 'reset_password') {
        throw new AuthInputError('INVALID_REQUEST', 'Request fields are invalid');
      }
      const target = normalizeContact(requiredString(body, 'identifier'));
      const challengeId = await runtime.service.requestChallenge(target, purpose, meta(request));
      response.status(202).type('application/json').send({ data: { challengeId } });
    }),
  );

  router.post(
    '/code-login',
    origin,
    asyncRoute(async (request, response) => {
      if (!(await requireExistingSessionCsrf(request, response, runtime.sessions))) return;
      const body = parseBody(request.body, [
        'challengeId',
        'identifier',
        'code',
        'termsVersion',
        'privacyVersion',
        'acceptTerms',
      ]);
      const input: CodeLoginInput = {
        challengeId: requiredString(body, 'challengeId'),
        target: normalizeContact(requiredString(body, 'identifier')),
        code: requiredString(body, 'code'),
        termsVersion: optionalString(body, 'termsVersion') ?? '',
        privacyVersion: optionalString(body, 'privacyVersion') ?? '',
        acceptTerms: optionalBoolean(body, 'acceptTerms', false),
      };
      const issued = await runtime.service.codeLogin(input, meta(request));
      sendIssued(response, runtime, issued, 200);
    }),
  );

  router.post(
    '/reset-password',
    origin,
    asyncRoute(async (request, response) => {
      if (!(await requireExistingSessionCsrf(request, response, runtime.sessions))) return;
      const body = parseBody(request.body, ['challengeId', 'identifier', 'code', 'password', 'confirmPassword']);
      const input: ResetPasswordInput = {
        challengeId: requiredString(body, 'challengeId'),
        target: normalizeContact(requiredString(body, 'identifier')),
        code: requiredString(body, 'code'),
        password: requiredString(body, 'password'),
        confirmPassword: requiredString(body, 'confirmPassword'),
      };
      if (input.password !== input.confirmPassword) throw new AuthInputError('PASSWORD_MISMATCH', 'Passwords do not match');
      await runtime.service.resetPassword(input, meta(request));
      runtime.sessions.clearSessionCookie(response);
      response.status(204).end();
    }),
  );

  router.post(
    '/logout',
    origin,
    asyncRoute(async (request, response) => {
      const session = await runtime.sessions.loadSessionFromRequest(request);
      if (!session) {
        runtime.sessions.clearSessionCookie(response);
        response.status(204).end();
        return;
      }
      if (!runtime.sessions.verifyCsrf(session, request.get('X-CSRF-Token'))) {
        sendError(response, 403, 'CSRF_INVALID', 'Invalid CSRF token');
        return;
      }
      await runtime.sessions.revokeSession(request.headers.cookie);
      runtime.sessions.clearSessionCookie(response);
      response.status(204).end();
    }),
  );

  return router;
}

function adminRouter(runtime: AuthRuntime, deps: AuthRouteDependencies): Router {
  const router = express.Router();
  router.use(noStore);
  router.post(
    '/login',
    requireAllowedOrigin(deps.allowOrigin),
    asyncRoute(async (request, response) => {
      if (!(await requireExistingSessionCsrf(request, response, runtime.sessions))) return;
      const body = parseBody(request.body, ['identifier', 'password', 'remember']);
      const issued = await runtime.service.login(loginInput(body), meta(request), { adminOnly: true });
      sendIssued(response, runtime, issued, 200);
    }),
  );
  return router;
}

/**
 * Mounts /auth and /admin below an API router. When an Express app is supplied,
 * the API prefix is mounted automatically so callers receive /api/auth and /api/admin.
 */
export function registerAuth(app: Express | Router, deps: AuthRouteDependencies): void {
  const runtime = buildRuntime(deps);
  const root = express.Router();
  root.use('/auth', authRouter(runtime, deps));
  root.use('/admin', adminRouter(runtime, deps));
  if (isExpressApp(app)) app.use('/api', root);
  else app.use(root);
}

