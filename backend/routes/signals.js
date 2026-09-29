const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { runFullAnalysis } = require('../engines/analysisEngine');
const { runRiskGate } = require('../engines/riskGate');
const { refreshAllMarketData } = require('../services/marketData');

// GET /api/signals/:clientId — fetch active signals for client
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { tier, action, limit = 20 } = req.query;

  if (!supabaseAdmin) {
    // The service key is not configured, so there is no database to read.
    // This used to return hardcoded "demo" data that the frontend had no way
    // to distinguish from real output — including fabricated BUY calls with
    // invented stop-losses. Returning real emptiness is the only honest
    // answer, and the frontend's existing empty states handle it.
    return res.status(503).json({
      signals: [],
      unavailable: true,
      message: 'Signals are temporarily unavailable. Nothing is shown rather than anything uncertain.',
    });
  }

  try {
    let query = supabaseAdmin
      .from('recommendations')
      .select('*')
      .or(`client_id.eq.${clientId},client_id.is.null`)
      .eq('risk_gate_passed', true)
      .eq('is_active', true)
      .gte('confidence_score', 0.60)
      .order('generated_at', { ascending: false })
      .limit(parseInt(limit));

    if (tier) query = query.eq('signal_tier', tier);
    if (action) query = query.eq('action', action);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ signals: data, count: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signals/generate — run analysis engine for an instrument
router.post('/generate', async (req, res) => {
  const { instrument_id, client_id } = req.body;

  try {
    // Fetch all required data
    const macro = await refreshAllMarketData();

    let instrument = null, technicalData = null, fundamentalData = null,
        sentimentData = null, pestleData = [], clientProfile = null, behaviouralProfile = null;

    if (supabaseAdmin) {
      const [instrRes, techRes, fundRes, sentRes, pestleRes, clientRes, behavRes] = await Promise.all([
        supabaseAdmin.from('instruments').select('*').eq('id', instrument_id).single(),
        supabaseAdmin.from('technical_signals').select('*').eq('instrument_id', instrument_id).order('computed_at', { ascending: false }).limit(1).single(),
        supabaseAdmin.from('fundamental_scores').select('*').eq('instrument_id', instrument_id).order('scored_at', { ascending: false }).limit(1).single(),
        supabaseAdmin.from('sentiment_scores').select('*').eq('instrument_id', instrument_id).order('scored_at', { ascending: false }).limit(1).single(),
        supabaseAdmin.from('pestle_scores').select('*').order('recorded_at', { ascending: false }).limit(20),
        client_id ? supabaseAdmin.from('client_life_profiles').select('*').eq('client_id', client_id).order('assessed_at', { ascending: false }).limit(1).single() : Promise.resolve({ data: null }),
        client_id ? supabaseAdmin.from('client_behavioural_profiles').select('*').eq('client_id', client_id).order('assessed_at', { ascending: false }).limit(1).single() : Promise.resolve({ data: null }),
      ]);
      instrument = instrRes.data;
      technicalData = techRes.data;
      fundamentalData = fundRes.data;
      sentimentData = sentRes.data;
      pestleData = pestleRes.data || [];
      clientProfile = clientRes.data;
      behaviouralProfile = behavRes.data;
    } else {
      instrument = { id: instrument_id, name: 'Demo Instrument', asset_class: 'equity', sub_category: 'large_cap', risk_tier: 3, min_risk_score_required: 5 };
    }

    const analysis = await runFullAnalysis(
      instrument, technicalData, fundamentalData, sentimentData,
      pestleData, macro?.flows, macro, clientProfile,
      null // use equal weights for now
    );

    if (analysis.convergence?.action === 'BLOCK') {
      return res.json({ blocked: true, reasons: analysis.convergence });
    }

    // Run risk gate
    const portfolio = supabaseAdmin
      ? (await supabaseAdmin.from('portfolios').select('*').eq('client_id', client_id).eq('is_active', true)).data || []
      : [];

    analysis.risk_gate = await runRiskGate(
      { ...analysis, instrument, convergence: analysis.convergence },
      clientProfile, behaviouralProfile, portfolio, macro
    );

    // Store recommendation
    if (supabaseAdmin && analysis.risk_gate.passed) {
      const entryPrice = macro?.nifty?.price; // simplified
      const { data: rec } = await supabaseAdmin.from('recommendations').insert({
        client_id: client_id || null,
        instrument_id: instrument?.id,
        instrument_name: instrument?.name,
        action: analysis.convergence.action,
        signal_tier: analysis.convergence.tier,
        engines_agreed: analysis.convergence.bullishCount,
        engines_detail_json: analysis.convergence.engines_detail,
        confidence_score: analysis.convergence.confidence,
        rationale_text: analysis.rationale?.full,
        rationale_short: analysis.rationale?.short,
        risk_gate_passed: true,
        market_regime: macro?.vixRegime?.regime,
        india_vix_at_signal: macro?.vix,
        valid_until: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      }).select().single();
      analysis.saved_recommendation = rec;
    }

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('Signal generation error:', err);
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
