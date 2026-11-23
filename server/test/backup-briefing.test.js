import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, importFixture, passAll } from './helpers.js';

test('export → wipe → import restores transcripts, evidence, feedback and assessments', async () => {
  const { app } = await makeApp();
  const { body: t } = await importFixture(request, app);
  const a = (await request(app).post(`/api/transcripts/${t.id}/analyse`).send({}).expect(201)).body;
  const clone = a.matches.find((m) => m.exercise_id === 'D2-C2-E2');
  await request(app).post(`/api/matches/${clone.id}/decision`).send({ decision: 'approve' }).expect(200);
  await request(app).post('/api/feedback').send({ feedback_date: '2026-11-21', strengths: 'Clean commits' }).expect(201);
  const att = (await request(app).post('/api/assessments/attempts').send({ rubric_id: 'RUB-D1-C1', assessor: 'T', attempt_date: '2026-11-21', results: passAll(['D1-C1-E1', 'D1-C1-E2', 'D1-C1-E3', 'D1-C1-E4']) })).body;
  await request(app).post('/api/assessments/verify').send({ competency_id: 'D1-C1', attempt_id: att.id, verifier: 'T', verifier_role: 'tutor', evidence_summary: 'ok' }).expect(200);

  const exported = (await request(app).get('/api/export').expect(200)).body;
  assert.equal(exported.format, 'vibe-coding-command-centre-backup');
  assert.match(exported.privacy_warning, /private/);
  assert.equal(exported.tables.transcripts.length, 1);

  await request(app).post('/api/data/transcripts/delete-all').send({ confirm: 'nope' }).expect(400);
  await request(app).post('/api/data/transcripts/delete-all').send({ confirm: 'DELETE ALL TRANSCRIPTS' }).expect(200);
  assert.equal((await request(app).get('/api/sessions')).body[0].transcript_count, 0);

  const imported = (await request(app).post('/api/import').send(exported).expect(200)).body;
  assert.equal(imported.imported.transcripts, 1);
  assert.equal((await request(app).get('/api/exercises/D2-C2-E2')).body.evidence.length, 1);
  assert.equal((await request(app).get('/api/assessments/mastery/D1-C1')).body.state, 'passed');
  assert.equal((await request(app).get('/api/feedback')).body.length, 1);
  const chat = (await request(app).post('/api/assistant/chat').send({ question: 'credential manager' })).body;
  assert.ok(chat.citations.length > 0, 'full-text index rebuilt after import');

  await request(app).post('/api/import').send({ format: 'something-else' }).expect(400);
  const file = (await request(app).post('/api/backups').expect(201)).body;
  assert.match(file.name, /^backup-real-/);
  assert.equal((await request(app).get('/api/backups')).body.length, 1);
});

test('adding tutor feedback and next steps updates the next-lesson briefing', async () => {
  const { app } = await makeApp();
  for (const l of ['L01', 'L02', 'L03', 'L04', 'L05']) await request(app).patch(`/api/lessons/${l}/progress`).send({ status: 'held' }).expect(200);
  let b = (await request(app).get('/api/briefing')).body;
  assert.equal(b.lesson.id, 'L06');
  assert.equal(b.tutor_priorities.length, 0);
  assert.ok(b.carry_over_gaps.length > 0, 'held lessons without evidence produce carry-over gaps');

  const fb = (
    await request(app)
      .post('/api/feedback')
      .send({ feedback_date: '2026-11-22', lesson_id: 'L05', next_priorities: 'Demonstrate git fetch vs git pull', weaknesses: 'Mixes up staging and committing', homework_items: [{ description: 'Practise git add/commit five times', due_date: '2026-11-25' }] })
      .expect(201)
  ).body;
  b = (await request(app).get('/api/briefing')).body;
  const prio = b.tutor_priorities.find((p) => p.field === 'Next priorities');
  assert.equal(prio.text, 'Demonstrate git fetch vs git pull');
  assert.equal(prio.citations[0].ref, `feedback:${fb.id}`);
  assert.equal(b.open_homework.length, 1);
  assert.ok(b.agenda.reduce((s, a) => s + a.minutes, 0) <= 60, 'agenda fits a 60-minute lesson');

  // Editing feedback keeps history.
  await request(app).patch(`/api/feedback/${fb.id}`).send({ next_priorities: 'Inspect git remote -v' }).expect(200);
  const hist = (await request(app).get(`/api/feedback/${fb.id}`)).body.history;
  assert.ok(hist.some((h) => h.action === 'update' && h.before.next_priorities === 'Demonstrate git fetch vs git pull'));
  b = (await request(app).get('/api/briefing')).body;
  assert.equal(b.tutor_priorities.find((p) => p.field === 'Next priorities').text, 'Inspect git remote -v');
});

test('demo mode uses a separate, clearly labelled database and never touches real records', async () => {
  const { app } = await makeApp();
  await request(app).patch('/api/exercises/D1-C1-E1/progress').send({ status: 'discussed' }).expect(200);
  const on = (await request(app).post('/api/data/demo-mode').send({ enabled: true }).expect(200)).body;
  assert.equal(on.mode, 'demo');
  const demoStats = (await request(app).get('/api/dashboard/stats')).body;
  assert.equal(demoStats.mastery.verified_passed, 1);
  assert.equal((await request(app).get('/api/health')).body.mode, 'demo');
  await request(app).post('/api/data/demo-mode').send({ enabled: false }).expect(200);
  const real = (await request(app).get('/api/dashboard/stats')).body;
  assert.equal(real.mastery.verified_passed, 0);
  assert.equal(real.coverage.covered, 1);
  assert.equal((await request(app).get('/api/sessions')).body.length, 0);
});
