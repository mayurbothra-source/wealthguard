/**
 * WealthGuard session tokens.
 *
 * WHY THIS EXISTS
 * Until now the server trusted whatever `client_id` the browser sent, so
 * anyone who knew (or could look up) an id could read or change that
 * client's data. A token is a server-signed statement "this caller proved
 * they are client X". Routes take the identity from the token and ignore any
 * id in the URL or body that does not match it.
 *
 * FORMAT   v1.<base64url(payload)>.<base64url(HMAC-SHA256)>
 * PAYLOAD  { sub: clientId, scope: 'session' | 'setpin', iat, exp }
 *
 *   session — normal login, 14 days
 *   setpin  — issued only after registration or a verified emailed/admin
 *             code; valid 15 minutes; can do exactly one thing: set a PIN.
 *
 * No external dependency: Node's crypto is enough for HMAC-signed tokens.
 * The signing key is JWT_SECRET (already present in Render). If it is
 * missing in production, tokens cannot be issued and login fails closed.
 */
'use strict';

const crypto = require('crypto');

const SESSION_TTL_S = 14 * 24 * 3600;
const SETUP_TTL_S   = 15 * 60;

let _ephemeral = null;
function secret() {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 8) {
    if (s.length < 32 && !secret._warned) {
      secret._warned = true;
      console.warn('   ⚠ JWT_SECRET is shorter than 32 characters. Use a long random string (e.g. 64 hex characters).');
    }
    return s;
  }
  if (process.env.NODE_ENV === 'production') return null;           // fail closed
  if (!_ephemeral) {
    _ephemeral = crypto.randomBytes(32).toString('hex');
    console.warn('   ⚠ JWT_SECRET not set — using a temporary key. Sessions will not survive a restart.');
  }
  return _ephemeral;
}

const b64 = buf => Buffer.from(buf).toString('base64url');
const sign = data => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

function issue(clientId, scope, ttl) {
  if (!secret()) return null;
  const now = Math.floor(Date.now() / 1000);
  const body = b64(JSON.stringify({ sub: String(clientId), scope, iat: now, exp: now + ttl }));
  return `v1.${body}.${sign(`v1.${body}`)}`;
}

const issueSession    = clientId => issue(clientId, 'session', SESSION_TTL_S);
const issueSetupToken = clientId => issue(clientId, 'setpin',  SETUP_TTL_S);

/** Returns the payload, or null for anything malformed, forged or expired. */
function verify(token) {
  if (typeof token !== 'string' || !secret()) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = sign(`v1.${parts[1]}`);
  const a = Buffer.from(parts[2]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || !payload.sub || !payload.exp) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

/** AUTH_ENFORCE=false is a temporary rollout escape hatch, nothing more. */
const enforcing = () => String(process.env.AUTH_ENFORCE || 'true').toLowerCase() !== 'false';

/**
 * requireSession — the caller must hold a valid session token.
 * Sets req.auth = { clientId, scope }.
 */
function requireSession(req, res, next) {
  const p = verify(bearer(req));
  if (p && p.scope === 'session') { req.auth = { clientId: p.sub, scope: p.scope }; return next(); }
  if (!enforcing()) {
    console.warn(`   ⚠ AUTH_ENFORCE=false — unauthenticated call allowed: ${req.method} ${req.originalUrl.split('?')[0]}`);
    req.auth = { clientId: req.params.clientId || (req.body && req.body.client_id) || null, scope: 'session', soft: true };
    return next();
  }
  return res.status(401).json({ error: 'Please log in again.', auth_required: true });
}

/** requireSetupToken — only the short-lived "set a PIN" token is accepted. */
function requireSetupToken(req, res, next) {
  const p = verify(bearer(req));
  if (p && p.scope === 'setpin') { req.auth = { clientId: p.sub, scope: p.scope }; return next(); }
  return res.status(401).json({ error: 'This link has expired. Please start again.', auth_required: true });
}

/**
 * requireSetupOrSession — for set-pin. Accepts the short-lived setup token, or an
 * ordinary session (a brand-new account's registration session). The route then
 * refuses a session if the account already has a PIN, so a stolen session can
 * never overwrite an existing PIN.
 */
function requireSetupOrSession(req, res, next) {
  const p = verify(bearer(req));
  if (p && (p.scope === 'setpin' || p.scope === 'session')) { req.auth = { clientId: p.sub, scope: p.scope }; return next(); }
  return res.status(401).json({ error: 'Please start again.', auth_required: true });
}

/**
 * ownsParam('clientId') — after requireSession: the id in the URL must be the
 * caller's own. A mismatch is 403, never a silent substitution, so a bug in
 * the frontend shows up instead of reading someone else's data.
 */
const ownsParam = (name = 'clientId') => (req, res, next) => {
  if (req.auth.soft || String(req.params[name]) === String(req.auth.clientId)) return next();
  return res.status(403).json({ error: 'Not allowed.' });
};

/** ownsBody('client_id') — same rule for an id carried in the JSON body. */
const ownsBody = (name = 'client_id') => (req, res, next) => {
  const v = req.body && req.body[name];
  if (req.auth.soft || (v && String(v) === String(req.auth.clientId))) return next();
  return res.status(403).json({ error: 'Not allowed.' });
};

module.exports = {
  issueSession, issueSetupToken, verify,
  requireSession, requireSetupToken, requireSetupOrSession, ownsParam, ownsBody, enforcing,
};
