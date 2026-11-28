import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import ExerciseRow from '../components/ExerciseRow.jsx';
import { HomeworkList } from '../components/Homework.jsx';
import { Badge, Card, Empty, ErrorBox, Field, Loading, MasteryBadge, ProgressBar, label } from '../components/ui.jsx';

const COVERAGE = {
  not_covered: ['', 'Not covered'],
  discussed: ['info', 'Discussed'],
  demonstrated: ['info', 'Demonstrated'],
  independently_completed: ['good', 'Done independently'],
};

/**
 * The lesson's objectives (its curriculum exercises) in one place: Claude's score for how well the transcript
 * covered each one (generous), its current status, and an editor for status and evidence.
 */
function Objectives({ lesson, onChanged }) {
  const { data: r, reload } = useApi(`/lessons/${lesson.id}/review`);
  const { data: health } = useApi('/ai/status');
  const act = useAction();
  const hasTranscript = lesson.sessions?.length > 0;
  const run = () => act.run(async () => { await api.post(`/lessons/${lesson.id}/review`); await reload(); });
  const scoreFor = new Map((r?.objectives || []).map((o) => [o.exercise_id, o]));
  return (
    <Card
      title="Objectives"
      actions={
        hasTranscript && (
          <button className="btn small" disabled={act.busy || !health?.available} title={health?.available ? '' : health?.reason} onClick={run}>
            {act.busy ? 'Scoring…' : r ? 'Score again' : 'Score from transcript'}
          </button>
        )
      }
    >
      <ErrorBox error={act.error} />
      {r ? (
        <div className="stack" style={{ marginBottom: 10 }}>
          <ProgressBar kind="coverage" value={r.overall_score} total={100} caption={`Lesson score: ${r.overall_score}%`} />
          <p style={{ margin: 0, fontSize: '0.9rem' }}>{r.overall_summary}</p>
        </div>
      ) : (
        <p className="faint" style={{ fontSize: '0.85rem', marginTop: 0 }}>
          {lesson.status === 'held' || hasTranscript
            ? 'Not scored yet. Lessons are scored automatically from the transcript once they are held.'
            : 'Each objective is scored automatically from the transcript once the lesson is held.'}
        </p>
      )}
      <ul className="comp-list" style={{ margin: 0 }}>
        {lesson.exercises.map((e) => {
          const o = scoreFor.get(e.id);
          return (
            <li key={e.id}>
              <div className="row between">
                <span style={{ fontSize: '0.92rem' }}>{e.description}</span>
                <span className="row" style={{ gap: 6 }}>
                  {o && <Badge tone={COVERAGE[o.coverage]?.[0]}>{COVERAGE[o.coverage]?.[1] || o.coverage}</Badge>}
                  <strong style={{ minWidth: 42, textAlign: 'right' }}>{o ? `${o.score}%` : '–'}</strong>
                </span>
              </div>
              {o && (
                <div className="faint" style={{ fontSize: '0.82rem' }}>
                  {o.summary}
                  {o.evidence_segment ? ` (transcript line #${o.evidence_segment})` : ''}
                </div>
              )}
              <details style={{ marginTop: 2 }}>
                <summary className="faint" style={{ fontSize: '0.8rem' }}>
                  Status: {label(e.status)}
                  {e.covered ? ' · counted as covered' : ''} · edit status and evidence
                </summary>
                <ExerciseRow ex={e} onChange={onChanged} />
              </details>
            </li>
          );
        })}
      </ul>
      {r?.went_well?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="faint" style={{ fontSize: '0.8rem' }}>Went well</div>
          <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: '0.88rem' }}>{r.went_well.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
      {r && (
        <p className="faint" style={{ fontSize: '0.78rem', margin: '8px 0 0' }}>
          Scored generously by Claude from the transcript: how much of each objective the lesson covered, not mastery. Scored{' '}
          {new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
          {r.truncated ? ' · the transcript was very long and only the first part was scored' : ''}.
        </p>
      )}
    </Card>
  );
}

/** One feedback entry on the lesson page, focused on the tutor's view. */
function TutorFeedbackSummary({ f }) {
  const block = (title, text) =>
    text ? (
      <div style={{ marginTop: 6 }}>
        <div className="faint" style={{ fontSize: '0.8rem' }}>{title}</div>
        <div style={{ whiteSpace: 'pre-line', fontSize: '0.88rem' }}>{text}</div>
      </div>
    ) : null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: '0.82rem' }} className="faint">
        {f.feedback_date} · {f.author || 'feedback'}
      </div>
      {f.analysis && (
        <div className="notice" style={{ fontSize: '0.88rem', marginTop: 6 }}>
          <strong>What she seems to be thinking</strong> <span className="faint">(interpretation)</span>
          <div style={{ marginTop: 2 }}>{f.analysis}</div>
        </div>
      )}
      {block('Positives', f.strengths)}
      {block('Concerns', f.weaknesses)}
      {block('Questions she asked', f.tutor_questions)}
      {block('Her comments', f.corrections)}
      {block('Next priorities', f.next_priorities)}
    </div>
  );
}

