/**
 * Client profile routes. Every route requires a session, and a client can only
 * ever reach their own record (ownsParam).
 */
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { requireSession, ownsParam } = require('../lib/session');
const { LIFE_FIELDS, BEHAVIOURAL_FIELDS, EDITABLE_CLIENT_FIELDS, only } = require('../lib/clientFields');

router.use('/:clientId', requireSession, ownsParam('clientId'));

router.get('/:clientId/profile', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({
    profile: null, unavailable: true,
    message: 'Your profile is temporarily unavailable.',
  });
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select(`*, client_life_profiles(*), client_behavioural_profiles(*), client_goals(*)`)
    .eq('id', req.params.clientId).single();
  if (error) return res.status(500).json({ error: 'Could not load your profile.' });
  // Secrets never leave the server, even to their owner.
  const { pin_hash, pin_attempts, pin_locked_until, ...safe } = data;
  res.json({ profile: safe });
});

router.put('/:clientId/profile', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({
    success: false, unavailable: true,
    error: 'Could not save your profile right now — no change was made.',
  });
  const { type, updates } = req.body || {};
  const isLife = type === 'life', isBehav = type === 'behavioural';
  // Allow-listed fields only. The body used to be spread into the UPDATE, which
  // let a caller set is_admin, subscription_status or pin_hash.
  const clean = only(updates, isLife ? LIFE_FIELDS : isBehav ? BEHAVIOURAL_FIELDS : EDITABLE_CLIENT_FIELDS);
  if (!Object.keys(clean).length) return res.status(400).json({ error: 'Nothing to update.' });

  const id = req.params.clientId;
  // The profile tables are keyed by client_id; the clients table by id. The old
  // code filtered every table on client_id, which matches no row in `clients`.
  const q = isLife || isBehav
    ? supabaseAdmin.from(isLife ? 'client_life_profiles' : 'client_behavioural_profiles')
        .update({ ...clean, assessed_at: new Date().toISOString() }).eq('client_id', id)
    : supabaseAdmin.from('clients').update(clean).eq('id', id);
  const { error } = await q;
  if (error) return res.status(500).json({ error: 'Could not save your changes.' });

  await supabaseAdmin.from('profile_change_events').insert({
    client_id: id, event_type: 'client_initiated',
    trigger_description: `Client updated ${type || 'account'} profile`, fields_changed_json: clean,
  });
  res.json({ success: true });
});

// ── POST /api/clients/:clientId/email ────────────────────────────────
// Saves or changes the address the morning brief and flash alerts go to.
router.post('/:clientId/email', async (req, res) => {
  const { clientId } = req.params;
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();

  if (!supabaseAdmin) {
    return res.status(503).json({ success: false, error: 'Database not configured.' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ success: false, error: 'A valid email address is required.' });
  }

  // clients.email is UNIQUE. Report the collision in plain words.
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
    return res.status(500).json({ success: false, error: 'Could not save your email.' });
  }

  console.log(`   ✓ Email saved for client ${clientId}`);
  res.json({ success: true, email });
});

module.exports = router;
