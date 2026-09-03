/**
 * WealthGuard Scheduler
 * Central cron registry — all scheduled jobs defined here.
 *
 * Schedule overview:
 *   07:30 IST Mon–Fri  — Morning brief delivery
 *   Every 5 min        — Market data refresh (during market hours)
 *   Every hour         — Flash alert scan (during market hours) ← NEW
 *   16:30 IST Mon–Fri  — EOD analysis + track record checkpoints ← UPDATED
 *   22:00 IST Mon–Fri  — Opportunity engine
 *   20:00 IST Sunday   — Instrument scoring engine (9 levers) ← NEW
 */

const cron = require('node-cron');
const { refreshAllMarketData } = require('./marketData');
const { runTrackRecordCheckpoints } = require('./trackRecordEngine');
const { runFlashAlertScan }         = require('./flashAlertEngine');
const { runInstrumentScoringEngine } = require('./instrumentEngine');

function isMarketHours() {
  const now = new Date();
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  return istMin >= (9 * 60 + 15) && istMin <= (15 * 60 + 30);
}

async function safeRun(label, fn) {
  try { await fn(); }
  catch (e) { console.error(`Scheduler error [${label}]:`, e.message); }
}

function startSchedulers() {
  console.log('\n⏰ Starting WealthGuard schedulers...');

  // ── Morning Brief — 7:30 AM IST (Mon–Fri) ────────────────
  // IST = UTC+5:30, so 7:30 IST = 2:00 UTC
  cron.schedule('0 2 * * 1-5', () => {
    safeRun('Morning Brief', async () => {
      const { generateAndSendMorningBrief } = require('./morningBrief');
      await generateAndSendMorningBrief();
    });
  }, { timezone: 'UTC' });
  console.log('   ✓ Morning brief: 7:30 AM IST (Mon-Fri)');

  // ── Market Data Refresh — every 5 min during market hours ─
  cron.schedule('*/5 * * * *', async () => {
    if (isMarketHours()) await safeRun('Market Data', refreshAllMarketData);
  });
  console.log('   ✓ Market data: Every 5 min during market hours');

  // ── Flash Alert Scan — every hour during market hours ─────
  // NEW: scans all 100 instruments for ≥3% hourly moves (≥1% for indices)
  cron.schedule('5 * * * *', async () => {
    if (isMarketHours()) await safeRun('Flash Alerts', runFlashAlertScan);
  });
  console.log('   ✓ Flash alert scan: Every hour during market hours');

  // ── EOD Analysis + Track Record — 4:30 PM IST (Mon–Fri) ──
  // 4:30 IST = 11:00 UTC
  // Track record engine now auto-files 7/30/90-day checkpoints daily —
  // no more manual v8 Tab 2 workflow needed.
  cron.schedule('0 11 * * 1-5', () => {
    safeRun('EOD + Track Record', async () => {
      const { runEODAnalysis } = require('./eodAnalysis');
      await runEODAnalysis();
      await runTrackRecordCheckpoints(); // auto-resolve pending predictions
    });
  }, { timezone: 'UTC' });
  console.log('   ✓ EOD analysis + track record: 4:30 PM IST (Mon-Fri)');

  // ── Opportunity Engine — 10:00 PM IST (Mon–Fri) ──────────
  // 10 PM IST = 16:30 UTC
  cron.schedule('30 16 * * 1-5', () => {
    safeRun('Opportunity Engine', async () => {
      const { runOpportunityEngine } = require('./opportunityEngine');
      await runOpportunityEngine();
    });
  }, { timezone: 'UTC' });
  console.log('   ✓ Opportunity engine: 10 PM IST (Mon-Fri)');

  // ── Instrument Scoring — Sunday 8 PM IST ─────────────────
  // NEW: 9-levers scoring for all 100 instruments. Detects category drops
  // and notifies affected clients immediately. Also promotes watchlist
  // instruments that consistently score above the promotion threshold.
  // 8 PM IST Sunday = 14:30 UTC Sunday (day 0)
  cron.schedule('30 14 * * 0', () => {
    safeRun('Instrument Scoring', runInstrumentScoringEngine);
  }, { timezone: 'UTC' });
  console.log('   ✓ Instrument scoring engine: Sunday 8 PM IST');

  console.log('');
}

module.exports = { startSchedulers };
