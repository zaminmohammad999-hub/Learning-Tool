import { getDb, nowIso, tx } from '../db/connection.js';
import { HttpError, notFound, audit, isCovered, getSetting, todayIso, parseJson, EXERCISE_STATUSES } from './common.js';
import { computeMastery, domainAssessmentStatus } from './assessments.js';

const db = () => getDb();

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Planned date: explicit lesson date, else derived from programme start (lesson 2 of a week = +3 days). */
export function plannedDate(lesson, progress, startDate = getSetting('programme_start_date')) {
  if (progress?.scheduled_date) return progress.scheduled_date;
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
  return addDays(startDate, (lesson.week - 1) * 7 + (lesson.session_in_week === 2 ? 3 : 0));
}

function exerciseRows(where = '', args = []) {
  return db()
    .prepare(
      `SELECT e.id, e.competency_id, e.description, e.is_canonical, e.sort_order,
              p.status, p.coverage_confirmed, p.notes, p.due_date, p.display_order, p.updated_at,
              (SELECT COUNT(*) FROM exercise_evidence ev WHERE ev.exercise_id = e.id) AS evidence_count,
              (SELECT COUNT(*) FROM evidence_matches m WHERE m.exercise_id = e.id AND m.review_status = 'pending') AS pending_matches
       FROM practical_exercises e JOIN exercise_progress p ON p.exercise_id = e.id ${where}
       ORDER BY e.competency_id, COALESCE(p.display_order, e.sort_order), e.id`
    )
    .all(...args)
    .map((e) => ({ ...e, covered: isCovered(e.status, e.coverage_confirmed) }));
}

export function getCurriculumTree() {
  const programme = db().prepare('SELECT * FROM programme WHERE id = 1').get();
  const domains = db().prepare('SELECT * FROM learning_domains ORDER BY sort_order').all();
  const comps = db()
    .prepare(
      `SELECT cc.*, l.number AS lesson_number, l.week, l.title AS lesson_title, lp.status AS lesson_status
       FROM core_competencies cc JOIN lessons l ON l.id = cc.lesson_id JOIN lesson_progress lp ON lp.lesson_id = l.id
       ORDER BY cc.sort_order`
    )
    .all();
  const exercises = exerciseRows();
  const byComp = new Map();
  exercises.forEach((e) => {
    if (!byComp.has(e.competency_id)) byComp.set(e.competency_id, []);
    byComp.get(e.competency_id).push(e);
  });
  return {
    programme: { ...programme, hierarchy: parseJson(programme?.hierarchy_json, []) },
    domains: domains.map((d) => {
      const competencies = comps
        .filter((c) => c.domain_id === d.id)
        .map((c) => {
          const ex = byComp.get(c.id) || [];
          const canonical = ex.filter((e) => e.is_canonical);
          const covered = canonical.filter((e) => e.covered).length;
          return {
            ...c,
            exercises: ex,
            coverage: { covered, total: canonical.length, percent: Math.round((covered / 4) * 100) },
            mastery: computeMastery(c.id),
          };
        });
      const covered = competencies.reduce((s, c) => s + c.coverage.covered, 0);
      return {
        ...d,
        competencies,
        coverage: { covered, total: 16, percent: Math.round((covered / 16) * 100) },
        mastered: competencies.filter((c) => c.mastery.state === 'passed').length,
        domain_assessment: domainAssessmentStatus(`DA-${d.id}`),
      };
    }),
  };
}

export function getExercise(id) {
  const e = exerciseRows('WHERE e.id = ?', [id])[0];
  if (!e) throw notFound(`Exercise ${id}`);
  return e;
}

