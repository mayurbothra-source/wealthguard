/**
 * Tiny in-memory rate limiter (no dependency).
 *
 * Render runs one instance of this service, so a per-process map is
 * sufficient. If the service is ever scaled to several instances, swap this
 * for a shared store — the call sites will not change.
 *
 *   router.post('/login', limit({ windowMs: 10*60e3, max: 20 }), handler)
 */
'use strict';

function limit({ windowMs = 60_000, max = 60, key = req => req.ip, message } = {}) {
  const hits = new Map();   // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 60_000));
  if (sweep.unref) sweep.unref();

  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test' && !process.env.RATE_LIMIT_IN_TEST) return next();
    const k = String(key(req) || 'anon');
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + windowMs }; hits.set(k, h); }
    h.count++;
    if (h.count > max) {
      const retry = Math.ceil((h.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: message || 'Too many attempts. Please wait a few minutes and try again.', retry_after_s: retry });
    }
    next();
  };
}

module.exports = { limit };
