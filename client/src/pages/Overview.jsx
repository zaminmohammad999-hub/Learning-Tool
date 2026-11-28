import { Link } from 'react-router-dom';
import { useApi } from '../hooks.js';
import AutomationPanel from '../components/AutomationPanel.jsx';
import { Badge, Card, Empty, ErrorBox, Loading, MasteryBadge, ProgressBar, Stat, label } from '../components/ui.jsx';

export default function Overview() {
  const { data: s, error, loading, reload } = useApi('/dashboard/stats');
  if (loading && !s) return <Loading what="Loading dashboard" />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const next = s.next_lesson;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">{s.programme.title} · today {s.today}</p>
        </div>
        <div className="row" style={{ fontSize: '0.85rem' }}>
          <span><span className="legend-dot" style={{ background: 'var(--coverage)' }} />Coverage = exercises evidenced as taught</span>
          <span><span className="legend-dot" style={{ background: 'var(--mastery)' }} />Mastery = competencies passed in a verified practical test</span>
        </div>
      </div>

      <div className="grid cols-4">
        <Stat label="Exercise coverage" value={`${s.coverage.covered}`} sub={`/ 96 exercises (${s.coverage.percent}%)`}>
          <ProgressBar kind="coverage" value={s.coverage.covered} total={96} caption="Distinct exercises evidenced" />
        </Stat>
        <Stat label="Verified mastery" value={`${s.mastery.verified_passed}`} sub={`/ 24 competencies`}>
          <ProgressBar kind="mastery" value={s.mastery.verified_passed} total={24} caption="Verified passed competencies" />
        </Stat>
        <Stat label="Lessons held" value={s.lessons.held} sub={`/ 24 · ${s.lessons.missed} missed`}>
          <small className="muted">Held ≠ covered ≠ mastered</small>
        </Stat>
        <Stat label="Next session" value={next ? `L${next.number}` : '—'} sub={next?.planned_date || (next ? 'date not set' : 'none left')}>
          {next ? (
            <small>
              <Link to={`/schedule/${next.id}`}>{next.title}</Link> · <Link to="/gaps">briefing</Link>
            </small>
          ) : (
            <small className="muted">All lessons recorded</small>
          )}
        </Stat>
      </div>

      <AutomationPanel />

      {s.warnings.length > 0 && (
        <div className="section notice warn" role="status">
          <strong>Evidence warnings</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {s.warnings.slice(0, 8).map((w, i) => (
              <li key={i}>
                {w.message}{' '}
                {w.lesson_id && <Link to={`/schedule/${w.lesson_id}`}>open lesson</Link>}
                {w.session_id && <Link to={`/sessions/${w.session_id}`}>open session</Link>}
                {w.type === 'pending_review' && <Link to="/intelligence">review now</Link>}
                {w.transcript_id && <Link to="/sessions">analyse</Link>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card title="12-week timeline" className="section">
        <div className="timeline" role="list">
          {s.timeline.map((w) => (
            <div key={w.week} className="tl-week" role="listitem">
              <div className="wk">W{w.week}</div>
              {w.lessons.map((l) => (
                <Link
                  key={l.id}
                  to={`/schedule/${l.id}`}
                  className={`tl-lesson ${l.status} ${next?.id === l.id ? 'next' : ''}`}
                  title={`Lesson ${l.number}: ${l.title} — ${l.status}; coverage ${l.coverage.covered}/${l.coverage.total}; mastery ${label(l.mastery_state)}`}
                >
                  <span>
                    L{l.number} {l.status === 'held' ? '✓' : l.status === 'missed' ? '✕' : ''}
                  </span>
                  <span className="mini"><span style={{ width: `${(l.coverage.covered / 4) * 100}%` }} /></span>
                  {l.mastery_state === 'passed' && <span style={{ color: 'var(--mastery)' }}>★</span>}
                  {l.domain_assessment_after && <span className="faint">+DA</span>}
                </Link>
              ))}
            </div>
          ))}
        </div>
        <p className="faint" style={{ marginTop: 8, fontSize: '0.8rem' }}>
          ✓ held · ✕ missed · blue line = exercise coverage · ★ verified mastery · +DA domain assessment after this lesson
        </p>
      </Card>

      <div className="section grid cols-3">
        {s.domains.map((d) => (
          <Card key={d.id} title={`${d.id} · ${d.name}`}>
            <div className="stack">
              <ProgressBar kind="coverage" value={d.coverage.covered} total={16} caption="Exercise coverage" />
              <ProgressBar kind="mastery" value={d.mastered} total={4} caption="Verified competencies" />
              <div className="row between" style={{ fontSize: '0.85rem' }}>
                <span>Domain assessment ({d.domain_assessment.id})</span>
                {d.domain_assessment.latest_result ? (
                  <Badge status={d.domain_assessment.latest_result}>{d.domain_assessment.latest_result} {d.domain_assessment.latest_score}</Badge>
                ) : (
                  <Badge>not attempted</Badge>
                )}
              </div>
              <ul className="comp-list">
                {d.competencies.map((c) => (
                  <li key={c.id}>
                    <Link to={`/assessments/${c.id}`}>{c.title}</Link>
                    <div className="row" style={{ gap: 6, marginTop: 2 }}>
                      <MasteryBadge state={c.mastery_state} />
                      <span className="faint" style={{ fontSize: '0.78rem' }}>L{c.lesson_number} · covered {c.coverage.covered}/4 · criteria {c.criteria}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        ))}
      </div>

      <div className="section grid cols-3">
        <Card title="Overdue">
          {s.overdue.length ? (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {s.overdue.map((o, i) => (
                <li key={i}>
                  <Badge status="fail">{o.type.replace('_', ' ')}</Badge> {o.label} <span className="faint">due {o.due}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing overdue. Set a programme start date in Settings to track lesson dates.</Empty>
          )}
        </Card>
        <Card title="Recent sessions">
          {s.recent_sessions.length ? (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {s.recent_sessions.map((r) => (
                <li key={r.id}>
                  <Link to={`/sessions/${r.id}`}>{r.session_date}</Link> {r.title || ''} <span className="faint">{r.lesson_ids || 'no lesson'} · {r.transcript_count} transcript(s)</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No sessions recorded yet.</Empty>
          )}
        </Card>
        <Card title="Assessment outcomes">
          {s.recent_attempts.length ? (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {s.recent_attempts.map((a) => (
                <li key={a.id}>
                  <Badge status={a.overall_result} /> {a.competency_id || a.domain_assessment_id} attempt {a.attempt_number} · {a.criteria_passed}/{a.criteria_mandatory} criteria <span className="faint">{a.attempt_date}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No practical tests recorded yet.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
