import fs from 'node:fs';
import path from 'node:path';
import { getDb, nowIso, tx, getMode, switchMode } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { config, DATA_DIR } from '../config.js';
import { HttpError, audit, getSettings } from './common.js';

const db = () => getDb();
// Internal format id kept from the original name so existing backups still restore.
export const BACKUP_FORMAT = 'vibe-coding-command-centre-backup';
export const BACKUP_VERSION = 1;

// User-owned tables in FK-safe insert order. Canonical curriculum is NOT exported (it comes from the seed file).
const USER_TABLES = [
  ['settings', null],
  ['lesson_progress', null],
  ['practical_exercises', 'is_canonical = 0'],
  ['exercise_progress', null],
  ['assessment_criteria', null],
  ['tutoring_sessions', null],
  ['session_lessons', null],
  ['transcripts', null],
  ['transcript_segments', null],
  ['calendar_events', null],
  ['watched_files', null],
  ['auto_applied', null],
  ['lesson_reviews', null],
  ['lesson_insights', null],
  ['api_usage', null],
  ['transcript_analyses', null],
  ['evidence_matches', null],
  ['approval_decisions', null],
  ['exercise_evidence', null],
  ['assessment_attempts', null],
  ['criterion_results', null],
  ['competency_verifications', null],
  ['tutor_feedback', null],
  ['homework', null],
  ['chat_messages', null],
  ['audit_log', null],
];

// ───────────── Settings ─────────────

const SETTING_RULES = {
  learner_name: (v) => typeof v === 'string' && v.length <= 80,
  tutor_name: (v) => typeof v === 'string' && v.length <= 80,
  programme_start_date: (v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v),
  ai_enabled: (v) => v === 'true' || v === 'false',
  ai_model: (v) => v === '' || /^claude-[a-z0-9-]{2,60}$/.test(v),
  ai_effort: (v) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(v),
  ai_max_chunk_chars: (v) => /^\d+$/.test(v) && Number(v) >= 2000 && Number(v) <= 200000,
  ai_max_chunks: (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 200,
  transcript_retention_days: (v) => /^\d+$/.test(v) && Number(v) <= 3650,
  // Automation (folder watching, calendar, translation, reminders)
  watch_enabled: (v) => v === 'true' || v === 'false',
  watch_folder: (v) => v === '' || (typeof v === 'string' && v.length <= 400 && path.isAbsolute(v) && !v.includes('\u0000')),
  calendar_keyword: (v) => typeof v === 'string' && v.trim().length >= 3 && v.length <= 80,
  auto_translate: (v) => v === 'true' || v === 'false',
  auto_claude_analysis: (v) => v === 'true' || v === 'false',
  auto_max_usd: (v) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) <= 20,
  reminders_enabled: (v) => v === 'true' || v === 'false',
  auto_apply: (v) => v === 'true' || v === 'false',
  translation_model: (v) => v === '' || /^claude-[a-z0-9-]{2,60}$/.test(v),
  // Prepaid Claude API credit bought in total (USD), and the level at which to warn.
  api_credit_usd: (v) => v === '' || (/^\d+(\.\d{1,2})?$/.test(v) && Number(v) <= 10000),
  api_credit_warn_usd: (v) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) <= 1000,
};

export function updateSettings(patch, actor) {
  const before = getSettings();
  const changes = {};
  for (const [k, raw] of Object.entries(patch)) {
    if (!(k in SETTING_RULES)) throw new HttpError(400, `Unknown setting ${k}`);
    const v = typeof raw === 'boolean' || typeof raw === 'number' ? String(raw) : raw;
    if (!SETTING_RULES[k](v)) throw new HttpError(400, `Invalid value for ${k}`);
    changes[k] = v;
  }
  if (changes.watch_folder) changes.watch_folder = path.normalize(changes.watch_folder);
  // Turning watching on (or pointing it at a new folder) starts the clock: files already there are left alone.
  const turningOn = changes.watch_enabled === 'true' && before.watch_enabled !== 'true';
  const newFolder = changes.watch_folder !== undefined && changes.watch_folder !== before.watch_folder;
  if (turningOn || newFolder) changes.watch_since = nowIso();
  tx((d) => {
    const st = d.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(changes)) st.run(k, v);
  });
  audit('settings', null, 'update', Object.fromEntries(Object.keys(changes).map((k) => [k, before[k]])), changes, actor);
  return getSettings();
}

