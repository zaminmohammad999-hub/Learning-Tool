import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import { Badge, Card, Empty, ErrorBox, Field, Loading, MasteryBadge, ProgressBar, label, today } from '../components/ui.jsx';

const EVIDENCE_TYPES = ['observed_live', 'artifact_url', 'commit_or_pr', 'screen_recording', 'transcript_only', 'other'];

/** Mirror of the server rule, for a live preview only — the server decides. */
function counts(r) {
  if (r.result !== 'pass') return [false, r.result === 'fail' ? 'failed' : 'not observed'];
  if (r.independence !== 'independent') return [false, 'assisted'];
  if (r.evidence_type === 'transcript_only') return [false, 'transcript alone cannot prove independent execution'];
  if (!r.evidence_text?.trim() && !r.evidence_url?.trim()) return [false, 'no evidence recorded'];
  return [true, null];
}

function RubricEditor({ rubric, onChange }) {
  const [edits, setEdits] = useState({});
  const [newText, setNewText] = useState('');
  const act = useAction();
  const patch = (cid, body) => act.run(async () => { await api.patch(`/assessments/criteria/${cid}`, body); onChange(); });
  return (
    <details>
      <summary><strong>Rubric criteria</strong> <span className="faint">({rubric.criteria.filter((c) => c.active && c.mandatory).length} mandatory) — editable without changing the curriculum source</span></summary>
      <div style={{ marginTop: 8 }}>
        {rubric.criteria.map((c) => (
          <div key={c.id} className="row" style={{ padding: '6px 0', borderTop: '1px dashed var(--border)', alignItems: 'flex-start' }}>
            <code className="faint" style={{ minWidth: 120 }}>{c.id}</code>
            <div style={{ flex: 1, minWidth: 200 }}>
              <input type="text" value={edits[c.id] ?? c.text} onChange={(e) => setEdits({ ...edits, [c.id]: e.target.value })} style={{ width: '100%' }} aria-label={`Criterion ${c.id}`} />
              {c.seed_text && c.text !== c.seed_text && <div className="faint" style={{ fontSize: '0.78rem' }}>Seed: {c.seed_text}</div>}
            </div>
            {edits[c.id] !== undefined && edits[c.id] !== c.text && <button className="btn small" onClick={() => patch(c.id, { text: edits[c.id] })}>Save</button>}
            <label className="row" style={{ fontSize: '0.82rem', gap: 4 }}><input type="checkbox" checked={!!c.mandatory} onChange={(e) => patch(c.id, { mandatory: e.target.checked })} />mandatory</label>
            <label className="row" style={{ fontSize: '0.82rem', gap: 4 }}><input type="checkbox" checked={!!c.active} onChange={(e) => patch(c.id, { active: e.target.checked })} />active</label>
          </div>
        ))}
        <div className="row" style={{ marginTop: 6 }}>
          <input type="text" placeholder="Add an additional test criterion" value={newText} onChange={(e) => setNewText(e.target.value)} style={{ flex: 1 }} />
          <button className="btn small" disabled={newText.trim().length < 3 || act.busy} onClick={() => act.run(async () => { await api.post(`/assessments/rubric/${rubric.id}/criteria`, { text: newText, mandatory: true }); setNewText(''); onChange(); })}>
            Add criterion
          </button>
        </div>
        <p className="faint" style={{ fontSize: '0.8rem' }}>Adding a mandatory criterion after a verification marks the competency “reassessment required”.</p>
        <ErrorBox error={act.error} />
      </div>
    </details>
  );
}

