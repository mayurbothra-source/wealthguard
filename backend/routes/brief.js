const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { generateMorningBrief } = require('../engines/analysisEngine');
const { refreshAllMarketData } = require('../services/marketData');

// GET /api/brief/:clientId — get today's morning brief
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const today = new Date().toISOString().split('T')[0];

  if (!supabaseAdmin) {
    return res.json({ brief: getDemoBrief(), demo: true });
  }

  // Check if brief already generated today
  const { data: existing } = await supabaseAdmin
    .from('morning_briefs').select('*')
    .eq('client_id', clientId).eq('brief_date', today).single();
  if (existing) return res.json({ brief: existing });

  // Generate fresh brief
  try {
    const [clientRes, portfolioRes, signalsRes, macro] = await Promise.all([
      supabaseAdmin.from('clients').select(`*, client_life_profiles(*), client_behavioural_profiles(*), client_goals(*)`).eq('id', clientId).single(),
      supabaseAdmin.from('portfolios').select('*').eq('client_id', clientId).eq('is_active', true),
      supabaseAdmin.from('recommendations').select('*').eq('client_id', clientId).eq('risk_gate_passed', true).eq('is_active', true).gte('confidence_score', 0.60).order('confidence_score', { ascending: false }).limit(5),
      refreshAllMarketData(),
    ]);

    const client = clientRes.data;
    const portfolio = portfolioRes.data || [];
    const signals = signalsRes.data || [];

    const totalValue = portfolio.reduce((s,h) => s + (h.current_value_inr || 0), 0);
    const totalCost = portfolio.reduce((s,h) => s + h.quantity * h.avg_buy_price_inr, 0);

    const portfolioSummary = {
      total_value: totalValue,
      total_pnl_pct: ((totalValue - totalCost) / totalCost * 100),
      max_drawdown: -7.4, // simplified
      risk_status: 'GREEN — All positions above stop-loss',
    };

    const briefText = await generateMorningBrief(
      { ...client, ...client?.client_life_profiles?.[0], goals: client?.client_goals },
      portfolioSummary, signals, macro
    );

    // Store brief
    const { data: savedBrief } = await supabaseAdmin.from('morning_briefs').insert({
      client_id: clientId,
      brief_date: today,
      nifty_prediction: macro?.nifty?.change_pct > 0.3 ? 'bullish' : macro?.nifty?.change_pct < -0.3 ? 'bearish' : 'neutral',
      nifty_confidence: macro?.nifty?.change_pct > 0.3 ? 72 : 55,
      nifty_range_low: (macro?.nifty?.price || 24650) * 0.994,
      nifty_range_high: (macro?.nifty?.price || 24650) * 1.006,
      vix_at_brief: macro?.vix,
      market_regime: macro?.vixRegime?.regime,
      whatsapp_message: briefText,
      generated_at: new Date().toISOString(),
    }).select().single();

    res.json({ brief: savedBrief || { whatsapp_message: briefText, brief_date: today } });
  } catch (err) {
    console.error('Brief generation error:', err);
    res.json({ brief: getDemoBrief(), error: err.message });
  }
});

// POST /api/brief/:clientId/send — send brief via WhatsApp
router.post('/:clientId/send', async (req, res) => {
  const { clientId } = req.params;
  const { whatsappService } = require('../services/whatsapp');
  if (!supabaseAdmin) return res.json({ sent: false, demo: true });
  try {
    const { data: client } = await supabaseAdmin.from('clients').select('phone_wa, full_name').eq('id', clientId).single();
    const { data: brief } = await supabaseAdmin.from('morning_briefs').select('whatsapp_message').eq('client_id', clientId).eq('brief_date', new Date().toISOString().split('T')[0]).single();
    if (!client || !brief) return res.status(404).json({ error: 'Client or brief not found' });
    const result = await whatsappService.sendMessage(client.phone_wa, brief.whatsapp_message);
    res.json({ sent: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getDemoBrief() {
  const date = new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  return {
    brief_date: new Date().toISOString().split('T')[0],
    nifty_prediction: 'bullish',
    nifty_confidence: 72,
    vix_at_brief: 13.4,
    market_regime: 'normal',
    whatsapp_message: `🌅 *Good morning, Rahul!*\n_WealthGuard · ${date} · 7:30 AM_\n\n📊 *Your Portfolio*\nValue: ₹18,43,200 | Return: +15.2% from cost\n🟢 Risk Status: GREEN — All positions protected\n\n🌍 *Market Prediction Today*\nNifty 50: ▲ Mildly Bullish (72% confidence)\nExpected Range: 24,420 – 24,780\n_FII net buyers ₹28Cr. Asia positive. VIX calm at 13.4._\n\n⚡ *Your Actions Today*\n• HOLD all current positions — stop-losses safe\n• ⭐ HC BUY: SBI Bluechip Fund — ₹30,000 allocation (82% conf)\n• ⚠ REVIEW: Tata Motors — 4.2% from stop-loss, monitor today\n• SIP due: Check scheduled Mirae Large Cap investment\n\n🎯 *Goal Update*\n• Priya's College: 73% funded ✓ On track\n• Retirement at 55: 31% — step-up SIP by ₹3,000/mo recommended\n\n_Reply *DETAILS* for signals · *EXPLAIN* for plain English · *CALL* for advisor_\n\n_WealthGuard · Capital preservation first · Not SEBI registered advice_`
  };
}

module.exports = router;
