// Calendar sync from the learner's private Google Calendar iCal address ("Secret address in iCal format").
// The URL is a secret: it is read only from the CALENDAR_ICS_URL environment variable and is never
// stored in the database, exported, logged or sent to the browser.
import ical from 'node-ical';
import { getDb, nowIso, tx } from '../db/connection.js';
import { HttpError, audit, getSetting } from './common.js';
import { updateLessonProgress } from './progress.js';

const db = () => getDb();
const DAY = 86400000;
// A recording that starts this long before a lesson, or any time until it ends, belongs to that lesson.
export const EARLY_GRACE_MIN = 30;
const MAX_ICS_BYTES = 5_000_000;

let fetchOverride = null;
/** Tests inject the iCal text instead of fetching a URL. */
export function setCalendarSourceForTests(fn) {
  fetchOverride = fn;
}

export function calendarConfigured() {
  return Boolean(fetchOverride) || Boolean(process.env.CALENDAR_ICS_URL && process.env.CALENDAR_ICS_URL.trim());
}

export function calendarKeyword() {
  return (getSetting('calendar_keyword') ?? 'Vibe Coding').trim();
}

async function fetchIcs() {
  if (fetchOverride) return fetchOverride();
  let url = process.env.CALENDAR_ICS_URL.trim();
  if (url.startsWith('webcal://')) url = `https://${url.slice('webcal://'.length)}`;
  if (!/^https:\/\//i.test(url)) throw new HttpError(400, 'CALENDAR_ICS_URL must be an https:// (or webcal://) address.');
  const resp = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
  // Never echo the URL in errors: it is a secret.
  if (!resp.ok) throw new HttpError(502, `Calendar feed returned HTTP ${resp.status}. Check CALENDAR_ICS_URL in .env.`);
  const text = await resp.text();
  if (text.length > MAX_ICS_BYTES) throw new HttpError(413, 'Calendar feed is larger than 5 MB.');
  if (!/BEGIN:VCALENDAR/.test(text)) throw new HttpError(502, 'Calendar address did not return iCal data. Use the "Secret address in iCal format".');
  return text;
}

/**
 * Lesson number written in an event title, e.g. "Vibe Coding — Lesson 7" or "VC L07".
 * "Session 3" is deliberately NOT treated as a lesson number: people number their meetings
 * differently from the curriculum (and repeat them), so only an explicit "Lesson N" / "LN" pins.
 */
export function lessonFromTitle(summary) {
  const m = String(summary || '').match(/\b(?:lesson\s*#?\s*|L)0?(\d{1,2})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 24 ? `L${String(n).padStart(2, '0')}` : null;
}

const summaryText = (s) => (typeof s === 'string' ? s : s?.val ? String(s.val) : String(s ?? ''));

/** Expand iCal text into concrete, timed, non-cancelled occurrences whose title contains the keyword. */
export function expandOccurrences(icsText, { from, to, keyword }) {
  const data = ical.sync.parseICS(icsText);
  const kw = keyword.toLowerCase();
  const out = [];
  for (const ev of Object.values(data)) {
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, { from, to });
    } catch {
      continue;
    }
    for (const inst of instances) {
      const summary = summaryText(inst.summary ?? ev.summary);
      if (inst.isFullDay) continue;
      if (String(inst.event?.status || '').toUpperCase() === 'CANCELLED') continue;
      if (!summary.toLowerCase().includes(kw)) continue;
      const start = new Date(inst.start);
      const end = inst.end ? new Date(inst.end) : new Date(start.getTime() + 60 * 60000);
      if (Number.isNaN(start.getTime())) continue;
      out.push({ uid: String(ev.uid || summary), starts_at: start.toISOString(), ends_at: end.toISOString(), summary: summary.slice(0, 200) });
    }
  }
  // A RECURRENCE-ID override can duplicate a base instance; keep one per (uid, start).
  const seen = new Set();
  return out
    .filter((o) => {
      const k = `${o.uid}|${o.starts_at}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

const localDate = (iso) => new Date(iso).toLocaleDateString('en-CA');
const localTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function setInternal(key, value) {
  db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * Pull the calendar, store occurrences, assign them to lessons and fill planned dates.
 * Assignment: a lesson number in the title wins; occurrences already tied to a recorded transcript or a
 * user choice keep their lesson; remaining FUTURE occurrences are mapped in order onto the planned
 * (not yet held/missed) lessons. Only lesson dates that are empty or came from the calendar are changed.
 */
export async function syncCalendar({ now = new Date(), actor = 'calendar-sync' } = {}) {
  if (!calendarConfigured()) throw new HttpError(400, 'No calendar connected. Add CALENDAR_ICS_URL to .env and restart the app.');
  const keyword = calendarKeyword();
  if (keyword.length < 3) throw new HttpError(400, 'Set a lesson title keyword (3+ characters) in Settings, so private events are never imported.');
  let occurrences;
  try {
    const text = await fetchIcs();
    occurrences = expandOccurrences(text, { from: new Date(now.getTime() - 180 * DAY), to: new Date(now.getTime() + 180 * DAY), keyword });
  } catch (err) {
    const msg = err instanceof HttpError ? err.message : `Could not read the calendar feed (${err.name || 'error'}).`;
    setInternal('calendar_last_error', msg);
    throw err instanceof HttpError ? err : new HttpError(502, msg);
  }
  const syncedAt = nowIso();
  const nowIsoStr = now.toISOString();
  const result = tx((d) => {
    const up = d.prepare(
      `INSERT INTO calendar_events (uid, starts_at, ends_at, summary, cancelled, synced_at) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(uid, starts_at) DO UPDATE SET ends_at = excluded.ends_at, summary = excluded.summary, cancelled = 0, synced_at = excluded.synced_at`
    );
    occurrences.forEach((o) => up.run(o.uid, o.starts_at, o.ends_at, o.summary, syncedAt));
    // Anything in the window that the feed no longer lists was deleted or moved.
    const cancelled = d.prepare('UPDATE calendar_events SET cancelled = 1 WHERE synced_at <> ? AND cancelled = 0').run(syncedAt).changes;

    const rows = d.prepare('SELECT * FROM calendar_events WHERE cancelled = 0 ORDER BY starts_at').all();
    const setLesson = d.prepare('UPDATE calendar_events SET lesson_id = ?, assigned_by = ? WHERE id = ?');
    const hard = new Set();
    for (const r of rows) {
      const fromTitle = lessonFromTitle(r.summary);
      if (fromTitle) {
        setLesson.run(fromTitle, 'title', r.id);
        r.lesson_id = fromTitle;
        r.assigned_by = 'title';
      } else if (r.assigned_by === 'title') {
        // The title no longer names a lesson (renamed event, or an older rule): release the pin.
        setLesson.run(null, null, r.id);
        r.lesson_id = null;
        r.assigned_by = null;
      }
      if (r.lesson_id && ['title', 'transcript', 'user'].includes(r.assigned_by)) hard.add(r.lesson_id);
    }
    const planned = d
      .prepare("SELECT l.id FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id WHERE lp.status = 'planned' AND COALESCE(lp.schedule_source, '') <> 'manual' ORDER BY l.number")
      .all()
      .map((x) => x.id)
      .filter((id) => !hard.has(id));
    let i = 0;
    for (const r of rows) {
      if (['title', 'transcript', 'user'].includes(r.assigned_by)) continue;
      if (r.starts_at > nowIsoStr) {
        const lid = planned[i++] || null;
        setLesson.run(lid, lid ? 'sequence' : null, r.id);
        r.lesson_id = lid;
      } else if (r.assigned_by === 'sequence') {
        // A past occurrence with no recording: let the remaining lessons move to the next slots.
        setLesson.run(null, null, r.id);
        r.lesson_id = null;
      }
    }
    return { rows, cancelled };
  });

  // Fill planned dates for upcoming lessons (never overriding a date the learner typed in).
  const upcoming = new Map();
  result.rows.filter((r) => r.lesson_id && r.ends_at > nowIsoStr).forEach((r) => !upcoming.has(r.lesson_id) && upcoming.set(r.lesson_id, r));
  let datesSet = 0;
  const progressRows = db().prepare('SELECT lesson_id, status, scheduled_date, scheduled_time, schedule_source FROM lesson_progress').all();
  for (const lp of progressRows) {
    if (lp.status !== 'planned' || lp.schedule_source === 'manual') continue;
    const occ = upcoming.get(lp.lesson_id);
    const date = occ ? localDate(occ.starts_at) : null;
    const time = occ ? localTime(occ.starts_at) : null;
    if (!occ && lp.schedule_source !== 'calendar') continue;
    if (lp.scheduled_date === date && lp.scheduled_time === time) continue;
    if (lp.scheduled_date !== date) updateLessonProgress(lp.lesson_id, { scheduled_date: date || '' }, actor);
    db().prepare('UPDATE lesson_progress SET schedule_source = ?, scheduled_time = ? WHERE lesson_id = ?').run(occ ? 'calendar' : null, time, lp.lesson_id);
    datesSet++;
  }
  setInternal('calendar_last_sync', syncedAt);
  setInternal('calendar_last_error', '');
  const summary = { occurrences: occurrences.length, cancelled: result.cancelled, lesson_dates_updated: datesSet };
  audit('calendar', null, 'sync', undefined, summary, actor);
  return summary;
}

/** The lesson occurrence a recording started in (from EARLY_GRACE_MIN before the start until the end). */
export function occurrenceAt(iso) {
  const t = new Date(iso).getTime();
  const early = new Date(t + EARLY_GRACE_MIN * 60000).toISOString();
  return (
    db()
      .prepare('SELECT * FROM calendar_events WHERE cancelled = 0 AND starts_at <= ? AND ends_at >= ? ORDER BY starts_at LIMIT 1')
      .get(early, new Date(t).toISOString()) || null
  );
}

/** Current or next lesson occurrence. */
export function currentOrNextOccurrence(now = new Date()) {
  return db().prepare('SELECT * FROM calendar_events WHERE cancelled = 0 AND ends_at > ? ORDER BY starts_at LIMIT 1').get(now.toISOString()) || null;
}

export function upcomingOccurrences(now = new Date(), limit = 6) {
  return db()
    .prepare(
      `SELECT ce.id, ce.starts_at, ce.ends_at, ce.summary, ce.lesson_id, ce.assigned_by, l.number AS lesson_number, l.title AS lesson_title
       FROM calendar_events ce LEFT JOIN lessons l ON l.id = ce.lesson_id
       WHERE ce.cancelled = 0 AND ce.ends_at > ? ORDER BY ce.starts_at LIMIT ?`
    )
    .all(now.toISOString(), limit);
}

/** First lesson not yet held or missed: where a new recording most likely belongs. */
export function nextPlannedLessonId() {
  return (
    db().prepare("SELECT l.id FROM lessons l JOIN lesson_progress lp ON lp.lesson_id = l.id WHERE lp.status = 'planned' ORDER BY l.number LIMIT 1").get()?.id || null
  );
}

export function calendarStatus(now = new Date()) {
  return {
    configured: calendarConfigured(),
    keyword: calendarKeyword(),
    last_sync: getSetting('calendar_last_sync') || null,
    last_error: getSetting('calendar_last_error') || null,
    upcoming: calendarConfigured() ? upcomingOccurrences(now) : [],
  };
}
