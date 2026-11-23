import { getDb, nowIso, tx } from '../db/connection.js';
import { HttpError, notFound, audit, parseJson } from './common.js';

const db = () => getDb();

export function getRubric(rubricId) {
  const rubric = db().prepare('SELECT * FROM assessment_rubrics WHERE id = ?').get(rubricId);
  if (!rubric) throw notFound(`Rubric ${rubricId}`);
  const criteria = db()
    .prepare('SELECT * FROM assessment_criteria WHERE rubric_id = ? ORDER BY sort_order, id')
    .all(rubricId);
  return { ...rubric, criteria };
}

export function rubricIdForCompetency(competencyId) {
  return `RUB-${competencyId}`;
}

function mandatoryActive(criteria) {
  return criteria.filter((c) => c.active && c.mandatory);
}

/**
 * Decide whether one criterion result counts toward a pass. A conversation transcript alone can never
 * establish independent successful execution, and every passing criterion needs recorded evidence.
 */
export function evaluateCriterionResult(r) {
  if (r.result !== 'pass') return { counts: false, reason: r.result === 'fail' ? 'Failed' : 'Not observed' };
  if (r.independence !== 'independent') return { counts: false, reason: 'Completed with assistance' };
  if (r.evidence_type === 'transcript_only')
    return { counts: false, reason: 'A transcript alone cannot prove independent execution' };
  if (!(r.evidence_text && r.evidence_text.trim()) && !(r.evidence_url && r.evidence_url.trim()))
    return { counts: false, reason: 'No evidence recorded' };
  return { counts: true, reason: null };
}

