import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { Badge, Card, CitationList, Empty, ErrorBox, Loading, MasteryBadge, label } from '../components/ui.jsx';

function Cites({ citations }) {
  const [open, setOpen] = useState(false);
  if (!citations?.length) return null;
  return (
    <>
      <button className="cite" onClick={() => setOpen(!open)} aria-expanded={open}>{citations.length} source{citations.length > 1 ? 's' : ''}</button>
      {open && <CitationList citations={citations} />}
    </>
  );
}

function Briefing({ lessonId }) {
  const { data: b, error, loading, reload } = useApi(`/briefing${lessonId ? `?lesson_id=${lessonId}` : ''}`);
  if (loading && !b) return <Loading what="Building briefing" />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!b.lesson) return <Empty>{b.message}</Empty>;
  return (
    <Card title={`Briefing — Lesson ${b.lesson.number}: ${b.lesson.title}`} actions={<button className="btn small" onClick={reload}>Refresh</button>}>
      <p className="muted">
        Week {b.lesson.week} · {b.lesson.competency_title} {b.lesson.planned_date && `· ${b.lesson.planned_date}`} · <MasteryBadge state={b.mastery.state} />
        <br />
        <span className="faint" style={{ fontSize: '0.8rem' }}>Generated {b.generated_at.slice(0, 16).replace('T', ' ')} · {b.method}</span>
      </p>
      <h3>Suggested 60-minute plan</h3>
      <ol>
        {b.agenda.map((a, i) => <li key={i}><strong>{a.minutes} min</strong> — {a.item}</li>)}
      </ol>
      <div className="grid cols-2">
        <div>
          <h3>This lesson's exercises</h3>
          <ul style={{ paddingLeft: 18 }}>
            {b.exercises.map((e) => <li key={e.id}><code>{e.id}</code> {e.description} {e.covered ? <Badge tone="info">covered</Badge> : <Badge>not evidenced</Badge>}</li>)}
          </ul>
        </div>
        <div>
          <h3>Tutor priorities & watch-outs</h3>
          {b.tutor_priorities.length ? (
            <ul style={{ paddingLeft: 18 }}>{b.tutor_priorities.map((p, i) => <li key={i}><strong>{p.field}:</strong> {p.text} <Cites citations={p.citations} /></li>)}</ul>
          ) : (
            <p className="faint">No tutor feedback yet. <Link to="/feedback">Add feedback</Link> to shape the next lesson.</p>
          )}
        </div>
        <div>
          <h3>Carry-over gaps from earlier lessons</h3>
          {b.carry_over_gaps.length ? (
            <ul style={{ paddingLeft: 18 }}>{b.carry_over_gaps.slice(0, 15).map((g, i) => <li key={i}>{g.text} <Cites citations={g.citations} /></li>)}</ul>
          ) : (
            <p className="faint">None — no held lessons with unevidenced exercises.</p>
          )}
        </div>
        <div>
          <h3>Failed criteria to retry</h3>
          {b.failed_criteria.length ? (
            <ul style={{ paddingLeft: 18 }}>{b.failed_criteria.map((f, i) => <li key={i}><code>{f.criterion_id}</code> {f.text} <span className="faint">— {f.reason} (attempt {f.attempt_date})</span></li>)}</ul>
          ) : (
            <p className="faint">No failed criteria on latest attempts.</p>
          )}
        </div>
        <div>
          <h3>Open homework</h3>
          {b.open_homework.length ? (
            <ul style={{ paddingLeft: 18 }}>{b.open_homework.map((h) => <li key={h.id}>{h.description} {h.due_date && <span className={h.overdue ? 'badge bad' : 'faint'}>due {h.due_date}</span>}</li>)}</ul>
          ) : (
            <p className="faint">No open homework.</p>
          )}
        </div>
        <div>
          <h3>Recurring difficulties</h3>
          {b.recurring_difficulties.length ? (
            <ul style={{ paddingLeft: 18 }}>{b.recurring_difficulties.map((d, i) => <li key={i}>{d.text} <Cites citations={d.citations} /></li>)}</ul>
          ) : (
            <p className="faint">None extracted from analysed transcripts.</p>
          )}
        </div>
      </div>
      {b.covered_recently.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary><strong>Recently evidenced ({b.covered_recently.length})</strong></summary>
          <ul style={{ paddingLeft: 18 }}>{b.covered_recently.map((c, i) => <li key={i}><code>{c.exercise_id}</code> {label(c.category)} <Cites citations={c.citations} /></li>)}</ul>
        </details>
      )}
      {b.domain_assessment && <p className="notice" style={{ marginTop: 8 }}>Domain assessment <strong>{b.domain_assessment.id}</strong> follows this lesson: {b.domain_assessment.description}</p>}
      {b.pending_review > 0 && <p className="notice warn" style={{ marginTop: 8 }}>{b.pending_review} transcript matches are still unreviewed — <Link to="/intelligence">review them</Link> for a more accurate briefing.</p>}
    </Card>
  );
}

