import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp } from './helpers.js';
import { loadCurriculumFile, validateCurriculum } from '../src/db/curriculum.js';

test('seed file validates exactly: 6/24/96/12/24, 2 lessons per week, 60 minutes', () => {
  const { json } = loadCurriculumFile();
  const v = validateCurriculum(json);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.counts, { domains: 6, competencies: 24, exercises: 96, weeks: 12, lessons: 24 });
});

test('validator catches duplicate and dangling ids', () => {
  const { json } = loadCurriculumFile();
  const bad = structuredClone(json);
  bad.learning_domains[0].core_competencies[0].practical_exercises[1].id = 'D1-C1-E1';
  bad.lessons[0].competency_id = 'D9-C9';
  bad.weeks[0].lesson_2_id = 'L99';
  bad.lessons[1].duration_minutes = 90;
  const v = validateCurriculum(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('Duplicate id D1-C1-E1')));
  assert.ok(v.errors.some((e) => e.includes('missing competency D9-C9')));
  assert.ok(v.errors.some((e) => e.includes('missing lesson L99')));
  assert.ok(v.errors.some((e) => e.includes('60 minutes')));
});

test('database mirrors the curriculum and Week 3 → Lesson 6 shows exactly the GitHub exercises', async () => {
  const { app } = await makeApp();
  const health = await request(app).get('/api/health');
  assert.equal(health.body.counts.exercises, 96);
  assert.equal(health.body.counts.lessons, 24);
  assert.equal(health.body.counts.rubrics, 24);
  assert.equal(health.body.counts.domain_assessments, 6);

  const schedule = (await request(app).get('/api/schedule')).body;
  assert.equal(schedule.length, 12);
  schedule.forEach((w) => {
    assert.equal(w.lessons.length, 2);
    w.lessons.forEach((l) => assert.equal(l.duration_minutes, 60));
  });
  const week3 = schedule.find((w) => w.week === 3);
  const l6 = week3.lessons.find((l) => l.id === 'L06');
  assert.equal(l6.title, 'Remote repository operations');
  assert.deepEqual(
    l6.exercises.map((e) => e.description),
    [
      'Create public and private GitHub repositories.',
      'Clone a repository to the computer.',
      'Practise git push, git pull and git fetch.',
      'Inspect git remote -v and understand origin and authentication.',
    ]
  );

  const tree = (await request(app).get('/api/curriculum')).body;
  assert.equal(tree.domains.length, 6);
  tree.domains.forEach((d) => {
    assert.equal(d.competencies.length, 4);
    d.competencies.forEach((c) => assert.equal(c.exercises.length, 4));
  });

  // Domain assessments are scheduled after lessons 4, 8, 12, 16, 20, 24 (weeks 2, 4, …, 12).
  const overview = (await request(app).get('/api/assessments')).body;
  assert.deepEqual(overview.domain_assessments.map((d) => d.after_lesson_id), ['L04', 'L08', 'L12', 'L16', 'L20', 'L24']);
  assert.deepEqual(overview.domain_assessments.map((d) => d.week), [2, 4, 6, 8, 10, 12]);
  // Each competency rubric uses its four exercises as mandatory criteria.
  overview.competencies.forEach((c) => {
    assert.equal(c.rubric.criteria.length, 4);
    assert.ok(c.rubric.criteria.every((k) => k.mandatory === 1 && k.exercise_id));
  });
  // The Git assessment covers clone, push, pull, fetch, branching, PR and sharing.
  const git = overview.domain_assessments.find((d) => d.id === 'DA-D2').rubric.criteria.map((k) => k.text).join(' ');
  for (const word of ['clone', 'push', 'pull', 'fetch', 'branch', 'pull request', 'collaborator']) assert.match(git, new RegExp(word, 'i'));
  const d4 = overview.domain_assessments.find((d) => d.id === 'DA-D4').rubric.criteria.map((k) => k.text).join(' ');
  for (const word of ['CLAUDE.md', 'SKILL.md', 'subagent']) assert.ok(d4.includes(word));
});

test('custom exercises append without touching canonical rows or the 96 count', async () => {
  const { app } = await makeApp();
  const created = await request(app).post('/api/exercises').send({ competency_id: 'D2-C2', description: 'Use gh repo clone as an alternative' });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 'D2-C2-X1');
  const canonEdit = await request(app).patch('/api/exercises/D2-C2-E1').send({ description: 'changed' });
  assert.equal(canonEdit.status, 403);
  const stats = (await request(app).get('/api/dashboard/stats')).body;
  assert.equal(stats.coverage.total, 96);
  const reordered = await request(app).post('/api/competencies/D2-C2/reorder').send({ ordered_ids: ['D2-C2-X1', 'D2-C2-E1', 'D2-C2-E2', 'D2-C2-E3', 'D2-C2-E4'] });
  assert.equal(reordered.status, 200);
  assert.equal(reordered.body[0].id, 'D2-C2-X1');
});
