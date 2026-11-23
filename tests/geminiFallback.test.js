/**
 * Gemini → Gemini fallback (a second model, optionally on a second free
 * Google AI Studio key) before Anthropic.
 */
'use strict';
process.env.NODE_ENV = 'test';
const ck = require('./_check');
const axios = require('axios');

const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.0-flash-lite', 'gemini-3.5-pro'];
const badKeys = new Set();
let failModel = null;              // model id that answers 503
const posts = [];
axios.get = async url => {
  const key = new URL(url).searchParams.get('key');
  if (badKeys.has(key)) { const e = new Error('400'); e.response = { status: 400, data: { error: { message: 'API key not valid.' } } }; throw e; }
  return { data: { models: MODELS.map(m => ({ name: `models/${m}`, supportedGenerationMethods: ['generateContent'] })) } };
};
axios.post = async url => {
  if (url.includes('anthropic')) { posts.push({ anthropic: true }); return { data: { content: [{ type: 'text', text: '{"from":"claude"}' }] } }; }
  const u = new URL(url);
  const model = u.pathname.split('/models/')[1].split(':')[0], key = u.searchParams.get('key');
  posts.push({ model, key });
  if (model === failModel) { const e = new Error('503'); e.response = { status: 503, data: { error: { status: 'UNAVAILABLE', message: 'The model is overloaded.' } } }; throw e; }
  return { data: { candidates: [{ content: { parts: [{ text: `{"model":"${model}","key":"${key}"}` }] } }] } };
};
function load(env) {
  for (const k of ['GOOGLE_API_KEY', 'GOOGLE_API_KEY_FALLBACK', 'ANTHROPIC_API_KEY', 'AI_PROVIDER']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../backend/services/aiProvider')];
  const ai = require('../backend/services/aiProvider');
  ai._test.setTiming({ backoffMs: 1, minGapMs: 0 });
  return ai;
}

(async () => {
  const ow = console.warn, ol = console.log; console.warn = () => {}; console.log = () => {};
  let ai = load({ GOOGLE_API_KEY: 'k1' });
  const rank = ai._test.rankGoogleModels(MODELS);
  const res = [];

  failModel = null; posts.length = 0;
  let r = await ai.ask('x');
  res.push(['primary model is flash-lite (newest), on the primary key', r?.model === 'gemini-3.5-flash-lite' && r.key === 'k1']);
  res.push(['fallback ranking: flash-lite, then flash (plain), then pro', rank[0] === 'gemini-3.5-flash-lite' && rank[1] === 'gemini-3.0-flash-lite' && rank.indexOf('gemini-3.5-flash') < rank.indexOf('gemini-3.5-pro')]);

  // primary model overloaded → a different Gemini model answers, same key
  failModel = 'gemini-3.5-flash-lite'; posts.length = 0;
  r = await ai.ask('x');
  let u = ai.getUsage();
  res.push(['3 × 503 on the primary model → a different Gemini model answers (no Anthropic key needed)',
    r && r.model !== 'gemini-3.5-flash-lite' && r.key === 'k1' && posts.filter(p => p.model === 'gemini-3.5-flash-lite').length === 3 && u.googleFallback === 1]);

  // second free key: fallback uses it
  ai = load({ GOOGLE_API_KEY: 'k1', GOOGLE_API_KEY_FALLBACK: 'k2' });
  posts.length = 0;
  r = await ai.ask('x');
  res.push(['with GOOGLE_API_KEY_FALLBACK set, the fallback step uses the second key', r?.key === 'k2' && r.model !== 'gemini-3.5-flash-lite']);

  // invalid primary key → second key answers
  ai = load({ GOOGLE_API_KEY: 'bad', GOOGLE_API_KEY_FALLBACK: 'k2' });
  badKeys.add('bad'); failModel = null; posts.length = 0;
  r = await ai.ask('x');
  res.push(['invalid primary key → the second free key still answers', r?.key === 'k2' && !posts.some(p => p.anthropic)]);
  badKeys.clear();

  // everything Gemini fails, Anthropic present → Claude
  ai = load({ GOOGLE_API_KEY: 'k1', ANTHROPIC_API_KEY: 'a' });
  failModel = '*'; const origPost = axios.post;
  axios.post = async (url, ...rest) => { if (!url.includes('anthropic')) { const e = new Error('503'); e.response = { status: 503, data: {} }; throw e; } return origPost(url, ...rest); };
  r = await ai.ask('x');
  res.push(['both Gemini steps fail → Anthropic answers', r?.from === 'claude']);
  axios.post = origPost;

  // only the fallback key configured
  ai = load({ GOOGLE_API_KEY_FALLBACK: 'k2' }); failModel = null;
  r = await ai.ask('x');
  res.push(['only GOOGLE_API_KEY_FALLBACK set → still configured and answering', ai.isConfigured() && r?.key === 'k2']);

  console.warn = ow; console.log = ol;
  for (const [n, ok] of res) ck(n, ok);
})();
