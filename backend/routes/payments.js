const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { requireSession, ownsParam, ownsBody } = require('../lib/session');
const { limit } = require('../lib/rateLimit');
const {
  PLANS, DISCOUNT_CODES, validateDiscountCode,
  createSubscription, cancelSubscription, verifySubscriptionSignature, verifyWebhookSignature, isConfigured
} = require('../services/payment');

const { paidPlansOpen } = require('../lib/freePeriod');
const codeLimiter = limit({ windowMs: 10 * 60e3, max: 30 });

// GET /api/payments/plans — list all plans
router.get('/plans', (req, res) => {
  const plans = Object.entries(PLANS).map(([key, plan]) => ({
    key,
    name: plan.name,
    amount: plan.amount,
    amount_display: `₹${(plan.amount / 100).toLocaleString('en-IN')}`,
    period: plan.period,
    description: plan.description,
    features: plan.features,
  }));
  res.json({ plans, razorpay_configured: isConfigured });
});

// POST /api/payments/validate-code — check discount code
router.post('/validate-code', codeLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  const result = await validateDiscountCode(String(code), supabaseAdmin);
  res.json(result);
});

/**
 * Records that this client redeemed this code, atomically enough for a free
 * database: insert first (a unique (code, client_id) index stops the same client
 * redeeming twice), then re-count; if the code is now over its limit, take the
 * row back out. The old order — check the count, then insert — let two
 * simultaneous requests both pass the check.
 */
async function redeemCode(code, clientId) {
  const upper = String(code).toUpperCase().trim();
  const max = (DISCOUNT_CODES[upper] || {}).max_uses || 0;

  const { error } = await supabaseAdmin.from('discount_code_usage').insert({
    code: upper, client_id: clientId, used_at: new Date().toISOString(),
  });
  if (error) {
    const dup = error.code === '23505' || /duplicate|unique/i.test(error.message || '');
    return { ok: false, message: dup ? 'You have already used this code.' : 'Could not apply that code right now.' };
  }
  const { count } = await supabaseAdmin.from('discount_code_usage')
    .select('id', { count: 'exact', head: true }).eq('code', upper);
  if (count != null && count > max) {
    await supabaseAdmin.from('discount_code_usage').delete().eq('code', upper).eq('client_id', clientId);
    return { ok: false, message: 'This code has already been fully redeemed.' };
  }
  return { ok: true };
}

// POST /api/payments/subscribe — create subscription for the signed-in client
router.post('/subscribe', requireSession, ownsBody('client_id'), async (req, res) => {
  const { plan_key, discount_code } = req.body || {};
  const client_id = req.auth.clientId;
  if (!plan_key || !PLANS[plan_key]) {
    return res.status(400).json({ error: 'A valid plan_key is required' });
  }
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Subscriptions are temporarily unavailable.' });
  }

  try {
    let discountInfo = null;
    if (discount_code) {
      discountInfo = await validateDiscountCode(discount_code, supabaseAdmin);
      if (!discountInfo.valid) {
        return res.status(400).json({ error: discountInfo.message });
      }
    }

    // Everything is free until the paid-plans date. Block real charges before then
    // (free 100% codes are unaffected). Test Razorpay by setting PAID_PLANS_OPEN_FROM.
    const wantsFree = !!(discountInfo && discountInfo.valid && discountInfo.discount === 100);
    if (!wantsFree && !paidPlansOpen()) {
      return res.status(403).json({
        paid_not_open: true,
        error: 'WealthGuard is free for everyone until 31 December 2026, so there is nothing to pay yet. You already have full access.',
      });
    }

    // Free activation (100% codes) first redeems the code, then activates.
    const isFree = !!(discountInfo && discountInfo.valid && discountInfo.discount === 100);
    if (discount_code && discountInfo?.valid) {
      const r = await redeemCode(discount_code, client_id);
      if (!r.ok) return res.status(409).json({ error: r.message });
    }

    let subscription;
    try {
      subscription = await createSubscription(plan_key, client_id, discountInfo && discountInfo.valid ? discount_code : null);
    } catch (e) {
      if (e.code === 'OFFER_NOT_CONFIGURED') {
        await supabaseAdmin.from('discount_code_usage').delete()
          .eq('code', String(discount_code).toUpperCase().trim()).eq('client_id', client_id);
        return res.status(400).json({ error: e.message });
      }
      if (e.code === 'PAYMENTS_UNAVAILABLE') {
        // Give the code back: nothing was purchased.
        if (discount_code && discountInfo?.valid) {
          await supabaseAdmin.from('discount_code_usage').delete()
            .eq('code', String(discount_code).toUpperCase().trim()).eq('client_id', client_id);
        }
        return res.status(503).json({ error: e.message, payments_unavailable: true });
      }
      throw e;
    }

    let expiresAt = subscription.expires_at ||
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    if (subscription.type === 'free') {
      // A code must never cut short a longer free period the client already has.
      const { data: cur } = await supabaseAdmin.from('clients')
        .select('subscription_expires_at').eq('id', client_id).maybeSingle();
      const have = cur && cur.subscription_expires_at;
      if (have && new Date(have) > new Date(expiresAt)) expiresAt = new Date(have).toISOString();
    }
    const active = subscription.type === 'free';
    const rzpSubId = subscription.subscription && subscription.subscription.id;

    // An abandoned checkout leaves a 'pending' row. Clear them so retries do not pile up.
    await supabaseAdmin.from('subscriptions').delete().eq('client_id', client_id).eq('status', 'pending');

    const { error: subErr } = await supabaseAdmin.from('subscriptions').insert({
      client_id,
      plan_key,
      plan_name: PLANS[plan_key]?.name,
      status: active ? 'active' : 'pending',
      subscription_type: subscription.type,
      razorpay_subscription_id: rzpSubId || null,
      discount_code: discount_code || null,
      discount_pct: discountInfo?.discount || 0,
      amount_paise: active ? 0 : PLANS[plan_key]?.amount,
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
      free_months_remaining: discountInfo?.duration_months || 0,
    });
    if (subErr) throw new Error(subErr.message);

    await supabaseAdmin.from('clients').update({
      subscription_plan: plan_key,
      subscription_status: active ? 'active' : 'pending',
      subscription_expires_at: expiresAt,
    }).eq('id', client_id);

    res.json({
      success: true, subscription, discount: discountInfo,
      // what the browser needs to open checkout: the PUBLIC key id and the subscription id
      razorpay_key: subscription.key_id || null,
      razorpay_subscription_id: rzpSubId || null,
    });
  } catch (err) {
    console.error('Subscribe error:', err.message);
    res.status(500).json({ error: 'Could not start your subscription. Please try again.' });
  }
});

