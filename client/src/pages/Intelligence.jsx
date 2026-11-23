import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction } from '../hooks.js';
import { useAppContext, AiIndicator } from '../App.jsx';
import AnalysisReview from '../components/AnalysisReview.jsx';
import { Card, CitationList, Empty, ErrorBox, Field, Loading, RichText, today } from '../components/ui.jsx';

const QUICK = ['What did we cover?', 'What did we miss?', 'What should my tutor cover next?', 'Have we demonstrated git fetch?', 'What mistakes keep recurring?'];
const MAX_BYTES = 2_000_000;

function Chat() {
  const { health } = useAppContext();
  const { data: messages, reload } = useApi('/assistant/messages');
  const [q, setQ] = useState('');
  const [hl, setHl] = useState({});
  const act = useAction();
  const end = useRef(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [messages]);
  const ask = (question) =>
    act.run(async () => {
      setQ('');
      await api.post('/assistant/chat', { question });
      await reload();
    });
  return (
    <Card
      title="Ask about your sessions"
      actions={
        <>
          <AiIndicator ai={health?.ai} />
          {messages?.length > 0 && <button className="btn small" onClick={() => act.run(async () => { await api.del('/assistant/messages'); reload(); })}>Clear</button>}
        </>
      }
    >
      {!health?.ai?.available && (
        <div className="notice" style={{ marginBottom: 10 }}>
          {health?.ai?.reason || 'AI is not configured.'} Answers below come from a <strong>rule-based search of your saved records</strong> (not AI), always with citations. <Link to="/settings">AI setup</Link>
        </div>
      )}
      <div className="chat" aria-live="polite">
        {!messages?.length && <Empty>Ask a question, or try one of the quick questions below. Answers cite the session, timestamp and text they rely on.</Empty>}
        {messages?.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === 'assistant' && (
              <div className="faint" style={{ fontSize: '0.75rem', marginBottom: 4 }}>
                {m.mode === 'claude' ? 'Claude answer (grounded in cited records)' : 'Rule-based answer from saved records (no AI)'}
              </div>
            )}
            <RichText text={m.content} onCite={(n) => setHl({ ...hl, [m.id]: n })} />
            {m.role === 'assistant' && (m.citations.length ? (
              <details open={!!hl[m.id]}>
                <summary style={{ fontSize: '0.82rem' }}>{m.citations.length} citation(s)</summary>
                <CitationList citations={m.citations} highlight={hl[m.id]} />
              </details>
            ) : (
              <p className="faint" style={{ fontSize: '0.8rem' }}>No supporting records were found.</p>
            ))}
          </div>
        ))}
        {act.busy && <Loading what="Searching your records" />}
        <div ref={end} />
      </div>
      <ErrorBox error={act.error} />
      <form
        className="row"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) ask(q.trim());
        }}
      >
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Have we demonstrated git fetch?" style={{ flex: 1, minWidth: 200 }} aria-label="Question" maxLength={4000} />
        <button className="btn primary" disabled={act.busy || !q.trim()}>Ask</button>
      </form>
      <div className="row" style={{ marginTop: 8 }}>
        {QUICK.map((x) => <button key={x} className="btn small" disabled={act.busy} onClick={() => ask(x)}>{x}</button>)}
      </div>
    </Card>
  );
}

