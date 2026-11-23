// Tutor-intelligence Q&A. Retrieval is local (SQLite FTS5 + structured records). Answers always carry
// citations; when nothing supports an answer we say so. With AI configured, Claude writes the prose but
// may only cite the retrieved context; without AI, a clearly labelled rule-based answer is returned.
import { getDb, nowIso } from '../db/connection.js';
import { parseJson } from './common.js';
import { searchSegments, STOPWORDS } from './transcripts.js';
import { EXERCISE_KEYWORDS } from './exerciseKeywords.js';
import { getGaps, getBriefing } from './briefing.js';
import { aiStatus, answerWithClaude, describeAiError } from './aiClient.js';

const db = () => getDb();

function segCitation(s) {
  return {
    type: 'transcript',
    ref: `transcript:${s.transcript_id}#${s.seq}`,
    label: `Session ${s.session_date}${s.lesson_ids ? ` (${s.lesson_ids})` : ''}${s.timecode ? ` @ ${s.timecode}` : ` line ${s.seq}`}${s.speaker ? ` — ${s.speaker}` : ''}`,
    session_id: s.session_id,
    transcript_id: s.transcript_id,
    snippet: s.text.length > 300 ? `${s.text.slice(0, 299)}…` : s.text,
  };
}

/** Find curriculum exercises (and facets) a question refers to. */
function matchExercises(rawQuestion) {
  // Remove the intent words themselves ("have we demonstrated…") so they don't match exercise keywords.
  const question = rawQuestion.replace(/\b(have|has|did|we|i|you|demonstrat\w*|cover\w*|practi[cs]\w*|done|taught|learn\w*|yet|ever|shown?)\b/gi, ' ');
  const exercises = db().prepare('SELECT e.id, e.description, p.status, p.coverage_confirmed FROM practical_exercises e JOIN exercise_progress p ON p.exercise_id = e.id').all();
  const out = [];
  for (const e of exercises) {
    const spec = EXERCISE_KEYWORDS[e.id];
    const facets = spec?.facets ? Object.entries(spec.facets).filter(([, re]) => re.test(question)).map(([k]) => k) : [];
    const idMention = new RegExp(`\\b${e.id}\\b`, 'i').test(question);
    if (idMention || facets.length || (spec && spec.any.test(question))) out.push({ ...e, facets, score: (idMention ? 5 : 0) + facets.length * 2 + 1 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

function evidenceFor(exerciseId) {
  return db()
    .prepare('SELECT ev.*, s.session_date FROM exercise_evidence ev LEFT JOIN tutoring_sessions s ON s.id = ev.session_id WHERE ev.exercise_id = ? ORDER BY ev.updated_at DESC')
    .all(exerciseId);
}

function evCitation(ev) {
  return {
    type: 'evidence',
    ref: `evidence:${ev.id}`,
    label: `Approved evidence ${ev.exercise_id} (${ev.category}) — ${ev.source === 'manual' ? 'manual' : `session ${ev.session_date}`}${ev.timecode ? ` @ ${ev.timecode}` : ''}`,
    session_id: ev.session_id,
    transcript_id: ev.transcript_id,
    snippet: ev.snippet || ev.note || '',
  };
}

function detectIntent(q) {
  const s = q.toLowerCase();
  if (/\b(have|has|did) (we|i)\b.*\b(demonstrat|practi[cs]|cover|done|do|run|ran|learn|taught)/.test(s) || /\bhave we (demonstrated|done|covered)/.test(s)) return 'have_we';
  if (/\b(miss|missed|missing|gap|gaps|haven'?t covered|not covered|left out)\b/.test(s)) return 'missed';
  if (/\b(next|cover next|should my tutor|plan for)\b/.test(s)) return 'next';
  if (/\b(mistake|mistakes|recurring|keep (making|getting)|struggl|errors?)\b/.test(s)) return 'mistakes';
  if (/\b(what did we cover|covered|what have we (covered|done)|summary|summari[sz]e)\b/.test(s)) return 'covered';
  return 'search';
}

/** Build a rule-based answer and the context blocks both answer modes cite from. */
export function buildContext(question) {
  const intent = detectIntent(question);
  const lines = [];
  const citations = [];
  const cite = (c) => {
    const i = citations.findIndex((x) => x.ref === c.ref);
    if (i >= 0) return `[C${i + 1}]`;
    citations.push(c);
    return `[C${citations.length}]`;
  };
  const sessionsCount = db().prepare('SELECT COUNT(*) n FROM transcripts').get().n;
  if (!sessionsCount) lines.push('No transcripts have been saved yet, so there is no session evidence to search.');

  if (intent === 'have_we') {
    const exs = matchExercises(question);
    if (!exs.length) lines.push('I could not map that question to a curriculum exercise. Try naming the command or exercise id (e.g. "git fetch" or D2-C2-E3).');
    for (const e of exs) {
      const ev = evidenceFor(e.id);
      const facetLabel = e.facets.length ? ` (${e.facets.join(', ')})` : '';
      lines.push(`**${e.id}** — ${e.description.replace(/\.$/, '')}${facetLabel}. Current status: ${e.status.replace(/_/g, ' ')}.`);
      const facetRes = e.facets.map((f) => EXERCISE_KEYWORDS[e.id].facets[f]);
      const facetEv = facetRes.length ? ev.filter((x) => facetRes.some((re) => re.test(`${x.snippet || ''} ${x.note || ''}`))) : ev;
      if (facetEv.length) facetEv.slice(0, 3).forEach((x) => lines.push(`- Approved evidence (${x.category}) ${cite(evCitation(x))}`));
      else lines.push(`- No approved evidence${facetLabel ? ` specifically for${facetLabel}` : ''}.`);
      const term = e.facets[0] || e.description;
      const hits = searchSegments(term, { limit: 4 });
      if (hits.length) hits.forEach((h) => lines.push(`- Transcript mention ${cite(segCitation(h))} (unreviewed: a mention is not proof of execution)`));
      else if (!facetEv.length) lines.push(`- No transcript lines mention it. Evidence is absent — this is not proof it was never taught.`);
    }
  } else if (intent === 'covered') {
    const ev = db()
      .prepare('SELECT ev.*, s.session_date FROM exercise_evidence ev LEFT JOIN tutoring_sessions s ON s.id = ev.session_id ORDER BY s.session_date DESC, ev.exercise_id LIMIT 25')
      .all();
    if (!ev.length) lines.push('No approved evidence yet. Review proposed matches in Tutor Intelligence → Review to record what was covered.');
    ev.forEach((x) => lines.push(`- ${x.exercise_id} — ${x.category.replace(/_/g, ' ')} ${cite(evCitation(x))}`));
  } else if (intent === 'missed') {
    const gaps = getGaps();
    lines.push(gaps.note);
    gaps.by_competency.forEach((c) => {
      c.uncovered_exercises.forEach((e) => lines.push(`- ${e.id} (${c.title}): ${e.description} — not evidenced`));
      c.facet_gaps.forEach((g) => lines.push(`- ${g.message} ${cite({ ...g.citation, snippet: g.message })}`));
    });
    if (!gaps.by_competency.length) lines.push('No held lessons or analyses yet, so no gaps can be computed.');
  } else if (intent === 'next') {
    const b = getBriefing();
    if (!b.lesson) lines.push(b.message);
    else {
      lines.push(`Next lesson: **Lesson ${b.lesson.number} — ${b.lesson.title}**${b.lesson.planned_date ? ` (${b.lesson.planned_date})` : ''}.`);
      b.agenda.forEach((a) => lines.push(`- ${a.minutes} min: ${a.item}`));
      b.carry_over_gaps.slice(0, 5).forEach((g) => lines.push(`- Gap: ${g.text} ${g.citations.map((c) => cite({ ...c, snippet: c.snippet || g.text })).join(' ')}`));
      b.tutor_priorities.slice(0, 3).forEach((p) => lines.push(`- Tutor ${p.field.toLowerCase()}: ${p.text} ${p.citations.map((c) => cite({ ...c, snippet: p.text })).join(' ')}`));
    }
  } else if (intent === 'mistakes') {
    const rows = db()
      .prepare(
        `SELECT a.extraction_json, a.transcript_id, s.session_date, s.id session_id FROM transcript_analyses a JOIN transcripts t ON t.id = a.transcript_id
         JOIN tutoring_sessions s ON s.id = t.session_id WHERE a.status='completed' ORDER BY s.session_date`
      )
      .all();
    const counts = new Map();
    const examples = new Map();
    rows.forEach((r) =>
      (parseJson(r.extraction_json, {})?.difficulties || []).forEach((d) => {
        // Most specific pattern wins (checked in order), so "permission denied" isn't filed under "error".
        const lower = d.text.toLowerCase();
        const key =
          ['permission denied', 'not recognized', 'merge conflict', 'module not found', 'cannot find', 'authenticat', 'rejected', 'fatal', 'syntax', 'typo', 'undefined', 'conflict', 'path', 'port', 'error'].find((k) =>
            lower.includes(k)
          ) || 'other';
        counts.set(key, (counts.get(key) || 0) + 1);
        if (!examples.has(key)) examples.set(key, []);
        examples.get(key).push({ type: 'transcript', ref: `transcript:${r.transcript_id}#${d.seq}`, label: `Session ${r.session_date}${d.timecode ? ` @ ${d.timecode}` : ''}`, session_id: r.session_id, transcript_id: r.transcript_id, snippet: d.text });
      })
    );
    const fb = db().prepare("SELECT * FROM tutor_feedback WHERE COALESCE(misunderstandings,'') <> '' OR COALESCE(weaknesses,'') <> '' ORDER BY feedback_date DESC LIMIT 5").all();
    if (!counts.size && !fb.length) lines.push('No difficulties have been extracted from analysed transcripts and no tutor feedback lists weaknesses yet.');
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .forEach(([k, n]) => lines.push(`- "${k}" appeared ${n} time(s) ${examples.get(k).slice(0, 2).map((c) => cite(c)).join(' ')}${n > 1 ? ' — recurring' : ''}`));
    fb.forEach((f) =>
      lines.push(`- Tutor noted: ${f.misunderstandings || f.weaknesses} ${cite({ type: 'feedback', ref: `feedback:${f.id}`, label: `Tutor feedback ${f.feedback_date}`, session_id: f.session_id, snippet: f.misunderstandings || f.weaknesses })}`)
    );
  }

  // Always add direct transcript search hits for grounding.
  const hits = searchSegments(question, { limit: intent === 'search' ? 10 : 5 });
  if (intent === 'search') {
    if (!hits.length) lines.push('No saved transcript lines match those words. There is no evidence for this in the saved records.');
    else lines.push('Most relevant transcript lines:');
  }
  hits.forEach((h) => {
    const tag = cite(segCitation(h));
    if (intent === 'search') lines.push(`- ${h.text.slice(0, 200)} ${tag}`);
  });
  const terms = (question.toLowerCase().match(/[a-z0-9.\-]+/g) || []).filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (terms.length) {
    const like = terms.slice(0, 5).map(() => "(COALESCE(strengths,'')||' '||COALESCE(weaknesses,'')||' '||COALESCE(misunderstandings,'')||' '||COALESCE(next_priorities,'')||' '||COALESCE(practiced,'')) LIKE ?");
    db()
      .prepare(`SELECT * FROM tutor_feedback WHERE ${like.join(' OR ')} ORDER BY feedback_date DESC LIMIT 3`)
      .all(...terms.slice(0, 5).map((t) => `%${t}%`))
      .forEach((f) => cite({ type: 'feedback', ref: `feedback:${f.id}`, label: `Tutor feedback ${f.feedback_date}`, session_id: f.session_id, snippet: [f.practiced, f.weaknesses, f.next_priorities].filter(Boolean).join(' | ') }));
  }

  return { intent, ruleAnswer: lines.join('\n'), citations };
}

export async function ask(question) {
  const q = String(question || '').trim();
  if (!q) throw Object.assign(new Error('Question is empty'), { status: 400 });
  if (q.length > 4000) throw Object.assign(new Error('Question is too long (max 4000 characters)'), { status: 400 });
  const history = db().prepare('SELECT role, content FROM chat_messages ORDER BY id DESC LIMIT 6').all().reverse();
  db().prepare('INSERT INTO chat_messages (role, content, mode, citations_json, created_at) VALUES (?, ?, ?, ?, ?)').run('user', q, null, '[]', nowIso());

  const { intent, ruleAnswer, citations } = buildContext(q);
  const status = aiStatus();
  let content = ruleAnswer;
  let mode = 'rule_based';
  let aiError = null;
  let usage = null;
  if (status.available) {
    try {
      const blocks = citations.map((c, i) => ({ id: `C${i + 1}`, label: c.label, text: c.snippet || '' }));
      blocks.push({ id: 'R', label: 'Structured summary computed from the database', text: ruleAnswer });
      const out = await answerWithClaude({ question: q, contextBlocks: blocks, history });
      // Output validation: strip citations that do not exist in the retrieved context.
      const valid = new Set(blocks.map((b) => b.id));
      content = out.text.replace(/\[(C\d+|R)\]/g, (m, id) => (valid.has(id) ? m : '[citation removed: not in context]'));
      mode = 'claude';
      usage = out.usage;
    } catch (err) {
      aiError = describeAiError(err);
      content = `${ruleAnswer}\n\n_(Claude was unavailable: ${aiError}. Showing the database answer instead.)_`;
    }
  }
  const info = db()
    .prepare('INSERT INTO chat_messages (role, content, mode, citations_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('assistant', content, mode, JSON.stringify(citations), nowIso());
  return { id: Number(info.lastInsertRowid), role: 'assistant', content, mode, intent, citations, ai: { available: status.available, reason: status.reason, error: aiError }, usage };
}

export function listMessages() {
  return db()
    .prepare('SELECT * FROM chat_messages ORDER BY id ASC LIMIT 500')
    .all()
    .map((m) => ({ ...m, citations: parseJson(m.citations_json, []) }));
}

export function clearMessages() {
  db().prepare('DELETE FROM chat_messages').run();
}
