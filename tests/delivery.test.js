/**
 * WS1 — reliable morning-brief delivery.
 *   IST date handling, the 07:30–12:00 window, exactly one email per client per
 *   IST day (including two triggers racing), retry of failed sends, skipped_late,
 *   the pre-migration fallback, and the job endpoint's secret check.
 */
'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_TRIGGER_KEY = 'admin-key-admin-key';
delete process.env.JOB_SECRET;

const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const DB = require('./_fakeDb')();
const reports = [];
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r.endsWith('services/marketData') || r === './marketData')
    return { refreshAllMarketData: async () => ({ nifty: { price: 25000, change_pct: 0.4, source: 'yahoo_live' }, vix: 15, vixSource: 'yahoo_live', vixRegime: { regime: 'normal' }, sensex: { price: 82000, source: 'yahoo_live' } }),
             getNSEQuote: async () => null, classifyVIXRegime: () => ({}), getIndiaVIX: async () => 15 };
  if (r === './healthEngine' || r.endsWith('services/healthEngine'))
    return { reportRun: async (x) => { reports.push(x); return { status: 'ok' }; } };
  return orig(r, p, i);
};

const ist = require('../backend/lib/istTime');
const email = require('../backend/services/emailEngine');
const { deliverMorningBriefs } = require('../backend/services/briefDelivery');

let sends = [];
let failFor = new Set();
email.sendMorningBrief = async (c) => {
  await new Promise(r => setTimeout(r, 5));             // let racing triggers interleave
  if (failFor.has(c.id)) return { ok: false, error: 'HTTP 500 — provider down' };
  sends.push(c.id); return { ok: true, id: `msg-${c.id}-${sends.length}` };
};

const at = (isoUtc) => new Date(isoUtc);
const FRI_0731 = at('2026-11-13T02:01:00Z');   // Fri 07:31 IST
const FRI_0700 = at('2026-11-13T01:30:00Z');   // Fri 07:00 IST
const FRI_1201 = at('2026-11-13T06:31:00Z');   // Fri 12:01 IST
const SAT_0800 = at('2026-11-14T02:30:00Z');   // Sat 08:00 IST

function reset() {
  for (const t of ['clients', 'brief_deliveries', 'morning_briefs', 'email_log']) DB.rows(t).length = 0;
  DB.missingTables.clear();
  sends = []; failFor = new Set(); reports.length = 0;
  DB.seed('clients', [
    { id: 'c1', full_name: 'Asha Rao', email: 'a@x.in', subscription_status: 'active', email_brief_enabled: true },
    { id: 'c2', full_name: 'Bala K', email: 'b@x.in', subscription_status: 'trial', email_brief_enabled: true },
    { id: 'c3', full_name: 'No Email', email: null, subscription_status: 'active' },
    { id: 'c4', full_name: 'Lapsed', email: 'd@x.in', subscription_status: 'read_only' },
    { id: 'c5', full_name: 'Opted Out', email: 'e@x.in', subscription_status: 'active', email_brief_enabled: false },
  ]);
}
const count = id => sends.filter(x => x === id).length;
const quiet = async fn => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

