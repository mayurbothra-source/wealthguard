const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const crypto = require('crypto');

// POST /api/auth/register — Client onboarding
router.post('/register', async (req, res) => {
  try {
    const {
      full_name, email, phone_wa, age, income_type, monthly_income_inr,
      monthly_committed_expenses, marital_status, num_children, dependents_json,
      health_status, health_insurance_cover_inr, term_cover_inr,
      has_critical_illness_cover, stated_risk_score, panic_history,
      portfolio_check_frequency, money_relationship, sleep_test_threshold_pct,
      goals, tax_bracket,
    } = req.body;

    if (!full_name || !phone_wa) {
      return res.status(400).json({ error: 'Name and WhatsApp number required' });
    }

    // Demo mode — return mock client
    if (!supabaseAdmin) {
      const mockClient = {
        id: crypto.randomUUID(),
        full_name, email, phone_wa, tax_bracket: tax_bracket || 30,
        kyc_status: 'pending',
        onboarded_at: new Date().toISOString(),
      };
      return res.json({ success: true, client: mockClient, demo: true });
    }

    // Create client
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients').insert({ full_name, email, phone_wa, tax_bracket: tax_bracket || 30 })
      .select().single();
    if (clientErr) throw clientErr;

    // Compute client tier
    const income = monthly_income_inr || 0;
    const tier = income >= 200000 ? 'hni' : income >= 30000 ? 'wealth_builder' : income >= 50000 ? 'builder' : 'starter';

    // Compute protection gaps
    const protectionGaps = [];
    if (!health_insurance_cover_inr || health_insurance_cover_inr < 500000) protectionGaps.push({ gap: 'health_insurance', severity: 'high', message: 'Health cover below ₹5L per family member' });
    if (!term_cover_inr && num_children > 0) protectionGaps.push({ gap: 'term_life', severity: 'critical', message: 'No term life cover with dependents — protect your family first' });
    if (!has_critical_illness_cover) protectionGaps.push({ gap: 'critical_illness', severity: 'medium', message: 'Critical illness cover recommended' });

    // Create life profile
    await supabaseAdmin.from('client_life_profiles').insert({
      client_id: client.id, age, income_type, monthly_income_inr,
      monthly_committed_expenses, marital_status, num_children,
      dependents_json: dependents_json || [], health_status: health_status || 'good',
      health_insurance_cover_inr, term_cover_inr, has_critical_illness_cover: has_critical_illness_cover || false,
      protection_gaps_json: protectionGaps, client_tier: tier, income_stability: 'stable',
    });

    // Compute effective risk score with behavioural adjustment
    let effectiveRisk = stated_risk_score || 5;
    if (panic_history) effectiveRisk = Math.max(1, effectiveRisk - 2);
    if (portfolio_check_frequency === 'multiple_daily') effectiveRisk = Math.max(1, effectiveRisk - 1);
    if (money_relationship === 'security') effectiveRisk = Math.max(1, effectiveRisk - 1);
    if (money_relationship === 'growth') effectiveRisk = Math.min(10, effectiveRisk + 1);

    const riskCategory = effectiveRisk <= 3 ? 'conservative' : effectiveRisk <= 6 ? 'moderate' : 'aggressive';
    const stabilityThreshold = sleep_test_threshold_pct ? sleep_test_threshold_pct * 0.7 : 10;

    await supabaseAdmin.from('client_behavioural_profiles').insert({
      client_id: client.id, stated_risk_score: stated_risk_score || 5,
      effective_risk_score: effectiveRisk, panic_history: panic_history || false,
      portfolio_check_frequency: portfolio_check_frequency || 'weekly',
      money_relationship: money_relationship || 'security',
      sleep_test_threshold_pct: sleep_test_threshold_pct || 15,
      stability_intervention_threshold_pct: stabilityThreshold,
      max_single_position_pct: effectiveRisk <= 3 ? 8 : effectiveRisk <= 6 ? 10 : 15,
      max_drawdown_tolerance_pct: effectiveRisk <= 3 ? 10 : effectiveRisk <= 6 ? 20 : 30,
    });

    // Create goals
    if (goals && goals.length > 0) {
      for (const goal of goals) {
        if (!goal.goal_name || !goal.target_amount_inr) continue;
        const type = goal.goal_name.toLowerCase().includes('emergency') ? 'emergency'
          : parseInt(goal.years_to_target) <= 3 ? 'short'
          : parseInt(goal.years_to_target) <= 7 ? 'medium' : 'long';
        await supabaseAdmin.from('client_goals').insert({
          client_id: client.id,
          goal_name: goal.goal_name,
          goal_type: type,
          target_amount_inr: goal.target_amount_inr,
          target_date: goal.target_date,
          priority_rank: goal.priority || 1,
          is_non_negotiable: type === 'emergency',
        });
      }
    }

    // Log profile creation event
    await supabaseAdmin.from('profile_change_events').insert({
      client_id: client.id, event_type: 'initial',
      trigger_description: 'Client onboarded via WealthGuard platform',
      fields_changed_json: { all: 'initial_setup' },
    });

    res.json({ success: true, client_id: client.id, client, tier, effective_risk_score: effectiveRisk, protection_gaps: protectionGaps });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login — Simple phone-based lookup (demo)
router.post('/login', async (req, res) => {
  const { phone_wa } = req.body;
  if (!supabaseAdmin) return res.json({ success: true, demo: true });
  const { data, error } = await supabaseAdmin.from('clients').select('*').eq('phone_wa', phone_wa).single();
  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json({ success: true, client: data });
});

module.exports = router;
