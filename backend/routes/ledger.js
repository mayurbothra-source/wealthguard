/**
 * GET /api/ledger/predictions   header  x-ledger-token: <LEDGER_TOKEN>
 *
 * Read-only JSON for the Google Sheet prediction ledger
 * (scripts/google-sheets/PredictionLedger.gs). The token is LEDGER_TOKEN, or
 * JOB_SECRET when that is not set; compared in constant time. Returns
 * { rows, summary, engine, generated_at }. No client data — house predictions only.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { limit } = require('../lib/rateLimit');

const router = express.Router();
router.use(limit({ windowMs: 10 * 60e3, max: 30, message: 'Too many ledger requests.' }));

const token = () => String(process.env.LEDGER_TOKEN || process.env.JOB_SECRET || '').trim();
function tokenMatches(given) {
  const want = token();
  if (!want || !given) return false;
  const a = crypto.createHash('sha256').update(String(given).trim()).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

router.get('/predictions', async (req, res) => {
  if (!token()) return res.status(503).json({ error: 'LEDGER_TOKEN (or JOB_SECRET) is not set on the server.' });
  if (!tokenMatches(req.get('x-ledger-token'))) return res.status(401).json({ error: 'Unauthorised.' });
  try {
    const ledger = await require('../services/predictionLedger').getLedger({ since: req.query.since || undefined });
    res.json(ledger);
  } catch (e) {
    console.error('❌ /api/ledger/predictions:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports._test = { tokenMatches };
