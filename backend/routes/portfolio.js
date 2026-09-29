const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { getNSEQuote, getMFNav } = require('../services/marketData');

// GET /api/portfolio/:clientId — full portfolio with live prices
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;

  if (!supabaseAdmin) {
    // Return demo portfolio
    return res.json({
      // Invented holdings (₹18.43 lakh, with stop-loss distances and a
      // GREEN risk status) used to be returned here. A client seeing those
      // as their own portfolio is the worst possible failure mode.
      holdings: [],
      summary: { total_value: 0, total_cost: 0, total_pnl: 0, total_pnl_pct: 0,
                 positions_count: 0, risk_status: 'UNKNOWN' },
      unavailable: true,
      message: 'Your portfolio is temporarily unavailable.',
    });
  }

  try {
    const { data: holdings, error } = await supabaseAdmin
      .from('portfolios')
      .select(`*, client_goals(goal_name, goal_type)`)
      .eq('client_id', clientId)
      .eq('is_active', true);
    if (error) throw error;

    // Refresh prices for each holding
    const enriched = await Promise.all(holdings.map(async (h) => {
      let livePrice = h.current_price_inr;
      try {
        if (h.asset_class === 'equity' && h.instrument_id) {
          const quote = await getNSEQuote(h.instrument_name);
          if (quote?.price) livePrice = quote.price;
        }
      } catch {}
      const currentValue = h.quantity * livePrice;
      const pnl = currentValue - (h.quantity * h.avg_buy_price_inr);
      const pnlPct = (pnl / (h.quantity * h.avg_buy_price_inr)) * 100;
      const slDistance = h.stop_loss_price ? ((livePrice - h.stop_loss_price) / livePrice * 100) : null;
      return {
        ...h,
        current_price_inr: livePrice,
        current_value_inr: currentValue,
        unrealised_pnl_inr: pnl,
        unrealised_pnl_pct: pnlPct,
        sl_distance_pct: slDistance,
        sl_status: !slDistance ? 'na' : slDistance < 3 ? 'danger' : slDistance < 8 ? 'warn' : 'safe',
      };
    }));

    // Update trailing stop-losses
    for (const h of enriched) {
      if (h.sl_status === 'safe' && h.current_price_inr > h.avg_buy_price_inr * 1.15) {
        // Trail stop-loss to 85% of current price if significantly profitable
        const newSL = h.current_price_inr * 0.88;
        if (newSL > (h.stop_loss_price || 0)) {
          await supabaseAdmin.from('portfolios').update({
            trailing_sl_price: newSL,
            current_price_inr: h.current_price_inr,
            current_value_inr: h.current_value_inr,
            unrealised_pnl_inr: h.unrealised_pnl_inr,
            unrealised_pnl_pct: h.unrealised_pnl_pct,
            updated_at: new Date().toISOString(),
          }).eq('id', h.id);
        }
      }
    }

    const totalValue = enriched.reduce((s,h) => s + h.current_value_inr, 0);
    const totalCost = enriched.reduce((s,h) => s + h.quantity * h.avg_buy_price_inr, 0);
    const totalPnL = totalValue - totalCost;
    const totalPnLPct = (totalPnL / totalCost) * 100;

    // Add allocation %
    const withAllocation = enriched.map(h => ({
      ...h,
      allocation_pct: (h.current_value_inr / totalValue) * 100
    }));

    res.json({
      holdings: withAllocation,
      summary: {
        total_value: totalValue,
        total_cost: totalCost,
        total_pnl: totalPnL,
        total_pnl_pct: totalPnLPct,
        positions_count: enriched.length,
        risk_status: enriched.some(h => h.sl_status === 'danger') ? 'RED' : enriched.some(h => h.sl_status === 'warn') ? 'AMBER' : 'GREEN',
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portfolio/add — add a holding manually
router.post('/add', async (req, res) => {
  const { client_id, instrument_name, asset_class, quantity, avg_buy_price_inr,
          current_price_inr, stop_loss_price, target_price, linked_goal_id, notes } = req.body;

  if (!client_id || !instrument_name || !quantity || !avg_buy_price_inr) {
    return res.status(400).json({ error: 'client_id, instrument_name, quantity, avg_buy_price_inr required' });
  }

  if (!supabaseAdmin) {
    // Returning success here told the client their holding was saved when
    // nothing was written. A 503 is the honest answer.
    return res.status(503).json({
      success: false, unavailable: true,
      error: 'Could not save right now — your holding was not recorded. Please try again shortly.',
    });
  }

  try {
    const currPrice = current_price_inr || avg_buy_price_inr;
    const { data, error } = await supabaseAdmin.from('portfolios').insert({
      client_id, instrument_name, asset_class: asset_class || 'equity',
      quantity, avg_buy_price_inr, current_price_inr: currPrice,
      current_value_inr: quantity * currPrice,
      stop_loss_price, target_price, linked_goal_id, notes,
      buy_date: new Date().toISOString().split('T')[0],
      entry_source: 'manual',
    }).select().single();
    if (error) throw error;
    res.json({ success: true, holding: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/portfolio/:holdingId — update price or stop-loss
router.put('/:holdingId', async (req, res) => {
  const { holdingId } = req.params;
  const updates = req.body;
  // Never report success for a write that did not happen.
  if (!supabaseAdmin) return res.status(503).json({
    success: false, unavailable: true,
    error: 'Could not save right now — no change was made. Please try again shortly.',
  });
  const { data, error } = await supabaseAdmin.from('portfolios')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', holdingId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, holding: data });
});

// DELETE /api/portfolio/:holdingId — soft delete (mark inactive)
router.delete('/:holdingId', async (req, res) => {
  const { holdingId } = req.params;
  // Never report success for a write that did not happen.
  if (!supabaseAdmin) return res.status(503).json({
    success: false, unavailable: true,
    error: 'Could not save right now — no change was made. Please try again shortly.',
  });
  const { error } = await supabaseAdmin.from('portfolios')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', holdingId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── DEMO DATA ──────────────────────────────────────




module.exports = router;
