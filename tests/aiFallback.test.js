/**
 * SA4 — AI lever resilience: Gemini retries with backoff on 503/429, the
 * Anthropic fallback after 3 failed attempts (tested with an invalid Gemini
 * key), and graceful "no AI" when no fallback key is set.
 */
'use strict';
process.env.NODE_ENV = 'test';
const ck = require('./_check');
const axios = require('axios');

let script = [];          // queued Gemini behaviours: 'ok' | 503 | 429 | 400
let discovery = 'ok';     // 'ok' | 'badkey'
const calls = { google: 0, anthropic: 0, get: 0 };
axios.get = async () => {
  calls.get++;
  if (discovery === 'badkey') {
    const e = new Error('Request failed with status code 400');
    e.response = { status: 400, data: { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } } };
    e.config = { url: 'https://generativelanguage.googleapis.com/v1beta/models?key=SECRET123' };
    throw e;
  }
  return { data: { models: [{ name: 'models/gemini-test-flash-lite', supportedGenerationMethods: ['generateContent'] }] } };
};
axios.post = async (url) => {
  if (url.includes('anthropic')) { calls.anthropic++; return { data: { content: [{ type: 'text', text: '{"from":"claude"}' }] } }; }
  calls.google++;
  const step = script.length ? script.shift() : 'ok';
  if (step === 'ok') return { data: { candidates: [{ content: { parts: [{ text: '{"from":"gemini"}' }] } }] } };
  const e = new Error(`Request failed with status code ${step}`);
  e.response = { status: step, data: { error: { status: step === 503 ? 'UNAVAILABLE' : step === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT', message: step === 503 ? 'The model is overloaded. Please try again later.' : 'quota' } } };
  throw e;
};

function load(env) {
  for (const k of ['GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../backend/services/aiProvider')];
  const ai = require('../backend/services/aiProvider');
  ai._test.setTiming({ backoffMs: 1, minGapMs: 0 });
  ai.resetUsage();
  return ai;
}
const reset = () => { calls.google = calls.anthropic = calls.get = 0; script = []; discovery = 'ok'; };

(async () => {
  const warns = []; const ow = console.warn; console.warn = m => warns.push(String(m));
  const ol = console.log; console.log = () => {};

  // 1. transient 503s are retried, not failed
  reset(); let ai = load({ GOOGLE_API_KEY: 'g' });
  script = [503, 503];
  let r = await ai.ask('x');
  let u = ai.getUsage();
  ck('two Gemini 503s then success → answer returned, not a failure', r?.from === 'gemini' && u.failures === 0 && u.retries === 2);
  ck('full Gemini error is logged (status + provider message)', warns.some(w => /HTTP 503 UNAVAILABLE: The model is overloaded/.test(w)));

  // 2. 429 is backed off and retried
  reset(); ai.resetUsage(); script = [429];
  r = await ai.ask('x'); u = ai.getUsage();
  ck('a 429 is retried after backoff rather than logged as a failure', r?.from === 'gemini' && u.rateLimited === 1 && u.failures === 0);

  // 3. three failures, no Anthropic key → null, warn, continue
  reset(); ai.resetUsage(); warns.length = 0; script = [503, 503, 503];
  r = await ai.ask('x'); u = ai.getUsage();
  ck('3 consecutive Gemini failures and no Anthropic key → null (no AI for this item)', r === null && calls.google === 3 && calls.anthropic === 0);
  ck('…with a warning that no fallback is configured', warns.some(w => /ANTHROPIC_API_KEY is not set/.test(w)));
  ck('…and the error kept for the health log', u.lastErrors.length > 0 && /503/.test(u.lastErrors.at(-1).error));
  script = [503, 503, 503]; warns.length = 0;
  await ai.ask('x');
  ck('the no-fallback warning is not repeated every call', !warns.some(w => /ANTHROPIC_API_KEY is not set/.test(w)));

  // 4. three failures with Anthropic key → Claude answers
  reset(); ai = load({ GOOGLE_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' });
  script = [503, 503, 503];
  r = await ai.ask('x'); u = ai.getUsage();
  ck('after 3 Gemini failures the Anthropic fallback answers', r?.from === 'claude' && calls.google === 3 && calls.anthropic === 1 && u.fallbacks === 1);

  // 5. deliberately invalid Gemini key → straight to Anthropic, key never logged
  reset(); discovery = 'badkey'; warns.length = 0;
  ai = load({ GOOGLE_API_KEY: 'SECRET123', ANTHROPIC_API_KEY: 'a' });
  r = await ai.ask('x'); u = ai.getUsage();
  ck('invalid Gemini key → Anthropic fallback used', r?.from === 'claude' && u.anthropic === 1 && u.fallbacks === 1);
  ck('…the reason is logged ("API key not valid")', warns.some(w => /API key not valid/.test(w)));
  ck('…and the key itself never appears in logs or health detail', !warns.some(w => w.includes('SECRET123')) && !JSON.stringify(u).includes('SECRET123'));

  // 6. a non-retryable 400 does not burn retries
  reset(); ai = load({ GOOGLE_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' });
  script = [400, 400];   // JSON-mode retry path consumes one 400, the second is real
  r = await ai.ask('x');
  ck('a non-retryable 400 is not retried 3 times', calls.google <= 2 && r?.from === 'claude');

  // 7. classification
  ck('503/429/timeouts are retryable; 400/401/403 are not',
    ai._test.isRetryable({ response: { status: 503 } }) && ai._test.isRetryable({ response: { status: 429 } }) &&
    ai._test.isRetryable({ code: 'ECONNABORTED' }) && !ai._test.isRetryable({ response: { status: 400 } }) &&
    !ai._test.isRetryable({ response: { status: 403 } }));

  console.warn = ow; console.log = ol;
})();
