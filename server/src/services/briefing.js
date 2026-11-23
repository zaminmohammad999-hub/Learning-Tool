// Deterministic gap analysis and next-lesson briefing. Every item carries citations back to stored records.
import { getDb } from '../db/connection.js';
import { parseJson, isCovered, notFound, todayIso } from './common.js';
import { EXERCISE_KEYWORDS } from './exerciseKeywords.js';
import { computeMastery } from './assessments.js';
import { plannedDate } from './progress.js';

const db = () => getDb();

function exerciseState() {
  return db()
    .prepare(
      `SELECT e.id, e.competency_id, e.description, e.is_canonical, p.status, p.coverage_confirmed, p.due_date, cc.title AS competency_title, cc.domain_id, cc.lesson_id
       FROM practical_exercises e JOIN exercise_progress p ON p.exercise_id = e.id JOIN core_competencies cc ON cc.id = e.competency_id ORDER BY e.id`
    )
    .all()
    .map((e) => ({ ...e, covered: isCovered(e.status, e.coverage_confirmed) }));
}

function heldLessons() {
  return db()
    .prepare(`SELECT l.*, lp.held_date FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id WHERE lp.status = 'held' ORDER BY l.number`)
    .all();
}

function evidenceCitation(ev) {
  return {
    type: 'evidence',
    ref: `evidence:${ev.id}`,
    label: `${ev.exercise_id} · ${ev.source === 'manual' ? 'manual entry' : `session ${ev.session_date || '?'}`}${ev.timecode ? ` @ ${ev.timecode}` : ''}`,
    session_id: ev.session_id,
    transcript_id: ev.transcript_id,
    snippet: ev.snippet || ev.note || '',
  };
}

/** Facet-level gaps from the latest completed analysis of each transcript that are still not evidenced. */
function facetGapsStillOpen(exState) {
  const latest = db()
    .prepare(
      `SELECT a.*, t.session_id, s.session_date FROM transcript_analyses a JOIN transcripts t ON t.id = a.transcript_id JOIN tutoring_sessions s ON s.id = t.session_id
       WHERE a.status = 'completed' AND a.version = (SELECT MAX(version) FROM transcript_analyses x WHERE x.transcript_id = a.transcript_id AND x.status='completed')`
    )
    .all();
  const exById = new Map(exState.map((e) => [e.id, e]));
  const approvedText = new Map();
  db()
    .prepare('SELECT exercise_id, snippet, note FROM exercise_evidence')
    .all()
    .forEach((r) => approvedText.set(r.exercise_id, `${approvedText.get(r.exercise_id) || ''}\n${r.snippet || ''}\n${r.note || ''}`));
  const out = [];
  const seen = new Set();
  for (const a of latest) {
    for (const g of parseJson(a.gaps_json, [])) {
      const ex = exById.get(g.exercise_id);
      if (!ex) continue;
      const key = `${g.exercise_id}|${g.facet || ''}`;
      if (seen.has(key)) continue;
      if (!g.facet && ex.covered) continue;
      if (g.facet) {
        const re = EXERCISE_KEYWORDS[g.exercise_id]?.facets?.[g.facet];
        if (re && re.test(approvedText.get(g.exercise_id) || '')) continue;
      }
      seen.add(key);
      out.push({
        ...g,
        competency_id: ex.competency_id,
        citation: { type: 'analysis', ref: `analysis:${a.id}`, label: `Analysis v${a.version} of transcript #${a.transcript_id} (session ${a.session_date})`, session_id: a.session_id, transcript_id: a.transcript_id },
      });
    }
  }
  return out;
}

function failedCriteria() {
  const latestPerRubric = db()
    .prepare(
      `SELECT a.* FROM assessment_attempts a WHERE a.id = (SELECT MAX(id) FROM assessment_attempts b WHERE b.rubric_id = a.rubric_id) AND a.overall_result = 'fail'`
    )
    .all();
  const out = [];
  for (const a of latestPerRubric) {
    const rows = db()
      .prepare(
        `SELECT cr.*, ac.text, ac.mandatory FROM criterion_results cr JOIN assessment_criteria ac ON ac.id = cr.criterion_id
         WHERE cr.attempt_id = ? AND cr.counts_toward_pass = 0 AND ac.mandatory = 1 AND ac.active = 1`
      )
      .all(a.id);
    const recorded = new Set(db().prepare('SELECT criterion_id FROM criterion_results WHERE attempt_id = ?').all(a.id).map((r) => r.criterion_id));
    const unrecorded = db()
      .prepare('SELECT * FROM assessment_criteria WHERE rubric_id = ? AND mandatory = 1 AND active = 1')
      .all(a.rubric_id)
      .filter((c) => !recorded.has(c.id));
    rows.forEach((r) =>
      out.push({ rubric_id: a.rubric_id, competency_id: a.competency_id, domain_assessment_id: a.domain_assessment_id, criterion_id: r.criterion_id, text: r.text, reason: r.not_counted_reason, attempt_id: a.id, attempt_date: a.attempt_date, retry_plan: a.retry_plan })
    );
    unrecorded.forEach((c) =>
      out.push({ rubric_id: a.rubric_id, competency_id: a.competency_id, domain_assessment_id: a.domain_assessment_id, criterion_id: c.id, text: c.text, reason: 'Not recorded in attempt', attempt_id: a.id, attempt_date: a.attempt_date, retry_plan: a.retry_plan })
    );
  }
  return out;
}