export function updateExerciseProgress(id, patch, actor) {
  const before = getExercise(id);
  if (patch.status && !EXERCISE_STATUSES.includes(patch.status)) throw new HttpError(400, 'Invalid status');
  const next = {
    status: patch.status ?? before.status,
    coverage_confirmed: patch.coverage_confirmed === undefined ? before.coverage_confirmed : patch.coverage_confirmed ? 1 : 0,
    notes: patch.notes === undefined ? before.notes : patch.notes,
    due_date: patch.due_date === undefined ? before.due_date : patch.due_date || null,
  };
  db()
    .prepare('UPDATE exercise_progress SET status=?, coverage_confirmed=?, notes=?, due_date=?, updated_at=? WHERE exercise_id=?')
    .run(next.status, next.coverage_confirmed, next.notes, next.due_date, nowIso(), id);
  audit(
    'exercise_progress',
    id,
    'update',
    { status: before.status, coverage_confirmed: before.coverage_confirmed, notes: before.notes, due_date: before.due_date },
    next,
    actor
  );
  return getExercise(id);
}

/** Custom exercises live alongside (never replace) canonical seed rows and do not count toward the 96. */
export function addCustomExercise({ competency_id, description }, actor) {
  const cc = db().prepare('SELECT id FROM core_competencies WHERE id = ?').get(competency_id);
  if (!cc) throw notFound(`Competency ${competency_id}`);
  return tx((d) => {
    const n = d.prepare('SELECT COUNT(*) n FROM practical_exercises WHERE competency_id = ? AND is_canonical = 0').get(competency_id).n;
    const id = `${competency_id}-X${n + 1}`;
    const maxOrder = d
      .prepare(
        'SELECT COALESCE(MAX(COALESCE(p.display_order, e.sort_order)), 0) m FROM practical_exercises e JOIN exercise_progress p ON p.exercise_id = e.id WHERE e.competency_id = ?'
      )
      .get(competency_id).m;
    d.prepare('INSERT INTO practical_exercises (id, competency_id, description, is_canonical, sort_order, created_at) VALUES (?, ?, ?, 0, ?, ?)').run(
      id,
      competency_id,
      description,
      100 + n,
      nowIso()
    );
    d.prepare('INSERT INTO exercise_progress (exercise_id, display_order, updated_at) VALUES (?, ?, ?)').run(id, maxOrder + 1, nowIso());
    audit('practical_exercise', id, 'create_custom', undefined, { competency_id, description }, actor);
    return getExercise(id);
  });
}

export function updateCustomExercise(id, { description }, actor) {
  const e = getExercise(id);
  if (e.is_canonical) throw new HttpError(403, 'Canonical curriculum exercises cannot be edited; add notes or a custom exercise instead');
  db().prepare('UPDATE practical_exercises SET description = ? WHERE id = ?').run(description, id);
  audit('practical_exercise', id, 'update_custom', { description: e.description }, { description }, actor);
  return getExercise(id);
}

export function deleteCustomExercise(id, actor) {
  const e = getExercise(id);
  if (e.is_canonical) throw new HttpError(403, 'Canonical curriculum exercises cannot be deleted');
  tx((d) => {
    d.prepare('DELETE FROM evidence_matches WHERE exercise_id = ?').run(id);
    d.prepare('DELETE FROM practical_exercises WHERE id = ?').run(id);
  });
  audit('practical_exercise', id, 'delete_custom', e, undefined, actor);
}

export function reorderExercises(competencyId, orderedIds, actor) {
  const existing = exerciseRows('WHERE e.competency_id = ?', [competencyId]).map((e) => e.id);
  const set = new Set(existing);
  if (orderedIds.length !== existing.length || !orderedIds.every((id) => set.has(id)))
    throw new HttpError(400, 'orderedIds must contain exactly the exercises of this competency');
  tx((d) => {
    const st = d.prepare('UPDATE exercise_progress SET display_order = ? WHERE exercise_id = ?');
    orderedIds.forEach((id, i) => st.run(i + 1, id));
  });
  audit('competency', competencyId, 'reorder_exercises', existing, orderedIds, actor);
  return exerciseRows('WHERE e.competency_id = ?', [competencyId]);
}

