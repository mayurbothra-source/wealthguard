/**
 * Prediction ledger — every house prediction (BUY / SELL / WATCH / HOLD), when
 * it was made, and how it turned out at each checkpoint, in a shape a Google
 * Sheet can show directly (scripts/google-sheets/PredictionLedger.gs).
 *
 * One row per instrument per IST day (two scoring runs on one day are the same
 * call; the first one counts). Checkpoints: Weekly (+7 days), Monthly (+30),
 * Quarterly (+90), Annual (+365), each priced at the close on its own date by
 * trackRecordEngine — this module only reads and presents those results.
 *
 * Right or wrong, per checkpoint:
 *   BUY   right if the price rose (> 0%)
 *   SELL  right if the price fell (< 0%)
 *   HOLD  right if the price stayed within ±2%
 *   WATCH right if the price stayed within ±3% ("nothing worth acting on
 *         happened"); wrong if it moved more, either way (a move we missed)
 *   0.00% move, a price feed that stopped updating, or no market price
 *         → no verdict (shown as such, never counted as right)
 *
 * Row colour = the overall verdict, strictest wins: any checkpoint wrong → red;
 * at least one right and none wrong → green; otherwise uncoloured. A later
 * checkpoint can turn a green row red — the record is never flattered.
 */
'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const cal = require('../lib/tradingCalendar');

const CHECKS = [
  { label: 'Weekly',    days: 7,   tol: 1, field: 'return_1w_pct' },
  { label: 'Monthly',   days: 30,  tol: 2, field: 'return_1m_pct' },
  { label: 'Quarterly', days: 90,  tol: 3, field: 'return_3m_pct' },
  { label: 'Annual',    days: 365, tol: 5, field: 'return_1y_pct' },
];
const MIN_FOR_PERCENT = 10;     // fewer verdicts than this → "building (N)", never a percentage
const WATCH_BAND = 3, HOLD_BAND = 2;

const fmtPct = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}%`;
const fmtDay = ymd => { const [y, m, d] = ymd.split('-'); return `${+d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${y}`; };

/** Verdict for one checkpoint: { verdict: true|false|null, text, state } */
function checkpointResult(rec, check, o, todayIst) {
  const win = cal.checkpointWindow(rec.generated_at, check.days, check.tol);
  if (!o) {
    return todayIst > win.end
      ? { verdict: null, state: 'awaiting', text: 'awaiting scoring' }
      : { verdict: null, state: 'pending', text: `due ${fmtDay(win.end)}` };
  }
  const status = o.outcome_status || (o.actual_price_inr == null ? 'not_measurable' : 'measured');
  if (status === 'not_measurable' || status === 'price_suspect') {
    return { verdict: null, state: 'not_measurable', text: status === 'price_suspect' ? 'no verdict — price feed not updating' : 'no verdict — not measurable' };
  }
  const ret = Number(o[check.field]);
  if (!isFinite(ret)) return { verdict: null, state: 'not_measurable', text: 'no verdict — no return recorded' };
  const price = Number(o.price_at_checkpoint ?? o.actual_price_inr);
  const on = o.price_as_of || o.checkpoint_date;
  const proof = price > 0 ? ` (₹${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}${on ? ` on ${fmtDay(String(on).slice(0, 10))}` : ''})` : '';

  const a = String(rec.action).toUpperCase();
  let verdict;
  if (a === 'WATCH') verdict = Math.abs(ret) <= WATCH_BAND;
  else if (Math.abs(ret) < 0.005) verdict = a === 'HOLD' ? true : null;     // 0.00%: inconclusive for BUY/SELL
  else if (a === 'BUY') verdict = ret > 0;
  else if (a === 'SELL' || a === 'REDUCE') verdict = ret < 0;
  else if (a === 'HOLD') verdict = Math.abs(ret) <= HOLD_BAND;
  else verdict = null;
  const mark = verdict === true ? '✓' : verdict === false ? '✗' : '•';
  return { verdict, state: verdict == null ? 'inconclusive' : 'scored', text: `${mark} ${fmtPct(ret)}${verdict == null ? ' inconclusive' : ''}${proof}` };
}

/** Pure: build ledger rows and the accuracy summary from loaded data. */
function buildLedger(recs, outcomesByRec, now = new Date()) {
  const todayIst = cal.istDateOf(now);
  // One call per instrument per IST day: keep the first.
  const seen = new Set();
  const list = [...recs]
    .sort((a, b) => (a.generated_at < b.generated_at ? -1 : 1))
    .filter(r => { const k = `${r.instrument_name}|${cal.istDateOf(r.generated_at)}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const rows = list.map(r => {
    const outs = outcomesByRec[r.id] || [];
    const results = CHECKS.map(c => checkpointResult(r, c, outs.find(o => o.checkpoint_label === c.label), todayIst));
    const v = results.map(x => x.verdict).filter(x => x === true || x === false);
    const overall = v.includes(false) ? 'Wrong' : v.length ? 'Right' : results.some(x => x.state === 'pending' || x.state === 'awaiting') ? 'Pending' : 'No verdict';
    return {
      id: r.id,
      date: cal.istDateOf(r.generated_at),
      instrument: r.instrument_name,
      prediction: String(r.action).toUpperCase(),
      entry: r.entry_price_inr != null ? Number(r.entry_price_inr) : null,
      weekly: results[0].text, monthly: results[1].text, quarterly: results[2].text, annual: results[3].text,
      verdicts: results.map(x => x.verdict),
      overall,
      color: overall === 'Right' ? 'green' : overall === 'Wrong' ? 'red' : null,
    };
  });
  return { rows: rows.reverse(), summary: summarise(rows), generated_at: now.toISOString() };
}

