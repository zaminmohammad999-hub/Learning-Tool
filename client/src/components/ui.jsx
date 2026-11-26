import { Fragment } from 'react';
import { Link } from 'react-router-dom';

export const EXERCISE_STATUSES = ['not_started', 'discussed', 'demonstrated', 'independently_completed', 'needs_practice'];
export const label = (s) => (s ? String(s).replace(/_/g, ' ') : '—');

const STATUS_TONE = {
  not_started: '',
  discussed: 'info',
  demonstrated: 'info',
  independently_completed: 'good',
  needs_practice: 'warn',
  planned: '',
  held: 'good',
  missed: 'bad',
  pending: 'warn',
  approved: 'good',
  adjusted: 'good',
  rejected: 'bad',
  pass: 'good',
  fail: 'bad',
  not_observed: 'warn',
  uncertain: 'warn',
};
const STATUS_ICON = { held: '✓', missed: '✕', pass: '✓', fail: '✕', approved: '✓', rejected: '✕', needs_practice: '!', pending: '…' };

// Lesson (meeting) statuses are shown capitalised: Planned / Held / Missed.
const LESSON_STATUS_TEXT = { planned: 'Planned', held: 'Held', missed: 'Missed' };

export function Badge({ status, children, tone }) {
  const t = tone ?? STATUS_TONE[status] ?? '';
  return (
    <span className={`badge ${t}`}>
      {STATUS_ICON[status] && <span aria-hidden="true">{STATUS_ICON[status]}</span>}
      {children ?? LESSON_STATUS_TEXT[status] ?? label(status)}
    </span>
  );
}

const MASTERY = {
  not_assessed: ['', 'Not assessed'],
  in_progress: ['info', 'In progress'],
  needs_practice: ['warn', 'Needs practice'],
  passed: ['mastery', '✓ Mastered (verified)'],
  reassessment_required: ['bad', 'Reassessment required'],
};
export function MasteryBadge({ state, awaiting }) {
  const [tone, text] = MASTERY[state] || ['', label(state)];
  return <span className={`badge ${tone}`}>{awaiting ? 'Passed — awaiting verification' : text}</span>;
}

export function ProgressBar({ kind = 'coverage', value, total, caption }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="bar-label">
        <span>{caption ?? (kind === 'coverage' ? 'Coverage' : 'Verified mastery')}</span>
        <span>
          {value}/{total}
        </span>
      </div>
      <div className={`bar ${kind}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${caption || kind} ${value} of ${total}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Loading({ what = 'Loading' }) {
  return <div className="loading" role="status">{what}…</div>;
}
export function ErrorBox({ error, retry }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {error.message || String(error)} {retry && <button className="btn small" onClick={retry}>Retry</button>}
    </div>
  );
}
export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="row between" style={{ marginBottom: 10 }}>
          {title && <h2 style={{ margin: 0 }}>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label: l, value, sub, children }) {
  return (
    <div className="card stat">
      <span className="label">{l}</span>
      <span className="value">
        {value} {sub && <small className="muted">{sub}</small>}
      </span>
      {children}
    </div>
  );
}

export function CitationList({ citations, highlight }) {
  if (!citations?.length) return null;
  return (
    <div className="citation-list">
      {citations.map((c, i) => (
        <div key={c.ref + i} id={`cite-${i + 1}`} className={`citation ${highlight === i + 1 ? 'hl' : ''}`}>
          <strong>[C{i + 1}]</strong> <span className="muted">{c.label}</span>
          {c.snippet && <div className="mono" style={{ marginTop: 2 }}>“{c.snippet}”</div>}
          {c.session_id && (
            <Link to={`/sessions/${c.session_id}`} style={{ fontSize: "0.8rem" }}>
              open session
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

/** Minimal, safe markdown: **bold**, _italic_, "- " bullets, [C#] citation chips. No HTML injection. */
export function RichText({ text, onCite }) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let list = null;
  lines.forEach((ln, i) => {
    if (/^\s*[-*] /.test(ln)) {
      if (!list) {
        list = [];
        blocks.push({ type: 'ul', items: list });
      }
      list.push(ln.replace(/^\s*[-*] /, ''));
    } else {
      list = null;
      if (ln.trim()) blocks.push({ type: 'p', text: ln, key: i });
    }
  });
  const inline = (s) =>
    s.split(/(\*\*[^*]+\*\*|_[^_]+_|\[C\d+\])/g).map((part, i) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (/^_[^_]+_$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
      const m = part.match(/^\[C(\d+)\]$/);
      if (m)
        return (
          <button key={i} className="cite" onClick={() => onCite?.(Number(m[1]))} aria-label={`Show citation ${m[1]}`}>
            C{m[1]}
          </button>
        );
      return <Fragment key={i}>{part}</Fragment>;
    });
  return (
    <div>
      {blocks.map((b, i) =>
        b.type === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{inline(b.text)}</p>
        )
      )}
    </div>
  );
}

export function Field({ label: l, children, style }) {
  return (
    <label className="field" style={style}>
      {l}
      {children}
    </label>
  );
}

export const today = () => new Date().toISOString().slice(0, 10);
