/**
 * One-time codes for setting or resetting a PIN.
 *
 * Issued by either (a) emailing the client at the address on file, or (b) an
 * admin, for accounts with no email. Stored hashed, single-use, 15 minutes,
 * at most 5 wrong guesses. Needs the auth_codes table (migration 006).
 */
'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../../config/supabase');

const TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_ISSUED_PER_HOUR = 3;

const hash = (code, clientId) =>
  crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-only')
    .update(`${clientId}:${code}`).digest('hex');

/** Returns { code } or { error }. */
async function issueCode(clientId, channel = 'email') {
  if (!supabaseAdmin) return { error: 'Database not configured.' };
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const { data: recent, error: e1 } = await supabaseAdmin
    .from('auth_codes').select('id').eq('client_id', clientId).gte('created_at', since);
  if (e1) return { error: `auth_codes table unavailable (${e1.message}). Run migration 006.` };
  if ((recent || []).length >= MAX_ISSUED_PER_HOUR) return { error: 'Too many codes requested. Try again in an hour.', throttled: true };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const { error } = await supabaseAdmin.from('auth_codes').insert({
    client_id: clientId, code_hash: hash(code, clientId), channel,
    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
  });
  if (error) return { error: error.message };
  return { code };
}

/** Returns true only for a correct, unused, unexpired code (and consumes it). */
async function consumeCode(clientId, code) {
  if (!supabaseAdmin || !/^\d{6}$/.test(String(code))) return false;
  const { data: row } = await supabaseAdmin
    .from('auth_codes').select('*')
    .eq('client_id', clientId).is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!row || row.attempts >= MAX_ATTEMPTS) return false;

  const ok = crypto.timingSafeEqual(
    Buffer.from(row.code_hash, 'hex'), Buffer.from(hash(String(code), clientId), 'hex'));
  if (!ok) {
    await supabaseAdmin.from('auth_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
    return false;
  }
  await supabaseAdmin.from('auth_codes').update({ used_at: new Date().toISOString() }).eq('id', row.id);
  return true;
}

module.exports = { issueCode, consumeCode };
