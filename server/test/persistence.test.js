import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, tempDbPath } from './helpers.js';
import { seedDatabase } from '../src/db/seed.js';
import { closeDb } from '../src/db/connection.js';

test('progress survives restarts and re-running the seed does not reset it', async () => {
  const dbPath = tempDbPath('persist');
  let { app } = await makeApp(dbPath);
  await request(app).patch('/api/exercises/D1-C1-E1/progress').send({ status: 'demonstrated', notes: 'Installed Prettier' }).expect(200);
  await request(app).patch('/api/lessons/L01/progress').send({ status: 'held', tutor: 'Sam' }).expect(200);
  await request(app).patch('/api/assessments/criteria/RC-D1-C1-E1').send({ text: 'Edited criterion text' }).expect(200);
  await request(app).post('/api/exercises').send({ competency_id: 'D1-C1', description: 'Custom: configure settings sync' }).expect(201);

  seedDatabase();
  seedDatabase();
  closeDb();

  ({ app } = await makeApp(dbPath)); // simulates closing and reopening the app
  const ex = (await request(app).get('/api/exercises/D1-C1-E1')).body;
  assert.equal(ex.status, 'demonstrated');
  assert.equal(ex.notes, 'Installed Prettier');
  assert.equal(ex.description, 'Install and configure VS Code and essential extensions.');
  const lesson = (await request(app).get('/api/lessons/L01')).body;
  assert.equal(lesson.status, 'held');
  assert.equal(lesson.tutor, 'Sam');
  const rubric = (await request(app).get('/api/assessments/rubric/RUB-D1-C1')).body;
  assert.equal(rubric.criteria.find((c) => c.id === 'RC-D1-C1-E1').text, 'Edited criterion text');
  const health = (await request(app).get('/api/health')).body;
  assert.equal(health.counts.exercises, 96);
  assert.equal(health.counts.custom_exercises, 1);

  const audit = (await request(app).get('/api/audit?entity_type=exercise_progress&entity_id=D1-C1-E1')).body;
  assert.ok(audit.length >= 1);
  assert.equal(audit.at(-1).before.status, 'not_started');
});

test('lesson held status is distinct from exercise coverage and mastery', async () => {
  const { app } = await makeApp();
  await request(app).patch('/api/lessons/L05/progress').send({ status: 'held' }).expect(200);
  const stats = (await request(app).get('/api/dashboard/stats')).body;
  assert.equal(stats.lessons.held, 1);
  assert.equal(stats.coverage.covered, 0);
  assert.equal(stats.mastery.verified_passed, 0);
  assert.ok(stats.warnings.some((w) => w.type === 'missing_transcript' && w.lesson_id === 'L05'));
});

test('input validation rejects bad payloads', async () => {
  const { app } = await makeApp();
  await request(app).patch('/api/exercises/D1-C1-E1/progress').send({ status: 'mastered' }).expect(400);
  await request(app).patch('/api/lessons/L01/progress').send({ scheduled_date: '23/11/2026' }).expect(400);
  await request(app).post('/api/sessions').send({ session_date: 'yesterday' }).expect(400);
  await request(app).patch('/api/settings').send({ ai_model: 'gpt-4; DROP TABLE' }).expect(400);
});
