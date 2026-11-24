/**
 * WS3 — signal integrity.
 *   A static or stale price can never produce a BUY or carry a target/stop;
 *   targets and stops come from volatility (or yield for debt), not fixed
 *   percentages; reward:risk below 1.5 downgrades a BUY to WATCH; and no email
 *   shows a target or stop for an instrument without a trusted live price.
 */
'use strict';
process.env.NODE_ENV = 'test';

const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const DB = require('./_fakeDb')();
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r.endsWith('services/marketData') || r === './marketData')
    return { refreshAllMarketData: async () => ({}), getNSEQuote: async () => null, getYahooQuote: async () => null,
             getMFNav: async () => null, getMacroIndicators: async () => ({}), getIndiaVIX: async () => 15, classifyVIXRegime: () => ({}) };
  if (r === './healthEngine' || r.endsWith('services/healthEngine')) return { reportRun: async () => ({}) };
  return orig(r, p, i);
};

const { computeLevels, priceModeOf, priceIsFresh } = require('../backend/services/signalLevels');
const NOW = new Date('2026-11-13T05:00:00Z');                 // Fri 10:30 IST
const FRESH = '2026-11-12T10:00:00Z', STALE = '2026-11-06T10:00:00Z';
const eq = { category: 'large_cap_equity', price_mode: 'live' };
const stats = (o = {}) => ({ volatility_pct: 25, pct_from_52w_high: -20, return_1y: 12, ...o });

