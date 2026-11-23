import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const CURRICULUM_PATH = path.join(DATA_DIR, 'vibe_coding_curriculum.json');
export const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');

// Load the root .env (never committed). Values already in the environment win.
dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

function resolveFromRoot(p, fallback) {
  if (!p) return fallback;
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

export const config = {
  port: Number(process.env.PORT || 4000),
  // Localhost-only by default. Changing HOST exposes private transcripts on your network.
  host: process.env.HOST || '127.0.0.1',
  dbPath: resolveFromRoot(process.env.DB_PATH, path.join(DATA_DIR, 'db', 'learning.sqlite')),
  backupDir: resolveFromRoot(process.env.BACKUP_DIR, path.join(DATA_DIR, 'backups')),
  maxTranscriptBytes: Number(process.env.MAX_TRANSCRIPT_BYTES || 2_000_000),
  // Read at call time so tests / settings changes are honoured; never sent to the client.
  get anthropicKeyPresent() {
    return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
  },
  defaultModel: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
};
