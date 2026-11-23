import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests never use a real key or the real database.
// Set (not delete) so dotenv can never load the real values from .env during tests.
process.env.ANTHROPIC_API_KEY = '';
process.env.CALENDAR_ICS_URL = '';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
process.env.BACKUP_DIR = path.join(tmpRoot, 'backups');

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = fs.readFileSync(path.join(here, '..', '..', 'data', 'fixtures', 'SYNTHETIC_lesson06_transcript.txt'), 'utf8');

export function tempDbPath(name = 'test') {
  return path.join(tmpRoot, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

export async function makeApp(dbPath = tempDbPath()) {
  const { createApp } = await import('../src/app.js');
  return { app: createApp({ dbPath, serveClient: false }), dbPath };
}

export async function importFixture(request, app, overrides = {}) {
  const res = await request(app)
    .post('/api/transcripts')
    .send({ text: FIXTURE, filename: 'SYNTHETIC_lesson06_transcript.txt', session: { session_date: '2026-11-20', tutor: 'Tutor', lesson_ids: ['L06'], duration_minutes: 60 }, ...overrides });
  return res;
}

export const passAll = (exerciseIds, overrides = {}) =>
  exerciseIds.map((id) => ({ criterion_id: `RC-${id}`, result: 'pass', independence: 'independent', evidence_type: 'observed_live', evidence_text: 'Observed live', ...overrides }));
