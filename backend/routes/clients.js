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



module.exports = router;
