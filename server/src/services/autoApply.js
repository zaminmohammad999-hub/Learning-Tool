// Automatic application of Claude's findings after a lesson (when "auto_apply" is on).
//
// From one transcript's Claude analysis this:
// - approves every finding Claude classed as discussed / demonstrated / independently completed
//   (findings marked "uncertain" stay pending for you), which updates exercise status and coverage;
// - sets aside the free keyword matcher's proposals for the same transcript (superseded);
// - marks the lesson Held with the session date, if it was still Planned;
// - adds a Tutor Feedback entry from the transcript (Fariha's comments, difficulties, open questions,
//   topics, homework), labelled as automatic.
// Verified mastery is never touched: that stays a live practical test signed off by the tutor.
// Everything is recorded with its "before" state so it can be undone in one step.
import { getDb, nowIso, tx } from '../db/connection.js';
import { HttpError, audit, getSetting, notFound, parseJson, STATUS_RANK } from './common.js';
import { decideMatch, getAnalysis } from './analysis.js';
import { updateLessonProgress } from './progress.js';
import { createFeedback, deleteFeedback } from './feedback.js';

const db = () => getDb();
export const AUTO = 'auto';
const AUTO_AUTHOR_SUFFIX = '(automatic, from the lesson transcript)';

const texts = (items) => (items || []).map((i) => (typeof i === 'string' ? i : i?.text)).filter(Boolean);
const bullets = (items) => (items.length ? items.map((t) => `• ${t}`).join('\n') : null);

export function autoApplyEnabled() {
  return getSetting('auto_apply', 'false') === 'true';
}

/** Apply a completed Claude analysis. Returns a summary, or null if there was nothing to do. */
export function autoApplyAnalysis(analysisId, { now = new Date() } = {}) {
  const a = getAnalysis(analysisId);
  if (a.method !== 'claude' || a.status !== 'completed') return null;
  const existing = db().prepare('SELECT * FROM auto_applied WHERE transcript_id = ? AND undone_at IS NULL').get(a.transcript_id);
  if (existing) return parseJson(existing.summary_json);
  const t = db().prepare('SELECT id, session_id FROM transcripts WHERE id = ?').get(a.transcript_id);
  if (!t) throw notFound(`Transcript ${a.transcript_id}`);
  const session = db().prepare('SELECT * FROM tutoring_sessions WHERE id = ?').get(t.session_id);
  const lessonIds = db().prepare('SELECT lesson_id FROM session_lessons WHERE session_id = ? ORDER BY lesson_id').all(t.session_id).map((r) => r.lesson_id);

  return tx(() => {
    const summary = { analysis_id: analysisId, approved: [], left_for_review: [], superseded: [], lessons_held: [], feedback_id: null };

    // 1. Claude's findings → evidence + exercise status (before-state kept for undo).
    for (const m of a.matches.filter((x) => x.review_status === 'pending')) {
      if (m.category === 'uncertain') {
        summary.left_for_review.push({ match_id: m.id, exercise_id: m.exercise_id });
        continue;
      }
      const before = db().prepare('SELECT status, coverage_confirmed FROM exercise_progress WHERE exercise_id = ?').get(m.exercise_id);
      decideMatch(m.id, { decision: 'approve', reviewer: AUTO, note: 'Applied automatically from the Claude analysis of the lesson transcript.' });
      summary.approved.push({ match_id: m.id, exercise_id: m.exercise_id, category: m.category, before });
    }

    // 2. The free keyword matcher's proposals for this transcript are superseded by Claude's.
    const rulePending = db()
      .prepare(
        `SELECT m.id, m.exercise_id FROM evidence_matches m JOIN transcript_analyses an ON an.id = m.analysis_id
         WHERE m.transcript_id = ? AND an.method = 'rule_based' AND m.review_status = 'pending'`
      )
      .all(a.transcript_id);
    for (const m of rulePending) {
      decideMatch(m.id, { decision: 'reject', reviewer: AUTO, note: 'Superseded by the Claude analysis (applied automatically).' });
      summary.superseded.push({ match_id: m.id, exercise_id: m.exercise_id });
    }

    // 3. The lesson took place.
    for (const lid of lessonIds) {
      const lp = db().prepare('SELECT status, held_date FROM lesson_progress WHERE lesson_id = ?').get(lid);
      if (lp?.status === 'planned') {
        updateLessonProgress(lid, { status: 'held', held_date: session.session_date }, AUTO);
        summary.lessons_held.push(lid);
      }
    }

    // 4. Tutor feedback drawn from the transcript.
    const x = a.extraction || {};
    const difficulties = texts(x.difficulties);
    const tutorComments = texts(x.tutor_feedback);
    const openQuestions = texts(x.unresolved_questions);
    const homework = texts(x.homework);
    const topics = (x.topics || []).filter(Boolean);
    if (difficulties.length || tutorComments.length || openQuestions.length || homework.length || topics.length) {
      const tutor = (getSetting('tutor_name') || 'Tutor').trim();
      const due = (() => {
        const next = db()
          .prepare('SELECT starts_at FROM calendar_events WHERE cancelled = 0 AND starts_at > ? ORDER BY starts_at LIMIT 1')
          .get(now.toISOString());
        return next ? new Date(next.starts_at).toLocaleDateString('en-CA') : null;
      })();
      const fb = createFeedback(
        {
          session_id: session.id,
          lesson_id: lessonIds[0] || null,
          feedback_date: session.session_date,
          author: `${tutor} ${AUTO_AUTHOR_SUFFIX}`,
          corrections: bullets(tutorComments),
          weaknesses: bullets(difficulties),
          next_priorities: bullets(openQuestions),
          practiced: topics.length ? topics.join('; ') : null,
          homework: bullets(homework),
          exercise_ids: [...new Set(summary.approved.map((s) => s.exercise_id))],
          homework_items: homework.map((h) => ({ description: h, due_date: due })),
        },
        AUTO
      );
      summary.feedback_id = fb.id;
    }

    db()
      .prepare('INSERT INTO auto_applied (transcript_id, analysis_id, summary_json, applied_at) VALUES (?, ?, ?, ?) ON CONFLICT(transcript_id) DO UPDATE SET analysis_id = excluded.analysis_id, summary_json = excluded.summary_json, applied_at = excluded.applied_at, undone_at = NULL')
      .run(a.transcript_id, analysisId, JSON.stringify(summary), nowIso());
    audit('auto_apply', a.transcript_id, 'applied', undefined, { approved: summary.approved.length, left_for_review: summary.left_for_review.length, lessons_held: summary.lessons_held, feedback_id: summary.feedback_id }, AUTO);
    return summary;
  });
}

