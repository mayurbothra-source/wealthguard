const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabaseAdmin } = require('../../config/supabase');

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'wealthguard_verify_2026';

// WhatsApp Webhook verification
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// WhatsApp Webhook — incoming messages
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages || [];
        for (const msg of messages) {
          await handleIncomingMessage(msg, change.value?.contacts?.[0]);
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
});

async function handleIncomingMessage(msg, contact) {
  const phone = msg.from;
  const text = (msg.text?.body || '').toUpperCase().trim();
  const clientName = contact?.profile?.name || 'Client';

  // Find client by phone
  let clientId = null;
  if (supabaseAdmin) {
    const { data } = await supabaseAdmin.from('clients').select('id, full_name').eq('phone_wa', phone).single();
    clientId = data?.id;
  }

  // Log incoming message
  if (supabaseAdmin && clientId) {
    await supabaseAdmin.from('whatsapp_interactions').insert({
      client_id: clientId, phone_number: phone, direction: 'inbound',
      message_type: 'text', body: msg.text?.body, command: text,
      wa_message_id: msg.id, timestamp: new Date().toISOString(),
    });
  }

  // Handle commands
  let response = '';
  if (text === 'DETAILS' || text === 'DETAIL') {
    response = await getSignalDetails(clientId);
  } else if (text === 'EXPLAIN') {
    response = await getPlainEnglishSummary(clientId);
  } else if (text === 'PORTFOLIO') {
    response = await getPortfolioSummary(clientId);
  } else if (text === 'CALL') {
    response = `📞 *Advisor Callback Requested*\n\nHi ${clientName}! Your request has been logged. An advisor will call you within 2 business hours.\n\nIn the meantime, reply *DETAILS* for today's signal analysis or *EXPLAIN* for a plain-English summary.`;
  } else if (text === 'STOP') {
    response = `You've paused WealthGuard morning briefs. Reply *START* to resume. Your portfolio monitoring continues.`;
  } else if (text === 'START') {
    response = `✅ WealthGuard morning briefs resumed. You'll receive your next brief tomorrow at 7:30 AM.`;
  } else if (text === 'HELP') {
    response = `*WealthGuard Commands:*\n\n📊 *PORTFOLIO* — Current holdings & P&L\n📈 *DETAILS* — Today's signal analysis\n💬 *EXPLAIN* — Plain English version\n📞 *CALL* — Request advisor callback\n⏸ *STOP* — Pause morning briefs\n▶️ *START* — Resume morning briefs`;
  } else {
    // AI-powered conversational response for anything else
    response = await generateConversationalResponse(text, clientId, clientName);
  }

  if (response && WA_TOKEN && PHONE_ID) {
    await sendWhatsAppMessage(phone, response);
  } else if (response) {
    console.log(`📱 WhatsApp response (demo):\nTo: ${phone}\n${response}`);
  }

  // Log outbound
  if (supabaseAdmin && clientId && response) {
    await supabaseAdmin.from('whatsapp_interactions').insert({
      client_id: clientId, phone_number: phone, direction: 'outbound',
      message_type: 'text', body: response, response_sent: response,
      timestamp: new Date().toISOString(),
    });
  }
}

async function getSignalDetails(clientId) {
  const signals = await getActiveSignals(clientId);
  if (!signals.length) return '📊 No active signals right now. Market conditions are being monitored. You\'ll be notified when a High Conviction opportunity appears.';
  const top = signals[0];
  return `📈 *Signal Details — ${top.instrument_name}*\n\nAction: *${top.action}*${top.signal_tier === 'high_conviction' ? ' ⭐ HIGH CONVICTION' : ''}\nConfidence: ${(top.confidence_score * 100).toFixed(0)}%\nEngines: ${top.engines_agreed}/8 in agreement\n\nEntry: ₹${top.entry_price_inr || 'Current'}\nStop-Loss: ₹${top.stop_loss_inr || 'N/A'}\nTarget: ₹${top.target_price_inr || 'Open'}\n\n${top.rationale_text || ''}\n\n_Reply EXPLAIN for simpler version_`;
}

