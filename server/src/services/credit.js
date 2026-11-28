// Keeps tabs on the prepaid Claude API credit. The API does not let an ordinary key read the account
// balance, so the app records the cost of every call it makes and subtracts it from the credit you
// told it you bought (Settings → Claude credit). Close to, but not exactly, Anthropic's own figure.
import { getDb, nowIso, getMode } from '../db/connection.js';
import { getSetting } from './common.js';
import { notify } from './hearsayMonitor.js';

const db = () => getDb();
const DEFAULT_WARN_USD = 3;

function setFlag(key, value) {
  db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Record one Claude API call. `price` is [input, output] USD per million tokens. */
export function recordUsage({ purpose, model, usage, price }) {
  if (!usage) return;
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  const output = usage.output_tokens || 0;
  const [pi, po] = price || [4, 20];
  const usd = (input * pi + output * po) / 1e6;
  try {
    db()
      .prepare('INSERT INTO api_usage (created_at, purpose, model, input_tokens, output_tokens, usd) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nowIso(), purpose, model || null, Math.round(input), output, usd);
    checkCredit();
  } catch (err) {
    console.error(`[credit] could not record usage: ${err.message}`);
  }
}

export function creditStatus() {
  const bought = Number(getSetting('api_credit_usd', '')) || null;
  const warnAt = Number(getSetting('api_credit_warn_usd', String(DEFAULT_WARN_USD)));
  const spent = db().prepare('SELECT COALESCE(SUM(usd), 0) s, COUNT(*) n FROM api_usage').get();
  const last30 = db().prepare('SELECT COALESCE(SUM(usd), 0) s FROM api_usage WHERE created_at >= ?').get(new Date(Date.now() - 30 * 864e5).toISOString()).s;
  const remaining = bought == null ? null : Math.max(0, bought - spent.s);
  const ranOut = getSetting('api_credit_ran_out', '') === String(bought);
  return {
    bought_usd: bought,
    spent_usd: Math.round(spent.s * 100) / 100,
    calls: spent.n,
    last_30_days_usd: Math.round(last30 * 100) / 100,
    remaining_usd: remaining == null ? null : Math.round(remaining * 100) / 100,
    warn_at_usd: warnAt,
    low: ranOut || (remaining != null && remaining <= warnAt),
    ran_out: ranOut,
    note: 'Estimated from the calls this app made. Your exact balance is at console.anthropic.com → Settings → Billing.',
  };
}

/** Warn once (per amount of credit) when the estimate drops to the warning level. */
export function checkCredit() {
  if (getMode() === 'demo') return;
  const c = creditStatus();
  if (c.remaining_usd == null || c.remaining_usd > c.warn_at_usd) return;
  if (getSetting('api_credit_warned', '') === String(c.bought_usd)) return;
  setFlag('api_credit_warned', String(c.bought_usd));
  notify(
    'Claude credit is running low',
    `About $${c.remaining_usd.toFixed(2)} of your $${c.bought_usd} credit is left. When it runs out, use /process-lesson in Claude Code (covered by your Pro plan).`
  );
}

/** The API refused a call for lack of credit: tell the learner once, and point to /process-lesson. */
export function creditRanOut(message) {
  const bought = getSetting('api_credit_usd', '');
  if (getSetting('api_credit_ran_out', '') === bought) return;
  setFlag('api_credit_ran_out', bought);
  if (getMode() !== 'demo') notify('Claude credit has run out', message);
}
