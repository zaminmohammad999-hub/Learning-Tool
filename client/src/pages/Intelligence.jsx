import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import AnalysisReview from '../components/AnalysisReview.jsx';
import { Card, Empty, ErrorBox, Loading } from '../components/ui.jsx';

function Bullets({ title, items }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="faint" style={{ fontSize: '0.8rem', marginBottom: 2 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.92rem' }}>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** "Review lesson": covered vs the lesson's objectives, missed, next steps, and how to run and organise. */
function LessonReviewCard({ lesson, names, ai }) {
  const { data, reload } = useApi(`/insights/${lesson.id}`);
  const act = useAction();
  const r = data?.review;
  return (
    <Card
      title={`Lesson ${lesson.number}: ${lesson.title}`}
      actions={
        <button className="btn primary" disabled={act.busy || !ai?.available} title={ai?.available ? '' : ai?.reason} onClick={() => act.run(async () => { await api.post(`/insights/${lesson.id}/review`); await reload(); })}>
          {act.busy ? 'Reviewing…' : r ? 'Review lesson again' : 'Review lesson'}
        </button>
      }
    >
      <ErrorBox error={act.error} />
      {!r ? (
        <p className="faint" style={{ margin: 0 }}>Click <strong>Review lesson</strong> for a short summary of what was covered against this lesson's objectives, what was missed, and what to do next.</p>
      ) : (
        <div className="stack">
          <div className="grid cols-3">
            <Bullets title="Covered (against the objectives)" items={r.covered} />
            <Bullets title="Missed" items={r.missed} />
            <Bullets title="Next steps" items={r.next_steps} />
          </div>
          <hr style={{ margin: '4px 0' }} />
          <div className="grid cols-3">
            <Bullets title={`How ${names.tutor} could run the lesson`} items={r.how_to_run_the_lesson} />
            <Bullets title={`What ${names.learner} should do during the lesson`} items={r.learner_during_lesson} />
            <Bullets title={`How ${names.learner} should stay organised`} items={r.learner_organisation} />
          </div>
          <p className="faint" style={{ fontSize: '0.78rem', margin: 0 }}>Reviewed {when(r.created_at)} from the lesson transcript and records.</p>
        </div>
      )}
    </Card>
  );
}

/** "Possible format": a suggested plan for the next lesson, for the tutor. */
function NextLessonCard({ lesson, names, ai }) {
  const { data, reload } = useApi(`/insights/${lesson.id}`);
  const act = useAction();
  const [minutes, setMinutes] = useState(null);
  const f = data?.format;
  return (
    <Card
      title={`Next lesson: Lesson ${lesson.number}: ${lesson.title}`}
      actions={
        <button
          className="btn primary"
          disabled={act.busy || !ai?.available}
          title={ai?.available ? '' : ai?.reason}
          onClick={() => act.run(async () => { const r = await api.post(`/insights/${lesson.id}/format`); setMinutes(r.minutes); await reload(); })}
        >
          {act.busy ? 'Planning…' : f ? 'Possible format again' : 'Possible format'}
        </button>
      }
    >
      <ErrorBox error={act.error} />
      {!f ? (
        <p className="faint" style={{ margin: 0 }}>
          Click <strong>Possible format</strong> for a suggested plan {names.tutor} can use: the exercises and explanations for this lesson, with timings, building on what happened so far.
        </p>
      ) : (
        <div className="stack">
          <p style={{ margin: 0 }}><strong>Goal:</strong> {f.goal}</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Min</th>
                  <th>Part</th>
                  <th>{names.tutor}</th>
                  <th>{names.learner}</th>
                </tr>
              </thead>
              <tbody>
                {f.agenda.map((a, i) => (
                  <tr key={i}>
                    <td>{a.minutes}</td>
                    <td><strong>{a.title}</strong></td>
                    <td style={{ fontSize: '0.88rem' }}>{a.tutor_does}</td>
                    <td style={{ fontSize: '0.88rem' }}>{a.learner_does}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid cols-2">
            <Bullets title="Explain" items={f.explanations} />
            <Bullets title="Exercises" items={f.exercises?.map((e) => `${e.task} (${e.objective})`)} />
            <Bullets title={`Before the lesson: ${names.tutor}`} items={f.before_the_lesson?.tutor} />
            <Bullets title={`Before the lesson: ${names.learner}`} items={f.before_the_lesson?.learner} />
          </div>
          <Bullets title="Carried over from earlier lessons" items={f.carry_over} />
          <p className="faint" style={{ fontSize: '0.78rem', margin: 0 }}>
            Suggested {when(f.created_at)}{minutes ? ` for a ${minutes}-minute lesson` : ''}. A starting point for {names.tutor}, not a script.
          </p>
        </div>
      )}
    </Card>
  );
}

/** Findings Claude was unsure about (everything else is filled in automatically). */
function NeedsCheck() {
  const { data, reload } = useApi('/review/pending');
  if (!data?.length) return null;
  return (
    <Card title={`Needs your check (${data.reduce((n, a) => n + a.matches.filter((m) => m.review_status === 'pending').length, 0)})`}>
      <p className="faint" style={{ marginTop: 0, fontSize: '0.85rem' }}>Claude was unsure about these, so they were not filled in automatically.</p>
      {data.map((a) => (
        <AnalysisReview key={a.id} analysis={a} onDecided={reload} />
      ))}
    </Card>
  );
}

export default function Intelligence() {
  const { data: schedule } = useApi('/schedule');
  const { data: settings } = useApi('/settings');
  const [selected, setSelected] = useState(null);
  const lessons = schedule ? schedule.flatMap((w) => w.lessons) : [];
  const recorded = lessons.filter((l) => l.transcript_count > 0);
  const lastRecorded = recorded.length ? recorded[recorded.length - 1].id : null;
  useEffect(() => {
    if (!selected && lastRecorded) setSelected(lastRecorded);
  }, [lastRecorded, selected]);
  if (!schedule || !settings) return <Loading />;
  const names = { tutor: settings.settings.tutor_name || 'Tutor', learner: settings.settings.learner_name || 'Learner' };
  const lesson = lessons.find((l) => l.id === selected);
  const next = lesson ? lessons.find((l) => l.number > lesson.number && l.status === 'planned') : lessons.find((l) => l.status === 'planned');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Tutor Intelligence</h1>
          <p className="muted">A short review of each recorded lesson, and a suggested format for the next one.</p>
        </div>
        {recorded.length > 0 && (
          <label className="row" style={{ fontSize: '0.9rem' }}>
            Lesson
            <select value={selected || ''} onChange={(e) => setSelected(e.target.value)}>
              {recorded.map((l) => (
                <option key={l.id} value={l.id}>
                  L{l.number} · {l.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="stack">
        {lesson ? <LessonReviewCard key={lesson.id} lesson={lesson} names={names} ai={settings.ai} /> : <Empty>No recorded lessons yet. Lessons recorded with Hearsay appear here automatically.</Empty>}
        {next && <NextLessonCard key={next.id} lesson={next} names={names} ai={settings.ai} />}
        <NeedsCheck />
      </div>
    </div>
  );
}
