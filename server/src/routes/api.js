import express from 'express';
import { z, parse, isoDate, optDate, lessonId, exerciseId, competencyId, actorOf } from './validate.js';
import { getMode } from '../db/connection.js';
import { curriculumCountsFromDb } from '../db/seed.js';
import { listAudit, getSettings, EXERCISE_STATUSES, HttpError } from '../services/common.js';
import * as progress from '../services/progress.js';
import * as transcripts from '../services/transcripts.js';
import * as analysis from '../services/analysis.js';
import * as assessments from '../services/assessments.js';
import * as feedback from '../services/feedback.js';
import * as briefing from '../services/briefing.js';
import * as chat from '../services/chat.js';
import * as data from '../services/data.js';
import { aiStatus } from '../services/aiClient.js';
import { suggestLessons } from '../services/ruleAnalyzer.js';
import { getDb } from '../db/connection.js';
import * as translation from '../services/translation.js';
import * as automation from '../services/automation.js';
import * as calendar from '../services/calendar.js';
import * as autoApply from '../services/autoApply.js';
import * as lessonReview from '../services/lessonReview.js';
import * as insights from '../services/insights.js';
import { notify } from '../services/hearsayMonitor.js';
import { creditStatus } from '../services/credit.js';

export const api = express.Router();
const id = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id');
  return n;
};

// ───────── Health / meta ─────────
api.get('/health', (req, res) => res.json({ ok: true, mode: getMode(), counts: curriculumCountsFromDb(), ai: aiStatus() }));
api.get('/audit', (req, res) => res.json(listAudit({ entityType: req.query.entity_type, entityId: req.query.entity_id, limit: req.query.limit })));

// ───────── Curriculum ─────────
api.get('/curriculum', (req, res) => res.json(progress.getCurriculumTree()));
api.get('/exercises/:exerciseId', (req, res) => res.json({ ...progress.getExercise(req.params.exerciseId), evidence: progress.getExerciseEvidence(req.params.exerciseId) }));
api.patch('/exercises/:exerciseId/progress', (req, res) => {
  const body = parse(
    z.object({ status: z.enum(EXERCISE_STATUSES).optional(), coverage_confirmed: z.boolean().optional(), notes: z.string().max(10000).nullable().optional(), due_date: optDate }),
    req.body
  );
  res.json(progress.updateExerciseProgress(req.params.exerciseId, body, actorOf(req)));
});
api.post('/exercises', (req, res) => {
  const body = parse(z.object({ competency_id: competencyId, description: z.string().trim().min(3).max(500) }), req.body);
  res.status(201).json(progress.addCustomExercise(body, actorOf(req)));
});
api.patch('/exercises/:exerciseId', (req, res) => {
  const body = parse(z.object({ description: z.string().trim().min(3).max(500) }), req.body);
  res.json(progress.updateCustomExercise(req.params.exerciseId, body, actorOf(req)));
});
api.delete('/exercises/:exerciseId', (req, res) => {
  progress.deleteCustomExercise(req.params.exerciseId, actorOf(req));
  res.status(204).end();
});
api.post('/competencies/:competencyId/reorder', (req, res) => {
  const body = parse(z.object({ ordered_ids: z.array(exerciseId).min(1) }), req.body);
  res.json(progress.reorderExercises(req.params.competencyId, body.ordered_ids, actorOf(req)));
});
api.post('/exercises/:exerciseId/evidence', (req, res) => {
  const body = parse(
    z.object({ category: z.enum(['discussed', 'demonstrated', 'independently_completed']), note: z.string().trim().min(3).max(4000), session_id: z.number().int().positive().nullable().optional() }),
    req.body
  );
  res.status(201).json(progress.addManualEvidence(req.params.exerciseId, body, actorOf(req)));
});

// ───────── Schedule / lessons ─────────
api.get('/schedule', (req, res) => res.json(progress.getSchedule()));
api.get('/lessons/:lessonId', (req, res) => res.json(progress.getLesson(req.params.lessonId)));
api.patch('/lessons/:lessonId/progress', (req, res) => {
  const body = parse(
    z.object({
      status: z.enum(['planned', 'held', 'missed']).optional(),
      scheduled_date: optDate,
      held_date: optDate,
      tutor: z.string().max(120).nullable().optional(),
      objectives: z.string().max(10000).nullable().optional(),
      homework_text: z.string().max(10000).nullable().optional(),
      notes: z.string().max(20000).nullable().optional(),
    }),
    req.body
  );
  const updated = progress.updateLessonProgress(req.params.lessonId, body, actorOf(req));
  // Once a lesson is held, score its objectives from the transcript (in the background, if not scored yet).
  if (body.status === 'held' && aiStatus().available && !lessonReview.getLessonReview(req.params.lessonId) && updated.sessions?.length)
    lessonReview.runLessonReview(req.params.lessonId, 'auto').catch((err) => console.error('[lesson review]', err.message));
  res.json(updated);
});
api.patch('/domain-assessments/:daId', (req, res) => {
  const body = parse(z.object({ scheduled_date: optDate }), req.body);
  getDb().prepare('UPDATE domain_assessments SET scheduled_date = ? WHERE id = ?').run(body.scheduled_date || null, req.params.daId);
  res.json(assessments.domainAssessmentStatus(req.params.daId));
});

