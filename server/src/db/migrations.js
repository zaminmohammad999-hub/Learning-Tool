// Ordered, append-only schema migrations. Never edit a shipped migration; add a new one.
// Seed tables (curriculum) are rewritten by the seeder; learner tables are never touched by seeding.

export const migrations = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
-- ───────────── Canonical curriculum (seeded from data/vibe_coding_curriculum.json) ─────────────
CREATE TABLE programme (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  title TEXT NOT NULL,
  duration_weeks INTEGER NOT NULL,
  lessons_per_week INTEGER NOT NULL,
  minutes_per_lesson INTEGER NOT NULL,
  total_lessons INTEGER NOT NULL,
  hierarchy_json TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  seeded_at TEXT NOT NULL
);
CREATE TABLE learning_domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  assessment TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE TABLE core_competencies (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES learning_domains(id),
  title TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE TABLE practical_exercises (
  id TEXT PRIMARY KEY,
  competency_id TEXT NOT NULL REFERENCES core_competencies(id),
  description TEXT NOT NULL,
  is_canonical INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  created_at TEXT
);
CREATE TABLE weeks (
  week INTEGER PRIMARY KEY,
  lesson_1_id TEXT NOT NULL,
  lesson_2_id TEXT NOT NULL
);
CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  week INTEGER NOT NULL REFERENCES weeks(week),
  session_in_week INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  title TEXT NOT NULL,
  domain_id TEXT NOT NULL REFERENCES learning_domains(id),
  competency_id TEXT NOT NULL REFERENCES core_competencies(id)
);
CREATE TABLE domain_assessments (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES learning_domains(id),
  after_lesson_id TEXT NOT NULL REFERENCES lessons(id),
  week INTEGER NOT NULL,
  description TEXT NOT NULL,
  scheduled_date TEXT
);

