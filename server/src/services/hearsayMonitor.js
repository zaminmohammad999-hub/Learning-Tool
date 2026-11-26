// Reads Hearsay's own log to tell whether a recording is running and whether audio is being captured.
// Only lifecycle lines are parsed (start, stop, no-audio warnings, transcript saved). Transcribed text
// that Hearsay may log is never read into the app or stored.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function hearsayLogDir() {
  if (process.env.HEARSAY_LOG_DIR) return process.env.HEARSAY_LOG_DIR;
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'Hearsay', 'logs') : null;
}

const pad = (n) => String(n).padStart(2, '0');
const LINE = /^(\d{2}):(\d{2}):(\d{2}) \[(\w+)\] ([\w.]+): (.*)$/;
const MAX_READ = 2_000_000;

function readTail(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - MAX_READ);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse lifecycle events from a Hearsay log. Log lines carry only a time of day, and Hearsay keeps
 * writing to the file named after the day it was launched, so one file can span several days.
 * `lastLineDay` is the local date of the LAST line (the file's modification time); earlier lines are
 * dated by walking backwards and stepping back a day whenever the clock time goes up.
 */
export function parseHearsayLog(text, lastLineDay) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (m) rows.push(m);
  }
  const secs = rows.map((m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  const offsets = new Array(rows.length).fill(0);
  for (let i = rows.length - 2; i >= 0; i--) offsets[i] = offsets[i + 1] - (secs[i] > secs[i + 1] ? 1 : 0);
  const events = [];
  for (const [i, m] of rows.entries()) {
    const d = lastLineDay;
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsets[i], Number(m[1]), Number(m[2]), Number(m[3])).toISOString();
    const [, , , , , logger, msg] = m;
    if (logger === 'hearsay.app' && /^Starting recording/.test(msg)) {
      const src = msg.match(/source=(\w+)/);
      events.push({ type: 'start', at, source: src ? src[1] : null });
    } else if (logger === 'hearsay.app' && /^Stopping recording/.test(msg)) events.push({ type: 'stop', at });
    else if (/No audio captured for (\d+)s/.test(msg)) {
      const n = msg.match(/No audio captured for (\d+)s(?: \(source=(\w+)\))?/);
      events.push({ type: 'no_audio', at, seconds: Number(n[1]), source: n[2] || null });
    } else if (/Transcript (?:finalized|saved to)/.test(msg)) events.push({ type: 'saved', at });
  }
  return events;
}

/** Current recording state from the most recently written Hearsay log files. */
export function hearsayStatus(now = new Date()) {
  const dir = hearsayLogDir();
  const base = { log_dir_found: false, recording: false, recording_since: null, source: null, last_no_audio: null, last_saved: null, last_event_at: null };
  if (!dir || !fs.existsSync(dir)) return base;
  let events = [];
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((n) => /^hearsay_.*\.log$/i.test(n))
      .map((n) => ({ f: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtime }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 2);
  } catch {
    /* unreadable folder: report as unknown */
  }
  for (const { f, mtime } of files) {
    try {
      events = events.concat(parseHearsayLog(readTail(f), mtime));
    } catch {
      /* unreadable log: report as unknown */
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  const out = { ...base, log_dir_found: true };
  let lastStart = null;
  for (const e of events) {
    out.last_event_at = e.at;
    if (e.type === 'start') {
      lastStart = e;
      out.last_no_audio = null;
    } else if (e.type === 'stop') {
      lastStart = null;
      out.last_no_audio = null; // warnings only matter for the recording in progress
    }
    else if (e.type === 'no_audio' && lastStart) out.last_no_audio = { at: e.at, seconds: e.seconds, source: e.source };
    else if (e.type === 'saved') out.last_saved = e.at;
  }
  if (lastStart) {
    out.recording = true;
    out.recording_since = lastStart.at;
    out.source = lastStart.source;
  }
  return out;
}

// ───────────── Desktop notifications ─────────────

let notifierOverride = null;
export function setNotifierForTests(fn) {
  notifierOverride = fn;
}

// Title and body are passed through environment variables, never spliced into the script, so text
// from calendar titles cannot inject PowerShell.
const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $xml.GetElementsByTagName('text')
$t.Item(0).AppendChild($xml.CreateTextNode($env:VC_TOAST_TITLE)) > $null
$t.Item(1).AppendChild($xml.CreateTextNode($env:VC_TOAST_BODY)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
`;

function withoutSecrets(env) {
  const copy = { ...env };
  delete copy.ANTHROPIC_API_KEY;
  delete copy.CALENDAR_ICS_URL;
  return copy;
}

/** Show a Windows toast notification. Silently does nothing on other platforms. */
export function notify(title, body) {
  const t = String(title).slice(0, 120);
  const b = String(body).slice(0, 300);
  if (notifierOverride) return notifierOverride(t, b);
  if (process.platform !== 'win32') return;
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', TOAST_SCRIPT], {
      env: { ...withoutSecrets(process.env), VC_TOAST_TITLE: t, VC_TOAST_BODY: b },
      windowsHide: true,
      stdio: 'ignore',
    });
    p.on('error', () => {});
    p.unref();
  } catch {
    /* notifications are best-effort */
  }
}
