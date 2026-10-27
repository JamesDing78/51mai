import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Pool } from 'mysql2/promise';
import express from 'express';
import { createApp } from './app.js';
import { registerAuth } from './auth/routes.js';
import { loadConfig, type AppConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { registerBusiness } from './business/routes.js';
import { BusinessService } from './business/service.js';
import { startOrderExpirySweep } from './business/order-expiry-sweep.js';

export interface ServerDependencies {
  createPool?: (config: AppConfig['database']) => Pool;
  createApp?: typeof createApp;
}

async function closeHttpServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export async function startServer(
  config: AppConfig = loadConfig(),
  dependencies: ServerDependencies = {},
): Promise<{ server: Server; close: () => Promise<void> }> {
  const pool = (dependencies.createPool ?? createPool)(config.database);
  let server: Server | undefined;
  let closed = false;

  try {
    await pool.query('SELECT 1');
    if (!config.authHmacKey) throw new Error('AUTH_HMAC_KEY is required to start authentication');
    const apiRouter = express.Router();
    registerAuth(apiRouter, {
      pool,
      allowOrigin: config.allowOrigin,
      authHmacKey: config.authHmacKey,
      cookieName: config.cookieName,
      secureCookie: config.isProduction,
      sessionTtlSeconds: config.sessionTtlSeconds,
      rememberSessionTtlSeconds: config.rememberSessionTtlSeconds,
    });
    registerBusiness(apiRouter, {
      pool,
      allowOrigin: config.allowOrigin,
      authHmacKey: config.authHmacKey,
      cookieName: config.cookieName,
      secureCookie: config.isProduction,
      sessionTtlSeconds: config.sessionTtlSeconds,
      rememberSessionTtlSeconds: config.rememberSessionTtlSeconds,
      paymentRuntime: config.paymentRuntime,
      fulfillmentEncryptionKey: config.fulfillmentEncryptionKey,
    });
    const stopExpirySweep=startOrderExpirySweep(()=>new BusinessService(pool).closeExpiredOrders(),config.orderExpirySweepSeconds*1000);
    const app = (dependencies.createApp ?? createApp)({
      apiRouter,
      staticDir: config.staticDir,
      indexFile: config.indexFile,
      isProduction: config.isProduction,
      trustProxy: config.trustProxy,
    });
    server = app.listen(config.port, config.host);

    await new Promise<void>((resolve, reject) => {
      server?.once('listening', () => resolve());
      server?.once('error', reject);
    });

    // Hostinger requires listen() within three seconds. The new website has no
    // external traffic before DNS is attached, so bind first, then run the
    // advisory-lock-protected migrations before reporting startup complete.
    if (config.isProduction) await migrate(pool);

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      stopExpirySweep();
      await closeHttpServer(server);
      await pool.end();
    };

    return { server, close };
  } catch (error) {
    await closeHttpServer(server).catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export async function run(): Promise<void> {
  const config = loadConfig();
  const { close } = await startServer(config);
  const shutdown = (): void => {
    void close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log(`51mai server listening on ${config.host}:${config.port}`);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
