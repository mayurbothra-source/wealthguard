/**
 * FIX-4 — data → scoring → brief: the morning-scoring job endpoint starts a
 * fresh market-data refresh plus scoring run, is idempotent, and signals carry
 * risk_reward_ratio.
 */
'use strict';
process.env.NODE_ENV = 'test';
process.env.JOB_SECRET = 'job-secret-1';
const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const DB = require('./_fakeDb')();
const calls = [];
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r.endsWith('services/marketData')) return { refreshAllMarketData: async () => { calls.push('data'); } };
  if (r.endsWith('services/instrumentEngine')) return { runInstrumentScoringEngine: async () => { await new Promise(x => setTimeout(x, 20)); calls.push('scoring'); } };
  if (r.endsWith('lib/istTime')) { const real = orig(r, p, i); return { ...real, isIstWeekday: () => true }; }
  return orig(r, p, i);
};
const express = require('express');
const jobs = require('../backend/routes/jobs');

(async () => {
  const app = express(); app.use('/api/jobs', jobs);
  const srv = app.listen(0); const port = srv.address().port;
  const post = (h = {}, q = '') => fetch(`http://127.0.0.1:${port}/api/jobs/morning-scoring${q}`, { method: 'POST', headers: h }).then(async x => ({ status: x.status, body: await x.json() }));

  console.log('── morning scoring job ──');
  ck('no secret → 401', (await post()).status === 401);
  let r = await post({ 'x-job-secret': 'job-secret-1' });
  ck('starts a run in the background → 202 started', r.status === 202 && r.body.status === 'started');
  const r2 = await post({ 'x-job-secret': 'job-secret-1' });
  ck('a second call while it runs → 200 running (no second run)', r2.status === 200 && r2.body.status === 'running');
  await jobs._test.waitForScoring();
  ck('order: market data refreshed first, then scoring', calls.join(',') === 'data,scoring');
  DB.seed('system_health_log', [{ engine_name: 'instrumentEngine', run_at: new Date().toISOString(), status: 'ok' }]);
  r = await post({ 'x-job-secret': 'job-secret-1' });
  ck('a scoring run in the last 6 h → 200 fresh, nothing started', r.status === 200 && r.body.status === 'fresh' && calls.length === 2);
  DB.rows('system_health_log')[0].run_at = new Date(Date.now() - 13 * 3600e3).toISOString();   // last evening
  r = await post({ 'x-job-secret': 'job-secret-1' });
  ck('last night\'s run is not fresh enough → a new morning run starts', r.status === 202);
  await jobs._test.waitForScoring();
  srv.close();

  console.log('── risk_reward_ratio ──');
  const src = require('fs').readFileSync(require('path').join(__dirname, '../backend/services/instrumentEngine.js'), 'utf8');
  ck('every signal row writes risk_reward_ratio (the existing column) with the reward:risk value', /risk_reward_ratio:\s+rewardRisk/.test(src));
  const wf = require('fs').readFileSync(require('path').join(__dirname, '../.github/workflows/morning-scoring.yml'), 'utf8');
  ck('workflow runs before the 07:30 brief (00:15 and 00:50 UTC)', /'15 0 \* \* 1-5'/.test(wf) && /'50 0 \* \* 1-5'/.test(wf));
})();
