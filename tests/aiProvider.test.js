/**
 * aiProvider — Gemini replies that come back in several parts (or with
 * "thinking" parts first) must still parse as JSON.
 */
'use strict';
process.env.GOOGLE_API_KEY = 'test-key';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_PROVIDER;

const axios = require('axios');
let nextReply = null;
let lastBody = null;
let reject400Once = false;
axios.get = async () => ({ data: { models: [{ name: 'models/gemini-test-flash', supportedGenerationMethods: ['generateContent'] }] } });
axios.post = async (url, body) => {
  lastBody = JSON.parse(JSON.stringify(body));
  if (reject400Once && body.generationConfig) {
    reject400Once = false;
    const e = new Error('Request failed with status code 400'); e.response = { status: 400 }; throw e;
  }
  return { data: nextReply };
};

const ai = require('../backend/services/aiProvider');
let pass = 0, fail = 0;
const ck = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const reply = parts => ({ candidates: [{ content: { parts }, finishReason: 'STOP' }] });

(async () => {
  console.log('── Gemini reply parsing ──');
  const origWarn = console.warn; const warns = []; console.warn = m => warns.push(String(m));

  nextReply = reply([{ text: '{"snapshot": "Markets ' }, { text: 'were calm."}' }]);
  let r = await ai.ask('x', true);
  ck('JSON split across two parts is joined and parsed', r && r.snapshot === 'Markets were calm.');
  ck('JSON mode is requested from Gemini', lastBody.generationConfig?.responseMimeType === 'application/json');

  nextReply = reply([{ text: 'Let me think about the facts…', thought: true }, { text: '{"snapshot": "Flat day."}' }]);
  r = await ai.ask('x', true);
  ck('thinking parts are ignored', r && r.snapshot === 'Flat day.');

  nextReply = reply([{ text: '```json\n{"snapshot": "Fenced."}\n```' }]);
  r = await ai.ask('x', true);
  ck('markdown fences are still stripped', r && r.snapshot === 'Fenced.');

  reject400Once = true;
  nextReply = reply([{ text: '{"snapshot": "No JSON mode."}' }]);
  r = await ai.ask('x', true);
  ck('a model that rejects JSON mode is retried without it', r && r.snapshot === 'No JSON mode.' && !lastBody.generationConfig);

  nextReply = reply([{ text: 'Sorry, I cannot help with that.' }]);
  r = await ai.ask('x', true);
  ck('unparseable reply returns null (never fabricates)', r === null);
  ck('the failure log shows what came back', warns.some(w => /Sorry, I cannot help/.test(w)));

  nextReply = reply([{ text: 'plain text answer' }]);
  r = await ai.ask('x', false);
  ck('text mode returns the text and does not request JSON mode', r === 'plain text answer' && !lastBody.generationConfig);

  console.warn = origWarn;
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
