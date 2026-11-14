/**
 * Client-facing track record for the morning brief: the last 90 days of
 * directional house signals (BUY / SELL with a target and stop), and what
 * happened to each — misses shown alongside wins.
 *
 *   hit target — a checkpoint price reached the target first
 *   hit stop   — a checkpoint price reached the stop-loss first   (a miss)
 *   closed at horizon — the horizon passed without either
 *   open       — still inside its horizon, neither level reached
 *
 * Average result is over closed signals, signed so a good SELL counts as a gain.
 * With fewer than 10 closed signals no percentage is shown.
 */
'use strict';

const { supabaseAdmin } = require('../../config/supabase');

const WINDOW_DAYS = 90;
const MIN_CLOSED_FOR_RATE = 10;

function classify(rec, outcomes, now = new Date()) {
  const buy = rec.action === 'BUY';
  const target = Number(rec.target_price_inr), stop = Number(rec.stop_loss_inr);
  const sorted = [...outcomes].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
  for (const o of sorted) {
    const p = Number(o.actual_price_inr);
    if (!(p > 0)) continue;
    if (buy ? p >= target : p <= target) return { state: 'target', result: resultPct(rec, p) };
    if (buy ? p <= stop : p >= stop) return { state: 'stop', result: resultPct(rec, p) };
  }
  const expires = new Date(rec.generated_at).getTime() + (rec.horizon_days || 14) * 86400000;
  if (now.getTime() > expires) {
    const last = sorted.filter(o => Number(o.actual_price_inr) > 0).pop();
    return { state: 'expired', result: last ? resultPct(rec, Number(last.actual_price_inr)) : null };
  }
  return { state: 'open', result: null };
}

function resultPct(rec, price) {
  const entry = Number(rec.entry_price_inr);
  if (!(entry > 0)) return null;
  const move = ((price - entry) / entry) * 100;
  return rec.action === 'SELL' ? -move : move;
}

/** Pure: summarise already-loaded signals and outcomes. */
function summarise(recs, outcomesByRec, now = new Date()) {
  const s = { issued: recs.length, hit_target: 0, hit_stop: 0, expired: 0, open: 0 };
  const results = [];
  for (const r of recs) {
    const c = classify(r, outcomesByRec[r.id] || [], now);
    if (c.state === 'target') s.hit_target++;
    else if (c.state === 'stop') s.hit_stop++;
    else if (c.state === 'expired') s.expired++;
    else s.open++;
    if (c.state !== 'open' && c.result != null) results.push(c.result);
  }
  s.closed = s.hit_target + s.hit_stop + s.expired;
  s.avg_result_pct = results.length ? Math.round((results.reduce((a, b) => a + b, 0) / results.length) * 100) / 100 : null;
  s.building = s.closed < MIN_CLOSED_FOR_RATE;
  s.window_days = WINDOW_DAYS;
  s.text = toText(s);
  return s;
}

function toText(s) {
  if (!s.issued) return 'Track record building — no buy or sell calls in the last 90 days.';
  const parts = `${s.issued} buy/sell call${s.issued === 1 ? '' : 's'} in the last 90 days: ${s.hit_target} hit target, ${s.hit_stop} hit stop-loss, ${s.expired} closed at the end of their horizon, ${s.open} still open.`;
  if (s.building) return `Track record building (${s.closed} closed so far). ${parts}`;
  const avg = s.avg_result_pct == null ? '' : ` Average result on closed calls: ${s.avg_result_pct >= 0 ? '+' : ''}${s.avg_result_pct.toFixed(2)}%.`;
  return `${parts}${avg} Misses are counted alongside wins.`;
}

async function getTrackRecordSummary(now = new Date()) {
  if (!supabaseAdmin) return summarise([], {}, now);
  const since = new Date(now.getTime() - WINDOW_DAYS * 86400000).toISOString();
  const { data: recs } = await supabaseAdmin.from('recommendations')
    .select('id, instrument_name, action, entry_price_inr, target_price_inr, stop_loss_inr, horizon_days, generated_at')
    .is('client_id', null).in('action', ['BUY', 'SELL']).gte('generated_at', since).limit(2000);
  const directional = (recs || []).filter(r => r.target_price_inr != null && r.stop_loss_inr != null && Number(r.entry_price_inr) > 0);
  const byRec = {};
  if (directional.length) {
    const { data: outs } = await supabaseAdmin.from('recommendation_outcomes')
      .select('recommendation_id, actual_price_inr, measured_at').in('recommendation_id', directional.map(r => r.id)).limit(10000);
    for (const o of outs || []) (byRec[o.recommendation_id] = byRec[o.recommendation_id] || []).push(o);
  }
  return summarise(directional, byRec, now);
}

module.exports = { getTrackRecordSummary, summarise, classify, MIN_CLOSED_FOR_RATE };
