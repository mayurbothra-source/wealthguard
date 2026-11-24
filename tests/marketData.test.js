/**
 * WS2 — trustworthy market data.
 *   Source chain with fallbacks, as_of and previous close, staleness by trading
 *   day, the sanity guard (>4% move, unchanged >3 days), no hard-coded defaults,
 *   unknown VIX handled conservatively, and how the brief and email show it.
 */
'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_TRIGGER_KEY = 'admin-key-admin-key';

const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const DB = require('./_fakeDb')();
const reports = [];
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r === './healthEngine' || r.endsWith('services/healthEngine'))
    return { reportRun: async (x) => { reports.push(x); return { status: 'ok' }; } };
  return orig(r, p, i);
};

const idx = require('../backend/services/indexData');
const at = s => new Date(s);
const sec = s => Math.floor(new Date(s).getTime() / 1000);

/** A fake HTTP client: `routes` maps a URL substring to a response or an error status. */
function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    get: async (url, opts) => {
      calls.push(url);
      for (const [frag, resp] of Object.entries(routes)) {
        if (url.includes(frag)) {
          if (typeof resp === 'number') { const e = new Error(`HTTP ${resp}`); e.response = { status: resp }; throw e; }
          return { data: typeof resp === 'function' ? resp(url, opts) : resp };
        }
      }
      const e = new Error('blocked'); e.response = { status: 403 }; throw e;
    },
  };
}
const yahoo = (price, closes, whenIso) => ({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: closes[0], regularMarketTime: sec(whenIso) },
  indicators: { quote: [{ close: closes }] } }] } });

