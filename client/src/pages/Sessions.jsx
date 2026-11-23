import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import { useAppContext } from '../App.jsx';
import AnalysisReview from '../components/AnalysisReview.jsx';
import { Badge, Card, Empty, ErrorBox, Field, Loading, label } from '../components/ui.jsx';

const LANG = { ur: 'Urdu', en: 'English', unknown: 'unknown language' };

/** Translation status + "Translate to English" with a cost estimate shown before anything is sent. */
function TranslationBar({ t, ai, onDone }) {
  const needs = ['needed', 'failed', 'running'].includes(t.translation_status);
  const translated = ['done', 'partial'].includes(t.translation_status);
  const { data: est } = useApi(needs || translated ? `/transcripts/${t.id}/translation-estimate` : null);
  const act = useAction();
  if (!needs && !translated) return null;
  return (
    <div className={`notice ${needs ? 'warn' : ''}`} style={{ margin: '8px 0', fontSize: '0.88rem' }}>
      <div className="row between">
        <span>
          {translated ? (
            <>
              Translated from {LANG[t.language] || t.language} to English{t.translation_status === 'partial' ? ' (some lines kept in the original)' : ''} with {t.translation_model} on {t.translated_at?.slice(0, 10)}. Matching, search and citations use the English; the original file is unchanged.
            </>
          ) : (
            <>
              This transcript is in <strong>{LANG[t.language] || t.language}</strong>. Translate it to English so lessons can be matched and searched.
              {t.translation_status === 'failed' && ' The last attempt failed.'}
            </>
          )}
        </span>
        <button
          className="btn small"
          disabled={act.busy || !ai?.available}
          title={ai?.available ? '' : ai?.reason || 'Enable Claude in Settings'}
          onClick={() => {
            const cost = est?.approx_usd != null ? ` (about $${est.approx_usd} with ${est.model})` : '';
            if (window.confirm(`Send this transcript to Claude for translation${cost}? Then the free rule-based matcher runs again on the English.`))
              act.run(async () => onDone(await api.post(`/transcripts/${t.id}/translate`, {})));
          }}
        >
          {act.busy ? 'Translating…' : translated ? 'Re-translate' : 'Translate to English'}
          {est?.approx_usd != null && !act.busy && ` · ~$${est.approx_usd}`}
        </button>
      </div>
      {!ai?.available && <div className="faint" style={{ marginTop: 4 }}>{ai?.reason}</div>}
      <ErrorBox error={act.error} />
    </div>
  );
}

