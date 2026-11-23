import { getDb, nowIso, tx } from './connection.js';
import { loadCurriculumFile, validateCurriculum, DOMAIN_ASSESSMENT_CRITERIA } from './curriculum.js';

export const DEFAULT_SETTINGS = {
  learner_name: 'Learner',
  tutor_name: 'Tutor',
  programme_start_date: '',
  ai_enabled: 'false',
  ai_model: '',
  ai_effort: 'medium',
  ai_max_chunk_chars: '24000',
  ai_max_chunks: '20',
  transcript_retention_days: '0',
};

/**
 * Idempotent seed. Curriculum tables are upserted from the JSON; learner-owned rows are only
 * created when missing (INSERT OR IGNORE) so re-running never resets progress or edits.
 */
export function seedDatabase({ filePath } = {}) {
  const { json, checksum } = loadCurriculumFile(filePath);
  const v = validateCurriculum(json);
  if (!v.ok) {
    const err = new Error(`Curriculum validation failed:\n- ${v.errors.join('\n- ')}`);
    err.validation = v;
    throw err;
  }
  const { domains, competencies, exercises, lessons, weeks } = v.flat;
  const now = nowIso();

  tx((db) => {
    const p = json.programme;
    db.prepare(
      `INSERT INTO programme (id, title, duration_weeks, lessons_per_week, minutes_per_lesson, total_lessons, hierarchy_json, source_checksum, seeded_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, duration_weeks=excluded.duration_weeks, lessons_per_week=excluded.lessons_per_week,
         minutes_per_lesson=excluded.minutes_per_lesson, total_lessons=excluded.total_lessons, hierarchy_json=excluded.hierarchy_json,
         source_checksum=excluded.source_checksum, seeded_at=excluded.seeded_at`
    ).run(p.title, p.duration_weeks, p.lessons_per_week, p.minutes_per_lesson, p.total_lessons, JSON.stringify(p.hierarchy), checksum, now);

    const upDomain = db.prepare(
      `INSERT INTO learning_domains (id, name, objective, assessment, sort_order) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, objective=excluded.objective, assessment=excluded.assessment, sort_order=excluded.sort_order`
    );
    domains.forEach((d, i) => upDomain.run(d.id, d.name, d.objective, d.assessment, i + 1));

    const upComp = db.prepare(
      `INSERT INTO core_competencies (id, domain_id, title, lesson_id, sort_order) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET domain_id=excluded.domain_id, title=excluded.title, lesson_id=excluded.lesson_id, sort_order=excluded.sort_order`
    );
    competencies.forEach((cc, i) => upComp.run(cc.id, cc.domain_id, cc.title, cc.lesson_id, i + 1));

    const upEx = db.prepare(
      `INSERT INTO practical_exercises (id, competency_id, description, is_canonical, sort_order, created_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET competency_id=excluded.competency_id, description=excluded.description, is_canonical=1, sort_order=excluded.sort_order`
    );
    const ensureExProgress = db.prepare(`INSERT OR IGNORE INTO exercise_progress (exercise_id, updated_at) VALUES (?, ?)`);
    exercises.forEach((e) => {
      const idx = Number(e.id.split('-E')[1]);
      upEx.run(e.id, e.competency_id, e.description, idx, now);
      ensureExProgress.run(e.id, now);
    });

    const upWeek = db.prepare(
      `INSERT INTO weeks (week, lesson_1_id, lesson_2_id) VALUES (?, ?, ?)
       ON CONFLICT(week) DO UPDATE SET lesson_1_id=excluded.lesson_1_id, lesson_2_id=excluded.lesson_2_id`
    );
    weeks.forEach((w) => upWeek.run(w.week, w.lesson_1_id, w.lesson_2_id));

    const upLesson = db.prepare(
      `INSERT INTO lessons (id, number, week, session_in_week, duration_minutes, title, domain_id, competency_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET number=excluded.number, week=excluded.week, session_in_week=excluded.session_in_week,
         duration_minutes=excluded.duration_minutes, title=excluded.title, domain_id=excluded.domain_id, competency_id=excluded.competency_id`
    );
    const ensureLessonProgress = db.prepare(`INSERT OR IGNORE INTO lesson_progress (lesson_id, status, updated_at) VALUES (?, 'planned', ?)`);
    lessons.forEach((l) => {
      upLesson.run(l.id, l.number, l.week, l.session_in_week, l.duration_minutes, l.title, l.domain_id, l.competency_id);
      ensureLessonProgress.run(l.id, now);
    });

    // Domain assessments after every 4 lessons (lessons 4, 8, 12, 16, 20, 24 → weeks 2, 4, … 12).
    const upDA = db.prepare(
      `INSERT INTO domain_assessments (id, domain_id, after_lesson_id, week, description) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET domain_id=excluded.domain_id, after_lesson_id=excluded.after_lesson_id, week=excluded.week, description=excluded.description`
    );
    const upRubric = db.prepare(
      `INSERT INTO assessment_rubrics (id, scope, competency_id, domain_assessment_id, title, pass_rule) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, pass_rule=excluded.pass_rule`
    );
    // Criteria: insert if missing (keeps learner/tutor edits), always refresh the read-only seed_text.
    const insCrit = db.prepare(
      `INSERT INTO assessment_criteria (id, rubric_id, exercise_id, seed_text, text, mandatory, active, is_custom, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET seed_text=excluded.seed_text, exercise_id=excluded.exercise_id`
    );
    const PASS_RULE =
      'Pass only when every active mandatory criterion is passed independently with recorded non-transcript evidence; mastery additionally requires explicit verification.';

    domains.forEach((d, i) => {
      const lessonNum = (i + 1) * 4;
      const lesson = lessons.find((l) => l.number === lessonNum);
      const daId = `DA-${d.id}`;
      upDA.run(daId, d.id, lesson.id, lesson.week, d.assessment);
      const rubricId = `RUB-${daId}`;
      upRubric.run(rubricId, 'domain', null, daId, `${d.name} — domain assessment`, PASS_RULE);
      (DOMAIN_ASSESSMENT_CRITERIA[d.id] || []).forEach((text, k) => {
        insCrit.run(`${daId}-K${k + 1}`, rubricId, null, text, text, k + 1, now);
      });
    });

    competencies.forEach((cc) => {
      const rubricId = `RUB-${cc.id}`;
      upRubric.run(rubricId, 'competency', cc.id, null, `${cc.title} — practical rubric`, PASS_RULE);
      (cc.practical_exercises || []).forEach((e, k) => {
        const text = `Independently and observably: ${e.description}`;
        insCrit.run(`RC-${e.id}`, rubricId, e.id, text, text, k + 1, now);
      });
    });

    const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, val] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, val);
  });

  return { checksum, counts: v.counts };
}

export function curriculumCountsFromDb() {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get().n;
  return {
    domains: one('SELECT COUNT(*) n FROM learning_domains'),
    competencies: one('SELECT COUNT(*) n FROM core_competencies'),
    exercises: one('SELECT COUNT(*) n FROM practical_exercises WHERE is_canonical = 1'),
    custom_exercises: one('SELECT COUNT(*) n FROM practical_exercises WHERE is_canonical = 0'),
    weeks: one('SELECT COUNT(*) n FROM weeks'),
    lessons: one('SELECT COUNT(*) n FROM lessons'),
    rubrics: one("SELECT COUNT(*) n FROM assessment_rubrics WHERE scope='competency'"),
    domain_assessments: one('SELECT COUNT(*) n FROM domain_assessments'),
  };
}
