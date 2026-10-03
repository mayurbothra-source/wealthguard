/**
 * WealthGuard Auth Routes
 * POST /api/auth/check         — does this phone exist / has it a PIN (no id returned)
 * POST /api/auth/login         — phone_wa + pin → client data + session token
 * POST /api/auth/request-code  — emails a one-time code (accounts with no PIN yet)
 * POST /api/auth/verify-code   — code → short-lived set-PIN token
 * POST /api/auth/set-pin       — set-PIN token + pin → stores hash, returns session
 * POST /api/auth/change-pin    — session + current pin → new pin
 * POST /api/auth/register      — creates client; returns a set-PIN token
 */

const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const session = require('../lib/session');
const { limit } = require('../lib/rateLimit');
const { issueCode, consumeCode } = require('../lib/authCodes');
const emailEngine = require('../services/emailEngine');
const {
  CLIENT_FIELDS, LIFE_FIELDS, BEHAVIOURAL_FIELDS, pick,
} = require('../lib/clientFields');

// Per-IP throttles. The per-account lockout below stops guessing one account;
// these stop one machine trying many accounts, or flooding registration.
const authLimiter     = limit({ windowMs: 10 * 60e3, max: 30 });
const registerLimiter = limit({ windowMs: 60 * 60e3, max: 10, message: 'Too many sign-ups from this connection. Please try again later.' });
const codeLimiter     = limit({ windowMs: 60 * 60e3, max: 8 });

const BCRYPT_ROUNDS = 10;
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const PIN_LENGTH = 6;
// A real hash to compare against when the phone number is unknown, so a
// wrong-number login takes as long as a wrong-PIN login (no timing oracle).
const DUMMY_HASH = bcrypt.hashSync('000000', BCRYPT_ROUNDS);

// ── HELPERS ─────────────────────────────────────────────────

function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{6}$/.test(pin);
}

async function getClientByPhone(phone_wa) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('*')
    .eq('phone_wa', phone_wa.trim())
    .single();
  if (error || !data) return null;
  return data;
}

// Strips sensitive fields before sending client data to the frontend.
// The pin_hash must NEVER leave the backend under any circumstance.
function sanitiseClient(client) {
  const { pin_hash, pin_attempts, pin_locked_until, ...safe } = client;
  return safe;
}

// ── POST /api/auth/check ─────────────────────────────────────
// Lets the login screen check if a phone number exists before asking
// for a PIN — avoids exposing which numbers are registered by keeping
// the response vague when the number doesn't exist.
router.post('/check', authLimiter, async (req, res) => {
  const { phone_wa } = req.body || {};
  if (!phone_wa) return res.status(400).json({ error: 'phone_wa required' });
  const client = await getClientByPhone(String(phone_wa));
  // client_id is deliberately NOT returned. It used to be, which let anyone turn
  // a phone number into an id and then read that client's data.
  if (!client) return res.json({ exists: false, pin_set: false });
  res.json({ exists: true, pin_set: !!(client.pin_set && client.pin_hash) });
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  const { phone_wa, pin } = req.body || {};
  if (!phone_wa) {
    return res.status(400).json({ error: 'phone_wa is required' });
  }
  if (!session.issueSession('probe')) {
    return res.status(503).json({ error: 'Sign-in is temporarily unavailable.' });
  }

  const client = await getClientByPhone(String(phone_wa));
  if (!client) {
    await bcrypt.compare(String(pin || ''), DUMMY_HASH);   // equalise timing
    return res.status(401).json({ error: 'Incorrect phone number or PIN. Please try again.' });
  }

  // Check lockout
  if (client.pin_locked_until && new Date(client.pin_locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(client.pin_locked_until) - Date.now()) / 60000);
    return res.status(429).json({
      error: `Account temporarily locked after too many incorrect attempts. Try again in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.`,
      locked: true,
      locked_until: client.pin_locked_until,
    });
  }

  // No PIN yet. This branch used to log the caller straight in on the phone
  // number alone and return the whole client record. It now returns nothing
  // but an instruction: prove you own the account (emailed code), then set a PIN.
  if (!client.pin_set || !client.pin_hash) {
    return res.status(403).json({
      error: 'This account has no PIN yet. We will send a verification code to set one.',
      pin_setup_required: true,
      needs_code: true,
    });
  }

  if (!pin) return res.status(400).json({ error: 'PIN is required.' });

  // Verify PIN against stored bcrypt hash
  const pinValid = await bcrypt.compare(String(pin), client.pin_hash);

  if (!pinValid) {
    const newAttempts = (client.pin_attempts || 0) + 1;
    const shouldLock = newAttempts >= MAX_PIN_ATTEMPTS;
    const updatePayload = {
      pin_attempts: newAttempts,
      pin_locked_until: shouldLock
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
        : null,
    };
    await supabaseAdmin.from('clients').update(updatePayload).eq('id', client.id);

    if (shouldLock) {
      return res.status(429).json({
        error: `Incorrect PIN. Account locked for ${LOCKOUT_MINUTES} minutes after ${MAX_PIN_ATTEMPTS} failed attempts.`,
        locked: true,
      });
    }
    const remaining = MAX_PIN_ATTEMPTS - newAttempts;
    return res.status(401).json({
      error: `Incorrect PIN. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before temporary lockout.`,
    });
  }

  // Success — reset attempt counter and return client data plus a session token
  await supabaseAdmin.from('clients').update({
    pin_attempts: 0,
    pin_locked_until: null,
    last_login_at: new Date().toISOString(),
  }).eq('id', client.id);

  res.json({ success: true, client: sanitiseClient(client), token: session.issueSession(client.id) });
});

