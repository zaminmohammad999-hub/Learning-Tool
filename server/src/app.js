import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { initDb } from './db/connection.js';
import { seedDatabase } from './db/seed.js';
import { api } from './routes/api.js';
import { config, CLIENT_DIST } from './config.js';
import { HttpError } from './services/common.js';

/** Build the Express app against a database file. Seeding is idempotent and never resets progress. */
export function createApp({ dbPath = config.dbPath, serveClient = true } = {}) {
  initDb(dbPath);
  seedDatabase();

  const app = express();
  app.disable('x-powered-by');
  // Transcripts can be long; the service layer enforces the precise byte limit.
  app.use(express.json({ limit: `${Math.ceil(config.maxTranscriptBytes / 1_000_000) * 3 + 2}mb` }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  if (serveClient && fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    app.use(express.static(CLIENT_DIST));
    app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    const status = err instanceof HttpError ? err.status : err.status && err.status < 600 ? err.status : 500;
    if (status >= 500 && !(err instanceof HttpError)) console.error('[server error]', err.message);
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Internal server error' : err.message, details: err.details });
  });
  return app;
}
