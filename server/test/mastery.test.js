import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, passAll } from './helpers.js';

const EX = ['D2-C2-E1', 'D2-C2-E2', 'D2-C2-E3', 'D2-C2-E4'];
const attempt = (results, extra = {}) => ({ rubric_id: 'RUB-D2-C2', assessor: 'Tutor', attempt_date: '2026-11-21', results, ...extra });

test('one assisted criterion fails the attempt; transcript-only evidence never counts', async () => {
  const { app } = await makeApp();
  const assisted = passAll(EX);
  assisted[2] = { ...assisted[2], independence: 'assisted' };
  const a1 = (await request(app).post('/api/assessments/attempts').send(attempt(assisted)).expect(201)).body;
  assert.equal(a1.overall_result, 'fail');
  assert.equal(a1.criteria_passed, 3);

  const transcriptOnly = passAll(EX);
  transcriptOnly[0] = { ...transcriptOnly[0], evidence_type: 'transcript_only' };
  const a2 = (await request(app).post('/api/assessments/attempts').send(attempt(transcriptOnly)).expect(201)).body;
  assert.equal(a2.overall_result, 'fail');
  assert.match(a2.results[0].not_counted_reason, /transcript alone/i);

  const noEvidence = passAll(EX, { evidence_text: '' });
  const a3 = (await request(app).post('/api/assessments/attempts').send(attempt(noEvidence)).expect(201)).body;
  assert.equal(a3.overall_result, 'fail');

  const missing = (await request(app).post('/api/assessments/attempts').send(attempt(passAll(EX.slice(0, 3)))).expect(201)).body;
  assert.equal(missing.overall_result, 'fail', 'a mandatory criterion that was not recorded fails the attempt');

  const m = (await request(app).get('/api/assessments/mastery/D2-C2')).body;
  assert.equal(m.state, 'needs_practice');
  assert.equal(m.mastered_percent, null);
  assert.equal(m.best_criteria_passed, 4, 'partial progress is tracked separately');

  await request(app)
    .post('/api/assessments/verify')
    .send({ competency_id: 'D2-C2', attempt_id: a1.id, verifier: 'Tutor', verifier_role: 'tutor', evidence_summary: 'x' })
    .expect(409);
});

test('full pass + explicit verification → 100% mastered; reassessment and retake preserve history', async () => {
  const { app } = await makeApp();
  const pass = (await request(app).post('/api/assessments/attempts').send(attempt(passAll(EX), { github_links: 'https://github.com/example/pr/1' })).expect(201)).body;
  assert.equal(pass.overall_result, 'pass');

  let m = (await request(app).get('/api/assessments/mastery/D2-C2')).body;
  assert.equal(m.state, 'in_progress', 'passing is not mastery until verified');
  assert.equal(m.awaiting_verification, true);
  assert.equal(m.mastered_percent, null);

  await request(app)
    .post('/api/assessments/verify')
    .send({ competency_id: 'D2-C2', attempt_id: pass.id, verifier: 'Tutor', verifier_role: 'tutor', evidence_summary: '' })
    .expect(400);
  m = (
    await request(app)
      .post('/api/assessments/verify')
      .send({ competency_id: 'D2-C2', attempt_id: pass.id, verifier: 'Tutor', verifier_role: 'tutor', evidence_summary: 'Watched clone/push/pull/fetch live' })
      .expect(200)
  ).body;
  assert.equal(m.state, 'passed');
  assert.equal(m.mastered_percent, 100);
  assert.equal(m.verification.attempt_id, pass.id);
  assert.equal((await request(app).get('/api/dashboard/stats')).body.mastery.verified_passed, 1);

  // Reassessment keeps the old verification but marks it superseded.
  m = (await request(app).post('/api/assessments/reassess').send({ competency_id: 'D2-C2', reason: 'Refresher' }).expect(200)).body;
  assert.equal(m.state, 'reassessment_required');
  assert.equal(m.verification_history.length, 1);
  assert.ok(m.verification_history[0].superseded_at);

  // Retake: fail then pass, verify again.
  const fail = passAll(EX);
  fail[1] = { ...fail[1], result: 'fail' };
  await request(app).post('/api/assessments/attempts').send(attempt(fail)).expect(201);
  assert.equal((await request(app).get('/api/assessments/mastery/D2-C2')).body.state, 'needs_practice');
  const retake = (await request(app).post('/api/assessments/attempts').send(attempt(passAll(EX))).expect(201)).body;
  assert.equal(retake.attempt_number, 3);
  m = (
    await request(app)
      .post('/api/assessments/verify')
      .send({ competency_id: 'D2-C2', attempt_id: retake.id, verifier: 'Learner', verifier_role: 'learner', evidence_summary: 'Retake passed' })
      .expect(200)
  ).body;
  assert.equal(m.state, 'passed');
  assert.equal(m.verification_history.length, 2);
  assert.equal(m.attempts, 3);

  // Adding a new mandatory criterion means the old verification no longer covers the rubric.
  await request(app).post('/api/assessments/rubric/RUB-D2-C2/criteria').send({ text: 'Explain fetch vs pull', mandatory: true }).expect(201);
  m = (await request(app).get('/api/assessments/mastery/D2-C2')).body;
  assert.equal(m.state, 'reassessment_required');
  assert.equal(m.mastered_percent, null);
});

test('domain assessments are tracked separately from competency mastery', async () => {
  const { app } = await makeApp();
  const rubric = (await request(app).get('/api/assessments/rubric/RUB-DA-D2')).body;
  const results = rubric.criteria.map((c) => ({ criterion_id: c.id, result: 'pass', independence: 'independent', evidence_type: 'commit_or_pr', evidence_url: 'https://github.com/example/pull/2' }));
  const a = (await request(app).post('/api/assessments/attempts').send({ rubric_id: 'RUB-DA-D2', assessor: 'Tutor', attempt_date: '2026-11-22', results }).expect(201)).body;
  assert.equal(a.kind, 'domain');
  assert.equal(a.overall_result, 'pass');
  const overview = (await request(app).get('/api/assessments')).body;
  assert.equal(overview.domain_assessments.find((d) => d.id === 'DA-D2').ever_passed, true);
  assert.equal(overview.competencies.filter((c) => c.mastery.state === 'passed').length, 0);
});
