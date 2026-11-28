// Lesson review: Claude reads the lesson's transcript(s) and scores how well each of the lesson's four
// objectives (its curriculum exercises) was covered, generously. This is a learning record shown on the
// lesson page; it does not change exercise status or mastery by itself.
import { getDb, nowIso } from '../db/connection.js';
import { HttpError, notFound, parseJson, audit, getSetting } from './common.js';
import { aiStatus, reviewLessonWithClaude, describeAiError } from './aiClient.js';
import { createFeedback, updateFeedback, reviewHomework } from './feedback.js';
import { AUTO_AUTHOR_SUFFIX } from './autoApply.js';

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

export function lessonObjectives(lesson) {
  return db()
    .prepare('SELECT id, description FROM practical_exercises WHERE competency_id = ? AND is_canonical = 1 ORDER BY sort_order, id')
    .all(lesson.competency_id);
}

/** All of a lesson's transcripts as numbered English lines, for Claude. */
export function lessonTranscriptText(lessonId) {
  let text = '';
  for (const t of lessonTranscripts(lessonId)) {
    const segs = db().prepare('SELECT seq, speaker, timecode, text FROM transcript_segments WHERE transcript_id = ? ORDER BY seq').all(t.id);
    text += `--- Session ${t.session_date} (transcript #${t.id}) ---\n`;
    text += segs.map((s) => `[#${s.seq}]${s.timecode ? ` (${s.timecode})` : ''} ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n') + '\n';
  }
  const truncated = text.length > MAX_CHARS;
  return { text: truncated ? text.slice(0, MAX_CHARS) : text, truncated, count: lessonTranscripts(lessonId).length };
}

export async function runLessonReview(lessonId, actor = 'user') {
  const lesson = db().prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  if (!lesson) throw notFound(`Lesson ${lessonId}`);
  if (!aiStatus().available) throw new HttpError(503, `Lesson review needs Claude: ${aiStatus().reason}`);
  const transcripts = lessonTranscripts(lessonId);
  if (!transcripts.length) throw new HttpError(400, 'This lesson has no transcript yet.');
  const objectives = lessonObjectives(lesson);
  const { text, truncated } = lessonTranscriptText(lessonId);

  // Homework set in earlier lessons that the tutor has not approved yet: she may approve it in this lesson.
  const outstanding = db()
    .prepare("SELECT id, description FROM homework WHERE review_status <> 'approved' AND (lesson_id IS NULL OR lesson_id <> ?) ORDER BY id")
    .all(lessonId);
  let out;
  try {
    out = await reviewLessonWithClaude({ lessonTitle: `Lesson ${lesson.number}: ${lesson.title}`, objectives, transcriptText: text, homework: outstanding });
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
    tutor_perspective: out.data.tutor_perspective,
    homework_reviews: out.data.homework_reviews.filter((h) => outstanding.some((o) => o.id === h.homework_id)),
    truncated,
  };
  const info = db()
    .prepare('INSERT INTO lesson_reviews (lesson_id, transcript_ids, model, overall_score, review_json, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(lessonId, transcripts.map((t) => t.id).join(','), out.model, review.overall_score, JSON.stringify(review), out.usage ? JSON.stringify(out.usage) : null, nowIso());
  audit('lesson_review', lessonId, 'created', undefined, { overall_score: review.overall_score, review_id: Number(info.lastInsertRowid) }, actor);
  applyTutorPerspective(lesson, review, actor);
  applyHomeworkVerdicts(lesson, review, actor);
  return getLessonReview(lessonId);
}

const bullets = (items) => (items?.length ? items.map((t) => `• ${t}`).join('\n') : null);

/**
 * Put the tutor's positives, concerns, questions and the analysis of her thinking into the lesson's
 * automatic Tutor Feedback entry (created if there is none yet). Entries you wrote yourself are not touched.
 */
function applyTutorPerspective(lesson, review, actor) {
  const p = review.tutor_perspective;
  if (!p) return;
  const session = db()
    .prepare('SELECT s.* FROM tutoring_sessions s JOIN session_lessons sl ON sl.session_id = s.id WHERE sl.lesson_id = ? ORDER BY s.session_date DESC, s.id DESC LIMIT 1')
    .get(lesson.id);
  if (!session) return;
  const fields = { strengths: bullets(p.positives), weaknesses: bullets(p.concerns), tutor_questions: bullets(p.questions), analysis: p.analysis || null };
  const auto = db().prepare('SELECT id FROM tutor_feedback WHERE session_id = ? AND author LIKE ? ORDER BY id DESC LIMIT 1').get(session.id, `%${AUTO_AUTHOR_SUFFIX}`);
  if (auto) updateFeedback(auto.id, fields, actor);
  else {
    const tutor = (getSetting('tutor_name') || 'Tutor').trim();
    createFeedback({ session_id: session.id, lesson_id: lesson.id, feedback_date: session.session_date, author: `${tutor} ${AUTO_AUTHOR_SUFFIX}`, ...fields }, actor);
  }
}

/** Homework the tutor clearly approved (or sent back) during this recorded lesson. */
function applyHomeworkVerdicts(lesson, review, actor) {
  const tutor = (getSetting('tutor_name') || 'Tutor').trim();
  for (const h of review.homework_reviews || []) {
    if (h.verdict === 'not_discussed') continue;
    const cur = db().prepare('SELECT review_status FROM homework WHERE id = ?').get(h.homework_id);
    if (!cur || cur.review_status === 'approved') continue;
    reviewHomework(
      h.homework_id,
      {
        verdict: h.verdict === 'approved' ? 'approved' : 'changes_requested',
        method: 'transcript',
        reviewer: `${tutor} (in Lesson ${lesson.number})`,
        note: `${h.note}${h.evidence_segment ? ` (transcript line #${h.evidence_segment})` : ''}`,
      },
      actor
    );
  }
}

export function getLessonReview(lessonId) {
  const r = db().prepare('SELECT * FROM lesson_reviews WHERE lesson_id = ? ORDER BY id DESC LIMIT 1').get(lessonId);
  if (!r) return null;
  const review = parseJson(r.review_json, {});
  const desc = new Map(db().prepare('SELECT id, description FROM practical_exercises').all().map((e) => [e.id, e.description]));
  review.objectives = (review.objectives || []).map((o) => ({ ...o, description: desc.get(o.exercise_id) || '' }));
  return { id: r.id, lesson_id: r.lesson_id, model: r.model, created_at: r.created_at, transcript_ids: r.transcript_ids.split(',').map(Number), usage: parseJson(r.usage_json), ...review };
}
