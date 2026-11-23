import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, importFixture } from './helpers.js';
import { setAiClientForTests } from '../src/services/aiClient.js';

test('without an API key: AI reports unavailable, Claude analysis is refused, everything else works', async () => {
  const { app } = await makeApp();
  const status = (await request(app).get('/api/ai/status')).body;
  assert.equal(status.available, false);
  assert.equal(status.key_configured, false);
  assert.match(status.reason, /ANTHROPIC_API_KEY/);
  assert.ok(!JSON.stringify(status).includes('sk-'), 'no key material is ever returned');

  const { body } = await importFixture(request, app);
  const refused = await request(app).post(`/api/transcripts/${body.id}/analyse`).send({ method: 'claude' });
  assert.equal(refused.status, 503);
  await request(app).post(`/api/transcripts/${body.id}/analyse`).send({ method: 'rule_based' }).expect(201);

  const chat = (await request(app).post('/api/assistant/chat').send({ question: 'Have we demonstrated git fetch?' })).body;
  assert.equal(chat.mode, 'rule_based');
  assert.equal(chat.ai.available, false);
  assert.match(chat.content, /D2-C2-E3/);
  assert.match(chat.content, /No approved evidence/);

  await request(app).patch('/api/exercises/D2-C2-E1/progress').send({ status: 'discussed' }).expect(200);
  await request(app).post('/api/feedback').send({ feedback_date: '2026-11-21', next_priorities: 'fetch' }).expect(201);
});

test('with a (fake) Claude client: hallucinated quotes and unknown ids are dropped, citations validated', async () => {
  const { app } = await makeApp();
  await request(app).patch('/api/settings').send({ ai_enabled: 'true' }).expect(200);
  let calls = 0;
  setAiClientForTests({
    beta: {
      messages: {
        parse: async () => {
          calls += 1;
          return {
            stop_reason: 'end_turn',
            model: 'claude-opus-5-5',
            usage: { input_tokens: 1000, output_tokens: 200 },
            parsed_output: {
              findings: [
                { exercise_id: 'D2-C2-E2', category: 'demonstrated', confidence: 0.9, evidence_quote: 'git clone https://github.com/example/practice-site.git', segment_number: 5, guided_or_independent: 'guided', rationale: 'Clone executed' },
                { exercise_id: 'D2-C2-E3', category: 'demonstrated', confidence: 0.9, evidence_quote: 'I ran git fetch and it updated origin/main', segment_number: 19, guided_or_independent: 'guided', rationale: 'Hallucinated' },
                { exercise_id: 'D9-C9-E9', category: 'discussed', confidence: 0.5, evidence_quote: 'Welcome back', segment_number: 2, guided_or_independent: 'unclear', rationale: 'Bad id' },
              ],
              commands_executed: [{ text: 'git clone', segment_number: 5 }],
              commands_mentioned_only: [{ text: 'git fetch', segment_number: 19 }],
              difficulties: [],
              decisions: [],
              tutor_feedback: [],
              homework: [],
              unresolved_questions: [],
              topics: ['GitHub remotes'],
            },
          };
        },
        create: async () => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Fetch was not demonstrated [C1]. Made-up claim [C99].' }] }),
      },
    },
  });
  const status = (await request(app).get('/api/ai/status')).body;
  assert.equal(status.available, true);

  const { body } = await importFixture(request, app);
  const a = (await request(app).post(`/api/transcripts/${body.id}/analyse`).send({ method: 'claude' }).expect(201)).body;
  assert.equal(calls, 1);
  assert.equal(a.method, 'claude');
  assert.deepEqual(a.matches.map((m) => m.exercise_id), ['D2-C2-E2']);
  assert.ok(a.warnings.some((w) => /could not be found/.test(w)));
  assert.ok(a.warnings.some((w) => /unknown exercise id/.test(w)));
  assert.ok(a.gaps.some((g) => g.exercise_id === 'D2-C2-E3'));
  assert.equal((await request(app).get('/api/exercises/D2-C2-E2')).body.status, 'not_started', 'AI proposals still need approval');

  const chat = (await request(app).post('/api/assistant/chat').send({ question: 'Have we demonstrated git fetch?' })).body;
  assert.equal(chat.mode, 'claude');
  assert.match(chat.content, /\[C1\]/);
  assert.doesNotMatch(chat.content, /\[C99\]/);
  setAiClientForTests(null);
});
