/**
 * WealthGuard Admin Trigger Routes
 *
 * Lets any scheduled engine be fired on demand instead of waiting for its
 * cron time. Essential for testing after a deploy and for recovering from
 * a missed run.
 *
 * All routes protected by ADMIN_TRIGGER_KEY.
 *
 * Usage:  GET /api/admin/trigger-<engine>?key=YOUR_KEY
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { limit } = require('../lib/rateLimit');

// The key is a secret; ten wrong guesses in ten minutes from one address is
// not a typo, it is an attack.
router.use(limit({ windowMs: 10 * 60e3, max: 60, message: 'Too many admin requests.' }));
const _bad = new Map();   // ip -> { n, resetAt }  — wrong-key attempts only
function tooManyBadKeys(ip) {
  const h = _bad.get(ip);
  return !!(h && h.resetAt > Date.now() && h.n >= 10);
}
function noteBadKey(ip) {
  const now = Date.now();
  const h = _bad.get(ip);
  if (!h || h.resetAt <= now) _bad.set(ip, { n: 1, resetAt: now + 10 * 60e3 });
  else h.n++;
}

/** Constant-time string compare (a plain !== leaks how many leading chars match). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function checkKey(req, res) {
  // Header is preferred (it stays out of URLs, logs and browser history);
  // ?key= still works so existing bookmarks and the trigger workflow do too.
  const key = req.get('x-admin-key') || req.query.key || req.body?.key;
  if (tooManyBadKeys(req.ip)) {
    res.status(429).json({ error: 'Too many wrong keys. Try again in ten minutes.' });
    return false;
  }
  if (!process.env.ADMIN_TRIGGER_KEY) {
    res.status(503).json({
      error: 'ADMIN_TRIGGER_KEY not set on server — add it in Render environment variables first.',
    });
    return false;
  }
  if (!key || !safeEqual(key, process.env.ADMIN_TRIGGER_KEY)) {
    noteBadKey(req.ip);
    res.status(401).json({ error: 'Invalid or missing key.' });
    return false;
  }
  return true;
}

// ── GET /api/admin/issue-setup-code?phone=+91...&key=... ──────────────
// For an account with no PIN and no email on file (so the emailed code cannot
// reach it). Returns a one-time 6-digit code you pass to the client over
// WhatsApp or a call; they enter it on the login screen. 15 minutes, single use.
router.get('/issue-setup-code', async (req, res) => {
  if (!checkKey(req, res)) return;
  const { supabaseAdmin } = require('../../config/supabase');
  const { issueCode } = require('../lib/authCodes');
  const phone = String(req.query.phone || '').trim();
  if (!phone || !supabaseAdmin) return res.status(400).json({ error: 'phone is required (and the database must be configured).' });
  const { data: client } = await supabaseAdmin.from('clients').select('id, full_name').eq('phone_wa', phone).maybeSingle();
  if (!client) return res.status(404).json({ error: 'No client with that phone number (use the exact stored format).' });
  const issued = await issueCode(client.id, 'admin');
  if (!issued.code) return res.status(429).json({ error: issued.error });
  res.json({ success: true, client: client.full_name, code: issued.code, expires_in_minutes: 15 });
});

// Tracks which engines are currently mid-run. Without this, hitting a
// trigger URL twice (a double-click, a browser/proxy retry on a slow
// response, an impatient repeat request) fires two full concurrent runs of
// the same engine — which is exactly what happened on 2026-09-30: two
// overlapping instrumentEngine runs doubled every request to Yahoo's chart
// API inside the same window and tripped its rate limit for every single
// equity and ETF, forcing every instrument to WATCH regardless of its real
// score. A run that is genuinely stuck is rare and self-corrects on the next
// deploy/restart; a same-second double-trigger is common and preventable.
const _runningEngines = new Set();

/**
 * Fires an engine in the background and responds immediately.
 * Long-running engines would otherwise time out the HTTP request.
 * Refuses to start a second run of the same engine while one is in flight.
 */
function makeTrigger(name, emoji, loader) {
  return async (req, res) => {
    if (!checkKey(req, res)) return;

    if (_runningEngines.has(name)) {
      return res.status(409).json({
        success: false,
        engine:  name,
        error:   `${name} is already running from an earlier trigger — refusing to start a second ` +
                 `overlapping run. Wait for it to finish (check Render logs for "${emoji}") and try again.`,
      });
    }

    _runningEngines.add(name);
    res.json({
      success: true,
      engine:  name,
      message: `${name} started. Check Render logs for progress — look for lines starting with "${emoji}".`,
    });
    try {
      const fn = loader();
      await fn();
      console.log(`✅ Manual trigger: ${name} completed successfully.`);
    } catch (e) {
      console.error(`❌ Manual trigger: ${name} failed:`, e.message);
    } finally {
      _runningEngines.delete(name);
    }
  };
}

