const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const db = require('../lib/db');
const { requireSession, ownsParam } = require('../lib/session');
const { limit } = require('../lib/rateLimit');
const { generateBriefForClient, istDate } = require('../services/morningBriefEngine');

// Building a brief touches several tables; cap how often one client can ask.
const buildLimiter = limit({ windowMs: 10 * 60e3, max: 12, key: req => req.auth && req.auth.clientId || req.ip });

// GET /api/brief/:clientId — today's brief for the signed-in client.
//
// 1. Return the stored brief for today if the 07:30 run made one.
// 2. Otherwise build it NOW (a client who joined after 07:30, or a morning the
//    scheduler missed, used to see "arrives tomorrow" and nothing else).
// 3. If even that fails, fall back to the most recent brief, clearly marked stale.
router.get('/:clientId', requireSession, ownsParam('clientId'), buildLimiter, async (req, res) => {
  const { clientId } = req.params;
  const today = istDate();

  if (!supabaseAdmin) {
    return res.status(503).json({
      brief: null, unavailable: true,
      message: 'Your brief is temporarily unavailable.',
    });
  }

  const stored = await db.selectOne('morning_briefs', c =>
    c.from('morning_briefs').select('*')
      .eq('client_id', clientId).eq('brief_date', today).maybeSingle());
  if (stored) return res.json({ brief: stored });

  try {
    const built = await generateBriefForClient(clientId);
    if (built) return res.json({ brief: built, generated_on_demand: true });
  } catch (e) {
    console.warn(`   ⚠ On-demand brief failed for ${clientId}: ${e.message}`);
  }

  const last = await db.selectOne('morning_briefs', c =>
    c.from('morning_briefs').select('*')
      .eq('client_id', clientId)
      .order('brief_date', { ascending: false }).limit(1).maybeSingle());
  if (last) return res.json({ brief: last, stale: true });

  return res.json({
    brief: null,
    message: "We couldn't prepare your brief just now. Please try again in a few minutes.",
  });
});

module.exports = router;
