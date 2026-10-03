/**
 * Security and brief regression tests. Each block reproduces an attack or a bug
 * that was found in the code review, and asserts it no longer works.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.ADMIN_TRIGGER_KEY = 'adminkey-adminkey-adminkey';
delete process.env.RAZORPAY_KEY_SECRET;
const ck = require('./_check');
const Module = require('module'), orig = Module._load;
const makeDb = require('./_fakeDb');
const DB = makeDb();

// Stub the data layer and the outside world.
Module._load = function (r, p, i) {
  if (r.includes('config/supabase')) return { supabaseAdmin: DB, supabase: DB };
  if (r.endsWith('services/marketData') || r === './marketData')
    return { refreshAllMarketData: async () => ({ nifty: { price: 25000, change_pct: 0.4, source: 'nse_live' }, vix: 14, vixRegime: { regime: 'calm' }, sensex: { price: 82000, source: 'demo' } }),
             getNSEQuote: async () => null, classifyVIXRegime: () => ({}), getIndiaVIX: async () => 14 };
  return orig(r, p, i);
};
const bcrypt = require('bcrypt');
const express = require('express');
const http = require('http');
const session = require('../backend/lib/session');

const app = express();
app.use(express.json());
app.use('/api/auth', require('../backend/routes/auth'));
app.use('/api/clients', require('../backend/routes/clients'));
app.use('/api/portfolio', require('../backend/routes/portfolio'));
app.use('/api/goals', require('../backend/routes/goals'));
app.use('/api/payments', require('../backend/routes/payments'));
app.use('/api/brief', require('../backend/routes/brief'));
app.use('/api/signals', require('../backend/routes/signals'));
app.use('/api/admin', require('../backend/routes/admin'));
app.use((req, res) => res.status(404).json({ error: 'No such endpoint' }));
const srv = http.createServer(app);

function call(method, path, body, token, headers = {}) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path, method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                 ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } },
      r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: r.statusCode, body: j }); }); });
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 'TIMEOUT' }); });
    req.on('error', () => resolve({ status: 'ERROR' }));
    if (data) req.write(data); req.end();
  });
}

(async () => {
  const hash = await bcrypt.hash('123456', 4);
  DB.seed('clients', [
    { id: 'A', full_name: 'Alice', phone_wa: '9000000001', email: 'a@x.com', pin_set: true, pin_hash: hash, pin_attempts: 0, is_admin: false, subscription_status: 'none' },
    { id: 'B', full_name: 'Bob',   phone_wa: '9000000002', email: 'b@x.com', pin_set: true, pin_hash: hash, pin_attempts: 0, is_admin: false },
    { id: 'N', full_name: 'NoPin', phone_wa: '9000000003', email: null,      pin_set: false, pin_hash: null },
  ]);
  DB.seed('portfolios', [
    { id: 'hA', client_id: 'A', instrument_name: 'AAA', quantity: 10, avg_buy_price_inr: 100, current_price_inr: 100, asset_class: 'equity', is_active: true },
    { id: 'hB', client_id: 'B', instrument_name: 'BBB', quantity: 5,  avg_buy_price_inr: 200, current_price_inr: 200, asset_class: 'equity', is_active: true },
  ]);
  DB.seed('client_goals', [{ id: 'gB', client_id: 'B', goal_name: 'House', target_amount_inr: 100, is_active: true }]);

  const tA = session.issueSession('A'), tB = session.issueSession('B');

  console.log('\n── tokens ──');
  ck('a valid token verifies', session.verify(tA)?.sub === 'A');
  const [v, , tsig] = tA.split('.');
  const forged = `${v}.${Buffer.from(JSON.stringify({ sub: 'B', scope: 'session', iat: 1, exp: 9999999999 })).toString('base64url')}.${tsig}`;
  ck('a token with a swapped payload is rejected', session.verify(forged) === null);
  ck('garbage is rejected', session.verify('nonsense') === null && session.verify('') === null && session.verify(null) === null);
  const expired = (() => { const b = Buffer.from(JSON.stringify({ sub: 'A', scope: 'session', iat: 1, exp: 2 })).toString('base64url'); const crypto = require('crypto'); return `v1.${b}.${crypto.createHmac('sha256', process.env.JWT_SECRET).update(`v1.${b}`).digest('base64url')}`; })();
  ck('a correctly-signed but expired token is rejected', session.verify(expired) === null);

  console.log('\n── IDOR: one client reaching another ──');
  let r = await call('GET', '/api/portfolio/B');
  ck('no token → 401', r.status === 401);
  r = await call('GET', '/api/portfolio/B', null, tA);
  ck("Alice cannot read Bob's portfolio (403)", r.status === 403);
  r = await call('GET', '/api/clients/B/profile', null, tA);
  ck("Alice cannot read Bob's profile (403)", r.status === 403);
  r = await call('GET', '/api/goals/B', null, tA);
  ck("Alice cannot read Bob's goals (403)", r.status === 403);
  r = await call('GET', '/api/payments/status/B', null, tA);
  ck("Alice cannot read Bob's subscription (403)", r.status === 403);
  r = await call('GET', '/api/brief/B', null, tA);
  ck("Alice cannot read Bob's brief (403)", r.status === 403);
  r = await call('GET', '/api/signals/B', null, tA);
  ck("Alice cannot read signals as Bob (403)", r.status === 403);
  r = await call('GET', '/api/portfolio/A', null, tA);
  ck('Alice can read her own portfolio', r.status === 200 && r.body.holdings?.length === 1);
  r = await call('POST', '/api/portfolio/add', { client_id: 'B', instrument_name: 'EVIL', quantity: 1, avg_buy_price_inr: 1 }, tA);
  ck("Alice cannot add a holding into Bob's account", r.status === 403 && !DB.rows('portfolios').some(h => h.instrument_name === 'EVIL'));
  r = await call('PUT', '/api/portfolio/hB', { quantity: 999 }, tA);
  ck("Alice cannot edit Bob's holding", r.status === 404 && DB.rows('portfolios').find(h => h.id === 'hB').quantity === 5);
  r = await call('DELETE', '/api/portfolio/hB', null, tA);
  ck("Alice cannot delete Bob's holding", r.status === 404 && DB.rows('portfolios').find(h => h.id === 'hB').is_active === true);
  r = await call('PUT', '/api/goals/gB/progress', { current_corpus_inr: 50 }, tA);
  ck("Alice cannot change Bob's goal", r.status === 404 && !DB.rows('client_goals')[0].current_corpus_inr);

  console.log('\n── mass assignment ──');
  r = await call('PUT', '/api/clients/A/profile', { type: 'clients', updates: { is_admin: true, subscription_status: 'active', pin_hash: 'x', full_name: 'Alice K' } }, tA);
  const a = DB.rows('clients').find(c => c.id === 'A');
  ck('a profile edit applies allowed fields', a.full_name === 'Alice K');
  ck('…but cannot make you admin', a.is_admin === false);
  ck('…or give you a subscription', a.subscription_status === 'none');
  ck('…or overwrite your PIN hash', a.pin_hash === hash);
  r = await call('PUT', '/api/portfolio/hA', { quantity: 20, client_id: 'B', is_active: false }, tA);
  const hA = DB.rows('portfolios').find(h => h.id === 'hA');
  ck('a holding edit applies allowed fields', hA.quantity === 20);
  ck('…but cannot move the holding to another client or deactivate it', hA.client_id === 'A' && hA.is_active === true);
  r = await call('GET', '/api/clients/A/profile', null, tA);
  ck('the profile response never includes pin_hash', r.status === 200 && !('pin_hash' in (r.body.profile || {})));

  console.log('\n── PIN and login ──');
  r = await call('POST', '/api/auth/check', { phone_wa: '9000000001' });
  ck('/check says the number exists…', r.body.exists === true && r.body.pin_set === true);
  ck('…but no longer hands out the client id', !('client_id' in r.body));
  r = await call('POST', '/api/auth/login', { phone_wa: '9000000003' });
  ck('a PIN-less account is NOT logged in on a phone number', r.status === 403 && r.body.pin_setup_required === true);
  ck('…and no client data or token comes back', !r.body.client && !r.body.token);
  r = await call('POST', '/api/auth/login', { phone_wa: '9000000001', pin: '123456' });
  ck('correct PIN logs in and returns a token', r.status === 200 && !!r.body.token && session.verify(r.body.token)?.sub === 'A');
  ck('the login response never includes pin_hash', !('pin_hash' in (r.body.client || {})));
  r = await call('POST', '/api/auth/login', { phone_wa: '9000000001', pin: '000000' });
  ck('wrong PIN is refused', r.status === 401 && !r.body.token);
  r = await call('POST', '/api/auth/login', { phone_wa: '9999999999', pin: '123456' });
  ck('unknown number looks like a wrong PIN', r.status === 401);

  r = await call('POST', '/api/auth/set-pin', { client_id: 'B', pin: '111111' });
  ck('set-pin with no token is refused (was: anyone could overwrite any PIN)', r.status === 401);
  ck("…and Bob's PIN is untouched", DB.rows('clients').find(c => c.id === 'B').pin_hash === hash);
  r = await call('POST', '/api/auth/set-pin', { client_id: 'B', pin: '111111' }, tA);
  ck("Alice's session cannot overwrite an existing PIN (hers or Bob's)", r.status === 403 && DB.rows('clients').find(c => c.id === 'B').pin_hash === hash);
  const setup = session.issueSetupToken('N');
  r = await call('POST', '/api/auth/set-pin', { pin: '246810', confirm_pin: '246810' }, setup);
  ck('a setup token can set the PIN on the account it was issued for', r.status === 200 && !!r.body.token);
  ck('…and the PIN is stored hashed', await bcrypt.compare('246810', DB.rows('clients').find(c => c.id === 'N').pin_hash));
  r = await call('POST', '/api/auth/set-pin', { pin: '12ab56' }, session.issueSetupToken('N'));
  ck('a malformed PIN is refused', r.status === 400);
  r = await call('POST', '/api/auth/change-pin', { current_pin: '000000', new_pin: '654321' }, tA);
  ck('change-pin needs the current PIN', r.status === 401);
  r = await call('POST', '/api/auth/change-pin', { current_pin: '123456', new_pin: '654321' });
  ck('change-pin needs a session', r.status === 401);

  console.log('\n── registration signs the new client in ──');
  r = await call('POST', '/api/auth/register', { phone_wa: '9000000009', full_name: 'New', age: 30, stated_risk_score: 5 });
  ck('returns a session token', !!r.body.token && session.verify(r.body.token)?.sub === r.body.client_id);
  ck('profile answers mark onboarding_complete (brief engine depends on it)', DB.rows('clients').find(c => c.id === r.body.client_id).onboarding_complete === true);
  r = await call('POST', '/api/auth/set-pin', { pin: '135790' }, r.body.token);
  ck('the new account can set its first PIN with that session', r.status === 200);

  console.log('\n── payments fail closed ──');
  r = await call('POST', '/api/payments/verify', { order_id: 'o', payment_id: 'p', signature: 'anything', client_id: 'A', plan_key: 'builder' }, tA);
  ck('a payment is NOT verified when no Razorpay secret is configured', r.status === 400);
  r = await call('POST', '/api/payments/subscribe', { client_id: 'A', plan_key: 'builder' }, tA);
  ck('a paid plan cannot be "bought" without a gateway (503)', r.status === 503);
  ck('…no subscription row was created', DB.rows('subscriptions').length === 0);
  ck('…and the client was not upgraded', DB.rows('clients').find(c => c.id === 'A').subscription_status === 'none');
  r = await call('POST', '/api/payments/subscribe', { client_id: 'B', plan_key: 'builder' }, tA);
  ck("Alice cannot start a subscription for Bob", r.status === 403);
  r = await call('POST', '/api/payments/subscribe', { client_id: 'A', plan_key: 'builder', discount_code: 'WGFOUND01' }, tA);
  ck('a 100% launch code activates the plan', r.status === 200 && r.body.subscription?.type === 'free');
  ck('…status is active', DB.rows('clients').find(c => c.id === 'A').subscription_status === 'active');
  r = await call('POST', '/api/payments/subscribe', { client_id: 'A', plan_key: 'builder', discount_code: 'WGFOUND01' }, tA);
  ck('the same client cannot redeem the same code twice', r.status === 409 || r.status === 400);
  r = await call('POST', '/api/payments/subscribe', { client_id: 'B', plan_key: 'builder', discount_code: 'WGFOUND01' }, tB);
  ck('a single-use code cannot be redeemed by a second client', r.status >= 400 && DB.rows('discount_code_usage').filter(u => u.code === 'WGFOUND01').length === 1);
  r = await call('POST', '/api/payments/subscribe', { client_id: 'B', plan_key: 'builder', discount_code: 'LAUNCH9SEP' }, tB);
  ck('a paid-with-discount purchase still cannot succeed without a gateway, and does not burn the code', r.status === 503 && DB.rows('discount_code_usage').filter(u => u.code === 'LAUNCH9SEP').length === 0);

  console.log('\n── admin key ──');
  r = await call('GET', '/api/admin/issue-setup-code?phone=9000000003');
  ck('no key → 401', r.status === 401);
  r = await call('GET', '/api/admin/issue-setup-code?phone=9000000003&key=wrong');
  ck('wrong key → 401', r.status === 401);
  DB.rows('auth_codes').length = 0;
  r = await call('GET', '/api/admin/issue-setup-code?phone=9000000003', null, null, { 'x-admin-key': process.env.ADMIN_TRIGGER_KEY });
  ck('the key in a header works', r.status === 200 && /^\d{6}$/.test(r.body.code));
  const code = r.body.code;
  ck('the code is stored hashed, not in clear', !JSON.stringify(DB.rows('auth_codes')).includes(code));
  r = await call('POST', '/api/auth/verify-code', { phone_wa: '9000000003', code: '000000' });
  ck('a wrong code is refused', r.status === 401);
  r = await call('POST', '/api/auth/verify-code', { phone_wa: '9000000003', code });
  ck('the right code returns a short-lived set-PIN token', r.status === 200 && session.verify(r.body.setup_token)?.scope === 'setpin');
  r = await call('POST', '/api/auth/verify-code', { phone_wa: '9000000003', code });
  ck('a code works only once', r.status === 401);
  let last; for (let i = 0; i < 12; i++) last = await call('GET', '/api/admin/issue-setup-code?phone=x&key=bad' + i);
  ck('repeated wrong keys get locked out (429)', last.status === 429);
  ck('the old unauthenticated signal generator is gone', (await call('POST', '/api/signals/generate', { instrument_id: 1 })).status === 404);

  console.log('\n── morning brief ──');
  DB.seed('instrument_universe', [
    { symbol: 'LC1', name: 'Large One', category: 'large_cap_equity', status: 'active' },
    { symbol: 'LC2', name: 'Large Two', category: 'large_cap_equity', status: 'active' },
    { symbol: 'SM1', name: 'Small One', category: 'small_cap_equity', status: 'active' },
    { symbol: 'HELD', name: 'Held One', category: 'large_cap_equity', status: 'active' },
  ]);
  const sig = (s, a, c, extra = {}) => ({ client_id: null, instrument_name: s, action: a, confidence_score: c, is_active: true, risk_gate_passed: true, rationale_short: `${a} ${s}`, entry_price_inr: 100, target_price_inr: 110, stop_loss_inr: 95, horizon_days: 14, signal_tier: 'standard', generated_at: '2026-10-02', ...extra });
  DB.seed('recommendations', [sig('LC1', 'BUY', 0.8), sig('LC2', 'WATCH', 0.6), sig('SM1', 'BUY', 0.9), sig('HELD', 'SELL', 0.4)]);
  DB.seed('ai_events', [{ title: 'RBI holds rates', severity: 'MEDIUM', description: 'Policy unchanged.', status: 'active', detected_at: new Date().toISOString() }]);
  DB.seed('client_behavioural_profiles', [{ client_id: 'A', stated_risk_score: 2, assessed_at: '2026-09-01' }]);   // LOW risk
  DB.seed('portfolios', [{ id: 'hA2', client_id: 'A', instrument_name: 'HELD', quantity: 1, avg_buy_price_inr: 10, is_active: true }]);
  const tAnew = session.issueSession('A');

  r = await call('GET', '/api/brief/A', null, tAnew);
  const j = r.body.brief?.brief_json;
  ck('a client with no brief for today gets one on demand', r.status === 200 && !!r.body.brief && r.body.generated_on_demand === true);
  ck('it is stored for today (IST date)', DB.rows('morning_briefs').some(b => b.client_id === 'A'));
  ck('it carries a structured brief_json', !!j && Array.isArray(j.ideas) && Array.isArray(j.news));
  ck('the news section shows the AI-detected event', j?.news?.[0]?.title === 'RBI holds rates');
  const held = j?.holding_actions?.find(h => h.symbol === 'HELD');
  ck('the holding is reviewed against our signal (SELL → review)', held?.action === 'SELL' && /review/i.test(held.advice));
  ck('a holding we do not score is reported honestly', j?.holding_actions?.find(h => h.symbol === 'AAA')?.action === null);
  ck("today's action tells the client to review the SELL", /Review HELD/.test(j?.today_action || ''));
  ck('ideas use the client\'s RISK PROFILE (low risk → no small-cap)', !j?.ideas?.some(i => i.symbol === 'SM1'));
  ck('ideas recommend the BUY that fits', j?.ideas?.[0]?.symbol === 'LC1' && j.ideas[0].action === 'BUY' && j.ideas[0].entry === 100);
  ck('ideas never repeat something already held', !j?.ideas?.some(i => i.symbol === 'HELD'));
  ck('placeholder (demo) market values are not shown as fact', !/82,?000/.test(j?.market_snapshot || ''));
  const text = r.body.brief.whatsapp_message;
  ck('the plain-text brief (what the app shows) contains the sections', /TODAY:/.test(text) && /IN THE NEWS/.test(text) && /IDEAS WORTH A LOOK/.test(text));
  ck('the plain-text brief carries the not-advice line', /not a SEBI-registered/i.test(text));

  const n1 = DB.rows('morning_briefs').length;
  r = await call('GET', '/api/brief/A', null, tAnew);
  ck('the second request reuses the stored brief (no rebuild)', DB.rows('morning_briefs').length === n1 && !r.body.generated_on_demand);

  // no BUY available → honest answer
  DB.rows('recommendations').forEach(x => { if (x.action === 'BUY') x.action = 'WATCH'; });
  DB.rows('morning_briefs').length = 0;
  r = await call('GET', '/api/brief/A', null, tAnew);
  ck('with no qualifying BUY, the brief says so plainly', /No new BUY signals/.test(r.body.brief?.brief_json?.ideas_note || ''));

  // unmigrated DB: brief_json column missing
  DB.rejectColumns.morning_briefs = new Set(['brief_json']);
  DB.rows('morning_briefs').length = 0; 
  const warn = console.warn; console.warn = () => {};
  r = await call('GET', '/api/brief/A', null, session.issueSession('A'));
  console.warn = warn;
  ck('works before migration 006 (brief_json column absent): brief still stored', DB.rows('morning_briefs').length === 1 && !!r.body.brief?.whatsapp_message);

  // engine: briefs everyone, emails only active subscribers with an address
  DB.rejectColumns.morning_briefs = new Set();
  DB.rows('morning_briefs').length = 0;
  const email = require('../backend/services/emailEngine'); const sent = [];
  email.sendMorningBrief = async (c) => { sent.push(c.id); return true; };
  await require('../backend/services/morningBriefEngine').generateAndSendMorningBrief();
  const briefed = new Set(DB.rows('morning_briefs').map(b => b.client_id));
  ck('the 07:30 engine now stores a brief for EVERY client (not only onboarding_complete ones)', ['A', 'B', 'N'].every(id => briefed.has(id)));
  ck('…and emails only active subscribers', sent.length === 1 && sent[0] === 'A');

  srv.close();
})();
srv.listen(0);