function summarise(rows) {
  const table = [];
  for (const [ci, c] of CHECKS.entries()) {
    for (const action of ['BUY', 'SELL', 'WATCH', 'HOLD', 'ALL']) {
      const subset = rows.filter(r => action === 'ALL' || r.prediction === action);
      const right = subset.filter(r => r.verdicts[ci] === true).length;
      const wrong = subset.filter(r => r.verdicts[ci] === false).length;
      const n = right + wrong;
      table.push({ checkpoint: c.label, prediction: action, right, wrong, scored: n,
        accuracy: n >= MIN_FOR_PERCENT ? Math.round((right / n) * 1000) / 10 : null,
        accuracy_text: n === 0 ? '—' : n >= MIN_FOR_PERCENT ? `${(Math.round((right / n) * 1000) / 10).toFixed(1)}%` : `building (${n} scored)` });
    }
  }
  const overall = { right: rows.filter(r => r.overall === 'Right').length, wrong: rows.filter(r => r.overall === 'Wrong').length,
                    pending: rows.filter(r => r.overall === 'Pending').length, no_verdict: rows.filter(r => r.overall === 'No verdict').length,
                    predictions: rows.length };
  const n = overall.right + overall.wrong;
  overall.accuracy_text = n >= MIN_FOR_PERCENT ? `${((overall.right / n) * 100).toFixed(1)}%` : `building (${n} scored)`;
  return { table, overall, min_for_percent: MIN_FOR_PERCENT };
}

async function selectAll(build, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < page) return out;
  }
}

/** Loads every house prediction and its outcomes, then builds the ledger. */
async function getLedger({ since = '2026-08-28', now = new Date() } = {}) {
  if (!supabaseAdmin) return buildLedger([], {}, now);
  const recs = await selectAll(() => supabaseAdmin.from('recommendations')
    .select('id, instrument_name, action, entry_price_inr, generated_at')
    .is('client_id', null).gte('generated_at', `${since}T00:00:00+05:30`).order('generated_at', { ascending: true }));
  const outs = await selectAll(() => supabaseAdmin.from('recommendation_outcomes')
    .select('*').is('client_id', null).order('measured_at', { ascending: true }));
  const byRec = {};
  for (const o of outs) (byRec[o.recommendation_id] = byRec[o.recommendation_id] || []).push(o);
  const ledger = buildLedger(recs, byRec, now);
  // Engine health, so the sheet shows whether scoring is actually running.
  try {
    const { data } = await supabaseAdmin.from('system_health_log').select('run_at, status, items_processed, detail')
      .eq('engine_name', 'trackRecordEngine').order('run_at', { ascending: false }).limit(1);
    ledger.engine = data?.[0] || null;
  } catch { ledger.engine = null; }
  return ledger;
}

module.exports = { getLedger, buildLedger, checkpointResult, CHECKS, MIN_FOR_PERCENT };