// POST /api/payments/verify — called by the browser after Razorpay checkout succeeds.
// The signature proves Razorpay confirmed the authorisation; the subscription id must
// also be one WE created for THIS client, so a valid signature from someone else's
// payment cannot activate your account.
router.post('/verify', requireSession, ownsBody('client_id'), async (req, res) => {
  const { subscription_id, payment_id, signature } = req.body || {};
  const client_id = req.auth.clientId;

  if (!verifySubscriptionSignature(payment_id, subscription_id, signature)) {
    return res.status(400).json({ error: 'Invalid payment signature' });
  }
  if (!supabaseAdmin) return res.status(503).json({ error: 'Temporarily unavailable.' });

  const { data: row } = await supabaseAdmin.from('subscriptions').select('id, plan_key')
    .eq('client_id', client_id).eq('razorpay_subscription_id', subscription_id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'No matching subscription for this account.' });

  // Provisional access until the webhook confirms the exact billing period.
  const expires = new Date(Date.now() + 32 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin.from('subscriptions').update({
    status: 'active', razorpay_payment_id: payment_id, started_at: new Date().toISOString(), expires_at: expires,
  }).eq('id', row.id);
  if (error) return res.status(500).json({ error: 'Could not activate your subscription.' });

  await supabaseAdmin.from('clients').update({
    subscription_plan: row.plan_key, subscription_status: 'active',
    subscription_expires_at: expires, payment_failed_at: null, grace_stage: 0,
  }).eq('id', client_id);

  // Upgrade / plan switch: stop billing every OTHER paid plan this client still has,
  // otherwise they would be charged for both each month. A failed cancel is logged
  // loudly (support must fix it) but never blocks the customer's new plan.
  const { data: older } = await supabaseAdmin.from('subscriptions')
    .select('id, razorpay_subscription_id')
    .eq('client_id', client_id).neq('id', row.id)
    .not('razorpay_subscription_id', 'is', null)
    .in('status', ['active', 'past_due']);
  for (const o of older || []) {
    const ok = await cancelSubscription(o.razorpay_subscription_id);
    if (ok) {
      await supabaseAdmin.from('subscriptions')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', o.id);
    } else {
      console.error('ACTION NEEDED: could not cancel old subscription', o.razorpay_subscription_id,
        'for client', client_id, '- cancel it in the Razorpay dashboard to avoid double billing.');
    }
  }
  res.json({ success: true, message: 'Payment verified. Subscription activated.' });
});

/**
 * POST /api/payments/webhook — Razorpay tells us what really happened (renewals,
 * failed charges, cancellations). Mounted in server.js BEFORE express.json so the
 * raw bytes are available: the signature is over the exact body Razorpay sent.
 */
const ms = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);

