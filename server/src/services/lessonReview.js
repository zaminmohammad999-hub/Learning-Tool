// Lesson review: Claude reads the lesson's transcript(s) and scores how well each of the lesson's four
// objectives (its curriculum exercises) was covered, generously. This is a learning record shown on the
// lesson page; it does not change exercise status or mastery by itself.
import { getDb, nowIso } from '../db/connection.js';
import { HttpError, notFound, parseJson, audit } from './common.js';
import { aiStatus, reviewLessonWithClaude, describeAiError } from './aiClient.js';

const db = () => getDb();
const MAX_CHARS = 150_000;
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

function lessonTranscripts(lessonId) {
  return db()
    .prepare(
      `SELECT t.id, s.session_date FROM transcripts t JOIN session_lessons sl ON sl.session_id = t.session_id
       JOIN tutoring_sessions s ON s.id = t.session_id WHERE sl.lesson_id = ? ORDER BY s.session_date, t.id`
    )
    .all(lessonId);
}

export async function runLessonReview(lessonId, actor = 'user') {
  const lesson = db().prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  if (!lesson) throw notFound(`Lesson ${lessonId}`);
  if (!aiStatus().available) throw new HttpError(503, `Lesson review needs Claude: ${aiStatus().reason}`);
  const transcripts = lessonTranscripts(lessonId);
  if (!transcripts.length) throw new HttpError(400, 'This lesson has no transcript yet.');
  const objectives = db()
    .prepare('SELECT id, description FROM practical_exercises WHERE competency_id = ? AND is_canonical = 1 ORDER BY sort_order, id')
    .all(lesson.competency_id);
  let text = '';
  for (const t of transcripts) {
    const segs = db().prepare('SELECT seq, speaker, timecode, text FROM transcript_segments WHERE transcript_id = ? ORDER BY seq').all(t.id);
    text += `--- Session ${t.session_date} (transcript #${t.id}) ---\n`;
    text += segs.map((s) => `[#${s.seq}]${s.timecode ? ` (${s.timecode})` : ''} ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n') + '\n';
  }
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS);

  let out;
  try {
    out = await reviewLessonWithClaude({ lessonTitle: `Lesson ${lesson.number}: ${lesson.title}`, objectives, transcriptText: text });
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(502, describeAiError(err));
  }
  const ids = new Set(objectives.map((o) => o.id));
  const byId = new Map(out.data.objectives.filter((o) => ids.has(o.exercise_id)).map((o) => [o.exercise_id, { ...o, score: clamp(o.score) }]));
  const review = {
    objectives: objectives.map(
      (o) => byId.get(o.id) || { exercise_id: o.id, coverage: 'not_covered', score: 0, summary: 'Not assessed in the review.', evidence_segment: null }
    ),
    overall_score: clamp(out.data.overall_score),
    overall_summary: out.data.overall_summary,
    went_well: out.data.went_well,
    to_practise: out.data.to_practise,
    truncated,
  };
  const info = db()
    .prepare('INSERT INTO lesson_reviews (lesson_id, transcript_ids, model, overall_score, review_json, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(lessonId, transcripts.map((t) => t.id).join(','), out.model, review.overall_score, JSON.stringify(review), out.usage ? JSON.stringify(out.usage) : null, nowIso());
  audit('lesson_review', lessonId, 'created', undefined, { overall_score: review.overall_score, review_id: Number(info.lastInsertRowid) }, actor);
  return getLessonReview(lessonId);
}

export function getLessonReview(lessonId) {
  const r = db().prepare('SELECT * FROM lesson_reviews WHERE lesson_id = ? ORDER BY id DESC LIMIT 1').get(lessonId);
  if (!r) return null;
  const review = parseJson(r.review_json, {});
  const desc = new Map(db().prepare('SELECT id, description FROM practical_exercises').all().map((e) => [e.id, e.description]));
  review.objectives = (review.objectives || []).map((o) => ({ ...o, description: desc.get(o.exercise_id) || '' }));
  return { id: r.id, lesson_id: r.lesson_id, model: r.model, created_at: r.created_at, transcript_ids: r.transcript_ids.split(',').map(Number), usage: parseJson(r.usage_json), ...review };
}
