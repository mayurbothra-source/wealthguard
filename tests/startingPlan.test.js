/**
 * Starting plan for clients with no holdings: mixes, monthly amounts and the
 * instruments named. Uses TEST One's real profile and goals as the example.
 */
'use strict';
const P = require('../backend/services/startingPlan');
let pass = 0, fail = 0;
const ck = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); };

const now = new Date('2026-11-12T00:00:00Z');
const fund = (symbol, name, category, extra = {}) => ({ symbol, name, category, instrument_type: 'mutual_fund', measured: true, action: 'WATCH', confidence: 0.6, ...extra });
const etf = (symbol, name, category, extra = {}) => ({ symbol, name, category, instrument_type: 'etf', measured: false, action: 'WATCH', confidence: 0.6, ...extra });
const stock = (symbol, category, extra = {}) => ({ symbol, name: symbol, category, instrument_type: 'equity', measured: true, action: 'BUY', confidence: 0.8, ...extra });
const pool = [
  fund('MF-HDFC-LQ', 'HDFC Liquid Fund', 'debt_fund', { confidence: 0.62 }),
  fund('MF-ABL-SV', 'Aditya Birla SL Savings Fund', 'debt_fund', { confidence: 0.66 }),
  fund('MF-KOT-STB', 'Kotak Bond Short Term', 'debt_fund', { confidence: 0.68 }),
  fund('MF-IDFC-STB', 'IDFC Bond Fund Short Term', 'debt_fund', { confidence: 0.67 }),
  fund('MF-MIRAE-LC', 'Mirae Asset Large Cap Fund', 'large_cap_fund', { confidence: 0.63 }),
  fund('MF-SBI-BC', 'SBI Bluechip Fund', 'large_cap_fund', { confidence: 0.61 }),
  fund('MF-AXIS-BC', 'Axis Bluechip', 'large_cap_fund', { action: 'SELL', confidence: 0.9 }),
  fund('MF-UNMEASURED', 'Never measured fund', 'large_cap_fund', { measured: false, confidence: 0.95 }),
  fund('MF-NIP-MC', 'Nippon Growth Fund', 'flexi_mid_fund'),
  etf('NIFTYBEES', 'Nippon Nifty BeES', 'index_etf'), etf('JUNIORBEES', 'Nippon Junior BeES', 'index_etf'),
  etf('BANKBEES', 'Nippon Bank BeES', 'index_etf'),
  etf('GOLDBEES', 'Nippon Gold BeES', 'gold'), etf('SBIGOLD', 'SBI Gold ETF', 'gold'),
  stock('TCS', 'large_cap_equity'), stock('INFY', 'large_cap_equity', { measured: false }),
  stock('RELIANCE', 'large_cap_equity', { action: 'WATCH' }), stock('PERSISTENT', 'mid_cap_equity'),
];
const goals = [
  { goal_name: 'Retirement', target_amount_inr: 100000000, current_corpus_inr: 0, target_date: '2047-03-31' },
  { goal_name: "Child's Education", target_amount_inr: 3000000, current_corpus_inr: 0, target_date: '2035-03-31' },
  { goal_name: 'Emergency Fund', target_amount_inr: 300000, current_corpus_inr: 0, target_date: '2030-03-31' },
];

console.log('── caps and mixes ──');
ck('equity caps follow NPS lifecycle funds (25 / 50 / 75)', P.equityCap(2) === 25 && P.equityCap(6) === 50 && P.equityCap(9) === 75);
ck('a past panic-sell lowers the cap by 10', P.equityCap(6, true) === 40);
ck('under 3 years: no equity', P.mixFor(2.5, 75).equity === 0 && P.mixFor(2.5, 75).debt === 100);
ck('3–5 years: equity at most 25%', P.mixFor(4, 75).equity === 25);
ck('5–7 years: equity at most 50%', P.mixFor(6, 75).equity === 50 && P.mixFor(6, 25).equity === 25);
ck('over 7 years: the risk cap', P.mixFor(20, 50).equity === 50 && P.mixFor(20, 50).gold === 10);
ck('every mix adds up to 100', [1, 4, 6, 10, null].every(y => { const m = P.mixFor(y, 50); return m.equity + m.debt + m.gold === 100; }));
ck('monthly amount: ₹1 L in 12 months at 0% is ₹8,333', Math.round(P.monthlyNeeded(100000, 0, 12, 0)) === 8333);
ck('already enough saved → nothing more needed', P.monthlyNeeded(100000, 200000, 12, 6) === 0);