function AttemptForm({ rubric, isDomain, onSaved }) {
  const active = rubric.criteria.filter((c) => c.active);
  const blank = () => Object.fromEntries(active.map((c) => [c.id, { result: 'not_observed', independence: 'independent', evidence_type: 'observed_live', evidence_text: '', evidence_url: '' }]));
  const [rows, setRows] = useState(blank);
  const [meta, setMeta] = useState({ assessor: '', attempt_date: today(), kind: isDomain ? 'domain' : 'competency', feedback: '', retry_plan: '', github_links: '' });
  const act = useAction();
  const preview = useMemo(() => {
    const mandatory = active.filter((c) => c.mandatory);
    const passed = mandatory.filter((c) => counts(rows[c.id] || {})[0]).length;
    return { passed, total: mandatory.length, pass: mandatory.length > 0 && passed === mandatory.length };
  }, [rows, active]);
  const set = (cid, k, v) => setRows({ ...rows, [cid]: { ...rows[cid], [k]: v } });

  return (
    <details className="card">
      <summary><strong>Record a practical attempt</strong></summary>
      <div className="grid cols-4" style={{ marginTop: 8 }}>
        <Field label="Assessor"><input type="text" value={meta.assessor} onChange={(e) => setMeta({ ...meta, assessor: e.target.value })} /></Field>
        <Field label="Date"><input type="date" value={meta.attempt_date} onChange={(e) => setMeta({ ...meta, attempt_date: e.target.value })} /></Field>
        {!isDomain && (
          <Field label="Type">
            <select value={meta.kind} onChange={(e) => setMeta({ ...meta, kind: e.target.value })}>
              <option value="competency">Competency test</option>
              <option value="skill_check">Short skill check</option>
            </select>
          </Field>
        )}
        <Field label="GitHub commit / PR links"><input type="text" value={meta.github_links} onChange={(e) => setMeta({ ...meta, github_links: e.target.value })} /></Field>
      </div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th>Criterion</th><th>Result</th><th>Independence</th><th>Evidence type</th><th>Evidence (learner output / note / URL)</th><th>Counts?</th></tr></thead>
          <tbody>
            {active.map((c) => {
              const r = rows[c.id];
              const [ok, why] = counts(r);
              return (
                <tr key={c.id}>
                  <td style={{ minWidth: 200 }}>{c.text} {!c.mandatory && <Badge>optional</Badge>}</td>
                  <td>
                    <select value={r.result} onChange={(e) => set(c.id, 'result', e.target.value)} aria-label="Result">
                      <option value="pass">pass</option><option value="fail">fail</option><option value="not_observed">not observed</option>
                    </select>
                  </td>
                  <td>
                    <select value={r.independence} onChange={(e) => set(c.id, 'independence', e.target.value)} aria-label="Independence">
                      <option value="independent">independent</option><option value="assisted">assisted</option>
                    </select>
                  </td>
                  <td>
                    <select value={r.evidence_type} onChange={(e) => set(c.id, 'evidence_type', e.target.value)} aria-label="Evidence type">
                      {EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
                    </select>
                  </td>
                  <td style={{ minWidth: 220 }}>
                    <input type="text" placeholder="What was observed / output" value={r.evidence_text} onChange={(e) => set(c.id, 'evidence_text', e.target.value)} style={{ width: '100%' }} aria-label="Evidence text" />
                    <input type="url" placeholder="https://… (optional)" value={r.evidence_url} onChange={(e) => set(c.id, 'evidence_url', e.target.value)} style={{ width: '100%', marginTop: 4 }} aria-label="Evidence URL" />
                  </td>
                  <td>{ok ? <Badge status="pass">yes</Badge> : <span className="faint" style={{ fontSize: '0.8rem' }}>no — {why}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <Field label="Tutor feedback"><textarea rows={2} value={meta.feedback} onChange={(e) => setMeta({ ...meta, feedback: e.target.value })} /></Field>
        <Field label="Retry plan"><textarea rows={2} value={meta.retry_plan} onChange={(e) => setMeta({ ...meta, retry_plan: e.target.value })} /></Field>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <Badge status={preview.pass ? 'pass' : 'fail'}>Preview: {preview.pass ? 'PASS' : 'FAIL'} · {preview.passed}/{preview.total} mandatory criteria</Badge>
        <button
          className="btn primary"
          disabled={act.busy || !meta.assessor.trim()}
          onClick={() =>
            act.run(async () => {
              await api.post('/assessments/attempts', {
                rubric_id: rubric.id,
                ...meta,
                results: active.map((c) => ({ criterion_id: c.id, ...rows[c.id], evidence_text: rows[c.id].evidence_text || undefined, evidence_url: rows[c.id].evidence_url || undefined })),
              });
              setRows(blank());
              onSaved();
            })
          }
        >
          Save attempt
        </button>
        {!meta.assessor.trim() && <span className="faint">Assessor is required.</span>}
      </div>
      <p className="faint" style={{ fontSize: '0.8rem' }}>An attempt fails if any mandatory criterion is not passed independently with recorded, non-transcript evidence. Passing does not grant mastery until verified.</p>
      <ErrorBox error={act.error} />
    </details>
  );
}

function VerifyPanel({ competencyId, mastery, onDone }) {
  const [v, setV] = useState({ verifier: '', verifier_role: 'tutor', evidence_summary: '' });
  const [reason, setReason] = useState('');
  const act = useAction();
  if (mastery.state === 'passed')
    return (
      <div className="notice">
        <strong style={{ color: 'var(--mastery)' }}>100% mastered — verified</strong> by {mastery.verification.verifier} ({mastery.verification.verifier_role}) on {mastery.verification.verified_at.slice(0, 10)} from attempt #{mastery.verification.attempt_id}. <em>{mastery.verification.evidence_summary}</em>
        <div className="row" style={{ marginTop: 6 }}>
          <input type="text" placeholder="Reason for reassessment" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
          <button className="btn small" disabled={act.busy} onClick={() => act.run(async () => { await api.post('/assessments/reassess', { competency_id: competencyId, reason: reason || undefined }); onDone(); })}>
            Request reassessment
          </button>
        </div>
        <ErrorBox error={act.error} />
      </div>
    );
  if (!mastery.verifiable_attempt_id) return <p className="faint">Verify Pass becomes available after an attempt passes every mandatory criterion independently with evidence.</p>;
  return (
    <div className="notice">
      <strong>Attempt #{mastery.verifiable_attempt_id} passed all mandatory criteria.</strong> Explicit verification is required before this counts as mastery.
      <div className="grid cols-3" style={{ marginTop: 8 }}>
        <Field label="Verifier name"><input type="text" value={v.verifier} onChange={(e) => setV({ ...v, verifier: e.target.value })} /></Field>
        <Field label="Role"><select value={v.verifier_role} onChange={(e) => setV({ ...v, verifier_role: e.target.value })}><option value="tutor">tutor</option><option value="learner">learner</option></select></Field>
        <Field label="Evidence summary"><input type="text" value={v.evidence_summary} onChange={(e) => setV({ ...v, evidence_summary: e.target.value })} /></Field>
      </div>
      <button className="btn primary" style={{ marginTop: 8 }} disabled={act.busy || !v.verifier.trim() || !v.evidence_summary.trim()} onClick={() => act.run(async () => { await api.post('/assessments/verify', { competency_id: competencyId, attempt_id: mastery.verifiable_attempt_id, ...v }); onDone(); })}>
        Verify Pass
      </button>
      <ErrorBox error={act.error} />
    </div>
  );
}

function AttemptHistory({ attempts }) {
  if (!attempts.length) return <p className="faint">No attempts yet.</p>;
  return attempts.map((a) => (
    <details key={a.id} style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
      <summary>
        Attempt {a.attempt_number} · {a.attempt_date} · <Badge status={a.overall_result} /> {a.criteria_passed}/{a.criteria_mandatory} · {label(a.kind)} · {a.assessor}
        {a.verifications.length > 0 && <Badge tone="mastery">verified{a.verifications.some((v) => v.superseded_at) ? ' (superseded)' : ''}</Badge>}
      </summary>
      <ul style={{ fontSize: '0.85rem', paddingLeft: 18 }}>
        {a.results.map((r) => (
          <li key={r.id}>
            <Badge status={r.counts_toward_pass ? 'pass' : r.result} /> {r.criterion_text} — {r.independence}, {label(r.evidence_type)} {r.evidence_text && `· ${r.evidence_text}`} {r.evidence_url && <a href={r.evidence_url} target="_blank" rel="noreferrer">link</a>} {r.not_counted_reason && <em className="faint">({r.not_counted_reason})</em>}
          </li>
        ))}
      </ul>
      {a.feedback && <p style={{ fontSize: '0.85rem' }}>Feedback: {a.feedback}</p>}
      {a.retry_plan && <p style={{ fontSize: '0.85rem' }}>Retry plan: {a.retry_plan}</p>}
      {a.github_links && <p style={{ fontSize: '0.85rem' }}>Links: {a.github_links}</p>}
    </details>
  ));
}

function Detail({ target, overview, reloadOverview }) {
  const isDomain = target.startsWith('DA-');
  const comp = !isDomain && overview.competencies.find((c) => c.id === target);
  const da = isDomain && overview.domain_assessments.find((d) => d.id === target);
  const rubricId = isDomain ? `RUB-${target}` : `RUB-${target}`;
  const { data: attempts, reload } = useApi(`/assessments/attempts?rubric_id=${rubricId}`);
  if (!comp && !da) return <Empty>Unknown assessment {target}.</Empty>;
  const rubric = comp ? comp.rubric : da.rubric;
  const refresh = () => { reload(); reloadOverview(); };
  return (
    <div className="stack">
      <Card title={comp ? `${comp.id} · ${comp.title}` : `${da.id} · Domain assessment`} actions={comp ? <MasteryBadge state={comp.mastery.state} awaiting={comp.mastery.awaiting_verification} /> : da.latest_result ? <Badge status={da.latest_result} /> : <Badge>not attempted</Badge>}>
        {comp ? (
          <>
            <p className="muted">{comp.domain_name} · Week {comp.week}, Lesson {comp.lesson_number}. <Link to={`/schedule/${comp.lesson_id}`}>Open lesson</Link></p>
            <ProgressBar kind="partial" value={comp.mastery.best_criteria_passed} total={comp.mastery.mandatory_count} caption="Mandatory criteria passed independently (best across attempts) — partial progress, not mastery" />
            {comp.mastery.note && <p className="notice warn" style={{ marginTop: 8 }}>{comp.mastery.note}</p>}
            <div style={{ marginTop: 10 }}><VerifyPanel competencyId={comp.id} mastery={comp.mastery} onDone={refresh} /></div>
          </>
        ) : (
          <>
            <p>{da.description}</p>
            <p className="muted">Scheduled after Lesson {da.after_lesson_id.slice(1)} (week {da.week}). Domain assessment results are tracked separately from competency mastery.</p>
          </>
        )}
        <hr />
        <RubricEditor rubric={rubric} onChange={refresh} />
      </Card>
      <AttemptForm key={rubric.criteria.map((c) => c.id + c.active).join()} rubric={rubric} isDomain={isDomain} onSaved={refresh} />
      <Card title="Attempt history (retakes preserved)">{attempts ? <AttemptHistory attempts={attempts} /> : <Loading />}</Card>
    </div>
  );
}

export default function Assessments() {
  const { competencyId } = useParams();
  const { data, error, loading, reload } = useApi('/assessments');
  if (loading && !data) return <Loading what="Loading assessments" />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const byDomain = {};
  data.competencies.forEach((c) => (byDomain[c.domain_id] = [...(byDomain[c.domain_id] || []), c]));
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Practical Assessments</h1>
          <p className="muted">Each competency rubric uses its four exercises as mandatory, observable criteria. Mastery = all mandatory criteria passed independently with evidence + explicit verification.</p>
        </div>
      </div>
      {data.skill_checks_due.length > 0 && (
        <div className="notice" style={{ marginBottom: 12 }}>
          Short skill checks suggested after held lessons: {data.skill_checks_due.map((s) => <Link key={s.lesson_id} to={`/assessments/${s.competency_id}`} style={{ marginRight: 8 }}>L{s.number} {s.title}</Link>)}
        </div>
      )}
      <div className="grid split">
        <div className="stack">
          {Object.entries(byDomain).map(([dId, comps]) => {
            const da = data.domain_assessments.find((d) => d.domain_id === dId);
            return (
              <div key={dId} className="card" style={{ padding: 12, marginTop: 0 }}>
                <h3>{dId} · {comps[0].domain_name}</h3>
                {comps.map((c) => (
                  <Link key={c.id} to={`/assessments/${c.id}`} className="row between" style={{ padding: '4px 0', textDecoration: 'none', color: 'inherit', fontWeight: c.id === competencyId ? 700 : 400 }}>
                    <span>{c.title}</span>
                    <MasteryBadge state={c.mastery.state} awaiting={c.mastery.awaiting_verification} />
                  </Link>
                ))}
                <Link to={`/assessments/${da.id}`} className="row between" style={{ padding: '6px 0 0', borderTop: '1px dashed var(--border)', marginTop: 4, textDecoration: 'none', color: 'inherit', fontWeight: da.id === competencyId ? 700 : 400 }}>
                  <span>Domain assessment (after L{da.after_lesson_id.slice(1)}, wk {da.week})</span>
                  {da.latest_result ? <Badge status={da.latest_result}>{da.latest_result} {da.latest_score}</Badge> : <Badge>not attempted</Badge>}
                </Link>
              </div>
            );
          })}
        </div>
        <div>{competencyId ? <Detail key={competencyId} target={competencyId} overview={data} reloadOverview={reload} /> : <Empty>Select a competency or domain assessment.</Empty>}</div>
      </div>
    </div>
  );
}
