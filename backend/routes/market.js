const express = require('express');
const router = express.Router();
const { refreshAllMarketData, classifyVIXRegime, getNSEQuote } = require('../services/marketData');

// GET /api/market/snapshot — full market snapshot
router.get('/snapshot', async (req, res) => {
  try {
    const snapshot = await refreshAllMarketData();
    res.json({ success: true, data: snapshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/market/quote/:symbol
router.get('/quote/:symbol', async (req, res) => {
  const quote = await getNSEQuote(req.params.symbol.toUpperCase());
  res.json({ success: true, quote });
});

// GET /api/market/regime — current VIX regime
router.get('/regime', async (req, res) => {
  const { getIndiaVIX } = require('../services/marketData');
  const vix = await getIndiaVIX();
  const regime = classifyVIXRegime(vix);
  res.json({ vix, ...regime });
});

// GET /api/market/instruments — full universe list for the Add Holding dropdown
// Returns name, symbol, category/asset_class for every tracked instrument.
// Public — no auth needed; the list itself is not sensitive.
router.get('/instruments', async (req, res) => {
  try {
    const { supabaseAdmin } = require('../../config/supabase');
    const { data, error } = await supabaseAdmin
      .from('instrument_universe')
      .select('symbol, name, category')
      .order('category')
      .order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ instruments: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