console.log('── TEST One (risk 6, three goals, no holdings) ──');
const plan = P.buildStartingPlan({ riskScore: 6, panicHistory: false, goals, pool, now });
const [ef, edu, ret] = plan.goals;
ck('moderate band, equity cap 50%', plan.risk_band === 'moderate' && plan.equity_cap_pct === 50);
ck('emergency fund comes first, then nearest goal', ef.goal === 'Emergency Fund' && edu.goal === "Child's Education" && ret.goal === 'Retirement');
ck('emergency fund is 100% liquid / ultra-short debt', ef.sleeves.length === 1 && ef.sleeves[0].sleeve === 'liquid' && ef.sleeves[0].pct === 100);
ck('…named with liquid-type funds', ef.sleeves[0].instruments.every(i => /Liquid|Savings/.test(i.name)));
ck('education (8.4 yrs) and retirement (20 yrs) use the 50% cap', edu.mix.equity === 50 && ret.mix.equity === 50);
ck('sleeves add up to 100% for every goal', plan.goals.every(g => g.sleeves.reduce((s, x) => s + x.pct, 0) === 100));
ck('monthly amounts are in a sensible range', ef.monthly_needed > 6000 && ef.monthly_needed < 7000 && edu.monthly_needed > 19000 && edu.monthly_needed < 22000 && ret.monthly_needed > 140000 && ret.monthly_needed < 170000);
const named = plan.goals.flatMap(g => g.sleeves.flatMap(s => s.instruments.map(i => i.symbol)));
ck('a fund on SELL is never named', !named.includes('MF-AXIS-BC'));
ck('an unmeasured active fund is never named', !named.includes('MF-UNMEASURED'));
ck('a measured stock on BUY that fits the profile can be named', named.includes('TCS') && named.includes('PERSISTENT'));
ck('a stock not measured, or not on BUY, is not named', !named.includes('INFY') && !named.includes('RELIANCE'));
ck('a broad index ETF stands in for the market; sector ETFs are not used', named.includes('NIFTYBEES') && !named.includes('BANKBEES'));
ck('gold is held through a gold ETF', edu.sleeves.find(s => s.sleeve === 'gold')?.instruments[0]?.symbol === 'GOLDBEES');
const text = P.planToText(plan);
ck('the text version lists each goal with its monthly amount', /1\. Emergency Fund .*about ₹[\d,]+\/month/.test(text) && /3\. Retirement .*\/month/.test(text));
ck('…and states the assumptions', /equity 10%, debt 6.5%, gold 8%/.test(text));

console.log('── other profiles ──');
const low = P.buildStartingPlan({ riskScore: 2, panicHistory: false, goals: [goals[0]], pool, now });
ck('low risk: no mid-cap stocks or funds', !low.goals[0].sleeves.some(s => s.sleeve === 'flexiMid' || s.sleeve === 'small'));
const high = P.buildStartingPlan({ riskScore: 9, panicHistory: false, goals: [goals[0]], pool, now });
ck('high risk with no small-cap candidates: that share folds into large-cap', !high.goals[0].sleeves.some(s => s.sleeve === 'small') && high.goals[0].sleeves.reduce((s, x) => s + x.pct, 0) === 100);
const none = P.buildStartingPlan({ riskScore: 5, panicHistory: false, goals: [], pool, now });
ck('no goals: one long-term plan from the risk profile', none.goals.length === 1 && none.goals[0].monthly_needed === null);
ck('no emergency goal: the plan suggests building one', !none.has_emergency_goal && /emergency fund of 3–6 months/.test(P.planToText(none)));

console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
