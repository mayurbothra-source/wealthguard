/**
 * Reliability fixes: keep-awake while jobs run, evening jobs that survive late
 * wake-ups, and placeholder market values never shown as fact.
 */
'use strict';
process.env.NODE_ENV = 'test';
const path = require('path');

// ── fake Supabase: only what ranTodayIST needs ──
let healthRows = [];
const supaPath = path.resolve(__dirname, '../config/supabase.js');
const chain = () => {
  const q = { filters: [] };
  const api = {
    select: () => api,
    eq: (k, v) => { q.filters.push(r => r[k] === v); return api; },
    gte: (k, v) => { q.filters.push(r => r[k] >= v); return api; },
    then: (res) => res({ count: healthRows.filter(r => q.filters.every(f => f(r))).length }),
  };
  return api;
};
require.cache[supaPath] = { id: supaPath, filename: supaPath, loaded: true,
  exports: { supabaseAdmin: { from: () => chain() }, supabase: null } };

// ── fake axios for keep-awake pings ──
const axios = require('axios');
const pings = [];
axios.get = async (url) => { pings.push(url); return { data: {} }; };

let pass = 0, fail = 0;
const ck = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); };

(async () => {
  console.log('── keep-awake ──');
  process.env.RENDER_EXTERNAL_URL = 'https://example.onrender.com/';
  const keepAwake = require('../backend/lib/keepAwake');
  let seenDuring = null;
  await keepAwake.during('job', async () => { seenDuring = keepAwake.status(); await keepAwake._ping(); });
  ck('pings run while a job is active', seenDuring.pinging === true && seenDuring.active.length === 1);
  ck('it pings the server\'s own public /healthz', pings[0] === 'https://example.onrender.com/healthz');
  ck('pings stop when the job finishes', keepAwake.status().pinging === false && keepAwake.status().active.length === 0);
  let threw = false;
  try { await keepAwake.during('bad', async () => { throw new Error('boom'); }); } catch { threw = true; }
  ck('a failing job still stops the pings (and the error is not swallowed)', threw && keepAwake.status().pinging === false);
  delete process.env.RENDER_EXTERNAL_URL;
  await keepAwake.during('local', async () => { ck('no public URL (local/tests) → no pinging', keepAwake.status().pinging === false); });

  console.log('── evening jobs survive late wake-ups ──');
  const { _test: { eveningJobDue } } = require('../backend/services/scheduler');
  const realNow = Date.now;
  const at = iso => { Date.now = () => new Date(iso).getTime(); };
  healthRows = [];
  at('2026-11-11T16:40:00Z');   // Wed 22:10 IST
  ck('opportunity engine due at 22:10 IST on a weekday', await eveningJobDue('opportunityEngine', 22 * 60, 14));
  at('2026-11-11T19:50:00Z');   // Thu 01:20 IST — the GitHub ping arrived ~3h late
  ck('…still due after midnight when the ping arrives late', await eveningJobDue('opportunityEngine', 22 * 60, 14));
  healthRows = [{ engine_name: 'opportunityEngine', run_at: '2026-11-11T16:45:00Z' }];
  ck('…but not again once it has run', !(await eveningJobDue('opportunityEngine', 22 * 60, 14)));
  healthRows = [];
  at('2026-11-12T05:00:00Z');   // Thu 10:30 IST
  ck('not due during the day', !(await eveningJobDue('opportunityEngine', 22 * 60, 14)));
  at('2026-11-14T20:00:00Z');   // Sun 01:30 IST — Saturday evening is not a weekday
  ck('not due after a weekend evening', !(await eveningJobDue('opportunityEngine', 22 * 60, 14)));
  at('2026-11-12T13:00:00Z');   // Thu 18:30 IST
  ck('AI lever scan due from 18:00 IST', await eveningJobDue('aiLeverEngine', 18 * 60, 14));
  Date.now = realNow;

  console.log('── market snapshot never shows placeholders ──');
  const { _test: { buildMarketSnapshot } } = require('../backend/services/morningBriefEngine');
  const regime = { regime: 'normal' };
  let t = await buildMarketSnapshot({ nifty: { price: 24650.25, change_pct: 0.68, source: 'demo' }, vix: 13.42, vixSource: 'demo', vixRegime: regime, sensex: { price: 80845.2, source: 'demo' } }, []);
  ck('all-placeholder data → no numbers, an honest sentence', !/\d{2},?\d{3}|13\.4/.test(t) && /could not be fetched/.test(t));
  t = await buildMarketSnapshot({ nifty: { price: 25100, change_pct: -0.4, source: 'yahoo_live' }, vix: 13.42, vixSource: 'demo', vixRegime: regime, sensex: { price: 82361.72, source: 'yahoo_live' } }, []);
  ck('placeholder VIX is hidden while live Nifty and Sensex show', !/VIX/.test(t) && /25,100/.test(t) && /82,361/.test(t));
  t = await buildMarketSnapshot({ nifty: { price: 25100, change_pct: 0.2, source: 'yahoo_live' }, vix: 15.1, vixSource: 'supabase_cache', vixAsOf: '2026-11-11T09:55:00Z', vixRegime: regime }, []);
  ck('an earlier real VIX reading is shown and labelled as such', /India VIX is at 15\.1/.test(t) && /last reading/.test(t));

  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
