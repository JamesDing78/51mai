import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SessionManager, type SessionContext, type AuthUser } from './sessions.js';

export interface AuthRequestSession {
  tokenHash: Buffer;
  csrfTokenHash: Buffer;
  expiresAt: string;
}

export interface AuthRequestContext {
  user: AuthUser;
  session: AuthRequestSession;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthRequestContext;
    }
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sendError(response: Response, status: number, code: string, message: string): void {
  if (response.headersSent) return;
  response.status(status).type('application/json').send({ error: { code, message } });
}

function isUnsafe(request: Request): boolean {
  return UNSAFE_METHODS.has(request.method.toUpperCase());
}

function authContext(session: SessionContext): AuthRequestContext {
  return {
    user: session.user,
    session: {
      tokenHash: session.tokenHash,
      csrfTokenHash: session.csrfTokenHash,
      expiresAt: session.expiresAt,
    },
  };
}

async function authenticate(
  request: Request,
  response: Response,
  manager: SessionManager,
  requireCsrf: boolean,
): Promise<SessionContext | undefined> {
  if (request.method.toUpperCase() === 'GET') setNoStore(response);
  const session = await manager.loadSessionFromRequest(request);
  if (!session) {
    manager.clearSessionCookie(response);
    sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required');
    return undefined;
  }
  if (requireCsrf && isUnsafe(request) && !manager.verifyCsrf(session, request.get('X-CSRF-Token'))) {
    sendError(response, 403, 'CSRF_INVALID', 'Invalid CSRF token');
    return undefined;
  }
  request.auth = authContext(session);
  return session;
}

export interface SessionGuardOptions {
  requireCsrf?: boolean;
}

export function requireSession(manager: SessionManager, options: SessionGuardOptions = {}): RequestHandler {
  const requireCsrf = options.requireCsrf ?? true;
  return (request: Request, response: Response, next: NextFunction): void => {
    void authenticate(request, response, manager, requireCsrf)
      .then((session) => {
        if (session) next();
      })
      .catch(next);
  };
}

export function requireAdmin(manager: SessionManager, options: SessionGuardOptions = {}): RequestHandler {
  const requireCsrf = options.requireCsrf ?? true;
  return (request: Request, response: Response, next: NextFunction): void => {
    void authenticate(request, response, manager, requireCsrf)
      .then((session) => {
        if (!session) return;
        if (session.user.role !== 'admin') {
          sendError(response, 403, 'FORBIDDEN', 'Administrator access required');
          return;
        }
        next();
      })
      .catch(next);
  };
}

export function requireAllowedOrigin(allowOrigin: string): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.get('Origin') !== allowOrigin) {
      sendError(response, 403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed');
      return;
    }
    next();
  };
}

function setNoStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

export function noStore(_request: Request, response: Response, next: NextFunction): void {
  setNoStore(response);
  next();
}

export function requestSourceIp(request: Request): string {
  // Express calculates req.ip using its explicit trust-proxy setting. The app defaults
  // that setting to false, so an untrusted X-Forwarded-For header cannot replace this value.
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}