/** Record an attempt. Overall pass requires every active mandatory criterion to count. */
export function recordAttempt(input) {
  const rubric = getRubric(input.rubric_id);
  const kind = input.kind || (rubric.scope === 'domain' ? 'domain' : 'competency');
  if (rubric.scope === 'domain' && kind !== 'domain') throw new HttpError(400, 'Domain rubrics take kind=domain');
  if (rubric.scope === 'competency' && kind === 'domain') throw new HttpError(400, 'Competency rubrics take kind competency or skill_check');

  const byId = new Map(rubric.criteria.map((c) => [c.id, c]));
  for (const r of input.results) {
    if (!byId.has(r.criterion_id)) throw new HttpError(400, `Criterion ${r.criterion_id} is not in rubric ${rubric.id}`);
  }
  const resultsById = new Map(input.results.map((r) => [r.criterion_id, r]));
  const mandatory = mandatoryActive(rubric.criteria);
  let passed = 0;
  for (const c of mandatory) {
    const r = resultsById.get(c.id);
    if (r && evaluateCriterionResult(r).counts) passed += 1;
  }
  const overall = mandatory.length > 0 && passed === mandatory.length ? 'pass' : 'fail';

  return tx((d) => {
    const n = d
      .prepare('SELECT COUNT(*) n FROM assessment_attempts WHERE rubric_id = ?')
      .get(rubric.id).n;
    const info = d
      .prepare(
        `INSERT INTO assessment_attempts (rubric_id, kind, competency_id, domain_assessment_id, attempt_number, assessor, attempt_date,
          overall_result, criteria_passed, criteria_mandatory, feedback, retry_plan, github_links, ai_suggested, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rubric.id,
        kind,
        rubric.competency_id,
        rubric.domain_assessment_id,
        n + 1,
        input.assessor,
        input.attempt_date,
        overall,
        passed,
        mandatory.length,
        input.feedback || null,
        input.retry_plan || null,
        input.github_links || null,
        input.ai_suggested ? 1 : 0,
        nowIso()
      );
    const attemptId = Number(info.lastInsertRowid);
    const ins = d.prepare(
      `INSERT INTO criterion_results (attempt_id, criterion_id, result, independence, evidence_type, evidence_text, evidence_url, counts_toward_pass, not_counted_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of input.results) {
      const ev = evaluateCriterionResult(r);
      ins.run(attemptId, r.criterion_id, r.result, r.independence, r.evidence_type, r.evidence_text || null, r.evidence_url || null, ev.counts ? 1 : 0, ev.reason);
    }
    audit('assessment_attempt', attemptId, 'create', undefined, { rubric_id: rubric.id, overall, passed, mandatory: mandatory.length }, input.assessor);
    return getAttempt(attemptId);
  });
}

export function getAttempt(id) {
  const a = db().prepare('SELECT * FROM assessment_attempts WHERE id = ?').get(id);
  if (!a) throw notFound(`Attempt ${id}`);
  const results = db()
    .prepare(
      `SELECT cr.*, ac.text AS criterion_text, ac.mandatory, ac.exercise_id
       FROM criterion_results cr JOIN assessment_criteria ac ON ac.id = cr.criterion_id
       WHERE cr.attempt_id = ? ORDER BY ac.sort_order`
    )
    .all(id);
  const verification = db()
    .prepare('SELECT * FROM competency_verifications WHERE attempt_id = ? ORDER BY id DESC')
    .all(id);
  return { ...a, results, verifications: verification };
}

export function listAttempts({ rubricId, competencyId } = {}) {
  let rows;
  if (rubricId) rows = db().prepare('SELECT id FROM assessment_attempts WHERE rubric_id = ? ORDER BY id DESC').all(rubricId);
  else if (competencyId)
    rows = db().prepare('SELECT id FROM assessment_attempts WHERE competency_id = ? ORDER BY id DESC').all(competencyId);
  else rows = db().prepare('SELECT id FROM assessment_attempts ORDER BY id DESC').all();
  return rows.map((r) => getAttempt(r.id));
}

/** Check that an attempt satisfies every *current* active mandatory criterion of its rubric. */
function attemptSatisfiesRubric(attemptId, rubric) {
  const results = db().prepare('SELECT * FROM criterion_results WHERE attempt_id = ?').all(attemptId);
  const counted = new Set(results.filter((r) => r.counts_toward_pass).map((r) => r.criterion_id));
  const mandatory = mandatoryActive(rubric.criteria);
  const missing = mandatory.filter((c) => !counted.has(c.id));
  return { ok: mandatory.length > 0 && missing.length === 0, missing };
}

/**
 * Mastery state for one competency. 100% mastery is only ever reported when an attempt passed every
 * mandatory criterion independently with evidence AND a human explicitly verified it.
 */
export function computeMastery(competencyId) {
  const rubric = getRubric(rubricIdForCompetency(competencyId));
  const mandatory = mandatoryActive(rubric.criteria);
  const attempts = db()
    .prepare('SELECT * FROM assessment_attempts WHERE rubric_id = ? ORDER BY id DESC')
    .all(rubric.id);
  const verifications = db()
    .prepare('SELECT * FROM competency_verifications WHERE competency_id = ? ORDER BY id DESC')
    .all(competencyId);
  const active = verifications.find((v) => !v.superseded_at);
  const latest = attempts[0] || null;

  // Best per-criterion progress across all attempts (partial progress, never "mastery").
  const counted = new Set(
    db()
      .prepare(
        `SELECT DISTINCT cr.criterion_id FROM criterion_results cr JOIN assessment_attempts a ON a.id = cr.attempt_id
         WHERE a.rubric_id = ? AND cr.counts_toward_pass = 1`
      )
      .all(rubric.id)
      .map((r) => r.criterion_id)
  );
  const bestPassed = mandatory.filter((c) => counted.has(c.id)).length;

  let state;
  let note = null;
  let awaitingVerification = false;
  let verifiableAttemptId = null;

  if (active) {
    const check = attemptSatisfiesRubric(active.attempt_id, rubric);
    if (check.ok) state = 'passed';
    else {
      state = 'reassessment_required';
      note = `Rubric changed after verification; not yet evidenced: ${check.missing.map((c) => c.id).join(', ')}`;
    }
  } else if (verifications.length && (!latest || latest.created_at <= verifications[0].superseded_at)) {
    state = 'reassessment_required';
    note = verifications[0].superseded_reason || 'Reassessment requested';
  } else if (!latest) {
    state = 'not_assessed';
  } else if (latest.overall_result === 'fail') {
    state = 'needs_practice';
  } else {
    state = 'in_progress';
  }

  // Latest passing attempt that still satisfies the current rubric can be verified.
  if (state !== 'passed') {
    for (const a of attempts) {
      if (a.overall_result === 'pass' && attemptSatisfiesRubric(a.id, rubric).ok) {
        verifiableAttemptId = a.id;
        break;
      }
    }
    if (verifiableAttemptId && (state === 'in_progress' || state === 'reassessment_required')) {
      awaitingVerification = latest && latest.id === verifiableAttemptId;
    }
  }

  return {
    competency_id: competencyId,
    state,
    note,
    mastered_percent: state === 'passed' ? 100 : null,
    mandatory_count: mandatory.length,
    latest_attempt: latest
      ? { id: latest.id, result: latest.overall_result, passed: latest.criteria_passed, mandatory: latest.criteria_mandatory, date: latest.attempt_date }
      : null,
    best_criteria_passed: bestPassed,
    attempts: attempts.length,
    awaiting_verification: awaitingVerification,
    verifiable_attempt_id: verifiableAttemptId,
    verification: active || null,
    verification_history: verifications,
  };
}

export function verifyCompetency({ competency_id, attempt_id, verifier, verifier_role, evidence_summary }) {
  const rubric = getRubric(rubricIdForCompetency(competency_id));
  const attempt = db().prepare('SELECT * FROM assessment_attempts WHERE id = ?').get(attempt_id);
  if (!attempt) throw notFound(`Attempt ${attempt_id}`);
  if (attempt.rubric_id !== rubric.id) throw new HttpError(400, 'Attempt does not belong to this competency');
  if (attempt.overall_result !== 'pass')
    throw new HttpError(409, 'Cannot verify: this attempt did not pass every mandatory criterion independently');
  const check = attemptSatisfiesRubric(attempt_id, rubric);
  if (!check.ok)
    throw new HttpError(409, `Cannot verify: criteria not independently evidenced: ${check.missing.map((c) => c.id).join(', ')}`);
  if (!evidence_summary || !evidence_summary.trim()) throw new HttpError(400, 'Evidence summary is required for verification');

  return tx((d) => {
    const now = nowIso();
    // A new verification supersedes (never deletes) earlier active ones.
    d.prepare(
      "UPDATE competency_verifications SET superseded_at = ?, superseded_reason = 'Superseded by newer verification' WHERE competency_id = ? AND superseded_at IS NULL"
    ).run(now, competency_id);
    const info = d
      .prepare(
        `INSERT INTO competency_verifications (competency_id, attempt_id, verifier, verifier_role, evidence_summary, verified_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(competency_id, attempt_id, verifier, verifier_role, evidence_summary.trim(), now);
    audit('competency_verification', info.lastInsertRowid, 'verify', undefined, { competency_id, attempt_id, verifier, verifier_role }, verifier);
    return computeMastery(competency_id);
  });
}

export function requestReassessment({ competency_id, reason, actor }) {
  return tx((d) => {
    const now = nowIso();
    const res = d
      .prepare('UPDATE competency_verifications SET superseded_at = ?, superseded_reason = ? WHERE competency_id = ? AND superseded_at IS NULL')
      .run(now, reason || 'Reassessment requested', competency_id);
    if (res.changes === 0) throw new HttpError(409, 'No active verification to reassess');
    audit('competency_verification', competency_id, 'reassessment_requested', undefined, { reason }, actor);
    return computeMastery(competency_id);
  });
}

export function updateCriterion(id, patch, actor) {
  const before = db().prepare('SELECT * FROM assessment_criteria WHERE id = ?').get(id);
  if (!before) throw notFound(`Criterion ${id}`);
  const next = {
    text: patch.text ?? before.text,
    mandatory: patch.mandatory === undefined ? before.mandatory : patch.mandatory ? 1 : 0,
    active: patch.active === undefined ? before.active : patch.active ? 1 : 0,
  };
  db()
    .prepare('UPDATE assessment_criteria SET text = ?, mandatory = ?, active = ?, updated_at = ? WHERE id = ?')
    .run(next.text, next.mandatory, next.active, nowIso(), id);
  audit('assessment_criterion', id, 'update', before, next, actor);
  return db().prepare('SELECT * FROM assessment_criteria WHERE id = ?').get(id);
}

export function addCriterion(rubricId, { text, mandatory = true }, actor) {
  getRubric(rubricId);
  const n = db().prepare('SELECT COUNT(*) n FROM assessment_criteria WHERE rubric_id = ? AND is_custom = 1').get(rubricId).n;
  const id = `${rubricId}-X${n + 1}`;
  const sort = db().prepare('SELECT COALESCE(MAX(sort_order),0)+1 s FROM assessment_criteria WHERE rubric_id = ?').get(rubricId).s;
  db()
    .prepare(
      `INSERT INTO assessment_criteria (id, rubric_id, exercise_id, seed_text, text, mandatory, active, is_custom, sort_order, updated_at)
       VALUES (?, ?, NULL, NULL, ?, ?, 1, 1, ?, ?)`
    )
    .run(id, rubricId, text, mandatory ? 1 : 0, sort, nowIso());
  audit('assessment_criterion', id, 'create', undefined, { text, mandatory }, actor);
  return db().prepare('SELECT * FROM assessment_criteria WHERE id = ?').get(id);
}

/** Domain assessment outcome — a separate concept from competency mastery. */
export function domainAssessmentStatus(daId) {
  const da = db().prepare('SELECT * FROM domain_assessments WHERE id = ?').get(daId);
  const latest = db()
    .prepare('SELECT * FROM assessment_attempts WHERE domain_assessment_id = ? ORDER BY id DESC LIMIT 1')
    .get(daId);
  const anyPass = db()
    .prepare("SELECT COUNT(*) n FROM assessment_attempts WHERE domain_assessment_id = ? AND overall_result='pass'")
    .get(daId).n;
  return {
    ...da,
    rubric_id: `RUB-${daId}`,
    attempts: db().prepare('SELECT COUNT(*) n FROM assessment_attempts WHERE domain_assessment_id = ?').get(daId).n,
    latest_result: latest ? latest.overall_result : null,
    latest_score: latest ? `${latest.criteria_passed}/${latest.criteria_mandatory}` : null,
    latest_date: latest ? latest.attempt_date : null,
    ever_passed: anyPass > 0,
  };
}

export function assessmentOverview() {
  const comps = db()
    .prepare(
      `SELECT cc.*, d.name AS domain_name, l.number AS lesson_number, l.week FROM core_competencies cc
       JOIN learning_domains d ON d.id = cc.domain_id JOIN lessons l ON l.id = cc.lesson_id ORDER BY cc.sort_order`
    )
    .all();
  const competencies = comps.map((cc) => ({
    ...cc,
    rubric: getRubric(rubricIdForCompetency(cc.id)),
    mastery: computeMastery(cc.id),
  }));
  const domainAssessments = db()
    .prepare('SELECT id FROM domain_assessments ORDER BY week')
    .all()
    .map((r) => ({ ...domainAssessmentStatus(r.id), rubric: getRubric(`RUB-${r.id}`) }));

  // Short skill checks: suggested after each held lesson whose competency has no attempt yet.
  const skillChecksDue = db()
    .prepare(
      `SELECT l.id lesson_id, l.number, l.title, l.competency_id, lp.held_date FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id
       WHERE lp.status = 'held' AND NOT EXISTS (SELECT 1 FROM assessment_attempts a WHERE a.competency_id = l.competency_id)
       ORDER BY l.number`
    )
    .all();
  return { competencies, domain_assessments: domainAssessments, skill_checks_due: skillChecksDue };
}

export { parseJson };