function TranscriptPanel({ transcriptId, onChanged }) {
  const { health } = useAppContext();
  const { data: t, error, loading, reload } = useApi(`/transcripts/${transcriptId}`);
  const [analysisId, setAnalysisId] = useState(null);
  const [filter, setFilter] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);
  const { data: analysis, reload: reloadAnalysis } = useApi(analysisId ? `/analyses/${analysisId}` : null);
  const act = useAction();
  useEffect(() => {
    if (t?.analyses?.length && !analysisId) setAnalysisId(t.analyses[0].id);
  }, [t, analysisId]);
  if (loading && !t) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const lines = t.segments.filter((s) => !filter || s.text.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Card
      title={`Transcript #${t.id}${t.filename ? ` — ${t.filename}` : ''}`}
      actions={
        <button
          className="btn small danger"
          onClick={() => {
            if (window.confirm('Delete this transcript, its analyses and the evidence approved from it? Exercise statuses are kept.'))
              act.run(async () => {
                await api.del(`/transcripts/${t.id}`);
                onChanged?.();
              });
          }}
        >
          Delete transcript
        </button>
      }
    >
      <p className="faint" style={{ fontSize: '0.85rem' }}>
        {t.segment_count} lines · {t.char_count.toLocaleString()} characters · format {t.format} · imported {t.created_at.slice(0, 10)} · original preserved (checksum <code>{t.checksum.slice(0, 12)}…</code>)
      </p>
      <TranslationBar t={t} ai={health?.ai} onDone={async (r) => { await reload(); if (r?.analysis_id) setAnalysisId(r.analysis_id); onChanged?.(); }} />
      <details>
        <summary>Full stored transcript</summary>
        <div className="row" style={{ margin: '8px 0' }}>
          <input type="search" placeholder="Filter lines" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          {t.segments.some((s) => s.source_text) && (
            <label className="row" style={{ fontSize: '0.85rem' }}>
              <input type="checkbox" checked={showOriginal} onChange={(e) => setShowOriginal(e.target.checked)} /> Show original (Urdu) beside English
            </label>
          )}
        </div>
        <div className="transcript-view">
          {lines.map((s) => (
            <div key={s.seq} className="line">
              <span className="faint mono">{s.timecode || `#${s.seq}`}</span>
              <strong style={{ fontSize: '0.82rem' }}>{s.speaker || ''}</strong>
              <span>
                {s.text}
                {showOriginal && s.source_text && (
                  <span dir="rtl" lang="ur" className="faint" style={{ display: 'block', marginTop: 2 }}>{s.source_text}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </details>
      <hr />
      <div className="row between">
        <div className="row">
          <strong>Analysis versions</strong>
          {t.analyses.map((a) => (
            <button key={a.id} className="btn small" style={{ borderColor: a.id === analysisId ? 'var(--accent)' : undefined }} onClick={() => setAnalysisId(a.id)}>
              v{a.version} · {a.method === 'claude' ? 'Claude' : 'rule-based'} {a.status !== 'completed' && `(${a.status})`}
            </button>
          ))}
          {!t.analyses.length && <span className="faint">Not analysed yet.</span>}
        </div>
        <div className="row">
          <button className="btn small" disabled={act.busy} onClick={() => act.run(async () => { const a = await api.post(`/transcripts/${t.id}/analyse`, { method: 'rule_based' }); await reload(); setAnalysisId(a.id); })}>
            Re-analyse (rule-based)
          </button>
          <button className="btn small" disabled={act.busy || !health?.ai?.available} title={health?.ai?.reason || ''} onClick={() => act.run(async () => { const a = await api.post(`/transcripts/${t.id}/analyse`, { method: 'claude' }); await reload(); setAnalysisId(a.id); })}>
            Analyse with Claude
          </button>
        </div>
      </div>
      {act.busy && <Loading what="Working" />}
      <ErrorBox error={act.error} />
      {analysis && (
        <div style={{ marginTop: 10 }}>
          <AnalysisReview analysis={analysis} onDecided={() => { reloadAnalysis(); onChanged?.(); }} />
        </div>
      )}
    </Card>
  );
}

function AddTranscriptToSession({ sessionId, onSaved }) {
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const act = useAction();
  return (
    <details className="card">
      <summary><strong>Add another transcript to this session</strong></summary>
      <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} style={{ marginTop: 8 }} aria-label="Transcript text" />
      <div className="row" style={{ marginTop: 6 }}>
        <input type="file" accept=".txt,.md,.vtt,.srt" aria-label="Upload transcript" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setFilename(f.name); setText(await f.text()); } }} />
        <button className="btn primary small" disabled={!text.trim() || act.busy} onClick={() => act.run(async () => { await api.post('/transcripts', { session_id: sessionId, text, filename: filename || null }); setText(''); onSaved(); })}>
          Save
        </button>
      </div>
      <ErrorBox error={act.error} />
    </details>
  );
}

