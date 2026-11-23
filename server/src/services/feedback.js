import { getDb, nowIso, tx } from '../db/connection.js';
import { HttpError, notFound, audit, parseJson, listAudit } from './common.js';

const db = () => getDb();
const FIELDS = ['session_id', 'lesson_id', 'feedback_date', 'author', 'strengths', 'weaknesses', 'misunderstandings', 'corrections', 'confidence', 'practiced', 'homework', 'next_priorities'];

function shape(f) {
  return f ? { ...f, exercise_ids: parseJson(f.exercise_ids_json, []) } : f;
}

function checkRefs(input) {
  if (input.lesson_id && !db().prepare('SELECT 1 FROM lessons WHERE id = ?').get(input.lesson_id)) throw new HttpError(400, `Unknown lesson ${input.lesson_id}`);
  if (input.session_id && !db().prepare('SELECT 1 FROM tutoring_sessions WHERE id = ?').get(input.session_id)) throw new HttpError(400, `Unknown session ${input.session_id}`);
  for (const id of input.exercise_ids || []) if (!db().prepare('SELECT 1 FROM practical_exercises WHERE id = ?').get(id)) throw new HttpError(400, `Unknown exercise ${id}`);
}

export function listFeedback() {
  return db()
    .prepare(
      `SELECT f.*, l.number AS lesson_number, l.title AS lesson_title, s.session_date FROM tutor_feedback f
       LEFT JOIN lessons l ON l.id = f.lesson_id LEFT JOIN tutoring_sessions s ON s.id = f.session_id ORDER BY f.feedback_date DESC, f.id DESC`
    )
    .all()
    .map(shape);
}

export function getFeedback(id) {
  const f = db().prepare('SELECT * FROM tutor_feedback WHERE id = ?').get(id);
  if (!f) throw notFound(`Feedback ${id}`);
  return { ...shape(f), history: listAudit({ entityType: 'tutor_feedback', entityId: id }) };
}

export function createFeedback(input, actor) {
  checkRefs(input);
  return tx((d) => {
    const now = nowIso();
    const info = d
      .prepare(
        `INSERT INTO tutor_feedback (${FIELDS.join(', ')}, exercise_ids_json, created_at, updated_at) VALUES (${FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`
      )
      .run(...FIELDS.map((f) => input[f] ?? null), JSON.stringify(input.exercise_ids || []), now, now);
    const id = Number(info.lastInsertRowid);
    for (const h of input.homework_items || []) {
      createHomework({ ...h, lesson_id: h.lesson_id || input.lesson_id, session_id: input.session_id, feedback_id: id }, actor);
    }
    audit('tutor_feedback', id, 'create', undefined, input, actor);
    return getFeedback(id);
  });
}

export function updateFeedback(id, patch, actor) {
  const before = getFeedback(id);
  checkRefs(patch);
  const next = {};
  FIELDS.forEach((f) => (next[f] = patch[f] === undefined ? before[f] : patch[f]));
  const exIds = patch.exercise_ids === undefined ? before.exercise_ids : patch.exercise_ids;
  db()
    .prepare(`UPDATE tutor_feedback SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, exercise_ids_json = ?, updated_at = ? WHERE id = ?`)
    .run(...FIELDS.map((f) => next[f]), JSON.stringify(exIds), nowIso(), id);
  const { history, ...beforeCore } = before;
  audit('tutor_feedback', id, 'update', beforeCore, { ...next, exercise_ids: exIds }, actor);
  return getFeedback(id);
}

export function deleteFeedback(id, actor) {
  const before = getFeedback(id);
  db().prepare('DELETE FROM tutor_feedback WHERE id = ?').run(id);
  const { history, ...core } = before;
  audit('tutor_feedback', id, 'delete', core, undefined, actor);
}

// ───────────── Homework ─────────────

export function listHomework() {
  return db()
    .prepare(`SELECT h.*, l.number AS lesson_number, l.title AS lesson_title FROM homework h LEFT JOIN lessons l ON l.id = h.lesson_id ORDER BY h.status, COALESCE(h.due_date, '9999'), h.id DESC`)
    .all()
    .map((h) => ({ ...h, exercise_ids: parseJson(h.exercise_ids_json, []) }));
}

export function createHomework(input, actor) {
  checkRefs(input);
  if (!input.description || !input.description.trim()) throw new HttpError(400, 'Homework description is required');
  const info = db()
    .prepare(
      'INSERT INTO homework (lesson_id, session_id, feedback_id, description, due_date, status, exercise_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(input.lesson_id || null, input.session_id || null, input.feedback_id || null, input.description.trim(), input.due_date || null, 'open', JSON.stringify(input.exercise_ids || []), nowIso());
  audit('homework', info.lastInsertRowid, 'create', undefined, input, actor);
  return db().prepare('SELECT * FROM homework WHERE id = ?').get(info.lastInsertRowid);
}

export function updateHomework(id, patch, actor) {
  const before = db().prepare('SELECT * FROM homework WHERE id = ?').get(id);
  if (!before) throw notFound(`Homework ${id}`);
  const next = {
    description: patch.description ?? before.description,
    due_date: patch.due_date === undefined ? before.due_date : patch.due_date || null,
    status: patch.status ?? before.status,
  };
  if (!['open', 'done'].includes(next.status)) throw new HttpError(400, 'status must be open or done');
  const completedAt = next.status === 'done' ? before.completed_at || nowIso() : null;
  db().prepare('UPDATE homework SET description=?, due_date=?, status=?, completed_at=? WHERE id=?').run(next.description, next.due_date, next.status, completedAt, id);
  audit('homework', id, 'update', before, next, actor);
  return db().prepare('SELECT * FROM homework WHERE id = ?').get(id);
}

export function deleteHomework(id, actor) {
  const before = db().prepare('SELECT * FROM homework WHERE id = ?').get(id);
  if (!before) throw notFound(`Homework ${id}`);
  db().prepare('DELETE FROM homework WHERE id = ?').run(id);
  audit('homework', id, 'delete', before, undefined, actor);
}
