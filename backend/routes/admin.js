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
const router  = express.Router();

function checkKey(req, res) {
  const key = req.query.key || req.body?.key;
  if (!process.env.ADMIN_TRIGGER_KEY) {
    res.status(503).json({
      error: 'ADMIN_TRIGGER_KEY not set on server — add it in Render environment variables first.',
    });
    return false;
  }
  if (key !== process.env.ADMIN_TRIGGER_KEY) {
    res.status(401).json({ error: 'Invalid or missing key.' });
    return false;
  }
  return true;
}

/**
 * Fires an engine in the background and responds immediately.
 * Long-running engines would otherwise time out the HTTP request.
 */
function makeTrigger(name, emoji, loader) {
  return async (req, res) => {
    if (!checkKey(req, res)) return;
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