// ───────────── Export / import ─────────────

export function exportData() {
  const programme = db().prepare('SELECT source_checksum FROM programme WHERE id = 1').get();
  const tables = {};
  for (const [t, where] of USER_TABLES) tables[t] = db().prepare(`SELECT * FROM ${t}${where ? ` WHERE ${where}` : ''}`).all();
  tables.domain_assessment_dates = db().prepare('SELECT id, scheduled_date FROM domain_assessments WHERE scheduled_date IS NOT NULL').all();
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: nowIso(),
    curriculum_checksum: programme?.source_checksum || null,
    privacy_warning: 'This backup contains private tutoring transcripts, feedback and assessment evidence. Store it securely.',
    tables,
  };
}

function columnsOf(table) {
  return new Set(db().prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

export function importData(payload, actor) {
  if (!payload || payload.format !== BACKUP_FORMAT) throw new HttpError(400, 'Not a Learning Studio backup file');
  if (payload.version !== BACKUP_VERSION) throw new HttpError(400, `Unsupported backup version ${payload.version}`);
  if (!payload.tables || typeof payload.tables !== 'object') throw new HttpError(400, 'Backup has no tables');
  const warnings = [];
  const current = db().prepare('SELECT source_checksum FROM programme WHERE id = 1').get()?.source_checksum;
  if (payload.curriculum_checksum && current && payload.curriculum_checksum !== current)
    warnings.push('Backup was made with a different curriculum file version; rows referencing unknown curriculum ids will fail.');

  const counts = {};
  tx((d) => {
    d.exec('PRAGMA defer_foreign_keys = ON');
    for (const [t, where] of [...USER_TABLES].reverse()) {
      if (t === 'transcript_segments') d.prepare('DELETE FROM transcript_segments').run();
      else d.prepare(`DELETE FROM ${t}${where ? ` WHERE ${where}` : ''}`).run();
    }
    for (const [t] of USER_TABLES) {
      const rows = payload.tables[t] || [];
      if (!Array.isArray(rows)) throw new HttpError(400, `Table ${t} must be an array`);
      const allowed = columnsOf(t);
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => allowed.has(c));
        if (!cols.length) continue;
        d.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
      }
      counts[t] = rows.length;
    }
    d.prepare('UPDATE domain_assessments SET scheduled_date = NULL').run();
    for (const r of payload.tables.domain_assessment_dates || []) d.prepare('UPDATE domain_assessments SET scheduled_date = ? WHERE id = ?').run(r.scheduled_date, r.id);
  });
  // Re-run the idempotent seed so any curriculum rows missing from the backup get their default learner rows.
  seedDatabase();
  audit('data', null, 'import', undefined, { counts, warnings }, actor);
  return { imported: counts, warnings };
}

// ───────────── File backups ─────────────

export function writeBackupFile() {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const name = `backup-${getMode()}-${nowIso().replace(/[:.]/g, '-')}.json`;
  const file = path.join(config.backupDir, name);
  fs.writeFileSync(file, JSON.stringify(exportData(), null, 2));
  audit('data', null, 'backup_file', undefined, { name });
  return { name, path: file, bytes: fs.statSync(file).size };
}

