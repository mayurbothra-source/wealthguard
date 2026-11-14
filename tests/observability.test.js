/**
 * WS6 — observability: the System health view and the 08:30 admin summary.
 */
'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_TRIGGER_KEY = 'admin-key-admin-key';
process.env.SUMMARY_EMAIL = 'hello@pripar.com';

const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const DB = require('./_fakeDb')();
const { previousTradingDate } = require('../backend/services/indexData');   // real helper, loaded before the stub
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r === './indexData' || r.endsWith('services/indexData'))
    return { getIndexSnapshot: async () => ({ nifty: { label: 'Nifty 50', status: 'live', unverified: false, source: 'yahoo', age_hours: 2 },
      sensex: { label: 'Sensex', status: 'live', unverified: false, source: 'yahoo', age_hours: 2 }, vix: { label: 'India VIX', status: 'stale', unverified: false, source: 'stored (yahoo)', age_hours: 80 } }),
      previousTradingDate };
  return orig(r, p, i);
};
const email = require('../backend/services/emailEngine');
const mails = [];
email.sendDetailed = async (m) => { mails.push(m); return { ok: true, id: 'x' }; };
const SH = require('../backend/services/systemHealth');
const now = new Date('2026-11-13T03:00:00Z');                    // Fri 08:30 IST
const ago = h => new Date(now.getTime() - h * 3600e3).toISOString();

DB.seed('clients', [
  { id: 'a', email: 'a@x', subscription_status: 'active' }, { id: 'b', email: 'b@x', subscription_status: 'trial' },
  { id: 'c', email: 'c@x', subscription_status: 'active' }, { id: 'd', email: null, subscription_status: 'active' },
]);
DB.seed('brief_deliveries', [
  { client_id: 'a', ist_date: '2026-11-13', status: 'sent', sent_at: '2026-11-13T02:00:30Z' },
  { client_id: 'b', ist_date: '2026-11-13', status: 'failed' },
]);
DB.seed('system_health_log', [
  { engine_name: 'morningBriefEngine', run_at: ago(1), status: 'degraded', detail: '1 sent, 1 failed' },
  { engine_name: 'morningBriefEngine', run_at: ago(25), status: 'ok', detail: 'yesterday' },
  { engine_name: 'instrumentEngine', run_at: ago(100), status: 'ok', detail: '120 scored' },
]);
DB.seed('email_log', [{ sent_at: ago(1), email_type: 'morning_brief', status: 'failed', error_detail: 'HTTP 422 — invalid to' }]);
DB.seed('instrument_universe', [
  { symbol: 'TCS', price_mode: 'live', last_price_success_at: ago(20) },
  { symbol: 'INFY', price_mode: 'live', last_price_success_at: null },
  { symbol: 'MF1', price_mode: 'daily_nav', last_price_success_at: ago(15) },
  { symbol: 'GSEC10Y', price_mode: 'static' },
]);

(async () => {
  const h = await SH.getSystemHealth({ now });
  console.log('── system health ──');
  ck('jobs: the latest run per engine', h.jobs.length === 2 && h.jobs.find(j => j.engine === 'morningBriefEngine').status === 'degraded');
  ck('brief today: sent / failed / not attempted against eligible', h.brief.eligible === 3 && h.brief.sent === 1 && h.brief.failed === 1 && h.brief.pending === 1 && h.brief.first_sent_at === '2026-11-13T02:00:30Z');
  ck('data freshness: each index with source and age; WARN when one is stale', h.freshness.indices.length === 3 && h.freshness.indices_ok === false);
  ck('instruments by price_mode, and how many have a recent price', h.price_modes.live === 2 && h.price_modes.static === 1 && h.price_modes.daily_nav === 1
     && h.freshness.instruments.priced_fresh === 2 && h.freshness.instruments.priced_stale_or_unknown === 1);
  ck('last errors merged across jobs and emails, newest first', h.errors.length === 2 && h.errors.some(e => e.source === 'email:morning_brief') && h.errors[0].at >= h.errors[1].at);
  DB.missingTables.add('brief_deliveries');
  const h2 = await SH.getSystemHealth({ now });
  ck('before migration 011 the brief line says why it has no counts', h2.brief.sent === null && /migration 011/.test(h2.brief.note));
  DB.missingTables.clear();

  console.log('── 08:30 summary ──');
  const s = SH.summaryText(h);
  ck('says "Brief sent to N of M clients", with failures', /^Brief sent to 1 of 3 clients, 1 failed, 1 not attempted \(first at 07:30 am IST\)/i.test(s.text), s.text.split('\n')[0]);
  ck('data freshness OK/WARN and N instruments static', /Data freshness: WARN — .*India VIX stale/.test(s.text) && /Instruments: 1 static/.test(s.text));
  ck('lists recent failures', /email:morning_brief: HTTP 422/.test(s.text));
  ck('subject flags ATTENTION when anything is off', /ATTENTION/.test(s.subject));
  let r = await SH.sendDailySummary({ now });
  ck('sent to SUMMARY_EMAIL (hello@pripar.com)', r.status === 'sent' && mails.length === 1 && mails[0].to === 'hello@pripar.com');
  r = await SH.sendDailySummary({ now: new Date(now.getTime() + 30 * 60e3) });
  ck('a second trigger the same day: already_sent, no second email', r.status === 'already_sent' && mails.length === 1);

  console.log('── endpoints ──');
  const express = require('express'), http = require('http');
  const app = express(); app.use(express.json());
  app.use('/api/admin', require('../backend/routes/admin')); app.use('/api/jobs', require('../backend/routes/jobs'));
  const srv = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  ck('system-health needs the admin key or an admin session', (await fetch(`${base}/api/admin/system-health`)).status === 401);
  const ok = await fetch(`${base}/api/admin/system-health`, { headers: { 'x-admin-key': 'admin-key-admin-key' } });
  const body = await ok.json();
  ck('…and returns jobs, brief, freshness, price modes and errors', ok.status === 200 && ['jobs', 'brief', 'freshness', 'price_modes', 'errors'].every(k => k in body));
  ck('daily-summary job endpoint needs the job secret', (await fetch(`${base}/api/jobs/daily-summary`, { method: 'POST' })).status === 401);
  srv.close();
})();
