import { getDb, nowIso } from '../db/connection.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what) => new HttpError(404, `${what} not found`);

export function audit(entityType, entityId, action, before, after, actor = 'user') {
  getDb()
    .prepare(
      'INSERT INTO audit_log (entity_type, entity_id, action, before_json, after_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      entityType,
      entityId == null ? null : String(entityId),
      action,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      actor || 'user',
      nowIso()
    );
}

export function listAudit({ entityType, entityId, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (entityType) (where.push('entity_type = ?'), args.push(entityType));
  if (entityId) (where.push('entity_id = ?'), args.push(String(entityId)));
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return getDb()
    .prepare(sql)
    .all(...args, Math.min(Number(limit) || 200, 1000))
    .map((r) => ({ ...r, before: parseJson(r.before_json), after: parseJson(r.after_json) }));
}

export function parseJson(s, fallback = null) {
  if (s == null) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function getSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getSetting(key, fallback = null) {
  const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

export const EXERCISE_STATUSES = ['not_started', 'discussed', 'demonstrated', 'independently_completed', 'needs_practice'];
export const COVERED_STATUSES = ['discussed', 'demonstrated', 'independently_completed'];
export const STATUS_RANK = { not_started: 0, discussed: 1, demonstrated: 2, independently_completed: 3 };
export const MATCH_CATEGORIES = ['discussed', 'demonstrated', 'independently_completed', 'uncertain'];

/** Single source of truth for whether an exercise counts as "covered". */
export function isCovered(status, coverageConfirmed) {
  if (COVERED_STATUSES.includes(status)) return true;
  // Needs-practice counts as covered only when evidence confirms the topic was actually taught.
  return status === 'needs_practice' && Boolean(coverageConfirmed);
}