export function getExerciseEvidence(id) {
  getExercise(id);
  return db()
    .prepare(
      `SELECT ev.*, s.session_date, s.tutor, t.filename FROM exercise_evidence ev
       LEFT JOIN tutoring_sessions s ON s.id = ev.session_id LEFT JOIN transcripts t ON t.id = ev.transcript_id
       WHERE ev.exercise_id = ? ORDER BY ev.created_at DESC`
    )
    .all(id);
}

export function addManualEvidence(id, { category, note, session_id }, actor) {
  getExercise(id);
  const now = nowIso();
  const info = db()
    .prepare(
      `INSERT INTO exercise_evidence (exercise_id, transcript_id, session_id, match_id, source, category, snippet, timecode, note, approved_by, created_at, updated_at)
       VALUES (?, NULL, ?, NULL, 'manual', ?, NULL, NULL, ?, ?, ?, ?)`
    )
    .run(id, session_id || null, category, note, actor || 'user', now, now);
  db().prepare('UPDATE exercise_progress SET coverage_confirmed = 1, updated_at = ? WHERE exercise_id = ?').run(now, id);
  audit('exercise_evidence', info.lastInsertRowid, 'create_manual', undefined, { exercise_id: id, category, note }, actor);
  return getExerciseEvidence(id);
}

// ───────────── Lessons & schedule ─────────────

