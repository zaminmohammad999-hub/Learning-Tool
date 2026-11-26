import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import { Badge, Card, ErrorBox } from './ui.jsx';

const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const FILE_TONE = { imported: 'good', needs_review: 'warn', waiting: 'info', ignored: '', duplicate: '', error: 'bad' };
const FILE_LABEL = { imported: 'imported', needs_review: 'needs your decision', waiting: 'waiting', ignored: 'ignored', duplicate: 'duplicate', error: 'error' };
const LESSONS = Array.from({ length: 24 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`);

function InboxRow({ f, onDone }) {
  const [lesson, setLesson] = useState(f.lesson_id || '');
  const act = useAction();
  return (
    <li style={{ marginBottom: 8 }}>
      <div className="row between">
        <span>
          <strong>{fmt(f.recorded_at)}</strong>
          {f.duration_minutes ? ` · ${f.duration_minutes} min` : ''} <span className="faint mono" style={{ fontSize: '0.78rem' }}>{f.filename}</span>
        </span>
        <span className="row" style={{ gap: 6 }}>
          <select aria-label={`Lesson for ${f.filename}`} value={lesson} onChange={(e) => setLesson(e.target.value)}>
            <option value="">No lesson</option>
            {LESSONS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button className="btn small primary" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/automation/files/${f.id}/import`, { lesson_id: lesson || null }); onDone(); })}>
            {act.busy ? 'Importing…' : 'Import'}
          </button>
          <button className="btn small" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/automation/files/${f.id}/ignore`); onDone(); })}>Ignore</button>
        </span>
      </div>
      <div className="faint" style={{ fontSize: '0.8rem' }}>{f.reason}</div>
      <ErrorBox error={act.error} />
    </li>
  );
}

/** What was filled in automatically from one lesson's transcript, with a one-click Undo. */
export function AutoApplied({ f, onDone }) {
  const act = useAction();
  const s = f.auto_summary;
  if (!s || !f.transcript_id) return null;
  if (f.auto_undone_at)
    return <div className="faint" style={{ fontSize: '0.78rem' }}>Automatic updates were undone; the findings are waiting in Review lessons.</div>;
  const parts = [`${s.approved.length} exercise update(s)`];
  if (s.lessons_held.length) parts.push(`${s.lessons_held.join(', ')} marked Held`);
  if (s.feedback_id) parts.push('feedback and homework added');
  return (
    <div style={{ fontSize: '0.8rem', marginTop: 2 }}>
      <Badge tone="info">auto</Badge> Filled in: {parts.join(', ')}
      {s.left_for_review.length ? ` · ${s.left_for_review.length} left for you to check` : ''}{' '}
      <button
        className="btn small"
        disabled={act.busy}
        onClick={() =>
          window.confirm('Undo the automatic updates from this lesson? The findings go back to Review lessons for you to decide.') &&
          act.run(async () => {
            await api.post(`/transcripts/${f.transcript_id}/auto-apply/undo`);
            onDone();
          })
        }
      >
        Undo
      </button>
      <ErrorBox error={act.error} />
    </div>
  );
}

/** After-lesson automation at a glance: recording reminder, calendar, Hearsay state and the import inbox. */
export default function AutomationPanel() {
  const { data: st, reload } = useApi('/automation/status');
  useEffect(() => {
    const t = setInterval(reload, 30000);
    return () => clearInterval(t);
  }, [reload]);
  if (!st) return null;
  const configured = st.watcher.enabled || st.calendar.configured;
  if (!configured)
    return (
      <div className="section notice" style={{ fontSize: '0.9rem' }}>
        <strong>Automate after-lesson updates.</strong> Connect your calendar and the Hearsay folder in{' '}
        <Link to="/settings#automation">Settings → Automation</Link> and new lesson recordings will be imported, translated and analysed for you to review.
      </div>
    );
  const inbox = st.files.filter((f) => f.status === 'needs_review');
  const recent = st.files.filter((f) => f.status === 'imported').slice(0, 3);
  const next = st.calendar.upcoming[0];
  const hs = st.hearsay;

  return (
    <div className="section">
      {st.alert && (
        <div className={`notice ${st.alert.level === 'warn' ? 'warn' : ''}`} role="alert" style={{ marginBottom: 12 }}>
          <strong>{st.alert.title}.</strong> {st.alert.body}
        </div>
      )}
      <Card
        title="Lesson automation"
        actions={
          <span className="row" style={{ gap: 6 }}>
            {st.paused && <Badge tone="demo">paused in demo mode</Badge>}
            <Link to="/settings#automation" className="btn small">Settings</Link>
          </span>
        }
      >
        <div className="grid cols-3">
          <div>
            <div className="faint" style={{ fontSize: '0.8rem' }}>Next lesson (calendar)</div>
            {st.calendar.configured ? (
              next ? (
                <div>
                  <strong>{fmt(next.starts_at)}</strong>
                  <div style={{ fontSize: '0.85rem' }}>{next.lesson_id ? <Link to={`/schedule/${next.lesson_id}`}>Lesson {next.lesson_number}: {next.lesson_title}</Link> : <span className="faint">no lesson left to assign</span>}</div>
                </div>
              ) : (
                <span className="faint">No upcoming events titled “{st.calendar.keyword}”.</span>
              )
            ) : (
              <span className="faint">Calendar not connected.</span>
            )}
            {st.calendar.last_error && <div className="faint" style={{ color: 'var(--critical-text)', fontSize: '0.8rem' }}>{st.calendar.last_error}</div>}
          </div>
          <div>
            <div className="faint" style={{ fontSize: '0.8rem' }}>Hearsay</div>
            {!hs.log_dir_found ? (
              <span className="faint">Hearsay log not found.</span>
            ) : hs.recording ? (
              <div>
                <Badge tone="bad">● recording</Badge> <span style={{ fontSize: '0.85rem' }}>since {fmt(hs.recording_since)}</span>
                {hs.last_no_audio && <div style={{ fontSize: '0.8rem', color: 'var(--critical-text)' }}>No audio for {Math.round(hs.last_no_audio.seconds / 60)} min. Check the audio source.</div>}
              </div>
            ) : (
              <div style={{ fontSize: '0.85rem' }}>Not recording{hs.last_saved ? ` · last saved ${fmt(hs.last_saved)}` : ''}</div>
            )}
          </div>
          <div>
            <div className="faint" style={{ fontSize: '0.8rem' }}>Transcript folder</div>
            <div style={{ fontSize: '0.85rem' }}>
              {st.watcher.enabled ? (st.watcher.folder_exists ? <Badge status="pass">watching</Badge> : <Badge status="fail">folder missing</Badge>) : <Badge>off</Badge>}{' '}
              {st.watcher.last_scan?.error && <span style={{ color: 'var(--critical-text)' }}>{st.watcher.last_scan.error}</span>}
            </div>
            <div className="faint" style={{ fontSize: '0.8rem' }}>
              Translate: {st.watcher.auto_translate ? 'automatic' : 'manual'} · Claude analysis: {st.watcher.auto_claude_analysis ? 'automatic' : 'manual'} · Dashboard: {st.watcher.auto_apply ? 'filled in automatically' : 'you approve'}
            </div>
          </div>
        </div>

        {inbox.length > 0 && (
          <>
            <hr />
            <strong>Recordings waiting for you ({inbox.length})</strong>
            <p className="faint" style={{ fontSize: '0.8rem', margin: '2px 0 8px' }}>These were not recorded during a calendar lesson, so they were not imported automatically. Import the ones that were lessons.</p>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {inbox.map((f) => <InboxRow key={f.id} f={f} onDone={reload} />)}
            </ul>
          </>
        )}

        {recent.length > 0 && (
          <>
            <hr />
            <strong>Recently imported</strong>
            <ul style={{ paddingLeft: 18, margin: '6px 0 0' }}>
              {recent.map((f) => (
                <li key={f.id} style={{ fontSize: '0.88rem', marginBottom: 4 }}>
                  <Link to={`/sessions/${f.session_id}`}>{fmt(f.recorded_at)}</Link> {f.lesson_id && <Badge>{f.lesson_id}</Badge>}{' '}
                  {(f.pipeline || []).map((p) => (
                    <Badge key={p.step} tone={p.status === 'done' ? 'good' : p.status === 'failed' ? 'bad' : 'warn'}>
                      {p.step.replace(/_/g, ' ')}: {p.status}
                    </Badge>
                  ))}
                  {(f.pipeline || []).filter((p) => p.status !== 'done').map((p) => (
                    <div key={p.step} className="faint" style={{ fontSize: '0.78rem' }}>{p.reason}</div>
                  ))}
                  <AutoApplied f={f} onDone={reload} />
                </li>
              ))}
            </ul>
            <p style={{ fontSize: '0.85rem', margin: '8px 0 0' }}>
              {st.watcher.auto_apply ? (
                <>Claude's findings are filled in automatically. Anything it was unsure about waits in <Link to="/intelligence">Review lessons</Link>.</>
              ) : (
                <>Proposed matches are not applied automatically. <Link to="/intelligence">Review them</Link> to update coverage.</>
              )}
            </p>
          </>
        )}
      </Card>
    </div>
  );
}

export { FILE_TONE, FILE_LABEL, fmt };