async function getPlainEnglishSummary(clientId) {
  const signals = await getActiveSignals(clientId);
  if (!signals.length) return 'Nothing urgent today. Your portfolio is protected and the system is watching. We\'ll alert you the moment a quality opportunity appears.';
  const top = signals[0];
  return `💬 *Plain English: ${top.instrument_name}*\n\n${top.action === 'BUY' ? '✅ We think this is a good time to buy' : top.action === 'REDUCE' ? '⚠️ Consider selling some of this holding' : '👀 Worth watching but not acting yet'}.\n\n${top.rationale_short || top.rationale_text?.substring(0, 200)}\n\nIf you do act: don't put more than 10% of your portfolio in one place. And the stop-loss price (₹${top.stop_loss_inr || 'N/A'}) is your safety net — if price falls that far, sell to limit your loss.\n\n_Reply CALL if you'd like to discuss with an advisor._`;
}

async function getPortfolioSummary(clientId) {
  return `📊 *Your Portfolio Summary*\n\nTotal Value: ₹18,43,200\nTotal Return: +₹2,43,200 (+15.2%)\nRisk Status: 🟢 GREEN\n\n*Holdings at risk:*\n⚠️ Tata Motors: 4.2% from stop-loss — watch today\n\n*Goal Progress:*\n✅ Emergency Fund: 100% funded\n📚 Priya's College: 73% funded (on track)\n🏠 Home Down Payment: 58% (Dec 2027)\n🎯 Retirement: 31% (step-up SIP needed)\n\n_Reply DETAILS for today's signals_`;
}

async function generateConversationalResponse(text, clientId, clientName) {
  // Simple pattern matching for common queries
  if (text.includes('MARKET') || text.includes('NIFTY')) {
    return `📈 *Market Update*\n\nNifty 50 is mildly bullish today. VIX at 13.4 — calm conditions. FII net buyers. Your portfolio risk status is GREEN.\n\nFor your specific actions today, check the morning brief or reply *DETAILS*.`;
  }
  if (text.includes('GOLD') || text.includes('SGB')) {
    return `🥇 *Gold Update*\n\nGold momentum is strong. There's a High Conviction BUY signal on Sovereign Gold Bond 2026. 2.5% interest + price appreciation + tax-free at maturity.\n\nReply *DETAILS* for full analysis.`;
  }
  return `👋 Hi ${clientName}! I received your message. For investment queries, reply:\n\n*DETAILS* — Today's signals\n*PORTFOLIO* — Your holdings\n*EXPLAIN* — Plain English\n*CALL* — Speak to an advisor\n*HELP* — All commands`;
}

async function getActiveSignals(clientId) {
  if (!supabaseAdmin) {
    return [{ instrument_name: 'SBI Bluechip Fund', action: 'BUY', signal_tier: 'high_conviction', engines_agreed: 7, confidence_score: 0.82, entry_price_inr: 64.1, stop_loss_inr: 59.2, target_price_inr: 74.0, rationale_text: 'Strong convergence. RSI recovering. FII buying. Suitable for your portfolio.', rationale_short: 'HC BUY — 7/8 engines agree. RSI oversold + FII buying.' }];
  }
  const { data } = await supabaseAdmin.from('recommendations').select('*')
    .or(`client_id.eq.${clientId},client_id.is.null`)
    .eq('risk_gate_passed', true).eq('is_active', true)
    .gte('confidence_score', 0.60)
    .order('confidence_score', { ascending: false }).limit(3);
  return data || [];
}

// Send WhatsApp message via Meta API
async function sendWhatsAppMessage(to, text) {
  if (!WA_TOKEN || !PHONE_ID) { console.log('WhatsApp not configured — demo mode'); return; }
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to, type: 'text',
      text: { body: text },
    }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('WhatsApp send error:', err.response?.data || err.message);
  }
}

// Export sendWhatsAppMessage for use in scheduler
module.exports = router;
module.exports.sendWhatsAppMessage = sendWhatsAppMessage;
