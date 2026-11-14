/**
 * One view of "is everything working?" — for the admin panel's System health
 * card and the 08:30 IST admin summary email.
 *
 *   jobs        last run, status and detail of every scheduled job
 *   brief       today's morning-brief deliveries: sent / failed / skipped_late / pending
 *   freshness   Nifty, Sensex, VIX (source, as-of, status) and how many
 *               instruments have a price from the last 2 trading days
 *   price_modes instruments by price_mode (live / daily_nav / static)
 *   errors      the 20 most recent failures (jobs, emails, deliveries)
 */
'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const { istDate } = require('../lib/istTime');

async function safe(fn, fallback) { try { return await fn(); } catch { return fallback; } }

async function getSystemHealth({ now = new Date(), fetchIndices = true } = {}) {
  const date = istDate(now);

  // Jobs: latest health-log row per engine (last 14 days).
  const jobs = await safe(async () => {
    const { data } = await supabaseAdmin.from('system_health_log')
      .select('engine_name, run_at, status, detail, items_processed, items_expected, items_failed')
      .gte('run_at', new Date(now.getTime() - 14 * 86400000).toISOString())
      .order('run_at', { ascending: false }).limit(1000);
    const seen = {};
    for (const r of data || []) if (!seen[r.engine_name]) seen[r.engine_name] = r;
    return Object.values(seen).sort((a, b) => (a.engine_name < b.engine_name ? -1 : 1))
      .map(r => ({ engine: r.engine_name, last_run: r.run_at, status: r.status, detail: r.detail }));
  }, []);

  // Brief deliveries today.
  const brief = await safe(async () => {
    const { data: clients } = await supabaseAdmin.from('clients').select('id, email, email_brief_enabled, subscription_status').limit(5000);
    const eligible = (clients || []).filter(c => !!c.email && c.email_brief_enabled !== false && ['active', 'trial'].includes(c.subscription_status)).length;
    const { data: rows, error } = await supabaseAdmin.from('brief_deliveries').select('status, sent_at').eq('ist_date', date);
    if (error) return { date, eligible, sent: null, failed: null, skipped_late: null, pending: null, note: 'brief_deliveries table missing (migration 011)' };
    const n = st => (rows || []).filter(r => r.status === st).length;
    const sentTimes = (rows || []).filter(r => r.sent_at).map(r => r.sent_at).sort();
    return { date, eligible, sent: n('sent'), failed: n('failed'), skipped_late: n('skipped_late'),
             pending: Math.max(0, eligible - (rows || []).length), first_sent_at: sentTimes[0] || null, last_sent_at: sentTimes[sentTimes.length - 1] || null };
  }, { date, eligible: null });

  // Data freshness.
  const indices = fetchIndices ? await safe(async () => Object.values(await require('./indexData').getIndexSnapshot({ now })), []) : [];
  const instruments = await safe(async () => {
    const { data } = await supabaseAdmin.from('instrument_universe').select('symbol, status, price_mode, price_source, amfi_code, last_price_success_at');
    const { priceModeOf, priceIsFresh } = require('./signalLevels');
    const modes = { live: 0, daily_nav: 0, static: 0 };
    let fresh = 0, stale = 0;
    for (const i of data || []) {
      const m = priceModeOf(i); modes[m] = (modes[m] || 0) + 1;
      if (m === 'static') continue;
      if (priceIsFresh(i.last_price_success_at, now)) fresh++; else stale++;
    }
    return { total: (data || []).length, price_modes: modes, priced_fresh: fresh, priced_stale_or_unknown: stale };
  }, { total: null, price_modes: {}, priced_fresh: null, priced_stale_or_unknown: null });

  // Last 20 errors across jobs, emails and deliveries.
  const errors = await safe(async () => {
    const out = [];
    const { data: h } = await supabaseAdmin.from('system_health_log').select('engine_name, run_at, status, detail')
      .in('status', ['failed', 'degraded']).order('run_at', { ascending: false }).limit(20);
    (h || []).forEach(r => out.push({ at: r.run_at, source: r.engine_name, message: `${r.status}: ${r.detail || ''}` }));
    const { data: e } = await supabaseAdmin.from('email_log').select('sent_at, email_type, status, error_detail')
      .eq('status', 'failed').order('sent_at', { ascending: false }).limit(20);
    (e || []).forEach(r => out.push({ at: r.sent_at, source: `email:${r.email_type}`, message: r.error_detail || 'failed' }));
    const { data: a } = await supabaseAdmin.from('alert_deliveries').select('created_at, event_type, error')
      .eq('status', 'failed').order('created_at', { ascending: false }).limit(20);
    (a || []).forEach(r => out.push({ at: r.created_at, source: `alert:${r.event_type}`, message: r.error || 'failed' }));
    return out.filter(x => x.at).sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 20);
  }, []);

  const indicesOk = indices.length > 0 && indices.every(x => x.status === 'live' && !x.unverified);
  return {
    checked_at: now.toISOString(), date, jobs, brief,
    freshness: { indices, indices_ok: indicesOk, instruments },
    price_modes: instruments.price_modes,
    errors,
  };
}

