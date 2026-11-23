import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAction } from '../hooks.js';
import { Badge, ErrorBox, label } from './ui.jsx';

function MatchRow({ m, onDecided }) {
  const [mode, setMode] = useState(null);
  const [cat, setCat] = useState(m.category === 'uncertain' ? 'discussed' : m.category);
  const [exId, setExId] = useState(m.exercise_id);
  const [note, setNote] = useState('');
  const act = useAction();
  const decide = (decision, extra = {}) =>
    act.run(async () => {
      await api.post(`/matches/${m.id}/decision`, { decision, note: note || undefined, ...extra });
      onDecided?.();
    });
  const reviewed = m.review_status !== 'pending';

  return (
    <div className="review-row">
      <div>
        <div className="faint" style={{ fontSize: '0.75rem', textTransform: 'uppercase' }}>Suggestion</div>
        <div className="row">
          <Badge status={m.category === 'uncertain' ? 'uncertain' : m.category} />
          <span className="faint" style={{ fontSize: '0.82rem' }}>confidence {Math.round(m.confidence * 100)}%</span>
        </div>
        <p style={{ fontSize: '0.85rem', marginTop: 4 }}>{m.rationale}</p>
        {m.facets?.all?.length > 0 && (
          <p style={{ fontSize: '0.8rem' }}>
            {m.facets.found.map((f) => <Badge key={f} tone="info">✓ {f}</Badge>)} {m.facets.missing.map((f) => <Badge key={f} tone="warn">✗ {f} not evidenced</Badge>)}
          </p>
        )}
      </div>
      <div>
        <div className="faint" style={{ fontSize: '0.75rem', textTransform: 'uppercase' }}>Curriculum item</div>
        <code>{m.exercise_id}</code>
        <div>{m.exercise_description}</div>
        <div className="faint" style={{ fontSize: '0.8rem' }}>current status: {label(m.current_status)}</div>
        {m.already_approved_category && <div className="faint" style={{ fontSize: '0.8rem' }}>Already approved from this transcript as {label(m.already_approved_category)} — approving again will not double count.</div>}
      </div>
      <div>
        <div className="faint" style={{ fontSize: '0.75rem', textTransform: 'uppercase' }}>Cited evidence</div>
        <div className="quote">
          {m.timecode ? `[${m.timecode}] ` : `[line ${m.segment_seq}] `}
          {m.speaker ? `${m.speaker}: ` : ''}
          {m.snippet}
        </div>
        {m.extra_snippets?.length > 0 && (
          <details>
            <summary style={{ fontSize: '0.8rem' }}>{m.extra_snippets.length} more supporting line(s)</summary>
            {m.extra_snippets.map((s, i) => (
              <div key={i} className="quote" style={{ marginTop: 4 }}>
                {s.timecode ? `[${s.timecode}] ` : `[line ${s.seq}] `}
                {s.speaker ? `${s.speaker}: ` : ''}
                {s.text}
              </div>
            ))}
          </details>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          {reviewed ? (
            <Badge status={m.review_status}>{m.review_status}{m.final_category ? ` as ${label(m.final_category)}` : ''}</Badge>
          ) : (
            <>
              <button className="btn small primary" disabled={act.busy || m.category === 'uncertain'} title={m.category === 'uncertain' ? 'Uncertain matches must be adjusted or rejected' : ''} onClick={() => decide('approve')}>
                Approve
              </button>
              <button className="btn small" disabled={act.busy} onClick={() => setMode(mode === 'adjust' ? null : 'adjust')}>Adjust…</button>
              <button className="btn small danger" disabled={act.busy} onClick={() => decide('reject')}>Reject</button>
            </>
          )}
        </div>
        {mode === 'adjust' && !reviewed && (
          <div className="row" style={{ marginTop: 6 }}>
            <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
              <option value="discussed">discussed</option>
              <option value="demonstrated">demonstrated</option>
              <option value="independently_completed">independently completed</option>
            </select>
            <input type="text" value={exId} onChange={(e) => setExId(e.target.value.trim())} aria-label="Exercise id" style={{ width: 110 }} />
            <input type="text" placeholder="Reason" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
            <button className="btn small primary" disabled={act.busy} onClick={() => decide('adjust', { final_category: cat, exercise_id: exId !== m.exercise_id ? exId : undefined })}>
              Save adjustment
            </button>
          </div>
        )}
        <ErrorBox error={act.error} />
      </div>
    </div>
  );
}

const EXTRACTION_LABELS = {
  commands_executed: 'Commands executed',
  commands_mentioned_only: 'Commands only mentioned (not executed)',
  difficulties: 'Difficulties',
  tutor_feedback: 'Tutor feedback remarks',
  homework: 'Homework',
  unresolved_questions: 'Questions / possibly unresolved',
  decisions: 'Decisions',
};

/** Side-by-side review: AI/rule suggestion → curriculum item → cited evidence, with Approve / Reject / Adjust. */
export default function AnalysisReview({ analysis: a, onDecided, showHeader = true }) {
  const pending = a.matches.filter((m) => m.review_status === 'pending');
  const act = useAction();
  const approveHighConfidence = () =>
    act.run(async () => {
      const decisions = pending.filter((m) => m.category !== 'uncertain' && m.confidence >= 0.7).map((m) => ({ match_id: m.id, decision: 'approve' }));
      if (decisions.length) await api.post('/matches/decisions', { decisions });
      onDecided?.();
    });
  return (
    <div>
      {showHeader && (
        <div className="row between">
          <div>
            <strong>Analysis v{a.version}</strong> · {a.method === 'claude' ? `Claude (${a.model})` : 'Rule-based keyword matcher (not AI)'} · {a.created_at.slice(0, 16).replace('T', ' ')}
            {a.transcript_id && <span className="faint"> · transcript #{a.transcript_id}</span>}
          </div>
          <div className="row">
            <Badge status={pending.length ? 'pending' : 'approved'}>{pending.length} pending</Badge>
            {pending.length > 0 && (
              <button className="btn small" disabled={act.busy} onClick={approveHighConfidence} title="Approves non-uncertain suggestions with confidence ≥ 70%. Review the rest individually.">
                Approve all ≥70%
              </button>
            )}
          </div>
        </div>
      )}
      <ErrorBox error={act.error} />
      {a.status === 'failed' && <div className="error">Analysis failed: {a.error}</div>}
      {a.warnings?.length > 0 && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          {a.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
      {a.gaps?.length > 0 && (
        <div className="notice" style={{ marginTop: 8 }}>
          <strong>Not evidenced in this transcript</strong> <span className="faint">(not proof it was never taught)</span>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {a.gaps.map((g, i) => <li key={i}>{g.message}</li>)}
          </ul>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        {a.matches.length ? a.matches.map((m) => <MatchRow key={m.id} m={m} onDecided={onDecided} />) : <p className="faint">No curriculum matches were proposed.</p>}
      </div>
      {a.extraction && (
        <details style={{ marginTop: 8 }}>
          <summary><strong>Extracted session details</strong> <span className="faint">({a.extraction.method === 'claude' ? 'Claude' : 'heuristic'})</span></summary>
          <div className="grid cols-2" style={{ marginTop: 8 }}>
            {Object.entries(EXTRACTION_LABELS).map(([k, title]) =>
              a.extraction[k]?.length ? (
                <div key={k}>
                  <h3>{title}</h3>
                  <ul style={{ paddingLeft: 18, margin: 0, fontSize: '0.85rem' }}>
                    {a.extraction[k].map((it, i) => (
                      <li key={i}>
                        {it.command && <code>{it.command}</code>} {it.timecode && <span className="faint">[{it.timecode}]</span>} {it.command ? <span className="faint">{it.text}</span> : it.text}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null
            )}
          </div>
          {a.extraction.topics?.length > 0 && <p>Topics: {a.extraction.topics.join(', ')}</p>}
        </details>
      )}
      {a.usage && <p className="faint" style={{ fontSize: '0.8rem' }}>Token usage: {a.usage.input_tokens} in / {a.usage.output_tokens} out over {a.usage.chunks} chunk(s).</p>}
      <p style={{ fontSize: '0.8rem' }} className="faint">
        Approving records evidence and can raise an exercise status (never lowers it). It never changes verified mastery — that requires a <Link to="/assessments">practical assessment</Link>.
      </p>
    </div>
  );
}
