// Deterministic, offline transcript matcher. It proposes curriculum matches for human review; it never
// changes learning state itself. Transcript text is treated as data — nothing inside it is executed.
import { EXERCISE_KEYWORDS } from './exerciseKeywords.js';
import { speakerRole } from './transcripts.js';

const PROMPT_LINE = /^(PS [A-Za-z]:\\[^>]*>|[A-Za-z]:\\[^>]*>|\$\s|>\s|#\s(?=git|npm|node|cd|ls))/;
const EXEC_OUTPUT =
  /cloning into|enumerating objects|counting objects|writing objects|already up to date|fast-forward|^\s*from https?:\/\/github|^remote:|set up to track|switched to (a new )?branch|on branch \S+|nothing to commit|\[\S+ [0-9a-f]{5,}\]|create mode|local:\s+https?:|ready in \d+|listening on|added \d+ packages|tests? passed|\d+ passing|fatal:|error: failed to push|permission denied \(publickey\)/i;
const EXEC_VERBS =
  /\b(i ran|you ran|we ran|i'?ve run|let'?s run|let me run|now run|go ahead and run|run it|ran it|you typed|i typed|type in|executed?|hit enter|press(ed)? enter|it worked|that worked|works now|successfully|i'?ve (cloned|pushed|pulled|fetched|committed|created|installed|merged)|you (cloned|pushed|pulled|fetched|committed|created|installed|merged)|i (cloned|pushed|pulled|fetched|committed|created|installed|merged))\b/i;
const INDEPENDENT =
  /\b(on (my|your) own|by (myself|yourself)|without (my |any )?help|independently|unassisted|you did (that|it|this) (yourself|alone|on your own)|without me)\b/i;
const NEGATION =
  /\b(didn'?t|did not|haven'?t|have not|hasn'?t|not yet|next (time|session|lesson|week|class)|we'?ll (do|cover|look at|get to|try)|we will (do|cover|look at)|skip(ped)?|ran out of time|won'?t|another time|didn'?t get to|run out of time)\b/i;

const DIFFICULTY =
  /\b(error|stuck|confus\w*|don'?t understand|doesn'?t work|didn'?t work|not working|failed|failing|permission denied|not recognized|fatal:|rejected|struggl\w*|mistake|wrong|typo)\b/i;
const HOMEWORK =
  /\b(homework|for next (time|session|lesson|week)|before (our |the )?next (session|lesson|class)|practi[cs]e (this|that|it)\b.{0,30}(at home|this week|before)|assignment)\b/i;
const UNRESOLVED =
  /\b(not sure|i'?ll (have to )?check|let me get back|we'?ll come back to|park (that|this)|come back to (that|this)|no idea|i don'?t know)\b/i;
const DECISION = /\b(let'?s (use|go with|stick with)|we('?ll| will) (use|go with)|decided|agreed|we'?re going to (use|go with))\b/i;
const TUTOR_FEEDBACK =
  /\b(good|great|well done|nice|excellent|careful|remember|watch out|mistake|instead|better to|try to|don'?t forget|common (error|mistake)|be careful)\b/i;
const COMMAND_TOKEN =
  /\b(git (?:clone|init|status|add|commit|push|pull|fetch|log|remote(?: -v)?|branch|switch|checkout|merge|revert|reset|restore|stash)|npm (?:run \w+|install|init|test|start|i)|npx [\w@/.-]+|node [\w./-]+|Get-ChildItem|New-Item|Remove-Item|Rename-Item|Move-Item|Copy-Item|claude mcp add|pwd|cd [\w./\\:~-]+)/gi;

const truncate = (s, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function hasExecution(segments, i) {
  const s = segments[i];
  if (PROMPT_LINE.test(s.text) || EXEC_OUTPUT.test(s.text) || EXEC_VERBS.test(s.text)) return true;
  const next = segments[i + 1];
  return Boolean(next && (EXEC_OUTPUT.test(next.text) || PROMPT_LINE.test(next.text)));
}

/**
 * @param {object} p
 * @param {Array} p.segments - parsed transcript segments
 * @param {Array} p.exercises - [{id, competency_id, description, is_canonical}]
 * @param {Array<string>} p.focusCompetencies - competency ids of the lessons assigned to the session
 */
export function analyseRuleBased({ segments, exercises, focusCompetencies = [], tutorName, learnerName }) {
  const focus = new Set(focusCompetencies);
  const hits = new Map();

  segments.forEach((seg, i) => {
    for (const ex of exercises) {
      const spec = EXERCISE_KEYWORDS[ex.id];
      if (!spec || !spec.any.test(seg.text)) continue;
      // Questions and negated/future mentions are not evidence that something was taught or done.
      const question = /\?\s*$/.test(seg.text);
      const negated = NEGATION.test(seg.text) || question;
      const exec = !negated && hasExecution(segments, i);
      const role = speakerRole(seg.speaker, { tutorName, learnerName });
      const independent = !negated && INDEPENDENT.test(seg.text);
      const facets = spec.facets ? Object.entries(spec.facets).filter(([, re]) => re.test(seg.text)).map(([k]) => k) : [];
      if (!hits.has(ex.id)) hits.set(ex.id, []);
      hits.get(ex.id).push({ seg, negated, question, exec, independent, role, facets });
    }
  });

  const matches = [];
  const exById = new Map(exercises.map((e) => [e.id, e]));
  for (const [exerciseId, list] of hits) {
    const ex = exById.get(exerciseId);
    const inFocus = focus.size === 0 || focus.has(ex.competency_id);
    const positive = list.filter((h) => !h.negated);
    if (!inFocus && positive.length < 2) continue; // out-of-lesson topics need repeated evidence to be proposed

    const spec = EXERCISE_KEYWORDS[exerciseId];
    const allFacets = spec.facets ? Object.keys(spec.facets) : [];
    const facetsFound = [...new Set(positive.flatMap((h) => h.facets))];
    const facetsNegated = [...new Set(list.filter((h) => h.negated).flatMap((h) => h.facets))].filter((f) => !facetsFound.includes(f));

    let category;
    let best;
    let rationale;
    if (!positive.length) {
      category = 'uncertain';
      best = list[0];
      rationale = list.every((h) => h.question)
        ? 'Only raised as a question — not evidence that it was taught.'
        : 'Mentioned only as a question or as not done / planned for later — not evidence that it was taught.';
    } else if (positive.some((h) => h.independent && h.exec)) {
      category = 'independently_completed';
      best = positive.find((h) => h.independent && h.exec);
      rationale = 'Transcript language suggests the learner did this without help. Needs confirmation: a transcript alone cannot prove independent execution.';
    } else if (positive.some((h) => h.exec)) {
      category = 'demonstrated';
      best = positive.find((h) => h.exec);
      rationale = 'Command/output or "ran it" language appears near this topic, suggesting it was executed (guided) rather than only discussed.';
    } else {
      category = 'discussed';
      best = positive.reduce((a, b) => (b.facets.length > a.facets.length ? b : a), positive[0]);
      rationale = 'Topic is mentioned/explained; no sign that commands were executed.';
    }

    let confidence = category === 'uncertain' ? 0.25 : 0.35 + 0.08 * Math.min(positive.length, 4) + (inFocus && focus.size ? 0.15 : 0) + (category === 'demonstrated' ? 0.1 : 0);
    if (category === 'independently_completed') confidence = Math.min(confidence, 0.55);
    confidence = Math.round(Math.min(confidence, 0.9) * 100) / 100;

    const extra = (positive.length ? positive : list)
      .filter((h) => h !== best)
      .slice(0, 3)
      .map((h) => ({ seq: h.seg.seq, timecode: h.seg.timecode, speaker: h.seg.speaker, text: truncate(h.seg.text, 240) }));

    const missingFacets = allFacets.filter((f) => !facetsFound.includes(f));
    if (missingFacets.length && category !== 'uncertain') rationale += ` Not evidenced: ${missingFacets.join(', ')}.`;
    rationale += ` (${positive.length} supporting line(s)${list.length - positive.length ? `, ${list.length - positive.length} question/negated/future mention(s)` : ''}; speaker role: ${best.role}.)`;

    matches.push({
      exercise_id: exerciseId,
      category,
      confidence,
      snippet: truncate(best.seg.text),
      segment_seq: best.seg.seq,
      start_char: best.seg.start_char,
      end_char: best.seg.end_char,
      timecode: best.seg.timecode,
      speaker: best.seg.speaker,
      rationale,
      facets: { found: facetsFound, missing: missingFacets, negated: facetsNegated, all: allFacets },
      extra_snippets: extra,
    });
  }

  // Gaps: assigned-lesson exercises (or enumerated facets) with no supporting evidence in this transcript.
  const gaps = [];
  const positiveIds = new Set(matches.filter((m) => m.category !== 'uncertain').map((m) => m.exercise_id));
  for (const ex of exercises.filter((e) => focus.has(e.competency_id) && e.is_canonical)) {
    if (!positiveIds.has(ex.id)) {
      gaps.push({ exercise_id: ex.id, facet: null, message: `${ex.id} (${ex.description}) — not evidenced in this transcript.` });
    } else {
      const m = matches.find((x) => x.exercise_id === ex.id);
      m.facets.missing.forEach((f) =>
        gaps.push({ exercise_id: ex.id, facet: f, message: `${f} — not evidenced in this transcript (part of ${ex.id}).` })
      );
    }
  }

  // Structured extraction (labelled heuristics).
  const item = (s) => ({ seq: s.seq, timecode: s.timecode, speaker: s.speaker, text: truncate(s.text, 300) });
  const executed = [];
  const mentioned = [];
  segments.forEach((s, i) => {
    const cmds = s.text.match(COMMAND_TOKEN) || [];
    if (!cmds.length) return;
    const isExec = PROMPT_LINE.test(s.text) || ((EXEC_VERBS.test(s.text) || hasExecution(segments, i)) && !NEGATION.test(s.text));
    cmds.forEach((c) => (isExec ? executed : mentioned).push({ command: c.trim(), ...item(s) }));
  });
  const execSet = new Set(executed.map((c) => c.command.toLowerCase()));
  const extraction = {
    method: 'rule_based',
    commands_executed: dedupeBy(executed, (c) => c.command.toLowerCase()).slice(0, 40),
    commands_mentioned_only: dedupeBy(mentioned.filter((c) => !execSet.has(c.command.toLowerCase())), (c) => c.command.toLowerCase()).slice(0, 40),
    difficulties: segments.filter((s) => DIFFICULTY.test(s.text)).slice(0, 30).map(item),
    homework: segments.filter((s) => HOMEWORK.test(s.text)).slice(0, 15).map(item),
    unresolved_questions: segments
      .filter((s) => UNRESOLVED.test(s.text) || (speakerRole(s.speaker, { tutorName, learnerName }) === 'learner' && /\?\s*$/.test(s.text)))
      .slice(0, 20)
      .map(item),
    decisions: segments.filter((s) => DECISION.test(s.text)).slice(0, 15).map(item),
    tutor_feedback: segments
      .filter((s) => speakerRole(s.speaker, { tutorName, learnerName }) === 'tutor' && TUTOR_FEEDBACK.test(s.text))
      .slice(0, 20)
      .map(item),
    guided_vs_independent: {
      independent_signals: segments.filter((s) => INDEPENDENT.test(s.text) && !NEGATION.test(s.text)).map(item).slice(0, 10),
    },
  };

  const warnings = [];
  if (!focus.size) warnings.push('No lesson assigned to this session: lesson-specific gaps cannot be computed and all topics are treated equally.');
  if (!segments.some((s) => s.speaker)) warnings.push('No speaker labels detected; guided vs independent work and tutor feedback detection are less reliable.');

  return { matches: matches.sort((a, b) => a.exercise_id.localeCompare(b.exercise_id)), gaps, extraction, warnings };
}

function dedupeBy(arr, key) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Suggest which lessons a transcript most likely belongs to, by competency match counts. */
export function suggestLessons({ segments, exercises, lessons }) {
  const { matches } = analyseRuleBased({ segments, exercises, focusCompetencies: [] });
  const score = new Map();
  matches
    .filter((m) => m.category !== 'uncertain')
    .forEach((m) => {
      const cc = exercises.find((e) => e.id === m.exercise_id).competency_id;
      score.set(cc, (score.get(cc) || 0) + m.confidence);
    });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cc, s]) => {
      const lesson = lessons.find((l) => l.competency_id === cc);
      return {
        lesson_id: lesson.id,
        lesson_number: lesson.number,
        title: lesson.title,
        score: Math.round(s * 100) / 100,
        matched_exercises: matches.filter((m) => m.exercise_id.startsWith(`${cc}-`)).map((m) => m.exercise_id),
      };
    });
}
