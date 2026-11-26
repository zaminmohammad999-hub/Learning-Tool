import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import ExerciseRow from '../components/ExerciseRow.jsx';
import { Badge, Card, Empty, ErrorBox, Field, Loading, MasteryBadge, ProgressBar } from '../components/ui.jsx';

const COVERAGE = {
  not_covered: ['', 'Not covered'],
  discussed: ['info', 'Discussed'],
  demonstrated: ['info', 'Demonstrated'],
  independently_completed: ['good', 'Done independently'],
};

/** Claude's review of the lesson: how well each objective was covered, with a generous score. */
function LessonReview({ lesson }) {
  const { data: r, reload } = useApi(`/lessons/${lesson.id}/review`);
  const { data: health } = useApi('/ai/status');
  const act = useAction();
  const hasTranscript = lesson.sessions?.length > 0 || lesson.transcript_count > 0;
  const run = () => act.run(async () => { await api.post(`/lessons/${lesson.id}/review`); await reload(); });
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row between">
        <strong>How the lesson went (Claude's review of the transcript)</strong>
        <button className="btn small" disabled={act.busy || !health?.available} title={health?.available ? '' : health?.reason} onClick={run}>
          {act.busy ? 'Reviewing…' : r ? 'Review again' : 'Review this lesson'}
        </button>
      </div>
      <ErrorBox error={act.error} />
      {!r ? (
        <p className="faint" style={{ fontSize: '0.85rem', margin: '6px 0 0' }}>
          {hasTranscript ? 'Not reviewed yet. New lessons are reviewed automatically after the transcript is imported.' : 'No transcript for this lesson yet. It will be reviewed automatically after the lesson.'}
        </p>
      ) : (
        <div className="stack" style={{ marginTop: 8 }}>
          <ProgressBar kind="coverage" value={r.overall_score} total={100} caption={`Lesson coverage: ${r.overall_score}%`} />
          <p style={{ margin: 0, fontSize: '0.9rem' }}>{r.overall_summary}</p>
          <ul className="comp-list" style={{ margin: 0 }}>
            {r.objectives.map((o) => (
              <li key={o.exercise_id}>
                <div className="row between">
                  <span style={{ fontSize: '0.9rem' }}>{o.description}</span>
                  <span className="row" style={{ gap: 6 }}>
                    <Badge tone={COVERAGE[o.coverage]?.[0]}>{COVERAGE[o.coverage]?.[1] || o.coverage}</Badge>
                    <strong style={{ minWidth: 42, textAlign: 'right' }}>{o.score}%</strong>
                  </span>
                </div>
                <div className="faint" style={{ fontSize: '0.82rem' }}>
                  {o.summary}
                  {o.evidence_segment ? ` (transcript line #${o.evidence_segment})` : ''}
                </div>
              </li>
            ))}
          </ul>
          {(r.went_well?.length > 0 || r.to_practise?.length > 0) && (
            <div className="grid cols-2">
              {r.went_well?.length > 0 && (
                <div>
                  <div className="faint" style={{ fontSize: '0.8rem' }}>Went well</div>
                  <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: '0.88rem' }}>{r.went_well.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              )}
              {r.to_practise?.length > 0 && (
                <div>
                  <div className="faint" style={{ fontSize: '0.8rem' }}>To practise</div>
                  <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: '0.88rem' }}>{r.to_practise.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          <p className="faint" style={{ fontSize: '0.78rem', margin: 0 }}>
            Scored generously: it shows how much of each objective the lesson covered, not mastery. Reviewed {new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
            {r.truncated ? ' · the transcript was very long and only the first part was reviewed' : ''}.
          </p>
        </div>
      )}
    </div>
  );
}

function LessonDetail({ lessonId, onChanged }) {
  const { data: l, error, loading, reload } = useApi(`/lessons/${lessonId}`);
  const [form, setForm] = useState(null);
  const [hw, setHw] = useState({ description: '', due_date: '' });
  const act = useAction();
  useEffect(() => {
    if (l) setForm({ status: l.status, held_date: l.held_date || '', tutor: l.tutor || '', objectives: l.objectives || '', homework_text: l.homework_text || '', notes: l.notes || '' });
  }, [l]);
  if (loading && !l) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!form) return null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = () =>
    act.run(async () => {
      await api.patch(`/lessons/${lessonId}/progress`, form);
      await reload();
      onChanged?.();
    });
  const canonical = l.exercises.filter((e) => e.is_canonical);

  return (
    <div className="stack">
      <Card
        title={`Lesson ${l.number} · ${l.title}`}
        actions={
          <>
            <Badge status={l.status} />
            <Link className="btn small" to={`/intelligence?lesson=${l.id}`}>+ Transcript</Link>
            <Link className="btn small" to={`/gaps?lesson=${l.id}`}>Briefing</Link>
          </>
        }
      >
        <p className="muted">
          Week {l.week}, session {l.session_in_week} · {l.duration_minutes} min · {l.domain_name} › {l.competency_title}
          {l.status === 'held' && l.held_date ? ` · held ${l.held_date}` : l.planned_date ? ` · planned ${l.planned_date}${l.schedule_source === 'calendar' ? ' (from your calendar)' : ''}` : ''}
        </p>
        <div className="grid cols-2">
          <ProgressBar kind="coverage" value={canonical.filter((e) => e.covered).length} total={4} caption="Exercises evidenced (coverage)" />
          <div className="row between">
            <span className="muted" style={{ fontSize: '0.85rem' }}>Competency mastery</span>
            <MasteryBadge state={l.mastery.state} awaiting={l.mastery.awaiting_verification} />
          </div>
        </div>
        <LessonReview lesson={l} />
        <hr />
        <div className="grid cols-3">
          <Field label="Lesson status (held ≠ completed mastery)">
            <select value={form.status} onChange={set('status')}>
              <option value="planned">Planned</option>
              <option value="held">Held</option>
              <option value="missed">Missed</option>
            </select>
          </Field>
          <Field label="Held on"><input type="date" value={form.held_date} onChange={set('held_date')} /></Field>
          <Field label="Tutor"><input type="text" value={form.tutor} onChange={set('tutor')} /></Field>
        </div>
        <div className="grid cols-2" style={{ marginTop: 10 }}>
          <Field label="Objectives (defaults to the four exercises)">
            <textarea rows={4} value={form.objectives} placeholder={l.default_objectives.map((o) => `• ${o}`).join('\n')} onChange={set('objectives')} />
          </Field>
          <Field label="Lesson notes"><textarea rows={4} value={form.notes} onChange={set('notes')} /></Field>
          <Field label="Homework summary"><textarea rows={2} value={form.homework_text} onChange={set('homework_text')} /></Field>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={act.busy} onClick={save}>Save lesson</button>
          <ErrorBox error={act.error} />
        </div>
      </Card>

      <Card title="Linked practical exercises">
        {l.exercises.map((e) => <ExerciseRow key={e.id} ex={e} onChange={reload} />)}
      </Card>

      <div className="grid cols-2">
        <Card title="Sessions & transcripts">
          {l.sessions.length ? (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {l.sessions.map((s) => (
                <li key={s.id}>
                  <Link to={`/sessions/${s.id}`}>{s.session_date}</Link> {s.title} · {s.tutor || 'tutor ?'} · {s.transcript_count} transcript(s)
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No session linked. {l.status === 'held' && 'This lesson is marked held but has no transcript evidence.'}</Empty>
          )}
        </Card>
        <Card title="Homework">
          {l.homework.length ? (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {l.homework.map((h) => (
                <li key={h.id}><Badge status={h.status === 'done' ? 'pass' : 'pending'}>{h.status}</Badge> {h.description} {h.due_date && <span className="faint">due {h.due_date}</span>}</li>
              ))}
            </ul>
          ) : (
            <p className="faint">No homework items.</p>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <input type="text" placeholder="New homework item" value={hw.description} onChange={(e) => setHw({ ...hw, description: e.target.value })} style={{ flex: 1 }} />
            <input type="date" value={hw.due_date} onChange={(e) => setHw({ ...hw, due_date: e.target.value })} aria-label="Due date" />
            <button
              className="btn small"
              disabled={!hw.description.trim() || act.busy}
              onClick={() => act.run(async () => { await api.post('/homework', { ...hw, lesson_id: l.id }); setHw({ description: '', due_date: '' }); reload(); })}
            >
              Add
            </button>
          </div>
        </Card>
        <Card title="Tutor feedback" actions={<Link to={`/feedback?lesson=${l.id}`}>+ add</Link>}>
          {l.feedback.length ? (
            l.feedback.map((f) => (
              <div key={f.id} style={{ fontSize: '0.9rem', marginBottom: 8 }}>
                <strong>{f.feedback_date}</strong> {f.next_priorities && <>· Next: {f.next_priorities}</>} {f.weaknesses && <div className="muted">Weakness: {f.weaknesses}</div>}
              </div>
            ))
          ) : (
            <p className="faint">No feedback for this lesson yet.</p>
          )}
        </Card>
        <Card title="Results">
          <p>Rubric: best {l.mastery.best_criteria_passed}/{l.mastery.mandatory_count} criteria passed independently across {l.mastery.attempts} attempt(s).</p>
          <Link to={`/assessments/${l.competency_id}`}>Open practical assessment →</Link>
          {l.domain_assessment_after && (
            <p style={{ marginTop: 8 }}>
              <strong>Domain assessment {l.domain_assessment_after.id}</strong> is scheduled after this lesson:{' '}
              {l.domain_assessment_after.latest_result ? <Badge status={l.domain_assessment_after.latest_result} /> : <Badge>not attempted</Badge>}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function Schedule() {
  const { lessonId } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi('/schedule');
  if (loading && !data) return <Loading what="Loading schedule" />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Weekly Schedule</h1>
          <p className="muted">12 weeks × 2 instructor-led lessons × 60 minutes. Lesson status (planned / held / missed) is separate from coverage and mastery.</p>
        </div>
      </div>
      <div className={lessonId ? 'grid split' : 'grid'}>
        <div className={lessonId ? 'stack' : 'grid cols-3'}>
          {data.map((w) => (
            <div key={w.week} className="card" style={{ padding: 12, marginTop: 0 }}>
              <h3>Week {w.week}</h3>
              {w.lessons.map((l) => (
                <button
                  key={l.id}
                  className="btn"
                  style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 6, borderColor: l.id === lessonId ? 'var(--accent)' : undefined }}
                  onClick={() => navigate(`/schedule/${l.id}`)}
                  aria-current={l.id === lessonId ? 'page' : undefined}
                >
                  <div className="row between">
                    <strong>L{l.number} · {l.title}</strong>
                    <Badge status={l.status} />
                  </div>
                  <div className="faint" style={{ fontSize: '0.8rem' }}>
                    {l.planned_date || 'date not set'} · covered {l.coverage.covered}/{l.coverage.total} · {l.transcript_count} transcript(s)
                    {l.domain_assessment_after && ` · then ${l.domain_assessment_after.id}`}
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
        {lessonId && (
          <div>
            <LessonDetail key={lessonId} lessonId={lessonId} onChanged={reload} />
          </div>
        )}
      </div>
    </div>
  );
}
