import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import { useAppContext, AiIndicator } from '../App.jsx';
import { Badge, Card, ErrorBox, Field, Loading } from '../components/ui.jsx';

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

function AutomationSettings({ s, setS, ai, save, busy, run, done }) {
  const { data: st, reload } = useApi('/automation/status');
  const bool = (k, d = 'false') => (s[k] ?? d) === 'true';
  const toggle = (k) => (e) => setS({ ...s, [k]: e.target.checked ? 'true' : 'false' });
  const keys = ['watch_enabled', 'watch_folder', 'calendar_keyword', 'auto_translate', 'auto_claude_analysis', 'auto_max_usd', 'reminders_enabled', 'translation_model'];
  const after = (m) => {
    done(m);
    reload();
  };
  return (
    <Card title="Automation: calendar, Hearsay & translation" className="automation-card">
      <div className="stack" id="automation">
        <p style={{ fontSize: '0.88rem', margin: 0 }}>
          After each lesson, the server picks up the new transcript from your folder, translates it to English, and proposes matches for you to approve. <strong>Coverage only changes when you approve a match.</strong>
        </p>

        <strong>1. Calendar</strong>
        <p className="faint" style={{ fontSize: '0.82rem', margin: 0 }}>
          In Google Calendar → Settings → your calendar → <em>Integrate calendar</em>, copy the <em>Secret address in iCal format</em> and add <code>CALENDAR_ICS_URL=…</code> to <code>server/.env</code>, then restart. The address is a password: it stays on the server and is never shown, logged or exported.
        </p>
        <div className="row" style={{ fontSize: '0.88rem' }}>
          {st?.calendar.configured ? <Badge status="pass">connected</Badge> : <Badge status="fail">not connected</Badge>}
          <span className="faint">last sync {when(st?.calendar.last_sync)}</span>
          {st?.calendar.configured && (
            <button className="btn small" disabled={busy} onClick={() => run(async () => { const r = await api.post('/automation/calendar/sync'); after(`Calendar synced: ${r.occurrences} lesson event(s), ${r.lesson_dates_updated} lesson date(s) updated.`); })}>
              Sync now
            </button>
          )}
        </div>
        {st?.calendar.last_error && <div className="error" style={{ fontSize: '0.85rem' }}>{st.calendar.last_error}</div>}
        <Field label="Only events whose title contains (keeps private events out)">
          <input type="text" value={s.calendar_keyword ?? 'Vibe Coding'} onChange={(e) => setS({ ...s, calendar_keyword: e.target.value })} />
        </Field>
        <p className="faint" style={{ fontSize: '0.8rem', margin: 0 }}>Put “Lesson 7” in an event title to pin it to a lesson; otherwise upcoming events are matched in order to lessons not yet held. Dates you typed in yourself are never changed.</p>
        {st?.calendar.upcoming?.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem' }}>
            {st.calendar.upcoming.slice(0, 4).map((o) => (
              <li key={o.id}>{when(o.starts_at)}: {o.lesson_id ? `Lesson ${o.lesson_number}` : 'no lesson'} <span className="faint">({o.summary})</span></li>
            ))}
          </ul>
        )}

        <strong>2. Hearsay transcript folder</strong>
        <Field label="Folder Hearsay saves .md transcripts to">
          <input type="text" placeholder="C:\Users\you\Documents\Hearsay" value={s.watch_folder || ''} onChange={(e) => setS({ ...s, watch_folder: e.target.value.trim() })} />
        </Field>
        <label className="row"><input type="checkbox" checked={bool('watch_enabled')} onChange={toggle('watch_enabled')} /> Watch this folder for new recordings</label>
        <p className="faint" style={{ fontSize: '0.8rem', margin: 0 }}>
          Files already in the folder when you switch this on are left alone. A new recording is imported automatically only if it started during a lesson in your calendar; any other recording waits on the Overview for you to import or ignore.
        </p>
        {st && (
          <div className="row" style={{ fontSize: '0.85rem' }}>
            {st.watcher.enabled ? (st.watcher.folder_exists ? <Badge status="pass">watching</Badge> : <Badge status="fail">folder not found</Badge>) : <Badge>off</Badge>}
            <span className="faint">Hearsay log: {st.hearsay.log_dir_found ? 'found' : 'not found'} · last scan {when(st.watcher.last_scan?.at)}</span>
            {st.watcher.enabled && <button className="btn small" disabled={busy} onClick={() => run(async () => { await api.post('/automation/scan'); after('Folder scanned.'); })}>Scan now</button>}
          </div>
        )}

        <strong>3. Translation & analysis</strong>
        <label className="row"><input type="checkbox" checked={bool('auto_translate')} onChange={toggle('auto_translate')} /> Translate Urdu transcripts to English automatically (Claude)</label>
        <label className="row"><input type="checkbox" checked={bool('auto_claude_analysis')} onChange={toggle('auto_claude_analysis')} /> Also run Claude analysis automatically (the free rule-based matcher always runs)</label>
        <div className="grid cols-2">
          <Field label="Automatic spend limit per step (US$)">
            <input type="number" min={0} max={20} step={0.1} value={s.auto_max_usd ?? '1'} onChange={(e) => setS({ ...s, auto_max_usd: e.target.value })} />
          </Field>
          <Field label="Translation model">
            <input type="text" placeholder="claude-sonnet-5-5" value={s.translation_model || ''} onChange={(e) => setS({ ...s, translation_model: e.target.value.trim() })} />
          </Field>
        </div>
        {!ai.available && <div className="notice" style={{ fontSize: '0.85rem' }}>Claude is not enabled ({ai.reason}) Transcripts will still be imported and matched, but Urdu ones stay untranslated until you enable AI and press Translate.</div>}

        <strong>4. Recording reminders</strong>
        <label className="row"><input type="checkbox" checked={bool('reminders_enabled', 'true')} onChange={toggle('reminders_enabled')} /> Windows notifications: 10 min before a lesson, if Hearsay isn't recording once it starts, if Hearsay hears no audio, and to stop recording afterwards</label>
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => save(keys).then(reload)}>Save automation settings</button>
          <button className="btn" disabled={busy} onClick={() => run(async () => { await api.post('/automation/test-notification'); after('Test notification sent. If nothing appeared, check Windows notification settings for PowerShell.'); })}>Send test notification</button>
        </div>
      </div>
    </Card>
  );
}

