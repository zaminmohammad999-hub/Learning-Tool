import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import { useAppContext, AiIndicator } from '../App.jsx';
import { Badge, Card, ErrorBox, Field, Loading } from '../components/ui.jsx';

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
                To enable Claude: copy <code>.env.example</code> to <code>.env</code> in the project root, set <code>ANTHROPIC_API_KEY=…</code>, restart <code>npm run dev</code>, then enable AI here. Without a key, transcript paste, rule-based matching, manual mapping, assessments and briefings all still work.
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
