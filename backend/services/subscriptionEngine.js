/**
 * WealthGuard Subscription Lifecycle Engine
 *
 * Runs daily at 9:00 AM IST.
 *
 * Handles the entire subscription lifecycle with zero human intervention:
 *
 *   1. Trial expiry        — free trial ends 31 Dec 2026; post-Dec signups get 1 month
 *   2. Payment grace       — 4-stage escalation instead of an abrupt cutoff
 *   3. Referral rewards    — credits free months when a referred client completes onboarding
 *   4. Read-only mode      — preserves access to history when payment lapses
 *
 * Grace period design (deliberately generous — trust is the product):
 *   Day 0  payment fails  → email, FULL access continues
 *   Day 4  still unpaid   → reminder email, FULL access continues
 *   Day 7  still unpaid   → read-only mode, email. History/track record stay visible.
 *   Day 14 still unpaid   → suspended. Data preserved 90 days.
 *
 * Nothing is ever deleted. A returning client picks up exactly where they left off.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const emailEngine       = require('./emailEngine');
const { reportRun }     = require('./healthEngine');

// Frozen policy dates
const TRIAL_END_DATE      = new Date('2026-12-31T23:59:59Z');
const POST_TRIAL_FREE_DAYS = 30;   // signups after trial end get 1 month free

// Grace period stages (days since payment failure)
const GRACE_STAGE_2_DAYS = 4;
const GRACE_STAGE_3_DAYS = 7;   // → read_only
const GRACE_STAGE_4_DAYS = 14;  // → suspended

function daysSince(dateStr) {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// ─────────────────────────────────────────────────────────────────────
// TRIAL MANAGEMENT
// ─────────────────────────────────────────────────────────────────────

/**
 * Determines the correct trial expiry for a client based on when they joined.
 * Joined before 31 Dec 2026 → trial runs to 31 Dec 2026.
 * Joined after              → 30 days from their join date.
 */
function calculateTrialExpiry(createdAt) {
  const joined = new Date(createdAt);
  if (joined < TRIAL_END_DATE) return TRIAL_END_DATE.toISOString();
  return new Date(joined.getTime() + POST_TRIAL_FREE_DAYS * 86400000).toISOString();
}

async function processTrialExpiries() {
  if (!supabaseAdmin) return { expired: 0 };
  let expired = 0;

  try {
    const now = new Date().toISOString();
    const { data: trials } = await supabaseAdmin
      .from('clients')
      .select('id, full_name, email, created_at, subscription_expires_at, referral_months_earned')
      .eq('subscription_status', 'trial');

    for (const client of (trials || [])) {
      // Set expiry if not already set
      let expiry = client.subscription_expires_at;
      if (!expiry) {
        expiry = calculateTrialExpiry(client.created_at);
        // Add any referral months earned
        if (client.referral_months_earned > 0) {
          expiry = new Date(new Date(expiry).getTime()
            + client.referral_months_earned * 30 * 86400000).toISOString();
        }
        await supabaseAdmin.from('clients')
          .update({ subscription_expires_at: expiry })
          .eq('id', client.id);
        continue;
      }

      // Expire if past due
      if (new Date(expiry) < new Date(now)) {
        await supabaseAdmin.from('clients').update({
          subscription_status: 'payment_failed',
          payment_failed_at:   now,
          grace_stage:         1,
        }).eq('id', client.id);

        await emailEngine.sendPaymentGraceNotice(client, 1, GRACE_STAGE_3_DAYS);
        expired++;
        console.log(`   ⏳ Trial expired: ${client.full_name || client.id} → grace period started`);
      }
    }
  } catch (e) {
    console.warn(`   ⚠ Trial expiry processing failed: ${e.message}`);
  }

  return { expired };
}

// ─────────────────────────────────────────────────────────────────────
// PAYMENT GRACE PERIOD
// ─────────────────────────────────────────────────────────────────────