// ───────── Sessions & transcripts ─────────
const sessionSchema = z.object({
  session_date: isoDate,
  duration_minutes: z.number().int().min(1).max(600).nullable().optional(),
  tutor: z.string().max(120).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  speaker_notes: z.string().max(20000).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  lesson_ids: z.array(lessonId).max(4).optional(),
});
api.get('/sessions', (req, res) => res.json(transcripts.listSessions()));
api.post('/sessions', (req, res) => res.status(201).json(transcripts.createSession(parse(sessionSchema, req.body), actorOf(req))));
api.get('/sessions/:id', (req, res) => res.json(transcripts.getSession(id(req))));
api.patch('/sessions/:id', (req, res) => res.json(transcripts.updateSession(id(req), parse(sessionSchema.partial(), req.body), actorOf(req))));
api.delete('/sessions/:id', (req, res) => {
  transcripts.deleteSession(id(req), actorOf(req));
  res.status(204).end();
});

const transcriptSchema = z.object({
  text: z.string().min(1),
  filename: z.string().max(200).nullable().optional(),
  session_id: z.number().int().positive().optional(),
  session: sessionSchema.optional(),
});
api.post('/transcripts', (req, res) => {
  const body = parse(transcriptSchema, req.body);
  transcripts.validateTranscriptText(body.text);
  transcripts.detectFormat(body.filename, body.text);
  if (!body.session_id && !body.session) throw new HttpError(400, 'Provide session_id or session details');
  const actor = actorOf(req);
  // Check duplicates before creating a new session so a rejected import leaves nothing behind.
  const dup = getDb().prepare('SELECT id, session_id FROM transcripts WHERE checksum = ?').get(transcripts.checksumOf(body.text));
  if (dup) throw new HttpError(409, `This transcript was already imported (transcript #${dup.id}, session #${dup.session_id}).`, { transcript_id: dup.id, session_id: dup.session_id });
  const sessionId = body.session_id || transcripts.createSession(body.session, actor).id;
  res.status(201).json(transcripts.addTranscript({ session_id: sessionId, text: body.text, filename: body.filename }, actor));
});
api.post('/transcripts/suggest-lessons', (req, res) => {
  const body = parse(z.object({ text: z.string().min(1), filename: z.string().max(200).nullable().optional() }), req.body);
  transcripts.validateTranscriptText(body.text);
  const segments = transcripts.parseTranscript(body.text, transcripts.detectFormat(body.filename, body.text));
  const exercises = getDb().prepare('SELECT id, competency_id, description, is_canonical FROM practical_exercises').all();
  const lessons = getDb().prepare('SELECT * FROM lessons').all();
  res.json({ segments: segments.length, suggestions: suggestLessons({ segments, exercises, lessons }) });
});
api.get('/transcripts/:id', (req, res) => res.json(transcripts.getTranscript(id(req))));
api.delete('/transcripts/:id', (req, res) => {
  transcripts.deleteTranscript(id(req), actorOf(req));
  res.status(204).end();
});
api.get('/transcripts/:id/cost-estimate', (req, res) => res.json(analysis.analysisCostEstimate(id(req))));
api.post('/transcripts/:id/analyse', async (req, res) => {
  const body = parse(z.object({ method: z.enum(['rule_based', 'claude']).default('rule_based') }), req.body);
  res.status(201).json(await analysis.runAnalysis(id(req), body.method, actorOf(req)));
});
api.get('/transcripts/:id/translation-estimate', (req, res) => res.json(translation.translationEstimate(id(req))));
api.post('/transcripts/:id/translate', async (req, res) => {
  const tid = id(req);
  const result = await translation.translateTranscript(tid, actorOf(req));
  // Matching ran on the untranslated text; re-run the free rule-based pass on the English.
  const a = parse(z.object({ reanalyse: z.boolean().default(true) }), req.body || {}).reanalyse ? await analysis.runAnalysis(tid, 'rule_based', actorOf(req)) : null;
  res.json({ ...result, analysis_id: a?.id ?? null });
});
api.get('/insights/:lessonId', (req, res) => res.json(insights.getInsights(parse(lessonId, req.params.lessonId))));
api.post('/insights/:lessonId/review', async (req, res) => res.status(201).json(await insights.runLessonBrief(parse(lessonId, req.params.lessonId))));
api.post('/insights/:lessonId/format', async (req, res) => res.status(201).json(await insights.runLessonFormat(parse(lessonId, req.params.lessonId))));
api.get('/lessons/:lessonId/review', (req, res) => res.json(lessonReview.getLessonReview(parse(lessonId, req.params.lessonId))));
api.post('/lessons/:lessonId/review', async (req, res) => res.status(201).json(await lessonReview.runLessonReview(parse(lessonId, req.params.lessonId), actorOf(req))));
api.get('/transcripts/:id/auto-applied', (req, res) => res.json(autoApply.getAutoApplied(id(req))));
api.post('/transcripts/:id/auto-apply/undo', (req, res) => res.json(autoApply.undoAutoApply(id(req), actorOf(req))));
// Apply the latest Claude analysis of a transcript now (e.g. a lesson imported before auto-apply was switched on).
api.post('/transcripts/:id/auto-apply', (req, res) => {
  const tid = id(req);
  const latest = getDb().prepare("SELECT id FROM transcript_analyses WHERE transcript_id = ? AND method = 'claude' AND status = 'completed' ORDER BY version DESC LIMIT 1").get(tid);
  if (!latest) throw new HttpError(400, 'This transcript has no completed Claude analysis to apply.');
  res.json(autoApply.autoApplyAnalysis(latest.id));
});
api.get('/analyses/:id', (req, res) => res.json(analysis.getAnalysis(id(req))));

