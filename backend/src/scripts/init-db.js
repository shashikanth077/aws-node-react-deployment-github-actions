// Creates the products table and inserts the 5 sample rows (only if the table is empty).
// Safe to run more than once. Run locally with `npm run db:init`, or in AWS as a one-off
// ECS task using the same image (see docs/03-rds-and-secrets.md).
import { readFileSync } from 'node:fs';
import { closePool, query } from '../db.js';
import { logger } from '../logger.js';

const sql = (file) => readFileSync(new URL(`../../db/${file}`, import.meta.url), 'utf8');

try {
  await query(sql('schema.sql'));
  const [[{ total }]] = await query('SELECT COUNT(*) AS total FROM products');
  if (total === 0) {
    await query(sql('seed.sql'));
    logger.info('db_seeded');
  } else {
    logger.info('db_already_seeded', { rows: total });
  }
  await closePool();
} catch (err) {
  logger.error('db_init_failed', { err });
  process.exit(1);
}
