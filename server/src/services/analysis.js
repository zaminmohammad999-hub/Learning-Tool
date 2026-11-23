import { getDb, nowIso, tx } from '../db/connection.js';
import { HttpError, notFound, audit, parseJson, getSetting, STATUS_RANK } from './common.js';
import { getTranscript, getSegments } from './transcripts.js';
import { analyseRuleBased } from './ruleAnalyzer.js';
import { EXERCISE_KEYWORDS } from './exerciseKeywords.js';
import { aiStatus, analyseChunkWithClaude, describeAiError, estimateCost } from './aiClient.js';

const db = () => getDb();
const CATEGORY_RANK = { uncertain: 0, discussed: 1, demonstrated: 2, independently_completed: 3 };

function allExercises() {
  return db().prepare('SELECT id, competency_id, description, is_canonical FROM practical_exercises ORDER BY id').all();
}

function focusCompetencies(sessionId) {
  return db()
    .prepare('SELECT l.competency_id FROM session_lessons sl JOIN lessons l ON l.id = sl.lesson_id WHERE sl.session_id = ?')
    .all(sessionId)
    .map((r) => r.competency_id);
}

const norm = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/** Split labelled segments into bounded chunks. Never silently truncates: too many chunks is an explicit error. */
export function chunkSegments(segments, maxChars) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const s of segments) {
    const line = `[#${s.seq}]${s.timecode ? ` (${s.timecode})` : ''} ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`;
    if (size + line.length > maxChars && cur.length) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push({ seg: s, line });
    size += line.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function facetsFor(exerciseId, texts) {
  const spec = EXERCISE_KEYWORDS[exerciseId];
  if (!spec?.facets) return { found: [], missing: [], negated: [], all: [] };
  const all = Object.keys(spec.facets);
  const found = all.filter((k) => texts.some((t) => spec.facets[k].test(t)));
  return { found, missing: all.filter((k) => !found.includes(k)), negated: [], all };
}

async function runClaude({ segments, exercises, focus }) {
  const maxChars = Number(getSetting('ai_max_chunk_chars', '24000'));
  const maxChunks = Number(getSetting('ai_max_chunks', '20'));
  const chunks = chunkSegments(segments, maxChars);
  if (chunks.length > maxChunks)
    throw new HttpError(
      413,
      `Transcript needs ${chunks.length} chunks but the limit is ${maxChunks}. Increase "max chunks" in Settings or split the transcript; nothing was truncated.`
    );
  const curriculumText = exercises.map((e) => `${e.id}: ${e.description}`).join('\n');
  const exIds = new Set(exercises.map((e) => e.id));
  const warnings = [];
  const findings = [];
  const extraction = { method: 'claude', commands_executed: [], commands_mentioned_only: [], difficulties: [], decisions: [], tutor_feedback: [], homework: [], unresolved_questions: [], topics: [] };
  const usage = { input_tokens: 0, output_tokens: 0, chunks: chunks.length };
  let model = null;

  for (const [ci, chunk] of chunks.entries()) {
    const segBySeq = new Map(chunk.map((c) => [c.seg.seq, c.seg]));
    const { data, usage: u, model: m } = await analyseChunkWithClaude({ chunkText: chunk.map((c) => c.line).join('\n'), curriculumText });
    model = m || model;
    if (u) {
      usage.input_tokens += u.input_tokens || 0;
      usage.output_tokens += u.output_tokens || 0;
    }
    // Output validation: unknown ids are dropped, and every quote must exist verbatim in the transcript.
    for (const f of data.findings) {
      if (!exIds.has(f.exercise_id)) {
        warnings.push(`Chunk ${ci + 1}: dropped finding for unknown exercise id "${f.exercise_id}".`);
        continue;
      }
      const q = norm(f.evidence_quote);
      let seg = segBySeq.get(f.segment_number);
      if (!seg || !q || !norm(seg.text).includes(q.slice(0, 200))) seg = chunk.map((c) => c.seg).find((s) => q && norm(s.text).includes(q.slice(0, 200)));
      if (!seg) {
        warnings.push(`Chunk ${ci + 1}: dropped ${f.exercise_id} finding — its quote could not be found in the transcript (possible hallucination).`);
        continue;
      }
      findings.push({ ...f, confidence: Math.max(0, Math.min(1, f.confidence)), seg });
    }
    for (const key of Object.keys(extraction)) {
      if (key === 'method') continue;
      if (key === 'topics') extraction.topics.push(...data.topics);
      else
        extraction[key].push(
          ...data[key].map((it) => {
            const seg = segBySeq.get(it.segment_number);
            return { text: it.text, seq: seg ? seg.seq : null, timecode: seg?.timecode || null, speaker: seg?.speaker || null };
          })
        );
    }
  }
  extraction.topics = [...new Set(extraction.topics)];

  // Reconcile across chunks: one proposal per exercise, strongest category, extra snippets kept for context.
  const byEx = new Map();
  findings.forEach((f) => {
    if (!byEx.has(f.exercise_id)) byEx.set(f.exercise_id, []);
    byEx.get(f.exercise_id).push(f);
  });
  const matches = [];
  for (const [exerciseId, list] of byEx) {
    list.sort((a, b) => CATEGORY_RANK[b.category] - CATEGORY_RANK[a.category] || b.confidence - a.confidence);
    const best = list[0];
    const supporting = list.filter((f) => f.category !== 'uncertain');
    const facets = facetsFor(exerciseId, supporting.map((f) => f.seg.text));
    let rationale = `${best.rationale} (guided/independent: ${best.guided_or_independent}; ${list.length} finding(s) across chunks.)`;
    if (facets.missing.length && best.category !== 'uncertain') rationale += ` Not evidenced: ${facets.missing.join(', ')}.`;
    matches.push({
      exercise_id: exerciseId,
      category: best.category,
      confidence: Math.round(best.confidence * 100) / 100,
      snippet: best.seg.text.slice(0, 400),
      segment_seq: best.seg.seq,
      start_char: best.seg.start_char,
      end_char: best.seg.end_char,
      timecode: best.seg.timecode,
      speaker: best.seg.speaker,
      rationale,
      facets,
      extra_snippets: list.slice(1, 4).map((f) => ({ seq: f.seg.seq, timecode: f.seg.timecode, speaker: f.seg.speaker, text: f.seg.text.slice(0, 240) })),
    });
  }
  const gaps = [];
  const positive = new Set(matches.filter((m) => m.category !== 'uncertain').map((m) => m.exercise_id));
  exercises
    .filter((e) => focus.includes(e.competency_id) && e.is_canonical)
    .forEach((e) => {
      if (!positive.has(e.id)) gaps.push({ exercise_id: e.id, facet: null, message: `${e.id} (${e.description}) — not evidenced in this transcript.` });
      else matches.find((m) => m.exercise_id === e.id).facets.missing.forEach((f) => gaps.push({ exercise_id: e.id, facet: f, message: `${f} — not evidenced in this transcript (part of ${e.id}).` }));
    });
  if (!focus.length) warnings.push('No lesson assigned to this session: lesson-specific gaps cannot be computed.');
  return { matches, gaps, extraction, warnings, usage, model };
}

export async function runAnalysis(transcriptId, method = 'rule_based', actor = 'user') {
  const t = getTranscript(transcriptId, { includeSegments: false });
  if (method === 'claude' && !aiStatus().available) throw new HttpError(503, `AI analysis unavailable: ${aiStatus().reason}`);
  const segments = getSegments(transcriptId);
  const exercises = allExercises();
  const focus = focusCompetencies(t.session_id);
  const version = db().prepare('SELECT COALESCE(MAX(version),0)+1 v FROM transcript_analyses WHERE transcript_id = ?').get(transcriptId).v;
  const analysisId = Number(
    db()
      .prepare('INSERT INTO transcript_analyses (transcript_id, version, method, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(transcriptId, version, method, method === 'claude' ? aiStatus().model : null, 'running', nowIso()).lastInsertRowid
  );

  let result;
  try {
    if (method === 'claude') result = await runClaude({ segments, exercises, focus });
    else
      result = {
        ...analyseRuleBased({
          segments,
          exercises,
          focusCompetencies: focus,
          tutorName: getSetting('tutor_name'),
          learnerName: getSetting('learner_name'),
        }),
        usage: null,
        model: null,
      };
  } catch (err) {
    const message = err instanceof HttpError ? err.message : describeAiError(err);
    db().prepare("UPDATE transcript_analyses SET status='failed', error=? WHERE id=?").run(message, analysisId);
    audit('transcript_analysis', analysisId, 'failed', undefined, { transcript_id: transcriptId, method, error: message }, actor);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, message);
  }

  tx((d) => {
    d.prepare(
      "UPDATE transcript_analyses SET status='completed', model=COALESCE(?, model), chunk_count=?, extraction_json=?, gaps_json=?, warnings_json=?, usage_json=? WHERE id=?"
    ).run(
      result.model,
      result.usage?.chunks ?? 1,
      JSON.stringify(result.extraction),
      JSON.stringify(result.gaps),
      JSON.stringify(result.warnings),
      result.usage ? JSON.stringify(result.usage) : null,
      analysisId
    );
    const ins = d.prepare(
      `INSERT INTO evidence_matches (analysis_id, transcript_id, exercise_id, category, confidence, snippet, segment_seq, start_char, end_char, timecode, speaker, rationale, facets_json, extra_snippets_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    result.matches.forEach((m) =>
      ins.run(analysisId, transcriptId, m.exercise_id, m.category, m.confidence, m.snippet, m.segment_seq, m.start_char, m.end_char, m.timecode, m.speaker, m.rationale, JSON.stringify(m.facets), JSON.stringify(m.extra_snippets))
    );
  });
  audit('transcript_analysis', analysisId, 'completed', undefined, { transcript_id: transcriptId, method, version, matches: result.matches.length }, actor);
  return getAnalysis(analysisId);
}

export function getAnalysis(id) {
  const a = db().prepare('SELECT * FROM transcript_analyses WHERE id = ?').get(id);
  if (!a) throw notFound(`Analysis ${id}`);
  const matches = db()
    .prepare(
      `SELECT m.*, e.description AS exercise_description, e.competency_id, p.status AS current_status,
        (SELECT ev.category FROM exercise_evidence ev WHERE ev.exercise_id = m.exercise_id AND ev.transcript_id = m.transcript_id) AS already_approved_category
       FROM evidence_matches m JOIN practical_exercises e ON e.id = m.exercise_id JOIN exercise_progress p ON p.exercise_id = m.exercise_id
       WHERE m.analysis_id = ? ORDER BY m.exercise_id`
    )
    .all(id)
    .map((m) => ({ ...m, facets: parseJson(m.facets_json, null), extra_snippets: parseJson(m.extra_snippets_json, []) }));
  return {
    ...a,
    extraction: parseJson(a.extraction_json, null),
    gaps: parseJson(a.gaps_json, []),
    warnings: parseJson(a.warnings_json, []),
    usage: parseJson(a.usage_json, null),
    matches,
  };
}

export function analysisCostEstimate(transcriptId) {
  const t = getTranscript(transcriptId, { includeSegments: false });
  const maxChars = Number(getSetting('ai_max_chunk_chars', '24000'));
  const chunks = Math.max(1, Math.ceil(t.char_count / maxChars));
  const curriculumChars = allExercises().reduce((s, e) => s + e.id.length + e.description.length + 3, 0);
  return { chunks, ...estimateCost(t.char_count + chunks * (curriculumChars + 2500), { outputTokens: chunks * 2500 }) };
}

/**
 * Human review of one proposed match. Nothing updates learning state without this explicit decision.
 * Approved evidence is upserted per (exercise, transcript) so re-analysis never double counts.
 */
export function decideMatch(matchId, { decision, final_category, exercise_id, reviewer, note }) {
  const m = db().prepare('SELECT * FROM evidence_matches WHERE id = ?').get(matchId);
  if (!m) throw notFound(`Match ${matchId}`);
  if (m.review_status !== 'pending') throw new HttpError(409, `Match already ${m.review_status}`);
  if (!['approve', 'reject', 'adjust'].includes(decision)) throw new HttpError(400, 'decision must be approve, reject or adjust');

  let category = m.category;
  let targetExercise = m.exercise_id;
  if (decision === 'approve' && m.category === 'uncertain')
    throw new HttpError(400, 'An "uncertain" match cannot be approved as-is; use Adjust and choose a category, or Reject.');
  if (decision === 'adjust') {
    if (!['discussed', 'demonstrated', 'independently_completed'].includes(final_category))
      throw new HttpError(400, 'Adjust requires final_category of discussed, demonstrated or independently_completed');
    category = final_category;
    if (exercise_id) {
      if (!db().prepare('SELECT 1 FROM practical_exercises WHERE id = ?').get(exercise_id)) throw new HttpError(400, `Unknown exercise ${exercise_id}`);
      targetExercise = exercise_id;
    }
  }

  return tx((d) => {
    const now = nowIso();
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'adjusted';
    d.prepare('UPDATE evidence_matches SET review_status=?, final_category=?, reviewed_at=?, reviewer=? WHERE id=?').run(
      status,
      decision === 'reject' ? null : category,
      now,
      reviewer || 'user',
      matchId
    );
    d.prepare('INSERT INTO approval_decisions (match_id, decision, final_category, final_exercise_id, reviewer, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      matchId,
      decision,
      decision === 'reject' ? null : category,
      decision === 'reject' ? null : targetExercise,
      reviewer || 'user',
      note || null,
      now
    );

    let progressChange = null;
    if (decision !== 'reject') {
      const sessionId = d.prepare('SELECT session_id FROM transcripts WHERE id = ?').get(m.transcript_id).session_id;
      const existing = d.prepare('SELECT * FROM exercise_evidence WHERE exercise_id = ? AND transcript_id = ?').get(targetExercise, m.transcript_id);
      if (existing) {
        const keep = STATUS_RANK[existing.category] >= STATUS_RANK[category] ? existing.category : category;
        d.prepare('UPDATE exercise_evidence SET category=?, snippet=?, timecode=?, match_id=?, approved_by=?, updated_at=? WHERE id=?').run(
          keep,
          keep === existing.category ? existing.snippet : m.snippet,
          keep === existing.category ? existing.timecode : m.timecode,
          keep === existing.category ? existing.match_id : matchId,
          reviewer || 'user',
          now,
          existing.id
        );
      } else {
        d.prepare(
          `INSERT INTO exercise_evidence (exercise_id, transcript_id, session_id, match_id, source, category, snippet, timecode, note, approved_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'transcript', ?, ?, ?, ?, ?, ?, ?)`
        ).run(targetExercise, m.transcript_id, sessionId, matchId, category, m.snippet, m.timecode, note || null, reviewer || 'user', now, now);
      }
      const prog = d.prepare('SELECT * FROM exercise_progress WHERE exercise_id = ?').get(targetExercise);
      let nextStatus = prog.status;
      // Approved evidence can raise status but never lowers it, and never silently clears a manual "needs practice".
      if (prog.status !== 'needs_practice' && STATUS_RANK[category] > (STATUS_RANK[prog.status] ?? 0)) nextStatus = category;
      d.prepare('UPDATE exercise_progress SET status=?, coverage_confirmed=1, updated_at=? WHERE exercise_id=?').run(nextStatus, now, targetExercise);
      progressChange = { exercise_id: targetExercise, before: { status: prog.status, coverage_confirmed: prog.coverage_confirmed }, after: { status: nextStatus, coverage_confirmed: 1 } };
      audit('exercise_progress', targetExercise, 'evidence_approved', progressChange.before, { ...progressChange.after, match_id: matchId, category }, reviewer);
    }
    audit('evidence_match', matchId, decision, { category: m.category, exercise_id: m.exercise_id }, { category, exercise_id: targetExercise, note }, reviewer);
    return { match: d.prepare('SELECT * FROM evidence_matches WHERE id = ?').get(matchId), progress_change: progressChange };
  });
}
