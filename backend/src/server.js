import { app } from './app.js';
import { config } from './config.js';
import { closePool } from './db.js';
import { logger } from './logger.js';

const server = app.listen(config.port, () => {
  logger.info('server_started', { port: config.port, env: config.nodeEnv });
});

// ECS sends SIGTERM on every deployment/scale-in, then SIGKILL after stopTimeout (30s).
// Stop accepting new connections, let in-flight requests finish, then close the DB pool.
function shutdown(signal) {
  logger.info('shutdown_started', { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    await closePool().catch(() => {});
    logger.info('shutdown_complete');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => logger.error('unhandled_rejection', { err }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { err });
  process.exit(1);
});
