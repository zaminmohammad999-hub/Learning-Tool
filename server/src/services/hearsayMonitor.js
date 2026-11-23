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
const logNameFor = (d) => `hearsay_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`;
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

/** Parse lifecycle events from one day's log text. `day` gives the local date the times belong to. */
export function parseHearsayLog(text, day) {
  const events = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[1]), Number(m[2]), Number(m[3])).toISOString();
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

/** Current recording state from today's (and, just after midnight, yesterday's) Hearsay log. */
export function hearsayStatus(now = new Date()) {
  const dir = hearsayLogDir();
  const base = { log_dir_found: false, recording: false, recording_since: null, source: null, last_no_audio: null, last_saved: null, last_event_at: null };
  if (!dir || !fs.existsSync(dir)) return base;
  const days = [new Date(now.getTime() - 86400000), now];
  let events = [];
  for (const d of days) {
    const f = path.join(dir, logNameFor(d));
    if (fs.existsSync(f)) {
      try {
        events = events.concat(parseHearsayLog(readTail(f), d));
      } catch {
        /* unreadable log: report as unknown */
      }
    }
  }
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