(async () => {
  console.log('── price trust ──');
  ck('price_mode falls back from price_source before migration 012',
     priceModeOf({ price_source: 'static' }) === 'static' && priceModeOf({ price_source: 'mfapi', amfi_code: '1' }) === 'daily_nav'
     && priceModeOf({ price_source: 'mfapi' }) === 'static' && priceModeOf({ price_source: 'yahoo' }) === 'live');
  ck('a price from yesterday is fresh; one from last week is not', priceIsFresh(FRESH, NOW) && !priceIsFresh(STALE, NOW));
  ck('Monday: Thursday\'s price is still within 2 trading days', priceIsFresh('2026-11-12T10:00:00Z', new Date('2026-11-16T03:00:00Z')));
  let lv = computeLevels({ action: 'BUY', entry: 100, horizonDays: 14, instrument: { category: 'bond_gsec', price_mode: 'static' }, priceAsOf: FRESH, stats: stats(), now: NOW });
  ck('static price → no levels', !lv.ok && /static/.test(lv.reason));
  lv = computeLevels({ action: 'BUY', entry: 100, horizonDays: 14, instrument: eq, priceAsOf: STALE, stats: stats(), now: NOW });
  ck('stale price → no levels, says how old', !lv.ok && /stale \(last 2026-11-06\)/.test(lv.reason));
  lv = computeLevels({ action: 'BUY', entry: 100, horizonDays: 14, instrument: eq, priceAsOf: null, stats: stats(), now: NOW });
  ck('unknown price time → no levels', !lv.ok && /unknown/.test(lv.reason));

  console.log('── volatility-based levels ──');
  lv = computeLevels({ action: 'BUY', entry: 1000, horizonDays: 14, instrument: eq, priceAsOf: FRESH, stats: stats(), now: NOW });
  // σh = 0.25 × √(14/252) = 5.89%; stop 1.5σh = 8.84%; target 2.5σh = 14.73%
  ck('equity: stop 1.5σ and target 2.5σ over the horizon', lv.ok && lv.stop === 911.61 && lv.target === 1147.31 && lv.rewardRisk === 1.67, JSON.stringify(lv));
  const lvHi = computeLevels({ action: 'BUY', entry: 1000, horizonDays: 14, instrument: eq, priceAsOf: FRESH, stats: stats({ volatility_pct: 50, pct_from_52w_high: -60 }), now: NOW });
  ck('levels scale with volatility (not fixed percentages)', lvHi.ok && lvHi.stop < lv.stop && lvHi.target > lv.target);
  lv = computeLevels({ action: 'BUY', entry: 1000, horizonDays: 14, instrument: eq, priceAsOf: FRESH, stats: stats({ pct_from_52w_high: -3 }), now: NOW });
  ck('target capped at the 52-week high; too little room → reward:risk < 1.5, refused', !lv.ok && lv.rewardRisk < 1.5 && /below 1.5/.test(lv.reason));
  lv = computeLevels({ action: 'BUY', entry: 1000, horizonDays: 14, instrument: eq, priceAsOf: FRESH, stats: stats({ pct_from_52w_high: -0.5 }), now: NOW });
  ck('at the 52-week high (breakout) the target is not capped', lv.ok && lv.rewardRisk === 1.67);
  lv = computeLevels({ action: 'BUY', entry: 1000, horizonDays: 14, instrument: eq, priceAsOf: FRESH, stats: { volatility_pct: null }, now: NOW });
  ck('no price history → no levels', !lv.ok && /no price history/.test(lv.reason));

  console.log('── yield-based levels for debt ──');
  const debt = { category: 'debt_fund', price_mode: 'daily_nav' };
  lv = computeLevels({ action: 'BUY', entry: 100, horizonDays: 14, instrument: debt, priceAsOf: FRESH, stats: { volatility_pct: 0.2, return_1y: 6.8 }, now: NOW });
  ck('liquid-like fund: accrual target vs tiny volatility → passes', lv.ok && lv.method === 'yield' && lv.target === 100.26 && lv.rewardRisk >= 1.5);
  lv = computeLevels({ action: 'BUY', entry: 100, horizonDays: 14, instrument: debt, priceAsOf: FRESH, stats: { volatility_pct: 1.5, return_1y: 7 }, now: NOW });
  ck('short-duration fund over 14 days: accrual too small for the swing → refused', !lv.ok && lv.rewardRisk < 1.5);
  ck('the old G-Sec case (+0.5% vs −3%) can no longer happen: static refused outright',
     !computeLevels({ action: 'BUY', entry: 100, horizonDays: 14, instrument: { category: 'bond_gsec', price_source: 'static' }, priceAsOf: FRESH, stats: stats(), now: NOW }).ok);

  console.log('── the scoring engine ──');
  const ie = require('../backend/services/instrumentEngine');
  const pass = { action: 'BUY', vetoed: false };
  const levers = { technical: 8, fundamental: 7, management: 7, sentiment: 7, institutional: 6, sector_timing: 6, macro_pestle: 6, competitive: 7, risk_adjusted: 7 };
  const last = () => DB.rows('recommendations')[DB.rows('recommendations').length - 1];
  const quiet = async fn => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

  await quiet(() => ie.convertScoreToRecommendation({ symbol: 'GSEC10Y', category: 'bond_gsec', price_source: 'static', price_mode: 'static' },
    80, levers, 100, pass, { priceAsOf: null, stats: null }));
  ck('a static instrument scoring 80 cannot be a BUY', last().action === 'WATCH' && last().target_price_inr == null && last().stop_loss_inr == null);
  ck('…the reason is recorded', /static/.test(last().downgrade_reason || ''));

  await quiet(() => ie.convertScoreToRecommendation({ symbol: 'TCS', category: 'large_cap_equity', price_mode: 'live' },
    80, levers, 1000, pass, { priceAsOf: new Date().toISOString(), stats: stats({ pct_from_52w_high: -3 }) }));
  ck('reward:risk below 1.5 → BUY downgraded to WATCH, no levels', last().action === 'WATCH' && last().target_price_inr == null && /reward:risk/.test(last().downgrade_reason));
  ck('…the rationale explains it in plain words', /not large enough for the risk/.test(last().rationale_text));

  // 72 = standard tier (14-day horizon); 75+ is high conviction (30 days).
  await quiet(() => ie.convertScoreToRecommendation({ symbol: 'INFY', category: 'large_cap_equity', price_mode: 'live' },
    72, levers, 1000, pass, { priceAsOf: new Date().toISOString(), stats: stats() }));
  ck('live, fresh, reward:risk ≥ 1.5 → BUY with volatility-based target and stop', last().action === 'BUY' && last().stop_loss_inr === 911.61 && last().target_price_inr === 1147.31 && last().reward_risk === 1.67);

  await quiet(() => ie.convertScoreToRecommendation({ symbol: 'ITC', category: 'large_cap_equity', price_mode: 'live' },
    80, levers, 400, pass, { priceAsOf: STALE, stats: stats() }));
  ck('stale price → WATCH even with a strong score', last().action === 'WATCH' && /stale/.test(last().downgrade_reason));

  console.log('── what reaches the client ──');
  const email = require('../backend/services/emailEngine');
  const idea = { symbol: 'XYZ', name: 'XYZ Ltd', action: 'WATCH', entry: 100, target: 120, stop: 90, levels_ok: false, horizon_days: 14 };
  let html = email.renderMorningBrief({ full_name: 'Asha' }, { ideas: [idea] }).html;
  ck('email never shows a target or stop unless the levels are trusted', !/Target ₹/.test(html) && !/Stop-loss ₹/.test(html));
  html = email.renderMorningBrief({ full_name: 'Asha' }, { ideas: [{ ...idea, action: 'BUY', levels_ok: true, reward_risk: 1.67 }] }).html;
  ck('…and shows target, stop and reward:risk when they are', /Target ₹120/.test(html) && /Stop-loss ₹90/.test(html) && /Reward:risk 1\.7/.test(html));

  // The brief itself strips levels from a signal sized on a stale price.
  DB.seed('instrument_universe', [{ id: 'i1', symbol: 'HDFCBANK', name: 'HDFC Bank', category: 'large_cap_equity', status: 'active', price_source: 'yahoo', price_mode: 'live' }]);
  DB.seed('instrument_scores', [{ instrument_id: 'i1', scored_at: new Date().toISOString(), price_data_points: 250, data_complete: true }]);
  DB.seed('recommendations', [{ instrument_name: 'HDFCBANK', client_id: null, is_active: true, risk_gate_passed: true, action: 'BUY', confidence_score: 0.8,
    entry_price_inr: 1700, target_price_inr: 1900, stop_loss_inr: 1600, reward_risk: 2, price_as_of: '2026-10-01T10:00:00Z',
    generated_at: new Date().toISOString(), horizon_days: 14, rationale_short: 'BUY' }]);
  DB.seed('clients', [{ id: 'cA', full_name: 'Asha Rao' }]);
  const engine = require('../backend/services/morningBriefEngine');
  const brief = await quiet(() => engine.buildBriefForClient({ id: 'cA', full_name: 'Asha Rao' },
    { marketSnapshot: '', marketFigures: [], news: [], educationPoint: '' }));
  const hd = brief.ideas.find(i => i.symbol === 'HDFCBANK');
  ck('a signal whose price was stale when sized shows no target or stop in the brief', hd && hd.target === null && hd.stop === null && hd.levels_ok === false);
  ck('…nor in the plain-text brief', !/target ₹1900|stop-loss ₹1600/.test(brief.full_text));
})();