// ── POST /api/auth/request-code ──────────────────────────────
// Emails a one-time code to the address on file. The answer is always the
// same, so this cannot be used to find out which numbers are registered or
// which have an email.
router.post('/request-code', codeLimiter, async (req, res) => {
  const generic = { success: true, message: 'If this number has an email address on file, a code has been sent to it.' };
  const { phone_wa } = req.body || {};
  if (!phone_wa) return res.status(400).json({ error: 'phone_wa required' });
  try {
    const client = await getClientByPhone(String(phone_wa));
    if (client && client.email) {
      const issued = await issueCode(client.id, 'email');
      if (issued.code) await emailEngine.sendAuthCode(client, issued.code);
      else console.warn(`   ⚠ request-code: ${issued.error}`);
    }
  } catch (e) { console.warn(`   ⚠ request-code: ${e.message}`); }
  res.json(generic);
});

// ── POST /api/auth/verify-code ───────────────────────────────
// Exchanges a correct code for a short-lived "set a PIN" token.
router.post('/verify-code', codeLimiter, async (req, res) => {
  const { phone_wa, code } = req.body || {};
  if (!phone_wa || !code) return res.status(400).json({ error: 'phone_wa and code are required' });
  const client = await getClientByPhone(String(phone_wa));
  const ok = client ? await consumeCode(client.id, String(code).trim()) : false;
  if (!ok) return res.status(401).json({ error: 'That code is not valid or has expired.' });
  res.json({ success: true, setup_token: session.issueSetupToken(client.id) });
});

// ── POST /api/auth/set-pin ───────────────────────────────────
// Needs the short-lived setup token (from registration or a verified code).
// It used to accept just {client_id, pin} from anyone — i.e. anyone could
// overwrite anyone's PIN. The id now comes from the token, not the body.
router.post('/set-pin', authLimiter, session.requireSetupOrSession, async (req, res) => {
  const { pin, confirm_pin } = req.body || {};
  const client_id = req.auth.clientId;
  if (!pin) return res.status(400).json({ error: 'pin is required' });
  if (!isValidPin(String(pin))) {
    return res.status(400).json({ error: 'PIN must be exactly 6 digits.' });
  }
  if (confirm_pin && String(pin) !== String(confirm_pin)) {
    return res.status(400).json({ error: 'PINs do not match. Please try again.' });
  }

  // A plain session may set a PIN only on an account that has none yet. Changing
  // an existing PIN needs /change-pin (current PIN) or a verified emailed code.
  if (req.auth.scope === 'session') {
    const { data: cur } = await supabaseAdmin.from('clients').select('pin_set, pin_hash').eq('id', client_id).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Account not found.' });
    if (cur.pin_set && cur.pin_hash) return res.status(403).json({ error: 'This account already has a PIN. Use "change PIN".' });
  }

  const hash = await bcrypt.hash(String(pin), BCRYPT_ROUNDS);
  const { error } = await supabaseAdmin.from('clients').update({
    pin_hash: hash,
    pin_set: true,
    pin_attempts: 0,
    pin_locked_until: null,
  }).eq('id', client_id);

  if (error) return res.status(500).json({ error: 'Could not save PIN.' });
  res.json({ success: true, message: 'PIN set successfully.', token: session.issueSession(client_id) });
});

// ── POST /api/auth/change-pin ─────────────────────────────────
// Requires a signed-in session AND the current PIN.
router.post('/change-pin', authLimiter, session.requireSession, async (req, res) => {
  const { current_pin, new_pin } = req.body || {};
  const client_id = req.auth.clientId;
  if (!current_pin || !new_pin) {
    return res.status(400).json({ error: 'current_pin and new_pin are required' });
  }
  if (!isValidPin(String(new_pin))) {
    return res.status(400).json({ error: 'New PIN must be exactly 6 digits.' });
  }

  const { data: client } = await supabaseAdmin
    .from('clients').select('pin_hash,pin_set').eq('id', client_id).single();
  if (!client || !client.pin_hash) {
    return res.status(400).json({ error: 'No PIN set on this account.' });
  }

  const currentValid = await bcrypt.compare(String(current_pin), client.pin_hash);
  if (!currentValid) {
    return res.status(401).json({ error: 'Current PIN is incorrect.' });
  }

  const newHash = await bcrypt.hash(String(new_pin), BCRYPT_ROUNDS);
  await supabaseAdmin.from('clients').update({ pin_hash: newHash, pin_attempts: 0 }).eq('id', client_id);
  res.json({ success: true, message: 'PIN changed successfully.' });
});

