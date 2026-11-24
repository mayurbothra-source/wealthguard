/**
 * WS5 — portfolio and alert loop, end to end.
 *   HOLD / REVIEW / EXIT per holding, stop-loss breach and CRITICAL AI alerts
 *   emailed once per event per client (alert_deliveries), demo holdings alert the
 *   admin, flash alerts deduplicated, the brief's portfolio section, the admin
 *   test endpoint, and the starting plan for an account with no holdings.
 */
'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_TRIGGER_KEY = 'admin-key-admin-key';
delete process.env.DEMO_ALERTS_TO_CLIENTS;

const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const DB = require('./_fakeDb')();
const PRICES = {};
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r.endsWith('services/marketData') || r === './marketData')
    return { refreshAllMarketData: async () => ({}), getNSEQuote: async () => null,
             getYahooQuote: async (t) => { const s = t.replace('.NS', ''); return PRICES[s] != null ? { price: PRICES[s], change_pct: 1.0, source: 'yahoo_live', as_of: new Date().toISOString() } : null; },
             getMFNav: async () => null, getMacroIndicators: async () => ({}), getIndiaVIX: async () => 15, classifyVIXRegime: () => ({}) };
  if (r === './healthEngine' || r.endsWith('services/healthEngine')) return { reportRun: async () => ({}) };
  return orig(r, p, i);
};
const quiet = async fn => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

// The alert_deliveries unique key, like migration 013.
const realFrom = DB.from;
DB.from = (t) => {
  const b = realFrom(t);
  if (t !== 'alert_deliveries') return b;
  const ins = b.insert;
  b.insert = (row) => {
    if (DB.rows('alert_deliveries').some(x => x.client_id === row.client_id && x.event_key === row.event_key)) {
      const dup = { select: () => dup, maybeSingle: () => dup, then: (res) => res({ data: null, error: { code: '23505', message: 'duplicate' } }) };
      return dup;
    }
    return ins(row);
  };
  return b;
};

const email = require('../backend/services/emailEngine');
const sent = [];
email.sendHoldingAlert = async (c, ev) => { sent.push({ to: c.email, key: ev.key, title: ev.title }); return { ok: true, id: `m${sent.length}` }; };
email.sendAdminAlert = async (subject) => { sent.push({ to: 'ADMIN', subject }); return true; };
const H = require('../backend/services/holdingAlerts');

function seed() {
  for (const t of ['clients', 'portfolios', 'instrument_universe', 'recommendations', 'ai_instrument_flags', 'alert_deliveries', 'client_notifications', 'client_behavioural_profiles', 'client_goals', 'instrument_scores']) DB.rows(t).length = 0;
  sent.length = 0;
  DB.seed('clients', [
    { id: 'c1', full_name: 'Asha Rao', email: 'a@x.in', subscription_status: 'active', email_alerts_enabled: true },
    { id: 'd1', full_name: 'Demo Builder 1', email: 'demo@gmail.com', subscription_status: 'active' },
  ]);
  DB.seed('instrument_universe', [
    { id: 'i1', symbol: 'TCS', name: 'Tata Consultancy', category: 'large_cap_equity', status: 'active', price_source: 'yahoo', yahoo_ticker: 'TCS.NS' },
    { id: 'i2', symbol: 'ITC', name: 'ITC Ltd', category: 'large_cap_equity', status: 'active', price_source: 'yahoo', yahoo_ticker: 'ITC.NS' },
    { id: 'i3', symbol: 'INFY', name: 'Infosys', category: 'large_cap_equity', status: 'active', price_source: 'yahoo', yahoo_ticker: 'INFY.NS' },
  ]);
  DB.seed('portfolios', [
    { id: 'h1', client_id: 'c1', instrument_name: 'TCS', quantity: 10, avg_buy_price_inr: 2500, stop_loss_price: 2400, is_active: true },
    { id: 'h2', client_id: 'c1', instrument_name: 'ITC', quantity: 100, avg_buy_price_inr: 250, is_active: true },
    { id: 'h3', client_id: 'd1', instrument_name: 'INFY', quantity: 12, avg_buy_price_inr: 1200, stop_loss_price: 1140, is_active: true, entry_source: 'demo_seed' },
  ]);
  DB.seed('recommendations', [{ instrument_name: 'ITC', client_id: null, is_active: true, action: 'SELL', generated_at: new Date().toISOString() }]);
  Object.assign(PRICES, { TCS: 2440, ITC: 290, INFY: 1150 });
}

