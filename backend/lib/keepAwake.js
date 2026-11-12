/**
 * Keeps a free-plan Render server awake while background work is running.
 *
 * Render's free plan stops the server after ~15 minutes without an inbound
 * request, even if a job is still running. The wake-up ping starts a job but
 * is one request, so scoring and the AI scans were cut off part-way through
 * on every run. While any job is active, this requests the server's own public
 * URL every few minutes, which Render counts as traffic. Once the last job
 * finishes the pings stop and the server can sleep normally.
 *
 * No-op when there is no public URL (local runs, tests).
 */

'use strict';

const axios = require('axios');

const PING_EVERY_MS = 8 * 60 * 1000;      // well inside the 15-minute idle limit
const MAX_AWAKE_MS  = 3 * 60 * 60 * 1000; // safety stop if a job hangs forever

const active = new Map();   // label -> started at
let timer = null;
let awakeSince = 0;

function publicUrl() {
  const u = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BACKEND_URL || '';
  return u.replace(/\/+$/, '');
}

async function ping() {
  if (Date.now() - awakeSince > MAX_AWAKE_MS) {
    console.warn(`   ⚠ keep-awake: still busy after ${MAX_AWAKE_MS / 3600000}h (${[...active.keys()].join(', ')}) — stopping pings`);
    stopTimer();
    return;
  }
  try {
    await axios.get(`${publicUrl()}/healthz`, { timeout: 20000 });
  } catch (e) {
    console.warn(`   ⚠ keep-awake ping failed: ${e.message}`);
  }
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function begin(label) {
  active.set(label, Date.now());
  if (!timer && publicUrl()) {
    awakeSince = Date.now();
    timer = setInterval(ping, PING_EVERY_MS);
    if (timer.unref) timer.unref();
  }
}

function end(label) {
  active.delete(label);
  if (!active.size) stopTimer();
}

/** Runs fn while keeping the server awake. Nested calls are fine. */
async function during(label, fn) {
  const key = `${label}#${Math.random().toString(36).slice(2, 8)}`;
  begin(key);
  try { return await fn(); } finally { end(key); }
}

function status() {
  return { active: [...active.keys()], pinging: !!timer };
}

module.exports = { during, begin, end, status, _ping: ping };
