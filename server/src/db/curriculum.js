import fs from 'node:fs';
import crypto from 'node:crypto';
import { CURRICULUM_PATH } from '../config.js';

export function loadCurriculumFile(filePath = CURRICULUM_PATH) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return { raw, json: JSON.parse(raw), checksum: crypto.createHash('sha256').update(raw).digest('hex') };
}

/**
 * Validate the authoritative curriculum exactly as the spec requires.
 * Returns { ok, errors, counts }. Never mutates the input.
 */
export function validateCurriculum(c) {
  const errors = [];
  const ids = new Map();
  const claim = (id, kind) => {
    if (typeof id !== 'string' || !id) return errors.push(`${kind} has missing id`);
    if (ids.has(id)) errors.push(`Duplicate id ${id} (${kind} and ${ids.get(id)})`);
    ids.set(id, kind);
  };

  const p = c.programme || {};
  const domains = c.learning_domains || [];
  const lessons = c.lessons || [];
  const weeks = c.weeks || [];
  const competencies = domains.flatMap((d) => (d.core_competencies || []).map((cc) => ({ ...cc, domain_id: d.id })));
  const exercises = competencies.flatMap((cc) => (cc.practical_exercises || []).map((e) => ({ ...e, competency_id: cc.id })));

  domains.forEach((d) => claim(d.id, 'domain'));
  competencies.forEach((cc) => claim(cc.id, 'competency'));
  exercises.forEach((e) => claim(e.id, 'exercise'));
  lessons.forEach((l) => claim(l.id, 'lesson'));
  const weekNums = new Set();
  weeks.forEach((w) => {
    if (weekNums.has(w.week)) errors.push(`Duplicate week ${w.week}`);
    weekNums.add(w.week);
  });

  const expect = (label, actual, expected) => {
    if (actual !== expected) errors.push(`Expected ${expected} ${label}, found ${actual}`);
  };
  expect('domains', domains.length, 6);
  expect('competencies', competencies.length, 24);
  expect('exercises', exercises.length, 96);
  expect('weeks', weeks.length, 12);
  expect('lessons', lessons.length, 24);
  expect('programme.duration_weeks', p.duration_weeks, 12);
  expect('programme.lessons_per_week', p.lessons_per_week, 2);
  expect('programme.minutes_per_lesson', p.minutes_per_lesson, 60);
  expect('programme.total_lessons', p.total_lessons, 24);

  domains.forEach((d) => {
    if ((d.core_competencies || []).length !== 4) errors.push(`Domain ${d.id} must have 4 competencies`);
    if (!d.assessment) errors.push(`Domain ${d.id} has no assessment description`);
  });
  competencies.forEach((cc) => {
    if ((cc.practical_exercises || []).length !== 4) errors.push(`Competency ${cc.id} must have 4 exercises`);
  });
  exercises.forEach((e) => {
    if (!e.id.startsWith(`${e.competency_id}-`)) errors.push(`Exercise ${e.id} id does not match competency ${e.competency_id}`);
    if (!e.description) errors.push(`Exercise ${e.id} has no description`);
  });

  const lessonById = new Map(lessons.map((l) => [l.id, l]));
  const compById = new Map(competencies.map((cc) => [cc.id, cc]));
  const perWeek = new Map();
  lessons.forEach((l) => {
    if (l.duration_minutes !== 60) errors.push(`Lesson ${l.id} must be 60 minutes`);
    if (l.duration_minutes > 60) errors.push(`Lesson ${l.id} exceeds 60 minutes`);
    const cc = compById.get(l.competency_id);
    if (!cc) errors.push(`Lesson ${l.id} references missing competency ${l.competency_id}`);
    else {
      if (cc.domain_id !== l.domain_id) errors.push(`Lesson ${l.id} domain ${l.domain_id} != competency domain ${cc.domain_id}`);
      if (cc.lesson_id !== l.id) errors.push(`Competency ${cc.id} lesson_id ${cc.lesson_id} != lesson ${l.id}`);
    }
    if (!weekNums.has(l.week)) errors.push(`Lesson ${l.id} references missing week ${l.week}`);
    perWeek.set(l.week, (perWeek.get(l.week) || 0) + 1);
  });
  for (const [w, n] of perWeek) if (n !== 2) errors.push(`Week ${w} has ${n} lessons, expected 2`);
  competencies.forEach((cc) => {
    if (!lessonById.has(cc.lesson_id)) errors.push(`Competency ${cc.id} references missing lesson ${cc.lesson_id}`);
  });
  weeks.forEach((w) => {
    [
      [w.lesson_1_id, 1],
      [w.lesson_2_id, 2],
    ].forEach(([lid, slot]) => {
      const l = lessonById.get(lid);
      if (!l) errors.push(`Week ${w.week} references missing lesson ${lid}`);
      else if (l.week !== w.week || l.session_in_week !== slot)
        errors.push(`Week ${w.week} slot ${slot} lesson ${lid} disagrees with lesson week/session`);
    });
  });

  return {
    ok: errors.length === 0,
    errors,
    counts: {
      domains: domains.length,
      competencies: competencies.length,
      exercises: exercises.length,
      weeks: weeks.length,
      lessons: lessons.length,
    },
    flat: { domains, competencies, exercises, lessons, weeks },
  };
}

/** Additional, editable domain-assessment tests (derived from each domain's assessment text). */
export const DOMAIN_ASSESSMENT_CRITERIA = {
  D1: [
    'Open an unfamiliar project in VS Code',
    'Identify its key files and explain what each does',
    'Run the project locally from the terminal',
    'Edit its interface and verify the change in the browser',
    'Diagnose and fix an error',
  ],
  D2: [
    'Create a GitHub repository',
    'Clone it to the computer (git clone)',
    'Create and switch to a feature branch',
    'Edit files and commit with a meaningful message',
    'Push the branch to GitHub (git push)',
    'Pull and fetch remote changes (git pull, git fetch)',
    'Open a pull request',
    'Merge the pull request',
    'Share the repository with a collaborator',
  ],
  D3: [
    'Write a specification with acceptance criteria for a dashboard',
    'Build a functioning dashboard from the specification using Claude Code',
    'Test the dashboard (manual and/or automated)',
    'Troubleshoot an error using evidence',
    'Commit the completed feature',
  ],
  D4: [
    'Author a CLAUDE.md for a project',
    'Build two reusable skills, each with a SKILL.md',
    'Create one specialist subagent definition',
    'Build one coordinated workflow that delegates to specialists',
    'Demonstrate reuse without rewriting large prompts',
  ],
  D5: [
    'Read data from an API or via an MCP integration',
    'Validate the data that was read',
    'Produce a reliable structured result in an automated reporting flow',
    'Show what happens on a failure and how to recover',
  ],
  D6: [
    'Independently demonstrate a GTM OS application feature end to end',
    'Explain how the feature works (files, architecture, data flow)',
    'Make a change to the feature',
    'Troubleshoot a problem',
  ],
};
