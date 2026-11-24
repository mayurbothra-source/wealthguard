/**
 * WealthGuard Track Record Engine
 * Runs daily after market close, and on demand for a backfill.
 *
 * For every house signal (active or superseded) it scores each checkpoint
 * whose window has closed, at the close ON THE CHECKPOINT DATE taken from the
 * instrument's daily history, and records signals that cannot be measured as
 * `not_measurable` with the reason — never as a guess.
 *
 * WHY IT WAS REWRITTEN (Nov 2026 audit, docs/AUDIT-SCORING-2026-11.md)
 * The old query loaded only the 500 NEWEST signals. At ~114 signals a day those
 * were 4-5 days old, younger than the first (7-day) checkpoint, so from
 * 17 Nov every run found "0 checkpoints in window". It also priced every
 * checkpoint at the price on the day it ran (up to 14 days late), and gave up
 * for good on any checkpoint more than 14 days overdue.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const { reportRun } = require('./healthEngine');
const cal = require('../lib/tradingCalendar');
const { makeSeriesCache } = require('./checkpointPricing');

// Checkpoints: calendar days after the signal, with a tolerance in TRADING days
// either side of the target date.
const CHECKPOINTS = [
  { days: 7,  tol: 1, field: 'return_1w_pct',  label: 'Weekly'    },
  { days: 14, tol: 1, field: 'return_14d_pct', label: '14-Day'    },   // the horizon standard signals claim
  { days: 30, tol: 2, field: 'return_1m_pct',  label: 'Monthly'   },
  { days: 90, tol: 3, field: 'return_3m_pct',  label: 'Quarterly' },
];

// First house signal in the database; a backfill starts here.
const BACKFILL_SINCE = '2026-08-28';
// A not_measurable row caused by a failed fetch (not by the instrument itself)
// is retried on later runs for this many days after its window closed.
const RETRY_FETCH_FAILURES_FOR_DAYS = 30;
// Columns added by migration 016. Writes drop them if the migration has not run.
const NEW_COLUMNS = ['return_14d_pct', 'checkpoint_date', 'price_as_of', 'outcome_status', 'not_measurable_reason', 'run_label', 'price_at_checkpoint'];
// SA3: a close used for scoring must be no more than this many trading days before the checkpoint date.
const MAX_STALE_TRADING_DAYS = 3;
const PAGE = 1000;

/**
 * Is a checkpoint ready to score? Only once its whole window has closed in IST,
 * so every close inside the window has been published and the pick is final.
 */
function checkpointDue(win, todayIst) {
  return todayIst > win.end;
}

/**
 * Determine if a prediction is correct at a given checkpoint.
 * BUY/HOLD: correct if price went up (positive return)
 * SELL/REDUCE/WATCH: correct if price stayed flat or went down
 */
/**
 * Was a prediction directionally right?
 *
 * WATCH USED TO COUNT AS A BEARISH PREDICTION, and that inflated the published
 * accuracy figure. Most instruments score 50-69 and therefore land on WATCH,
 * so in any flat or mildly falling week a large slice of the track record was
 * automatically marked correct — for predicting nothing.
 *
 * WATCH is not a directional call. It is the explicit absence of one: "we do
 * not have a view strong enough to act on." Scoring it as a correct bearish
 * call when a price merely fails to rise measures the market's tendency to
 * drift, not our skill.
 *
 * It now returns null, which excludes the checkpoint from the accuracy
 * numerator and denominator both. WATCH outcomes are still recorded and
 * resolved — see classifyOutcome() — so nothing is lost, and the platform can
 * report "of our WATCH calls, X% stayed inside a quiet band" separately and
 * honestly, without folding it into a directional hit rate.
 */
function isDirectionCorrect(action, returnPct) {
  if (!action || returnPct === null || returnPct === undefined || isNaN(returnPct)) return null;
  const a = action.toUpperCase();
  // SA3: a move that rounds to 0.00% proves nothing either way — inconclusive.
  if (['BUY', 'SELL', 'REDUCE'].includes(a) && isFlat(returnPct)) return null;
  if (a === 'BUY') return returnPct > 0;
  if (a === 'SELL' || a === 'REDUCE') return returnPct < 0;
  // HOLD claims the price will hold steady, not that it will rise.
  if (a === 'HOLD') return Math.abs(returnPct) <= HOLD_BAND_PCT;
  return null;   // WATCH and anything unrecognised: no direction was claimed
}

