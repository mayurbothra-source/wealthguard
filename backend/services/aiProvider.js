/**
 * WealthGuard AI Provider Abstraction
 *
 * Single interface over two AI providers so every engine can call AI
 * without knowing or caring which provider is active:
 *
 *   Primary   : Google Gemini  (free tier — 1,500 req/day)
 *   Secondary : Anthropic Claude (paid — used as fallback or by config)
 *
 * Provider selection order:
 *   1. If AI_PROVIDER env var is set explicitly ('google' | 'anthropic'), use it
 *   2. Otherwise default to 'google' (free)
 *   3. If the chosen provider fails, automatically fall back to the other
 *   4. If both fail, return null — callers must handle this gracefully
 *
 * Model auto-discovery:
 *   Google renames/retires models frequently (we hit this twice already:
 *   gemini-1.5-flash → 2.0 → 2.5 → 3.6). Rather than hardcoding a name that
 *   breaks silently, this module queries the live ListModels endpoint on first
 *   use and picks the best available flash-tier model. Result is cached for the
 *   process lifetime. Zero manual intervention when Google changes model names.
 *
 * Required env vars:
 *   GOOGLE_API_KEY      — Gemini (free tier)
 *   ANTHROPIC_API_KEY   — Claude (optional; enables fallback)
 *   AI_PROVIDER         — optional override: 'google' | 'anthropic'
 */

'use strict';

const axios = require('axios');

// ─────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────

const GOOGLE_KEY    = process.env.GOOGLE_API_KEY    || null;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;
const FORCED        = (process.env.AI_PROVIDER || '').toLowerCase() || null;

// Preference order when auto-discovering a Google model.
// Earlier entries are preferred. Matched as substrings against live model ids.
const GOOGLE_MODEL_PREFERENCE = [
  'flash-lite',   // cheapest/fastest tier if present
  'flash',        // standard flash tier
  'pro',          // fall back to pro only if no flash exists
];

// Models to never auto-select (image/audio/video/embedding/specialised)
const GOOGLE_MODEL_EXCLUDE = [
  'image', 'tts', 'audio', 'transcribe', 'embedding', 'veo', 'lyria',
  'robotics', 'computer-use', 'aqa', 'antigravity', 'deep-research', 'banana',
];

const ANTHROPIC_MODEL  = 'claude-sonnet-4-6';
const ANTHROPIC_URL    = 'https://api.anthropic.com/v1/messages';
const REQUEST_TIMEOUT  = 45000;

// Cached discovered model (per process)
let _googleModel      = null;
let _googleModelTried = false;

// ── RATE LIMITING ────────────────────────────────────────────────────
// Google's free tier allows roughly 15 requests/minute. Firing 100 calls
// back-to-back (as Depth 3 does across 120 instruments) triggers a wall of
// HTTP 429s and loses almost all the analysis.
//
// Two protections:
//   1. Throttle — enforce a minimum gap between consecutive calls
//   2. Circuit breaker — after N consecutive 429s, stop calling for a
//      cooldown period instead of hammering a limit that is already tripped
const MIN_CALL_GAP_MS      = 4500;   // ~13 calls/min, safely under the limit
const BREAKER_THRESHOLD    = 3;      // consecutive 429s before opening
const BREAKER_COOLDOWN_MS  = 60000;  // wait a full minute before retrying

// SA4: retries. A Gemini 503 ("model overloaded") or 429 is usually gone
// seconds later, but every one used to count as a failure. Each call now gets
// up to GOOGLE_ATTEMPTS tries with exponential backoff before it falls back.
const GOOGLE_ATTEMPTS = 3;
let BACKOFF_BASE_MS   = 2000;    // 2 s, 4 s … (429: ×4 — the quota window needs longer)
let MIN_GAP_MS        = MIN_CALL_GAP_MS;
let _anthropicWarned  = false;
const lastErrors = [];           // the last few full errors, for the health log

