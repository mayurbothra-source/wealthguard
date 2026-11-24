/**
 * Client-facing track record for the morning brief (SA6).
 *
 * Source: house BUY / SELL / REDUCE signals issued in the last 90 days, and
 * their recommendation_outcomes at the horizon checkpoint — '14-Day' (the
 * horizon signals claim), falling back to 'Weekly' while 14-Day data is
 * insufficient. Only checkpoints with a real verdict (direction_correct not
 * null) count as closed: price_suspect, not_measurable and inconclusive rows
 * never count as wins.
 *
 *   < 10 closed  → "📊 Track record building (N signals closed so far)"
 *   ≥ 10 closed  → "📊 Last 90 days: X signals issued, Y hit target, Z hit
 *                   stop, W open. Avg return: R%. Nifty same period: S%."
 *
 * Misses are always counted alongside wins; underperformance against the
 * Nifty is stated, not hidden. Two scoring runs on the same day can write the
 * same call twice, so signals are counted once per instrument per day.
 */
'use strict';

const { supabaseAdmin } = require('../../config/supabase');

const WINDOW_DAYS = 90;
const MIN_CLOSED_FOR_RATE = 10;
const DIRECTIONAL = ['BUY', 'SELL', 'REDUCE'];
const RETURN_FIELD = { 'Weekly': 'return_1w_pct', '14-Day': 'return_14d_pct', 'Monthly': 'return_1m_pct', 'Quarterly': 'return_3m_pct' };
const DISCLAIMER_BASE = 'Past signals are not guarantees. See full methodology at';

function methodologyUrl() {
  const base = (process.env.APP_URL || 'https://wealthguard-rho.vercel.app').replace(/\/+$/, '');
  return process.env.METHODOLOGY_URL || `${base}/methodology.html`;
}

const isBearish = a => a === 'SELL' || a === 'REDUCE';
const istDay = ts => new Date(new Date(ts).getTime() + 19800000).toISOString().slice(0, 10);

/** Did the checkpoint price reach the target or the stop? */
function levelHit(rec, outcome) {
  const p = Number(outcome.price_at_checkpoint ?? outcome.actual_price_inr);
  const t = Number(rec.target_price_inr), s = Number(rec.stop_loss_inr);
  if (!(p > 0)) return null;
  const bear = isBearish(rec.action);
  if (t > 0 && (bear ? p <= t : p >= t)) return 'target';
  if (s > 0 && (bear ? p >= s : p <= s)) return 'stop';
  return null;
}

/** The checkpoint the record is measured at: 14-Day once it has enough, else Weekly. */
function chooseCheckpoint(recs, outcomesByRec) {
  const closedAt = label => recs.filter(r => (outcomesByRec[r.id] || [])
    .some(o => o.checkpoint_label === label && o.direction_correct != null)).length;
  const d14 = closedAt('14-Day'), wk = closedAt('Weekly');
  return d14 >= MIN_CLOSED_FOR_RATE || d14 >= wk ? '14-Day' : 'Weekly';
}