/** A return that rounds to 0.00%. */
function isFlat(returnPct) { return Math.abs(returnPct) < 0.005; }
const HOLD_BAND_PCT = 2;

/**
 * Band a WATCH outcome without pretending it was a directional call.
 * Reported separately from accuracy.
 *
 * "Held" means the price stayed inside ±WATCH_QUIET_BAND_PCT, which is what a
 * WATCH implies — nothing worth acting on happened.
 */
const WATCH_QUIET_BAND_PCT = 3;

function classifyWatchOutcome(returnPct) {
  if (returnPct === null || returnPct === undefined) return null;
  if (Math.abs(returnPct) <= WATCH_QUIET_BAND_PCT) return 'held';
  return returnPct > 0 ? 'rose_beyond_band' : 'fell_beyond_band';
}

/** True when this action made a directional claim at all. */
function isDirectionalAction(action) {
  return ['BUY', 'HOLD', 'SELL', 'REDUCE'].includes(String(action || '').toUpperCase());
}

/** Every row of a select, paged (PostgREST caps a response at 1,000 rows). */
async function selectAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * Insert outcome rows in chunks. If migration 016 has not run, PostgREST
 * rejects unknown columns; the chunk is retried without them, so a checkpoint
 * is never lost to a pending migration. A unique-key clash (another run got
 * there first) falls back to row-by-row inserts and skips the clashing rows.
 */
async function insertOutcomes(rows, state) {
  let written = 0;
  for (let i = 0; i < rows.length; i += 100) {
    let chunk = rows.slice(i, i + 100);
    if (state.dropNewColumns) chunk = chunk.map(stripNew);
    let { error } = await supabaseAdmin.from('recommendation_outcomes').insert(chunk);
    if (error && !state.dropNewColumns && isMissingColumn(error)) {
      state.dropNewColumns = true;
      console.warn(`   ⚠ recommendation_outcomes: migration 016 not applied — writing without [${NEW_COLUMNS.join(', ')}]`);
      chunk = chunk.map(stripNew);
      ({ error } = await supabaseAdmin.from('recommendation_outcomes').insert(chunk));
    }
    if (!error) { written += chunk.length; continue; }
    if (error.code === '23505') {
      for (const r of chunk) {
        const one = await supabaseAdmin.from('recommendation_outcomes').insert(r);
        if (!one.error) written++;
        else if (one.error.code !== '23505') console.error(`   ❌ outcome insert failed: ${one.error.message}`);
      }
      continue;
    }
    console.error(`   ❌ outcome insert failed for ${chunk.length} rows: ${error.message}`);
  }
  return written;
}

function stripNew(r) {
  const c = { ...r };
  for (const k of NEW_COLUMNS) delete c[k];
  return c;
}
function isMissingColumn(error) {
  const m = String(error.message || '').toLowerCase();
  return error.code === 'PGRST204' || error.code === '42703' || m.includes('column') && (m.includes('does not exist') || m.includes('could not find'));
}

/**
 * Score one checkpoint. Pure apart from the series lookups.
 * Returns { row } to write, or { wait: true } when the window has not closed.
 */
