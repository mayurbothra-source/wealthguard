const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');

router.get('/:clientId/profile', async (req, res) => {
  if (!supabaseAdmin) return res.json({ profile: getDemoProfile(), demo: true });
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select(`*, client_life_profiles(*), client_behavioural_profiles(*), client_goals(*)`)
    .eq('id', req.params.clientId).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

router.put('/:clientId/profile', async (req, res) => {
  if (!supabaseAdmin) return res.json({ success: true, demo: true });
  const { type, updates } = req.body;
  const table = type === 'life' ? 'client_life_profiles' : type === 'behavioural' ? 'client_behavioural_profiles' : 'clients';
  const { error } = await supabaseAdmin.from(table).update({ ...updates, assessed_at: new Date().toISOString() }).eq('client_id', req.params.clientId);
  if (error) return res.status(500).json({ error: error.message });
  // Log change
  await supabaseAdmin.from('profile_change_events').insert({ client_id: req.params.clientId, event_type: 'client_initiated', trigger_description: `Client updated ${type} profile`, fields_changed_json: updates });
  res.json({ success: true });
});

function getDemoProfile() {
  return {
    id: 'demo-client-1', full_name: 'Rahul Sharma', email: 'rahul@example.com', phone_wa: '+919876543210',
    client_life_profiles: [{ age: 35, income_type: 'salaried', monthly_income_inr: 75000, monthly_committed_expenses: 35000, investable_surplus_inr: 40000, client_tier: 'builder', marital_status: 'married', num_children: 2, health_status: 'good', health_insurance_cover_inr: 1000000, term_cover_inr: 10000000, has_critical_illness_cover: false, protection_gaps_json: [{ gap: 'critical_illness', severity: 'medium', message: 'Consider critical illness cover' }] }],
    client_behavioural_profiles: [{ stated_risk_score: 6, effective_risk_score: 5, risk_category: 'moderate', panic_history: false, money_relationship: 'security', sleep_test_threshold_pct: 15, stability_intervention_threshold_pct: 10, max_single_position_pct: 10, max_drawdown_tolerance_pct: 20 }],
    client_goals: [
      { goal_name: 'Emergency Fund', goal_type: 'emergency', funding_pct: 100, on_track: true },
      { goal_name: "Priya's College", goal_type: 'short', funding_pct: 73, on_track: true },
      { goal_name: 'Home Down Payment', goal_type: 'medium', funding_pct: 58, on_track: true },
      { goal_name: 'Retirement at 55', goal_type: 'long', funding_pct: 31, on_track: false },
    ]
  };
}

module.exports = router;