export default function Gaps() {
  const [params, setParams] = useSearchParams();
  const lessonId = params.get('lesson') || '';
  const { data: g, error, loading, reload } = useApi('/gaps');
  const { data: schedule } = useApi('/schedule');
  const lessons = schedule ? schedule.flatMap((w) => w.lessons) : [];
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Learning Gaps & Next Lesson Briefing</h1>
          <p className="muted">“Not evidenced” means no approved evidence in saved records — not proof that a topic was never taught.</p>
        </div>
        <select value={lessonId} onChange={(e) => setParams(e.target.value ? { lesson: e.target.value } : {})} aria-label="Brief for lesson">
          <option value="">Next planned lesson</option>
          {lessons.map((l) => <option key={l.id} value={l.id}>L{l.number} {l.title}</option>)}
        </select>
      </div>
      <Briefing key={lessonId} lessonId={lessonId} />
      <div className="section">
        {loading && !g && <Loading />}
        <ErrorBox error={error} retry={reload} />
        {g && (
          <div className="grid cols-2">
            <Card title="Gaps by competency">
              {!g.by_competency.length && <Empty>No held lessons yet — mark lessons as held to see gaps.</Empty>}
              {g.by_competency.map((c) => (
                <div key={c.competency_id} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
                  <div className="row between">
                    <Link to={`/schedule/${c.lesson_id}`}><strong>{c.competency_id} · {c.title}</strong></Link>
                    <MasteryBadge state={c.mastery_state} />
                  </div>
                  <ul style={{ paddingLeft: 18, margin: '4px 0', fontSize: '0.88rem' }}>
                    {c.uncovered_exercises.map((e) => <li key={e.id}><code>{e.id}</code> {e.description} — not evidenced</li>)}
                    {c.facet_gaps.map((f, i) => <li key={i}>{f.message}</li>)}
                    {c.needs_practice.map((e) => <li key={e.id}><Badge status="needs_practice" /> {e.id} {e.description}</li>)}
                    {c.failed_criteria.map((f) => <li key={f.criterion_id}><Badge status="fail">failed</Badge> {f.text} <span className="faint">({f.reason})</span></li>)}
                    {c.lesson_held && c.not_yet_attempted && <li><Badge>test not attempted</Badge> <Link to={`/assessments/${c.competency_id}`}>record a practical test</Link></li>}
                  </ul>
                </div>
              ))}
            </Card>
            <div className="stack">
              <Card title="Not-yet-attempted tests">
                {g.not_yet_attempted_tests.length || g.domain_assessments_due.length ? (
                  <ul style={{ paddingLeft: 18, margin: 0 }}>
                    {g.not_yet_attempted_tests.map((t) => <li key={t.competency_id}><Link to={`/assessments/${t.competency_id}`}>{t.competency_id} {t.title}</Link></li>)}
                    {g.domain_assessments_due.map((d) => <li key={d.id}><Link to={`/assessments/${d.id}`}>Domain assessment {d.id}</Link> is due</li>)}
                  </ul>
                ) : (
                  <p className="faint">Nothing due.</p>
                )}
              </Card>
              <Card title="Open homework">
                {g.open_homework.length ? (
                  <ul style={{ paddingLeft: 18, margin: 0 }}>{g.open_homework.map((h) => <li key={h.id}>{h.description} {h.due_date && <span className={h.overdue ? 'badge bad' : 'faint'}>due {h.due_date}</span>}</li>)}</ul>
                ) : (
                  <p className="faint">No open homework.</p>
                )}
              </Card>
              {g.pending_review > 0 && <div className="notice warn">{g.pending_review} proposed matches awaiting review. <Link to="/intelligence">Review</Link></div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