async function scoreCheckpoint({ pred, inst, cp, todayIst, now, cache, runLabel }) {
  const win = cal.checkpointWindow(pred.generated_at, cp.days, cp.tol);
  if (!checkpointDue(win, todayIst)) return { wait: true };

  const base = {
    recommendation_id: pred.id,
    client_id:         null,
    checkpoint_label:  cp.label,
    checkpoint_date:   win.target,
    measured_at:       now.toISOString(),
    run_label:         runLabel,
  };
  const notMeasurable = (reason, extra = {}) => ({
    row: { ...base, outcome_status: 'not_measurable', not_measurable_reason: reason, direction_correct: null, ...extra },
  });

  if (!inst) return notMeasurable('instrument not in the universe');
  const entry = Number(pred.monday_open_price_inr || pred.entry_price_inr);
  if (!(entry > 0)) return notMeasurable('no entry price');

  const s = await cache.get(inst);
  if (s.kind === 'static') return notMeasurable('static reference price — no market return');
  if (s.kind === 'error') return { ...notMeasurable(s.reason), retryable: s.retryable };

  const hit = cal.pickCheckpointClose(s.series, win);
  if (!hit) {
    const last = s.series.length ? s.series[s.series.length - 1].date : null;
    return notMeasurable(last && last < win.start
      ? `price history stops at ${last} — no close in ${win.start}..${win.end}`
      : `no close in ${win.start}..${win.end}`);
  }

  // Stale: the close used is too far before the checkpoint date.
  if (hit.date < cal.shiftTradingDays(win.target, -MAX_STALE_TRADING_DAYS)) {
    return notMeasurable(`stale price: close of ${hit.date} is more than ${MAX_STALE_TRADING_DAYS} trading days before ${win.target}`);
  }
  // Suspect: exactly the entry price. Seen on dead AMFI codes that keep
  // returning their last NAV — a 0.00% "move" that is really no data.
  if (Math.abs(hit.close - Number(pred.entry_price_inr)) <= 0.01) {
    return { row: { ...base, outcome_status: 'price_suspect', direction_correct: null,
      not_measurable_reason: `checkpoint price ₹${hit.close} on ${hit.date} equals the entry price — likely a feed that stopped updating`,
      actual_price_inr: hit.close, price_at_checkpoint: hit.close, price_as_of: hit.date, price_source: s.source } };
  }

  const returnPct = ((hit.close - entry) / entry) * 100;
  // A move this large over the period means the entry and checkpoint prices are
  // in different units (how Gold once showed -97% in a week). Refuse to score it.
  const IMPLAUSIBLE = { 7: 50, 14: 60, 30: 70, 90: 90 };
  if (Math.abs(returnPct) > IMPLAUSIBLE[cp.days]) {
    return notMeasurable(`implausible ${returnPct.toFixed(1)}% move (entry ₹${entry}, checkpoint ₹${hit.close}) — likely a unit mismatch`);
  }

  const correct = isDirectionCorrect(pred.action, returnPct);
  const watchOutcome = correct === null && String(pred.action).toUpperCase() === 'WATCH'
    ? classifyWatchOutcome(returnPct) : null;

  // Nifty over the same dates, for honest alpha.
  let niftyReturn = null;
  const n = await cache.nifty();
  if (n.kind === 'series') {
    const a = cal.closeOnOrBefore(n.series, win.signalDate), b = cal.closeOnOrBefore(n.series, hit.date);
    if (a && b && a.date < b.date) niftyReturn = parseFloat((((b.close - a.close) / a.close) * 100).toFixed(2));
  }
  const ret = parseFloat(returnPct.toFixed(2));

  return {
    row: {
      ...base,
      outcome_status:           correct === null && isDirectionalAction(pred.action) ? 'inconclusive' : 'measured',
      not_measurable_reason:    null,
      price_at_checkpoint:      hit.close,
      direction_correct:        correct,
      watch_outcome:            watchOutcome,
      actual_price_inr:         hit.close,
      price_as_of:              hit.date,
      price_source:             s.source,
      nifty_return_same_period: niftyReturn,
      alpha_generated:          niftyReturn === null ? null : parseFloat((ret - niftyReturn).toFixed(2)),
      [cp.field]:               ret,
    },
  };
}

/**
 * SA2 — the verdict on a recommendation as a whole, from its checkpoints.
 * Strictest wins: any checkpoint wrong → false; otherwise, if at least one
 * checkpoint has a verdict and all verdicts are right → true; no verdict → null.
 * Checkpoints without a verdict (WATCH, not_measurable, inconclusive) are
 * ignored. It is recomputed every run, so a later wrong checkpoint flips an
 * earlier true to false.
 */
function rollupOutcome(outcomes) {
  const verdicts = (outcomes || []).map(o => o.direction_correct).filter(v => v === true || v === false);
  if (!verdicts.length) return null;
  return verdicts.includes(false) ? false : true;
}

