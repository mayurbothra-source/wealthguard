const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { getNSEQuote } = require('../services/marketData');
const { requireSession, ownsParam, ownsBody } = require('../lib/session');
const { HOLDING_EDITABLE, only } = require('../lib/clientFields');

// A holding is trailed to this fraction of price once it is 15%+ in profit.
// (The comment used to say 85% while the code used 88%; the code was the
// behaviour, so 88% is now the stated rule.)
const TRAIL_TRIGGER = 1.15;
const TRAIL_FRACTION = 0.88;

const unavailable = (res, what = 'save') => res.status(503).json({
  success: false, unavailable: true,
  error: `Could not ${what} right now — no change was made. Please try again shortly.`,
});

/** Loads a holding and confirms it belongs to the caller. Returns the row or null. */
async function ownedHolding(req) {
  const { data } = await supabaseAdmin.from('portfolios')
    .select('*').eq('id', req.params.holdingId).maybeSingle();
  if (!data) return null;
  if (!req.auth.soft && String(data.client_id) !== String(req.auth.clientId)) return null;
  return data;
}

// GET /api/portfolio/:clientId — full portfolio with live prices
router.get('/:clientId', requireSession, ownsParam('clientId'), async (req, res) => {
  const { clientId } = req.params;

  if (!supabaseAdmin) {
    return res.json({
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

    const enriched = await Promise.all(holdings.map(async (h) => {
      let livePrice = Number(h.current_price_inr) || Number(h.avg_buy_price_inr);
      try {
        if (h.asset_class === 'equity' && h.instrument_id) {
          const quote = await getNSEQuote(h.instrument_name);
          if (quote?.price && quote.source !== 'demo') livePrice = quote.price;
        }
      } catch {}

      // ONE effective stop: the higher of the stop the client set, any stop
      // already trailed up, and — if the position is well in profit — a fresh
      // trail. Previously the trail was written to trailing_sl_price but the
      // distance was always measured against stop_loss_price, so a trailed
      // stop never showed up in the risk status.
      let stop = Math.max(Number(h.stop_loss_price) || 0, Number(h.trailing_sl_price) || 0) || null;
      let trailedTo = null;
      if (livePrice > Number(h.avg_buy_price_inr) * TRAIL_TRIGGER) {
        const candidate = Math.round(livePrice * TRAIL_FRACTION * 100) / 100;
        if (candidate > (stop || 0)) { stop = candidate; trailedTo = candidate; }
      }

      const qty = Number(h.quantity), cost = qty * Number(h.avg_buy_price_inr);
      const currentValue = qty * livePrice;
      const pnl = currentValue - cost;
      const slDistance = stop ? ((livePrice - stop) / livePrice * 100) : null;
      return {
        ...h,
        current_price_inr: livePrice,
        current_value_inr: currentValue,
        unrealised_pnl_inr: pnl,
        unrealised_pnl_pct: cost > 0 ? (pnl / cost) * 100 : 0,
        effective_stop_price: stop,
        sl_distance_pct: slDistance,
        sl_status: slDistance == null ? 'na' : slDistance < 3 ? 'danger' : slDistance < 8 ? 'warn' : 'safe',
        _trailedTo: trailedTo,
      };
    }));

    // Persist a trail only when it RAISES the stop (monotonic, idempotent), so
    // repeated page loads cannot move it down or change anything twice.
    for (const h of enriched) {
      if (h._trailedTo) {
        await supabaseAdmin.from('portfolios').update({
          trailing_sl_price: h._trailedTo,
          current_price_inr: h.current_price_inr,
          current_value_inr: h.current_value_inr,
          unrealised_pnl_inr: h.unrealised_pnl_inr,
          unrealised_pnl_pct: h.unrealised_pnl_pct,
          updated_at: new Date().toISOString(),
        }).eq('id', h.id).eq('client_id', clientId);
      }
      delete h._trailedTo;
    }

    const totalValue = enriched.reduce((s,h) => s + h.current_value_inr, 0);
    const totalCost = enriched.reduce((s,h) => s + h.quantity * h.avg_buy_price_inr, 0);
    const totalPnL = totalValue - totalCost;

    const withAllocation = enriched.map(h => ({
      ...h,
      allocation_pct: totalValue > 0 ? (h.current_value_inr / totalValue) * 100 : 0,
    }));

    res.json({
      holdings: withAllocation,
      summary: {
        total_value: totalValue,
        total_cost: totalCost,
        total_pnl: totalPnL,
        total_pnl_pct: totalCost > 0 ? (totalPnL / totalCost) * 100 : 0,
        positions_count: enriched.length,
        risk_status: enriched.some(h => h.sl_status === 'danger') ? 'RED' : enriched.some(h => h.sl_status === 'warn') ? 'AMBER' : 'GREEN',
      }
    });
  } catch (err) {
    console.error('portfolio GET:', err.message);
    res.status(500).json({ error: 'Could not load your portfolio.' });
  }
});

// POST /api/portfolio/add — add a holding manually
router.post('/add', requireSession, ownsBody('client_id'), async (req, res) => {
  const f = only(req.body, HOLDING_EDITABLE);
  const quantity = Number(f.quantity), avg = Number(f.avg_buy_price_inr);

  if (!f.instrument_name || !(quantity > 0) || !(avg > 0)) {
    return res.status(400).json({ error: 'instrument_name, a positive quantity and a positive avg_buy_price_inr are required' });
  }
  if (!supabaseAdmin) return unavailable(res);

  try {
    const currPrice = Number(f.current_price_inr) > 0 ? Number(f.current_price_inr) : avg;
    const { data, error } = await supabaseAdmin.from('portfolios').insert({
      client_id: req.auth.clientId,
      instrument_name: String(f.instrument_name).slice(0, 120),
      asset_class: f.asset_class || 'equity',
      quantity, avg_buy_price_inr: avg, current_price_inr: currPrice,
      current_value_inr: quantity * currPrice,
      stop_loss_price: f.stop_loss_price || null, target_price: f.target_price || null,
      linked_goal_id: f.linked_goal_id || null, notes: f.notes || null,
      buy_date: new Date().toISOString().split('T')[0],
      entry_source: 'manual',
    }).select().single();
    if (error) throw error;
    res.json({ success: true, holding: data });
  } catch (err) {
    console.error('portfolio add:', err.message);
    res.status(500).json({ success: false, error: 'Could not save your holding.' });
  }
});

// PUT /api/portfolio/:holdingId — update price or stop-loss (own holdings only)
router.put('/:holdingId', requireSession, async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const holding = await ownedHolding(req);
  if (!holding) return res.status(404).json({ error: 'Holding not found.' });

  // client_id, is_active and the rest are not editable; only the listed fields.
  const updates = only(req.body, HOLDING_EDITABLE);
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });
  const { data, error } = await supabaseAdmin.from('portfolios')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', holding.id).eq('client_id', holding.client_id).select().single();
  if (error) return res.status(500).json({ error: 'Could not save your change.' });
  res.json({ success: true, holding: data });
});

// DELETE /api/portfolio/:holdingId — soft delete (own holdings only)
router.delete('/:holdingId', requireSession, async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const holding = await ownedHolding(req);
  if (!holding) return res.status(404).json({ error: 'Holding not found.' });
  const { error } = await supabaseAdmin.from('portfolios')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', holding.id).eq('client_id', holding.client_id);
  if (error) return res.status(500).json({ error: 'Could not remove the holding.' });
  res.json({ success: true });
});

module.exports = router;