let _lastCallAt        = 0;
let _consecutive429s   = 0;
let _breakerOpenUntil  = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Enforces the minimum gap between calls. */
async function throttle() {
  const since = Date.now() - _lastCallAt;
  if (since < MIN_GAP_MS) {
    usage.throttleWaits++;
    await sleep(MIN_GAP_MS - since);
  }
  _lastCallAt = Date.now();
}

/** True when the breaker is open and we should not call at all. */
function breakerOpen() {
  return Date.now() < _breakerOpenUntil;
}

function recordRateLimit() {
  _consecutive429s++;
  if (_consecutive429s >= BREAKER_THRESHOLD) {
    _breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.warn(`   ⏸ AI provider: rate limit hit ${_consecutive429s}x — pausing calls for ${BREAKER_COOLDOWN_MS / 1000}s`);
    _consecutive429s = 0;
  }
}

function recordSuccess() {
  _consecutive429s = 0;
}

// Usage counters — surfaced in health logs
const usage = { google: 0, anthropic: 0, failures: 0, fallbacks: 0, rateLimited: 0, throttleWaits: 0, retries: 0, googleFailures: 0 };

// ─────────────────────────────────────────────────────────────────────
// GOOGLE MODEL AUTO-DISCOVERY
// ─────────────────────────────────────────────────────────────────────

/**
 * Queries Google's ListModels endpoint and picks the best available model
 * that supports generateContent. Caches the result.
 *
 * This is what makes the system immune to Google renaming models — which
 * has already broken this integration twice. No hardcoded name to go stale.
 */
