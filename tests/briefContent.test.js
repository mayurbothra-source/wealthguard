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
  DB.seed('ai_instrument_flags', [{ instrument_id: 'u0', horizon_label: 'Mid-Term', is_active: true, ai_lever_score: 6 },
    // a flag with no AI score (the AI call did not complete) must not earn the label
    { instrument_id: 'u1', horizon_label: 'Mid-Term', is_active: true, ai_lever_score: null }]);
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
  const astral = (await quiet(() => T.buildIdeas(9, [], now))).ideas.find(i => i.symbol === 'ASTRAL');
  ck('no AI label where the AI lever did not actually run (flag without an AI score)', astral && !astral.ai_label);
  ck('entry zone, target, stop, reward:risk and horizon on a qualifying BUY', tcs.entry_zone === '₹99.00–₹101.00' && tcs.target === 115 && tcs.stop === 91 && tcs.reward_risk === 1.67 && tcs.horizon_days === 14);
  const fund = r.ideas.find(i => i.asset_class === 'debt');
  ck('a fund\'s entry zone is the day\'s NAV', fund?.entry_zone === "at the day's NAV");

  console.log('── profile filtering ──');
  const low = (await quiet(() => T.buildIdeas(2, [], now))).ideas.map(i => i.symbol);
  const high = (await quiet(() => T.buildIdeas(9, [], now))).ideas.map(i => i.symbol);
  ck('low risk never sees mid-cap; high risk can', !low.includes('ASTRAL') && high.includes('ASTRAL'));

  console.log('── SELL calls are shown (FIX-7) ──');
  seedMarket();
  // ASTRAL: measured, fresh price, newest signal SELL → shown. TCS SELL with a price that stopped updating → not shown.
  // INFY: SELL but never measured on real prices → not shown.
  DB.rows('recommendations').push(
    { instrument_name: 'ASTRAL', client_id: null, is_active: true, risk_gate_passed: true, action: 'SELL', confidence_score: 0.42, entry_price_inr: 1500,
      price_as_of: iso(0.5), generated_at: iso(0.5), horizon_days: 14, rationale_short: 'SELL — 42/100 confidence score' },
    { instrument_name: 'INFY', client_id: null, is_active: true, risk_gate_passed: true, action: 'SELL', confidence_score: 0.40, entry_price_inr: 1500,
      price_as_of: iso(0.5), generated_at: iso(0.5), horizon_days: 14 });
  DB.rows('recommendations').filter(x => x.instrument_name === 'TCS').forEach(x => { x.action = 'SELL'; x.price_as_of = '2018-06-01T10:00:00Z'; });
  let sr = await quiet(() => T.buildIdeas(6, [], now));
  ck('a fresh SELL on an instrument the client does not hold is shown, framed "Consider avoiding or exiting"',
     sr.cautions.length === 1 && sr.cautions[0].symbol === 'ASTRAL' && sr.cautions[0].label === 'Consider avoiding or exiting', JSON.stringify(sr.cautions));
  ck('…with a plain reason line and no score (no "/100")', /^Why: /.test(sr.cautions[0].why || '') && !/\/100|0\.42/.test(JSON.stringify(sr.cautions)));
  ck('a SELL whose price feed stopped updating is not shown (we cannot stand behind it)', !sr.cautions.some(c => c.symbol === 'TCS'));
  ck('a SELL on an instrument never measured on real prices is not shown', !sr.cautions.some(c => c.symbol === 'INFY'));
  sr = await quiet(() => T.buildIdeas(6, ['ASTRAL'], now));
  ck('a SELL on a holding is left to Your Portfolio (EXIT/REVIEW), not repeated here', !sr.cautions.some(c => c.symbol === 'ASTRAL'));
  const cHtml = email.renderMorningBrief({ full_name: 'Asha' }, { cautions: [{ symbol: 'INFY', name: 'Infosys', action: 'SELL', label: 'Consider avoiding or exiting', why: 'Why: the price trend is weak.' }] }).html;
  ck('the email shows the "Consider avoiding or exiting" section', /Consider avoiding or exiting/.test(cHtml) && /INFY/.test(cHtml));

  console.log('── why no ideas ──');
  DB.rows('recommendations').forEach(x => { x.action = 'WATCH'; x.target_price_inr = null; x.stop_loss_inr = null; });
  DB.rows('recommendations')[0].downgrade_reason = 'reward:risk 0.40 is below 1.5';
  DB.rows('recommendations')[1].downgrade_reason = 'reward:risk 0.90 is below 1.5';
  DB.rows('recommendations')[2].downgrade_reason = 'reward:risk 1.10 is below 1.5';
  r = await quiet(() => T.buildIdeas(6, [], now));
  ck('no BUY: a concrete count-based reason, client-safe', r.no_ideas && r.no_ideas.passed === 0 && /instruments screened for your profile, 0 passed/.test(r.no_ideas.text) && /Main reason: possible gain too small for the risk \(3\)/.test(r.no_ideas.text), r.no_ideas?.text);
  ck('…static and unmeasured instruments are counted, not hidden', r.no_ideas.blockers['price not live or not recent'] >= 1 && r.no_ideas.blockers['not enough price history to measure'] >= 1);
  ck('…and no scores or probabilities leak into it', !/\d+\/100|0\.\d{2}|%/.test(r.no_ideas.text));

  console.log('── track record (SA6) ──');
  const mk = (id, action, entry, target, stop, daysAgo, sym = id) => ({ id, instrument_name: sym, action, entry_price_inr: entry, target_price_inr: target, stop_loss_inr: stop, generated_at: iso(daysAgo), horizon_days: 14 });
  const oc = (label, ok, price, ret, nifty, extra = {}) => ({ checkpoint_label: label, direction_correct: ok, actual_price_inr: price, price_at_checkpoint: price,
    [label === 'Weekly' ? 'return_1w_pct' : 'return_14d_pct']: ret, nifty_return_same_period: nifty, checkpoint_date: label === 'Weekly' ? '2026-10-08' : '2026-10-15', ...extra });
  const recs = [mk('a', 'BUY', 100, 110, 95, 40), mk('b', 'BUY', 100, 110, 95, 40), mk('c', 'SELL', 100, 90, 105, 40), mk('d', 'BUY', 100, 110, 95, 3),
                mk('e', 'SELL', 100, 90, 105, 40), mk('a2', 'BUY', 100, 110, 95, 40, 'a')];   // a2: same call, same day, second run
  const outs = { a: [oc('14-Day', true, 111, 11, 3)], b: [oc('14-Day', false, 94, -6, 3)], c: [oc('14-Day', false, 103, 3, 3)],
                 e: [oc('14-Day', null, 100, 0, 3, { outcome_status: 'price_suspect' })], a2: [oc('14-Day', true, 111, 11, 3)] };
  let sm = trs.summarise(recs, outs, now);
  ck('same call twice on one day counts once', sm.issued === 5);
  ck('closed = real verdicts at 14-Day; suspect price not counted as a win', sm.closed === 3 && sm.correct === 1 && sm.wrong === 2 && sm.not_measurable === 1 && sm.open === 1);
  ck('hit target / hit stop from the checkpoint price', sm.hit_target === 1 && sm.hit_stop === 1);
  ck('fewer than 10 closed: "📊 Track record building (N signals closed so far)", no percentage',
     sm.building && /^📊 Track record building \(3 signals closed so far\)/.test(sm.text) && !/%/.test(sm.text), sm.text);
  ck('disclaimer with the methodology link', /^Past signals are not guarantees\. See full methodology at https?:\/\/\S+\/methodology\.html$/.test(sm.disclaimer));

  // ≥10 closed, underperforming the Nifty
  const many = Array.from({ length: 12 }, (_, k) => mk(`m${k}`, k < 10 ? 'BUY' : 'SELL', 100, k < 10 ? 110 : 90, k < 10 ? 95 : 105, 30 + k));
  const manyOuts = Object.fromEntries(many.map((m, k) => [m.id, [k < 3 ? oc('14-Day', true, 111, 11, 6) : k < 10 ? oc('14-Day', false, 94, -6, 6) : oc('14-Day', false, 106, 6, 6)]]));
  sm = trs.summarise(many, manyOuts, now);
  ck('10+ closed: the full line, misses alongside wins', !sm.building && /^📊 Last 90 days: 12 signals issued, 3 hit target, 9 hit stop, 0 closed .* without either, 0 open\./.test(sm.text), sm.text);
  ck('…avg return (a SELL that rose counts as a loss) and Nifty same period', sm.avg_return_pct === -1.75 && /Avg return: −1\.75%\. Nifty same period: \+6\.00%\./.test(sm.text), sm.text);
  ck('…underperformance stated, not hidden', /7\.75 points behind the Nifty/.test(sm.text));
  ck('…right-direction count shown', /Right direction 3 of 12/.test(sm.text));

  // fallback to Weekly while 14-Day is thin
  const wk = Array.from({ length: 4 }, (_, k) => mk(`w${k}`, 'BUY', 100, 110, 95, 20));
  sm = trs.summarise(wk, Object.fromEntries(wk.map(m => [m.id, [oc('Weekly', true, 102, 2, 1)]])), now);
  ck('falls back to Weekly when 14-Day data is insufficient', sm.checkpoint === 'Weekly' && sm.closed === 4);
  ck('a good SELL counts as a gain', trs.summarise([mk('s', 'SELL', 100, 90, 105, 40)], { s: [oc('14-Day', true, 89, -11, 2)] }, now).avg_return_pct === 11);

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
  ck('…placed after the market snapshot and before the ideas (text)', bBeg.full_text.indexOf('MARKET SNAPSHOT') < bBeg.full_text.indexOf('OUR TRACK RECORD') && bBeg.full_text.indexOf('OUR TRACK RECORD') < bBeg.full_text.indexOf('IDEAS WORTH A LOOK'));
  const hBeg = email.renderMorningBrief({ full_name: 'Demo Beginner 1' }, bBeg).html, hWb = email.renderMorningBrief({ full_name: 'Demo Wealth Builder 1' }, bWb).html;
  ck('…placed after the market snapshot and before the ideas (email), with the disclaimer',
     hBeg.indexOf('Our track record') < hBeg.indexOf('Ideas worth a look') && /Past signals are not guarantees/.test(hBeg) && /methodology\.html/.test(hBeg));
  ck('…and the emails differ visibly', /Opportunities/.test(hWb) && !/Opportunities/.test(hBeg) && /Our track record/.test(hBeg));
  ck('…every email keeps the not-advice disclaimer', [hBeg, hWb].every(h => /do not constitute financial advice/i.test(h)));
  ck('…and never shows admin-only detail (scores, probabilities, source links)', [hBeg, hWb].every(h => !/\/100|P\(30d\)|probability|https?:\/\/(?!.*wealthguard)/i.test(h.replace(/<a [^>]*>/g, ''))));
  require('fs').writeFileSync(require('path').join(process.env.PREVIEW_DIR || require('os').tmpdir(), 'ws4-preview.txt'),
    `=== Demo Beginner 1 (starter, risk 2) ===\n${bBeg.full_text}\n\n=== Demo Wealth Builder 1 (wealth_builder, risk 8) ===\n${bWb.full_text}\n`);
})();
