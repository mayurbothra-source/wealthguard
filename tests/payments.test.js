/**
 * Razorpay integration tests with a MOCKED gateway: signature maths, subscription
 * checkout, the verify step, the webhook lifecycle, and server-side plan limits.
 * No network, no real keys.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.RAZORPAY_KEY_ID = 'rzp_test_KEYID';
process.env.RAZORPAY_KEY_SECRET = 'key_secret_for_tests';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook_secret_for_tests';
process.env.RAZORPAY_PLAN_BUILDER = 'plan_builder';
process.env.RAZORPAY_PLAN_STARTER = 'plan_starter';
process.env.RAZORPAY_OFFER_WGEARLY = 'offer_early';
const crypto = require('crypto');
const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const makeDb = require('./_fakeDb');
const DB = makeDb();
const created = [];
const cancelled = [];
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r === 'razorpay') return function Razorpay() {
    return { subscriptions: { create: async (payload) => { created.push(payload); return { id: 'sub_' + created.length, status: 'created' }; },
                              cancel: async (id) => { cancelled.push(id); return { id, status: 'cancelled' }; } },
             orders: { create: async () => ({ id: 'order_1' }) } };
  };
  return orig(r, p, i);
};
const express = require('express'), http = require('http');
const session = require('../backend/lib/session');
const payments = require('../backend/routes/payments');
const { entitlementFromRow } = require('../backend/lib/entitlements');
const svc = require('../backend/services/payment');

const app = express();
app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '100kb' }), (q, s, n) => payments.handleWebhook(q, s).catch(n));
app.use(express.json());
app.use('/api/payments', payments);
app.use('/api/signals', require('../backend/routes/signals'));
const srv = http.createServer(app);

function call(method, path, body, token, headers = {}, raw) {
  return new Promise(resolve => {
    const data = raw != null ? raw : body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path, method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                 ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } },
      r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', () => resolve({ status: 'ERROR' }));
    if (data) req.write(data); req.end();
  });
}
const hmac = (secret, t) => crypto.createHmac('sha256', secret).update(t).digest('hex');
const hook = (evt, id, sigOverride) => {
  const raw = JSON.stringify(evt);
  return call('POST', '/api/payments/webhook', null, null,
    { 'x-razorpay-signature': sigOverride || hmac('webhook_secret_for_tests', raw), 'x-razorpay-event-id': id }, raw);
};

srv.listen(0, async () => {
  DB.seed('clients', [
    { id: 'A', full_name: 'Alice', subscription_status: 'none' },
    { id: 'B', full_name: 'Bob', subscription_status: 'none' },
  ]);
  const tA = session.issueSession('A'), tB = session.issueSession('B');

  console.log('\n── signature maths ──');
  const good = hmac('key_secret_for_tests', 'pay_1|sub_9');
  ck('subscription signature is HMAC(payment|subscription)', svc.verifySubscriptionSignature('pay_1', 'sub_9', good));
  ck('reversed order is rejected', !svc.verifySubscriptionSignature('sub_9', 'pay_1', good));
  ck('tampered signature rejected', !svc.verifySubscriptionSignature('pay_1', 'sub_9', good.replace(/.$/, c => (c === '0' ? '1' : '0'))));
  ck('missing parts rejected', !svc.verifySubscriptionSignature('', 'sub_9', good) && !svc.verifySubscriptionSignature('pay_1', 'sub_9', undefined));
  ck('webhook signature uses the webhook secret over the raw body', svc.verifyWebhookSignature('{"a":1}', hmac('webhook_secret_for_tests', '{"a":1}')));
  ck('webhook signed with the API secret is rejected', !svc.verifyWebhookSignature('{"a":1}', hmac('key_secret_for_tests', '{"a":1}')));

  console.log('\n── subscribe → verify ──');
  let r = await call('POST', '/api/payments/subscribe', { client_id: 'A', plan_key: 'builder' }, tA);
  ck('paid subscribe returns key id + subscription id', r.status === 200 && r.body.razorpay_key === 'rzp_test_KEYID' && r.body.razorpay_subscription_id === 'sub_1');
  ck('the secret is never sent to the browser', !JSON.stringify(r.body).includes('key_secret_for_tests'));
  ck('subscription is created on the right plan with client in notes', created[0].plan_id === 'plan_builder' && created[0].notes.client_id === 'A');
  ck('subscription row is pending, not active', DB.rows('subscriptions').find(x => x.client_id === 'A').status === 'pending');
  ck('client is NOT active before payment', DB.rows('clients').find(c => c.id === 'A').subscription_status !== 'active');

  r = await call('POST', '/api/payments/subscribe', { client_id: 'A', plan_key: 'builder' }, tA);
  ck('retrying checkout leaves one pending row, not a pile', DB.rows('subscriptions').filter(x => x.client_id === 'A').length === 1);
  const subId = DB.rows('subscriptions').find(x => x.client_id === 'A').razorpay_subscription_id;

  r = await call('POST', '/api/payments/verify', { client_id: 'A', subscription_id: subId, payment_id: 'pay_1', signature: 'forged' }, tA);
  ck('forged signature rejected', r.status === 400);
  r = await call('POST', '/api/payments/verify', { client_id: 'B', subscription_id: subId, payment_id: 'pay_1', signature: hmac('key_secret_for_tests', `pay_1|${subId}`) }, tB);
  ck("another client cannot claim A's subscription with a valid signature", r.status === 404 && DB.rows('clients').find(c => c.id === 'B').subscription_status !== 'active');
  r = await call('POST', '/api/payments/verify', { client_id: 'A', subscription_id: subId, payment_id: 'pay_1', signature: hmac('key_secret_for_tests', `pay_1|${subId}`) }, tA);
  const cA = () => DB.rows('clients').find(c => c.id === 'A');
  ck('valid signature activates the right client and plan', r.status === 200 && cA().subscription_status === 'active' && cA().subscription_plan === 'builder');

  console.log('\n── webhook lifecycle ──');
  r = await call('POST', '/api/payments/webhook', null, null, { 'x-razorpay-signature': 'bad' }, '{"event":"subscription.charged"}');
  ck('webhook with a bad signature is refused', r.status === 400);
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  const ev = (event, extra = {}) => ({ event, payload: { subscription: { entity: { id: subId, current_end: end, ...extra } }, payment: { entity: { id: 'pay_2' } } } });
  r = await hook(ev('subscription.charged'), 'evt_1');
  ck('charged: active, expiry = billing period end', r.status === 200 && cA().subscription_status === 'active' && new Date(cA().subscription_expires_at).getTime() === end * 1000);
  const before = JSON.stringify(cA());
  r = await hook(ev('subscription.halted'), 'evt_1');
  ck('a replayed event id is ignored (idempotent)', r.body.duplicate === true && JSON.stringify(cA()) === before);
  r = await hook(ev('subscription.pending'), 'evt_2');
  ck('failed renewal starts the grace period', cA().subscription_status === 'payment_failed' && cA().grace_stage === 1);
  r = await hook(ev('subscription.charged'), 'evt_3');
  ck('a later successful charge clears the grace period', cA().subscription_status === 'active' && cA().grace_stage === 0 && !cA().payment_failed_at);
  r = await hook(ev('subscription.cancelled'), 'evt_4');
  ck('cancelled keeps access until the period ends', cA().subscription_status === 'cancelled' && new Date(cA().subscription_expires_at).getTime() === end * 1000);
  r = await hook({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_unknown', current_end: end } } } }, 'evt_5');
  ck('an unknown subscription id changes nothing and does not error', r.status === 200 && r.body.unknown_subscription === true);
  r = await hook(ev('subscription.completed'), 'evt_6');
  ck('completed/expired → read-only', cA().subscription_status === 'read_only');

  console.log('\n── upgrading never bills two plans ──');
  DB.seed('clients', [{ id: 'C', full_name: 'Carol', subscription_status: 'active', subscription_plan: 'starter' }]);
  DB.seed('subscriptions', [{ id: 'old1', client_id: 'C', plan_key: 'starter', status: 'active', razorpay_subscription_id: 'sub_OLD',
    subscription_type: 'razorpay', started_at: new Date(Date.now() - 864e5).toISOString() }]);
  const tC = session.issueSession('C');
  r = await call('POST', '/api/payments/subscribe', { client_id: 'C', plan_key: 'builder' }, tC);
  ck('starting an upgrade does NOT cancel the old plan yet (checkout may be abandoned)', cancelled.length === 0 && DB.rows('subscriptions').find(x => x.id === 'old1').status === 'active');
  const newId = r.body.razorpay_subscription_id;
  await call('POST', '/api/payments/verify', { client_id: 'C', subscription_id: newId, payment_id: 'pay_9', signature: hmac('key_secret_for_tests', `pay_9|${newId}`) }, tC);
  const cC = () => DB.rows('clients').find(c => c.id === 'C');
  ck('after the new payment is verified, the old Razorpay plan is cancelled', cancelled.includes('sub_OLD'));
  ck('…the old row is marked cancelled and the new one is active', DB.rows('subscriptions').find(x => x.id === 'old1').status === 'cancelled' && cC().subscription_plan === 'builder' && cC().subscription_status === 'active');
  const lateEvt = { event: 'subscription.cancelled', payload: { subscription: { entity: { id: 'sub_OLD', current_end: end } } } };
  r = await hook(lateEvt, 'evt_old_cancel');
  ck("Razorpay's late 'cancelled' for the OLD plan does not downgrade the client", r.status === 200 && cC().subscription_plan === 'builder' && cC().subscription_status === 'active');
  r = await call('POST', '/api/payments/webhook', null, null, { 'x-razorpay-signature': 'nope' }, '{"event":"x"}');
  ck('a rejected webhook still answers 400 (and logs why)', r.status === 400);

  console.log('\n── partial discount codes ──');
  r = await call('POST', '/api/payments/subscribe', { client_id: 'B', plan_key: 'builder', discount_code: 'LAUNCH9SEP' }, tB);
  ck('a % code with no Razorpay offer is refused, not silently charged full price', r.status === 400 && /cannot be applied/i.test(r.body.error));
  ck('…and the code is returned to the pool', DB.rows('discount_code_usage').filter(x => x.code === 'LAUNCH9SEP').length === 0);
  r = await call('POST', '/api/payments/subscribe', { client_id: 'B', plan_key: 'builder', discount_code: 'WGEARLY' }, tB);
  ck('a % code WITH an offer id is passed to Razorpay', r.status === 200 && created[created.length - 1].offer_id === 'offer_early');

  console.log('\n── plan limits are enforced by the server ──');
  const mk = (n) => Array.from({ length: n }, (_, k) => ({ id: 's' + k, client_id: null, risk_gate_passed: true, is_active: true, confidence_score: 0.8, action: 'BUY', generated_at: new Date(Date.now() - k * 3600e3).toISOString() }));
  DB.seed('recommendations', mk(30));
  const plan = (id, p, st = 'active', extra = {}) => { Object.assign(DB.rows('clients').find(c => c.id === id), { subscription_plan: p, subscription_status: st, subscription_expires_at: new Date(Date.now() + 864e5).toISOString(), ...extra }); };
  plan('A', 'starter'); r = await call('GET', '/api/signals/A?limit=100', null, tA);
  ck('starter gets at most 7 signals even when asking for 100', r.body.count === 7);
  plan('A', 'builder'); r = await call('GET', '/api/signals/A?limit=100', null, tA);
  ck('builder gets 15', r.body.count === 15);
  plan('A', 'wealth_builder'); r = await call('GET', '/api/signals/A?limit=100', null, tA);
  ck('wealth builder gets 25', r.body.count === 25);
  plan('A', 'builder', 'read_only'); r = await call('GET', '/api/signals/A', null, tA);
  ck('read-only gets no live signals and a clear message', r.body.count === 0 && r.body.access === 'read_only');
  plan('A', null, 'none'); r = await call('GET', '/api/signals/A', null, tA);
  ck('no plan → no live signals', r.body.count === 0);
  const e = (o) => entitlementFromRow(o).access;
  const past = new Date(Date.now() - 10 * 864e5).toISOString(), fut = new Date(Date.now() + 864e5).toISOString();
  ck('active but 10 days past expiry → read-only', e({ subscription_status: 'active', subscription_plan: 'builder', subscription_expires_at: past }) === 'read_only');
  ck('cancelled but paid up → still full', e({ subscription_status: 'cancelled', subscription_plan: 'builder', subscription_expires_at: fut }) === 'full');
  ck('payment failed, early grace → full; late grace → read-only', e({ subscription_status: 'payment_failed', grace_stage: 1 }) === 'full' && e({ subscription_status: 'payment_failed', grace_stage: 3 }) === 'read_only');
  ck('trial without a plan gets the Builder allowance', entitlementFromRow({ subscription_status: 'trial' }).signalLimit === 15);

  srv.close();
});