(async () => {
  console.log('── trading days and staleness ──');
  ck('previous trading day of a Monday is the Friday', idx.previousTradingDate('2026-11-16') === '2026-11-13');
  ck('previous trading day of a Wednesday is the Tuesday', idx.previousTradingDate('2026-11-11') === '2026-11-10');
  const MON_0730 = at('2026-11-16T02:00:00Z');
  ck('Monday 07:30: Friday\'s close is live (1 trading day old)', idx.assess({ price: 1, as_of: '2026-11-13T10:00:00Z' }, MON_0730).status === 'live');
  ck('Monday 07:30: Thursday\'s close is stale', idx.assess({ price: 1, as_of: '2026-11-12T10:00:00Z' }, MON_0730).status === 'stale');
  ck('no reading at all: missing', idx.assess(null, MON_0730).status === 'missing');

  console.log('── sanity guard ──');
  const big = idx.assess({ price: 100, change_pct: -4.6, as_of: '2026-11-13T10:00:00Z' }, MON_0730);
  ck('a daily move above 4% is unverified', big.unverified && /4.6%/.test(big.warnings.join()));
  ck('a 3.9% move is fine', !idx.assess({ price: 100, change_pct: 3.9, as_of: '2026-11-13T10:00:00Z' }, MON_0730).unverified);
  const frozen = { price: 13.42, change_pct: 0, as_of: '2026-11-13T10:00:00Z',
    history: [{ d: '2026-11-06', price: 13.40 }, { d: '2026-11-09', price: 13.42 }, { d: '2026-11-10', price: 13.42 }, { d: '2026-11-12', price: 13.42 }, { d: '2026-11-13', price: 13.42 }] };
  const fz = idx.assess(frozen, MON_0730);
  ck('a value unchanged for more than 3 days is unverified', fz.unverified && /unchanged since 2026-11-09/.test(fz.warnings.join()));
  const moving = { ...frozen, history: frozen.history.map((h, i) => ({ ...h, price: 13 + i })) };
  ck('a value that moves is not flagged', !idx.assess(moving, MON_0730).unverified);

  console.log('── source chain ──');
  let http = fakeHttp({ 'nseindia.com': 403, 'query1.finance': 429,
    'query2.finance': yahoo(25100, [25000, 25200, 25100], '2026-11-13T10:00:00Z') });
  let r = await idx.fetchIndex('nifty', http);
  ck('NSE blocked, Yahoo query1 rate-limited → Yahoo query2 answers', r?.source === 'yahoo-q2' && r.price === 25100);
  ck('previous close is the prior daily close, change % computed from it', r.prev_close === 25200 && r.change_pct === -0.4);
  ck('as_of is the market time of the price, not the fetch time', r.as_of === '2026-11-13T10:00:00.000Z');
  http = fakeHttp({ 'nseindia.com': { timestamp: '13-Nov-2026 15:30:00', data: [{ indexSymbol: 'NIFTY 50', last: 25100, previousClose: 25000, percentChange: 0.4 }] } });
  r = await idx.fetchIndex('nifty', http);
  ck('NSE answers first when it can, with its own timestamp', r.source === 'nse' && r.prev_close === 25000 && r.as_of === '2026-11-13T10:00:00.000Z');
  http = fakeHttp({ 'nseindia.com': { data: [] }, 'query1.finance': yahoo(80000, [79000, 80000], '2026-11-13T10:00:00Z') });
  r = await idx.fetchIndex('sensex', http);
  ck('Sensex skips NSE and uses Yahoo', r.source === 'yahoo' && !http.calls.some(u => u.includes('nseindia')));

  console.log('── no hard-coded defaults ──');
  DB.rows('market_cache').length = 0; reports.length = 0;
  const dead = fakeHttp({});
  let snap = await idx.getIndexSnapshot({ now: MON_0730, http: dead });
  ck('every source down, nothing stored: all three are missing with price null', ['nifty', 'sensex', 'vix'].every(k => snap[k].status === 'missing' && snap[k].price === null));
  const md = require('../backend/services/marketData');
  ck('no 13.42 / 24,650 / 80,845 placeholders remain in the market data code',
     !/13\.42|24650|80845/.test(require('fs').readFileSync(require.resolve('../backend/services/marketData.js'), 'utf8')));
  ck('unknown VIX is "unknown", not "calm"', md.classifyVIXRegime(null).regime === 'unknown');

  console.log('── stored readings ──');
  const good = fakeHttp({ 'nseindia.com': 403,
    '%5ENSEI': yahoo(25100, [25000, 25200, 25100], '2026-11-13T10:00:00Z'),
    '%5EBSESN': yahoo(82000, [81000, 81500, 82000], '2026-11-13T10:00:00Z'),
    '%5EINDIAVIX': yahoo(16.6, [15.8, 16.1, 16.6], '2026-11-13T10:00:00Z') });
  snap = await idx.getIndexSnapshot({ now: at('2026-11-13T10:05:00Z'), http: good });
  ck('live readings: level, change % and as_of for all three', snap.nifty.status === 'live' && snap.vix.price === 16.6 && snap.vix.change_pct === 3.11 && !!snap.sensex.as_of);
  ck('they are stored with their source', !!DB.rows('market_cache').find(x => x.cache_key === 'index_prices_v2')?.data?.vix?.source);
  snap = await idx.getIndexSnapshot({ now: at('2026-11-18T02:00:00Z'), http: dead });
  ck('later, every source down: the stored reading is used and labelled', snap.vix.source === 'stored (yahoo)' && snap.vix.price === 16.6);
  ck('…and it is stale once older than the previous trading day', snap.vix.status === 'stale' && snap.vix.age_hours > 100);
  await idx.reportIndexWarnings(snap);
  ck('stale or unverified figures raise one admin warning naming each', reports.some(x => x.engineName === 'marketDataSanity' && /India VIX: stale/.test(x.detail)));

  console.log('── unknown VIX in the risk gate ──');
  const gate = require('../backend/services/riskGateEngine');
  const sess = gate.createGateSession();
  const g1 = await gate.runRiskGate({ symbol: 'ASTRAL', category: 'mid_cap_equity' }, 'BUY', 78, { vix: null, priceSource: 'yahoo' }, sess);
  ck('unknown VIX: a mid-cap BUY is held at WATCH', g1.action === 'WATCH' && g1.vetoed && /could not confirm/.test(g1.reason));

  console.log('── what the client sees ──');
  const brief = require('../backend/services/morningBriefEngine');
  const { buildMarketFigures, buildMarketSnapshot } = brief._test;
  const indices = {
    nifty:  { label: 'Nifty 50', price: 25100.5, change_pct: -0.4, as_of: '2026-11-13T10:00:00Z', status: 'live', unverified: false },
    sensex: { label: 'Sensex', price: 82000, change_pct: 5.2, as_of: '2026-11-13T10:00:00Z', status: 'live', unverified: true },
    vix:    { label: 'India VIX', price: 16.6, change_pct: 3.11, as_of: '2026-11-10T10:00:00Z', status: 'stale', unverified: false },
  };
  const figs = buildMarketFigures({ indices });
  ck('live figure: level, day change and as-of time', /Nifty 50 25,100\.5 ▼ 0\.40% \(as of 13 Nov, 3:30 pm IST\)/i.test(figs[0].line), figs[0].line);
  ck('unverified figure is labelled unverified', figs[1].unverified && /unverified/.test(figs[1].line));
  ck('stale figure says not live, with its date', /not live — as of 10 Nov/.test(figs[2].line));
  const missingFigs = buildMarketFigures({ indices: { ...indices, nifty: { label: 'Nifty 50', price: null, status: 'missing' } } });
  ck('missing figure says so plainly', missingFigs[0].line === 'Nifty 50: not available today');
  const text = await buildMarketSnapshot({ indices }, []);
  ck('an unverified figure is never given to the summary as fact', !/82,000/.test(text) && /25,100/.test(text));
  const email = require('../backend/services/emailEngine').renderMorningBrief({ full_name: 'Asha Rao' },
    { market_figures: missingFigs, market_snapshot: 'Calm day.' }, at('2026-11-13T02:00:00Z'));
  ck('email shows each figure, including "not available today"', /not available today/.test(email.html) && /25,100\.5|Sensex/.test(email.html));

  console.log('── admin view ──');
  const express = require('express'), http2 = require('http');
  const app = express(); app.use('/api/admin', require('../backend/routes/admin'));
  const srv = http2.createServer(app).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/admin/data-freshness`;
  ck('no admin key or admin session → 401', (await fetch(base)).status === 401);
  const session = require('../backend/lib/session');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-123';
  DB.seed('clients', [{ id: 'u1', is_admin: false }, { id: 'adm', is_admin: true }]);
  ck('a logged-in non-admin → 403', (await fetch(base, { headers: { authorization: `Bearer ${session.issueSession('u1')}` } })).status === 403);
  const ok = await fetch(base, { headers: { authorization: `Bearer ${session.issueSession('adm')}` } });
  const body = await ok.json();
  ck('an admin session gets source, as-of and age for each figure', ok.status === 200 && body.indices.length === 3 && body.indices.every(x => 'source' in x && 'age_hours' in x && 'status' in x));
  srv.close();
})();
