/**
 * WealthGuard Admin Trigger Routes
 * Lets you manually fire a scheduled engine immediately instead of
 * waiting for its cron time — useful right after deploying a fix,
 * or for a launch day where waiting until Sunday isn't practical.
 *
 * Protected by a simple secret key (not full auth) since this can
 * trigger real side effects like client notifications.
 */

const express = require('express');
const router = express.Router();

function checkKey(req, res) {
  const key = req.query.key || req.body?.key;
  if (!process.env.ADMIN_TRIGGER_KEY) {
    res.status(503).json({ error: 'ADMIN_TRIGGER_KEY not set on server — add it in Render environment variables first.' });
    return false;
  }
  if (key !== process.env.ADMIN_TRIGGER_KEY) {
    res.status(401).json({ error: 'Invalid or missing key.' });
    return false;
  }
  return true;
}

// GET /api/admin/trigger-scoring?key=YOUR_SECRET
// Fires the 9-levers instrument scoring engine immediately.
// Also converts scores into live BUY/WATCH/SELL signals (the fix
// that closes the "No call yet" gap on the Markets Dashboard).
router.get('/trigger-scoring', async (req, res) => {
  if (!checkKey(req, res)) return;

  // Respond immediately — scoring 100+ instruments can take a couple
  // of minutes, and we don't want the HTTP request to time out while
  // waiting. Check Render logs to watch progress and confirm completion.
  res.json({
    success: true,
    message: 'Instrument scoring engine started. This takes 1-3 minutes for 120 instruments. Check Render logs for progress — look for lines starting with "🎯".',
  });

  try {
    const { runInstrumentScoringEngine } = require('../services/instrumentEngine');
    await runInstrumentScoringEngine();
    console.log('✅ Manual trigger: instrument scoring engine completed successfully.');
  } catch (e) {
    console.error('❌ Manual trigger: instrument scoring engine failed:', e.message);
  }
});

// GET /api/admin/trigger-ai-scan?key=YOUR_SECRET
router.get('/trigger-ai-scan', async (req, res) => {
  if (!checkKey(req, res)) return;
  res.json({ success: true, message: 'AI Lever scan started. Check Render logs — look for lines starting with "🤖".' });
  try {
    const { runAILeverScan } = require('../services/aiLeverEngine');
    await runAILeverScan();
    console.log('✅ Manual trigger: AI lever scan completed successfully.');
  } catch (e) {
    console.error('❌ Manual trigger: AI lever scan failed:', e.message);
  }
});

// GET /api/admin/trigger-track-record?key=YOUR_SECRET
router.get('/trigger-track-record', async (req, res) => {
  if (!checkKey(req, res)) return;
  res.json({ success: true, message: 'Track record checkpoint engine started. Check Render logs — look for lines starting with "📋".' });
  try {
    const { runTrackRecordCheckpoints } = require('../services/trackRecordEngine');
    await runTrackRecordCheckpoints();
    console.log('✅ Manual trigger: track record engine completed successfully.');
  } catch (e) {
    console.error('❌ Manual trigger: track record engine failed:', e.message);
  }
});

module.exports = router;