export function getLesson(id) {
  const l = db()
    .prepare(
      `SELECT l.*, lp.status, lp.scheduled_date, lp.held_date, lp.tutor, lp.objectives, lp.homework_text, lp.notes, lp.updated_at,
              cc.title AS competency_title, d.name AS domain_name
       FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id
       JOIN core_competencies cc ON cc.id = l.competency_id JOIN learning_domains d ON d.id = l.domain_id WHERE l.id = ?`
    )
    .get(id);
  if (!l) throw notFound(`Lesson ${id}`);
  const exercises = exerciseRows('WHERE e.competency_id = ?', [l.competency_id]);
  const sessions = db()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM transcripts t WHERE t.session_id = s.id) AS transcript_count
       FROM tutoring_sessions s JOIN session_lessons sl ON sl.session_id = s.id WHERE sl.lesson_id = ? ORDER BY s.session_date DESC`
    )
    .all(id);
  const feedback = db().prepare('SELECT * FROM tutor_feedback WHERE lesson_id = ? ORDER BY feedback_date DESC').all(id);
  const homework = db().prepare('SELECT * FROM homework WHERE lesson_id = ? ORDER BY created_at DESC').all(id);
  const da = db().prepare('SELECT id FROM domain_assessments WHERE after_lesson_id = ?').get(id);
  return {
    ...l,
    planned_date: plannedDate(l, l),
    default_objectives: exercises.filter((e) => e.is_canonical).map((e) => e.description),
    exercises,
    sessions,
    feedback: feedback.map((f) => ({ ...f, exercise_ids: parseJson(f.exercise_ids_json, []) })),
    homework,
    mastery: computeMastery(l.competency_id),
    domain_assessment_after: da ? domainAssessmentStatus(da.id) : null,
  };
}

export function updateLessonProgress(id, patch, actor) {
  const before = db().prepare('SELECT * FROM lesson_progress WHERE lesson_id = ?').get(id);
  if (!before) throw notFound(`Lesson ${id}`);
  if (patch.status && !['planned', 'held', 'missed'].includes(patch.status)) throw new HttpError(400, 'Invalid lesson status');
  const fields = ['status', 'scheduled_date', 'held_date', 'tutor', 'objectives', 'homework_text', 'notes'];
  const next = {};
  fields.forEach((f) => (next[f] = patch[f] === undefined ? before[f] : patch[f] === '' ? null : patch[f]));
  if (next.status === 'held' && !next.held_date) next.held_date = todayIso();
  db()
    .prepare(
      `UPDATE lesson_progress SET status=?, scheduled_date=?, held_date=?, tutor=?, objectives=?, homework_text=?, notes=?, updated_at=? WHERE lesson_id=?`
    )
    .run(...fields.map((f) => next[f]), nowIso(), id);
  // A date typed in by the learner always wins over calendar sync from then on.
  if (patch.scheduled_date !== undefined && actor !== 'calendar-sync')
    db().prepare("UPDATE lesson_progress SET schedule_source = ?, scheduled_time = NULL WHERE lesson_id = ?").run(next.scheduled_date ? 'manual' : null, id);
  audit('lesson_progress', id, 'update', before, next, actor);
  return getLesson(id);
}

export function getSchedule() {
  const start = getSetting('programme_start_date');
  const lessons = db()
    .prepare(
      `SELECT l.*, lp.status, lp.scheduled_date, lp.scheduled_time, lp.schedule_source, lp.held_date, lp.tutor, cc.title AS competency_title, d.name AS domain_name,
        (SELECT COUNT(*) FROM session_lessons sl WHERE sl.lesson_id = l.id) AS session_count,
        (SELECT COUNT(*) FROM session_lessons sl JOIN transcripts t ON t.session_id = sl.session_id WHERE sl.lesson_id = l.id) AS transcript_count
       FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id JOIN core_competencies cc ON cc.id = l.competency_id
       JOIN learning_domains d ON d.id = l.domain_id ORDER BY l.number`
    )
    .all();
  const tree = new Map();
  exerciseRows().forEach((e) => {
    if (!tree.has(e.competency_id)) tree.set(e.competency_id, []);
    tree.get(e.competency_id).push(e);
  });
  const das = db().prepare('SELECT id, after_lesson_id FROM domain_assessments').all();
  const weeks = db().prepare('SELECT * FROM weeks ORDER BY week').all();
  return weeks.map((w) => ({
    ...w,
    lessons: lessons
      .filter((l) => l.week === w.week)
      .sort((a, b) => a.session_in_week - b.session_in_week)
      .map((l) => {
        const ex = tree.get(l.competency_id) || [];
        const canonical = ex.filter((e) => e.is_canonical);
        const da = das.find((x) => x.after_lesson_id === l.id);
        return {
          ...l,
          planned_date: plannedDate(l, l, start),
          exercises: ex,
          coverage: { covered: canonical.filter((e) => e.covered).length, total: canonical.length },
          mastery_state: computeMastery(l.competency_id).state,
          domain_assessment_after: da ? domainAssessmentStatus(da.id) : null,
        };
      }),
  }));
}

// ───────────── Dashboard statistics ─────────────

export function dashboardStats() {
  const today = todayIso();
  const tree = getCurriculumTree();
  const allComps = tree.domains.flatMap((d) => d.competencies);
  const canonical = allComps.flatMap((c) => c.exercises.filter((e) => e.is_canonical));
  const covered = canonical.filter((e) => e.covered).length;
  const statusCounts = Object.fromEntries(EXERCISE_STATUSES.map((s) => [s, canonical.filter((e) => e.status === s).length]));
  const mastered = allComps.filter((c) => c.mastery.state === 'passed').length;
  const masteryCounts = {};
  allComps.forEach((c) => (masteryCounts[c.mastery.state] = (masteryCounts[c.mastery.state] || 0) + 1));

  const schedule = getSchedule();
  const lessons = schedule.flatMap((w) => w.lessons);
  const lessonCounts = { planned: 0, held: 0, missed: 0 };
  lessons.forEach((l) => (lessonCounts[l.status] += 1));
  const nextLesson = lessons.find((l) => l.status === 'planned') || null;

  const overdue = [];
  lessons
    .filter((l) => l.status === 'planned' && l.planned_date && l.planned_date < today)
    .forEach((l) => overdue.push({ type: 'lesson', id: l.id, label: `Lesson ${l.number}: ${l.title} — mark held or missed`, due: l.planned_date }));
  db()
    .prepare("SELECT * FROM homework WHERE status = 'open' AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date")
    .all(today)
    .forEach((h) => overdue.push({ type: 'homework', id: h.id, label: h.description, due: h.due_date }));
  canonical
    .filter((e) => e.due_date && e.due_date < today && !e.covered)
    .forEach((e) => overdue.push({ type: 'exercise', id: e.id, label: `${e.id}: ${e.description}`, due: e.due_date }));
  tree.domains
    .map((d) => d.domain_assessment)
    .forEach((da) => {
      const l = lessons.find((x) => x.id === da.after_lesson_id);
      const due = da.scheduled_date || l?.planned_date;
      if (due && due < today && !da.attempts) overdue.push({ type: 'domain_assessment', id: da.id, label: `${da.id} domain assessment not attempted`, due });
    });

  const warnings = [];
  lessons
    .filter((l) => l.status === 'held' && l.transcript_count === 0)
    .forEach((l) => warnings.push({ type: 'missing_transcript', lesson_id: l.id, message: `Lesson ${l.number} (${l.title}) is marked held but has no transcript evidence.` }));
  db()
    .prepare(
      `SELECT s.id, s.session_date, s.title FROM tutoring_sessions s WHERE NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.session_id = s.id)`
    )
    .all()
    .forEach((s) => warnings.push({ type: 'session_without_transcript', session_id: s.id, message: `Session on ${s.session_date}${s.title ? ` (${s.title})` : ''} has no transcript.` }));
  const pending = db().prepare("SELECT COUNT(*) n FROM evidence_matches WHERE review_status = 'pending'").get().n;
  if (pending) warnings.push({ type: 'pending_review', message: `${pending} proposed transcript match(es) are awaiting your review.` });
  db()
    .prepare(
      `SELECT t.id, t.filename, s.session_date FROM transcripts t JOIN tutoring_sessions s ON s.id = t.session_id
       WHERE NOT EXISTS (SELECT 1 FROM transcript_analyses a WHERE a.transcript_id = t.id AND a.status = 'completed')`
    )
    .all()
    .forEach((t) => warnings.push({ type: 'unanalysed_transcript', transcript_id: t.id, message: `Transcript from ${t.session_date} has not been analysed yet.` }));

  const recentSessions = db()
    .prepare(
      `SELECT s.*, (SELECT group_concat(lesson_id) FROM session_lessons sl WHERE sl.session_id = s.id) AS lesson_ids,
        (SELECT COUNT(*) FROM transcripts t WHERE t.session_id = s.id) AS transcript_count
       FROM tutoring_sessions s ORDER BY s.session_date DESC, s.id DESC LIMIT 5`
    )
    .all();
  const recentAttempts = db()
    .prepare('SELECT * FROM assessment_attempts ORDER BY id DESC LIMIT 6')
    .all();

  return {
    today,
    programme: tree.programme,
    coverage: { covered, total: 96, percent: Math.round((covered / 96) * 1000) / 10, status_counts: statusCounts },
    mastery: { verified_passed: mastered, total: 24, percent: Math.round((mastered / 24) * 1000) / 10, state_counts: masteryCounts },
    lessons: { ...lessonCounts, total: lessons.length },
    next_lesson: nextLesson,
    domains: tree.domains.map((d) => ({
      id: d.id,
      name: d.name,
      coverage: d.coverage,
      mastered: d.mastered,
      competencies: d.competencies.map((c) => ({
        id: c.id,
        title: c.title,
        lesson_id: c.lesson_id,
        lesson_number: c.lesson_number,
        coverage: c.coverage,
        mastery_state: c.mastery.state,
        criteria: `${c.mastery.best_criteria_passed}/${c.mastery.mandatory_count}`,
      })),
      domain_assessment: d.domain_assessment,
    })),
    timeline: schedule.map((w) => ({
      week: w.week,
      lessons: w.lessons.map((l) => ({
        id: l.id,
        number: l.number,
        title: l.title,
        status: l.status,
        planned_date: l.planned_date,
        coverage: l.coverage,
        mastery_state: l.mastery_state,
        transcript_count: l.transcript_count,
        domain_assessment_after: l.domain_assessment_after ? l.domain_assessment_after.id : null,
      })),
    })),
    overdue,
    warnings,
    recent_sessions: recentSessions,
    recent_attempts: recentAttempts,
  };
}
