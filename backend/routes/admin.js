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
  () => () => require('../services/morningBriefEngine').generateAndSendMorningBrief({ trigger: 'admin' })));

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
/**
 * Wake-up: called on a schedule by GitHub Actions (.github/workflows/wake.yml).
 * The request itself wakes a sleeping free-plan server; this then runs whatever is
 * due and has not run yet. Safe to call as often as you like.
 * Header:  x-admin-key: <ADMIN_TRIGGER_KEY>
 */
router.all('/wake', async (req, res) => {
  if (!checkKey(req, res)) return;
  if (_runningEngines.has('wake')) return res.json({ success: true, message: 'A wake-up run is already in progress.' });
  _runningEngines.add('wake');
  res.json({ success: true, message: 'Awake. Running anything that is due — see Render logs for "Wake-up ran".' });
  try {
    await require('../services/scheduler').runDueJobs();
  } catch (e) {
    console.error('❌ Wake-up failed:', e.message);
  } finally {
    _runningEngines.delete('wake');
  }
});

/**
 * Dry run of one client's morning brief: builds it exactly as the 07:30 run
 * would and returns the email HTML — nothing is stored or sent.
 *   GET /api/admin/brief-preview?client=<client uuid>[&format=json]
 * Header: x-admin-key: <ADMIN_TRIGGER_KEY>
 */
