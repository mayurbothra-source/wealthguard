/**
 * Which profile field belongs to which table — and, just as important, which
 * fields a client is ALLOWED to change.
 *
 * The profile and holding update routes used to spread the request body
 * straight into the UPDATE, so a caller could set is_admin, subscription_status,
 * pin_hash or client_id. Every write now goes through one of these allow-lists.
 */
'use strict';

const CLIENT_FIELDS = ['phone_wa', 'full_name', 'email', 'tax_bracket', 'pan_hash', 'kyc_status'];
const LIFE_FIELDS = [
  'age', 'retirement_age', 'income_type', 'monthly_income_inr', 'income_stability',
  'monthly_committed_expenses', 'client_tier', 'marital_status', 'num_children',
  'dual_income', 'health_status', 'health_insurance_cover_inr', 'term_cover_inr',
  'has_critical_illness_cover', 'has_disability_cover',
];
const BEHAVIOURAL_FIELDS = [
  'stated_risk_score', 'effective_risk_score', 'risk_category', 'panic_history',
  'portfolio_check_frequency', 'money_relationship', 'decision_style',
  'prior_loss_experience', 'communication_preference', 'trust_disposition',
  'sleep_test_threshold_pct', 'max_single_position_pct', 'max_drawdown_tolerance_pct',
];

// What a signed-in client may edit later. phone_wa, pan_hash and kyc_status are
// deliberately absent: identity fields are not self-service.
const EDITABLE_CLIENT_FIELDS = ['full_name', 'email', 'tax_bracket'];

const HOLDING_EDITABLE = [
  'instrument_name', 'asset_class', 'quantity', 'avg_buy_price_inr', 'current_price_inr',
  'stop_loss_price', 'target_price', 'linked_goal_id', 'notes',
];
const GOAL_EDITABLE = [
  'goal_name', 'goal_type', 'target_amount_inr', 'target_date', 'priority_rank', 'is_non_negotiable',
];

/** Keeps only allow-listed keys that are present (undefined is dropped, null kept). */
function only(src, fields) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

/** Like only(), but also drops null and empty strings (used at registration). */
function pick(src, fields) {
  const out = {};
  for (const f of fields) {
    if (src[f] !== undefined && src[f] !== null && src[f] !== '') out[f] = src[f];
  }
  return out;
}

module.exports = {
  CLIENT_FIELDS, LIFE_FIELDS, BEHAVIOURAL_FIELDS, EDITABLE_CLIENT_FIELDS,
  HOLDING_EDITABLE, GOAL_EDITABLE, only, pick,
};
