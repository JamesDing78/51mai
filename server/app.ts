import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express, type Request, type Response, type Router } from 'express';
import type { TrustProxy } from './config.js';

export interface AppDependencies {
  apiRouter?: Router;
  authRouter?: Router;
  adminRouter?: Router;
  staticDir?: string;
  indexFile?: string;
  isProduction?: boolean;
  trustProxy?: TrustProxy;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function normalizedRequestPath(rawPath: string): string | undefined {
  let decoded = rawPath;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (/%(?:2f|5c)/i.test(decoded)) return undefined;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return undefined;
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (/%(?:2f|5c)/i.test(decoded) || decoded.includes('\u0000')) return undefined;
  const normalized = path.posix.normalize(decoded.replaceAll('\\', '/'));
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function sendError(response: Response, status: number, code: string, message: string): void {
  if (response.headersSent) return;
  response.status(status).type('application/json').send({ error: { code, message } });
}

function isApiPath(request: Request): boolean {
  const requestPath = normalizedRequestPath(request.path);
  return requestPath === '/api' || requestPath?.startsWith('/api/') === true;
}

function securityHeaders(isProduction: boolean) {
  return (request: Request, response: Response, next: () => void): void => {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (isProduction && request.secure) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

function rejectSensitiveSourcePaths(request: Request, response: Response, next: () => void): void {
  const requestPath = normalizedRequestPath(request.path)?.toLowerCase();
  if (!requestPath || requestPath.startsWith('/server/') || requestPath === '/server' || /(^|\/)\.env(?:$|[./])/.test(requestPath)) {
    response.status(404).type('text/plain').send('Not found');
    return;
  }
  next();
}

function requireJsonForApiBodies(request: Request, response: Response, next: () => void): void {
  const requestPath=normalizedRequestPath(request.path);
  if (requestPath==='/api/payments/callback/alipay') { next(); return; }
  if (isApiPath(request) && BODY_METHODS.has(request.method) && request.is('application/json') !== 'application/json') {
    sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
    return;
  }
  next();
}

const parseError: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error?.type === 'entity.too.large') {
    sendError(response, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    return;
  }
  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    sendError(response, 400, 'INVALID_JSON', 'Request body must be valid JSON');
    return;
  }
  next(error);
};

const apiNotFound = (request: Request, response: Response, next: () => void): void => {
  if (isApiPath(request)) {
    sendError(response, 404, 'NOT_FOUND', 'Not found');
    return;
  }
  next();
};

const notFound = (request: Request, response: Response): void => {
  if (isApiPath(request)) {
    sendError(response, 404, 'NOT_FOUND', 'Not found');
    return;
  }
  response.status(404).type('text/plain').send('Not found');
};

const internalError: ErrorRequestHandler = (_error, _request, response, _next) => {
  sendError(response, 500, 'INTERNAL_ERROR', 'Internal server error');
};

export function createApp(deps: AppDependencies = {}): Express {
  const app = express();
  const staticDir = path.resolve(deps.staticDir ?? path.resolve(process.cwd(), 'dist'));
  const indexFile = path.resolve(deps.indexFile ?? path.join(staticDir, 'index.html'));
  const isProduction = deps.isProduction ?? process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxy ?? false);
  app.use(securityHeaders(isProduction));
  app.use(rejectSensitiveSourcePaths);
  app.use('/api/payments/callback/alipay', express.urlencoded({ limit:'16kb', extended:false }));
  app.use(requireJsonForApiBodies);
  app.use(express.json({ limit: '16kb', strict: true, type: 'application/json', verify:(request,_response,buffer)=>{(request as Request & {rawBody?:Buffer}).rawBody=Buffer.from(buffer)} }));

  if (deps.apiRouter) app.use('/api', deps.apiRouter);
  if (deps.authRouter) app.use('/api/auth', deps.authRouter);
  if (deps.adminRouter) app.use('/api/admin', deps.adminRouter);

  app.use(parseError);
  app.use(apiNotFound);

  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, dotfiles: 'deny', fallthrough: true, redirect: false }));
  }

  app.get(/.*/, (request, response, next) => {
    if (isApiPath(request) || !existsSync(indexFile)) {
      next();
      return;
    }
    response.sendFile(indexFile, (error) => {
      if (error) next(error);
    });
  });

  app.use(notFound);
  app.use(internalError);
  return app;
}
