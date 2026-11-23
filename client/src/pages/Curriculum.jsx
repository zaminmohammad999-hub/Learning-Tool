import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import ExerciseRow from '../components/ExerciseRow.jsx';
import { ErrorBox, Loading, MasteryBadge, ProgressBar, Empty, today } from '../components/ui.jsx';

export default function Curriculum() {
  const { data, error, loading, reload } = useApi('/curriculum');
  const [q, setQ] = useState('');
  const [week, setWeek] = useState('');
  const [coverage, setCoverage] = useState('');
  const [mastery, setMastery] = useState('');
  const [due, setDue] = useState('');
  const [openAll, setOpenAll] = useState(false);
  const [newEx, setNewEx] = useState({});
  const act = useAction();

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const t = today();
    return data.domains
      .map((d) => ({
        ...d,
        competencies: d.competencies
          .filter((c) => (!week || String(c.week) === week) && (!mastery || c.mastery.state === mastery))
          .map((c) => ({
            ...c,
            exercises: c.exercises.filter(
              (e) =>
                (!needle || `${e.id} ${e.description} ${c.title} ${d.name} ${e.notes || ''}`.toLowerCase().includes(needle)) &&
                (!coverage || (coverage === 'covered' ? e.covered : !e.covered)) &&
                (!due || (due === 'overdue' ? e.due_date && e.due_date < t && !e.covered : due === 'has_due' ? e.due_date : true))
            ),
          }))
          .filter((c) => c.exercises.length),
      }))
      .filter((d) => d.competencies.length);
  }, [data, q, week, coverage, mastery, due]);

  if (loading && !data) return <Loading what="Loading curriculum" />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const filtering = q || week || coverage || mastery || due;

  const move = (c, idx, dir) =>
    act.run(async () => {
      const ids = c.exercises.map((e) => e.id);
      const [x] = ids.splice(idx, 1);
      ids.splice(idx + dir, 0, x);
      await api.post(`/competencies/${c.id}/reorder`, { ordered_ids: ids });
      reload();
    });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Curriculum Explorer</h1>
          <p className="muted">Learning Domain › Core Competency › Practical Exercise — canonical content from <code>data/vibe_coding_curriculum.json</code>.</p>
        </div>
        <button className="btn" onClick={() => setOpenAll((v) => !v)}>{openAll ? 'Collapse all' : 'Expand all'}</button>
      </div>
      <div className="card row" style={{ marginBottom: 14 }}>
        <input type="search" placeholder="Search exercises, e.g. git fetch" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" style={{ flex: 1, minWidth: 200 }} />
        <select value={week} onChange={(e) => setWeek(e.target.value)} aria-label="Week">
          <option value="">All weeks</option>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>Week {i + 1}</option>)}
        </select>
        <select value={coverage} onChange={(e) => setCoverage(e.target.value)} aria-label="Coverage">
          <option value="">Any coverage</option>
          <option value="covered">Covered</option>
          <option value="uncovered">Not evidenced</option>
        </select>
        <select value={mastery} onChange={(e) => setMastery(e.target.value)} aria-label="Mastery">
          <option value="">Any mastery</option>
          {['not_assessed', 'in_progress', 'needs_practice', 'passed', 'reassessment_required'].map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date">
          <option value="">Any due date</option>
          <option value="has_due">Has due date</option>
          <option value="overdue">Overdue</option>
        </select>
      </div>
      <ErrorBox error={act.error} />
      {!filtered.length && <Empty>No exercises match these filters.</Empty>}
      {filtered.map((d) => (
        <details key={d.id} className="tree-domain" open={openAll || !!filtering || undefined}>
          <summary>
            <strong>{d.id} · {d.name}</strong>
            <span className="muted" style={{ marginLeft: 8, fontSize: '0.88rem' }}>
              covered {d.coverage.covered}/16 · verified {d.mastered}/4 competencies
            </span>
          </summary>
          <div className="tree-body">
            <p className="muted" style={{ fontSize: '0.9rem' }}>{d.objective}</p>
            <p style={{ fontSize: '0.88rem' }}><strong>Domain assessment:</strong> {d.assessment}</p>
            {d.competencies.map((c) => (
              <details key={c.id} className="tree-comp" open={openAll || !!filtering || undefined}>
                <summary>
                  <strong>{c.id} · {c.title}</strong>{' '}
                  <span className="faint" style={{ fontSize: '0.85rem' }}>
                    <Link to={`/schedule/${c.lesson_id}`}>Week {c.week} · Lesson {c.lesson_number}</Link>
                  </span>{' '}
                  <MasteryBadge state={c.mastery.state} awaiting={c.mastery.awaiting_verification} />
                </summary>
                <div style={{ padding: '6px 0 0 16px' }}>
                  <div className="grid cols-2" style={{ marginBottom: 6 }}>
                    <ProgressBar kind="coverage" value={c.coverage.covered} total={4} caption="Coverage (exercises evidenced)" />
                    <ProgressBar kind="partial" value={c.mastery.best_criteria_passed} total={c.mastery.mandatory_count} caption="Rubric criteria passed independently (not mastery until verified)" />
                  </div>
                  {c.exercises.map((e, i) => (
                    <ExerciseRow
                      key={e.id}
                      ex={e}
                      onChange={reload}
                      onMove={filtering ? undefined : (dir) => move(c, i, dir)}
                      canMoveUp={i > 0}
                      canMoveDown={i < c.exercises.length - 1}
                    />
                  ))}
                  {!filtering && (
                    <div className="row" style={{ marginTop: 6 }}>
                      <input
                        type="text"
                        placeholder="Append a custom exercise (canonical ones stay unchanged)"
                        value={newEx[c.id] || ''}
                        onChange={(e) => setNewEx({ ...newEx, [c.id]: e.target.value })}
                        style={{ flex: 1, minWidth: 200 }}
                        aria-label={`New custom exercise for ${c.id}`}
                      />
                      <button
                        className="btn small"
                        disabled={act.busy || (newEx[c.id] || '').trim().length < 3}
                        onClick={() =>
                          act.run(async () => {
                            await api.post('/exercises', { competency_id: c.id, description: newEx[c.id] });
                            setNewEx({ ...newEx, [c.id]: '' });
                            reload();
                          })
                        }
                      >
                        Add custom exercise
                      </button>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
