const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  region: process.env.AWS_REGION ?? 'eu-central-1',
  imageBaseUrl: (process.env.IMAGE_BASE_URL ?? '').replace(/\/$/, ''),
  corsOrigin: process.env.CORS_ORIGIN || null,
  db: {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 3306),
    name: required('DB_NAME'),
    // Either a Secrets Manager secret (AWS) or a plain user/password (local only)
    secretArn: process.env.DB_SECRET_ARN || null,
    user: process.env.DB_USER || null,
    password: process.env.DB_PASSWORD || null,
    ssl: process.env.DB_SSL === 'true',
    sslCaPath: process.env.DB_SSL_CA ?? '/app/certs/rds-global-bundle.pem',
    poolSize: Number(process.env.DB_POOL_SIZE ?? 10),
  },
};

if (!config.db.secretArn && !(config.db.user && config.db.password)) {
  throw new Error('Set DB_SECRET_ARN, or DB_USER and DB_PASSWORD');
}
