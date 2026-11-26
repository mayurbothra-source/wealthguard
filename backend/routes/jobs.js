/**
 * Scheduled-job endpoints, called by GitHub Actions (.github/workflows/morning-brief.yml).
 *
 *   POST /api/jobs/morning-brief      header  x-job-secret: <JOB_SECRET>
 *
 * The secret is JOB_SECRET, or ADMIN_TRIGGER_KEY when JOB_SECRET is not set.
 * Both sides are whitespace-trimmed and compared in constant time.
 *
 * Responses (JSON { status, date, ... }):
 *   200  sent | already_sent | not_a_brief_day | too_early
 *   409  skipped_late   (after 16:00 IST — nothing sent, admin alerted; the workflow fails on purpose)
 *   502  failed         (every send attempted this time failed)
 *   500  error
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { limit } = require('../lib/rateLimit');

const router = express.Router();
router.use(limit({ windowMs: 10 * 60e3, max: 30, message: 'Too many job requests.' }));

function jobSecret() {
  return String(process.env.JOB_SECRET || process.env.ADMIN_TRIGGER_KEY || '').trim();
}

/** Constant time, length-independent: compare SHA-256 digests. */
function secretMatches(given) {
  const want = jobSecret();
  if (!want || !given) return false;
  const a = crypto.createHash('sha256').update(String(given).trim()).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireJobSecret(req, res, next) {
  if (!jobSecret()) return res.status(503).json({ status: 'error', error: 'JOB_SECRET (or ADMIN_TRIGGER_KEY) is not set on the server.' });
  if (!secretMatches(req.get('x-job-secret'))) return res.status(401).json({ status: 'error', error: 'Unauthorised.' });
  next();
}

let _running = null;   // one delivery at a time in this process; a second caller waits for the same result

router.post('/morning-brief', requireJobSecret, async (req, res) => {
  try {
    if (!_running) {
      _running = require('../lib/keepAwake').during('morning-brief-job', () =>
        require('../services/morningBriefEngine').generateAndSendMorningBrief({ trigger: 'job' }))
        .finally(() => { _running = null; });
    }
    const result = await _running;
    const code = result.status === 'skipped_late' ? 409 : result.status === 'failed' ? 502 : 200;
    res.status(code).json(result);
  } catch (e) {
    console.error('❌ /api/jobs/morning-brief:', e.message);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

/**
 * Morning scoring — fresh market data, then the full 9-lever scoring pass, so
 * the 07:30 brief is built from today's signals (FIX-4: data → scoring → brief).
 * Called by .github/workflows/morning-scoring.yml from 05:45 IST.
 *
 * Scoring takes 10–40 minutes (Yahoo is paced), longer than any HTTP request
 * should wait, so this answers at once and runs in the background with the
 * server kept awake:
 *   202 started       — a run began
 *   200 running       — one is already in progress
 *   200 fresh         — a scoring run finished in the last 6 hours; nothing to do
 *   200 not_a_weekday — Saturday / Sunday (IST)
 */
const FRESH_SCORING_MS = 6 * 3600e3;
let _scoring = null;
router.post('/morning-scoring', requireJobSecret, async (req, res) => {
  try {
    const { isIstWeekday } = require('../lib/istTime');
    if (!isIstWeekday(new Date()) && req.query.force !== '1') return res.json({ status: 'not_a_weekday' });
    if (_scoring) return res.json({ status: 'running', since: _scoring.since });
    const last = await lastScoringRun();
    if (last && Date.now() - new Date(last).getTime() < FRESH_SCORING_MS && req.query.force !== '1') {
      return res.json({ status: 'fresh', last_run: last });
    }
    const since = new Date().toISOString();
    const run = require('../lib/keepAwake').during('morning-scoring', async () => {
      await require('../services/marketData').refreshAllMarketData();
      await require('../services/instrumentEngine').runInstrumentScoringEngine();
      // Chain: after scoring finishes, deliver today's brief (the brief endpoint
      // is idempotent, so this is safe even if the morning-brief workflow also fires).
      console.log('📋 Scoring complete — chaining to morning brief delivery...');
      try { await require('../services/morningBriefEngine').generateAndSendMorningBrief({ trigger: 'post-scoring' }); }
      catch (e) { console.error('❌ chained brief delivery:', e.message); }
    }).catch(e => console.error('❌ morning scoring:', e.message))
      .finally(() => { _scoring = null; });
    _scoring = { since, run };
    res.status(202).json({ status: 'started', since, last_run: last || null });
  } catch (e) {
    console.error('❌ /api/jobs/morning-scoring:', e.message);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

async function lastScoringRun() {
  const { supabaseAdmin } = require('../../config/supabase');
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin.from('system_health_log').select('run_at')
    .eq('engine_name', 'instrumentEngine').order('run_at', { ascending: false }).limit(1);
  return data?.[0]?.run_at || null;
}

/** 08:30 IST admin summary — once per IST date. */
router.post('/daily-summary', requireJobSecret, async (req, res) => {
  try {
    const r = await require('../services/systemHealth').sendDailySummary();
    res.status(r.status === 'failed' ? 502 : 200).json(r);
  } catch (e) {
    console.error('❌ /api/jobs/daily-summary:', e.message);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

module.exports = router;
module.exports._test = { secretMatches, lastScoringRun, waitForScoring: () => _scoring && _scoring.run };