function SessionDetail({ id, onChanged }) {
  const navigate = useNavigate();
  const { data: s, error, loading, reload } = useApi(`/sessions/${id}`);
  const { data: schedule } = useApi('/schedule');
  const [form, setForm] = useState(null);
  const act = useAction();
  useEffect(() => {
    if (s) setForm({ session_date: s.session_date, duration_minutes: s.duration_minutes ?? '', tutor: s.tutor || '', title: s.title || '', speaker_notes: s.speaker_notes || '', notes: s.notes || '', lesson_ids: s.lesson_ids });
  }, [s]);
  if (loading && !s) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!form) return null;
  const lessons = schedule ? schedule.flatMap((w) => w.lessons) : [];
  const refresh = () => { reload(); onChanged(); };

  return (
    <div className="stack">
      <Card
        title={`Session ${s.session_date}${s.title ? ` — ${s.title}` : ''}`}
        actions={
          <>
            <Link className="btn small" to="/gaps">Next lesson briefing</Link>
            <Link className="btn small" to={`/feedback?session=${s.id}`}>+ Feedback</Link>
            <button className="btn small danger" onClick={() => window.confirm('Delete this session and all of its transcripts and analyses?') && act.run(async () => { await api.del(`/sessions/${s.id}`); onChanged(); navigate('/sessions'); })}>
              Delete
            </button>
          </>
        }
      >
        <div className="grid cols-4">
          <Field label="Date"><input type="date" value={form.session_date} onChange={(e) => setForm({ ...form, session_date: e.target.value })} /></Field>
          <Field label="Duration (min)"><input type="number" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} /></Field>
          <Field label="Tutor"><input type="text" value={form.tutor} onChange={(e) => setForm({ ...form, tutor: e.target.value })} /></Field>
          <Field label="Title"><input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        </div>
        <div className="grid cols-2" style={{ marginTop: 8 }}>
          <Field label="Speaker notes"><textarea rows={3} value={form.speaker_notes} onChange={(e) => setForm({ ...form, speaker_notes: e.target.value })} /></Field>
          <Field label="Session notes"><textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
        <Field label="Lessons" style={{ marginTop: 8 }}>
          <select multiple value={form.lesson_ids} onChange={(e) => setForm({ ...form, lesson_ids: [...e.target.selectedOptions].map((o) => o.value) })} size={4}>
            {lessons.map((l) => <option key={l.id} value={l.id}>L{l.number} {l.title}</option>)}
          </select>
        </Field>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={act.busy} onClick={() => act.run(async () => { await api.patch(`/sessions/${s.id}`, { ...form, duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null }); refresh(); })}>
            Save session
          </button>
          <ErrorBox error={act.error} />
        </div>
      </Card>

      {s.transcripts.length ? s.transcripts.map((t) => <TranscriptPanel key={t.id} transcriptId={t.id} onChanged={refresh} />) : <Empty>No transcript stored for this session.</Empty>}
      <AddTranscriptToSession sessionId={s.id} onSaved={refresh} />

      <div className="grid cols-2">
        <Card title="Matched evidence (approved)">
          {s.evidence.length ? (
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: '0.9rem' }}>
              {s.evidence.map((e) => <li key={e.id}><code>{e.exercise_id}</code> <Badge status={e.category} /> {e.description}</li>)}
            </ul>
          ) : (
            <p className="faint">No approved evidence yet.</p>
          )}
        </Card>
        <Card title="Review approvals">
          {s.approvals.length ? (
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: '0.85rem' }}>
              {s.approvals.map((a) => (
                <li key={a.id}>{a.created_at.slice(0, 16).replace('T', ' ')} · {a.reviewer} · <Badge status={a.decision === 'reject' ? 'rejected' : 'approved'}>{a.decision}</Badge> {a.final_exercise_id || a.exercise_id} {a.final_category && `as ${label(a.final_category)}`} {a.note && <em>— {a.note}</em>}</li>
              ))}
            </ul>
          ) : (
            <p className="faint">No review decisions yet.</p>
          )}
        </Card>
        <Card title="Feedback">
          {s.feedback.length ? s.feedback.map((f) => <p key={f.id} style={{ fontSize: '0.9rem' }}><strong>{f.feedback_date}</strong> {f.next_priorities && `· Next: ${f.next_priorities}`}</p>) : <p className="faint">No feedback linked.</p>}
        </Card>
        <Card title="Homework">
          {s.homework.length ? s.homework.map((h) => <p key={h.id} style={{ fontSize: '0.9rem' }}><Badge status={h.status === 'done' ? 'pass' : 'pending'}>{h.status}</Badge> {h.description}</p>) : <p className="faint">No homework linked.</p>}
        </Card>
      </div>
    </div>
  );
}

export default function Sessions() {
  const { sessionId } = useParams();
  const { data, error, loading, reload } = useApi('/sessions');
  if (loading && !data) return <Loading what="Loading sessions" />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Session History</h1>
          <p className="muted">Every stored session with its full original transcript, analysis versions, approvals and outcomes. Export/import lives in <Link to="/settings">Settings & Data</Link>.</p>
        </div>
        <Link className="btn primary" to="/intelligence?lesson=">+ New session / transcript</Link>
      </div>
      <div className={sessionId ? 'grid split' : ''}>
        <Card title={`${data.length} session(s)`}>
          {!data.length ? (
            <Empty>No sessions yet. Add one by pasting a transcript in Tutor Intelligence.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Lessons</th>{!sessionId && <><th>Tutor</th><th>Duration</th><th>Transcripts</th><th>Review</th></>}</tr></thead>
                <tbody>
                  {data.map((s) => (
                    <tr key={s.id} style={{ background: String(s.id) === sessionId ? 'var(--surface-2)' : undefined }}>
                      <td><Link to={`/sessions/${s.id}`}>{s.session_date}</Link><div className="faint" style={{ fontSize: '0.8rem' }}>{s.title}</div></td>
                      <td>{s.lesson_ids.join(', ') || '—'}</td>
                      {!sessionId && (
                        <>
                          <td>{s.tutor || '—'}</td>
                          <td>{s.duration_minutes ? `${s.duration_minutes} min` : '—'}</td>
                          <td>{s.transcript_count}</td>
                          <td>{s.pending_matches ? <Badge status="pending">{s.pending_matches} pending</Badge> : <span className="faint">{s.approved_evidence} approved</span>}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {sessionId && <SessionDetail key={sessionId} id={Number(sessionId)} onChanged={reload} />}
      </div>
    </div>
  );
}