async function handleWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    // Never log the secret or signature themselves, only facts that explain WHY.
    console.warn('Webhook rejected: bad signature —',
      'secret_configured=' + !!process.env.RAZORPAY_WEBHOOK_SECRET,
      'signature_header=' + !!req.get('x-razorpay-signature'),
      'body_bytes=' + raw.length);
    return res.status(400).json({ error: 'bad signature' });
  }
  console.log('Webhook received:', (req.get('x-razorpay-event-id') || 'no-id'));
  if (!supabaseAdmin) return res.status(503).json({ error: 'unavailable' });

  let evt;
  try { evt = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad json' }); }
  const eventId = req.get('x-razorpay-event-id') || null;
  const type = evt.event;

  try {
    // Razorpay retries; do each event once.
    if (eventId) {
      const { error: dup } = await supabaseAdmin.from('payment_events')
        .insert({ event_id: eventId, event_type: type });
      if (dup && (dup.code === '23505' || /duplicate|unique/i.test(dup.message || ''))) {
        return res.json({ ok: true, duplicate: true });
      }
    }

    const sub = evt.payload && evt.payload.subscription && evt.payload.subscription.entity;
    if (!sub || !sub.id) return res.json({ ok: true, ignored: type });

    let { data: row } = await supabaseAdmin.from('subscriptions')
      .select('id, client_id, plan_key').eq('razorpay_subscription_id', sub.id).maybeSingle();
    if (!row) return res.json({ ok: true, unknown_subscription: true });

    const periodEnd = ms(sub.current_end);
    const pay = evt.payload.payment && evt.payload.payment.entity;
    // If the client has since moved to a newer paid plan, a late "cancelled"/"halted"
    // etc. about the OLD plan must not downgrade them: update only that old row.
    let newerActive = false;
    if (type !== 'subscription.activated' && type !== 'subscription.charged') {
      const { count } = await supabaseAdmin.from('subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', row.client_id).eq('status', 'active').neq('id', row.id)
        .not('razorpay_subscription_id', 'is', null);
      newerActive = (count || 0) > 0;
    }
    const setBoth = async (subFields, clientFields) => {
      await supabaseAdmin.from('subscriptions').update(subFields).eq('id', row.id);
      if (newerActive) return;
      await supabaseAdmin.from('clients').update(clientFields).eq('id', row.client_id);
    };

    if (type === 'subscription.activated' || type === 'subscription.charged') {
      const exp = periodEnd || new Date(Date.now() + 32 * 86400e3).toISOString();
      await setBoth(
        { status: 'active', expires_at: exp, ...(pay ? { razorpay_payment_id: pay.id } : {}) },
        { subscription_plan: row.plan_key, subscription_status: 'active', subscription_expires_at: exp,
          payment_failed_at: null, grace_stage: 0 });
    } else if (type === 'subscription.pending' || type === 'subscription.halted') {
      await setBoth({ status: type === 'subscription.halted' ? 'halted' : 'past_due' },
        { subscription_status: 'payment_failed', payment_failed_at: new Date().toISOString(), grace_stage: 1 });
    } else if (type === 'subscription.cancelled') {
      await setBoth({ status: 'cancelled', cancelled_at: new Date().toISOString(), ...(periodEnd ? { expires_at: periodEnd } : {}) },
        { subscription_status: 'cancelled', ...(periodEnd ? { subscription_expires_at: periodEnd } : {}) });
    } else if (type === 'subscription.completed' || type === 'subscription.expired') {
      await setBoth({ status: 'expired' }, { subscription_status: 'read_only', grace_stage: 3 });
    }
    // authenticated / updated / payment.* are recorded above and need no state change.
    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error:', e.message);
    // 500 makes Razorpay retry later, which is what we want for a transient fault.
    res.status(500).json({ error: 'retry' });
  }
}

// GET /api/payments/status/:clientId — check subscription status
router.get('/status/:clientId', requireSession, ownsParam('clientId'), async (req, res) => {
  if (!supabaseAdmin) {
    // A failure must never silently upgrade someone.
    return res.status(503).json({
      status: 'unknown', plan: null, unavailable: true,
      message: 'Subscription status is temporarily unavailable.',
    });
  }
  const { data } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('client_id', req.params.clientId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return res.json({ status: 'none', plan: null });

  const expired = data.expires_at && new Date(data.expires_at) < new Date();
  res.json({
    status: expired ? 'expired' : data.status,
    plan: data.plan_key,
    plan_name: data.plan_name,
    expires_at: data.expires_at,
    discount_code: data.discount_code,
    days_remaining: data.expires_at
      ? Math.max(0, Math.ceil((new Date(data.expires_at) - new Date()) / (1000 * 60 * 60 * 24)))
      : null,
  });
});

module.exports = router;
module.exports.handleWebhook = handleWebhook;
