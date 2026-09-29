const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const db = require('../lib/db');

// GET /api/brief/:clientId — return TODAY'S STORED BRIEF
//
// This used to generate a brief on the fly with engines/analysisEngine's
// generateMorningBrief(), which is a different implementation from the
// morningBriefEngine the 07:30 scheduler runs. The result was two briefs
// per client per day, from two engines, with different content: the client
// read one in the app and received the other by email.
//
// Now it reads what the scheduled engine stored. One brief, one source of
// truth, and the in-app Daily Brief tab shows exactly what was emailed.
// Requires migration 002_morning_briefs_align.sql — without it the engine
// cannot persist and this returns empty.
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const today = new Date().toISOString().split('T')[0];

  if (!supabaseAdmin) {
    return res.status(503).json({
      brief: null, unavailable: true,
      message: 'Your brief is temporarily unavailable.',
    });
  }

  // maybeSingle(), not single(): single() treats "no rows" as an error, and
  // no brief yet is an ordinary state, not a failure.
  const brief = await db.selectOne('morning_briefs', c =>
    c.from('morning_briefs').select('*')
      .eq('client_id', clientId).eq('brief_date', today).maybeSingle());

  if (brief) return res.json({ brief });

  // Nothing for today. Offer the most recent one so the tab is not blank,
  // clearly labelled with its own date.
  const last = await db.selectOne('morning_briefs', c =>
    c.from('morning_briefs').select('*')
      .eq('client_id', clientId)
      .order('brief_date', { ascending: false }).limit(1));

  if (last) return res.json({ brief: last, stale: true });

  return res.json({
    brief: null,
    message: "No brief yet. Yours is generated at 7:30 AM IST on weekdays once your profile and portfolio are set up.",
  });
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



module.exports = router;