export default function Settings() {
  const { refreshHealth } = useAppContext();
  const { data, error, loading, reload } = useApi('/settings');
  const { data: backups, reload: reloadBackups } = useApi('/backups');
  const { data: audit, reload: reloadAudit } = useApi('/audit?limit=40');
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const act = useAction();
  useEffect(() => {
    if (data) setS(data.settings);
  }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!s) return null;
  const ai = data.ai;
  const save = (keys) =>
    act.run(async () => {
      await api.patch('/settings', Object.fromEntries(keys.map((k) => [k, s[k] ?? ''])));
      await reload();
      await refreshHealth();
      reloadAudit();
      setMsg('Settings saved.');
    });
  const done = (m) => {
    setMsg(m);
    reload();
    reloadBackups();
    reloadAudit();
    refreshHealth();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Settings & Data</h1>
          <p className="muted">Everything is stored locally in SQLite. The server listens on 127.0.0.1 only by default.</p>
        </div>
        {data.mode === 'demo' && <Badge tone="demo">DEMO MODE</Badge>}
      </div>
      {msg && <div className="notice" role="status" style={{ marginBottom: 12 }}>{msg}</div>}
      <ErrorBox error={act.error} />

      <div className="grid cols-2">
        <Card title="People & programme">
          <div className="stack">
            <Field label="Learner name (used to detect learner lines in transcripts)"><input type="text" value={s.learner_name || ''} onChange={(e) => setS({ ...s, learner_name: e.target.value })} /></Field>
            <Field label="Tutor name (used to detect tutor lines)"><input type="text" value={s.tutor_name || ''} onChange={(e) => setS({ ...s, tutor_name: e.target.value })} /></Field>
            <Field label="Programme start date (week 1, lesson 1). Lesson 2 of each week defaults to +3 days.">
              <input type="date" value={s.programme_start_date || ''} onChange={(e) => setS({ ...s, programme_start_date: e.target.value })} />
            </Field>
            <button className="btn primary" disabled={act.busy} onClick={() => save(['learner_name', 'tutor_name', 'programme_start_date'])}>Save</button>
          </div>
        </Card>

        <Card title="AI (optional)" actions={<AiIndicator ai={ai} />}>
          <div className="stack">
            <p style={{ fontSize: '0.9rem' }}>
              API key: {ai.key_configured ? <Badge status="pass">configured on the server</Badge> : <Badge status="fail">not set</Badge>} <span className="faint">(the key itself is never sent to the browser)</span>
            </p>
            {!ai.key_configured && (
              <div className="notice" style={{ fontSize: '0.88rem' }}>
                To enable Claude: copy <code>server/.env.example</code> to <code>server/.env</code>, set <code>ANTHROPIC_API_KEY=…</code>, restart <code>npm run dev</code>, then enable AI here. Without a key, transcript paste, rule-based matching, manual mapping, assessments and briefings all still work.
              </div>
            )}
            <label className="row"><input type="checkbox" checked={s.ai_enabled === 'true'} onChange={(e) => setS({ ...s, ai_enabled: e.target.checked ? 'true' : 'false' })} /> Enable Claude for transcript analysis and Q&A</label>
            <div className="grid cols-2">
              <Field label="Model (blank = default)"><input type="text" placeholder={ai.model} value={s.ai_model || ''} onChange={(e) => setS({ ...s, ai_model: e.target.value.trim() })} /></Field>
              <Field label="Effort">
                <select value={s.ai_effort} onChange={(e) => setS({ ...s, ai_effort: e.target.value })}>
                  {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x}>{x}</option>)}
                </select>
              </Field>
              <Field label="Chunk size (characters)"><input type="number" value={s.ai_max_chunk_chars} onChange={(e) => setS({ ...s, ai_max_chunk_chars: e.target.value })} /></Field>
              <Field label="Max chunks per transcript"><input type="number" value={s.ai_max_chunks} onChange={(e) => setS({ ...s, ai_max_chunks: e.target.value })} /></Field>
            </div>
            <p className="faint" style={{ fontSize: '0.82rem' }}>
              Cost awareness: ~4 characters ≈ 1 token. A 60-minute transcript (~50k characters) is roughly 15–20k input tokens per analysis
              {ai.pricing_per_mtok && ` — at $${ai.pricing_per_mtok.input}/M input and $${ai.pricing_per_mtok.output}/M output for ${ai.model}, typically well under $0.20`}. Each chat question sends only the retrieved excerpts. An estimate is shown before every Claude analysis.
            </p>
            <button className="btn primary" disabled={act.busy} onClick={() => save(['ai_enabled', 'ai_model', 'ai_effort', 'ai_max_chunk_chars', 'ai_max_chunks'])}>Save AI settings</button>
          </div>
        </Card>

        <AutomationSettings s={s} setS={setS} ai={ai} save={save} busy={act.busy} run={act.run} done={done} />

        <Card title="Backup, export & import">
          <div className="stack">
            <div className="notice warn" style={{ fontSize: '0.88rem' }}>Backups contain private tutoring transcripts, feedback and assessment evidence. Store them somewhere safe and never commit them to Git.</div>
            <div className="row">
              <a className="btn" href="/api/export" download>Download export (.json)</a>
              <button className="btn" disabled={act.busy} onClick={() => act.run(async () => { const b = await api.post('/backups'); done(`Backup written to ${b.path}`); })}>Write backup file to data/backups</button>
            </div>
            <Field label="Import / restore from an export file (replaces all your records)">
              <input
                type="file"
                accept="application/json,.json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (!window.confirm('Importing REPLACES all current progress, transcripts, feedback and assessments with the file contents. Continue?')) return;
                  act.run(async () => {
                    const r = await api.post('/import', JSON.parse(await f.text()));
                    done(`Imported: ${Object.entries(r.imported).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ') || 'nothing'}${r.warnings.length ? ` — ${r.warnings.join(' ')}` : ''}`);
                  });
                }}
              />
            </Field>
            {backups?.length > 0 && (
              <table>
                <tbody>
                  {backups.slice(0, 8).map((b) => (
                    <tr key={b.name}>
                      <td className="mono" style={{ fontSize: '0.8rem' }}>{b.name}</td>
                      <td className="faint">{Math.round(b.bytes / 1024)} KB</td>
                      <td>
                        <button className="btn small" onClick={() => window.confirm(`Restore ${b.name}? This replaces all current records.`) && act.run(async () => { await api.post(`/backups/${b.name}/restore`); done(`Restored ${b.name}`); })}>Restore</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <Card title="Privacy & retention">
          <div className="stack">
            <Field label="Delete transcripts older than N days (0 = keep forever; also applied at server start)">
              <input type="number" min={0} value={s.transcript_retention_days} onChange={(e) => setS({ ...s, transcript_retention_days: e.target.value })} />
            </Field>
            <div className="row">
              <button className="btn" disabled={act.busy} onClick={() => save(['transcript_retention_days'])}>Save retention</button>
              <button className="btn" disabled={act.busy} onClick={() => act.run(async () => { const r = await api.post('/data/retention/apply'); done(r.message || `Deleted ${r.deleted} transcript(s). ${r.note || ''}`); })}>Apply now</button>
            </div>
            <hr />
            <Field label='Delete ALL stored transcripts — type "DELETE ALL TRANSCRIPTS"'>
              <input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            </Field>
            <button className="btn danger" disabled={confirmText !== 'DELETE ALL TRANSCRIPTS' || act.busy} onClick={() => act.run(async () => { const r = await api.post('/data/transcripts/delete-all', { confirm: confirmText }); setConfirmText(''); done(`Deleted ${r.deleted} transcript(s). ${r.note}`); })}>
              Delete all transcripts
            </button>
          </div>
        </Card>

        <Card title="Demo data">
          <p style={{ fontSize: '0.9rem' }}>
            Demo mode switches to a <strong>separate database file</strong> (<code>data/db/demo.sqlite</code>) filled with clearly labelled synthetic records. Your real data is never mixed with it. Demo mode resets to real data when the server restarts.
          </p>
          <button className="btn" disabled={act.busy} onClick={() => act.run(async () => { const r = await api.post('/data/demo-mode', { enabled: data.mode !== 'demo' }); done(`Now using ${r.mode === 'demo' ? 'DEMO' : 'your real'} data.`); })}>
            {data.mode === 'demo' ? 'Exit demo mode' : 'Enter demo mode'}
          </button>
        </Card>

        <Card title="Recent audit log">
          {audit?.length ? (
            <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td className="faint" style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>{a.created_at.slice(0, 16).replace('T', ' ')}</td>
                      <td style={{ fontSize: '0.85rem' }}>{a.entity_type} {a.entity_id}</td>
                      <td style={{ fontSize: '0.85rem' }}>{a.action}</td>
                      <td className="faint" style={{ fontSize: '0.8rem' }}>{a.actor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="faint">No changes recorded yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
