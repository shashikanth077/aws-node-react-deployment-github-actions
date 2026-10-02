import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { config } from './config.js';
import { logger } from './logger.js';

let poolPromise = null;

// In AWS the SDK finds credentials by itself: on Fargate it calls the ECS task-role
// endpoint, so there are no access keys anywhere in our code or config.
async function loadCredentials() {
  if (!config.db.secretArn) {
    return { user: config.db.user, password: config.db.password };
  }
  const client = new SecretsManagerClient({ region: config.region });
  const res = await client.send(new GetSecretValueCommand({ SecretId: config.db.secretArn }));
  const secret = JSON.parse(res.SecretString);
  logger.info('db_credentials_loaded', { source: 'secrets-manager' });
  return { user: secret.username, password: secret.password };
}

async function createPool() {
  const { user, password } = await loadCredentials();
  return mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user,
    password,
    waitForConnections: true,
    connectionLimit: config.db.poolSize,
    queueLimit: 0,
    connectTimeout: 5000,
    enableKeepAlive: true,
    decimalNumbers: true,
    ssl: config.db.ssl
      ? { ca: readFileSync(config.db.sslCaPath), rejectUnauthorized: true }
      : undefined,
  });
}

function getPool() {
  if (!poolPromise) {
    poolPromise = createPool().catch((err) => {
      poolPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return poolPromise;
}

// If the secret was rotated, the old password stops working for NEW connections.
// Re-read the secret once, rebuild the pool and retry.
async function resetPool() {
  const old = poolPromise;
  poolPromise = null;
  if (old) old.then((p) => p.end()).catch(() => {});
}

export async function query(sql, params) {
  try {
    return await (await getPool()).query(sql, params);
  } catch (err) {
    if (err.code === 'ER_ACCESS_DENIED_ERROR' && config.db.secretArn) {
      logger.warn('db_access_denied_refreshing_credentials');
      await resetPool();
      return (await getPool()).query(sql, params);
    }
    throw err;
  }
}

export async function closePool() {
  if (poolPromise) await (await poolPromise).end();
}