(async () => {
  console.log('── status per holding ──');
  ck('price at/below stop → EXIT', H.holdingStatus({ price: 99, stop: 100 }).status === 'EXIT');
  ck('within 3% of stop → REVIEW', H.holdingStatus({ price: 102, stop: 100 }).status === 'REVIEW');
  ck('our signal is SELL → REVIEW', H.holdingStatus({ price: 150, stop: 100, signalAction: 'SELL' }).status === 'REVIEW');
  ck('CRITICAL AI flag → REVIEW', H.holdingStatus({ price: 150, stop: 100, aiCritical: true }).status === 'REVIEW');
  ck('otherwise HOLD', H.holdingStatus({ price: 150, stop: 100, signalAction: 'BUY' }).status === 'HOLD');

  console.log('── stop-loss breach alert ──');
  seed();
  let r = await quiet(() => H.runHoldingAlertScan({ clientId: 'c1', priceOverride: { TCS: 2390 } }));
  ck('price through the stop → one stop-loss event', r.events.length === 1 && r.events[0].type === 'stop_loss' && r.events[0].key === 'stop:h1:2400');
  ck('…emailed to the right client', sent.length === 1 && sent[0].to === 'a@x.in' && /Stop-loss reached: Tata Consultancy/.test(sent[0].title));
  ck('…logged in alert_deliveries with the message id', DB.rows('alert_deliveries')[0]?.status === 'sent' && DB.rows('alert_deliveries')[0].provider_message_id === 'm1');
  ck('…and shown in-app', DB.rows('client_notifications').some(n => n.client_id === 'c1' && n.type === 'stop_loss'));
  r = await quiet(() => H.runHoldingAlertScan({ clientId: 'c1', priceOverride: { TCS: 2380 } }));
  ck('the next hourly scan: same event, no second email (one per event per client)', sent.length === 1 && r.deliveries[0].deduped === true);

  console.log('── CRITICAL AI override ──');
  DB.seed('ai_instrument_flags', [{ id: 'f9', instrument_id: 'i2', risk_level: 'CRITICAL', is_active: true }]);
  r = await quiet(() => H.runHoldingAlertScan({ clientId: 'c1', priceOverride: { TCS: 2380 } }));
  ck('a CRITICAL flag on a held instrument → shown in-app, NOT emailed', sent.filter(x => x.key === 'ai:f9').length === 0
     && DB.rows('client_notifications').filter(n => n.type === 'ai_critical').length === 1
     && DB.rows('alert_deliveries').find(x => x.event_key === 'ai:f9')?.status === 'in_app');
  await quiet(() => H.runHoldingAlertScan({ clientId: 'c1', priceOverride: { TCS: 2380 } }));
  ck('…and not repeated next hour', DB.rows('client_notifications').filter(n => n.type === 'ai_critical').length === 1);

  console.log('── demo holdings never email the demo account ──');
  r = await quiet(() => H.runHoldingAlertScan({ clientId: 'd1', priceOverride: { INFY: 1130 } }));
  ck('demo-seeded holding breach → admin address, not demo@gmail.com', sent.some(x => x.to === 'ADMIN' && /DEMO alert for Demo Builder 1/.test(x.subject)) && !sent.some(x => x.to === 'demo@gmail.com'));

  console.log('── without migration 013 ──');
  seed(); DB.missingTables.add('alert_deliveries');
  r = await quiet(() => H.runHoldingAlertScan({ clientId: 'c1', priceOverride: { TCS: 2390 } }));
  ck('no alert_deliveries table → nothing emailed (cannot guarantee once-only)', sent.length === 0 && /missing/.test(r.deliveries[0].error));
  DB.missingTables.clear();

  console.log('── flash alerts are deduplicated too ──');
  seed();
  const flash = require('../backend/services/flashAlertEngine')._test.notifyClientsForAlert;
  const fallKey = `fall:TCS:${require('../backend/lib/istTime').istDate()}`;
  await quiet(() => flash({ id: 'fa1', move_pct: -3.4, context_note: 'Stock-specific move.' }, { id: 'i1', symbol: 'TCS', name: 'Tata Consultancy' }));
  await quiet(() => flash({ id: 'fa2', move_pct: -3.9, context_note: 'Stock-specific move.' }, { id: 'i1', symbol: 'TCS', name: 'Tata Consultancy' }));
  ck('a holding falling 3%+ → its holder is emailed once that day (a second hourly fall adds no email)',
     sent.filter(x => x.key === fallKey).length === 1 && /fell 3\.4% in the last hour/.test(sent.find(x => x.key === fallKey).title));
  const before = sent.length;
  await quiet(() => flash({ id: 'fa3', move_pct: 3.6, context_note: 'Stock-specific move.' }, { id: 'i2', symbol: 'ITC', name: 'ITC Ltd' }));
  ck('a sharp RISE is not emailed (in-app only)', sent.length === before && DB.rows('client_notifications').some(n => n.alert_id === 'fa3'));

  console.log('── the brief\'s portfolio section ──');
  seed();
  const engine = require('../backend/services/morningBriefEngine');
  const b = await quiet(() => engine.buildBriefForClient({ id: 'c1', full_name: 'Asha Rao' }, { marketSnapshot: '', marketFigures: [], news: [], educationPoint: '' }));
  const p = b.portfolio;
  ck('value, day change and P&L in total', p.value === 10 * 2440 + 100 * 290 && p.pnl === (10 * 2440 + 100 * 290) - (10 * 2500 + 100 * 250) && p.day_change != null);
  const tcs = p.holdings.find(x => x.symbol === 'TCS'), itc = p.holdings.find(x => x.symbol === 'ITC');
  ck('per holding: price, P&L and %', tcs.price === 2440 && tcs.pnl === -600 && tcs.pnl_pct === -2.4 && itc.pnl_pct === 16);
  ck('near its stop → REVIEW; our SELL → REVIEW', tcs.status === 'REVIEW' && /within 3%/.test(tcs.reasons.join()) && itc.status === 'REVIEW' && /SELL/.test(itc.reasons.join()));
  ck('today\'s action points to it', /Review TCS, ITC/.test(b.today_action));
  PRICES.TCS = 2390;
  engine._test.resetPriceCache();                         // next morning: the 30-minute price cache has expired
  const b2 = await quiet(() => engine._test.buildPortfolio(DB.rows('portfolios').filter(h => h.client_id === 'c1'), []));
  const t2 = b2.holdings.find(x => x.symbol === 'TCS');
  ck('next morning, price through the stop → EXIT, and the brief\'s action says so', t2.status === 'EXIT' && b2.exits.includes('TCS'));
  const html = email.renderMorningBrief({ full_name: 'Asha Rao' }, b).html;
  ck('email shows the portfolio table with statuses', /REVIEW/.test(html) && /TCS/.test(html) && /gain\/loss/.test(html));

  console.log('── starting plan for a holdings-free account ──');
  DB.seed('clients', [{ id: 'n1', full_name: 'New Client' }]);
  const b3 = await quiet(() => engine.buildBriefForClient({ id: 'n1', full_name: 'New Client' }, { marketSnapshot: '', marketFigures: [], news: [], educationPoint: '' }));
  ck('no holdings → starting plan rendered, no portfolio table', !!b3.starting_plan && b3.portfolio === null && /YOUR STARTING PLAN/.test(b3.full_text));

  console.log('── admin test endpoint ──');
  seed();
  const express = require('express'), http = require('http');
  const app = express(); app.use(express.json()); app.use('/api/admin', require('../backend/routes/admin'));
  const srv = http.createServer(app).listen(0);
  const url = `http://127.0.0.1:${srv.address().port}/api/admin/test-alert`;
  const post = (body, key) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) }, body: JSON.stringify(body) });
  ck('without the admin key → 401', (await post({ client_id: 'c1' })).status === 401);
  let res = await quiet(() => post({ client_id: 'c1' }, 'admin-key-admin-key'));
  let j = await res.json();
  ck('near-stop holding priced just under its stop → one alert, to the ADMIN only', res.status === 200 && j.price_override.TCS === 2388 && sent.length === 1 && sent[0].to === 'ADMIN');
  ck('…the client gets no email and no in-app notification', !sent.some(x => x.to === 'a@x.in') && !DB.rows('client_notifications').length);
  j = await (await quiet(() => post({ client_id: 'c1' }, 'admin-key-admin-key'))).json();
  ck('calling again: already sent (deduplicated)', sent.length === 1 && j.deliveries[0].deduped === true);
  srv.close();
})();
