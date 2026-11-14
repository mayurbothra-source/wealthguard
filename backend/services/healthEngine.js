/**
 * WealthGuard System Health Engine
 *
 * Every scheduled engine reports its run here. This solves the silent-failure
 * problem: the track record engine ran for weeks writing nothing and nobody
 * knew because there was no alerting.
 *
 * How it works:
 *   - Each engine calls reportRun() when it finishes
 *   - If items_processed is 0 but items_expected > 0, that's an anomaly
 *   - Anomalies trigger an immediate admin email (once per engine per day,
 *     so a persistently broken engine doesn't spam the inbox)
 *
 * Fully automated. No human polling of logs required.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');

// Tracks which anomalies we've already alerted on today, so a broken
// engine running hourly doesn't send 8 identical emails.
const alertedToday = new Set();
// Engines whose anomaly is emailed to the admin straight away. Others wait for the daily summary.
const URGENT_ENGINES = ['morningBriefDelivery'];
let alertDateKey = null;

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

function resetIfNewDay() {
  const today = todayKey();
  if (alertDateKey !== today) {
    alertedToday.clear();
    alertDateKey = today;
  }
}

/**
 * Records an engine run and detects anomalies.
 *
 * @param {object} opts
 * @param {string} opts.engineName
 * @param {number} opts.durationMs
 * @param {number} opts.itemsProcessed
 * @param {number} [opts.itemsExpected]  If provided and processed is 0, flags anomaly
 * @param {number} [opts.itemsFailed]
 * @param {string} [opts.detail]
 */
async function reportRun({
  engineName,
  durationMs      = 0,
  itemsProcessed  = 0,
  itemsExpected   = null,
  itemsFailed     = 0,
  detail          = null,
}) {
  resetIfNewDay();

  // Anomaly detection:
  //   - Expected work existed but nothing was processed
  //   - More than half of attempted items failed
  const zeroWhenExpected = itemsExpected != null && itemsExpected > 0 && itemsProcessed === 0;
  const highFailureRate  = itemsProcessed > 0 && itemsFailed / (itemsProcessed + itemsFailed) > 0.5;
  const anomaly          = zeroWhenExpected || highFailureRate;

  const status = anomaly ? 'failed'
               : itemsFailed > 0 ? 'degraded'
               : 'ok';

  // Was this engine already flagged today? The in-memory set below is lost on
  // every restart, and the free server restarts several times a day — which is
  // how one false alarm became three emails overnight. The database remembers.
  let alreadyAlertedToday = alertedToday.has(engineName);
  if (anomaly && !alreadyAlertedToday && supabaseAdmin) {
    try {
      const ist = new Date(Date.now() + 5.5 * 3600e3);
      const istMidnightUtc = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3600e3);
      const { count } = await supabaseAdmin.from('system_health_log')
        .select('id', { count: 'exact', head: true })
        .eq('engine_name', engineName).eq('anomaly_flag', true)
        .gte('run_at', istMidnightUtc.toISOString());
      if (count) alreadyAlertedToday = true;
    } catch { /* if the lookup fails, fall back to the in-memory check */ }
  }

  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from('system_health_log').insert({
        engine_name:     engineName,
        run_at:          new Date().toISOString(),
        duration_ms:     Math.round(durationMs),
        items_processed: itemsProcessed,
        items_expected:  itemsExpected,
        items_failed:    itemsFailed,
        status,
        anomaly_flag:    anomaly,
        detail,
      });
    } catch (e) {
      console.warn(`   ⚠ Health log write failed for ${engineName}: ${e.message}`);
    }
  }

  // Alert on anomaly — once per engine per day
  // Immediate emails only for problems that need action today (a morning brief
  // that did not go out). Everything else is recorded here and appears in the
  // 08:30 IST daily summary instead of a separate email per anomaly.
  // ADMIN_ALERTS_IMMEDIATE=all restores an email for every anomaly.
  const immediate = String(process.env.ADMIN_ALERTS_IMMEDIATE || 'urgent').toLowerCase() === 'all'
    || URGENT_ENGINES.includes(engineName);
  if (anomaly && !alreadyAlertedToday && immediate) {
    alertedToday.add(engineName);
    await sendAnomalyAlert(engineName, {
      itemsProcessed, itemsExpected, itemsFailed, detail, durationMs,
    });
  }

  return { status, anomaly };
}

/**
 * Emails the admin when an engine anomaly is detected.
 * Uses a lazy require to avoid a circular dependency with emailEngine.
 */
async function sendAnomalyAlert(engineName, stats) {
  console.error(`🚨 ANOMALY DETECTED in ${engineName}:`, JSON.stringify(stats));

  try {
    const { sendAdminAlert } = require('./emailEngine');
    const body = [
      `Engine: ${engineName}`,
      `Items processed: ${stats.itemsProcessed}`,
      `Items expected: ${stats.itemsExpected ?? 'n/a'}`,
      `Items failed: ${stats.itemsFailed}`,
      `Duration: ${Math.round(stats.durationMs / 1000)}s`,
      stats.detail ? `Detail: ${stats.detail}` : null,
      '',
      'This engine produced no output when output was expected, or had a high failure rate.',
      'Check Render logs for the full trace.',
    ].filter(Boolean).join('\n');

    await sendAdminAlert(`WealthGuard alert: ${engineName} anomaly`, body);
  } catch (e) {
    console.warn(`   ⚠ Could not send anomaly alert email: ${e.message}`);
  }
}

/**
 * Returns a summary of recent engine health — used by the admin panel.
 */
async function getHealthSummary(hoursBack = 48) {
  if (!supabaseAdmin) return [];
  try {
    const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
    const { data } = await supabaseAdmin
      .from('system_health_log')
      .select('*')
      .gte('run_at', since)
      .order('run_at', { ascending: false });
    return data || [];
  } catch {
    return [];
  }
}

module.exports = { reportRun, getHealthSummary };
