// After-lesson automation: watch the transcripts folder (Hearsay output), import recordings made during a
// calendar lesson, translate them to English, and propose evidence matches for review.
//
// Safety rules:
// - Nothing changes learning progress automatically. Analyses only PROPOSE matches; you approve them.
// - Files that existed before watching was turned on are never imported automatically.
// - A file is imported automatically only when its recording time falls inside a lesson in your calendar
//   (whose title contains your keyword). Anything else waits in the inbox for you to import or ignore.
// - Claude is only called automatically if you enabled it, and never above the cost cap you set.
// - Automation is paused in demo mode so demo data and real recordings never mix.
import fs from 'node:fs';
import path from 'node:path';
import { getDb, getMode, nowIso } from '../db/connection.js';
import { HttpError, audit, getSetting, notFound } from './common.js';
import { ALLOWED_EXTENSIONS, addTranscript, checksumOf, createSession, getTranscript, hearsayFinalised, transcriptMeta, validateTranscriptText } from './transcripts.js';
import { runAnalysis, analysisCostEstimate } from './analysis.js';
import { aiStatus } from './aiClient.js';
import { translateTranscript, translationEstimate } from './translation.js';
import { calendarConfigured, calendarStatus, currentOrNextOccurrence, nextPlannedLessonId, occurrenceAt, syncCalendar } from './calendar.js';
import { hearsayStatus, notify } from './hearsayMonitor.js';
import { config } from '../config.js';

const db = () => getDb();
const SETTLE_MS = 15_000; // file must be unchanged this long before reading
const UNFINALISED_GRACE_MS = 10 * 60_000; // a Hearsay file without its footer is still being written
const FINAL = new Set(['imported', 'ignored', 'duplicate']);

const setting = (k, d) => getSetting(k, d);
const flag = (k, d = 'false') => setting(k, d) === 'true';
/** Learner and tutor names from Settings, used to personalise reminders and session titles. */
const realName = (v, placeholder) => { const n = (v || '').trim(); return n.toLowerCase() === placeholder ? '' : n; };
const who = () => ({ learner: realName(setting('learner_name', ''), 'learner'), tutor: realName(setting('tutor_name', ''), 'tutor') });

export function watcherSettings() {
  return {
    enabled: flag('watch_enabled'),
    folder: setting('watch_folder', '') || '',
    since: setting('watch_since', null),
    auto_translate: flag('auto_translate'),
    auto_claude_analysis: flag('auto_claude_analysis'),
    auto_max_usd: Number(setting('auto_max_usd', '1')),
    reminders_enabled: flag('reminders_enabled', 'true'),
  };
}

const localDate = (iso) => new Date(iso).toLocaleDateString('en-CA');
const localTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function upsertFile(p, fields) {
  const now = nowIso();
  const existing = db().prepare('SELECT * FROM watched_files WHERE path = ?').get(p);
  if (!existing) {
    const cols = ['path', 'filename', 'detected_at', 'updated_at', ...Object.keys(fields)];
    const vals = [p, path.basename(p), now, now, ...Object.values(fields)];
    db().prepare(`INSERT INTO watched_files (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  } else {
    const keys = Object.keys(fields);
    db()
      .prepare(`UPDATE watched_files SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(fields), now, existing.id);
  }
  return db().prepare('SELECT * FROM watched_files WHERE path = ?').get(p);
}

let scanning = false;
let lastScan = { at: null, error: null, result: null };