-- ───────────── Learner-owned state (never overwritten by seeding) ─────────────
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE lesson_progress (
  lesson_id TEXT PRIMARY KEY REFERENCES lessons(id),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','held','missed')),
  scheduled_date TEXT,
  held_date TEXT,
  tutor TEXT,
  objectives TEXT,
  homework_text TEXT,
  notes TEXT,
  updated_at TEXT
);
CREATE TABLE exercise_progress (
  exercise_id TEXT PRIMARY KEY REFERENCES practical_exercises(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','discussed','demonstrated','independently_completed','needs_practice')),
  coverage_confirmed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  due_date TEXT,
  display_order INTEGER,
  updated_at TEXT
);
CREATE TABLE tutoring_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date TEXT NOT NULL,
  duration_minutes INTEGER,
  tutor TEXT,
  title TEXT,
  speaker_notes TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE session_lessons (
  session_id INTEGER NOT NULL REFERENCES tutoring_sessions(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES lessons(id),
  PRIMARY KEY (session_id, lesson_id)
);
CREATE TABLE transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES tutoring_sessions(id) ON DELETE CASCADE,
  filename TEXT,
  format TEXT NOT NULL,
  original_text TEXT NOT NULL,
  checksum TEXT NOT NULL UNIQUE,
  char_count INTEGER NOT NULL,
  segment_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- The original transcript is immutable: analyses and edits never rewrite it.
CREATE TRIGGER transcripts_original_immutable
BEFORE UPDATE OF original_text, checksum ON transcripts
BEGIN
  SELECT RAISE(ABORT, 'Original transcript text is immutable');
END;
CREATE TABLE transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  speaker TEXT,
  timecode TEXT,
  start_char INTEGER,
  end_char INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX ix_segments_transcript ON transcript_segments(transcript_id, seq);
CREATE VIRTUAL TABLE segments_fts USING fts5(
  text, speaker, content='transcript_segments', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER segments_ai AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO segments_fts(rowid, text, speaker) VALUES (new.id, new.text, coalesce(new.speaker,''));
END;
CREATE TRIGGER segments_ad AFTER DELETE ON transcript_segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text, speaker) VALUES ('delete', old.id, old.text, coalesce(old.speaker,''));
END;

CREATE TABLE transcript_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('rule_based','claude')),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  chunk_count INTEGER,
  extraction_json TEXT,
  gaps_json TEXT,
  warnings_json TEXT,
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (transcript_id, version)
);
CREATE TABLE evidence_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES transcript_analyses(id) ON DELETE CASCADE,
  transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES practical_exercises(id),
  category TEXT NOT NULL CHECK (category IN ('discussed','demonstrated','independently_completed','uncertain')),
  confidence REAL NOT NULL,
  snippet TEXT NOT NULL,
  segment_seq INTEGER,
  start_char INTEGER,
  end_char INTEGER,
  timecode TEXT,
  speaker TEXT,
  rationale TEXT,
  facets_json TEXT,
  extra_snippets_json TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected','adjusted')),
  final_category TEXT,
  reviewed_at TEXT,
  reviewer TEXT
);
CREATE TABLE approval_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES evidence_matches(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','adjust')),
  final_category TEXT,
  final_exercise_id TEXT,
  reviewer TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
-- Approved, deduplicated evidence. One row per exercise per transcript prevents double counting
-- when a transcript is re-analysed or mentions the same topic many times.
CREATE TABLE exercise_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise_id TEXT NOT NULL REFERENCES practical_exercises(id) ON DELETE CASCADE,
  transcript_id INTEGER REFERENCES transcripts(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES tutoring_sessions(id) ON DELETE CASCADE,
  match_id INTEGER,
  source TEXT NOT NULL CHECK (source IN ('transcript','manual')),
  category TEXT NOT NULL CHECK (category IN ('discussed','demonstrated','independently_completed')),
  snippet TEXT,
  timecode TEXT,
  note TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_evidence_exercise_transcript ON exercise_evidence(exercise_id, transcript_id)
  WHERE transcript_id IS NOT NULL;

-- ───────────── Assessments ─────────────
CREATE TABLE assessment_rubrics (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('competency','domain')),
  competency_id TEXT REFERENCES core_competencies(id),
  domain_assessment_id TEXT REFERENCES domain_assessments(id),
  title TEXT NOT NULL,
  pass_rule TEXT NOT NULL
);
CREATE TABLE assessment_criteria (
  id TEXT PRIMARY KEY,
  rubric_id TEXT NOT NULL REFERENCES assessment_rubrics(id),
  exercise_id TEXT REFERENCES practical_exercises(id),
  seed_text TEXT,
  text TEXT NOT NULL,
  mandatory INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  is_custom INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE assessment_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rubric_id TEXT NOT NULL REFERENCES assessment_rubrics(id),
  kind TEXT NOT NULL CHECK (kind IN ('competency','domain','skill_check')),
  competency_id TEXT REFERENCES core_competencies(id),
  domain_assessment_id TEXT REFERENCES domain_assessments(id),
  attempt_number INTEGER NOT NULL,
  assessor TEXT NOT NULL,
  attempt_date TEXT NOT NULL,
  overall_result TEXT NOT NULL CHECK (overall_result IN ('pass','fail')),
  criteria_passed INTEGER NOT NULL,
  criteria_mandatory INTEGER NOT NULL,
  feedback TEXT,
  retry_plan TEXT,
  github_links TEXT,
  ai_suggested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE criterion_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL REFERENCES assessment_criteria(id),
  result TEXT NOT NULL CHECK (result IN ('pass','fail','not_observed')),
  independence TEXT NOT NULL CHECK (independence IN ('independent','assisted')),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('observed_live','artifact_url','commit_or_pr','screen_recording','transcript_only','other')),
  evidence_text TEXT,
  evidence_url TEXT,
  counts_toward_pass INTEGER NOT NULL,
  not_counted_reason TEXT,
  UNIQUE (attempt_id, criterion_id)
);
CREATE TABLE competency_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competency_id TEXT NOT NULL REFERENCES core_competencies(id),
  attempt_id INTEGER NOT NULL REFERENCES assessment_attempts(id),
  verifier TEXT NOT NULL,
  verifier_role TEXT NOT NULL CHECK (verifier_role IN ('learner','tutor')),
  evidence_summary TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_reason TEXT
);