// ── POST /api/auth/register ──────────────────────────────────
// Creates the initial client record (no PIN yet — PIN is set after
// onboarding in a dedicated /set-pin step).
// Field allow-lists live in lib/clientFields.js (shared with the profile route).

router.post('/register', registerLimiter, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured.' });
  }

  const body = req.body || {};
  const { phone_wa, full_name } = body;
  if (!phone_wa || !full_name) {
    return res.status(400).json({ error: 'phone_wa and full_name are required' });
  }

  const existing = await getClientByPhone(phone_wa);
  if (existing) {
    return res.status(409).json({ error: 'An account with this phone number already exists.' });
  }

  // clients.email is UNIQUE. Say so plainly rather than surfacing a raw
  // Postgres constraint name to someone signing up.
  if (body.email) {
    const { data: dupe } = await supabaseAdmin
      .from('clients').select('id').eq('email', String(body.email).trim().toLowerCase()).limit(1);
    if (dupe && dupe.length) {
      return res.status(409).json({ error: 'An account with this email address already exists.' });
    }
  }

  // Warn about anything the form sends that no table claims — a silent drop
  // is how a field goes missing for weeks without anyone noticing.
  const known = new Set([...CLIENT_FIELDS, ...LIFE_FIELDS, ...BEHAVIOURAL_FIELDS, 'goals']);
  const unknown = Object.keys(body).filter(k => !known.has(k));
  if (unknown.length) {
    console.warn(`   ⚠ /auth/register ignored unrecognised field(s): ${unknown.join(', ')}. ` +
                 `Add them to the right allow-list in routes/auth.js if they should persist.`);
  }

  // ── 1. The client row ────────────────────────────────────────────
  const clientRow = {
    ...pick(body, CLIENT_FIELDS),
    phone_wa: String(phone_wa).trim(),
    full_name: String(full_name).trim(),
    pin_set: false,
    // The onboarding questionnaire IS the registration payload, so a client who
    // arrives with profile answers has completed it. Nothing else in the code
    // ever set this to true, which is why the morning-brief engine (which only
    // briefs onboarding_complete clients) skipped every account.
    onboarding_complete: Object.keys(pick(body, LIFE_FIELDS)).length > 0
                      || Object.keys(pick(body, BEHAVIOURAL_FIELDS)).length > 0,
  };
  if (clientRow.email) clientRow.email = String(clientRow.email).trim().toLowerCase();

  const { data, error } = await supabaseAdmin
    .from('clients').insert(clientRow).select('id').single();

  if (error) {
    console.error(`   ❌ /auth/register: clients insert failed — ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
  const clientId = data.id;

  // ── 2. The three child records ───────────────────────────────────
  // Each is attempted independently. The account already exists at this point,
  // so a failure here must not fail the whole registration and leave the user
  // unable to sign up — it is reported and the account still works.
  const warnings = [];

  const life = pick(body, LIFE_FIELDS);
  if (Object.keys(life).length) {
    const { error: e } = await supabaseAdmin
      .from('client_life_profiles').insert({ client_id: clientId, ...life });
    if (e) { warnings.push(`life profile: ${e.message}`); console.warn(`   ⚠ ${e.message}`); }
  }

  const behav = pick(body, BEHAVIOURAL_FIELDS);
  if (Object.keys(behav).length) {
    const { error: e } = await supabaseAdmin
      .from('client_behavioural_profiles').insert({ client_id: clientId, ...behav });
    if (e) { warnings.push(`behavioural profile: ${e.message}`); console.warn(`   ⚠ ${e.message}`); }
  }

  // goals is an ARRAY. Spreading it into `clients` is what broke registration.
  if (Array.isArray(body.goals) && body.goals.length) {
    const rows = body.goals
      .filter(g => g && g.goal_name)
      .map((g, i) => ({
        client_id:         clientId,
        goal_name:         String(g.goal_name).slice(0, 200),
        target_amount_inr: Number(g.target_amount_inr) || null,
        // The form collects a year ("2045"); the column is a DATE.
        target_date:       g.target_date
          ? (/^\d{4}$/.test(String(g.target_date).trim())
              ? `${String(g.target_date).trim()}-03-31`
              : g.target_date)
          : null,
        bucket_number:     i + 1,
        priority_rank:     i + 1,
        is_active:         true,
      }));
    if (rows.length) {
      const { error: e } = await supabaseAdmin.from('client_goals').insert(rows);
      if (e) { warnings.push(`goals: ${e.message}`); console.warn(`   ⚠ goals insert: ${e.message}`); }
    }
  }

  console.log(`   ✓ Registered ${clientRow.full_name} (${clientId})` +
              (warnings.length ? ` with ${warnings.length} warning(s)` : ''));

  res.json({
    success: true,
    client_id: clientId,
    // The registrant is signed in straight away (so plan activation and the PIN
    // step work), and also gets a short-lived set-PIN token.
    token: session.issueSession(clientId),
    setup_token: session.issueSetupToken(clientId),
    ...(warnings.length ? { warnings } : {}),
  });
});

module.exports = router;