// ───────── Automation (folder watcher, calendar, Hearsay) ─────────
api.get('/automation/status', (req, res) => res.json(automation.automationStatus()));
api.post('/automation/scan', async (req, res) => res.json(await automation.scanFolder()));
api.post('/automation/calendar/sync', async (req, res) => res.json(await calendar.syncCalendar({ actor: actorOf(req) })));
api.post('/automation/files/:id/import', async (req, res) => {
  const body = parse(z.object({ lesson_id: lessonId.nullable().optional() }), req.body || {});
  res.status(201).json(await automation.importWatchedFile(id(req), { lesson_id: body.lesson_id || null, actor: actorOf(req) }));
});
api.post('/automation/files/:id/ignore', (req, res) => res.json(automation.ignoreWatchedFile(id(req), actorOf(req))));
api.post('/automation/test-notification', (req, res) => {
  notify('Learning Studio test', 'Notifications are working. You will be reminded to start Hearsay before each lesson.');
  res.json({ ok: true });
});
api.get('/review/pending', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.analysis_id FROM evidence_matches m WHERE m.review_status = 'pending' ORDER BY m.analysis_id DESC, m.exercise_id`
    )
    .all();
  const analysisIds = [...new Set(rows.map((r) => r.analysis_id))];
  const source = getDb().prepare(
    `SELECT t.id AS transcript_id, t.filename, t.segment_count, t.language, t.translation_status, s.id AS session_id, s.title AS session_title,
            s.session_date, s.duration_minutes, s.tutor, (SELECT group_concat(lesson_id) FROM session_lessons sl WHERE sl.session_id = s.id) AS lesson_ids,
            EXISTS (SELECT 1 FROM watched_files w WHERE w.transcript_id = t.id) AS auto_imported
     FROM transcripts t JOIN tutoring_sessions s ON s.id = t.session_id WHERE t.id = ?`
  );
  // Claude's analysis first: it is the more accurate set when both exist.
  const list = analysisIds.map((a) => {
    const an = analysis.getAnalysis(a);
    return { ...an, source: source.get(an.transcript_id) || null };
  });
  list.sort((a, b) => (b.source?.session_date || '').localeCompare(a.source?.session_date || '') || (a.method === 'claude' ? -1 : 1) - (b.method === 'claude' ? -1 : 1));
  res.json(list);
});
const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'adjust']),
  final_category: z.enum(['discussed', 'demonstrated', 'independently_completed']).optional(),
  exercise_id: exerciseId.optional(),
  note: z.string().max(4000).optional(),
});
api.post('/matches/:id/decision', (req, res) => {
  const body = parse(decisionSchema, req.body);
  res.json(analysis.decideMatch(id(req), { ...body, reviewer: actorOf(req) }));
});
api.post('/matches/decisions', (req, res) => {
  const body = parse(z.object({ decisions: z.array(decisionSchema.extend({ match_id: z.number().int().positive() })).min(1).max(200) }), req.body);
  const results = body.decisions.map((d) => {
    try {
      return { match_id: d.match_id, ok: true, ...analysis.decideMatch(d.match_id, { ...d, reviewer: actorOf(req) }) };
    } catch (err) {
      return { match_id: d.match_id, ok: false, error: err.message };
    }
  });
  res.json({ results });
});

// ───────── Assessments ─────────
api.get('/assessments', (req, res) => res.json(assessments.assessmentOverview()));
api.get('/assessments/rubric/:rubricId', (req, res) => res.json(assessments.getRubric(req.params.rubricId)));
api.get('/assessments/mastery/:competencyId', (req, res) => res.json(assessments.computeMastery(req.params.competencyId)));
api.patch('/assessments/criteria/:criterionId', (req, res) => {
  const body = parse(z.object({ text: z.string().trim().min(3).max(1000).optional(), mandatory: z.boolean().optional(), active: z.boolean().optional() }), req.body);
  res.json(assessments.updateCriterion(req.params.criterionId, body, actorOf(req)));
});
api.post('/assessments/rubric/:rubricId/criteria', (req, res) => {
  const body = parse(z.object({ text: z.string().trim().min(3).max(1000), mandatory: z.boolean().default(true) }), req.body);
  res.status(201).json(assessments.addCriterion(req.params.rubricId, body, actorOf(req)));
});
api.get('/assessments/attempts', (req, res) => res.json(assessments.listAttempts({ rubricId: req.query.rubric_id, competencyId: req.query.competency_id })));
api.get('/assessments/attempts/:id', (req, res) => res.json(assessments.getAttempt(id(req))));
api.post('/assessments/attempts', (req, res) => {
  const body = parse(
    z.object({
      rubric_id: z.string().min(3),
      kind: z.enum(['competency', 'domain', 'skill_check']).optional(),
      assessor: z.string().trim().min(1).max(120),
      attempt_date: isoDate,
      feedback: z.string().max(10000).optional(),
      retry_plan: z.string().max(10000).optional(),
      github_links: z.string().max(4000).optional(),
      ai_suggested: z.boolean().optional(),
      results: z
        .array(
          z.object({
            criterion_id: z.string().min(3),
            result: z.enum(['pass', 'fail', 'not_observed']),
            independence: z.enum(['independent', 'assisted']),
            evidence_type: z.enum(['observed_live', 'artifact_url', 'commit_or_pr', 'screen_recording', 'transcript_only', 'other']),
            evidence_text: z.string().max(4000).optional(),
            evidence_url: z.string().max(2000).optional(),
          })
        )
        .min(1),
    }),
    req.body
  );
  res.status(201).json(assessments.recordAttempt(body));
});
api.post('/assessments/verify', (req, res) => {
  const body = parse(
    z.object({ competency_id: competencyId, attempt_id: z.number().int().positive(), verifier: z.string().trim().min(1).max(120), verifier_role: z.enum(['learner', 'tutor']), evidence_summary: z.string().max(4000) }),
    req.body
  );
  res.json(assessments.verifyCompetency(body));
});
api.post('/assessments/reassess', (req, res) => {
  const body = parse(z.object({ competency_id: competencyId, reason: z.string().max(2000).optional() }), req.body);
  res.json(assessments.requestReassessment({ ...body, actor: actorOf(req) }));
});

// ───────── Feedback & homework ─────────
const feedbackSchema = z.object({
  session_id: z.number().int().positive().nullable().optional(),
  lesson_id: lessonId.nullable().optional(),
  feedback_date: isoDate,
  author: z.string().max(120).nullable().optional(),
  strengths: z.string().max(10000).nullable().optional(),
  weaknesses: z.string().max(10000).nullable().optional(),
  misunderstandings: z.string().max(10000).nullable().optional(),
  corrections: z.string().max(10000).nullable().optional(),
  confidence: z.number().int().min(1).max(5).nullable().optional(),
  practiced: z.string().max(10000).nullable().optional(),
  homework: z.string().max(10000).nullable().optional(),
  next_priorities: z.string().max(10000).nullable().optional(),
  tutor_questions: z.string().max(10000).nullable().optional(),
  analysis: z.string().max(20000).nullable().optional(),
  exercise_ids: z.array(exerciseId).max(96).optional(),
  homework_items: z.array(z.object({ description: z.string().min(1).max(2000), due_date: optDate, exercise_ids: z.array(exerciseId).optional() })).optional(),
});
api.get('/feedback', (req, res) => res.json(feedback.listFeedback()));
api.get('/feedback/:id', (req, res) => res.json(feedback.getFeedback(id(req))));
api.post('/feedback', (req, res) => res.status(201).json(feedback.createFeedback(parse(feedbackSchema, req.body), actorOf(req))));
api.patch('/feedback/:id', (req, res) => res.json(feedback.updateFeedback(id(req), parse(feedbackSchema.partial().omit({ homework_items: true }), req.body), actorOf(req))));
api.delete('/feedback/:id', (req, res) => {
  feedback.deleteFeedback(id(req), actorOf(req));
  res.status(204).end();
});
const homeworkSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  due_date: optDate,
  lesson_id: lessonId.nullable().optional(),
  session_id: z.number().int().positive().nullable().optional(),
  exercise_ids: z.array(exerciseId).optional(),
});
api.get('/homework', (req, res) => res.json(feedback.listHomework()));
api.post('/homework', (req, res) => res.status(201).json(feedback.createHomework(parse(homeworkSchema, req.body), actorOf(req))));
api.post('/homework/:id/submit', (req, res) => {
  const body = parse(z.object({ url: z.string().trim().max(2000).optional(), note: z.string().max(4000).optional() }), req.body || {});
  res.json(feedback.submitHomework(id(req), body, actorOf(req)));
});
api.post('/homework/:id/review', (req, res) => {
  const body = parse(z.object({ verdict: z.enum(['approved', 'changes_requested']), method: z.enum(['loom', 'live', 'transcript']), note: z.string().max(4000).optional() }), req.body);
  const tutor = (getSettings().tutor_name || 'Tutor').trim();
  res.json(feedback.reviewHomework(id(req), { ...body, reviewer: tutor }, actorOf(req)));
});
api.patch('/homework/:id', (req, res) => {
  const body = parse(z.object({ description: z.string().trim().min(1).max(2000).optional(), due_date: optDate, status: z.enum(['open', 'done']).optional() }), req.body);
  res.json(feedback.updateHomework(id(req), body, actorOf(req)));
});
api.delete('/homework/:id', (req, res) => {
  feedback.deleteHomework(id(req), actorOf(req));
  res.status(204).end();
});

// ───────── Gaps, briefing, dashboard ─────────
api.get('/gaps', (req, res) => res.json(briefing.getGaps()));
api.get('/briefing', (req, res) => res.json(briefing.getBriefing(req.query.lesson_id ? parse(lessonId, req.query.lesson_id) : undefined)));
api.get('/dashboard/stats', (req, res) => res.json(progress.dashboardStats()));

// ───────── Assistant ─────────
api.get('/ai/status', (req, res) => res.json(aiStatus()));
api.get('/assistant/messages', (req, res) => res.json(chat.listMessages()));
api.delete('/assistant/messages', (req, res) => {
  chat.clearMessages();
  res.status(204).end();
});
api.post('/assistant/chat', async (req, res) => {
  const body = parse(z.object({ question: z.string().trim().min(1).max(4000) }), req.body);
  res.json(await chat.ask(body.question));
});

// ───────── Settings & data ─────────
api.get('/settings', (req, res) => res.json({ settings: getSettings(), ai: aiStatus(), mode: getMode(), credit: creditStatus() }));
api.get('/credit', (req, res) => res.json(creditStatus()));
api.patch('/settings', (req, res) => {
  const out = data.updateSettings(parse(z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])), req.body), actorOf(req));
  automation.refreshFolderWatch();
  res.json(out);
});
api.get('/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="learning-studio-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data.exportData());
});
api.post('/import', (req, res) => res.json(data.importData(req.body, actorOf(req))));
api.get('/backups', (req, res) => res.json(data.listBackupFiles()));
api.post('/backups', (req, res) => res.status(201).json(data.writeBackupFile()));
api.post('/backups/:name/restore', (req, res) => res.json(data.restoreBackupFile(req.params.name, actorOf(req))));
api.post('/data/retention/apply', (req, res) => res.json(data.applyRetention(actorOf(req))));
api.post('/data/transcripts/delete-all', (req, res) => {
  parse(z.object({ confirm: z.literal('DELETE ALL TRANSCRIPTS') }), req.body);
  res.json(data.deleteAllTranscripts(actorOf(req)));
});
api.post('/data/demo-mode', async (req, res) => {
  const body = parse(z.object({ enabled: z.boolean() }), req.body);
  res.json(await data.setDemoMode(body.enabled));
});