/** Write recommendations.outcome_correct for the given ids; only rows whose value changes. */
async function syncOutcomeCorrect(recIds, outcomesByRec, currentByRec) {
  const groups = { true: [], false: [], null: [] };
  for (const id of recIds) {
    const v = rollupOutcome(outcomesByRec.get(id));
    if ((currentByRec.get(id) ?? null) !== v) groups[String(v)].push(id);
  }
  let updated = 0;
  for (const [k, ids] of Object.entries(groups)) {
    const value = k === 'null' ? null : k === 'true';
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error } = await supabaseAdmin.from('recommendations').update({ outcome_correct: value }).in('id', chunk);
      if (error) console.error(`   ❌ outcome_correct update failed: ${error.message}`);
      else updated += chunk.length;
    }
  }
  return updated;
}

/**
 * Main engine. Options:
 *   since     — only signals generated on/after this IST date (default: all)
 *   runLabel  — recorded on each row ('daily', or 'backfill_2026_11')
 *   now       — for tests
 */
async function runTrackRecordCheckpoints(opts = {}) {
  if (!supabaseAdmin) {
    console.log('📋 Track record engine: Supabase not configured, skipping.');
    return null;
  }
  const engineStart = Date.now();
  const now = opts.now ? new Date(opts.now) : new Date();
  const runLabel = opts.runLabel || 'daily';
  const since = opts.since || BACKFILL_SINCE;
  const todayIst = cal.istDateOf(now);
  console.log(`📋 Track record (${runLabel}): scoring checkpoints for signals since ${since}...`);

  let preds, instruments, existing;
  try {
    // Every house signal old enough for its first checkpoint, active or not —
    // a superseded signal still happened and still gets scored.
    const oldest = new Date(now.getTime() - 7 * 86400000).toISOString();
    preds = await selectAll(() => supabaseAdmin.from('recommendations')
      .select('id, instrument_name, action, entry_price_inr, monday_open_price_inr, generated_at, outcome_correct')
      .is('client_id', null)
      .not('entry_price_inr', 'is', null)
      .gte('generated_at', `${since}T00:00:00+05:30`)
      .lt('generated_at', oldest)
      .order('generated_at', { ascending: true }));
    instruments = await selectAll(() => supabaseAdmin.from('instrument_universe')
      .select('symbol, name, instrument_type, exchange, yahoo_ticker, amfi_code, static_price, price_source')
      .order('symbol', { ascending: true }));
    existing = await selectAll(() => supabaseAdmin.from('recommendation_outcomes')
      .select('*')
      .is('client_id', null)
      .order('measured_at', { ascending: true }));
  } catch (e) {
    console.error(`📋 Track record: could not load signals — ${e.message}`);
    await reportRun({ engineName: 'trackRecordEngine', durationMs: Date.now() - engineStart,
      itemsProcessed: 0, itemsExpected: null, itemsFailed: 1, detail: `load failed: ${e.message}` });
    return null;
  }

  const bySymbol = new Map();
  for (const i of instruments) { bySymbol.set(i.symbol, i); if (i.name && !bySymbol.has(i.name)) bySymbol.set(i.name, i); }
  const done = new Map();   // `${rec}|${label}` -> existing row
  for (const o of existing) done.set(`${o.recommendation_id}|${o.checkpoint_label}`, o);

  const cache = makeSeriesCache({ fromYmd: since, toYmd: todayIst });
  const toInsert = [], toRetry = [];
  const c = { due: 0, already: 0, measured: 0, notMeasurable: 0, retried: 0, waiting: 0 };
  const reasons = {};

  for (const pred of preds) {
    const inst = bySymbol.get(pred.instrument_name) || null;
    for (const cp of CHECKPOINTS) {
      const prior = done.get(`${pred.id}|${cp.label}`);
      // A prior row is final unless it is a not_measurable caused by a fetch
      // failure whose window closed recently — then try again.
      if (prior && !isRetryable(prior, now) && !isLegacy(prior)) { c.already++; continue; }

      const r = await scoreCheckpoint({ pred, inst, cp, todayIst, now, cache, runLabel });
      if (r.wait) { c.waiting++; continue; }
      c.due++;
      const row = r.row;
      if (['measured', 'inconclusive'].includes(row.outcome_status)) c.measured++;
      else {
        c.notMeasurable++;
        const key = row.not_measurable_reason.replace(/\d{4}-\d{2}-\d{2}/g, 'DATE').replace(/-?\d+(\.\d+)?%.*/, '…');
        reasons[key] = (reasons[key] || 0) + 1;
      }
      if (prior && isLegacy(prior)) {
        // Scored at the wrong date's price under the old rules: always replace.
        toRetry.push({ id: prior.id, row }); c.rescored = (c.rescored || 0) + 1;
      } else if (prior) {
        // Only a better answer replaces a failed fetch; another failure leaves it be.
        if (['measured', 'inconclusive'].includes(row.outcome_status)) { toRetry.push({ id: prior.id, row }); c.retried++; }
      } else {
        toInsert.push(row);
        done.set(`${pred.id}|${cp.label}`, row);
      }
    }
  }

  const state = { dropNewColumns: false };
  const written = await insertOutcomes(toInsert, state);
  let updated = 0;
  for (const { id, row } of toRetry) {
    const { error } = await supabaseAdmin.from('recommendation_outcomes')
      .update(state.dropNewColumns ? stripNew(row) : row).eq('id', id);
    if (!error) updated++;
  }

  // SA2: keep recommendations.outcome_correct in step with the checkpoints.
  const outcomesByRec = new Map();
  for (const o of existing) (outcomesByRec.get(o.recommendation_id) || outcomesByRec.set(o.recommendation_id, []).get(o.recommendation_id)).push(o);
  for (const { id, row } of toRetry) {
    const list = outcomesByRec.get(row.recommendation_id) || [];
    const i = list.findIndex(o => o.id === id);
    if (i >= 0) list[i] = { ...list[i], ...row };
  }
  for (const r of toInsert) (outcomesByRec.get(r.recommendation_id) || outcomesByRec.set(r.recommendation_id, []).get(r.recommendation_id)).push(r);
  const currentByRec = new Map(preds.map(p => [p.id, p.outcome_correct ?? null]));
  const outcomeCorrectUpdated = await syncOutcomeCorrect(preds.map(p => p.id), outcomesByRec, currentByRec);

  const measuredWritten = toInsert.filter(r => r.outcome_status === 'measured').length;
  const reasonText = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${v}× ${k}`).join('; ');
  const detail = `[${runLabel}] ${preds.length} signals, ${c.due} checkpoints due: ${c.measured} measured, ` +
    `${c.notMeasurable} not measurable${reasonText ? ` (${reasonText})` : ''}; ${c.already} already recorded, ` +
    `${c.waiting} not yet due; ${c.rescored || 0} legacy rows re-scored; ${written} rows written, ${updated} existing rows re-scored, ${outcomeCorrectUpdated} outcome_correct updated`;
  console.log(`📋 Track record complete: ${detail}`);

  await reportRun({
    engineName:     'trackRecordEngine',
    durationMs:     Date.now() - engineStart,
    // Rows actually written this run (measured or honestly not measurable).
    itemsProcessed: written + updated,
    itemsExpected:  c.due || null,
    itemsFailed:    toInsert.length - written,
    detail,
  });
  return { ...c, written, updated, outcomeCorrectUpdated, measuredWritten, signals: preds.length, reasons };
}

/** Written before SA1/SA3: priced on the run day, under the old 0.00%-is-correct rules. */
function isLegacy(prior) {
  return !prior.checkpoint_date || prior.run_label === 'legacy_live_price';
}

function isRetryable(prior, now) {
  if (prior.outcome_status !== 'not_measurable') return false;
  if (!/fetch failed/.test(prior.not_measurable_reason || '')) return false;
  if (!prior.checkpoint_date) return false;
  return (now - new Date(`${prior.checkpoint_date}T00:00:00Z`)) / 86400000 <= RETRY_FETCH_FAILURES_FOR_DAYS;
}

module.exports = {
  CHECKPOINTS, BACKFILL_SINCE, checkpointDue, scoreCheckpoint, rollupOutcome,
  classifyWatchOutcome, isDirectionalAction, isDirectionCorrect, isFlat, HOLD_BAND_PCT, WATCH_QUIET_BAND_PCT,
  runTrackRecordCheckpoints,
};
