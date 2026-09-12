/**
 * WealthGuard Scheduler — complete cron registry
 *
 * Every automated engine is registered here. Nothing requires human input.
 *
 * DAILY / INTRADAY
 *   07:30 IST Mon–Fri   Morning brief          → personalised brief + email
 *   09:00 IST daily     Subscription engine    → trials, grace periods, referrals
 *   Every 5 min (mkt)   Market data refresh    → NSE/Yahoo/MFAPI + Supabase cache
 *   Every hour (mkt)    Flash alert scan       → steep-move detection + notify
 *   16:30 IST Mon–Fri   EOD + track record     → auto-resolve 7/30/90d checkpoints
 *   18:00 IST Mon–Fri   AI Lever scan          → 3-depth event analysis
 *   22:00 IST Mon–Fri   Opportunity engine     → breakouts, dual agreement, rotation
 *
 * WEEKLY
 *   20:00 IST Sunday    Instrument scoring     → 9 levers + risk gate + signals
 *
 * MONTHLY
 *   19:00 IST on 1st    Benchmark engine       → auto-derive category benchmarks
 *   20:00 IST on 1st    Instrument review      → 100+20 universe management
 *
 * All times converted to UTC for cron (IST = UTC+5:30).
 */

'use strict';

const cron = require('node-cron');

const { refreshAllMarketData }       = require('./marketData');
const { runTrackRecordCheckpoints }  = require('./trackRecordEngine');
const { runFlashAlertScan }          = require('./flashAlertEngine');
const { runInstrumentScoringEngine } = require('./instrumentEngine');
const { runAILeverScan }             = require('./aiLeverEngine');
const { generateAndSendMorningBrief }= require('./morningBriefEngine');
const { runOpportunityEngine }       = require('./opportunityEngine');
const { runSubscriptionEngine }      = require('./subscriptionEngine');
const { runBenchmarkEngine }         = require('./benchmarkEngine');
const { runInstrumentReview }        = require('./instrumentReviewEngine');

const UTC = { timezone: 'UTC' };

/** Market hours check: Mon–Fri, 9:15 AM – 3:30 PM IST */
function isMarketHours() {
  const now = new Date();
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  const istDay = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) >= 1440
    ? (now.getUTCDay() + 1) % 7
    : now.getUTCDay();
  if (istDay === 0 || istDay === 6) return false;
  return istMin >= (9 * 60 + 15) && istMin <= (15 * 60 + 30);
}

/** Is today the 1st of the month in IST? */
function isFirstOfMonthIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60000);
  return ist.getUTCDate() === 1;
}

/** Wraps every scheduled run so one failing engine never kills the process. */
async function safeRun(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`Scheduler error [${label}]:`, e.message);
    // Report the failure to the health engine so it triggers an admin alert
    try {
      const { reportRun } = require('./healthEngine');
      await reportRun({
        engineName: label, itemsProcessed: 0, itemsExpected: 1,
        itemsFailed: 1, detail: `Uncaught: ${e.message}`,
      });
    } catch {}
  }
}

function startSchedulers() {
  console.log('\n⏰ Starting WealthGuard schedulers...');

  // ── 07:30 IST Mon–Fri — Morning brief (02:00 UTC) ──────────────────
  cron.schedule('0 2 * * 1-5', () => {
    safeRun('morningBriefEngine', generateAndSendMorningBrief);
  }, UTC);
  console.log('   ✓ Morning brief: 7:30 AM IST (Mon-Fri)');

  // ── 09:00 IST daily — Subscription lifecycle (03:30 UTC) ───────────
  cron.schedule('30 3 * * *', () => {
    safeRun('subscriptionEngine', runSubscriptionEngine);
  }, UTC);
  console.log('   ✓ Subscription lifecycle: 9:00 AM IST (daily)');

  // ── Every 5 min during market hours — Market data ──────────────────
  cron.schedule('*/5 * * * *', async () => {
    if (isMarketHours()) await safeRun('marketData', refreshAllMarketData);
  });
  console.log('   ✓ Market data: Every 5 min during market hours');

  // ── Every hour at :05 during market hours — Flash alerts ───────────
  cron.schedule('5 * * * *', async () => {
    if (isMarketHours()) await safeRun('flashAlertEngine', runFlashAlertScan);
  });
  console.log('   ✓ Flash alert scan: Every hour during market hours');

  // ── 16:30 IST Mon–Fri — EOD + track record (11:00 UTC) ─────────────
  cron.schedule('0 11 * * 1-5', () => {
    safeRun('trackRecordEngine', runTrackRecordCheckpoints);
  }, UTC);
  console.log('   ✓ Track record checkpoints: 4:30 PM IST (Mon-Fri)');

  // ── 18:00 IST Mon–Fri — AI Lever scan (12:30 UTC) ──────────────────
  cron.schedule('30 12 * * 1-5', () => {
    safeRun('aiLeverEngine', runAILeverScan);
  }, UTC);
  console.log('   ✓ AI Lever scan (10th lever): 6:00 PM IST (Mon-Fri)');

  // ── 22:00 IST Mon–Fri — Opportunity engine (16:30 UTC) ─────────────
  cron.schedule('30 16 * * 1-5', () => {
    safeRun('opportunityEngine', runOpportunityEngine);
  }, UTC);
  console.log('   ✓ Opportunity engine: 10 PM IST (Mon-Fri)');

  // ── 20:00 IST Sunday — Instrument scoring (14:30 UTC Sun) ──────────
  cron.schedule('30 14 * * 0', () => {
    safeRun('instrumentEngine', runInstrumentScoringEngine);
  }, UTC);
  console.log('   ✓ Instrument scoring (9 levers + risk gate): Sunday 8 PM IST');

  // ── 19:00 IST on the 1st — Benchmark engine (13:30 UTC) ────────────
  cron.schedule('30 13 1 * *', () => {
    if (isFirstOfMonthIST()) safeRun('benchmarkEngine', runBenchmarkEngine);
  }, UTC);
  console.log('   ✓ Benchmark engine: 7:00 PM IST on the 1st of each month');

  // ── 20:00 IST on the 1st — Instrument review (14:30 UTC) ───────────
  cron.schedule('30 14 1 * *', () => {
    if (isFirstOfMonthIST()) safeRun('instrumentReviewEngine', runInstrumentReview);
  }, UTC);
  console.log('   ✓ Instrument universe review: 8:00 PM IST on the 1st of each month');

  console.log('');
}

module.exports = { startSchedulers, isMarketHours };
