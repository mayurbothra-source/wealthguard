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

let _lastCallAt        = 0;
let _consecutive429s   = 0;
let _breakerOpenUntil  = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Enforces the minimum gap between calls. */
async function throttle() {
  const since = Date.now() - _lastCallAt;
  if (since < MIN_CALL_GAP_MS) {
    await sleep(MIN_CALL_GAP_MS - since);
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
const usage = { google: 0, anthropic: 0, failures: 0, fallbacks: 0, rateLimited: 0, throttleWaits: 0 };

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
  if (_googleModelTried && !_googleModel) return null; // already failed once
  _googleModelTried = true;

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
    console.warn(`   ⚠ AI provider: Google model discovery failed — ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// PROVIDER IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────

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

  const { data } = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_KEY}`,
    { contents: [{ parts: [{ text: fullPrompt }] }] },
    { timeout: REQUEST_TIMEOUT, headers: { 'Content-Type': 'application/json' } }
  );

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Google');
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

  let lastError = null;

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];

    // Skip providers with no key configured
    if (provider === 'google'    && !GOOGLE_KEY)    continue;
    if (provider === 'anthropic' && !ANTHROPIC_KEY) continue;

    try {
      const text = provider === 'google'
        ? await callGoogle(prompt, expectJSON)
        : await callAnthropic(prompt, expectJSON);

      if (i > 0) {
        usage.fallbacks++;
        console.log(`   🤖 AI provider: fell back to ${provider} successfully`);
      }
      return expectJSON ? parseJSON(text) : text;

    } catch (e) {
      lastError = e;

      // Track rate limiting specifically so the breaker can open
      const is429 = e.response?.status === 429 || /429/.test(e.message);
      if (is429 && provider === 'google') {
        usage.rateLimited++;
        recordRateLimit();
      }

      const isLast = i === order.length - 1;
      // Only log the fallback attempt once per breaker cycle — otherwise a
      // rate-limited run produces a hundred identical log lines
      if (!isLast && !is429) {
        console.warn(`   ⚠ AI provider ${provider} failed (${e.message}) — trying fallback`);
      }
    }
  }

  usage.failures++;
  // Log the first few failures then go quiet — a rate-limited run should not
  // produce hundreds of identical lines that bury the useful output
  if (usage.failures <= 3) {
    console.warn(`   ⚠ AI provider: all providers failed — ${lastError?.message || 'unknown'}`);
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
  return { ...usage, activeModel: _googleModel };
}

function resetUsage() {
  usage.google = 0; usage.anthropic = 0; usage.failures = 0;
  usage.fallbacks = 0; usage.rateLimited = 0; usage.throttleWaits = 0;
  _consecutive429s = 0; _breakerOpenUntil = 0;
}

module.exports = {
  ask,
  isConfigured,
  getUsage,
  resetUsage,
  discoverGoogleModel,   // exported for health checks
};
