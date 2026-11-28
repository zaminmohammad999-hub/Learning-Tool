// Tutor Intelligence: a short review of a held lesson, and a suggested format for the next lesson.
// Both are written by Claude from the lesson records (objectives, scores, tutor feedback, homework) and,
// for the review, the transcript. The latest result per lesson is kept so it shows without re-running.
import { getDb, nowIso } from '../db/connection.js';
import { HttpError, notFound, parseJson, audit } from './common.js';
import { aiStatus, describeAiError, lessonBriefWithClaude, lessonFormatWithClaude } from './aiClient.js';
import { getLessonReview, lessonObjectives, lessonTranscriptText } from './lessonReview.js';

const db = () => getDb();

function lessonOrThrow(lessonId) {
  const l = db().prepare('SELECT l.*, lp.status FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id WHERE l.id = ?').get(lessonId);
  if (!l) throw notFound(`Lesson ${lessonId}`);
  return l;
}

function ensureAi() {
  if (!aiStatus().available) throw new HttpError(503, `This needs Claude: ${aiStatus().reason}`);
}

function save(lessonId, kind, out) {
  db()
    .prepare('INSERT INTO lesson_insights (lesson_id, kind, content_json, model, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(lessonId, kind, JSON.stringify(out.data), out.model, out.usage ? JSON.stringify(out.usage) : null, nowIso());
  audit('lesson_insight', lessonId, kind, undefined, { model: out.model }, 'user');
}

function latest(lessonId, kind) {
  const r = db().prepare('SELECT * FROM lesson_insights WHERE lesson_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(lessonId, kind);
  return r ? { ...parseJson(r.content_json, {}), created_at: r.created_at, model: r.model } : null;
}

export function getInsights(lessonId) {
  lessonOrThrow(lessonId);
  return { review: latest(lessonId, 'review'), format: latest(lessonId, 'format') };
}

/** Plain-text summary of what the records say about one lesson (scores, tutor feedback, homework). */
export function recordsFor(lesson) {
  const lines = [`Lesson ${lesson.number}: ${lesson.title} (status: ${lesson.status})`];
  const rev = getLessonReview(lesson.id);
  if (rev) {
    lines.push(`Objective scores (generous): overall ${rev.overall_score}%`);
    rev.objectives.forEach((o) => lines.push(`- ${o.description}: ${o.coverage}, ${o.score}% — ${o.summary}`));
  }
  const brief = latest(lesson.id, 'review');
  if (brief) {
    if (brief.missed?.length) lines.push(`Missed: ${brief.missed.join(' | ')}`);
    if (brief.next_steps?.length) lines.push(`Agreed next steps: ${brief.next_steps.join(' | ')}`);
  }
  for (const f of db().prepare('SELECT * FROM tutor_feedback WHERE lesson_id = ? ORDER BY id').all(lesson.id)) {
    for (const [k, label] of [['strengths', 'Tutor positives'], ['weaknesses', 'Tutor concerns'], ['tutor_questions', 'Tutor questions'], ['next_priorities', 'Next priorities'], ['analysis', 'Tutor thinking (interpretation)']])
      if (f[k]) lines.push(`${label}: ${String(f[k]).replace(/\n/g, ' ')}`);
  }
  const hw = db().prepare('SELECT description, review_status FROM homework WHERE lesson_id = ? ORDER BY id').all(lesson.id);
  hw.forEach((h) => lines.push(`Homework (${h.review_status.replace('_', ' ')}): ${h.description}`));
  return lines.join('\n');
}

/** Short review of a held lesson: covered vs objectives, missed, next steps, how to run and organise. */
export async function runLessonBrief(lessonId) {
  const lesson = lessonOrThrow(lessonId);
  ensureAi();
  const { text, count } = lessonTranscriptText(lessonId);
  if (!count) throw new HttpError(400, 'This lesson has no transcript yet, so there is nothing to review.');
  let out;
  try {
    out = await lessonBriefWithClaude({ lessonTitle: `Lesson ${lesson.number}: ${lesson.title}`, objectives: lessonObjectives(lesson), transcriptText: text, context: recordsFor(lesson) });
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(502, describeAiError(err));
  }
  save(lessonId, 'review', out);
  return latest(lessonId, 'review');
}

/** Length of the lesson in its calendar slot, else the curriculum length. */
export function minutesFor(lesson) {
  const occ = db()
    .prepare("SELECT starts_at, ends_at FROM calendar_events WHERE lesson_id = ? AND cancelled = 0 AND ends_at > ? ORDER BY starts_at LIMIT 1")
    .get(lesson.id, new Date().toISOString());
  if (occ) return Math.round((new Date(occ.ends_at) - new Date(occ.starts_at)) / 60000);
  return lesson.duration_minutes || 60;
}

/** What happened in the lessons before this one, plus open homework (input for the suggested format). */
export function formatContext(lesson) {
  const earlier = db()
    .prepare("SELECT l.*, lp.status FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id WHERE l.number < ? AND lp.status = 'held' ORDER BY l.number DESC LIMIT 3")
    .all(lesson.number);
  const openHomework = db()
    .prepare("SELECT h.description, h.review_status, l.number FROM homework h LEFT JOIN lessons l ON l.id = h.lesson_id WHERE h.review_status <> 'approved' ORDER BY h.id")
    .all();
  return [
    ...earlier.reverse().map(recordsFor),
    openHomework.length ? `Homework not yet approved:\n${openHomework.map((h) => `- L${h.number ?? '?'}: ${h.description} (${h.review_status.replace('_', ' ')})`).join('\n')}` : 'No outstanding homework.',
  ].join('\n\n');
}

/** Suggested format for a (normally upcoming) lesson, built from what happened in the lessons before it. */
export async function runLessonFormat(lessonId) {
  const lesson = lessonOrThrow(lessonId);
  ensureAi();
  const context = formatContext(lesson);
  let out;
  try {
    out = await lessonFormatWithClaude({ lessonTitle: `Lesson ${lesson.number}: ${lesson.title}`, minutes: minutesFor(lesson), objectives: lessonObjectives(lesson), context: context || 'This is the first lesson.' });
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(502, describeAiError(err));
  }
  save(lessonId, 'format', out);
  return { ...latest(lessonId, 'format'), minutes: minutesFor(lesson) };
}
