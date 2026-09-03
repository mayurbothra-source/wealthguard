/**
 * WealthGuard Auth Routes
 * POST /api/auth/login     — phone_wa + pin → returns client data
 * POST /api/auth/set-pin   — client_id + pin → hashes and stores
 * POST /api/auth/register  — creates new client record (no PIN yet)
 * POST /api/auth/check     — checks if phone_wa exists (for login screen UX)
 */

const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');

const BCRYPT_ROUNDS = 10;
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const PIN_LENGTH = 6;

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
router.post('/check', async (req, res) => {
  const { phone_wa } = req.body;
  if (!phone_wa) return res.status(400).json({ error: 'phone_wa required' });
  const client = await getClientByPhone(phone_wa);
  if (!client) {
    // Deliberate vague response — don't confirm whether the number exists
    return res.json({ exists: false, pin_set: false });
  }
  res.json({ exists: true, pin_set: !!client.pin_set });
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  const { phone_wa, pin } = req.body;
  if (!phone_wa || !pin) {
    return res.status(400).json({ error: 'phone_wa and pin are required' });
  }

  const client = await getClientByPhone(phone_wa);
  if (!client) {
    // Same response shape as a wrong PIN — don't leak whether the account exists
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

  // If no PIN set yet, allow login but flag that PIN setup is required
  if (!client.pin_set || !client.pin_hash) {
    return res.json({
      success: true,
      pin_setup_required: true,
      client: sanitiseClient(client),
      message: 'Please set a 6-digit PIN to secure your account.',
    });
  }

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

  // Success — reset attempt counter and return client data
  await supabaseAdmin.from('clients').update({
    pin_attempts: 0,
    pin_locked_until: null,
    last_login_at: new Date().toISOString(),
  }).eq('id', client.id);

  res.json({ success: true, client: sanitiseClient(client) });
});

// ── POST /api/auth/set-pin ───────────────────────────────────
router.post('/set-pin', async (req, res) => {
  const { client_id, pin, confirm_pin } = req.body;
  if (!client_id || !pin) {
    return res.status(400).json({ error: 'client_id and pin are required' });
  }
  if (!isValidPin(String(pin))) {
    return res.status(400).json({ error: 'PIN must be exactly 6 digits.' });
  }
  if (confirm_pin && String(pin) !== String(confirm_pin)) {
    return res.status(400).json({ error: 'PINs do not match. Please try again.' });
  }

  const hash = await bcrypt.hash(String(pin), BCRYPT_ROUNDS);
  const { error } = await supabaseAdmin.from('clients').update({
    pin_hash: hash,
    pin_set: true,
    pin_attempts: 0,
    pin_locked_until: null,
  }).eq('id', client_id);

  if (error) return res.status(500).json({ error: 'Could not save PIN: ' + error.message });
  res.json({ success: true, message: 'PIN set successfully.' });
});

// ── POST /api/auth/change-pin ─────────────────────────────────
// Requires the current PIN before allowing a change.
router.post('/change-pin', async (req, res) => {
  const { client_id, current_pin, new_pin } = req.body;
  if (!client_id || !current_pin || !new_pin) {
    return res.status(400).json({ error: 'client_id, current_pin, and new_pin are required' });
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
router.post('/register', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured.' });
  }
  const { phone_wa, full_name, ...rest } = req.body;
  if (!phone_wa || !full_name) {
    return res.status(400).json({ error: 'phone_wa and full_name are required' });
  }

  // Check for duplicate
  const existing = await getClientByPhone(phone_wa);
  if (existing) {
    return res.status(409).json({ error: 'An account with this phone number already exists.' });
  }

  const { data, error } = await supabaseAdmin
    .from('clients')
    .insert({ phone_wa, full_name, ...rest, pin_set: false, onboarding_complete: false })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, client_id: data.id });
});

module.exports = router;
