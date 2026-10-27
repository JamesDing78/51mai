import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { hashPassword } from '../auth/password.js';
import { normalizeUsername } from '../auth/service.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { randomUUID } from 'node:crypto';

function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return Promise.reject(new Error('ADMIN_PASSWORD must be set in a local interactive command'));
  }
  process.stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const stdin = process.stdin;
    const cleanup = (): void => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk: string | Buffer): void => {
      const text = String(chunk);
      for (const character of text) {
        if (character === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Input cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += character;
      }
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readUsername(): Promise<string> {
  if (process.env.ADMIN_USERNAME?.trim()) return normalizeUsername(process.env.ADMIN_USERNAME);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('ADMIN_USERNAME must be set in a local interactive command');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return normalizeUsername(await new Promise<string>((resolve) => readline.question('Admin username: ', resolve)));
  } finally {
    readline.close();
  }
}

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD !== undefined) return process.env.ADMIN_PASSWORD;
  return readSecret('Admin password: ');
}

async function createAdmin(pool: Pool, username: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1 FOR UPDATE",
    );
    if (existing[0]) throw new Error('An administrator already exists');
    const userId = randomUUID();
    await connection.execute(
      `INSERT INTO users (id, username_normalized, password_hash, account_status, role)
       VALUES (?, ?, ?, 'active', 'admin')`,
      [userId, username, passwordHash],
    );
    await connection.execute(
      `INSERT INTO audit_logs (id, actor_user_id, target_user_id, event_type, metadata_json)
       VALUES (?, ?, ?, 'admin.created', JSON_OBJECT('source', 'create-admin'))`,
      [randomUUID(), userId, userId],
    );
    await connection.commit();
    committed = true;
  } finally {
    if (!committed) await connection.rollback().catch(() => undefined);
    connection.release();
  }
}

async function run(): Promise<void> {
  const config = loadConfig();
  if (config.nodeEnv === 'production' && process.env.CREATE_ADMIN_CONFIRM !== '51mai-local-admin') {
    throw new Error('create-admin is disabled in production without explicit confirmation');
  }
  const username = await readUsername();
  const password = await readPassword();
  const pool = createPool(config.database);
  try {
    await createAdmin(pool, username, password);
  } finally {
    await pool.end();
  }
  console.log(`Administrator created: ${username}`);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