export function getAutoApplied(transcriptId) {
  const r = db().prepare('SELECT * FROM auto_applied WHERE transcript_id = ?').get(transcriptId);
  return r ? { ...r, summary: parseJson(r.summary_json, {}) } : null;
}

/** Highest category among an exercise's remaining approved evidence, or null if there is none. */
function bestRemaining(exerciseId) {
  const rows = db().prepare('SELECT category FROM exercise_evidence WHERE exercise_id = ?').all(exerciseId);
  return rows.reduce((best, r) => (best === null || STATUS_RANK[r.category] > STATUS_RANK[best] ? r.category : best), null);
}

/**
 * Undo everything applied automatically for one transcript. Claude's findings go back to "pending" so
 * you can review them yourself; exercise statuses fall back to what other evidence supports (or what they
 * were before); the lesson goes back to Planned if automation had marked it Held; the automatic feedback
 * entry and its homework are removed. Changes you made yourself afterwards are left alone.
 */
export function undoAutoApply(transcriptId, actor = 'user') {
  const rec = getAutoApplied(transcriptId);
  if (!rec || rec.undone_at) throw new HttpError(404, 'Nothing was applied automatically for this transcript (or it was already undone).');
  const s = rec.summary;
  return tx((d) => {
    for (const it of s.approved || []) {
      const m = d.prepare('SELECT * FROM evidence_matches WHERE id = ?').get(it.match_id);
      if (!m || m.reviewer !== AUTO) continue; // you re-decided it since: keep your decision
      d.prepare('DELETE FROM exercise_evidence WHERE match_id = ? AND approved_by = ?').run(it.match_id, AUTO);
      d.prepare("UPDATE evidence_matches SET review_status = 'pending', final_category = NULL, reviewed_at = NULL, reviewer = NULL WHERE id = ?").run(it.match_id);
      const prog = d.prepare('SELECT status FROM exercise_progress WHERE exercise_id = ?').get(it.exercise_id);
      if (prog && prog.status !== 'needs_practice') {
        const remaining = bestRemaining(it.exercise_id);
        const status = remaining || it.before?.status || 'not_started';
        const confirmed = remaining ? 1 : it.before?.coverage_confirmed ?? 0;
        d.prepare('UPDATE exercise_progress SET status = ?, coverage_confirmed = ?, updated_at = ? WHERE exercise_id = ?').run(status, confirmed, nowIso(), it.exercise_id);
      }
    }
    for (const it of s.superseded || []) {
      d.prepare("UPDATE evidence_matches SET review_status = 'pending', final_category = NULL, reviewed_at = NULL, reviewer = NULL WHERE id = ? AND reviewer = ?").run(it.match_id, AUTO);
    }
    for (const lid of s.lessons_held || []) {
      const lp = d.prepare('SELECT status FROM lesson_progress WHERE lesson_id = ?').get(lid);
      if (lp?.status === 'held') updateLessonProgress(lid, { status: 'planned', held_date: '' }, actor);
    }
    if (s.feedback_id && d.prepare('SELECT 1 FROM tutor_feedback WHERE id = ?').get(s.feedback_id)) {
      d.prepare('DELETE FROM homework WHERE feedback_id = ?').run(s.feedback_id);
      deleteFeedback(s.feedback_id, actor);
    }
    d.prepare('UPDATE auto_applied SET undone_at = ? WHERE transcript_id = ?').run(nowIso(), transcriptId);
    audit('auto_apply', transcriptId, 'undone', undefined, { approved: (s.approved || []).length }, actor);
    return { undone: true, findings_back_to_review: (s.approved || []).length };
  });
}