/** The 08:30 IST admin summary, as subject + plain text. */
function summaryText(h) {
  const b = h.brief || {};
  const briefLine = b.sent == null
    ? `Brief: delivery log unavailable (${b.note || 'unknown'})`
    : `Brief sent to ${b.sent} of ${b.eligible} clients` +
      `${b.failed ? `, ${b.failed} failed` : ''}${b.skipped_late ? `, ${b.skipped_late} skipped (late)` : ''}${b.pending ? `, ${b.pending} not attempted` : ''}` +
      `${b.first_sent_at ? ` (first at ${new Date(b.first_sent_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST)` : ''}`;
  const idx = (h.freshness.indices || []).map(x => `${x.label} ${x.status}${x.unverified ? '/unverified' : ''}`).join(', ') || 'not checked';
  const inst = h.freshness.instruments || {};
  const failures = (h.errors || []).filter(e => e.at && new Date(e.at) > new Date(Date.now() - 24 * 3600e3));
  const ok = b.sent != null && b.sent === b.eligible && h.freshness.indices_ok;
  const subject = `WealthGuard daily summary ${h.date}: ${ok ? 'OK' : 'ATTENTION'}`;
  const lines = [
    briefLine,
    `Data freshness: ${h.freshness.indices_ok ? 'OK' : 'WARN'} — ${idx}`,
    `Instruments: ${inst.price_modes?.static ?? '?'} static, ${inst.price_modes?.live ?? '?'} live, ${inst.price_modes?.daily_nav ?? '?'} daily NAV; ${inst.priced_fresh ?? '?'} with a price from the last 2 trading days, ${inst.priced_stale_or_unknown ?? '?'} stale or never priced`,
    `Failures (last 24 h): ${failures.length ? '' : 'none'}`,
    ...failures.slice(0, 10).map(e => `  • ${e.source}: ${String(e.message).slice(0, 160)}`),
    '',
    'Jobs (last run):',
    ...(h.jobs || []).map(j => `  • ${j.engine}: ${j.status} at ${new Date(j.last_run).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`),
  ];
  return { subject, text: lines.join('\n'), ok };
}

/**
 * Sends the daily summary once per IST date (recorded in system_health_log as
 * engine 'dailySummary'). Recipient: SUMMARY_EMAIL, else ADMIN_EMAIL.
 */
async function sendDailySummary({ now = new Date() } = {}) {
  const date = istDate(now);
  const { data: prior } = await supabaseAdmin.from('system_health_log').select('id, detail')
    .eq('engine_name', 'dailySummary').gte('run_at', new Date(now.getTime() - 20 * 3600e3).toISOString());
  if ((prior || []).some(r => String(r.detail || '').includes(date))) return { status: 'already_sent', date };
  const h = await getSystemHealth({ now });
  const { subject, text, ok } = summaryText(h);
  const to = process.env.SUMMARY_EMAIL || process.env.ADMIN_EMAIL || null;
  const email = require('./emailEngine');
  const res = to ? await email.sendDetailed({ to, subject, html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`, text, type: 'admin_summary' })
                 : { ok: false, error: 'SUMMARY_EMAIL / ADMIN_EMAIL not set' };
  await supabaseAdmin.from('system_health_log').insert({
    engine_name: 'dailySummary', run_at: new Date().toISOString(), status: res.ok ? 'ok' : 'failed',
    items_processed: res.ok ? 1 : 0, items_expected: 1, items_failed: res.ok ? 0 : 1, anomaly_flag: false,
    detail: `${date}: ${subject}${res.ok ? '' : ` — not sent: ${res.error}`}`,
  });
  return { status: res.ok ? 'sent' : 'failed', date, ok, subject, error: res.ok ? null : res.error };
}

module.exports = { getSystemHealth, summaryText, sendDailySummary };
