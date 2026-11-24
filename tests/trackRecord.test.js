/**
 * SA1 — track-record checkpoints: trading-day windows, the 14-Day checkpoint,
 * scoring at the checkpoint-date close, inactive signals, duplicates, the
 * backfill, and honest not_measurable rows.
 */
'use strict';
process.env.NODE_ENV = 'test';

const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const DB = require('./_fakeDb')();
const runs = [];
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r.endsWith('/healthEngine') || r === './healthEngine') return { reportRun: async x => { runs.push(x); } };
  return orig(r, p, i);
};

const cal = require('../backend/lib/tradingCalendar');
const pricing = require('../backend/services/checkpointPricing');
const eng = require('../backend/services/trackRecordEngine');

(async () => {
  console.log('\nTrading calendar');
  ck('Saturday and Sunday are not trading days', !cal.isTradingDay('2026-11-07') && !cal.isTradingDay('2026-11-08'));
  ck('Gandhi Jayanti (Fri 2 Oct) is not a trading day', !cal.isTradingDay('2026-10-02'));
  ck('one trading day after Thu 1 Oct skips the holiday and weekend → Mon 5 Oct', cal.shiftTradingDays('2026-10-01', 1) === '2026-10-05');
  ck('IST date: 20:00 UTC Sunday is Monday in India', cal.istDateOf('2026-11-01T20:00:00Z') === '2026-11-02');

  let w = cal.checkpointWindow('2026-11-01T12:00:00Z', 7, 1);   // Sunday signal
  ck('Weekly on a Sunday signal: target Sun 8 Nov, window Fri 6 – Mon 9 Nov',
    w.target === '2026-11-08' && w.start === '2026-11-06' && w.end === '2026-11-09');
  w = cal.checkpointWindow('2026-09-24T10:00:00Z', 7, 1);       // Thu → Thu 1 Oct
  ck('Weekly across the 2 Oct holiday: window Wed 30 Sep – Mon 5 Oct', w.start === '2026-09-30' && w.end === '2026-10-05');
  w = cal.checkpointWindow('2026-08-31T10:00:00Z', 30, 2);
  ck('Monthly across a month boundary: 31 Aug + 30 = 30 Sep, ±2 trading days',
    w.target === '2026-09-30' && w.start === '2026-09-28' && w.end === '2026-10-05');
  w = cal.checkpointWindow('2026-10-01T10:00:00Z', 30, 2);      // target Sat 31 Oct
  ck('Monthly on a Saturday target: window Thu 29 Oct – Tue 3 Nov', w.start === '2026-10-29' && w.end === '2026-11-03');
  w = cal.checkpointWindow('2026-11-02T04:00:00Z', 14, 1);
  ck('14-Day checkpoint: Mon 2 Nov → Mon 16 Nov, window 13–17 Nov', w.target === '2026-11-16' && w.start === '2026-11-13' && w.end === '2026-11-17');

  const win = { target: '2026-11-08', start: '2026-11-06', end: '2026-11-09' };
  ck('weekend target uses the nearest PRIOR close (Fri 6 Nov, not Mon 9 Nov)',
    cal.pickCheckpointClose([{ date: '2026-11-06', close: 10 }, { date: '2026-11-09', close: 11 }], win).date === '2026-11-06');
  ck('…and the next close only when nothing on/before the target is in the window',
    cal.pickCheckpointClose([{ date: '2026-11-09', close: 11 }], win).date === '2026-11-09');
  ck('on an equal distance the earlier close wins',
    cal.pickCheckpointClose([{ date: '2026-11-05', close: 9 }, { date: '2026-11-11', close: 12 }],
      { target: '2026-11-08', start: '2026-11-05', end: '2026-11-11' }).date === '2026-11-05');
  ck('no close inside the window → null (never a price from outside it)',
    cal.pickCheckpointClose([{ date: '2026-11-02', close: 9 }, { date: '2026-11-12', close: 12 }], win) === null);

  ck('checkpoint is not due until its whole window has closed',
    !eng.checkpointDue(win, '2026-11-09') && eng.checkpointDue(win, '2026-11-10'));
  ck('MFAPI dates convert to ISO', pricing.mfapiDate('06-11-2026') === '2026-11-06');

  // ── Engine, end to end on a fake database ─────────────────────────────────
  console.log('\nEngine');
  const days = [];
  for (let d = '2026-08-20'; d <= '2026-11-23'; d = cal.addCalendarDays(d, 1)) if (cal.isTradingDay(d)) days.push(d);
  // Steady rise: +0.1% a trading day from 100.
  const rising = days.map((date, i) => ({ date, close: +(100 * 1.001 ** i).toFixed(4) }));
  const closeOn = ymd => cal.closeOnOrBefore(rising, ymd).close;
  const yahooCalls = [];
  pricing._setFetchers({
    mfapi: async code => {
      if (code === 'DEAD') return { series: rising.filter(p => p.date <= '2026-09-01') };   // stops publishing
      return { series: rising };
    },
    yahoo: async (t) => {
      yahooCalls.push(t);
      if (t === '^NSEI') return { series: rising.map(p => ({ date: p.date, close: p.close * 2 })) };
      if (t === 'BLOCKED.NS') { const e = new Error('rate limited'); e.response = { status: 429 }; throw e; }
      return { series: rising };
    },
  });

  DB.seed('instrument_universe', [
    { symbol: 'MF-DEBT',  name: 'Debt Fund', price_source: 'mfapi', amfi_code: '1001' },
    { symbol: 'MF-DEAD',  name: 'Dead code', price_source: 'mfapi', amfi_code: 'DEAD' },
    { symbol: 'GSEC10Y',  name: 'G-Sec',     price_source: 'static', static_price: 100 },
    { symbol: 'NIFTYBEES', name: 'Nifty ETF', price_source: 'yahoo', yahoo_ticker: 'NIFTYBEES.NS' },
    { symbol: 'BLOCKED',  name: 'Blocked',   price_source: 'yahoo', yahoo_ticker: 'BLOCKED.NS' },
  ]);

  // 27 BUYs between 28 Aug and 12 Sep, as in production, all inactive now.
  const buySyms = ['MF-DEBT', 'GSEC10Y', 'MF-DEBT', 'NIFTYBEES'];
  const recs = [];
  for (let i = 0; i < 27; i++) {
    const d = cal.addCalendarDays('2026-08-28', Math.floor(i * 15 / 27));
    const sym = buySyms[i % buySyms.length];
    const entry = sym === 'GSEC10Y' ? 100 : closeOn(d);
    recs.push({ id: `buy${i}`, client_id: null, instrument_name: sym, action: 'BUY', is_active: false,
      entry_price_inr: entry, generated_at: `${d}T04:00:00.000Z` });
  }
  recs.push({ id: 'sellDead', client_id: null, instrument_name: 'MF-DEAD', action: 'SELL', is_active: false,
    entry_price_inr: closeOn('2026-09-01'), generated_at: '2026-10-01T04:00:00.000Z' });
  recs.push({ id: 'watchBlocked', client_id: null, instrument_name: 'BLOCKED', action: 'WATCH', is_active: true,
    entry_price_inr: closeOn('2026-11-02'), generated_at: '2026-11-02T04:00:00.000Z' });
  recs.push({ id: 'young', client_id: null, instrument_name: 'MF-DEBT', action: 'WATCH', is_active: true,
    entry_price_inr: closeOn('2026-11-20'), generated_at: '2026-11-20T04:00:00.000Z' });
  recs.push({ id: 'client', client_id: 'c1', instrument_name: 'MF-DEBT', action: 'BUY',
    entry_price_inr: 100, generated_at: '2026-09-01T04:00:00.000Z' });
  DB.seed('recommendations', recs);
  // A legacy duplicate-prone row: already recorded Weekly for buy0.
  DB.seed('recommendation_outcomes', [{ id: 'legacy1', recommendation_id: 'buy0', client_id: null,
    checkpoint_label: 'Weekly', direction_correct: true, return_1w_pct: 0, measured_at: '2026-09-10T00:00:00Z' }]);

  const now = '2026-11-23T12:00:00Z';
  const r1 = await eng.runTrackRecordCheckpoints({ now, runLabel: 'backfill_2026_11' });
  const outs = DB.rows('recommendation_outcomes');
  const of = (id, label) => outs.filter(o => o.recommendation_id === id && o.checkpoint_label === label);

  ck('every one of the 27 BUYs has an outcome row', recs.filter(r => r.action === 'BUY' && !r.client_id).every(r => outs.some(o => o.recommendation_id === r.id)));
  ck('inactive signals are scored', of('buy1', 'Monthly').length === 1);
  ck('client-specific recommendations are not scored as house calls', !outs.some(o => o.recommendation_id === 'client'));
  ck('signal younger than 7 days is not scored', !outs.some(o => o.recommendation_id === 'young'));
  ck('existing Weekly row is not duplicated', of('buy0', 'Weekly').length === 1 && of('buy0', 'Weekly')[0].id === 'legacy1');
  ck('the 14-Day checkpoint is written', of('buy0', '14-Day').length === 1 && of('buy0', '14-Day')[0].return_14d_pct != null);
  ck('Quarterly not written before its window closes', of('buy20', 'Quarterly').length === 0);

  const m = of('buy2', 'Monthly')[0];
  const mw = cal.checkpointWindow(recs[2].generated_at, 30, 2);
  ck('Monthly is priced at the checkpoint-date close, not today\'s price',
    m.outcome_status === 'measured' && m.price_as_of >= mw.start && m.price_as_of <= mw.end && m.actual_price_inr === closeOn(m.price_as_of));
  ck('return matches entry → checkpoint close', Math.abs(m.return_1m_pct - ((m.actual_price_inr - recs[2].entry_price_inr) / recs[2].entry_price_inr * 100)) < 0.01);
  ck('a rising BUY is directionally correct', m.direction_correct === true);
  ck('alpha is computed against Nifty over the same dates', m.nifty_return_same_period != null && m.alpha_generated != null);
  ck('rows carry run_label backfill_2026_11 and the checkpoint date', m.run_label === 'backfill_2026_11' && m.checkpoint_date === mw.target);

  const g = of('buy1', 'Monthly')[0];
  ck('static-priced G-Sec BUY → not_measurable with a reason, no verdict',
    g.outcome_status === 'not_measurable' && g.direction_correct === null && /static/.test(g.not_measurable_reason));
  const dead = of('sellDead', 'Weekly')[0];
  ck('a dead scheme code (history stops) → not_measurable, never a 0.00% "correct" SELL',
    dead.outcome_status === 'not_measurable' && dead.direction_correct === null && /stops at/.test(dead.not_measurable_reason));
  const bl = of('watchBlocked', 'Weekly')[0];
  ck('a failed fetch (HTTP 429) → not_measurable, reason recorded', bl.outcome_status === 'not_measurable' && /429/.test(bl.not_measurable_reason));
  ck('each instrument history is fetched once per run', yahooCalls.filter(t => t === 'NIFTYBEES.NS').length === 1);

  const run1 = runs[runs.length - 1];
  ck('health report shows non-zero items processed', run1.itemsProcessed > 0 && /backfill_2026_11/.test(run1.detail));

  // >80% coverage of signals older than 14 days
  const old = recs.filter(r => !r.client_id && r.generated_at < '2026-11-09');
  const covered = old.filter(r => outs.some(o => o.recommendation_id === r.id)).length;
  ck(`>80% of signals older than 14 days have an outcome (${covered}/${old.length})`, covered / old.length > 0.8);

  // ── Second run: nothing new to write, retry of the failed fetch succeeds ──
  pricing._setFetchers({ yahoo: async t => (t === '^NSEI' ? { series: rising } : { series: rising }) });
  const before = outs.length;
  const r2 = await eng.runTrackRecordCheckpoints({ now });
  const after = DB.rows('recommendation_outcomes');
  ck('a re-run writes no duplicate rows', after.length === before && r2.written === 0);
  const bl2 = after.filter(o => o.recommendation_id === 'watchBlocked' && o.checkpoint_label === 'Weekly');
  ck('a failed fetch is retried later and the row upgraded in place', bl2.length === 1 && bl2[0].outcome_status === 'measured' && r2.updated >= 1);
  ck('a not_measurable static price is final (not retried)', r2.already > 0);

  // ── Unmigrated database: new columns rejected, checkpoint still lands ──
  console.log('\nUnmigrated database');
  const DB2 = require('./_fakeDb')();
  for (const c of ['return_14d_pct', 'checkpoint_date', 'price_as_of', 'outcome_status', 'not_measurable_reason', 'run_label'])
    (DB2.rejectColumns.recommendation_outcomes = DB2.rejectColumns.recommendation_outcomes || new Set()).add(c);
  DB2.seed('instrument_universe', [{ symbol: 'MF-DEBT', price_source: 'mfapi', amfi_code: '1001' }]);
  DB2.seed('recommendations', [{ id: 'x', client_id: null, instrument_name: 'MF-DEBT', action: 'SELL',
    entry_price_inr: closeOn('2026-10-01'), generated_at: '2026-10-01T04:00:00.000Z' }]);
  const saveFrom = DB.from; DB.from = DB2.from;
  await eng.runTrackRecordCheckpoints({ now });
  DB.from = saveFrom;
  const o2 = DB2.rows('recommendation_outcomes');
  ck('outcomes still written without the migration-016 columns', o2.length >= 3 && o2.every(o => o.outcome_status === undefined));
  ck('a SELL on a rising fund is wrong', o2.find(o => o.checkpoint_label === 'Monthly').direction_correct === false);
  // ── Only ONE pending column: the others must still be written (24 Nov bug) ──
  console.log('\nOne column not migrated yet');
  const DB3 = require('./_fakeDb')();
  DB3.rejectColumns.recommendation_outcomes = new Set(['price_at_checkpoint']);
  DB3.seed('instrument_universe', [{ symbol: 'MF-DEBT', price_source: 'mfapi', amfi_code: '1001' }]);
  DB3.seed('recommendations', [{ id: 'y', client_id: null, instrument_name: 'MF-DEBT', action: 'BUY',
    entry_price_inr: closeOn('2026-10-01'), generated_at: '2026-10-01T04:00:00.000Z' }]);
  const save3 = DB.from; DB.from = DB3.from;
  await eng.runTrackRecordCheckpoints({ now });
  DB.from = save3;
  const o3 = DB3.rows('recommendation_outcomes');
  ck('a missing price_at_checkpoint column drops only that column', o3.length >= 3 && o3.every(o => o.price_at_checkpoint === undefined));
  ck('…checkpoint_date, outcome_status, price_as_of and 14-Day return are still written',
    o3.every(o => o.checkpoint_date && o.outcome_status && o.run_label) && o3.some(o => o.checkpoint_label === '14-Day' && o.return_14d_pct != null));

  // ── SA2: outcome_correct on the recommendation ──
  console.log('\nSA2 outcome_correct');
  ck('rollup: any wrong checkpoint → false', eng.rollupOutcome([{ direction_correct: true }, { direction_correct: false }]) === false);
  ck('rollup: all verdicts right → true', eng.rollupOutcome([{ direction_correct: true }, { direction_correct: true }, { direction_correct: null }]) === true);
  ck('rollup: no verdict (WATCH / not measurable) → null', eng.rollupOutcome([{ direction_correct: null }]) === null && eng.rollupOutcome([]) === null);
  const recRows = DB.rows('recommendations');
  const ocOf = id => recRows.find(r => r.id === id).outcome_correct;
  ck('a BUY scored right at every measured checkpoint → outcome_correct true', ocOf('buy2') === true);
  ck('a static G-Sec BUY with no verdict stays null', (ocOf('buy1') ?? null) === null);
  ck('a WATCH never gets a verdict', (ocOf('watchBlocked') ?? null) === null);
  const outsNow = DB.rows('recommendation_outcomes');
  const withVerdict = new Set(outsNow.filter(o => o.direction_correct === true || o.direction_correct === false).map(o => o.recommendation_id));
  ck('acceptance: no recommendation with a verdict has outcome_correct null',
    recRows.filter(r => withVerdict.has(r.id) && (r.outcome_correct ?? null) === null).length === 0);
  // A later wrong checkpoint flips an earlier true.
  outsNow.filter(o => o.recommendation_id === 'buy2' && o.checkpoint_label === 'Weekly').forEach(o => { o.direction_correct = false; });
  await eng.runTrackRecordCheckpoints({ now });
  ck('a later wrong checkpoint flips outcome_correct to false', ocOf('buy2') === false);
})();

