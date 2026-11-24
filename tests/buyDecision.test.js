/**
 * SA5 — the BUY decision: thresholds unchanged, the AI lever is not a gate,
 * statically-priced fixed income is never BUY, and a strong measured
 * confluence of the nine levers reaches BUY on its own.
 */
'use strict';
process.env.NODE_ENV = 'test';
const ck = require('./_check');
const L = require('../backend/services/leverEngine');
const F = require('../backend/services/fundamentalsProvider');

const d = (composite, extra = {}) => L.decideAction({ composite, insufficient_data: false, price_source: 'yahoo', ...extra }).action;

console.log('\nDecision thresholds (frozen Sep 2026)');
ck('70 → BUY, 69 → WATCH, 50 → WATCH, 49 → SELL', d(70) === 'BUY' && d(69) === 'WATCH' && d(50) === 'WATCH' && d(49) === 'SELL');
ck('thresholds not lowered', L.BUY_AT === 70 && L.WATCH_AT === 50);
ck('no own price history → WATCH even at 90', d(90, { insufficient_data: true }) === 'WATCH');

console.log('\nStatic fixed income');
for (const sym of ['GSEC10Y', 'RECBOND', 'RBIFLOAT'])
  ck(`${sym} (static price) is never BUY — even at composite 95`, L.decideAction({ composite: 95, insufficient_data: false, price_source: 'static' }).action === 'WATCH');
ck('…and never SELL either, labelled "Reference (price not live)"',
  L.decideAction({ composite: 10, insufficient_data: false, price_source: 'static' }).reason === 'Reference (price not live)'
  && L.decideAction({ composite: 10, insufficient_data: false, price_source: 'static' }).action === 'WATCH');

console.log('\nThe AI lever is not a gate');
const args = { composite: 72, insufficient_data: false, price_source: 'yahoo' };
ck('BUY with the AI lever unavailable', L.decideAction({ ...args, ai_lever: null }).action === 'BUY');
ck('same BUY when the AI lever ran (it is not an input)', L.decideAction({ ...args, ai_lever: { score: 2 } }).action === 'BUY');
ck('decideAction takes no AI argument at all', !/ai/i.test(L.decideAction.toString().split('{')[1].split('}')[0]));

console.log('\nNine levers alone can reach BUY');
// A steady uptrend with shallow pullbacks: above both averages, golden cross,
// positive 1/3/6/12-month returns, modest volatility.
const closes = [];
let p = 100;
for (let i = 0; i < 260; i++) { p *= 1 + 0.0012 + 0.004 * Math.sin(i / 3); closes.push(+p.toFixed(2)); }
const ps = F.computePriceStats(closes);
const inst = { symbol: 'UPTREND', category: 'large_cap_equity', price_source: 'yahoo' };
const macro = { gdp_latest: 7.2, cpi_latest: 4.83 };   // what production passes (no FII/DII figures)
const s = L.scoreInstrument(inst, macro, { price_stats: ps, fundamentals: null, peer_median_return_3m: 2, peer_count: 10 });
const dec = L.decideAction({ composite: s.composite, insufficient_data: s._audit.insufficient_data, price_source: 'yahoo' });
ck(`a measured strong uptrend scores ≥ 70 without the AI lever (composite ${s.composite})`, s.composite >= 70 && dec.action === 'BUY');
const flat = F.computePriceStats(Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 5)));
const s2 = L.scoreInstrument(inst, macro, { price_stats: flat, fundamentals: null, peer_median_return_3m: 2, peer_count: 10 });
ck(`a flat, going-nowhere series is not a BUY (composite ${s2.composite}) — quality not lowered`,
  L.decideAction({ composite: s2.composite, insufficient_data: false, price_source: 'yahoo' }).action !== 'BUY');
