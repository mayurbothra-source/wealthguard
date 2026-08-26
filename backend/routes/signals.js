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
    return res.json({ signals: getDemoSignals(), demo: true });
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

function getDemoSignals() {
  return [
    { id:'s1', action:'BUY', signal_tier:'high_conviction', instrument_name:'SBI Bluechip Fund', asset_class:'mutual_fund', engines_agreed:7, confidence_score:0.82, entry_price_inr:64.1, stop_loss_inr:59.2, target_price_inr:74.0, risk_reward_ratio:2.1, rationale_text:'Strong convergence across 7 of 8 engines. RSI recovering from oversold at 38. FII net buyers in large-cap MFs for 3 consecutive weeks. PE at 24.2x — below sector average. High Conviction BUY — suitable for your Home Down Payment bucket.', rationale_short:'HC BUY — 7/8 engines agree. RSI oversold + FII buying. SL: ₹59.2.', engines_detail_json:{technical:'bullish',fundamental:'bullish',management:'bullish',sentiment:'bullish',institutional:'bullish',sector_rotation:'bullish',pestle:'bullish',porters:'neutral'} },
    { id:'s2', action:'BUY', signal_tier:'standard', instrument_name:'Sovereign Gold Bond 2026', asset_class:'gold', engines_agreed:6, confidence_score:0.76, entry_price_inr:6240, stop_loss_inr:5800, target_price_inr:7200, risk_reward_ratio:2.3, rationale_text:'High Conviction BUY on SGB. Gold momentum strong as USD weakens. 2.5% interest p.a. + gold price appreciation + capital gains tax exempt at maturity. FII rotations to gold observed. Recommended for Retirement bucket at 5% allocation.', rationale_short:'BUY SGB — Gold momentum + tax benefits. SL: ₹5,800.', engines_detail_json:{technical:'bullish',fundamental:'bullish',management:'neutral',sentiment:'bullish',institutional:'bullish',sector_rotation:'bullish',pestle:'bullish',porters:'neutral'} },
    { id:'s3', action:'REDUCE', signal_tier:'standard', instrument_name:'Tata Motors Ltd', asset_class:'equity', engines_agreed:4, confidence_score:0.64, entry_price_inr:712, stop_loss_inr:682, rationale_text:'REDUCE 40% of position. Stop-loss at ₹682 is 4.2% away. Promoter pledging increased from 12% to 18% — management quality flag. EV transition competitive pressure scoring high. Consider booking partial profits now.', rationale_short:'REDUCE Tata Motors — SL close (4.2%). Promoter pledge rising. Exit 40% now.', engines_detail_json:{technical:'bearish',fundamental:'neutral',management:'bearish',sentiment:'bearish',institutional:'neutral',sector_rotation:'neutral',pestle:'neutral',porters:'bearish'} },
    { id:'s4', action:'WATCH', signal_tier:'watchlist', instrument_name:'Bajaj Finance Ltd', asset_class:'equity', engines_agreed:4, confidence_score:0.58, rationale_text:'Watchlist only. 4 engines positive but below High Conviction threshold. Rate environment uncertain — NBFCs rate-sensitive. Wait for RSI pullback below 45 before entering. PE 28x slightly above comfort zone.', rationale_short:'WATCH Bajaj Finance — await better entry. RSI pullback to 45 = entry signal.', engines_detail_json:{technical:'neutral',fundamental:'bullish',management:'bullish',sentiment:'neutral',institutional:'bullish',sector_rotation:'bullish',pestle:'bearish',porters:'neutral'} },
    { id:'s5', action:'BUY', signal_tier:'standard', instrument_name:'Nifty BeES ETF', asset_class:'equity', engines_agreed:5, confidence_score:0.68, entry_price_inr:245.6, stop_loss_inr:228.0, target_price_inr:278.0, risk_reward_ratio:1.8, rationale_text:'Standard BUY. Market regime strongly bullish — Nifty above 200 DMA, VIX at 13.4. ETF provides broad large-cap exposure at low cost. Suitable for Retirement bucket. FII net buyers for 5 consecutive sessions.', rationale_short:'BUY Nifty BeES — bull regime confirmed. SL: ₹228. Retirement bucket.', engines_detail_json:{technical:'bullish',fundamental:'bullish',management:'neutral',sentiment:'bullish',institutional:'bullish',sector_rotation:'neutral',pestle:'bullish',porters:'neutral'} },
  ];
}

module.exports = router;
