'use strict';
/**
 * What a client is allowed to see, decided on the SERVER from the clients row.
 * The browser also hides things by plan, but that is cosmetics: this is the check.
 *
 *   starter 7 signals · builder 15 · wealth_builder 25
 *   status active / trial / cancelled-but-paid-up / early grace -> full access
 *   read_only                                                  -> history only, no live signals
 *   suspended / pending / none                                 -> nothing live
 *
 * Trial clients with no plan chosen get the Builder allowance (policy: pre-launch
 * trial is generous; change TRIAL_PLAN below if the trial policy changes).
 */
const SIGNAL_LIMITS = { starter: 7, builder: 15, wealth_builder: 25 };
const TRIAL_PLAN = 'builder';
const EXPIRY_BUFFER_MS = 3 * 24 * 3600e3;

function entitlementFromRow(c, now = Date.now()) {
  if (!c) return { access: 'none', plan: null, signalLimit: 0 };
  const status = c.subscription_status || 'none';
  const exp = c.subscription_expires_at ? new Date(c.subscription_expires_at).getTime() : null;
  let plan = (c.subscription_plan && c.subscription_plan !== 'none') ? c.subscription_plan : (status === 'trial' ? TRIAL_PLAN : null);
  let access = 'none';

  if (status === 'active' || status === 'trial' || status === 'cancelled') {
    // A paid-up period that has lapsed (and the webhook/engine has not caught up yet)
    // gets a short buffer, then drops to read-only.
    access = exp && exp + EXPIRY_BUFFER_MS < now ? 'read_only' : 'full';
    if (status === 'cancelled' && exp && exp < now) access = 'read_only';
  } else if (status === 'payment_failed') {
    access = (c.grace_stage || 1) <= 2 ? 'full' : 'read_only';
  } else if (status === 'read_only') {
    access = 'read_only';
  }
  if (access === 'full' && !plan) plan = 'starter';
  return { access, plan, status, signalLimit: access === 'full' ? (SIGNAL_LIMITS[plan] || SIGNAL_LIMITS.starter) : 0 };
}

async function getEntitlement(supabaseAdmin, clientId) {
  const { data } = await supabaseAdmin.from('clients')
    .select('subscription_plan,subscription_status,subscription_expires_at,grace_stage')
    .eq('id', clientId).maybeSingle();
  return entitlementFromRow(data);
}

module.exports = { SIGNAL_LIMITS, entitlementFromRow, getEntitlement };