async function discoverGoogleModel() {
  if (_googleModel) return _googleModel;
  // A failed discovery is retried after 5 minutes (it used to give up for the
  // life of the process, so one bad minute disabled Gemini until a restart).
  if (_googleModelTried && Date.now() - _googleModelTried < 5 * 60000) return null;
  _googleModelTried = Date.now();

  if (!GOOGLE_KEY) return null;

  try {
    const { data } = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GOOGLE_KEY}`,
      { timeout: 15000 }
    );

    const candidates = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(id => !GOOGLE_MODEL_EXCLUDE.some(bad => id.toLowerCase().includes(bad)));

    if (!candidates.length) {
      console.warn('   ⚠ AI provider: no usable Google models found');
      return null;
    }

    // Pick by preference order, preferring the highest version number within a tier
    for (const pref of GOOGLE_MODEL_PREFERENCE) {
      const matches = candidates.filter(id => id.includes(pref));
      if (matches.length) {
        // Sort descending so the newest version wins (e.g. 3.8 before 3.6)
        matches.sort((a, b) => {
          const va = parseFloat((a.match(/(\d+\.?\d*)/) || [0])[0]) || 0;
          const vb = parseFloat((b.match(/(\d+\.?\d*)/) || [0])[0]) || 0;
          return vb - va;
        });
        _googleModel = matches[0];
        console.log(`   🤖 AI provider: auto-selected Google model "${_googleModel}"`);
        return _googleModel;
      }
    }

    _googleModel = candidates[0];
    console.log(`   🤖 AI provider: using Google model "${_googleModel}"`);
    return _googleModel;

  } catch (e) {
    console.warn(`   ⚠ AI provider: Google model discovery failed — ${describeError(e)}`);
    noteError('google', e);
    return null;
  }
}

/**
 * The full reason a call failed: HTTP status plus the provider's own error
 * message (e.g. "503 UNAVAILABLE: The model is overloaded"). Never includes the
 * request URL or headers, which carry the API key.
 */
function describeError(e) {
  const st = e?.response?.status;
  const body = e?.response?.data;
  const apiMsg = body?.error?.message || body?.error?.status || (typeof body === 'string' ? body : '');
  const base = st ? `HTTP ${st}${body?.error?.status ? ` ${body.error.status}` : ''}` : (e?.code || 'error');
  const msg = String(apiMsg || e?.message || '').replace(/key=[^&\s]+/g, 'key=***').slice(0, 300);
  return `${base}: ${msg}`;
}

function noteError(provider, e) {
  lastErrors.push({ at: new Date().toISOString(), provider, error: describeError(e) });
  if (lastErrors.length > 5) lastErrors.shift();
}

/** Worth another try: rate limits, server errors, timeouts, network drops. */
function isRetryable(e) {
  const st = e?.response?.status;
  if (st === 429 || st === 500 || st === 502 || st === 503 || st === 504) return true;
  if (!st && ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(e?.code)) return true;
  return /Empty response from Google/.test(e?.message || '');
}

/**
 * Gemini with up to GOOGLE_ATTEMPTS tries. Backoff doubles each time; a 429
 * waits four times longer. A non-retryable error (bad key, bad request) stops
 * at once — retrying it cannot help.
 */
async function callGoogleWithRetry(prompt, expectJSON) {
  let lastErr;
  for (let attempt = 1; attempt <= GOOGLE_ATTEMPTS; attempt++) {
    try {
      return await callGoogle(prompt, expectJSON);
    } catch (e) {
      lastErr = e;
      usage.googleFailures++;
      noteError('google', e);
      const is429 = e.response?.status === 429;
      if (is429) { usage.rateLimited++; recordRateLimit(); }
      if (!isRetryable(e) || attempt === GOOGLE_ATTEMPTS || breakerOpen()) break;
      usage.retries++;
      const wait = BACKOFF_BASE_MS * 2 ** (attempt - 1) * (is429 ? 4 : 1);
      console.warn(`   ↻ Gemini attempt ${attempt}/${GOOGLE_ATTEMPTS} failed (${describeError(e)}) — retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  lastErr.attempts = GOOGLE_ATTEMPTS;
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────
// PROVIDER IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────

/**
 * Newer Gemini models split a reply into several parts, and "thinking" models
 * add thought parts before the answer. Join every non-thought text part —
 * reading only parts[0] returned a fragment that could not be parsed as JSON.
 */
function extractGoogleText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(p => typeof p.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('');
}

async function callGoogle(prompt, expectJSON) {
  const model = await discoverGoogleModel();
  if (!model) throw new Error('No Google model available');

  if (breakerOpen()) {
    throw new Error('Rate limit cooldown active — skipping Google call');
  }
  await throttle();

  const fullPrompt = expectJSON
    ? `${prompt}\n\nRespond ONLY with valid JSON. No markdown fences, no commentary before or after the JSON.`
    : prompt;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_KEY}`;
  const body = { contents: [{ parts: [{ text: fullPrompt }] }] };
  // JSON mode: Gemini then returns bare JSON instead of prose / fenced code.
  if (expectJSON) body.generationConfig = { responseMimeType: 'application/json' };
  const opts = { timeout: REQUEST_TIMEOUT, headers: { 'Content-Type': 'application/json' } };

  let data;
  try {
    ({ data } = await axios.post(url, body, opts));
  } catch (e) {
    // A model that rejects JSON mode answers 400 — retry once without it.
    if (expectJSON && e.response?.status === 400) {
      delete body.generationConfig;
      ({ data } = await axios.post(url, body, opts));
    } else {
      throw e;
    }
  }

  const text = extractGoogleText(data);
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'unknown';
    throw new Error(`Empty response from Google (finishReason: ${reason})`);
  }
  usage.google++;
  recordSuccess();
  return text.trim();
}

async function callAnthropic(prompt, expectJSON) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const fullPrompt = expectJSON
    ? `${prompt}\n\nRespond ONLY with valid JSON. No markdown fences, no commentary before or after the JSON.`
    : prompt;

  const { data } = await axios.post(
    ANTHROPIC_URL,
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: fullPrompt }],
    },
    {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
    }
  );

  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  if (!text) throw new Error('Empty response from Anthropic');
  usage.anthropic++;
  return text.trim();
}

// ─────────────────────────────────────────────────────────────────────
// JSON PARSING — tolerant of provider quirks
// ─────────────────────────────────────────────────────────────────────

function parseJSON(text) {
  // Strip markdown fences that models sometimes add despite instructions
  let clean = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    // Last resort: extract the outermost JSON object or array
    const objMatch = clean.match(/[{[][\s\S]*[}\]]/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch {}
    }
    throw new Error('Could not parse JSON from AI response');
  }
}

// ─────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────

/**
 * Ask the AI a question. Handles provider selection, fallback, and parsing.
 *
 * @param {string}  prompt      The prompt text
 * @param {boolean} expectJSON  If true, parses and returns an object
 * @returns {Promise<object|string|null>}  Parsed JSON, raw text, or null on total failure
 */
async function ask(prompt, expectJSON = true) {
  const order = FORCED === 'anthropic'
    ? ['anthropic', 'google']
    : ['google', 'anthropic'];

  let lastError = null, tried = 0;

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];

    // A provider with no key is skipped. Anthropic is the optional fallback:
    // without its key the AI lever simply runs without one (warned once).
    if (provider === 'google' && !GOOGLE_KEY) continue;
    if (provider === 'anthropic' && !ANTHROPIC_KEY) {
      if (tried && !_anthropicWarned) {
        _anthropicWarned = true;
        console.warn('   ⚠ AI provider: Gemini failed and ANTHROPIC_API_KEY is not set — no fallback; continuing without the AI lever for this item');
      }
      continue;
    }
    tried++;

    try {
      const text = provider === 'google'
        ? await callGoogleWithRetry(prompt, expectJSON)
        : await callAnthropic(prompt, expectJSON);

      if (tried > 1) {
        usage.fallbacks++;
        console.log(`   🤖 AI provider: fell back to ${provider} successfully`);
      }
      if (!expectJSON) return text;
      try {
        return parseJSON(text);
      } catch (pe) {
        // Show what came back so the next failure is diagnosable from the logs.
        const excerpt = text.replace(/\s+/g, ' ').slice(0, 200);
        pe.message = `${pe.message} from ${provider} (${text.length} chars): "${excerpt}"`;
        noteError(provider, pe);
        throw pe;
      }

    } catch (e) {
      lastError = e;
      if (provider === 'anthropic') noteError('anthropic', e);
      if (i < order.length - 1) {
        console.warn(`   ⚠ AI provider ${provider} failed${e.attempts ? ` ${e.attempts}×` : ''} (${describeError(e)}) — trying fallback`);
      }
    }
  }

  usage.failures++;
  // Log the first few failures in full, then go quiet — the run summary and
  // the health log carry the last five errors.
  if (usage.failures <= 3) {
    console.warn(`   ⚠ AI provider: all providers failed — ${lastError ? describeError(lastError) : 'no provider configured'}`);
  } else if (usage.failures === 4) {
    console.warn(`   ⚠ AI provider: further failures suppressed (see summary at end of run)`);
  }
  return null; // caller must handle gracefully — never fabricate
}

/**
 * Returns true if at least one provider is configured and usable.
 */
function isConfigured() {
  return !!(GOOGLE_KEY || ANTHROPIC_KEY);
}

/**
 * Current usage counters — included in system_health_log entries.
 */
function getUsage() {
  return { ...usage, activeModel: _googleModel, lastErrors: [...lastErrors] };
}

function resetUsage() {
  usage.google = 0; usage.anthropic = 0; usage.failures = 0;
  usage.fallbacks = 0; usage.rateLimited = 0; usage.throttleWaits = 0;
  usage.retries = 0; usage.googleFailures = 0; lastErrors.length = 0; _anthropicWarned = false;
  _consecutive429s = 0; _breakerOpenUntil = 0;
}

module.exports = {
  ask,
  isConfigured,
  getUsage,
  resetUsage,
  discoverGoogleModel,   // exported for health checks
  _test: {
    extractGoogleText, parseJSON, describeError, isRetryable,
    /** Make backoff and throttling instant in tests. */
    setTiming({ backoffMs, minGapMs }) { if (backoffMs != null) BACKOFF_BASE_MS = backoffMs; if (minGapMs != null) MIN_GAP_MS = minGapMs; },
    resetDiscovery() { _googleModel = null; _googleModelTried = false; },
  },
};
