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
      holdings: getDemoPortfolio(),
      summary: getDemoSummary(),
      demo: true,
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
    return res.json({ success: true, demo: true, message: 'Holding added (demo mode)' });
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
  if (!supabaseAdmin) return res.json({ success: true, demo: true });
  const { data, error } = await supabaseAdmin.from('portfolios')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', holdingId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, holding: data });
});

// DELETE /api/portfolio/:holdingId — soft delete (mark inactive)
router.delete('/:holdingId', async (req, res) => {
  const { holdingId } = req.params;
  if (!supabaseAdmin) return res.json({ success: true, demo: true });
  const { error } = await supabaseAdmin.from('portfolios')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', holdingId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── DEMO DATA ──────────────────────────────────────
function getDemoPortfolio() {
  const holdings = [
    { id:'1', instrument_name:'Infosys Ltd', asset_class:'equity', sub_category:'large_cap', quantity:50, avg_buy_price_inr:1420, current_price_inr:1682, stop_loss_price:1320, target_price:1900, linked_goal:'Retirement at 55', allocation_pct:8.4 },
    { id:'2', instrument_name:'Mirae Asset Large Cap', asset_class:'mutual_fund', sub_category:'large_cap', quantity:2800, avg_buy_price_inr:52.4, current_price_inr:61.8, stop_loss_price:48.0, target_price:74.0, linked_goal:'Home Down Payment', allocation_pct:9.4 },
    { id:'3', instrument_name:'SBI Bluechip Fund', asset_class:'mutual_fund', sub_category:'large_cap', quantity:1500, avg_buy_price_inr:58.2, current_price_inr:64.1, stop_loss_price:54.0, linked_goal:"Priya's College", allocation_pct:5.2 },
    { id:'4', instrument_name:'Tata Motors Ltd', asset_class:'equity', sub_category:'large_cap', quantity:120, avg_buy_price_inr:680, current_price_inr:712, stop_loss_price:682, linked_goal:'Retirement at 55', allocation_pct:4.6 },
    { id:'5', instrument_name:'Gold ETF (Nippon)', asset_class:'gold', sub_category:'etf', quantity:30, avg_buy_price_inr:5200, current_price_inr:5840, stop_loss_price:4900, linked_goal:"Priya's College", allocation_pct:9.4 },
    { id:'6', instrument_name:'HDFC Liquid Fund', asset_class:'mutual_fund', sub_category:'liquid', quantity:200, avg_buy_price_inr:1500, current_price_inr:1548, stop_loss_price:null, linked_goal:'Emergency Fund', allocation_pct:16.8 },
    { id:'7', instrument_name:'G-Sec 7.26% 2032', asset_class:'bond', sub_category:'gsec', quantity:10, buy_price_inr:100, current_price_inr:102.4, stop_loss_price:null, linked_goal:'Retirement at 55', allocation_pct:0.6 },
  ];
  return holdings.map(h => ({
    ...h,
    current_value_inr: h.quantity * h.current_price_inr,
    unrealised_pnl_inr: h.quantity * (h.current_price_inr - h.avg_buy_price_inr),
    unrealised_pnl_pct: ((h.current_price_inr - h.avg_buy_price_inr) / h.avg_buy_price_inr * 100),
    sl_distance_pct: h.stop_loss_price ? ((h.current_price_inr - h.stop_loss_price) / h.current_price_inr * 100) : null,
    sl_status: h.stop_loss_price ? (((h.current_price_inr - h.stop_loss_price) / h.current_price_inr * 100) < 3 ? 'danger' : ((h.current_price_inr - h.stop_loss_price) / h.current_price_inr * 100) < 8 ? 'warn' : 'safe') : 'na',
  }));
}

function getDemoSummary() {
  return { total_value: 1843200, total_cost: 1600000, total_pnl: 243200, total_pnl_pct: 15.2, positions_count: 7, risk_status: 'GREEN' };
}

module.exports = router;
