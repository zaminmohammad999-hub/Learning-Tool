import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAction } from '../hooks.js';
import { Badge, ErrorBox, EXERCISE_STATUSES, label } from './ui.jsx';

/** One practical exercise with status, notes, due date, evidence and audit trail. */
export default function ExerciseRow({ ex, onChange, onMove, canMoveUp, canMoveDown }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [audit, setAudit] = useState([]);
  const [notes, setNotes] = useState(ex.notes || '');
  const [evNote, setEvNote] = useState('');
  const [evCat, setEvCat] = useState('discussed');
  const { busy, error, run } = useAction();

  const loadDetail = async () => {
    setDetail(await api.get(`/exercises/${ex.id}`));
    setAudit(await api.get(`/audit?entity_type=exercise_progress&entity_id=${ex.id}`));
  };
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) await run(loadDetail);
  };
  const patch = (body) =>
    run(async () => {
      await api.patch(`/exercises/${ex.id}/progress`, body);
      onChange?.();
      if (open) await loadDetail();
    });

  return (
    <div className="exercise">
      <div>
        <div className="row">
          <code className="faint">{ex.id}</code>
          {!ex.is_canonical && <Badge tone="info">custom</Badge>}
          {ex.covered ? <Badge tone="info">covered</Badge> : <Badge>not evidenced</Badge>}
          {ex.evidence_count > 0 && <span className="faint" style={{ fontSize: '0.8rem' }}>{ex.evidence_count} evidence</span>}
          {ex.pending_matches > 0 && (
            <Link to="/intelligence" className="badge warn">
              {ex.pending_matches} to review
            </Link>
          )}
          {ex.due_date && <span className="faint" style={{ fontSize: '0.8rem' }}>due {ex.due_date}</span>}
        </div>
        <div style={{ marginTop: 2 }}>{ex.description}</div>
        {ex.notes && !open && <div className="faint" style={{ fontSize: '0.85rem' }}>Note: {ex.notes}</div>}
        <button className="btn link" style={{ fontSize: '0.82rem' }} onClick={toggle} aria-expanded={open}>
          {open ? 'Hide details' : 'Notes, evidence & history'}
        </button>
        {open && (
          <div className="stack" style={{ marginTop: 8 }}>
            <label className="field">
              Lesson notes for this exercise
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn small" disabled={busy || notes === (ex.notes || '')} onClick={() => patch({ notes })}>
                Save notes
              </button>
              <label className="field" style={{ flexDirection: 'row', alignItems: 'center' }}>
                Due
                <input type="date" value={ex.due_date || ''} onChange={(e) => patch({ due_date: e.target.value })} />
              </label>
              {ex.status === 'needs_practice' && (
                <label className="row" style={{ fontSize: '0.85rem' }}>
                  <input type="checkbox" checked={!!ex.coverage_confirmed} onChange={(e) => patch({ coverage_confirmed: e.target.checked })} />
                  Topic was taught (counts as covered)
                </label>
              )}
            </div>
            <div>
              <strong style={{ fontSize: '0.85rem' }}>Approved evidence</strong>
              {detail?.evidence?.length ? (
                <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: '0.85rem' }}>
                  {detail.evidence.map((ev) => (
                    <li key={ev.id}>
                      <Badge status={ev.category} /> {ev.source === 'manual' ? 'manual' : <Link to={`/sessions/${ev.session_id}`}>session {ev.session_date}</Link>}
                      {ev.timecode && ` @ ${ev.timecode}`} {ev.snippet && <span className="mono">“{ev.snippet}”</span>} {ev.note && <em>{ev.note}</em>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="faint" style={{ fontSize: '0.85rem' }}>No approved evidence. Absence of evidence is not proof it was not taught.</p>
              )}
              <div className="row">
                <select value={evCat} onChange={(e) => setEvCat(e.target.value)} aria-label="Evidence category">
                  <option value="discussed">discussed</option>
                  <option value="demonstrated">demonstrated</option>
                  <option value="independently_completed">independently completed</option>
                </select>
                <input type="text" placeholder="Manual evidence note (what was seen, where)" value={evNote} onChange={(e) => setEvNote(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
                <button
                  className="btn small"
                  disabled={busy || evNote.trim().length < 3}
                  onClick={() =>
                    run(async () => {
                      await api.post(`/exercises/${ex.id}/evidence`, { category: evCat, note: evNote });
                      setEvNote('');
                      onChange?.();
                      await loadDetail();
                    })
                  }
                >
                  Add evidence
                </button>
              </div>
            </div>
            {audit.length > 0 && (
              <details>
                <summary style={{ fontSize: '0.85rem' }}>Audit trail ({audit.length})</summary>
                <ul style={{ fontSize: '0.8rem', paddingLeft: 18 }}>
                  {audit.map((a) => (
                    <li key={a.id}>
                      {a.created_at.slice(0, 16).replace('T', ' ')} · {a.actor} · {a.action}: {a.before?.status && `${label(a.before.status)} → `}
                      {label(a.after?.status)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        <ErrorBox error={error} />
      </div>
      <div className="stack" style={{ textAlign: 'right' }}>
        <label className="sr-only" htmlFor={`st-${ex.id}`}>Status for {ex.id}</label>
        <select id={`st-${ex.id}`} value={ex.status} disabled={busy} onChange={(e) => patch({ status: e.target.value })}>
          {EXERCISE_STATUSES.map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </select>
        {onMove && (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
            <button className="btn small" disabled={!canMoveUp} onClick={() => onMove(-1)} aria-label="Move up">↑</button>
            <button className="btn small" disabled={!canMoveDown} onClick={() => onMove(1)} aria-label="Move down">↓</button>
          </div>
        )}
      </div>
    </div>
  );
}
