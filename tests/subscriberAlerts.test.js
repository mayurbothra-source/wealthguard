/**
 * What a subscriber receives: the daily brief, and an email only when an index
 * (Nifty 50 / Sensex, ≥1% in an hour) or a holding (≥3% in an hour) FALLS.
 * Internal system anomalies go to the admin's 08:30 summary, not a separate email.
 */
'use strict';
process.env.NODE_ENV = 'test';
delete process.env.ADMIN_ALERTS_IMMEDIATE;

const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const DB = require('./_fakeDb')();
const adminMails = [];
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  return orig(r, p, i);
};
const email = require('../backend/services/emailEngine');
const sent = [];
email.sendHoldingAlert = async (c, ev) => { sent.push({ to: c.email, key: ev.key, title: ev.title }); return { ok: true, id: 'm' }; };
email.sendAdminAlert = async (subject) => { adminMails.push(subject); return true; };

const { runIndexFallScan } = require('../backend/services/flashAlertEngine');
const snap = (nifty, sensex, extra = {}) => ({
  nifty: { price: nifty, status: 'live', unverified: false, ...(extra.nifty || {}) },
  sensex: { price: sensex, status: 'live', unverified: false, ...(extra.sensex || {}) },
});
const T0 = new Date('2026-11-16T05:00:00Z');                  // Mon 10:30 IST
const later = m => new Date(T0.getTime() + m * 60000);

(async () => {
  DB.seed('clients', [
    { id: 'a', full_name: 'Asha', email: 'a@x', subscription_status: 'active' },
    { id: 'b', full_name: 'Bala', email: 'b@x', subscription_status: 'trial' },
    { id: 'c', full_name: 'Lapsed', email: 'c@x', subscription_status: 'read_only' },
    { id: 'd', full_name: 'Opted out', email: 'd@x', subscription_status: 'active', email_alerts_enabled: false },
  ]);

  console.log('── index falls ──');
  let r = await runIndexFallScan({ now: T0, snapshot: snap(25000, 82000) });
  ck('first reading of the day: nothing to compare, no alert', r.fired.length === 0 && sent.length === 0);
  r = await runIndexFallScan({ now: later(60), snapshot: snap(24700, 81900) });      // Nifty −1.2%, Sensex −0.12%
  ck('Nifty down 1.2% in the hour → alert; Sensex down 0.1% → none', r.fired.length === 1 && r.fired[0].key === 'nifty' && r.fired[0].move === -1.2);
  ck('…every active/trial subscriber with alerts on is emailed once', sent.filter(x => /^index_fall:nifty:/.test(x.key)).map(x => x.to).sort().join() === 'a@x,b@x');
  ck('…the message says what fell and by how much, without urging a sale', /Nifty 50 fell 1\.2% in the last hour/.test(sent[0].title));
  r = await runIndexFallScan({ now: later(120), snapshot: snap(24400, 81800) });     // falls again
  ck('a further fall the same day: no second email per subscriber', sent.filter(x => /^index_fall:nifty:/.test(x.key)).length === 2);
  r = await runIndexFallScan({ now: later(180), snapshot: snap(24800, 82900) });     // rises
  ck('a rise never alerts', r.fired.length === 0);
  r = await runIndexFallScan({ now: later(240), snapshot: snap(24000, 82900, { nifty: { status: 'stale' } }) });
  ck('a stale or unverified index reading never alerts', r.fired.length === 0);
  await runIndexFallScan({ now: later(300), snapshot: snap(24800, 82900) });           // stores a fresh reading
  r = await runIndexFallScan({ now: later(310), snapshot: snap(23000, 82900) });
  ck('a reading only 10 minutes old is not "the last hour": no alert', r.fired.length === 0);

  console.log('── admin anomalies ──');
  const { reportRun } = require('../backend/services/healthEngine');
  await reportRun({ engineName: 'aiLeverEngine', itemsProcessed: 5, itemsFailed: 7, detail: '7 flags' });
  ck('an ordinary engine anomaly is NOT emailed (it goes to the 08:30 summary)', adminMails.length === 0
     && DB.rows('system_health_log').some(x => x.engine_name === 'aiLeverEngine' && x.anomaly_flag === true));
  await reportRun({ engineName: 'morningBriefDelivery', itemsProcessed: 0, itemsExpected: 3, itemsFailed: 3, detail: 'skipped_late' });
  ck('a brief that did not go out IS emailed to the admin straight away', adminMails.length === 1 && /morningBriefDelivery/.test(adminMails[0]));
  process.env.ADMIN_ALERTS_IMMEDIATE = 'all';
  await reportRun({ engineName: 'trackRecordEngine', itemsProcessed: 0, itemsExpected: 5, itemsFailed: 5 });
  ck('ADMIN_ALERTS_IMMEDIATE=all restores an email per anomaly', adminMails.length === 2);
  delete process.env.ADMIN_ALERTS_IMMEDIATE;

  console.log('── the AI lever no longer cries wolf ──');
  const src = require('fs').readFileSync(require.resolve('../backend/services/aiLeverEngine.js'), 'utf8');
  ck('its health check counts AI calls, not errors against news events',
     /itemsProcessed: aiUsage\.google \+ aiUsage\.anthropic/.test(src) && /itemsFailed:\s+aiUsage\.failures/.test(src));
  // The run in the screenshot: 10 AI calls succeeded, 2 failed → 17% — degraded, not an anomaly.
  const r2 = await reportRun({ engineName: 'aiLeverEngine2', itemsProcessed: 10, itemsFailed: 2 });
  ck('the 13 Nov run (10 calls ok, 2 failed) is "degraded", not an alert', r2.status === 'degraded' && r2.anomaly === false);
})();