/** One pass over the watched folder. Safe to call repeatedly; already-handled files are skipped. */
export async function scanFolder({ now = new Date() } = {}) {
  if (getMode() === 'demo') return { skipped: 'demo mode' };
  const s = watcherSettings();
  if (!s.enabled || !s.folder) return { skipped: 'folder watching is off' };
  if (scanning) return { skipped: 'scan already running' };
  scanning = true;
  const result = { seen: 0, imported: 0, needs_review: 0, waiting: 0, ignored: 0 };
  try {
    if (!fs.existsSync(s.folder) || !fs.statSync(s.folder).isDirectory()) throw new HttpError(400, `Watched folder not found: ${s.folder}`);
    const names = fs.readdirSync(s.folder).filter((n) => ALLOWED_EXTENSIONS.includes(path.extname(n).toLowerCase()));
    for (const name of names) {
      const p = path.join(s.folder, name);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      result.seen++;
      const mtime = st.mtime.toISOString();
      const row = db().prepare('SELECT * FROM watched_files WHERE path = ?').get(p);
      if (row && FINAL.has(row.status)) continue; // handled (a later edit to an imported file is not re-imported)
      if (row && row.status === 'needs_review' && row.mtime === mtime && row.size === st.size) continue; // waiting for you
      if (st.size > config.maxTranscriptBytes) {
        upsertFile(p, { size: st.size, mtime, status: 'error', reason: 'File is larger than the transcript size limit.' });
        continue;
      }
      // Files that were already there when watching was switched on are yours to import by hand.
      if (!row && s.since && mtime < s.since) {
        upsertFile(p, { size: st.size, mtime, status: 'ignored', reason: 'Already in the folder before watching was turned on. Use "Import" if you want it.' });
        result.ignored++;
        continue;
      }
      if (now.getTime() - st.mtime.getTime() < SETTLE_MS) {
        upsertFile(p, { size: st.size, mtime, status: 'waiting', reason: 'File is still being written.' });
        result.waiting++;
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch (err) {
        upsertFile(p, { size: st.size, mtime, status: 'error', reason: `Could not read file (${err.code || 'error'}).` });
        continue;
      }
      const meta = transcriptMeta(text, name);
      if (meta.hearsay && !hearsayFinalised(text) && now.getTime() - st.mtime.getTime() < UNFINALISED_GRACE_MS) {
        upsertFile(p, { size: st.size, mtime, status: 'waiting', reason: 'Hearsay is still recording or saving this transcript.', recorded_at: meta.recorded_at });
        result.waiting++;
        continue;
      }
      const recordedAt = meta.recorded_at || mtime;
      const occ = occurrenceAt(recordedAt);
      const base = { size: st.size, mtime, recorded_at: recordedAt, duration_minutes: meta.duration_minutes };
      if (!occ) {
        const reason = calendarConfigured()
          ? `Recorded ${localDate(recordedAt)} ${localTime(recordedAt)}, which is not during a lesson in your calendar. Import it if it was a lesson.`
          : 'No calendar connected, so the lesson could not be confirmed. Choose the lesson and import, or ignore.';
        const prev = row?.status;
        upsertFile(p, { ...base, status: 'needs_review', reason, lesson_id: nextPlannedLessonId() });
        if (prev !== 'needs_review') result.needs_review++;
        continue;
      }
      const lessonId = occ.lesson_id || nextPlannedLessonId();
      const f = upsertFile(p, { ...base, status: 'waiting', reason: 'Importing…', lesson_id: lessonId, calendar_event_id: occ.id });
      await importWatchedFile(f.id, { lesson_id: lessonId, actor: 'automation', text });
      result.imported++;
    }
    lastScan = { at: nowIso(), error: null, result };
    return result;
  } catch (err) {
    lastScan = { at: nowIso(), error: err.message, result: null };
    throw err;
  } finally {
    scanning = false;
  }
}

/** Import one watched file as a session + transcript, then run the pipeline. Used by the scanner and the inbox. */
export async function importWatchedFile(fileId, { lesson_id, actor = 'user', text } = {}) {
  const f = db().prepare('SELECT * FROM watched_files WHERE id = ?').get(fileId);
  if (!f) throw notFound(`Watched file ${fileId}`);
  if (f.status === 'imported') throw new HttpError(409, 'This file was already imported.');
  if (lesson_id && !db().prepare('SELECT 1 FROM lessons WHERE id = ?').get(lesson_id)) throw new HttpError(400, `Unknown lesson ${lesson_id}`);
  let body = text;
  if (body == null) {
    if (!fs.existsSync(f.path)) throw new HttpError(404, 'The file no longer exists in the folder.');
    body = fs.readFileSync(f.path, 'utf8');
  }
  validateTranscriptText(body);
  const dup = db().prepare('SELECT id, session_id FROM transcripts WHERE checksum = ?').get(checksumOf(body));
  if (dup) {
    db().prepare("UPDATE watched_files SET status = 'duplicate', reason = ?, transcript_id = ?, session_id = ?, updated_at = ? WHERE id = ?").run(
      `Already imported as transcript #${dup.id}.`,
      dup.id,
      dup.session_id,
      nowIso(),
      fileId
    );
    return { status: 'duplicate', transcript_id: dup.id };
  }
  const meta = transcriptMeta(body, f.filename);
  const recordedAt = meta.recorded_at || f.recorded_at || f.mtime || nowIso();
  const lessonIds = lesson_id ? [lesson_id] : [];
  const session = createSession(
    {
      session_date: localDate(recordedAt),
      duration_minutes: meta.duration_minutes,
      tutor: getSetting('tutor_name') || null,
      title: `${lesson_id ? `Lesson ${Number(lesson_id.slice(1))}` : 'Recording'}${who().tutor ? ` with ${who().tutor}` : ''} · ${localTime(recordedAt)}`,
      notes: `Imported automatically from ${f.filename}.`,
      lesson_ids: lessonIds,
    },
    actor
  );
  const t = addTranscript({ session_id: session.id, text: body, filename: f.filename, recorded_at: recordedAt }, actor);
  if (f.calendar_event_id && lesson_id)
    db().prepare("UPDATE calendar_events SET lesson_id = ?, assigned_by = 'transcript' WHERE id = ?").run(lesson_id, f.calendar_event_id);
  db().prepare("UPDATE watched_files SET status = 'imported', reason = NULL, transcript_id = ?, session_id = ?, lesson_id = ?, updated_at = ? WHERE id = ?").run(
    t.id,
    session.id,
    lesson_id || null,
    nowIso(),
    fileId
  );
  audit('watched_file', fileId, 'imported', undefined, { transcript_id: t.id, session_id: session.id, lesson_id }, actor);
  const steps = await runPipeline(t.id, actor);
  db().prepare('UPDATE watched_files SET pipeline_json = ? WHERE id = ?').run(JSON.stringify(steps), fileId);
  const pending = db().prepare("SELECT COUNT(*) n FROM evidence_matches WHERE transcript_id = ? AND review_status = 'pending'").get(t.id).n;
  notify(
    `${lesson_id ? `Lesson ${Number(lesson_id.slice(1))}` : 'New'} transcript imported`,
    `${who().learner ? `${who().learner}, ` : ''}${pending} proposed match(es) from ${who().tutor ? `${who().tutor}'s lesson` : 'the lesson'} are ready to review in the Command Centre.${steps.some((x) => x.status === 'skipped' && x.step === 'translate') ? ' Translation still needed.' : ''}`
  );
  return { status: 'imported', transcript_id: t.id, session_id: session.id, steps };
}

export function ignoreWatchedFile(fileId, actor = 'user') {
  const f = db().prepare('SELECT * FROM watched_files WHERE id = ?').get(fileId);
  if (!f) throw notFound(`Watched file ${fileId}`);
  if (f.status === 'imported') throw new HttpError(409, 'This file was already imported; delete the transcript instead.');
  db().prepare("UPDATE watched_files SET status = 'ignored', reason = 'Ignored by you.', updated_at = ? WHERE id = ?").run(nowIso(), fileId);
  audit('watched_file', fileId, 'ignored', undefined, { filename: f.filename }, actor);
  return db().prepare('SELECT * FROM watched_files WHERE id = ?').get(fileId);
}

/**
 * After import: translate (if needed and allowed) → rule-based analysis → optional Claude analysis.
 * Each step is recorded; a failing step never undoes the import.
 */
export async function runPipeline(transcriptId, actor = 'automation') {
  const s = watcherSettings();
  const steps = [];
  const ai = aiStatus();
  let t = getTranscript(transcriptId, { includeSegments: false });
  if (t.translation_status === 'needed' || t.translation_status === 'failed') {
    if (!ai.available) steps.push({ step: 'translate', status: 'skipped', reason: 'Claude is not enabled, so the transcript stays in Urdu. Enable AI, then press Translate.' });
    else if (!s.auto_translate) steps.push({ step: 'translate', status: 'skipped', reason: 'Automatic translation is off. Press Translate on the transcript.' });
    else {
      const est = translationEstimate(transcriptId);
      if (est.approx_usd != null && est.approx_usd > s.auto_max_usd)
        steps.push({ step: 'translate', status: 'skipped', reason: `Estimated $${est.approx_usd} is above your automatic limit of $${s.auto_max_usd}.` });
      else {
        try {
          const r = await translateTranscript(transcriptId, actor);
          steps.push({ step: 'translate', status: 'done', detail: `${r.translated}/${r.segments} lines with ${r.model}` });
        } catch (err) {
          steps.push({ step: 'translate', status: 'failed', reason: err.message });
        }
      }
    }
    t = getTranscript(transcriptId, { includeSegments: false });
  }
  try {
    const a = await runAnalysis(transcriptId, 'rule_based', actor);
    steps.push({ step: 'rule_based_analysis', status: 'done', detail: `${a.matches.length} proposed match(es)`, analysis_id: a.id });
  } catch (err) {
    steps.push({ step: 'rule_based_analysis', status: 'failed', reason: err.message });
  }
  const english = ['not_needed', 'done', 'partial'].includes(t.translation_status);
  if (s.auto_claude_analysis && ai.available && english) {
    const est = analysisCostEstimate(transcriptId);
    if (est.approx_usd != null && est.approx_usd > s.auto_max_usd)
      steps.push({ step: 'claude_analysis', status: 'skipped', reason: `Estimated $${est.approx_usd} is above your automatic limit of $${s.auto_max_usd}.` });
    else {
      try {
        const a = await runAnalysis(transcriptId, 'claude', actor);
        steps.push({ step: 'claude_analysis', status: 'done', detail: `${a.matches.length} proposed match(es)`, analysis_id: a.id });
      } catch (err) {
        steps.push({ step: 'claude_analysis', status: 'failed', reason: err.message });
      }
    }
  }
  audit('transcript', transcriptId, 'pipeline', undefined, { steps }, actor);
  return steps;
}

// ───────────── Recording reminders ─────────────

const sentReminders = new Set();

/** What the learner should be told right now about recording the current/next lesson. */
export function recordingAlert(now = new Date()) {
  if (!calendarConfigured()) return null;
  const occ = currentOrNextOccurrence(now);
  if (!occ) return null;
  const hs = hearsayStatus(now);
  const start = new Date(occ.starts_at).getTime();
  const end = new Date(occ.ends_at).getTime();
  const t = now.getTime();
  const label = (occ.lesson_id ? `Lesson ${Number(occ.lesson_id.slice(1))}` : 'Your lesson') + (who().tutor ? ` with ${who().tutor}` : '');
  const hi = who().learner ? `${who().learner}, ` : '';
  const at = localTime(occ.starts_at);
  const recordingThis = hs.recording && new Date(hs.recording_since).getTime() >= start - 30 * 60000;
  if (t >= start - 10 * 60000 && t < start && !hs.recording)
    return { key: `pre:${occ.id}`, level: 'info', title: `${label} starts at ${at}`, body: `${hi}open Hearsay and press Record (audio source: microphone + system audio).` };
  if (t >= start + 2 * 60000 && t < end && !recordingThis)
    return { key: `late:${occ.id}`, level: 'warn', title: `${label} started at ${at}. Hearsay is not recording`, body: `${hi}start recording in Hearsay now so this lesson can be analysed.` };
  if (t >= start && t < end && recordingThis && hs.last_no_audio && new Date(hs.last_no_audio.at).getTime() >= start)
    return {
      key: `noaudio:${occ.id}:${hs.last_no_audio.at}`,
      level: 'warn',
      title: 'Hearsay is capturing no audio',
      body: `No sound for ${Math.round(hs.last_no_audio.seconds / 60)} min${hs.last_no_audio.source ? ` from the ${hs.last_no_audio.source}` : ''}. Check the audio source in Hearsay settings.`,
    };
  if (t >= end + 5 * 60000 && t < end + 60 * 60000 && recordingThis)
    return { key: `end:${occ.id}`, level: 'info', title: `${label} has ended`, body: `${hi}stop the Hearsay recording so the transcript is saved and imported.` };
  return null;
}

export function reminderTick(now = new Date()) {
  if (getMode() === 'demo' || !watcherSettings().reminders_enabled) return null;
  const alert = recordingAlert(now);
  if (alert && !sentReminders.has(alert.key)) {
    sentReminders.add(alert.key);
    notify(alert.title, alert.body);
  }
  return alert;
}

// ───────────── Status & timers ─────────────

export function automationStatus(now = new Date()) {
  const s = watcherSettings();
  const files = db()
    .prepare(
      `SELECT w.id, w.filename, w.status, w.reason, w.recorded_at, w.duration_minutes, w.lesson_id, w.transcript_id, w.session_id, w.pipeline_json, w.updated_at,
              t.language, t.translation_status
       FROM watched_files w LEFT JOIN transcripts t ON t.id = w.transcript_id
       ORDER BY COALESCE(w.recorded_at, w.detected_at) DESC LIMIT 40`
    )
    .all()
    .map((f) => ({ ...f, pipeline: f.pipeline_json ? JSON.parse(f.pipeline_json) : null, pipeline_json: undefined }));
  return {
    mode: getMode(),
    paused: getMode() === 'demo',
    watcher: { ...s, folder_exists: Boolean(s.folder) && fs.existsSync(s.folder), last_scan: lastScan },
    calendar: calendarStatus(now),
    hearsay: hearsayStatus(now),
    alert: getMode() === 'demo' ? null : recordingAlert(now),
    files,
    inbox_count: files.filter((f) => f.status === 'needs_review').length,
    ai: { available: aiStatus().available },
  };
}

let timers = [];
let fsWatcher = null;
let watchedPath = null;
let debounce = null;

function logErr(where) {
  return (err) => console.error(`[automation] ${where}: ${err.message}`);
}

/** Point fs.watch at the configured folder (re-called when settings change). Polling remains the backstop. */
export function refreshFolderWatch() {
  const { enabled, folder } = watcherSettings();
  const want = enabled && folder && fs.existsSync(folder) ? folder : null;
  if (want === watchedPath) return;
  if (fsWatcher) fsWatcher.close();
  fsWatcher = null;
  watchedPath = want;
  if (!want) return;
  try {
    fsWatcher = fs.watch(want, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => scanFolder().catch(logErr('scan')), SETTLE_MS + 2000);
      debounce.unref();
    });
    fsWatcher.on('error', () => {});
    fsWatcher.unref();
  } catch {
    fsWatcher = null;
  }
}

export function startAutomation() {
  stopAutomation();
  refreshFolderWatch();
  const syncIfConfigured = () => {
    if (getMode() !== 'demo' && calendarConfigured()) syncCalendar().catch(logErr('calendar sync'));
  };
  syncIfConfigured();
  scanFolder().catch(logErr('scan'));
  timers.push(setInterval(() => scanFolder().catch(logErr('scan')), 60_000));
  timers.push(setInterval(syncIfConfigured, 15 * 60_000));
  timers.push(
    setInterval(() => {
      try {
        reminderTick();
      } catch (err) {
        logErr('reminder')(err);
      }
    }, 60_000)
  );
  timers.forEach((t) => t.unref());
}

export function stopAutomation() {
  timers.forEach(clearInterval);
  timers = [];
  if (fsWatcher) fsWatcher.close();
  fsWatcher = null;
  watchedPath = null;
}

export function _resetForTests() {
  stopAutomation();
  clearTimeout(debounce);
  sentReminders.clear();
  lastScan = { at: null, error: null, result: null };
  scanning = false;
}
