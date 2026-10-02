import { Router } from 'express';
import { query } from '../db.js';

export const healthRouter = Router();

// Liveness: "is the Node process up?" -> used by the ALB target group.
// It deliberately does NOT touch the database: a DB hiccup must not make the ALB
// kill every healthy container at once.
healthRouter.get('/', (req, res) => res.json({ status: 'ok' }));

// Readiness: "can I reach the database?" -> for humans and debugging.
healthRouter.get('/ready', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ready', db: 'up' });
  } catch (err) {
    req.log?.error('readiness_check_failed', { err });
    res.status(503).json({ status: 'not-ready', db: 'down' });
  }
});
