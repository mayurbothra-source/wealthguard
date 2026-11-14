/**
 * WS4 — brief content that supports a decision.
 *   Rationale line from the strongest lever, AI label, confidence band, entry
 *   zone / target / stop / reward:risk, asset-class breadth, a concrete "why no
 *   ideas", the 90-day track record (with "building" under 10 closed), the
 *   greeting, and visibly different briefs for a Beginner and a Wealth account.
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
const quiet = async fn => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

const engine = require('../backend/services/morningBriefEngine');
const T = engine._test;
const trs = require('../backend/services/trackRecordSummary');
const email = require('../backend/services/emailEngine');
const now = new Date();
const iso = d => new Date(now.getTime() - d * 86400000).toISOString();

function seedMarket() {
  for (const t of ['instrument_universe', 'instrument_scores', 'recommendations', 'ai_instrument_flags', 'opportunities', 'client_behavioural_profiles', 'clients', 'portfolios', 'client_goals', 'recommendation_outcomes']) DB.rows(t).length = 0;
  const inst = [
    ['TCS', 'large_cap_equity', 'live'], ['ASTRAL', 'mid_cap_equity', 'live'], ['NIFTYBEES', 'index_etf', 'live'],
    ['GOLDBEES', 'gold', 'live'], ['MF-KOT-STB', 'debt_fund', 'daily_nav'], ['MF-HDFC-LQ', 'debt_fund', 'daily_nav'],
    ['GSEC10Y', 'bond_gsec', 'static'], ['INFY', 'large_cap_equity', 'live'],
  ];
  DB.seed('instrument_universe', inst.map(([sym, cat, mode], k) => ({ id: `u${k}`, symbol: sym, name: `${sym} name`, category: cat, status: 'active', price_mode: mode, price_source: mode === 'static' ? 'static' : mode === 'daily_nav' ? 'mfapi' : 'yahoo', amfi_code: mode === 'daily_nav' ? '1' : null })));
  const lev = (best) => ({ technical: 5, fundamental: 5, management: 5, sentiment: 5, institutional: 5, sector_timing: 5, macro_pestle: 5, competitive: 5, risk_adjusted: 6, [best]: 9 });
  DB.seed('instrument_scores', inst.map((_, k) => ({ instrument_id: `u${k}`, scored_at: iso(1), price_data_points: k === 7 ? 0 : 250, data_complete: k !== 7, ...lev(['technical', 'fundamental', 'sentiment', 'risk_adjusted', 'institutional', 'competitive', 'technical', 'technical'][k]) })));
  const rec = (sym, action, conf, extra = {}) => ({ instrument_name: sym, client_id: null, is_active: true, risk_gate_passed: true, action, confidence_score: conf, entry_price_inr: 100,
    target_price_inr: action === 'BUY' ? 115 : null, stop_loss_inr: action === 'BUY' ? 91 : null, reward_risk: action === 'BUY' ? 1.67 : null,
    price_as_of: iso(1), generated_at: iso(1), horizon_days: 14, rationale_short: action, ...extra });
  DB.seed('recommendations', [
    rec('MF-KOT-STB', 'BUY', 0.90), rec('MF-HDFC-LQ', 'BUY', 0.89),         // two debt funds score highest…
    rec('TCS', 'BUY', 0.75), rec('NIFTYBEES', 'BUY', 0.74), rec('GOLDBEES', 'BUY', 0.72), rec('ASTRAL', 'BUY', 0.80),
  ]);
  DB.seed('ai_instrument_flags', [{ instrument_id: 'u0', horizon_label: 'Mid-Term', is_active: true }]);
  DB.seed('opportunities', [{ symbol: 'ITBEES', instrument_name: 'IT BeES', headline: 'IT is gaining ground on the wider market', detail: 'Sector rotation into IT over four weeks.', min_tier: 'builder', is_active: true, generated_at: iso(0) }]);
}

(async () => {
  console.log('── idea details ──');
  ck('confidence band from the risk-adjusted lever', T.confidenceBand(8) === 'High' && T.confidenceBand(5.5) === 'Medium' && T.confidenceBand(3) === 'Low');
  ck('rationale line comes from the strongest lever, in plain words', /^Why now: the underlying business fundamentals are solid\.$/.test(T.whyLine({ technical: 5, fundamental: 9, risk_adjusted: 6 })));

  seedMarket();
  let r = await quiet(() => T.buildIdeas(6, [], now));                    // moderate profile
  const syms = r.ideas.map(i => i.symbol);
  ck('breadth: the two top-scoring debt funds do not crowd out other classes', new Set(r.ideas.map(i => i.asset_class)).size === 3, JSON.stringify(syms));
  ck('every idea has a rationale line', r.ideas.every(i => /^Why now: /.test(i.why || '')));
  const tcs = (await quiet(() => T.buildIdeas(3, [], now))).ideas.find(i => i.symbol === 'TCS');
  ck('AI lever contribution shows the client-safe label only', tcs?.ai_label === '🤖 AI Influenced — Mid-Term');
  ck('entry zone, target, stop, reward:risk and horizon on a qualifying BUY', tcs.entry_zone === '₹99.00–₹101.00' && tcs.target === 115 && tcs.stop === 91 && tcs.reward_risk === 1.67 && tcs.horizon_days === 14);
  const fund = r.ideas.find(i => i.asset_class === 'debt');
  ck('a fund\'s entry zone is the day\'s NAV', fund?.entry_zone === "at the day's NAV");

  console.log('── profile filtering ──');
  const low = (await quiet(() => T.buildIdeas(2, [], now))).ideas.map(i => i.symbol);
  const high = (await quiet(() => T.buildIdeas(9, [], now))).ideas.map(i => i.symbol);
  ck('low risk never sees mid-cap; high risk can', !low.includes('ASTRAL') && high.includes('ASTRAL'));

  console.log('── why no ideas ──');
  DB.rows('recommendations').forEach(x => { x.action = 'WATCH'; x.target_price_inr = null; x.stop_loss_inr = null; });
  DB.rows('recommendations')[0].downgrade_reason = 'reward:risk 0.40 is below 1.5';
  DB.rows('recommendations')[1].downgrade_reason = 'reward:risk 0.90 is below 1.5';
  DB.rows('recommendations')[2].downgrade_reason = 'reward:risk 1.10 is below 1.5';
  r = await quiet(() => T.buildIdeas(6, [], now));
  ck('no BUY: a concrete count-based reason, client-safe', r.no_ideas && r.no_ideas.passed === 0 && /instruments screened for your profile, 0 passed/.test(r.no_ideas.text) && /Main reason: possible gain too small for the risk \(3\)/.test(r.no_ideas.text), r.no_ideas?.text);
  ck('…static and unmeasured instruments are counted, not hidden', r.no_ideas.blockers['price not live or not recent'] >= 1 && r.no_ideas.blockers['not enough price history to measure'] >= 1);
  ck('…and no scores or probabilities leak into it', !/\d+\/100|0\.\d{2}|%/.test(r.no_ideas.text));

  console.log('── track record ──');
  const mk = (id, action, entry, target, stop, daysAgo, horizon = 14) => ({ id, action, entry_price_inr: entry, target_price_inr: target, stop_loss_inr: stop, generated_at: iso(daysAgo), horizon_days: horizon });
  const recs = [mk('a', 'BUY', 100, 110, 95, 40), mk('b', 'BUY', 100, 110, 95, 40), mk('c', 'SELL', 100, 90, 105, 40), mk('d', 'BUY', 100, 110, 95, 3)];
  const outs = { a: [{ actual_price_inr: 111, measured_at: iso(30) }], b: [{ actual_price_inr: 94, measured_at: iso(33) }], c: [{ actual_price_inr: 97, measured_at: iso(10) }] };
  let sm = trs.summarise(recs, outs, now);
  ck('hit target, hit stop, closed at horizon, open are counted', sm.hit_target === 1 && sm.hit_stop === 1 && sm.expired === 1 && sm.open === 1);
  ck('fewer than 10 closed: "Track record building (N closed so far)", no percentage', sm.building && /^Track record building \(3 closed so far\)/.test(sm.text) && !/Average result/.test(sm.text));
  ck('misses (stop-loss hits) are shown', /1 hit stop-loss/.test(sm.text));
  const many = Array.from({ length: 12 }, (_, k) => mk(`m${k}`, 'BUY', 100, 110, 95, 40));
  const manyOuts = Object.fromEntries(many.map((m, k) => [m.id, [{ actual_price_inr: k < 8 ? 111 : 94, measured_at: iso(30) }]]));
  sm = trs.summarise(many, manyOuts, now);
  ck('10+ closed: average result shown, misses counted alongside wins', !sm.building && sm.hit_target === 8 && sm.hit_stop === 4 && /Average result on closed calls: \+5\.33%/.test(sm.text) && /Misses are counted/.test(sm.text), sm.text);
  ck('a good SELL counts as a gain', trs.classify(mk('s', 'SELL', 100, 90, 105, 40), [{ actual_price_inr: 89, measured_at: iso(30) }], now).result === 11);

  console.log('── greeting ──');
  ck('first name when known', /Good morning, Asha</.test(email.renderMorningBrief({ full_name: 'Asha Rao' }, {}).html));
  ck('"Hello" when there is no name', /<h2[^>]*>Hello<\/h2>/.test(email.renderMorningBrief({ full_name: '' }, {}).html));

  console.log('── Beginner vs Wealth demo accounts ──');
  seedMarket();
  DB.seed('clients', [
    { id: 'beg', full_name: 'Demo Beginner 1', subscription_plan: 'starter', subscription_status: 'active' },
    { id: 'wb', full_name: 'Demo Wealth Builder 1', subscription_plan: 'wealth_builder', subscription_status: 'active' },
  ]);
  DB.seed('client_behavioural_profiles', [{ client_id: 'beg', stated_risk_score: 2, assessed_at: iso(5) }, { client_id: 'wb', stated_risk_score: 8, assessed_at: iso(5) }]);
  const shared = { marketSnapshot: 'Calm.', marketFigures: [], news: [], educationPoint: 'x', trackRecord: trs.summarise(recs, outs, now) };
  const bBeg = await quiet(() => engine.buildBriefForClient({ id: 'beg', full_name: 'Demo Beginner 1', subscription_plan: 'starter', subscription_status: 'active' }, shared));
  const bWb = await quiet(() => engine.buildBriefForClient({ id: 'wb', full_name: 'Demo Wealth Builder 1', subscription_plan: 'wealth_builder', subscription_status: 'active' }, shared));
  const begSyms = bBeg.ideas.map(i => i.symbol), wbSyms = bWb.ideas.map(i => i.symbol);
  ck('Beginner (low risk) and Wealth (high risk) get different ideas', JSON.stringify(begSyms) !== JSON.stringify(wbSyms), `${begSyms} vs ${wbSyms}`);
  ck('…the Beginner sees no mid-cap; the Wealth account can', !begSyms.includes('ASTRAL') && wbSyms.includes('ASTRAL'));
  ck('…only Builder+ tiers get Opportunities (min_tier from code)', bBeg.opportunities.length === 0 && bWb.opportunities.length === 1);
  ck('…every idea in both briefs has a rationale line', [...bBeg.ideas, ...bWb.ideas].every(i => /^Why now: /.test(i.why || '')));
  ck('…both show the track record block', /Track record building/.test(bBeg.full_text) && /Track record building/.test(bWb.full_text));
  const hBeg = email.renderMorningBrief({ full_name: 'Demo Beginner 1' }, bBeg).html, hWb = email.renderMorningBrief({ full_name: 'Demo Wealth Builder 1' }, bWb).html;
  ck('…and the emails differ visibly', /Opportunities/.test(hWb) && !/Opportunities/.test(hBeg) && /Our track record/.test(hBeg));
  ck('…every email keeps the not-advice disclaimer', [hBeg, hWb].every(h => /do not constitute financial advice/i.test(h)));
  ck('…and never shows admin-only detail (scores, probabilities, source links)', [hBeg, hWb].every(h => !/\/100|P\(30d\)|probability|https?:\/\/(?!.*wealthguard)/i.test(h.replace(/<a [^>]*>/g, ''))));
  require('fs').writeFileSync(require('path').join(process.env.PREVIEW_DIR || require('os').tmpdir(), 'ws4-preview.txt'),
    `=== Demo Beginner 1 (starter, risk 2) ===\n${bBeg.full_text}\n\n=== Demo Wealth Builder 1 (wealth_builder, risk 8) ===\n${bWb.full_text}\n`);
})();