export function getGaps() {
  const exState = exerciseState();
  const held = heldLessons();
  const heldComps = new Set(held.map((l) => l.competency_id));
  const comps = db().prepare('SELECT cc.*, d.name AS domain_name FROM core_competencies cc JOIN learning_domains d ON d.id = cc.domain_id ORDER BY cc.sort_order').all();
  const facetGaps = facetGapsStillOpen(exState);
  const failed = failedCriteria();

  const byCompetency = comps
    .map((cc) => {
      const ex = exState.filter((e) => e.competency_id === cc.id && e.is_canonical);
      const uncovered = ex.filter((e) => !e.covered);
      const needsPractice = exState.filter((e) => e.competency_id === cc.id && e.status === 'needs_practice');
      const mastery = computeMastery(cc.id);
      return {
        competency_id: cc.id,
        title: cc.title,
        domain_id: cc.domain_id,
        domain_name: cc.domain_name,
        lesson_id: cc.lesson_id,
        lesson_held: heldComps.has(cc.id),
        uncovered_exercises: uncovered.map((e) => ({ id: e.id, description: e.description, status: e.status })),
        facet_gaps: facetGaps.filter((g) => g.competency_id === cc.id),
        needs_practice: needsPractice.map((e) => ({ id: e.id, description: e.description })),
        failed_criteria: failed.filter((f) => f.competency_id === cc.id),
        mastery_state: mastery.state,
        not_yet_attempted: mastery.attempts === 0,
      };
    })
    .filter((c) => c.lesson_held || c.facet_gaps.length || c.needs_practice.length || c.failed_criteria.length);

  const domainAssessmentsDue = db()
    .prepare(
      `SELECT da.*, lp.status AS lesson_status FROM domain_assessments da JOIN lesson_progress lp ON lp.lesson_id = da.after_lesson_id
       WHERE lp.status = 'held' AND NOT EXISTS (SELECT 1 FROM assessment_attempts a WHERE a.domain_assessment_id = da.id)`
    )
    .all();
  const openHomework = db().prepare("SELECT * FROM homework WHERE status = 'open' ORDER BY COALESCE(due_date, '9999') ").all();
  const pendingReview = db().prepare("SELECT COUNT(*) n FROM evidence_matches WHERE review_status = 'pending'").get().n;

  return {
    generated_at: new Date().toISOString(),
    note: '"Not evidenced" means no approved evidence was found in saved records — it is not proof the topic was never taught.',
    by_competency: byCompetency,
    not_yet_attempted_tests: byCompetency.filter((c) => c.lesson_held && c.not_yet_attempted).map((c) => ({ competency_id: c.competency_id, title: c.title })),
    domain_assessments_due: domainAssessmentsDue,
    failed_criteria: failed,
    open_homework: openHomework.map((h) => ({ ...h, exercise_ids: parseJson(h.exercise_ids_json, []), overdue: Boolean(h.due_date && h.due_date < todayIso()) })),
    pending_review: pendingReview,
  };
}

