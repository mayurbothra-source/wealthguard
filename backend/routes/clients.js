const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');

router.get('/:clientId/profile', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({
    profile: null, unavailable: true,
    message: 'Your profile is temporarily unavailable.',
  });
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select(`*, client_life_profiles(*), client_behavioural_profiles(*), client_goals(*)`)
    .eq('id', req.params.clientId).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

router.put('/:clientId/profile', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({
    success: false, unavailable: true,
    error: 'Could not save your profile right now — no change was made.',
  });
  const { type, updates } = req.body;
  const table = type === 'life' ? 'client_life_profiles' : type === 'behavioural' ? 'client_behavioural_profiles' : 'clients';
  const { error } = await supabaseAdmin.from(table).update({ ...updates, assessed_at: new Date().toISOString() }).eq('client_id', req.params.clientId);
  if (error) return res.status(500).json({ error: error.message });
  // Log change
  await supabaseAdmin.from('profile_change_events').insert({ client_id: req.params.clientId, event_type: 'client_initiated', trigger_description: `Client updated ${type} profile`, fields_changed_json: updates });
  res.json({ success: true });
});



// ── POST /api/clients/:clientId/email ────────────────────────────────
// Saves or changes the address a client's morning brief and flash alerts go
// to. The frontend called this route before it existed: Express matched
// nothing, the SPA fallback ignored /api paths without responding, and the
// request HUNG until the browser's 60-second timeout — which looked exactly
// like account creation failing.
router.post('/:clientId/email', async (req, res) => {
  const { clientId } = req.params;
  const raw = (req.body && req.body.email) || '';
  const email = String(raw).trim().toLowerCase();

  if (!supabaseAdmin) {
    return res.status(503).json({ success: false, error: 'Database not configured.' });
  }
  // Same rule the frontend applies, enforced again here — a client can reach
  // this route directly.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ success: false, error: 'A valid email address is required.' });
  }

  // clients.email is UNIQUE. Report the collision in plain words rather than
  // letting a Postgres constraint name reach the user.
  const { data: dupe } = await supabaseAdmin
    .from('clients').select('id').eq('email', email).limit(1);
  if (dupe && dupe.length && dupe[0].id !== clientId) {
    return res.status(409).json({
      success: false,
      error: 'That email address is already in use on another account.',
    });
  }

  const { error } = await supabaseAdmin
    .from('clients')
    .update({ email, email_verified: true })
    .eq('id', clientId);

  if (error) {
    console.error(`   ❌ /clients/${clientId}/email: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }

  console.log(`   ✓ Email saved for client ${clientId}`);
  res.json({ success: true, email });
});

module.exports = router;
