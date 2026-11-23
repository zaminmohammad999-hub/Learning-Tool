import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.js';

let state = { db: null, mode: 'real', realPath: null, path: null };

export function nowIso() {
  return new Date().toISOString();
}

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, nowIso());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Open the primary (real) database. */
export function initDb(dbPath) {
  if (state.db) state.db.close();
  state = { db: open(dbPath), mode: 'real', realPath: dbPath, path: dbPath };
  return state.db;
}

export function getDb() {
  if (!state.db) throw new Error('Database not initialised');
  return state.db;
}

export function getMode() {
  return state.mode;
}

export function demoPathFor(realPath) {
  if (realPath === ':memory:') return ':memory:';
  return path.join(path.dirname(realPath), 'demo.sqlite');
}

/** Switch between the real DB and a fully separate demo DB file. Returns true if the demo DB is new. */
export function switchMode(mode) {
  if (mode === state.mode) return false;
  const target = mode === 'demo' ? demoPathFor(state.realPath) : state.realPath;
  const isNew = target === ':memory:' || !fs.existsSync(target);
  state.db.close();
  state.db = open(target);
  state.mode = mode;
  state.path = target;
  return isNew;
}

export function closeDb() {
  if (state.db) state.db.close();
  state = { db: null, mode: 'real', realPath: null, path: null };
}

/** Run fn inside a transaction (nested calls reuse the outer transaction). */
export function tx(fn) {
  const db = getDb();
  if (db.isTransaction) return fn(db);
  db.exec('BEGIN');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
