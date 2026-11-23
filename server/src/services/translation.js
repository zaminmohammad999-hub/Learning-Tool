// Translation of non-English (mostly Urdu) transcripts into English with Claude.
// The original file text in transcripts.original_text is never modified. Each segment keeps its
// source-language text in source_text, and its working text (used for matching, search and citations)
// becomes the English translation.
import { getDb, nowIso, tx } from '../db/connection.js';
import { HttpError, audit, getSetting } from './common.js';
import { getTranscript, getSegments } from './transcripts.js';
import { aiStatus, translateChunkWithClaude, describeAiError, PRICES } from './aiClient.js';

const db = () => getDb();
const CHUNK_CHARS = 6000;
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;

export const DEFAULT_TRANSLATION_MODEL = 'claude-sonnet-5-5';
export function translationModel() {
  return getSetting('translation_model') || DEFAULT_TRANSLATION_MODEL;
}

function sourceOf(seg) {
  return seg.source_text ?? seg.text;
}

export function chunkForTranslation(segments, maxChars = CHUNK_CHARS) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const s of segments) {
    const len = sourceOf(s).length + 12;
    if (size + len > maxChars && cur.length) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Urdu script tokenises less efficiently than English: estimate ≈2 characters per token for it. */
export function translationEstimate(transcriptId) {
  const segs = getSegments(transcriptId);
  const text = segs.map(sourceOf).join('\n');
  const arabic = (text.match(ARABIC) || []).length;
  const inputTokens = Math.ceil(arabic / 2 + (text.length - arabic) / 4) + chunkForTranslation(segs).length * 450;
  const outputTokens = Math.ceil(text.length / 3);
  const model = translationModel();
  const price = PRICES[model];
  return {
    model,
    approx_input_tokens: inputTokens,
    approx_output_tokens: outputTokens,
    approx_usd: price ? Math.round(((inputTokens * price[0] + outputTokens * price[1]) / 1e6) * 1000) / 1000 : null,
    note: 'Rough estimate; Urdu script uses more tokens per character than English. Actual billing may differ.',
  };
}

/**
 * Translate every segment of a transcript. Re-running re-translates from the stored source text,
 * so translating twice never compounds errors. Lines the model omits keep their original text.
 */
export async function translateTranscript(transcriptId, actor = 'user') {
  const t = getTranscript(transcriptId, { includeSegments: false });
  if (!aiStatus().available) throw new HttpError(503, `Translation needs Claude: ${aiStatus().reason}`);
  const segs = getSegments(transcriptId);
  const model = translationModel();
  db().prepare("UPDATE transcripts SET translation_status = 'running' WHERE id = ?").run(transcriptId);
  const translated = new Map();
  const usage = { input_tokens: 0, output_tokens: 0 };
  let usedModel = model;
  try {
    for (const chunk of chunkForTranslation(segs)) {
      const { map, usage: u, model: m } = await translateChunkWithClaude({
        lines: chunk.map((s) => ({ n: s.seq, speaker: s.speaker, text: sourceOf(s) })),
        model,
      });
      usedModel = m || usedModel;
      if (u) {
        usage.input_tokens += u.input_tokens || 0;
        usage.output_tokens += u.output_tokens || 0;
      }
      map.forEach((v, k) => translated.set(k, v));
    }
  } catch (err) {
    const message = err instanceof HttpError ? err.message : describeAiError(err);
    db().prepare("UPDATE transcripts SET translation_status = 'failed' WHERE id = ?").run(transcriptId);
    audit('transcript', transcriptId, 'translation_failed', undefined, { error: message }, actor);
    throw err instanceof HttpError ? err : new HttpError(502, message);
  }
  const missing = segs.filter((s) => !translated.has(s.seq)).map((s) => s.seq);
  tx((d) => {
    const upd = d.prepare('UPDATE transcript_segments SET source_text = ?, text = ? WHERE id = ?');
    for (const s of segs) upd.run(sourceOf(s), translated.get(s.seq) ?? sourceOf(s), s.id);
    d.prepare("UPDATE transcripts SET translation_status = ?, translation_model = ?, translated_at = ? WHERE id = ?").run(
      missing.length ? 'partial' : 'done',
      usedModel,
      nowIso(),
      transcriptId
    );
  });
  const summary = { segments: segs.length, translated: translated.size, missing_segments: missing, model: usedModel, usage, language: t.language };
  audit('transcript', transcriptId, 'translated', undefined, summary, actor);
  return summary;
}