export function TranscriptImport({ onSaved, presetLesson }) {
  const { health } = useAppContext();
  const { data: schedule } = useApi('/schedule');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [session, setSession] = useState({ session_date: today(), tutor: '', duration_minutes: 60, title: '', lesson_ids: presetLesson ? [presetLesson] : [] });
  const [suggestions, setSuggestions] = useState(null);
  const [saved, setSaved] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const act = useAction();
  const lessons = schedule ? schedule.flatMap((w) => w.lessons) : [];
  const bytes = new Blob([text]).size;

  const onFile = async (file) => {
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!['.txt', '.md', '.vtt', '.srt'].includes(ext)) return act.setError(new Error(`Unsupported file type ${ext}. Use .txt, .md, .vtt or .srt`));
    if (file.size > MAX_BYTES) return act.setError(new Error(`File is ${file.size} bytes; the limit is ${MAX_BYTES}. Split it into parts.`));
    act.setError(null);
    setFilename(file.name);
    setText(await file.text());
  };
  const toggleLesson = (id) =>
    setSession((s) => ({ ...s, lesson_ids: s.lesson_ids.includes(id) ? s.lesson_ids.filter((x) => x !== id) : [...s.lesson_ids, id] }));

  const save = () =>
    act.run(async () => {
      const t = await api.post('/transcripts', {
        text,
        filename: filename || null,
        session: { ...session, duration_minutes: session.duration_minutes ? Number(session.duration_minutes) : null, tutor: session.tutor || null, title: session.title || null },
      });
      setSaved(t);
      setEstimate(await api.get(`/transcripts/${t.id}/cost-estimate`));
      onSaved?.();
    });
  const analyse = (method) =>
    act.run(async () => {
      setAnalysis(await api.post(`/transcripts/${saved.id}/analyse`, { method }));
      onSaved?.();
    });
  const reset = () => {
    setText('');
    setFilename('');
    setSaved(null);
    setAnalysis(null);
    setSuggestions(null);
  };

  if (saved) {
    return (
      <Card title={`Transcript #${saved.id} saved`} actions={<button className="btn small" onClick={reset}>Add another</button>}>
        <p className="muted">
          {saved.segment_count} lines parsed · format {saved.format} · checksum <code>{saved.checksum.slice(0, 12)}…</code>. The original text is stored unchanged. <Link to={`/sessions/${saved.session_id}`}>Open session</Link>
        </p>
        {!analysis && (
          <div className="stack">
            <div className="row">
              <button className="btn primary" disabled={act.busy} onClick={() => analyse('rule_based')}>Propose matches (rule-based, offline)</button>
              <button className="btn" disabled={act.busy || !health?.ai?.available} onClick={() => analyse('claude')} title={health?.ai?.reason || ''}>
                Analyse with Claude
              </button>
              {act.busy && <Loading what="Analysing" />}
            </div>
            {health?.ai?.available && estimate && (
              <p className="faint" style={{ fontSize: '0.82rem' }}>
                Claude estimate: {estimate.chunks} chunk(s), ~{estimate.approx_input_tokens.toLocaleString()} input tokens{estimate.approx_usd != null && `, roughly $${estimate.approx_usd}`} ({estimate.model}). {estimate.note}
              </p>
            )}
            {!health?.ai?.available && <p className="faint" style={{ fontSize: '0.82rem' }}>Claude analysis is unavailable: {health?.ai?.reason} You can still use the rule-based matcher or map exercises manually in the Curriculum Explorer.</p>}
          </div>
        )}
        <ErrorBox error={act.error} />
        {analysis && <AnalysisReview analysis={analysis} onDecided={async () => setAnalysis(await api.get(`/analyses/${analysis.id}`))} />}
      </Card>
    );
  }

  return (
    <Card title="Add a transcript">
      <p className="muted" style={{ fontSize: '0.88rem' }}>
        Paste a transcript or upload .txt / .md / .vtt / .srt (max 2 MB). It is treated as untrusted text: nothing inside it is executed, and nothing changes your progress until you approve proposed matches.
      </p>
      <div className="grid cols-4">
        <Field label="Meeting date"><input type="date" value={session.session_date} onChange={(e) => setSession({ ...session, session_date: e.target.value })} /></Field>
        <Field label="Tutor"><input type="text" value={session.tutor} onChange={(e) => setSession({ ...session, tutor: e.target.value })} /></Field>
        <Field label="Duration (min)"><input type="number" min={1} max={600} value={session.duration_minutes} onChange={(e) => setSession({ ...session, duration_minutes: e.target.value })} /></Field>
        <Field label="Title (optional)"><input type="text" value={session.title} onChange={(e) => setSession({ ...session, title: e.target.value })} /></Field>
      </div>
      <div style={{ marginTop: 10 }}>
        <Field label={`Transcript text${filename ? ` — ${filename}` : ''} (${bytes.toLocaleString()} bytes)`}>
          <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'[00:03:05] Tutor: In the terminal, run git clone …\n[00:03:40] Learner: Cloning into …'} />
        </Field>
        <div className="row" style={{ marginTop: 6 }}>
          <input type="file" accept=".txt,.md,.vtt,.srt,text/plain,text/markdown,text/vtt" onChange={(e) => onFile(e.target.files?.[0])} aria-label="Upload transcript file" />
          <button className="btn small" disabled={!text.trim() || act.busy} onClick={() => act.run(async () => setSuggestions((await api.post('/transcripts/suggest-lessons', { text, filename: filename || null })).suggestions))}>
            Suggest matching lessons
          </button>
        </div>
      </div>
      {suggestions && (
        <div className="notice" style={{ marginTop: 8 }}>
          {suggestions.length ? (
            <>
              Likely lessons:{' '}
              {suggestions.map((s) => (
                <button key={s.lesson_id} className="btn small" style={{ marginRight: 6 }} onClick={() => !session.lesson_ids.includes(s.lesson_id) && toggleLesson(s.lesson_id)}>
                  + L{s.lesson_number} {s.title} <span className="faint">({s.matched_exercises.length} exercises)</span>
                </button>
              ))}
            </>
          ) : (
            'No lesson could be suggested from the text.'
          )}
        </div>
      )}
      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 10 }}>
        <legend style={{ fontSize: '0.85rem', color: 'var(--text-2)' }}>Lesson(s) this session covered ({session.lesson_ids.length} selected)</legend>
        <div className="row" style={{ gap: 4 }}>
          {lessons.map((l) => (
            <label key={l.id} className="badge" style={{ cursor: 'pointer', borderColor: session.lesson_ids.includes(l.id) ? 'var(--accent)' : undefined }}>
              <input type="checkbox" checked={session.lesson_ids.includes(l.id)} onChange={() => toggleLesson(l.id)} style={{ margin: 0 }} />
              L{l.number} {l.title}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={act.busy || !text.trim() || !session.session_date || bytes > MAX_BYTES} onClick={save}>Save transcript</button>
        {bytes > MAX_BYTES && <span className="error">Too large — split the transcript.</span>}
      </div>
      <ErrorBox error={act.error} />
      {act.error?.details?.session_id && <Link to={`/sessions/${act.error.details.session_id}`}>Open the existing session</Link>}
    </Card>
  );
}

function ReviewQueue() {
  const { data, error, loading, reload } = useApi('/review/pending');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data.length) return <Empty>No proposed matches are waiting for review.</Empty>;
  return data.map((a) => (
    <Card key={a.id}>
      <AnalysisReview analysis={a} onDecided={reload} />
    </Card>
  ));
}

export default function Intelligence() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('lesson') ? 'import' : 'chat');
  const [n, setN] = useState(0);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Tutor Intelligence</h1>
          <p className="muted">Paste transcripts, review proposed curriculum matches, and ask questions across all saved sessions.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[
          ['chat', 'Ask'],
          ['import', 'Add transcript'],
          ['review', 'Review queue'],
        ].map(([k, t]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'chat' && <Chat />}
      {tab === 'import' && <TranscriptImport key={n} presetLesson={params.get('lesson')} onSaved={() => setN((x) => x)} />}
      {tab === 'review' && <ReviewQueue />}
    </div>
  );
}
