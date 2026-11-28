import { HomeworkList } from '../components/Homework.jsx';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import { Badge, Card, Empty, ErrorBox, Field, Loading, today } from '../components/ui.jsx';

const TEXT_FIELDS = [
  ['strengths', 'Positives (what she liked)'],
  ['weaknesses', 'Concerns'],
  ['misunderstandings', 'Misunderstandings'],
  ['corrections', 'Corrections given'],
  ['practiced', 'What was practised'],
  ['homework', 'Homework (summary)'],
  ['next_priorities', 'Next session priorities'],
  ['tutor_questions', 'Questions she asked'],
  ['analysis', 'What she seems to be thinking (interpretation)'],
];

function FeedbackForm({ initial, preset, onSaved, onCancel }) {
  const { data: sessions } = useApi('/sessions');
  const { data: schedule } = useApi('/schedule');
  const [f, setF] = useState(
    initial || preset || { feedback_date: today(), author: '', session_id: null, lesson_id: null, confidence: null, exercise_ids: [], ...Object.fromEntries(TEXT_FIELDS.map(([k]) => [k, ''])) }
  );
  const [hwItems, setHwItems] = useState([]);
  const act = useAction();
  const lessons = schedule ? schedule.flatMap((w) => w.lessons) : [];
  const lessonExercises = lessons.find((l) => l.id === f.lesson_id)?.exercises || [];

  const save = () =>
    act.run(async () => {
      const body = { ...f };
      ['id', 'history', 'created_at', 'updated_at', 'exercise_ids_json', 'lesson_number', 'lesson_title', 'session_date'].forEach((k) => delete body[k]);
      if (initial) await api.patch(`/feedback/${initial.id}`, body);
      else await api.post('/feedback', { ...body, homework_items: hwItems.filter((h) => h.description.trim()) });
      onSaved();
    });

  return (
    <div className="stack">
      <div className="grid cols-4">
        <Field label="Date"><input type="date" value={f.feedback_date} onChange={(e) => setF({ ...f, feedback_date: e.target.value })} /></Field>
        <Field label="Author"><input type="text" value={f.author || ''} onChange={(e) => setF({ ...f, author: e.target.value })} /></Field>
        <Field label="Lesson">
          <select value={f.lesson_id || ''} onChange={(e) => setF({ ...f, lesson_id: e.target.value || null })}>
            <option value="">—</option>
            {lessons.map((l) => <option key={l.id} value={l.id}>L{l.number} {l.title}</option>)}
          </select>
        </Field>
        <Field label="Session">
          <select value={f.session_id || ''} onChange={(e) => setF({ ...f, session_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {sessions?.map((s) => <option key={s.id} value={s.id}>{s.session_date} {s.title || ''}</option>)}
          </select>
        </Field>
        <Field label="Learner confidence (1–5)">
          <select value={f.confidence ?? ''} onChange={(e) => setF({ ...f, confidence: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid cols-2">
        {TEXT_FIELDS.map(([k, l]) => (
          <Field key={k} label={l}><textarea rows={2} value={f[k] || ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
        ))}
      </div>
      {lessonExercises.length > 0 && (
        <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
          <legend style={{ fontSize: '0.85rem' }}>Linked curriculum exercises</legend>
          {lessonExercises.map((e) => (
            <label key={e.id} className="row" style={{ fontSize: '0.88rem' }}>
              <input type="checkbox" checked={f.exercise_ids.includes(e.id)} onChange={() => setF({ ...f, exercise_ids: f.exercise_ids.includes(e.id) ? f.exercise_ids.filter((x) => x !== e.id) : [...f.exercise_ids, e.id] })} />
              <code>{e.id}</code> {e.description}
            </label>
          ))}
        </fieldset>
      )}
      {!initial && (
        <div>
          <strong style={{ fontSize: '0.9rem' }}>Homework items</strong>
          {hwItems.map((h, i) => (
            <div key={i} className="row" style={{ marginTop: 4 }}>
              <input type="text" value={h.description} placeholder="Homework task" onChange={(e) => setHwItems(hwItems.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} style={{ flex: 1 }} />
              <input type="date" value={h.due_date} onChange={(e) => setHwItems(hwItems.map((x, j) => (j === i ? { ...x, due_date: e.target.value } : x)))} aria-label="Due date" />
            </div>
          ))}
          <button className="btn small" style={{ marginTop: 4 }} onClick={() => setHwItems([...hwItems, { description: '', due_date: '' }])}>+ homework item</button>
        </div>
      )}
      <div className="row">
        <button className="btn primary" disabled={act.busy} onClick={save}>{initial ? 'Save changes' : 'Save feedback'}</button>
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        <ErrorBox error={act.error} />
      </div>
    </div>
  );
}

function FeedbackItem({ f, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(null);
  const act = useAction();
  if (editing) return <Card title={`Edit feedback ${f.feedback_date}`}><FeedbackForm initial={f} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} /></Card>;
  return (
    <Card
      title={`${f.feedback_date}${f.lesson_number ? ` · L${f.lesson_number} ${f.lesson_title}` : ''}`}
      actions={
        <>
          {f.confidence && <Badge>confidence {f.confidence}/5</Badge>}
          <button className="btn small" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn small" onClick={() => act.run(async () => setHistory((await api.get(`/feedback/${f.id}`)).history))}>History</button>
          <button className="btn small danger" onClick={() => window.confirm('Delete this feedback?') && act.run(async () => { await api.del(`/feedback/${f.id}`); onChanged(); })}>Delete</button>
        </>
      }
    >
      {f.analysis && (
        <div className="notice" style={{ fontSize: '0.9rem', marginBottom: 8 }}>
          <strong>What she seems to be thinking</strong> <span className="faint">(Claude's interpretation of the lesson)</span>
          <div style={{ marginTop: 4 }}>{f.analysis}</div>
        </div>
      )}
      <div className="grid cols-2" style={{ fontSize: '0.9rem' }}>
        {TEXT_FIELDS.filter(([k]) => f[k] && k !== 'analysis').map(([k, l]) => (
          <div key={k} style={{ whiteSpace: 'pre-line' }}><strong>{l}:</strong>{'\n'}{f[k]}</div>
        ))}
      </div>
      <p className="faint" style={{ fontSize: '0.82rem', marginTop: 6 }}>
        {f.author && `by ${f.author} · `}
        {f.session_id && <Link to={`/sessions/${f.session_id}`}>session {f.session_date}</Link>}
        {f.exercise_ids.length > 0 && ` · exercises ${f.exercise_ids.join(', ')}`}
      </p>
      {history && (
        <ul style={{ fontSize: '0.8rem', paddingLeft: 18 }}>
          {history.map((h) => (
            <li key={h.id}>
              {h.created_at.slice(0, 16).replace('T', ' ')} · {h.actor} · {h.action}
              {h.action === 'update' && h.before && h.after && ': ' + Object.keys(h.after).filter((k) => JSON.stringify(h.after[k]) !== JSON.stringify(h.before[k]) && k !== 'exercise_ids').map((k) => `${k} “${h.before[k] ?? ''}” → “${h.after[k] ?? ''}”`).join('; ')}
            </li>
          ))}
        </ul>
      )}
      <ErrorBox error={act.error} />
    </Card>
  );
}

function AllHomework() {
  const { data, reload } = useApi('/homework');
  const { data: settings } = useApi('/settings');
  if (!data) return <Loading />;
  return (
    <>
      <p className="faint" style={{ fontSize: '0.82rem', marginTop: 0 }}>
        Homework is complete when {settings?.settings?.tutor_name || 'your tutor'} approves it: send her a Loom video and record her decision, or do it in front of her. Approvals she gives during a recorded lesson are picked up automatically.
      </p>
      <HomeworkList items={data} tutor={settings?.settings?.tutor_name || 'Tutor'} onChange={reload} />
    </>
  );
}

export default function Feedback() {
  const [params] = useSearchParams();
  const { data, error, loading, reload } = useApi('/feedback');
  const [adding, setAdding] = useState(Boolean(params.get('lesson') || params.get('session')));
  const preset = { feedback_date: today(), author: '', session_id: params.get('session') ? Number(params.get('session')) : null, lesson_id: params.get('lesson') || null, confidence: null, exercise_ids: [], ...Object.fromEntries(TEXT_FIELDS.map(([k]) => [k, ''])) };
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Tutor Feedback</h1>
          <p className="muted">Structured notes. “Next session priorities” and open homework feed straight into the <Link to="/gaps">next-lesson briefing</Link>.</p>
        </div>
        {!adding && <button className="btn primary" onClick={() => setAdding(true)}>+ New feedback</button>}
      </div>
      {adding && (
        <Card title="New feedback">
          <FeedbackForm key="new" initial={null} preset={preset} onSaved={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
        </Card>
      )}
      <div className="grid split wide-left section">
        <div>
          {loading && !data && <Loading />}
          <ErrorBox error={error} retry={reload} />
          {data && !data.length && <Empty>No feedback yet.</Empty>}
          {data?.map((f) => <FeedbackItem key={f.id} f={f} onChanged={reload} />)}
        </div>
        <Card title="Homework"><AllHomework /></Card>
      </div>
    </div>
  );
}
