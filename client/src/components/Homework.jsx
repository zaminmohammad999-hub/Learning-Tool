import { useState } from 'react';
import { api } from '../api.js';
import { useAction } from '../hooks.js';
import { Badge, ErrorBox } from './ui.jsx';

const METHOD = { loom: 'watched your Loom video', live: 'saw it done live', transcript: 'approved it in a recorded lesson', before_approval_existed: 'marked done' };

export function homeworkState(h) {
  switch (h.review_status) {
    case 'approved':
      return { tone: 'good', text: 'Approved' };
    case 'submitted':
      return { tone: 'info', text: 'Waiting for Fariha' };
    case 'changes_requested':
      return { tone: 'warn', text: 'Needs more work' };
    default:
      return { tone: '', text: 'Not submitted' };
  }
}

/**
 * One homework task. Complete only when the tutor approves it: after watching a Loom video you submitted,
 * after seeing it done live, or automatically when she approves it in a recorded lesson.
 */
export function HomeworkItem({ h, tutor = 'Fariha', onChange }) {
  const act = useAction();
  const [mode, setMode] = useState(null); // 'submit' | 'approve'
  const [url, setUrl] = useState(h.submission_url || '');
  const [note, setNote] = useState('');
  const st = homeworkState(h);
  const done = (p) =>
    act.run(async () => {
      await p();
      setMode(null);
      setNote('');
      onChange?.();
    });
  return (
    <li style={{ marginBottom: 10 }}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <span style={{ fontSize: '0.9rem', textDecoration: h.review_status === 'approved' ? 'line-through' : undefined }}>{h.description}</span>
        <Badge tone={st.tone}>{st.text}</Badge>
      </div>
      <div className="faint" style={{ fontSize: '0.8rem' }}>
        {h.lesson_number ? `L${h.lesson_number} · ` : ''}
        {h.due_date ? `due ${h.due_date}` : 'no due date'}
        {h.submission_url && (
          <>
            {' · '}
            <a href={h.submission_url} target="_blank" rel="noreferrer">Loom video</a>
          </>
        )}
        {h.review_status === 'approved' && ` · ${h.approved_by || tutor} ${METHOD[h.approval_method] || 'approved it'}${h.reviewed_at ? ` on ${h.reviewed_at.slice(0, 10)}` : ''}`}
        {h.review_note && ` · “${h.review_note}”`}
      </div>
      {h.review_status !== 'approved' && (
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <button className="btn small" disabled={act.busy} onClick={() => setMode(mode === 'submit' ? null : 'submit')}>
            {h.review_status === 'submitted' ? 'Change Loom link' : 'Submit Loom video'}
          </button>
          <button className="btn small" disabled={act.busy} onClick={() => setMode(mode === 'approve' ? null : 'approve')}>{tutor}'s decision</button>
        </div>
      )}
      {mode === 'submit' && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <input type="url" placeholder="https://www.loom.com/share/…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="Loom link" />
          <button className="btn small primary" disabled={act.busy || !url.trim()} onClick={() => done(() => api.post(`/homework/${h.id}/submit`, { url: url.trim() }))}>
            Submit
          </button>
        </div>
      )}
      {mode === 'approve' && (
        <div className="stack" style={{ marginTop: 6 }}>
          <span className="faint" style={{ fontSize: '0.8rem' }}>Record {tutor}'s decision (only when she has checked it):</span>
          <input type="text" placeholder={`Optional comment from ${tutor}`} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Comment" />
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small primary" disabled={act.busy || !h.submission_url} title={h.submission_url ? '' : 'Submit a Loom link first'} onClick={() => done(() => api.post(`/homework/${h.id}/review`, { verdict: 'approved', method: 'loom', note }))}>
              Approved after watching the Loom
            </button>
            <button className="btn small primary" disabled={act.busy} onClick={() => done(() => api.post(`/homework/${h.id}/review`, { verdict: 'approved', method: 'live', note }))}>
              Approved: she saw it done live
            </button>
            <button className="btn small" disabled={act.busy} onClick={() => done(() => api.post(`/homework/${h.id}/review`, { verdict: 'changes_requested', method: h.submission_url ? 'loom' : 'live', note }))}>
              Needs more work
            </button>
          </div>
        </div>
      )}
      <ErrorBox error={act.error} />
    </li>
  );
}

export function HomeworkList({ items, tutor, onChange }) {
  if (!items?.length) return <p className="faint">No homework yet.</p>;
  return (
    <ul style={{ paddingLeft: 18, margin: 0 }}>
      {items.map((h) => (
        <HomeworkItem key={h.id} h={h} tutor={tutor} onChange={onChange} />
      ))}
    </ul>
  );
}