async function processGracePeriods() {
  if (!supabaseAdmin) return { advanced: 0, readOnly: 0, suspended: 0 };
  let advanced = 0, readOnly = 0, suspended = 0;

  try {
    const { data: lapsed } = await supabaseAdmin
      .from('clients')
      .select('id, full_name, email, payment_failed_at, grace_stage, subscription_status')
      .in('subscription_status', ['payment_failed', 'read_only']);

    for (const client of (lapsed || [])) {
      const days  = daysSince(client.payment_failed_at);
      const stage = client.grace_stage || 1;

      // Stage 1 → 2 (day 4): reminder, full access continues
      if (stage === 1 && days >= GRACE_STAGE_2_DAYS) {
        await supabaseAdmin.from('clients')
          .update({ grace_stage: 2 }).eq('id', client.id);
        await emailEngine.sendPaymentGraceNotice(client, 2, GRACE_STAGE_3_DAYS - days);
        advanced++;
        console.log(`   📧 Grace stage 2 (reminder): ${client.full_name || client.id}`);
      }

      // Stage 2 → 3 (day 7): read-only mode
      else if (stage === 2 && days >= GRACE_STAGE_3_DAYS) {
        await supabaseAdmin.from('clients').update({
          grace_stage:         3,
          subscription_status: 'read_only',
        }).eq('id', client.id);
        await emailEngine.sendPaymentGraceNotice(client, 3, GRACE_STAGE_4_DAYS - days);
        readOnly++;
        console.log(`   🔒 Read-only mode: ${client.full_name || client.id}`);
      }

      // Stage 3 → 4 (day 14): suspended, data preserved
      else if (stage === 3 && days >= GRACE_STAGE_4_DAYS) {
        await supabaseAdmin.from('clients').update({
          grace_stage:         4,
          subscription_status: 'suspended',
        }).eq('id', client.id);
        suspended++;
        console.log(`   ⛔ Suspended (data preserved): ${client.full_name || client.id}`);
      }
    }
  } catch (e) {
    console.warn(`   ⚠ Grace period processing failed: ${e.message}`);
  }

  return { advanced, readOnly, suspended };
}

// ─────────────────────────────────────────────────────────────────────
// REFERRAL REWARDS
// ─────────────────────────────────────────────────────────────────────

/**
 * Credits a free month to both parties when a referred client completes
 * onboarding. Runs idempotently — a referral is only ever rewarded once.
 */
async function processReferralRewards() {
  if (!supabaseAdmin) return { rewarded: 0 };
  let rewarded = 0;

  try {
    // Clients who used a referral code, completed onboarding, not yet rewarded
    const { data: referred } = await supabaseAdmin
      .from('clients')
      .select('id, full_name, referred_by, referral_months_earned, subscription_expires_at, onboarding_complete')
      .not('referred_by', 'is', null)
      .eq('onboarding_complete', true)
      .eq('referral_months_earned', 0);

    for (const newClient of (referred || [])) {
      // Find the referrer
      const { data: referrer } = await supabaseAdmin
        .from('clients')
        .select('id, full_name, email, referral_months_earned, subscription_expires_at')
        .eq('referral_code', newClient.referred_by)
        .single();

      if (!referrer) continue;
      if (referrer.id === newClient.id) continue; // self-referral guard

      const addMonth = (expiry) => {
        const base = expiry ? new Date(expiry) : new Date();
        return new Date(base.getTime() + 30 * 86400000).toISOString();
      };

      // Credit the new client
      await supabaseAdmin.from('clients').update({
        referral_months_earned:  1,
        subscription_expires_at: addMonth(newClient.subscription_expires_at),
      }).eq('id', newClient.id);

      // Credit the referrer
      await supabaseAdmin.from('clients').update({
        referral_months_earned:  (referrer.referral_months_earned || 0) + 1,
        subscription_expires_at: addMonth(referrer.subscription_expires_at),
      }).eq('id', referrer.id);

      // Notify the referrer
      if (referrer.email) {
        await emailEngine.send({
          to:       referrer.email,
          subject:  'WealthGuard — you earned a free month',
          html:     `<p>Good news. ${newClient.full_name || 'Someone you referred'} just joined WealthGuard using your referral code.</p>
                     <p>We have added <strong>one free month</strong> to your subscription. Thank you for spreading the word.</p>`,
          clientId: referrer.id,
          type:     'referral_reward',
        });
      }

      rewarded++;
      console.log(`   🎁 Referral rewarded: ${referrer.full_name} ← ${newClient.full_name}`);
    }
  } catch (e) {
    console.warn(`   ⚠ Referral processing failed: ${e.message}`);
  }

  return { rewarded };
}

// ─────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────

async function runSubscriptionEngine() {
  if (!supabaseAdmin) {
    console.log('💳 Subscription engine: Supabase not configured, skipping.');
    return;
  }

  const start = Date.now();
  console.log('💳 Running subscription lifecycle engine...');

  const trials    = await processTrialExpiries();
  const grace     = await processGracePeriods();
  const referrals = await processReferralRewards();

  const total = trials.expired + grace.advanced + grace.readOnly + grace.suspended + referrals.rewarded;
  const duration = Date.now() - start;

  console.log(`💳 Subscription engine complete: ${trials.expired} trials expired, ` +
              `${grace.advanced} reminders, ${grace.readOnly} → read-only, ` +
              `${grace.suspended} suspended, ${referrals.rewarded} referrals rewarded.`);

  await reportRun({
    engineName:     'subscriptionEngine',
    durationMs:     duration,
    itemsProcessed: total,
    itemsExpected:  null,  // zero activity is normal on most days
    itemsFailed:    0,
    detail:         JSON.stringify({ trials, grace, referrals }),
  });
}

module.exports = {
  runSubscriptionEngine,
  calculateTrialExpiry,
};