function LessonDetail({ lessonId, onChanged }) {
  const { data: l, error, loading, reload } = useApi(`/lessons/${lessonId}`);
  const [form, setForm] = useState(null);
  const [hw, setHw] = useState({ description: '', due_date: '' });
  const act = useAction();
  useEffect(() => {
    if (l) setForm({ status: l.status, held_date: l.held_date || '', tutor: l.tutor || '', notes: l.notes || '' });
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

  return (
    <div className="stack">
      <Card
        title={`Lesson ${l.number} · ${l.title}`}
        actions={
          <>
            <Badge status={l.status} />
            <Link className="btn small" to={`/gaps?lesson=${l.id}`}>Briefing</Link>
          </>
        }
      >
        <p className="muted">
          Week {l.week}, session {l.session_in_week} · {l.duration_minutes} min · {l.domain_name} › {l.competency_title}
          {l.status === 'held' && l.held_date ? ` · held ${l.held_date}` : l.planned_date ? ` · planned ${l.planned_date}${l.schedule_source === 'calendar' ? ' (from your calendar)' : ''}` : ''}
        </p>
        <div className="row" style={{ fontSize: '0.85rem' }}>
          <span className="muted">Competency mastery</span>
          <MasteryBadge state={l.mastery.state} awaiting={l.mastery.awaiting_verification} />
        </div>
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
        <Field label="Lesson notes" style={{ marginTop: 10 }}><textarea rows={3} value={form.notes} onChange={set('notes')} /></Field>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={act.busy} onClick={save}>Save lesson</button>
          <ErrorBox error={act.error} />
        </div>
      </Card>

      <Objectives lesson={l} onChanged={reload} />

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
          <HomeworkList items={l.homework} tutor={l.tutor || 'Fariha'} onChange={reload} />
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
            l.feedback.map((f) => <TutorFeedbackSummary key={f.id} f={f} />)
          ) : (
            <p className="faint">No feedback yet. After a recorded lesson, {l.tutor || 'your tutor'}'s positives, concerns, questions and what she seems to be thinking are filled in from the transcript.</p>
          )}
        </Card>
        <Card title="Practical assessment">
          {(() => {
            const total = l.homework.length;
            const approved = l.homework.filter((h) => h.review_status === 'approved').length;
            if (total && approved < total)
              return (
                <>
                  <p style={{ marginTop: 0 }}>
                    <Badge>Locked</Badge> Available once all of this lesson's homework is approved by {l.tutor || 'your tutor'}: {approved} of {total} approved.
                  </p>
                  <ProgressBar kind="partial" value={approved} total={total} caption="Homework approved" />
                </>
              );
            return (
              <>
                <p style={{ marginTop: 0 }}>
                  {total ? <Badge status="pass">Homework approved</Badge> : null} Best result so far: {l.mastery.best_criteria_passed}/{l.mastery.mandatory_count} criteria passed independently across {l.mastery.attempts} attempt(s).
                </p>
                <Link to={`/assessments/${l.competency_id}`}>Open practical assessment →</Link>
              </>
            );
          })()}
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
