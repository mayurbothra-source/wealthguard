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
 *   409  skipped_late   (after 12:00 IST — nothing sent, admin alerted; the workflow fails on purpose)
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

module.exports = router;
module.exports._test = { secretMatches };
