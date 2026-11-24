/**
 * Morning-brief delivery: one function, used by every trigger (the in-process
 * 07:30 cron, start-up catch-up, the GitHub job endpoint, the admin trigger).
 *
 * Rules
 *   - Mon–Fri only (IST). Never before 07:30 IST. Never after 12:00 IST — a
 *     brief that would arrive at lunchtime is skipped, recorded as
 *     `skipped_late`, and the admin is alerted.
 *   - Exactly one email per client per IST date. Each send is claimed first in
 *     `brief_deliveries` (unique client_id + ist_date), so two triggers racing
 *     each other cannot both send. A failed send is retried by a later trigger,
 *     at most MAX_ATTEMPTS times.
 *   - Every client still gets an in-app brief stored, emailed or not.
 *
 * Before migration 011 (no brief_deliveries table) it falls back to the older
 * morning_briefs.email_sent check and says so in the logs.
 */
'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const db = require('../lib/db');
const { istDate, istMinutes, isIstWeekday } = require('../lib/istTime');

const SEND_FROM_MIN = 7 * 60 + 30;   // 07:30 IST
const LATE_CUTOFF_MIN = 12 * 60;     // 12:00 IST
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 15 * 60 * 1000;

const isMissingTable = e => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|Could not find the table/i.test(e.message || ''));

const emailable = c => !!c.email && c.email_brief_enabled !== false && ['active', 'trial'].includes(c.subscription_status);

/** Is the delivery table there? (Migration 011.) */
async function deliveriesTableReady() {
  const { error } = await supabaseAdmin.from('brief_deliveries').select('id', { count: 'exact', head: true }).limit(1);
  if (isMissingTable(error)) return false;
  return true;
}

/**
 * Claims the right to email `clientId` for `date`. Returns the delivery row id,
 * or null if someone else already sent it, is sending it now, or it has failed
 * too many times.
 */
async function claim(clientId, date, trigger) {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('brief_deliveries')
    .insert({ client_id: clientId, ist_date: date, status: 'sending', attempts: 1, trigger, updated_at: now })
    .select('id').maybeSingle();
  if (!error) return data?.id || null;
  if (error.code !== '23505') throw new Error(`brief_deliveries insert: ${error.message}`);

  // A row already exists: only a failed attempt, or a claim abandoned by a crash, may be retried.
  const { data: row } = await supabaseAdmin.from('brief_deliveries')
    .select('id, status, attempts, updated_at').eq('client_id', clientId).eq('ist_date', date).maybeSingle();
  if (!row) return null;
  const stale = row.status === 'sending' && Date.now() - new Date(row.updated_at).getTime() > STALE_CLAIM_MS;
  if (!(row.status === 'failed' || stale) || (row.attempts || 0) >= MAX_ATTEMPTS) return null;
  const { data: upd } = await supabaseAdmin.from('brief_deliveries')
    .update({ status: 'sending', attempts: (row.attempts || 0) + 1, trigger, updated_at: now })
    .eq('id', row.id).eq('status', row.status)            // only if nobody else re-claimed it first
    .select('id');
  return upd && upd.length ? row.id : null;
}

async function settle(id, result) {
  const now = new Date().toISOString();
  await supabaseAdmin.from('brief_deliveries').update({
    status: result.ok ? 'sent' : 'failed',
    provider_message_id: result.id || null,
    error: result.ok ? null : String(result.error || 'unknown').slice(0, 500),
    sent_at: result.ok ? now : null,
    updated_at: now,
  }).eq('id', id);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.trigger]  'cron' | 'catch-up' | 'job' | 'admin'
 * @param {Date}   [opts.now]
 * @param {boolean} [opts.ignoreWindow] admin only: send outside 07:30–12:00 (still once per day)
 * @returns {Promise<{status: string, date: string, sent?: number, failed?: number, pending?: number, eligible?: number, stored?: number}>}
 */
