import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { healthRouter } from './routes/health.js';
import { productsRouter } from './routes/products.js';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true); // we sit behind CloudFront + ALB; makes req.ip the real client

if (config.corsOrigin) app.use(cors({ origin: config.corsOrigin }));

// Request logging: one line per request, with a request id to correlate with errors
app.use((req, res, next) => {
  const requestId = req.get('x-amzn-trace-id') ?? randomUUID();
  const started = process.hrtime.bigint();
  req.log = {
    info: (msg, meta) => logger.info(msg, { requestId, ...meta }),
    error: (msg, meta) => logger.error(msg, { requestId, ...meta }),
  };
  res.on('finish', () => {
    // Skip ALB health-check noise (every few seconds, from every AZ)
    if (req.path === '/health') return;
    logger.info('request', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Number(process.hrtime.bigint() - started) / 1e6,
      ip: req.ip,
    });
  });
  next();
});

app.use('/health', healthRouter);
app.use('/api/products', productsRouter);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler: log the details server-side, return a generic message to the client
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  req.log.error('unhandled_error', { err });
  res.status(500).json({ error: 'Internal server error' });
});
