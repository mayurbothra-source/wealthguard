/**
 * WealthGuard Scheduler — full cron registry
 *
 * 07:30 IST Mon–Fri  — Morning brief
 * Every 5 min        — Market data refresh (market hours)
 * Every hour         — Flash alert scan (market hours)
 * 16:30 IST Mon–Fri  — EOD analysis + track record auto-checkpoints
 * 18:00 IST Mon–Fri  — AI Lever scan (Depth 1+2+3)
 * 22:00 IST Mon–Fri  — Opportunity engine
 * 20:00 IST Sunday   — Instrument scoring engine (9 levers)
 */

const cron = require('node-cron');
const { refreshAllMarketData }      = require('./marketData');
const { runTrackRecordCheckpoints } = require('./trackRecordEngine');
const { runFlashAlertScan }         = require('./flashAlertEngine');
const { runInstrumentScoringEngine } = require('./instrumentEngine');
const { runAILeverScan }            = require('./aiLeverEngine');

function isMarketHours() {
  const now = new Date();
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  return istMin >= (9 * 60 + 15) && istMin <= (15 * 60 + 30);
}

async function safeRun(label, fn) {
  try { await fn(); }
  catch (e) { console.error('Scheduler error [' + label + ']:', e.message); }
}

function startSchedulers() {
  console.log('\n⏰ Starting WealthGuard schedulers...');

  cron.schedule('0 2 * * 1-5', () => {
    safeRun('Morning Brief', async () => {
      const { generateAndSendMorningBrief } = require('./morningBrief');
      await generateAndSendMorningBrief();
    });
  }, { timezone: 'UTC' });
  console.log('   ✓ Morning brief: 7:30 AM IST (Mon-Fri)');

  cron.schedule('*/5 * * * *', async () => {
    if (isMarketHours()) await safeRun('Market Data', refreshAllMarketData);
  });
  console.log('   ✓ Market data: Every 5 min during market hours');

  cron.schedule('5 * * * *', async () => {
    if (isMarketHours()) await safeRun('Flash Alerts', runFlashAlertScan);
  });
  console.log('   ✓ Flash alert scan: Every hour during market hours');

  cron.schedule('0 11 * * 1-5', () => {
    safeRun('EOD + Track Record', async () => {
      try { const { runEODAnalysis } = require('./eodAnalysis'); await runEODAnalysis(); } catch {}
      await runTrackRecordCheckpoints();
    });
  }, { timezone: 'UTC' });
  console.log('   ✓ EOD analysis + track record: 4:30 PM IST (Mon-Fri)');

  cron.schedule('30 12 * * 1-5', () => {
    safeRun('AI Lever Scan', runAILeverScan);
  }, { timezone: 'UTC' });
  console.log('   ✓ AI Lever scan (10th lever): 6:00 PM IST (Mon-Fri)');

  cron.schedule('30 16 * * 1-5', () => {
    safeRun('Opportunity Engine', async () => {
      try { const { runOpportunityEngine } = require('./opportunityEngine'); await runOpportunityEngine(); } catch {}
    });
  }, { timezone: 'UTC' });
  console.log('   ✓ Opportunity engine: 10 PM IST (Mon-Fri)');

  cron.schedule('30 14 * * 0', () => {
    safeRun('Instrument Scoring', runInstrumentScoringEngine);
  }, { timezone: 'UTC' });
  console.log('   ✓ Instrument scoring engine: Sunday 8 PM IST');

  console.log('');
}

module.exports = { startSchedulers };