async function deliverMorningBriefs({ trigger = 'cron', now = new Date(), ignoreWindow = false } = {}) {
  const engine = require('./morningBriefEngine');
  const emailEngine = require('./emailEngine');
  const { reportRun } = require('./healthEngine');
  const date = istDate(now);
  const minutes = istMinutes(now);
  const base = { date, trigger };

  if (!supabaseAdmin) return { ...base, status: 'no_database' };
  if (!isIstWeekday(now) && !ignoreWindow) return { ...base, status: 'not_a_brief_day' };
  if (minutes < SEND_FROM_MIN && !ignoreWindow) return { ...base, status: 'too_early' };

  const start = Date.now();
  const { data: clients, error: cErr } = await supabaseAdmin.from('clients').select('*').limit(5000);
  if (cErr) throw new Error(`clients: ${cErr.message}`);
  const all = clients || [];
  const eligible = all.filter(emailable);

  const tableReady = await deliveriesTableReady();
  if (!tableReady) console.warn('   ⚠ brief_deliveries table missing (run migration 011) — falling back to morning_briefs.email_sent');

  // Who still needs an email today?
  const done = new Set();
  if (tableReady) {
    const { data: rows } = await supabaseAdmin.from('brief_deliveries')
      .select('client_id, status, attempts').eq('ist_date', date);
    for (const r of rows || []) {
      if (r.status === 'sent' || r.status === 'skipped_late' || (r.status === 'failed' && (r.attempts || 0) >= MAX_ATTEMPTS)) done.add(r.client_id);
    }
  } else {
    const { data: rows } = await supabaseAdmin.from('morning_briefs').select('client_id').eq('brief_date', date).eq('email_sent', true);
    (rows || []).forEach(r => done.add(r.client_id));
  }
  const pending = eligible.filter(c => !done.has(c.id));

  // Briefs already stored today (in-app) do not need rebuilding unless we are emailing them.
  const { data: storedRows } = await supabaseAdmin.from('morning_briefs').select('client_id').eq('brief_date', date);
  const stored = new Set((storedRows || []).map(r => r.client_id));
  const pendingIds = new Set(pending.map(c => c.id));
  const toBuild = all.filter(c => pendingIds.has(c.id) || !stored.has(c.id));

  if (!pending.length && !toBuild.length) {
    return { ...base, status: 'already_sent', eligible: eligible.length, sent: 0, pending: 0 };
  }

  if (pending.length && minutes >= LATE_CUTOFF_MIN && !ignoreWindow) {
    // Too late to be a *morning* brief. Record it, tell the admin once, send nothing.
    if (tableReady) {
      for (const c of pending) {
        await supabaseAdmin.from('brief_deliveries').insert({
          client_id: c.id, ist_date: date, status: 'skipped_late', attempts: 0, trigger,
          error: `first trigger arrived at ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} IST`,
          updated_at: new Date().toISOString(),
        });   // a conflict means a row already exists — fine
      }
    }
    console.warn(`   ⏰ Morning brief skipped_late: ${pending.length} client(s) not emailed (after 12:00 IST)`);
    await reportRun({
      engineName: 'morningBriefDelivery', durationMs: Date.now() - start,
      itemsProcessed: 0, itemsExpected: pending.length, itemsFailed: pending.length,
      detail: `skipped_late: no brief sent by 12:00 IST on ${date} (trigger: ${trigger}). Check the morning-brief GitHub workflow.`,
    });
    return { ...base, status: 'skipped_late', eligible: eligible.length, pending: pending.length, sent: 0 };
  }

  console.log(`📰 Morning brief delivery (${trigger}) for ${date}: ${pending.length} to email, ${toBuild.length} to build`);
  const shared = await engine.getSharedSections({ force: true });
  let sent = 0, failed = 0, built = 0, skippedClaim = 0;

  for (const client of toBuild) {
    let brief;
    try {
      brief = await engine.buildBriefForClient(client, shared);
      const { ok } = await engine.persistBrief(client, brief, date);
      if (ok) built++;
    } catch (e) {
      console.error(`   ❌ Brief build failed for ${client.id}: ${e.message}`);
      if (pendingIds.has(client.id)) failed++;
      continue;
    }
    if (!pendingIds.has(client.id)) continue;

    let claimId = null;
    if (tableReady) {
      claimId = await claim(client.id, date, trigger);
      if (!claimId) { skippedClaim++; continue; }       // another trigger has it, or it is done
    }
    const result = await emailEngine.sendMorningBrief(client, brief);
    const res = typeof result === 'object' && result !== null ? result : { ok: !!result };
    if (claimId) await settle(claimId, res);
    if (res.ok) {
      sent++;
      const at = new Date().toISOString();
      await db.tryWrite('morning_briefs', 'update', c =>
        c.from('morning_briefs').update({ email_sent: true, email_sent_at: at }).eq('client_id', client.id).eq('brief_date', date));
      await db.tryWrite('clients', 'update', c =>
        c.from('clients').update({ last_brief_sent_at: at }).eq('id', client.id));
    } else {
      failed++;
    }
  }

  console.log(`📰 Morning brief delivery done: ${sent} sent, ${failed} failed, ${skippedClaim} already handled, ${built} briefs stored`);
  await reportRun({
    engineName: 'morningBriefEngine', durationMs: Date.now() - start,
    itemsProcessed: sent, itemsExpected: pending.length - skippedClaim || null, itemsFailed: failed,
    detail: `${date} via ${trigger}: ${sent} sent, ${failed} failed, ${skippedClaim} already handled, ${built} stored, ${eligible.length} eligible`,
  });
  const status = sent > 0 || failed === 0 ? (sent > 0 ? 'sent' : 'already_sent') : 'failed';
  return { ...base, status, eligible: eligible.length, pending: pending.length, sent, failed, already: skippedClaim, stored: built };
}

module.exports = { deliverMorningBriefs, SEND_FROM_MIN, LATE_CUTOFF_MIN, MAX_ATTEMPTS, _test: { claim, emailable } };