router.get('/brief-preview', async (req, res) => {
  if (!checkKey(req, res)) return;
  const clientId = String(req.query.client || '').trim();
  if (!clientId) return res.status(400).json({ error: 'Pass ?client=<client id>.' });
  try {
    const { supabaseAdmin } = require('../../config/supabase');
    const { data: client } = await supabaseAdmin.from('clients').select('*').eq('id', clientId).maybeSingle();
    if (!client) return res.status(404).json({ error: 'No such client.' });
    const engine = require('../services/morningBriefEngine');
    const shared = await engine.getSharedSections();
    const brief = await engine.buildBriefForClient(client, shared);
    const email = require('../services/emailEngine').renderMorningBrief(client, brief);
    if (req.query.format === 'json') return res.json({ subject: email.subject, text: email.text, brief });
    res.set('Content-Type', 'text/html; charset=utf-8').send(email.html);
  } catch (e) {
    console.error('brief-preview:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Admin access for the in-app admin panel: either the admin key (scripts,
 * curl) or a logged-in session whose client row has is_admin = true.
 */
async function checkAdmin(req, res) {
  if (req.get('x-admin-key') || req.query.key) return checkKey(req, res);
  const { verify } = require('../lib/session');
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const p = m && verify(m[1]);
  if (!p || p.scope !== 'session') { res.status(401).json({ error: 'Admin login required.' }); return false; }
  const { supabaseAdmin } = require('../../config/supabase');
  const { data } = await supabaseAdmin.from('clients').select('is_admin').eq('id', p.sub).maybeSingle();
  if (!data?.is_admin) { res.status(403).json({ error: 'Admins only.' }); return false; }
  return true;
}

/**
 * Where each market figure came from and how old it is.
 *   GET /api/admin/data-freshness   (admin key, or admin session)
 */
router.get('/data-freshness', async (req, res) => {
  if (!(await checkAdmin(req, res))) return;
  try {
    const indices = await require('../services/indexData').getIndexSnapshot();
    res.json({ checked_at: new Date().toISOString(), indices: Object.values(indices) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Checks instrument price sources from the server (which can reach Yahoo and
 * MFAPI), without changing anything:
 *   - candidate Yahoo tickers for instruments with a disputed ticker
 *   - every mutual fund's AMFI code: scheme name, latest NAV date, duplicates
 *   GET /api/admin/verify-instruments   (admin key or admin session)
 * Use the result to decide which ticker / code corrections to apply.
 */
const TICKER_CANDIDATES = {
  BHARAT22ETF: ['ICICIB22.NS', 'BHARAT22.NS'],
  AXISGOLD:    ['AXISGOLD.NS', 'AXISGOLDETF.NS'],
  SBIGOLD:     ['SETFGOLD.NS', 'SBIGOLD.NS'],
};
router.get('/verify-instruments', async (req, res) => {
  if (!(await checkAdmin(req, res))) return;
  try {
    const axios = require('axios');
    const { supabaseAdmin } = require('../../config/supabase');
    const { getYahooQuote } = require('../services/marketData');
    const tickers = [];
    for (const [symbol, list] of Object.entries(TICKER_CANDIDATES)) {
      for (const t of list) {
        const q = await getYahooQuote(t);
        tickers.push({ symbol, ticker: t, ok: !!q, price: q?.price ?? null, as_of: q?.as_of ?? null });
        await new Promise(r => setTimeout(r, 800));
      }
    }
    const { data: funds } = await supabaseAdmin.from('instrument_universe')
      .select('symbol, name, amfi_code, status').eq('price_source', 'mfapi');
    const seen = {};
    (funds || []).forEach(f => { if (f.amfi_code) (seen[f.amfi_code] = seen[f.amfi_code] || []).push(f.symbol); });
    const mf = [];
    for (const f of funds || []) {
      const row = { symbol: f.symbol, name: f.name, status: f.status, amfi_code: f.amfi_code, issues: [] };
      if (!f.amfi_code) { row.issues.push('no amfi_code'); mf.push(row); continue; }
      if (seen[f.amfi_code].length > 1) row.issues.push(`code shared with ${seen[f.amfi_code].filter(x => x !== f.symbol).join(', ')}`);
      try {
        const { data } = await axios.get(`https://api.mfapi.in/mf/${f.amfi_code}/latest`, { timeout: 10000 });
        row.scheme_name = data?.meta?.scheme_name || null;
        row.nav = data?.data?.[0]?.nav ?? null;
        row.nav_date = data?.data?.[0]?.date ?? null;
        if (!row.scheme_name) row.issues.push('MFAPI returned no scheme');
        const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(row.nav_date || '');
        if (m && Date.now() - new Date(`${m[3]}-${m[2]}-${m[1]}`).getTime() > 7 * 86400e3) row.issues.push(`latest NAV is from ${row.nav_date}`);
        const amc = (f.name || '').split(/\s+/)[0].toLowerCase();
        if (row.scheme_name && amc && !row.scheme_name.toLowerCase().includes(amc)) row.issues.push('scheme name does not match the fund house');
        if (row.scheme_name && /idcw|dividend|bonus/i.test(row.scheme_name)) row.issues.push('not a growth plan');
      } catch (e) {
        row.issues.push(`MFAPI error: ${e.message}`);
      }
      mf.push(row);
      await new Promise(r => setTimeout(r, 300));
    }
    res.json({ checked_at: new Date().toISOString(), tickers, mutual_funds: mf,
               funds_with_issues: mf.filter(x => x.issues.length).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * End-to-end alert test. Runs the real stop-loss / critical-risk scan for ONE
 * client and sends whatever it finds to the ADMIN address only (never the client).
 *   POST /api/admin/test-alert   { "client_id": "<id>", "symbol": "TCS", "price": 3450 }
 * symbol + price are optional: without them, a holding with a stop-loss is
 * priced 0.5% below its stop so the breach path is exercised. Each event is
 * sent once — calling again shows it as already sent.
 */
router.post('/test-alert', async (req, res) => {
  if (!(await checkAdmin(req, res))) return;
  const clientId = String(req.body?.client_id || '').trim();
  if (!clientId) return res.status(400).json({ error: 'Pass client_id.' });
  try {
    const { supabaseAdmin } = require('../../config/supabase');
    const { runHoldingAlertScan } = require('../services/holdingAlerts');
    let priceOverride = null;
    if (req.body?.symbol && req.body?.price != null) {
      priceOverride = { [String(req.body.symbol)]: Number(req.body.price) };
    } else {
      const { data: hs } = await supabaseAdmin.from('portfolios').select('instrument_name, stop_loss_price')
        .eq('client_id', clientId).eq('is_active', true);
      const h = (hs || []).find(x => Number(x.stop_loss_price) > 0);
      if (h) priceOverride = { [h.instrument_name]: Math.round(Number(h.stop_loss_price) * 0.995 * 100) / 100 };
    }
    const result = await runHoldingAlertScan({ clientId, priceOverride, forceAdmin: true });
    res.json({ client_id: clientId, price_override: priceOverride, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    ['morningBriefEngine',  () => require('../services/morningBriefEngine').generateAndSendMorningBrief({ trigger: 'admin' })],
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
module.exports.checkAdmin = checkAdmin;
