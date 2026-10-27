import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import type { DatabaseConfig } from '../config.js';

export async function configureConnection(connection: PoolConnection): Promise<void> {
  await connection.query("SET time_zone = '+00:00'");
}

export function createPool(config: DatabaseConfig): Pool {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: 0,
    connectTimeout: config.connectTimeout,
    enableKeepAlive: true,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
  });
  pool.on('connection', (connection) => {
    // mysql2 queues this command before pool.query/execute can use the new connection.
    const coreConnection = connection as unknown as {
      query: (sql: string, callback: (error: Error | null) => void) => void;
    };
    coreConnection.query("SET time_zone = '+00:00'", () => undefined);
  });
  const getConnection = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const connection = await getConnection();
    await configureConnection(connection);
    return connection;
  };
  return pool;
}