-- ───────────── Feedback, homework, assistant, audit ─────────────
CREATE TABLE tutor_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES tutoring_sessions(id) ON DELETE SET NULL,
  lesson_id TEXT REFERENCES lessons(id),
  feedback_date TEXT NOT NULL,
  author TEXT,
  strengths TEXT,
  weaknesses TEXT,
  misunderstandings TEXT,
  corrections TEXT,
  confidence INTEGER CHECK (confidence BETWEEN 1 AND 5),
  practiced TEXT,
  homework TEXT,
  next_priorities TEXT,
  exercise_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE homework (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id TEXT REFERENCES lessons(id),
  session_id INTEGER REFERENCES tutoring_sessions(id) ON DELETE SET NULL,
  feedback_id INTEGER REFERENCES tutor_feedback(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  exercise_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  mode TEXT,
  citations_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id);
`,
  },
  {
    version: 2,
    name: 'automation: calendar, folder watcher, translation',
    sql: `
-- Calendar occurrences pulled from the learner's private iCal feed (re-synced; the feed is the source of truth).
CREATE TABLE calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  summary TEXT,
  lesson_id TEXT REFERENCES lessons(id),
  assigned_by TEXT CHECK (assigned_by IN ('title','sequence','transcript','user')),
  cancelled INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  UNIQUE (uid, starts_at)
);
CREATE INDEX ix_calendar_start ON calendar_events(starts_at);
ALTER TABLE lesson_progress ADD COLUMN schedule_source TEXT;
ALTER TABLE lesson_progress ADD COLUMN scheduled_time TEXT;

-- Files seen in the watched transcripts folder (e.g. Hearsay output). File content is NOT stored here.
CREATE TABLE watched_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size INTEGER,
  mtime TEXT,
  recorded_at TEXT,
  duration_minutes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('waiting','imported','needs_review','ignored','duplicate','error')),
  reason TEXT,
  transcript_id INTEGER REFERENCES transcripts(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES tutoring_sessions(id) ON DELETE SET NULL,
  lesson_id TEXT REFERENCES lessons(id),
  calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
  pipeline_json TEXT,
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Translation: the immutable original stays in transcripts.original_text. Segments hold the
-- English working text, with the source-language text kept alongside in source_text.
ALTER TABLE transcripts ADD COLUMN language TEXT;
ALTER TABLE transcripts ADD COLUMN translation_status TEXT;
ALTER TABLE transcripts ADD COLUMN translation_model TEXT;
ALTER TABLE transcripts ADD COLUMN translated_at TEXT;
ALTER TABLE transcripts ADD COLUMN recorded_at TEXT;
ALTER TABLE transcript_segments ADD COLUMN source_text TEXT;
CREATE TRIGGER segments_au AFTER UPDATE OF text, speaker ON transcript_segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text, speaker) VALUES ('delete', old.id, old.text, coalesce(old.speaker,''));
  INSERT INTO segments_fts(rowid, text, speaker) VALUES (new.id, new.text, coalesce(new.speaker,''));
END;
`,
  },
  {
    version: 3,
    name: 'automatic application of Claude findings (undoable)',
    sql: `
-- What was applied automatically from one transcript's Claude analysis, with the "before" state needed to undo it.
CREATE TABLE auto_applied (
  transcript_id INTEGER PRIMARY KEY REFERENCES transcripts(id) ON DELETE CASCADE,
  analysis_id INTEGER REFERENCES transcript_analyses(id) ON DELETE SET NULL,
  summary_json TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  undone_at TEXT
);
`,
  },
  {
    version: 4,
    name: 'lesson reviews (Claude scores how well each objective was covered)',
    sql: `
CREATE TABLE lesson_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id TEXT NOT NULL REFERENCES lessons(id),
  transcript_ids TEXT NOT NULL,
  model TEXT,
  overall_score INTEGER,
  review_json TEXT NOT NULL,
  usage_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_lesson_reviews ON lesson_reviews(lesson_id, id);
`,
  },
];
