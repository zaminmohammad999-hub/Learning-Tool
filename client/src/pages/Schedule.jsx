import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import ExerciseRow from '../components/ExerciseRow.jsx';
import { Badge, Card, Empty, ErrorBox, Field, Loading, MasteryBadge, ProgressBar } from '../components/ui.jsx';

function LessonDetail({ lessonId, onChanged }) {
  const { data: l, error, loading, reload } = useApi(`/lessons/${lessonId}`);
  const [form, setForm] = useState(null);
  const [hw, setHw] = useState({ description: '', due_date: '' });
  const act = useAction();
  useEffect(() => {
    if (l) setForm({ status: l.status, scheduled_date: l.scheduled_date || '', held_date: l.held_date || '', tutor: l.tutor || '', objectives: l.objectives || '', homework_text: l.homework_text || '', notes: l.notes || '' });
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
          {l.planned_date && ` · planned ${l.planned_date}`}
        </p>
        <div className="grid cols-2">
          <ProgressBar kind="coverage" value={canonical.filter((e) => e.covered).length} total={4} caption="Exercises evidenced (coverage)" />
          <div className="row between">
            <span className="muted" style={{ fontSize: '0.85rem' }}>Competency mastery</span>
            <MasteryBadge state={l.mastery.state} awaiting={l.mastery.awaiting_verification} />
          </div>
        </div>
        <hr />
        <div className="grid cols-3">
          <Field label="Lesson status (held ≠ completed mastery)">
            <select value={form.status} onChange={set('status')}>
              <option value="planned">planned</option>
              <option value="held">held</option>
              <option value="missed">missed</option>
            </select>
          </Field>
          <Field label="Scheduled date"><input type="date" value={form.scheduled_date} onChange={set('scheduled_date')} /></Field>
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
