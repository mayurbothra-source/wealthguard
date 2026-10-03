const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { requireSession, ownsParam, ownsBody } = require('../lib/session');
const { limit } = require('../lib/rateLimit');
const {
  PLANS, DISCOUNT_CODES, validateDiscountCode,
  createSubscription, verifyPaymentSignature, isConfigured
} = require('../services/payment');

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

    // Free activation (100% codes) first redeems the code, then activates.
    const isFree = !!(discountInfo && discountInfo.valid && discountInfo.discount === 100);
    if (discount_code && discountInfo?.valid) {
      const r = await redeemCode(discount_code, client_id);
      if (!r.ok) return res.status(409).json({ error: r.message });
    }

    let subscription;
    try {
      subscription = await createSubscription(plan_key, client_id, isFree ? discount_code : null);
    } catch (e) {
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

    const expiresAt = subscription.expires_at ||
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const active = subscription.type === 'free';

    const { error: subErr } = await supabaseAdmin.from('subscriptions').insert({
      client_id,
      plan_key,
      plan_name: PLANS[plan_key]?.name,
      status: active ? 'active' : 'pending',
      subscription_type: subscription.type,
      razorpay_subscription_id: subscription.subscription?.id || null,
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

    res.json({ success: true, subscription, discount: discountInfo });
  } catch (err) {
    console.error('Subscribe error:', err.message);
    res.status(500).json({ error: 'Could not start your subscription. Please try again.' });
  }
});

// POST /api/payments/verify — verify Razorpay payment after checkout
router.post('/verify', requireSession, ownsBody('client_id'), async (req, res) => {
  const { order_id, payment_id, signature, plan_key } = req.body || {};
  const client_id = req.auth.clientId;

  // verifyPaymentSignature fails closed: without RAZORPAY_KEY_SECRET it is false.
  if (!verifyPaymentSignature(order_id, payment_id, signature)) {
    return res.status(400).json({ error: 'Invalid payment signature' });
  }
  if (!supabaseAdmin) return res.status(503).json({ error: 'Temporarily unavailable.' });

  const { error } = await supabaseAdmin.from('subscriptions').update({
    status: 'active',
    razorpay_payment_id: payment_id,
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  }).eq('client_id', client_id).eq('plan_key', plan_key);
  if (error) return res.status(500).json({ error: 'Could not activate your subscription.' });

  await supabaseAdmin.from('clients').update({ subscription_status: 'active' }).eq('id', client_id);
  res.json({ success: true, message: 'Payment verified. Subscription activated.' });
});

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
