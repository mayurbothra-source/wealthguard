const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { requireSession, ownsParam } = require('../lib/session');
const { getEntitlement } = require('../lib/entitlements');

// GET /api/signals/:clientId — active signals for the signed-in client
// (house-level signals plus any addressed to this client).
//
// POST /api/signals/generate used to live here. It ran the legacy eight-engine
// analysis against tables the current pipeline no longer fills, was open to
// anyone, and stored the Nifty index level as a stock's entry price. Signals
// are now produced only by the scheduled instrumentEngine.
router.get('/:clientId', requireSession, ownsParam('clientId'), async (req, res) => {
  const { clientId } = req.params;
  const { tier, action } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

  if (!supabaseAdmin) {
    return res.status(503).json({
      signals: [],
      unavailable: true,
      message: 'Signals are temporarily unavailable. Nothing is shown rather than anything uncertain.',
    });
  }

  try {
    const ent = await getEntitlement(supabaseAdmin, clientId);
    if (ent.access !== 'full') {
      return res.json({
        signals: [], count: 0, access: ent.access, plan: ent.plan,
        message: ent.access === 'read_only'
          ? 'Your plan has lapsed, so live signals are paused. Your history stays visible.'
          : 'Choose a plan to see live signals.',
      });
    }
    let query = supabaseAdmin
      .from('recommendations')
      .select('*')
      .or(`client_id.eq.${clientId},client_id.is.null`)
      .eq('risk_gate_passed', true)
      .eq('is_active', true)
      .gte('confidence_score', 0.60)
      .order('generated_at', { ascending: false })
      .limit(Math.min(limit, ent.signalLimit));

    if (tier) query = query.eq('signal_tier', tier);
    if (action) query = query.eq('action', action);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ signals: data, count: data.length, plan: ent.plan, signal_limit: ent.signalLimit, access: ent.access });
  } catch (err) {
    console.error('signals GET:', err.message);
    res.status(500).json({ error: 'Could not load signals.' });
  }
});

module.exports = router;
