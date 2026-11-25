/**
 * SA3 — honest direction rules, 0.00% handling, price_suspect, NAV staleness,
 * and re-scoring of outcomes written under the old rules.
 */
'use strict';
process.env.NODE_ENV = 'test';

const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const DB = require('./_fakeDb')();
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r.endsWith('/healthEngine') || r === './healthEngine') return { reportRun: async () => {} };
  return orig(r, p, i);
};
const cal = require('../backend/lib/tradingCalendar');
const pricing = require('../backend/services/checkpointPricing');
const eng = require('../backend/services/trackRecordEngine');
const D = eng.isDirectionCorrect;

(async () => {
  console.log('\nDirection rules');
  ck('BUY up → correct', D('BUY', 1.2) === true);
  ck('BUY down → wrong', D('BUY', -0.4) === false);
  ck('BUY 0.00% → inconclusive (null), not correct', D('BUY', 0) === null && D('BUY', 0.004) === null);
  ck('SELL down → correct', D('SELL', -2) === true);
  ck('SELL up → wrong', D('SELL', 8.15) === false);
  ck('SELL 0.00% → inconclusive (null) — the old rule called this correct', D('SELL', 0) === null && D('SELL', -0.001) === null);
  ck('SELL −0.01% is a real (tiny) fall → correct', D('SELL', -0.01) === true);
  ck('REDUCE follows SELL', D('REDUCE', -1) === true && D('REDUCE', 1) === false);
  ck('HOLD within ±2% → correct', D('HOLD', 1.9) === true && D('HOLD', -2) === true && D('HOLD', 0) === true);
  ck('HOLD beyond ±2% → wrong (either way)', D('HOLD', 2.5) === false && D('HOLD', -3) === false);
  ck('WATCH has no direction', D('WATCH', 5) === null && D('WATCH', -5) === null);
  ck('WATCH bands unchanged', eng.classifyWatchOutcome(2) === 'held' && eng.classifyWatchOutcome(4) === 'rose_beyond_band' && eng.classifyWatchOutcome(-4) === 'fell_beyond_band');

  // ── Engine: suspect / stale / inconclusive / legacy re-score ──
  console.log('\nNAV freshness and re-scoring');
  const days = [];
  for (let d = '2026-08-20'; d <= '2026-11-23'; d = cal.addCalendarDays(d, 1)) if (cal.isTradingDay(d)) days.push(d);
  const rising = days.map((date, i) => ({ date, close: +(100 * 1.002 ** i).toFixed(4) }));
  const at = ymd => cal.closeOnOrBefore(rising, ymd).close;
  const frozen = days.map(date => ({ date, close: 14.55 }));                         // dead code: same NAV daily
  const gappy = rising.filter(p => p.date < '2026-10-05' || p.date > '2026-10-20');   // 2-week publishing gap
  pricing._setFetchers({
    mfapi: async code => ({ series: code === 'FROZEN' ? frozen : code === 'GAPPY' ? gappy : rising }),
    yahoo: async () => ({ series: rising }),
  });
  DB.seed('instrument_universe', [
    { symbol: 'MF-FRK-PRM', price_source: 'mfapi', amfi_code: 'FROZEN' },
    { symbol: 'MF-NIP-LC',  price_source: 'mfapi', amfi_code: '1' },
    { symbol: 'MF-GAP',     price_source: 'mfapi', amfi_code: 'GAPPY' },
  ]);
  DB.seed('recommendations', [
    { id: 'frz', client_id: null, instrument_name: 'MF-FRK-PRM', action: 'SELL', entry_price_inr: 14.55, generated_at: '2026-10-01T04:00:00Z' },
    { id: 'nip', client_id: null, instrument_name: 'MF-NIP-LC', action: 'SELL', entry_price_inr: at('2026-10-01'), generated_at: '2026-10-01T04:00:00Z' },
    { id: 'hold', client_id: null, instrument_name: 'MF-NIP-LC', action: 'HOLD', entry_price_inr: at('2026-10-01'), generated_at: '2026-10-01T04:00:00Z' },
    { id: 'gap', client_id: null, instrument_name: 'MF-GAP', action: 'BUY', entry_price_inr: at('2026-10-01'), generated_at: '2026-10-01T04:00:00Z' },
  ]);
  // Legacy rows as found in production: the dead-code SELL marked correct at 0.00%,
  // the rising SELL marked wrong, the HOLD marked wrong (old rule: HOLD = bullish).
  DB.seed('recommendation_outcomes', [
    { id: 'L1', recommendation_id: 'frz', client_id: null, checkpoint_label: 'Monthly', direction_correct: true, return_1m_pct: 0, actual_price_inr: 14.55, measured_at: '2026-11-11T00:00:00Z', run_label: 'legacy_live_price', outcome_status: 'measured' },
    { id: 'L2', recommendation_id: 'nip', client_id: null, checkpoint_label: 'Monthly', direction_correct: false, return_1m_pct: 8.15, measured_at: '2026-11-11T00:00:00Z' },
    { id: 'L3', recommendation_id: 'hold', client_id: null, checkpoint_label: 'Weekly', direction_correct: false, return_1w_pct: 1.0, measured_at: '2026-10-20T00:00:00Z' },
  ]);

  const r = await eng.runTrackRecordCheckpoints({ now: '2026-11-23T12:00:00Z' });
  const outs = DB.rows('recommendation_outcomes');
  const of = (id, l) => outs.filter(o => o.recommendation_id === id && o.checkpoint_label === l);

  const frz = of('frz', 'Monthly');
  ck('legacy row re-scored in place, no duplicate', frz.length === 1 && frz[0].id === 'L1');
  ck('dead-code SELL at 0.00% is now price_suspect with no verdict (was "correct")',
    frz[0].outcome_status === 'price_suspect' && frz[0].direction_correct === null);
  ck('price_suspect explains itself', /equals the entry price/.test(frz[0].not_measurable_reason));
  ck('price_at_checkpoint records the price actually used', frz[0].price_at_checkpoint === 14.55);
  ck('every checkpoint of the dead-code SELL is suspect, none correct', outs.filter(o => o.recommendation_id === 'frz').every(o => o.direction_correct !== true));

  const nip = of('nip', 'Monthly')[0];
  ck('rising-fund SELL stays wrong, re-priced at its checkpoint date', nip.id === 'L2' && nip.direction_correct === false && nip.price_at_checkpoint === nip.actual_price_inr && nip.price_as_of <= nip.checkpoint_date);

  const hw = of('hold', 'Weekly')[0];
  ck('HOLD re-scored under the ±2% rule', hw.direction_correct === (Math.abs(hw.return_1w_pct) <= 2));
  ck('re-score counted in the run summary', r.updated >= 3);

  const gap = of('gap', '14-Day')[0];   // target 15 Oct falls in the publishing gap
  ck('NAV gap longer than the window → not_measurable, not a stale price', gap.outcome_status === 'not_measurable' && gap.direction_correct === null);

  // Acceptance: none of the SELLs is "correct" any more
  const sellVerdicts = outs.filter(o => ['frz', 'nip'].includes(o.recommendation_id) && o.direction_correct !== null);
  ck(`honest SELL accuracy: 0 correct of ${sellVerdicts.length} with real price movement`, sellVerdicts.length > 0 && sellVerdicts.every(o => o.direction_correct === false));
  ck('outcome_correct follows: dead-code SELL null, rising SELL false',
    (DB.rows('recommendations').find(x => x.id === 'frz').outcome_correct ?? null) === null &&
    DB.rows('recommendations').find(x => x.id === 'nip').outcome_correct === false);

  // A 0.00% move on a live feed (not equal to entry because entry used Monday open) → inconclusive
  const row = (await eng.scoreCheckpoint({
    pred: { id: 'z', action: 'BUY', entry_price_inr: 99, monday_open_price_inr: 100, generated_at: '2026-10-01T04:00:00Z' },
    inst: { symbol: 'Z', price_source: 'yahoo', yahoo_ticker: 'Z' },
    cp: eng.CHECKPOINTS[0], todayIst: '2026-11-23', now: new Date('2026-11-23T12:00:00Z'),
    cache: { get: async () => ({ kind: 'series', series: [{ date: '2026-10-08', close: 100 }], source: 'yahoo_history' }), nifty: async () => ({ kind: 'error' }) },
    runLabel: 't' })).row;
  ck('0.00% from the trade-able entry → outcome_status inconclusive, direction null', row.outcome_status === 'inconclusive' && row.direction_correct === null);
})();