export function getBriefing(lessonId) {
  let lesson;
  if (lessonId) lesson = db().prepare('SELECT l.*, lp.status, lp.scheduled_date FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id WHERE l.id = ?').get(lessonId);
  else
    lesson = db()
      .prepare("SELECT l.*, lp.status, lp.scheduled_date FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id WHERE lp.status = 'planned' ORDER BY l.number LIMIT 1")
      .get();
  if (!lesson) {
    if (lessonId) throw notFound(`Lesson ${lessonId}`);
    return { lesson: null, message: 'All 24 lessons are marked held or missed — no upcoming lesson to brief.' };
  }
  const comp = db().prepare('SELECT * FROM core_competencies WHERE id = ?').get(lesson.competency_id);
  const exState = exerciseState();
  const gaps = getGaps();
  const thisEx = exState.filter((e) => e.competency_id === lesson.competency_id);

  const evidenceRows = db()
    .prepare(
      `SELECT ev.*, s.session_date FROM exercise_evidence ev LEFT JOIN tutoring_sessions s ON s.id = ev.session_id
       WHERE ev.exercise_id IN (SELECT id FROM practical_exercises WHERE competency_id IN (SELECT competency_id FROM lessons WHERE number BETWEEN ? AND ?))
       ORDER BY ev.updated_at DESC LIMIT 30`
    )
    .all(Math.max(1, lesson.number - 2), lesson.number);

  const earlierGaps = gaps.by_competency.filter((c) => c.lesson_held && c.lesson_id !== lesson.id);
  const carryOver = earlierGaps.flatMap((c) => [
    ...c.uncovered_exercises.map((e) => ({ exercise_id: e.id, text: `${e.id}: ${e.description}`, kind: 'not_evidenced', citations: [] })),
    ...c.facet_gaps.map((g) => ({ exercise_id: g.exercise_id, text: g.message, kind: 'facet_not_evidenced', citations: [g.citation] })),
    ...c.needs_practice.map((e) => ({ exercise_id: e.id, text: `${e.id} marked needs practice: ${e.description}`, kind: 'needs_practice', citations: [] })),
  ]);

  const feedback = db().prepare('SELECT * FROM tutor_feedback ORDER BY feedback_date DESC, id DESC LIMIT 3').all();
  const feedbackItems = feedback.flatMap((f) => {
    const cite = { type: 'feedback', ref: `feedback:${f.id}`, label: `Tutor feedback ${f.feedback_date}${f.author ? ` (${f.author})` : ''}`, session_id: f.session_id };
    return [
      f.next_priorities && { field: 'Next priorities', text: f.next_priorities, citations: [cite] },
      f.weaknesses && { field: 'Weaknesses', text: f.weaknesses, citations: [cite] },
      f.misunderstandings && { field: 'Misunderstandings', text: f.misunderstandings, citations: [cite] },
      f.corrections && { field: 'Corrections', text: f.corrections, citations: [cite] },
    ].filter(Boolean);
  });

  const difficulties = [];
  db()
    .prepare(
      `SELECT a.id, a.extraction_json, a.transcript_id, s.session_date, s.id AS session_id FROM transcript_analyses a JOIN transcripts t ON t.id = a.transcript_id
       JOIN tutoring_sessions s ON s.id = t.session_id WHERE a.status='completed' ORDER BY s.session_date DESC, a.version DESC LIMIT 6`
    )
    .all()
    .forEach((a) =>
      (parseJson(a.extraction_json, {})?.difficulties || []).slice(0, 3).forEach((d) =>
        difficulties.push({
          text: d.text,
          citations: [{ type: 'transcript', ref: `transcript:${a.transcript_id}#${d.seq}`, label: `Session ${a.session_date}${d.timecode ? ` @ ${d.timecode}` : ''}`, session_id: a.session_id, transcript_id: a.transcript_id, snippet: d.text }],
        })
      )
    );

  const da = db().prepare('SELECT * FROM domain_assessments WHERE after_lesson_id = ?').get(lesson.id);
  const uncoveredHere = thisEx.filter((e) => e.is_canonical && !e.covered);
  const homework = gaps.open_homework;

  // Suggested 60-minute agenda.
  const agenda = [];
  if (homework.length) agenda.push({ minutes: 5, item: `Review homework (${homework.length} open)` });
  if (carryOver.length) agenda.push({ minutes: Math.min(15, 5 * Math.ceil(carryOver.length / 2)), item: `Close carry-over gaps: ${carryOver.slice(0, 3).map((g) => g.exercise_id).join(', ')}` });
  if (gaps.failed_criteria.length) agenda.push({ minutes: 10, item: `Re-practise failed criteria: ${gaps.failed_criteria.slice(0, 3).map((f) => f.criterion_id).join(', ')}` });
  const used = agenda.reduce((s, a) => s + a.minutes, 0);
  const remaining = 60 - used - (da ? 15 : 5);
  agenda.push({ minutes: Math.max(20, remaining), item: `Lesson ${lesson.number} — ${lesson.title}: ${uncoveredHere.length} of ${thisEx.filter((e) => e.is_canonical).length} exercises still to evidence` });
  agenda.push(da ? { minutes: 15, item: `Domain assessment ${da.id} is scheduled after this lesson` } : { minutes: 5, item: 'Short skill check on today\'s exercises + set homework' });

  return {
    generated_at: new Date().toISOString(),
    method: 'deterministic (computed from saved records; no AI)',
    lesson: { ...lesson, planned_date: plannedDate(lesson, lesson), competency_title: comp.title },
    exercises: thisEx.map((e) => ({ id: e.id, description: e.description, status: e.status, covered: e.covered, is_canonical: e.is_canonical })),
    covered_recently: evidenceRows.map((ev) => ({ exercise_id: ev.exercise_id, category: ev.category, citations: [evidenceCitation(ev)] })),
    carry_over_gaps: carryOver,
    failed_criteria: gaps.failed_criteria,
    open_homework: homework,
    tutor_priorities: feedbackItems,
    recurring_difficulties: difficulties.slice(0, 8),
    domain_assessment: da || null,
    pending_review: gaps.pending_review,
    agenda,
    mastery: computeMastery(lesson.competency_id),
  };
}
