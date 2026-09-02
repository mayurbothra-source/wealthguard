const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const {
  PLANS, validateDiscountCode, createOrder,
  createSubscription, verifyPaymentSignature, isConfigured
} = require('../services/payment');

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
router.post('/validate-code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  const result = await validateDiscountCode(code, supabaseAdmin);
  res.json(result);
});

// POST /api/payments/subscribe — create subscription
router.post('/subscribe', async (req, res) => {
  const { client_id, plan_key, discount_code } = req.body;
  if (!client_id || !plan_key) {
    return res.status(400).json({ error: 'client_id and plan_key required' });
  }

  try {
    let discountInfo = null;
    if (discount_code) {
      discountInfo = await validateDiscountCode(discount_code, supabaseAdmin);
      if (!discountInfo.valid) {
        return res.status(400).json({ error: discountInfo.message });
      }
    }

    const subscription = await createSubscription(plan_key, client_id, discount_code);

    if (supabaseAdmin) {
      const expiresAt = subscription.expires_at ||
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await supabaseAdmin.from('subscriptions').insert({
        client_id,
        plan_key,
        plan_name: PLANS[plan_key]?.name,
        status: subscription.type === 'free' ? 'active' : 'pending',
        subscription_type: subscription.type,
        razorpay_subscription_id: subscription.subscription?.id || null,
        discount_code: discount_code || null,
        discount_pct: discountInfo?.discount || 0,
        amount_paise: subscription.type === 'free' ? 0 : PLANS[plan_key]?.amount,
        started_at: new Date().toISOString(),
        expires_at: expiresAt,
        free_months_remaining: discountInfo?.duration_months || 0,
      });

      if (discount_code && discountInfo?.valid) {
        await supabaseAdmin.from('discount_code_usage').insert({
          code: discount_code.toUpperCase(),
          client_id,
          used_at: new Date().toISOString(),
        });
      }

      await supabaseAdmin.from('clients').update({
        subscription_plan: plan_key,
        subscription_status: subscription.type === 'free' ? 'active' : 'pending',
        subscription_expires_at: expiresAt,
      }).eq('id', client_id);
    }

    res.json({ success: true, subscription, discount: discountInfo });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/verify — verify Razorpay payment after checkout
router.post('/verify', async (req, res) => {
  const { order_id, payment_id, signature, client_id, plan_key } = req.body;

  const valid = verifyPaymentSignature(order_id, payment_id, signature);
  if (!valid) return res.status(400).json({ error: 'Invalid payment signature' });

  if (supabaseAdmin) {
    await supabaseAdmin.from('subscriptions').update({
      status: 'active',
      razorpay_payment_id: payment_id,
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }).eq('client_id', client_id).eq('plan_key', plan_key);

    await supabaseAdmin.from('clients').update({
      subscription_status: 'active',
    }).eq('id', client_id);
  }

  res.json({ success: true, message: 'Payment verified. Subscription activated.' });
});

// GET /api/payments/status/:clientId — check subscription status
router.get('/status/:clientId', async (req, res) => {
  if (!supabaseAdmin) {
    return res.json({ status: 'active', plan: 'builder', demo: true });
  }
  const { data } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('client_id', req.params.clientId)
    .order('started_at', { ascending: false })
    .limit(1)
    .single();

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

