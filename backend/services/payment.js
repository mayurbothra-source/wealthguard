/**
 * WealthGuard Payment Service
 * Razorpay subscriptions — India-first billing
 */
const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;

// ── SUBSCRIPTION PLANS (frozen structure — Starter/Builder/Wealth Builder) ──
const PLANS = {
  starter: {
    name: 'Starter',
    amount: 29900,          // Rs.299 in paise
    currency: 'INR',
    period: 'monthly',
    interval: 1,
    description: 'Daily brief, flash alerts, up to 7 signals, all time horizons',
    features: [
      'Daily Morning Brief — WhatsApp + dashboard',
      'Flash steep-move alerts — WhatsApp + dashboard',
      'Unlimited goals & holdings',
      'Up to 7 active signals',
      'Short + Mid + Long-term outlook',
      'Education centre',
    ],
    razorpay_plan_id: process.env.RAZORPAY_PLAN_STARTER || null,
  },
  builder: {
    name: 'Builder',
    amount: 79900,          // Rs.799
    currency: 'INR',
    period: 'monthly',
    interval: 1,
    description: 'Full Intelligence Centre, High Conviction signals, real-time stop-loss',
    features: [
      'Everything in Starter',
      'Up to 15 active signals',
      'High Conviction signals with full AI rationale',
      'Real-time stop-loss alerts',
      'PESTLE snapshot',
      'Full Intelligence Centre',
    ],
    razorpay_plan_id: process.env.RAZORPAY_PLAN_BUILDER || null,
  },
  wealth_builder: {
    name: 'Wealth Builder',
    amount: 199900,         // Rs.1,999
    currency: 'INR',
    period: 'monthly',
    interval: 1,
    description: 'Priority delivery, tax optimisation, monthly report, personal track record',
    features: [
      'Everything in Builder',
      'Up to 25 active signals',
      'Priority signal delivery',
      'Tax optimisation alerts (LTCG/STCG)',
      'Monthly PDF report',
      'Personal Track Record module',
    ],
    razorpay_plan_id: process.env.RAZORPAY_PLAN_WEALTH || null,
  },
};

// ── DISCOUNT CODES ──────────────────────────────────────────
const DISCOUNT_CODES = {
  // First 5 clients — 1 year free
  'WGFOUND01': { discount: 100, type: 'percent', duration_months: 12, max_uses: 1, description: 'Founder client #1 — 1 year free' },
  'WGFOUND02': { discount: 100, type: 'percent', duration_months: 12, max_uses: 1, description: 'Founder client #2 — 1 year free' },
  'WGFOUND03': { discount: 100, type: 'percent', duration_months: 12, max_uses: 1, description: 'Founder client #3 — 1 year free' },
  'WGFOUND04': { discount: 100, type: 'percent', duration_months: 12, max_uses: 1, description: 'Founder client #4 — 1 year free' },
  'WGFOUND05': { discount: 100, type: 'percent', duration_months: 12, max_uses: 1, description: 'Founder client #5 — 1 year free' },
  // Launch codes for September 9th
  'LAUNCH9SEP': { discount: 50, type: 'percent', duration_months: 3, max_uses: 50, description: 'Launch day — 50% off for 3 months' },
  'WGEARLY':    { discount: 30, type: 'percent', duration_months: 6, max_uses: 100, description: 'Early adopter — 30% off for 6 months' },
  // Demo code — used for trial activation and internal monitoring accounts
  'WGDEMO':     { discount: 100, type: 'percent', duration_months: 1, max_uses: 999, description: 'Demo — 1 month free trial' },
};

// ── VALIDATE DISCOUNT CODE ──────────────────────────────────
async function validateDiscountCode(code, supabaseAdmin) {
  if (!code) return { valid: false, message: 'No code provided' };
  const upperCode = code.toUpperCase().trim();
  const discount = DISCOUNT_CODES[upperCode];
  if (!discount) return { valid: false, message: 'Invalid code. Please check and try again.' };

  if (supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from('discount_code_usage')
      .select('id')
      .eq('code', upperCode);
    const usedCount = data?.length || 0;
    if (usedCount >= discount.max_uses) {
      return { valid: false, message: 'This code has already been fully redeemed.' };
    }
  }

  return {
    valid: true,
    code: upperCode,
    discount: discount.discount,
    type: discount.type,
    duration_months: discount.duration_months,
    description: discount.description,
    message: discount.discount === 100
      ? `🎉 Code applied! You get ${discount.duration_months} month${discount.duration_months > 1 ? 's' : ''} completely free.`
      : `✅ Code applied! ${discount.discount}% off for ${discount.duration_months} month${discount.duration_months > 1 ? 's' : ''}.`
  };
}