router.get('/trigger-scoring', makeTrigger(
  'instrumentEngine', '🎯',
  () => require('../services/instrumentEngine').runInstrumentScoringEngine));

router.get('/trigger-ai-scan', makeTrigger(
  'aiLeverEngine', '🤖',
  () => require('../services/aiLeverEngine').runAILeverScan));

router.get('/trigger-track-record', makeTrigger(
  'trackRecordEngine', '📋',
  () => require('../services/trackRecordEngine').runTrackRecordCheckpoints));

router.get('/trigger-morning-brief', makeTrigger(
  'morningBriefEngine', '📰',
  () => require('../services/morningBriefEngine').generateAndSendMorningBrief));

router.get('/trigger-opportunities', makeTrigger(
  'opportunityEngine', '💡',
  () => require('../services/opportunityEngine').runOpportunityEngine));

router.get('/trigger-subscriptions', makeTrigger(
  'subscriptionEngine', '💳',
  () => require('../services/subscriptionEngine').runSubscriptionEngine));

router.get('/trigger-benchmarks', makeTrigger(
  'benchmarkEngine', '📐',
  () => require('../services/benchmarkEngine').runBenchmarkEngine));

router.get('/trigger-instrument-review', makeTrigger(
  'instrumentReviewEngine', '🔍',
  () => require('../services/instrumentReviewEngine').runInstrumentReview));

router.get('/trigger-flash-alerts', makeTrigger(
  'flashAlertEngine', '⚡',
  () => require('../services/flashAlertEngine').runFlashAlertScan));

/**
 * Health summary — what every engine has been doing.
 * Useful for a quick "is everything running?" check.
 */
router.get('/health', async (req, res) => {
  if (!checkKey(req, res)) return;
  try {
    const { getHealthSummary } = require('../services/healthEngine');
    const rows = await getHealthSummary(72);

    // Summarise by engine: last run, status, anomaly count
    const byEngine = {};
    rows.forEach(r => {
      if (!byEngine[r.engine_name]) {
        byEngine[r.engine_name] = {
          engine: r.engine_name, lastRun: r.run_at, lastStatus: r.status,
          runs: 0, anomalies: 0, totalProcessed: 0,
        };
      }
      const e = byEngine[r.engine_name];
      e.runs++;
      if (r.anomaly_flag) e.anomalies++;
      e.totalProcessed += r.items_processed || 0;
    });

    const aiProvider = require('../services/aiProvider');
    const emailEngine = require('../services/emailEngine');

    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      config: {
        aiProviderConfigured: aiProvider.isConfigured(),
        aiActiveModel:        aiProvider.getUsage().activeModel,
        emailConfigured:      emailEngine.isConfigured(),
      },
      engines: Object.values(byEngine).sort((a, b) =>
        new Date(b.lastRun) - new Date(a.lastRun)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Runs the full daily sequence in order. Useful after a deploy or an outage.
 */
router.get('/trigger-all', async (req, res) => {
  if (!checkKey(req, res)) return;
  res.json({
    success: true,
    message: 'Full engine sequence started: scoring → track record → AI scan → opportunities → briefs. This takes 5-10 minutes. Watch Render logs.',
  });

  const sequence = [
    ['instrumentEngine',    () => require('../services/instrumentEngine').runInstrumentScoringEngine()],
    ['trackRecordEngine',   () => require('../services/trackRecordEngine').runTrackRecordCheckpoints()],
    ['aiLeverEngine',       () => require('../services/aiLeverEngine').runAILeverScan()],
    ['opportunityEngine',   () => require('../services/opportunityEngine').runOpportunityEngine()],
    ['morningBriefEngine',  () => require('../services/morningBriefEngine').generateAndSendMorningBrief()],
  ];

  for (const [name, fn] of sequence) {
    try {
      console.log(`\n▶ Sequence: running ${name}...`);
      await fn();
    } catch (e) {
      console.error(`❌ Sequence: ${name} failed — ${e.message}`);
    }
  }
  console.log('\n✅ Full engine sequence complete.');
});

module.exports = router;