export function listBackupFiles() {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs
    .readdirSync(config.backupDir)
    .filter((n) => /^backup-[\w-]+\.json$/.test(n))
    .map((n) => ({ name: n, bytes: fs.statSync(path.join(config.backupDir, n)).size, modified: fs.statSync(path.join(config.backupDir, n)).mtime.toISOString() }))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export function restoreBackupFile(name, actor) {
  if (!/^backup-[\w-]+\.json$/.test(name)) throw new HttpError(400, 'Invalid backup name');
  const file = path.join(config.backupDir, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Backup not found');
  return importData(JSON.parse(fs.readFileSync(file, 'utf8')), actor);
}

// ───────────── Privacy & retention ─────────────

export function applyRetention(actor) {
  const days = Number(getSettings().transcript_retention_days || 0);
  if (!days) return { deleted: 0, message: 'Retention is set to keep transcripts indefinitely.' };
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return deleteTranscriptsWhere('created_at < ?', [cutoff], actor, `retention ${days} days`);
}

export function deleteAllTranscripts(actor) {
  return deleteTranscriptsWhere('1 = 1', [], actor, 'delete all transcripts');
}

function deleteTranscriptsWhere(where, args, actor, reason) {
  const ids = db().prepare(`SELECT id FROM transcripts WHERE ${where}`).all(...args).map((r) => r.id);
  tx((d) => {
    for (const id of ids) {
      d.prepare('DELETE FROM transcript_segments WHERE transcript_id = ?').run(id);
      d.prepare('DELETE FROM transcripts WHERE id = ?').run(id);
    }
  });
  if (ids.length) audit('transcript', null, 'bulk_delete', undefined, { ids, reason }, actor);
  return { deleted: ids.length, note: 'Approved evidence snippets from these transcripts were removed; exercise statuses are kept (see audit log).' };
}

// ───────────── Demo mode (fully separate database file) ─────────────

export async function setDemoMode(enabled) {
  const isNew = switchMode(enabled ? 'demo' : 'real');
  seedDatabase();
  if (enabled && isNew) await seedDemoData();
  return { mode: getMode() };
}

export async function seedDemoData() {
  const { createSession, addTranscript } = await import('./transcripts.js');
  const { runAnalysis, decideMatch } = await import('./analysis.js');
  const { updateLessonProgress } = await import('./progress.js');
  const { createFeedback } = await import('./feedback.js');
  const { recordAttempt, verifyCompetency } = await import('./assessments.js');
  const actor = 'demo-seed';
  const start = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  updateSettings({ learner_name: 'Demo Learner', tutor_name: 'Demo Tutor', programme_start_date: start }, actor);
  ['L01', 'L02', 'L03', 'L04', 'L05'].forEach((id) => updateLessonProgress(id, { status: 'held' }, actor));
  const text = fs.readFileSync(path.join(DATA_DIR, 'fixtures', 'SYNTHETIC_lesson06_transcript.txt'), 'utf8');
  updateLessonProgress('L06', { status: 'held' }, actor);
  const s = createSession({ session_date: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), duration_minutes: 60, tutor: 'Demo Tutor', title: 'DEMO — Remote repository operations', lesson_ids: ['L06'] }, actor);
  const t = addTranscript({ session_id: s.id, text, filename: 'SYNTHETIC_lesson06_transcript.txt' }, actor);
  const a = await runAnalysis(t.id, 'rule_based', actor);
  a.matches.filter((m) => ['D2-C2-E1', 'D2-C2-E2', 'D2-C2-E3'].includes(m.exercise_id) && m.category !== 'uncertain').forEach((m) => decideMatch(m.id, { decision: 'approve', reviewer: actor }));
  createFeedback(
    {
      session_id: s.id,
      lesson_id: 'L06',
      feedback_date: s.session_date,
      author: 'Demo Tutor',
      strengths: 'Cloned and pushed confidently.',
      weaknesses: 'Unsure about the difference between fetch and pull.',
      misunderstandings: 'Thought git fetch changes local files.',
      next_priorities: 'Demonstrate git fetch vs git pull; inspect git remote -v.',
      confidence: 3,
      exercise_ids: ['D2-C2-E3'],
      homework_items: [{ description: 'Practise git fetch then git status on the demo repo', due_date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), exercise_ids: ['D2-C2-E3'] }],
    },
    actor
  );
  const ev = (id) => ({ criterion_id: `RC-${id}`, result: 'pass', independence: 'independent', evidence_type: 'observed_live', evidence_text: 'DEMO: observed live in session' });
  const att = recordAttempt({ rubric_id: 'RUB-D1-C1', assessor: 'Demo Tutor', attempt_date: start, results: ['D1-C1-E1', 'D1-C1-E2', 'D1-C1-E3', 'D1-C1-E4'].map(ev) }, actor);
  verifyCompetency({ competency_id: 'D1-C1', attempt_id: att.id, verifier: 'Demo Tutor', verifier_role: 'tutor', evidence_summary: 'DEMO verification' });
  recordAttempt(
    {
      rubric_id: 'RUB-D1-C2',
      assessor: 'Demo Tutor',
      attempt_date: start,
      results: [ev('D1-C2-E1'), ev('D1-C2-E2'), { ...ev('D1-C2-E3'), independence: 'assisted' }, { ...ev('D1-C2-E4'), result: 'not_observed' }],
      retry_plan: 'DEMO: retry environment variables next week',
    },
    actor
  );
}
