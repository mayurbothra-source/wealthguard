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
    return { id: 'demo_order_' + Date.now(), amount, currency, status: 'demo' };
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
    return {
      type: 'demo',
      plan: planKey,
      plan_name: plan.name,
      amount: plan.amount,
      demo_subscription_id: 'demo_sub_' + Date.now(),
      message: 'Demo subscription created. Add Razorpay credentials to go live.',
    };
  }

  const subscription = await razorpay.subscriptions.create({
    plan_id: plan.razorpay_plan_id,
    customer_notify: 1,
    quantity: 1,
    total_count: 12,
    notes: { client_id: clientId, discount_code: discountCode || '' },
  });

  return { type: 'razorpay', subscription, plan: planKey, plan_name: plan.name };
}

// ── VERIFY RAZORPAY PAYMENT SIGNATURE ──────────────────────
function verifyPaymentSignature(orderId, paymentId, signature) {
  if (!process.env.RAZORPAY_KEY_SECRET) return true; // demo mode
  const body = orderId + '|' + paymentId;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest('hex');
  return expectedSignature === signature;
}

module.exports = {
  PLANS,
  DISCOUNT_CODES,
  validateDiscountCode,
  createOrder,
  createSubscription,
  verifyPaymentSignature,
  isConfigured: !!razorpay,
};