(async () => {
  console.log('── IST date handling ──');
  ck('20:00 UTC on 12 Nov is 13 Nov in IST', ist.istDate(at('2026-11-12T20:00:00Z')) === '2026-11-13');
  ck('18:29 UTC is still the same IST day; 18:30 UTC is the next', ist.istDate(at('2026-11-12T18:29:00Z')) === '2026-11-12' && ist.istDate(at('2026-11-12T18:30:00Z')) === '2026-11-13');
  ck('02:00 UTC is 07:30 IST (450 minutes)', ist.istMinutes(at('2026-11-13T02:00:00Z')) === 450);
  ck('Friday is a weekday, Saturday is not (IST)', ist.isIstWeekday(FRI_0731) && !ist.isIstWeekday(SAT_0800));
  ck('a Sunday-night-UTC instant that is Monday morning in IST counts as a weekday', ist.isIstWeekday(at('2026-11-15T20:00:00Z')));
  ck('email date header is in IST', /Friday, 13 November/.test(ist.istLongDate(at('2026-11-12T20:00:00Z'))));

  console.log('── window rules ──');
  reset();
  let r = await quiet(() => deliverMorningBriefs({ trigger: 'job', now: FRI_0700 }));
  ck('before 07:30 IST: too_early, nothing sent', r.status === 'too_early' && sends.length === 0);
  r = await quiet(() => deliverMorningBriefs({ trigger: 'job', now: SAT_0800 }));
  ck('Saturday: not_a_brief_day, nothing sent', r.status === 'not_a_brief_day' && sends.length === 0);

  console.log('── exactly once per client per IST day ──');
  reset();
  r = await quiet(() => deliverMorningBriefs({ trigger: 'job', now: FRI_0731 }));
  ck('07:31 IST: sends to the two eligible clients', r.status === 'sent' && r.sent === 2 && count('c1') === 1 && count('c2') === 1);
  ck('no email to: no address, lapsed plan, opted out', !sends.includes('c3') && !sends.includes('c4') && !sends.includes('c5'));
  ck('every client still gets an in-app brief stored', ['c1', 'c2', 'c3', 'c4', 'c5'].every(id => DB.rows('morning_briefs').some(b => b.client_id === id)));
  const d1 = DB.rows('brief_deliveries').find(x => x.client_id === 'c1');
  ck('delivery row: sent, IST date, provider message id, sent_at', d1?.status === 'sent' && d1.ist_date === '2026-11-13' && /^msg-c1/.test(d1.provider_message_id) && !!d1.sent_at);
  r = await quiet(() => deliverMorningBriefs({ trigger: 'job', now: at('2026-11-13T02:20:00Z') }));
  ck('a second trigger the same morning: already_sent, no new email', r.status === 'already_sent' && sends.length === 2);

  reset();
  const [a, b, c] = await quiet(() => Promise.all([
    deliverMorningBriefs({ trigger: 'job', now: FRI_0731 }),
    deliverMorningBriefs({ trigger: 'cron', now: FRI_0731 }),
    deliverMorningBriefs({ trigger: 'catch-up', now: FRI_0731 }),
  ]));
  ck('three triggers racing: exactly one email per client', count('c1') === 1 && count('c2') === 1 && sends.length === 2, JSON.stringify(sends));
  ck('…one delivery row per client', DB.rows('brief_deliveries').filter(x => x.client_id === 'c1').length === 1);
  ck('…and every caller gets a success status', [a, b, c].every(x => ['sent', 'already_sent'].includes(x.status)));

  console.log('── failures are retried, at most 3 attempts ──');
  reset(); failFor.add('c2');
  r = await quiet(() => deliverMorningBriefs({ trigger: 'job', now: FRI_0731 }));
  const f = DB.rows('brief_deliveries').find(x => x.client_id === 'c2');
  ck('a failed send is recorded with its error', r.failed === 1 && f?.status === 'failed' && /provider down/.test(f.error));
  failFor.clear();
  r = await quiet(() => deliverMorningBriefs({ trigger: 'job', now: at('2026-11-13T02:16:00Z') }));
  ck('the next trigger retries it and sends once', r.sent === 1 && count('c2') === 1 && count('c1') === 1 && f.status === 'sent' && f.attempts === 2);
  reset(); failFor.add('c2');
  for (let i = 0; i < 4; i++) await quiet(() => deliverMorningBriefs({ trigger: 'job', now: FRI_0731 }));
  ck('a client that keeps failing is tried 3 times, then left alone', DB.rows('brief_deliveries').find(x => x.client_id === 'c2').attempts === 3);

  console.log('── late cutoff ──');
  reset();
  r = await quiet(() => deliverMorningBriefs({ trigger: 'catch-up', now: FRI_1201 }));
  ck('after 12:00 IST with nothing sent: skipped_late, no email', r.status === 'skipped_late' && sends.length === 0 && r.pending === 2);
  ck('…recorded per client as skipped_late', DB.rows('brief_deliveries').filter(x => x.status === 'skipped_late').length === 2);
  ck('…and reported as an anomaly (admin alert)', reports.some(x => x.engineName === 'morningBriefDelivery' && x.itemsProcessed === 0 && x.itemsExpected === 2 && /skipped_late/.test(x.detail)));
  r = await quiet(() => deliverMorningBriefs({ trigger: 'catch-up', now: at('2026-11-13T12:00:00Z') }));
  ck('a later wake-up the same day does nothing more', r.status === 'already_sent' && sends.length === 0);
  reset();
  await quiet(() => deliverMorningBriefs({ trigger: 'job', now: FRI_0731 }));
  r = await quiet(() => deliverMorningBriefs({ trigger: 'catch-up', now: FRI_1201 }));
  ck('after 12:00 when the brief already went: already_sent, no alert', r.status === 'already_sent' && !reports.some(x => x.engineName === 'morningBriefDelivery'));

  console.log('── before migration 011 ──');
  reset(); DB.missingTables.add('brief_deliveries');
  r = await quiet(() => deliverMorningBriefs({ trigger: 'job', now: FRI_0731 }));
  ck('no brief_deliveries table: still sends once per eligible client', r.sent === 2 && sends.length === 2);
  r = await quiet(() => deliverMorningBriefs({ trigger: 'job', now: FRI_0731 }));
  ck('…and a second trigger falls back to email_sent: no double send', r.status === 'already_sent' && sends.length === 2);

  console.log('── job endpoint ──');
  const engine = require('../backend/services/morningBriefEngine');
  let next = { status: 'sent', sent: 2 };
  engine.generateAndSendMorningBrief = async () => next;
  const express = require('express'), http = require('http');
  const app = express(); app.use('/api/jobs', require('../backend/routes/jobs'));
  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  const post = (headers = {}) => fetch(`http://127.0.0.1:${port}/api/jobs/morning-brief`, { method: 'POST', headers }).then(async x => ({ status: x.status, body: await x.json() }));
  ck('no secret → 401', (await post()).status === 401);
  ck('wrong secret → 401', (await post({ 'x-job-secret': 'nope' })).status === 401);
  let res = await post({ 'x-job-secret': '  admin-key-admin-key  ' });
  ck('the secret is whitespace-trimmed; ADMIN_TRIGGER_KEY works when JOB_SECRET is unset', res.status === 200 && res.body.status === 'sent');
  process.env.JOB_SECRET = 'job-secret-1';
  ck('when JOB_SECRET is set, it is the one that works', (await post({ 'x-job-secret': 'job-secret-1' })).status === 200 && (await post({ 'x-job-secret': 'admin-key-admin-key' })).status === 401);
  next = { status: 'already_sent' };
  ck('already_sent → 200 (the workflow succeeds)', (await post({ 'x-job-secret': 'job-secret-1' })).status === 200);
  next = { status: 'skipped_late', pending: 2 };
  ck('skipped_late → 409 (the workflow fails loudly)', (await post({ 'x-job-secret': 'job-secret-1' })).status === 409);
  next = { status: 'failed', failed: 2 };
  ck('all sends failed → 502', (await post({ 'x-job-secret': 'job-secret-1' })).status === 502);
  srv.close();

  console.log('── admin brief preview (dry run) ──');
  reset();
  const app2 = express(); app2.use('/api/admin', require('../backend/routes/admin'));
  const srv2 = http.createServer(app2).listen(0);
  const p2 = srv2.address().port;
  const get = (q, key) => fetch(`http://127.0.0.1:${p2}/api/admin/brief-preview${q}`, { headers: key ? { 'x-admin-key': key } : {} });
  ck('preview without the admin key → 401', (await get('?client=c1')).status === 401);
  const before = { briefs: DB.rows('morning_briefs').length, sends: sends.length };
  const pr = await quiet(() => get('?client=c1', 'admin-key-admin-key'));
  const html = await pr.text();
  ck('preview returns the email HTML with the client\'s first name', pr.status === 200 && /Good morning, Asha/.test(html));
  ck('…including the not-advice disclaimer', /do not constitute financial advice/i.test(html));
  ck('…and nothing is sent or stored', DB.rows('morning_briefs').length === before.briefs && sends.length === before.sends);
  const pj = await (await quiet(() => get('?client=c1&format=json', 'admin-key-admin-key'))).json();
  ck('format=json returns the subject, text and structured brief', /Morning Brief/.test(pj.subject) && !!pj.brief?.market_snapshot);
  ck('unknown client → 404', (await quiet(() => get('?client=nope', 'admin-key-admin-key'))).status === 404);
  srv2.close();
})();