// ── CREATE RAZORPAY ORDER (for one-time payment) ───────────
async function createOrder(amount, currency = 'INR', receipt) {
  if (!razorpay) {
    // Used to hand back a fake "demo" order that the frontend treated as a
    // successful checkout. No gateway means no payment — say so.
    throw Object.assign(new Error('Payments are not available yet.'), { status: 503, code: 'PAYMENTS_UNAVAILABLE' });
  }
  return razorpay.orders.create({ amount, currency, receipt: receipt || 'wg_' + Date.now() });
}

// ── CREATE RAZORPAY SUBSCRIPTION ───────────────────────────
async function createSubscription(planKey, clientId, discountCode) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error('Invalid plan');

  if (discountCode) {
    const validation = await validateDiscountCode(discountCode, null);
    if (validation.valid && validation.discount === 100) {
      return {
        type: 'free',
        plan: planKey,
        plan_name: plan.name,
        duration_months: validation.duration_months,
        discount_code: discountCode,
        activated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + validation.duration_months * 30 * 24 * 60 * 60 * 1000).toISOString(),
        message: `${plan.name} plan activated free for ${validation.duration_months} months!`,
      };
    }
  }

  if (!razorpay || !plan.razorpay_plan_id) {
    // This branch used to return a 'demo' subscription that the frontend
    // accepted as a paid upgrade. Paid plans cannot be bought until Razorpay
    // is configured; free-code activation (above) is unaffected.
    throw Object.assign(new Error('Paid plans are not open yet. Please use a launch code or check back soon.'),
      { status: 503, code: 'PAYMENTS_UNAVAILABLE' });
  }

  const payload = {
    plan_id: plan.razorpay_plan_id,
    customer_notify: 1,
    quantity: 1,
    total_count: 120,          // ten years of monthly cycles; the client can cancel any time
    notes: { client_id: clientId, plan_key: planKey, discount_code: discountCode || '' },
  };
  // A partial discount is only honoured through a Razorpay Offer created in the
  // dashboard (env RAZORPAY_OFFER_<CODE>). Without one we refuse rather than
  // show a discount on screen and then charge full price.
  if (discountCode) {
    const offer = offerIdFor(discountCode);
    if (!offer) {
      throw Object.assign(new Error('That code cannot be applied to a paid plan yet. Remove it to continue at the full price.'),
        { status: 400, code: 'OFFER_NOT_CONFIGURED' });
    }
    payload.offer_id = offer;
  }
  const subscription = await razorpay.subscriptions.create(payload);

  return { type: 'razorpay', subscription, plan: planKey, plan_name: plan.name, key_id: process.env.RAZORPAY_KEY_ID };
}

function offerIdFor(code) {
  return process.env['RAZORPAY_OFFER_' + String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')] || null;
}

// ── SIGNATURES ──────────────────────────────────────────────
// All three FAIL CLOSED: a missing secret means nothing verifies.
function safeEqualHex(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function hmac(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

// One-time order checkout: HMAC(order_id|payment_id)
function verifyPaymentSignature(orderId, paymentId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId) return false;
  return safeEqualHex(hmac(secret, `${orderId}|${paymentId}`), signature);
}

// Subscription checkout: HMAC(payment_id|subscription_id)  — note the order is reversed
function verifySubscriptionSignature(paymentId, subscriptionId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !paymentId || !subscriptionId) return false;
  return safeEqualHex(hmac(secret, `${paymentId}|${subscriptionId}`), signature);
}

// Webhook: HMAC of the RAW request body with the webhook secret (a different
// secret from the API key secret; you choose it when creating the webhook).
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;
  return safeEqualHex(hmac(secret, rawBody), signature);
}

module.exports = {
  PLANS,
  DISCOUNT_CODES,
  validateDiscountCode,
  createOrder,
  createSubscription,
  verifyPaymentSignature,
  verifySubscriptionSignature,
  verifyWebhookSignature,
  offerIdFor,
  getRazorpay: () => razorpay,
  isConfigured: !!razorpay,
};