/** Pure: summarise already-loaded signals and outcomes. */
function summarise(recsIn, outcomesByRec, now = new Date()) {
  // One call per instrument per day.
  const seen = new Set();
  const recs = recsIn
    .filter(r => DIRECTIONAL.includes(String(r.action).toUpperCase()))
    .sort((a, b) => (a.generated_at < b.generated_at ? -1 : 1))
    .filter(r => { const k = `${r.instrument_name || r.id}|${istDay(r.generated_at)}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const label = chooseCheckpoint(recs, outcomesByRec);
  const s = { checkpoint: label, issued: recs.length, closed: 0, correct: 0, wrong: 0,
              hit_target: 0, hit_stop: 0, open: 0, not_measurable: 0 };
  const rets = [], nifty = [];

  for (const r of recs) {
    const outs = outcomesByRec[r.id] || [];
    const at = outs.find(o => o.checkpoint_label === label);
    if (at && at.direction_correct != null) {
      s.closed++;
      at.direction_correct ? s.correct++ : s.wrong++;
      // Target / stop: the first checkpoint up to the horizon that reached either.
      const upTo = outs.filter(o => o.checkpoint_date && at.checkpoint_date ? o.checkpoint_date <= at.checkpoint_date : o === at)
        .sort((a, b) => String(a.checkpoint_date || a.measured_at).localeCompare(String(b.checkpoint_date || b.measured_at)));
      const hit = upTo.map(o => levelHit(r, o)).find(Boolean);
      if (hit === 'target') s.hit_target++; else if (hit === 'stop') s.hit_stop++;
      const ret = Number(at[RETURN_FIELD[label]]);
      if (isFinite(ret)) rets.push(isBearish(r.action) ? -ret : ret);
      if (at.nifty_return_same_period != null) nifty.push(Number(at.nifty_return_same_period));
    } else if (at) {
      s.not_measurable++;      // reached its checkpoint, but no honest verdict was possible
    } else {
      s.open++;
    }
  }
  const avg = a => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);
  s.avg_return_pct = avg(rets);
  s.nifty_same_period_pct = avg(nifty);
  s.avg_alpha_pct = s.avg_return_pct != null && s.nifty_same_period_pct != null
    ? Math.round((s.avg_return_pct - s.nifty_same_period_pct) * 100) / 100 : null;
  s.building = s.closed < MIN_CLOSED_FOR_RATE;
  s.window_days = WINDOW_DAYS;
  s.disclaimer = `${DISCLAIMER_BASE} ${methodologyUrl()}`;
  s.methodology_url = methodologyUrl();
  s.text = toText(s);
  return s;
}

const pct = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;

function toText(s) {
  if (s.building) {
    const extra = s.issued
      ? ` ${s.issued} buy/sell signal${s.issued === 1 ? '' : 's'} issued in the last 90 days, ${s.open} still open${s.not_measurable ? `, ${s.not_measurable} could not be measured` : ''}.`
      : ' No buy or sell signals in the last 90 days.';
    return `📊 Track record building (${s.closed} signal${s.closed === 1 ? '' : 's'} closed so far).${extra}`;
  }
  const other = s.closed - s.hit_target - s.hit_stop;
  let t = `📊 Last 90 days: ${s.issued} signals issued, ${s.hit_target} hit target, ${s.hit_stop} hit stop, ` +
          `${other} closed at the ${s.checkpoint === '14-Day' ? '14-day' : '7-day'} mark without either, ${s.open} open.`;
  t += ` Right direction ${s.correct} of ${s.closed}.`;
  if (s.avg_return_pct != null) t += ` Avg return: ${pct(s.avg_return_pct)}.`;
  if (s.nifty_same_period_pct != null) t += ` Nifty same period: ${pct(s.nifty_same_period_pct)}.`;
  if (s.avg_alpha_pct != null && s.avg_alpha_pct < 0) t += ` That is ${Math.abs(s.avg_alpha_pct).toFixed(2)} points behind the Nifty.`;
  if (s.not_measurable) t += ` ${s.not_measurable} could not be measured and are not counted.`;
  return t;
}

async function getTrackRecordSummary(now = new Date()) {
  if (!supabaseAdmin) return summarise([], {}, now);
  const since = new Date(now.getTime() - WINDOW_DAYS * 86400000).toISOString();
  const { data: recs } = await supabaseAdmin.from('recommendations')
    .select('id, instrument_name, action, entry_price_inr, target_price_inr, stop_loss_inr, horizon_days, generated_at')
    .is('client_id', null).in('action', DIRECTIONAL).gte('generated_at', since).limit(5000);
  const list = recs || [];
  const byRec = {};
  for (let i = 0; i < list.length; i += 200) {
    const ids = list.slice(i, i + 200).map(r => r.id);
    const { data: outs } = await supabaseAdmin.from('recommendation_outcomes')
      .select('*').in('recommendation_id', ids).limit(5000);
    for (const o of outs || []) (byRec[o.recommendation_id] = byRec[o.recommendation_id] || []).push(o);
  }
  return summarise(list, byRec, now);
}

module.exports = { getTrackRecordSummary, summarise, chooseCheckpoint, levelHit, MIN_CLOSED_FOR_RATE, DISCLAIMER_BASE };
