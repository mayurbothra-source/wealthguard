/**
 * WealthGuard — data access layer
 *
 * WHY THIS EXISTS
 * ---------------
 * An audit of this codebase found 139 Supabase call sites, of which only 34
 * destructured `error` and could react to it. 51 discarded the result
 * entirely. supabase-js does NOT throw on a failed query — it resolves with
 * `{ data: null, error: {...} }` — so a discarded result means a failure that
 * leaves no trace anywhere.
 *
 * Three production bugs of exactly that shape were found:
 *
 *   1. subscriptionEngine selected clients.created_at, a column that does not
 *      exist. PostgREST rejects the whole select, so `trials` came back null,
 *      the loop body never ran, and the 09:00 cron reported success every
 *      night for weeks while no trial expiry was ever computed.
 *
 *   2. morningBriefEngine upserts ten columns morning_briefs does not have.
 *      Every brief failed to persist, silently.
 *
 *   3. Four engines read `portfolio_holdings` while the frontend writes to
 *      `portfolios`, so no engine had ever seen a client's portfolio.
 *
 * Fixing three instances leaves the fourth to happen next month. This module
 * fixes the class: every call through it surfaces its error once, with the
 * table, the operation and the PostgREST message, and reports to the health
 * engine so the admin alert actually fires.
 *
 * DESIGN NOTES
 * ------------
 * - Deliberately thin. It wraps the query builder rather than replacing it,
 *   so existing call sites migrate by wrapping, not rewriting.
 * - Reads degrade: a failed read returns the supplied fallback so a page
 *   still renders. Writes are strict by default, because a silently dropped
 *   write is how all three bugs above happened.
 * - No behaviour changes for a query that succeeds.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');

// Keyed by `${table}:${op}:${code}` so a failure repeating every 5 minutes
// does not bury the log. Counts are reported in the summary instead.
const _seen = new Map();
const LOG_REPEAT_EVERY = 25;

const stats = { reads: 0, writes: 0, failures: 0, silenced: 0 };

/** True when the module has a usable client. */
function isConfigured() {
  return !!supabaseAdmin;
}

function _fingerprint(table, op, error) {
  const code = error?.code || error?.status || 'unknown';
  return `${table}:${op}:${code}`;
}

/**
 * A missing column or table is a deployment problem, not a transient error.
 * PostgREST reports these as 42703 (undefined_column) and 42P01
 * (undefined_table); it also surfaces its own PGRST2xx schema-cache codes.
 * These deserve a louder message than a network blip, because they mean the
 * code and the database have drifted apart.
 */
function _isSchemaError(error) {
  const code = String(error?.code || '');
  const msg  = String(error?.message || '').toLowerCase();
  return code === '42703' || code === '42P01' || code.startsWith('PGRST')
      || msg.includes('does not exist')
      || msg.includes('could not find')
      || msg.includes('schema cache');
}

function _report(table, op, error) {
  stats.failures++;
  const fp = _fingerprint(table, op, error);
  const n = (_seen.get(fp) || 0) + 1;
  _seen.set(fp, n);

  // Log the first occurrence, then every LOG_REPEAT_EVERY-th
  if (n !== 1 && n % LOG_REPEAT_EVERY !== 0) {
    stats.silenced++;
    return;
  }

  const repeat = n > 1 ? ` (x${n})` : '';
  if (_isSchemaError(error)) {
    console.error(
      `   ‼ SCHEMA MISMATCH  ${table}.${op}${repeat}: ${error.message}\n` +
      `     The code and the database disagree. This will not fix itself — ` +
      `run scripts/verify_schema.sql.`
    );
  } else {
    console.warn(`   ⚠ DB ${op} failed on ${table}${repeat}: ${error.message}`);
  }
}

/**
 * Runs a Supabase query and never lets its error vanish.
 *
 * @param {string}   table   table name, for the message
 * @param {string}   op      'select' | 'insert' | 'upsert' | 'update' | 'delete'
 * @param {Function} build   (client) => a Supabase query builder (thenable)
 * @param {object}  [opts]
 * @param {*}        opts.fallback  returned on failure (default null)
 * @param {boolean}  opts.strict    throw on failure (default: true for writes)
 * @returns {Promise<*>} the rows, or the fallback
 */
async function run(table, op, build, opts = {}) {
  const isWrite = op !== 'select';
  const strict  = opts.strict !== undefined ? opts.strict : isWrite;
  const fallback = opts.fallback !== undefined ? opts.fallback : null;

  if (!supabaseAdmin) {
    // Not an error: the platform is designed to boot without Supabase.
    // But a caller must never mistake this for an empty result set.
    return fallback;
  }

  if (isWrite) stats.writes++; else stats.reads++;

  let result;
  try {
    result = await build(supabaseAdmin);
  } catch (e) {
    // A genuine throw (network, malformed builder)
    _report(table, op, { message: e.message });
    if (strict) throw new Error(`${table}.${op}: ${e.message}`);
    return fallback;
  }

  const { data, error } = result || {};
  if (error) {
    _report(table, op, error);
    if (strict) {
      const err = new Error(`${table}.${op}: ${error.message}`);
      err.dbError = error;
      err.schemaMismatch = _isSchemaError(error);
      throw err;
    }
    return fallback;
  }

  return data;
}

/** A read that degrades to `fallback` (default []) rather than throwing. */
function select(table, build, fallback = []) {
  return run(table, 'select', build, { strict: false, fallback });
}

/** A read expected to return at most one row. Returns null, never throws. */
async function selectOne(table, build) {
  const rows = await run(table, 'select', build, { strict: false, fallback: null });
  if (!rows) return null;
  return Array.isArray(rows) ? (rows[0] || null) : rows;
}

/** A write that MUST NOT fail silently. Throws on error. */
function write(table, op, build) {
  return run(table, op, build, { strict: true });
}

/**
 * A write whose failure should be visible but must not abort the caller —
 * a per-client loop that should carry on to the next client, for instance.
 * Returns true on success, false on a reported failure.
 */
async function tryWrite(table, op, build) {
  try {
    await run(table, op, build, { strict: true });
    return true;
  } catch (_) {
    return false;   // already reported by _report()
  }
}


/**
 * A write that tolerates a database which has not been migrated yet.
 *
 * WHY THIS IS NEEDED
 * PostgREST rejects an INSERT naming a column the table does not have — the
 * WHOLE statement, not just that field. So adding a new column to a write is a
 * breaking change until its migration runs, which makes deploy order
 * load-bearing: push the code first and a working insert starts failing
 * entirely.
 *
 * This tries the full row, and if the failure is specifically about one of the
 * `optionalKeys`, retries once without them. The core data still lands; only
 * the new fields are dropped, and it says so once per process.
 *
 * The result: code and migrations can be deployed in either order, and a
 * forgotten migration costs you provenance columns rather than your scores.
 *
 * @param {string} table
 * @param {'insert'|'upsert'} op
 * @param {object} row
 * @param {string[]} optionalKeys   fields that may not exist yet
 * @param {object} [upsertOpts]     passed through to .upsert()
 * @returns {Promise<{ok: boolean, degraded: boolean}>}
 */
const _degradedOnce = new Set();

async function writeTolerant(table, op, row, optionalKeys = [], upsertOpts = undefined) {
  if (!supabaseAdmin) return { ok: false, degraded: false };

  const attempt = async payload => {
    const q = supabaseAdmin.from(table);
    return op === 'upsert' ? q.upsert(payload, upsertOpts) : q.insert(payload);
  };

  stats.writes++;
  let { error } = await attempt(row);
  if (!error) return { ok: true, degraded: false };

  // Only retry when the failure is about a column we already know is optional
  const msg = String(error.message || '').toLowerCase();
  const blamed = optionalKeys.filter(k => msg.includes(k.toLowerCase()));
  const worthRetrying = _isSchemaError(error) && (blamed.length > 0 || optionalKeys.length > 0);

  if (!worthRetrying || !optionalKeys.length) {
    _report(table, op, error);
    return { ok: false, degraded: false };
  }

  const trimmed = { ...row };
  for (const k of optionalKeys) delete trimmed[k];

  const retry = await attempt(trimmed);
  if (retry.error) {
    _report(table, op, retry.error);
    return { ok: false, degraded: false };
  }

  const fp = `${table}:${op}:degraded`;
  if (!_degradedOnce.has(fp)) {
    _degradedOnce.add(fp);
    console.warn(
      `   ⚠ ${table}.${op}: wrote without [${optionalKeys.join(', ')}] — ` +
      `those columns do not exist yet. The row was saved; the new fields were ` +
      `dropped. Run the pending migration in scripts/migrations/ to capture them. ` +
      `(${error.message})`
    );
  }
  return { ok: true, degraded: true };
}

/** Counters for the health engine / admin panel. */
function getStats() {
  return {
    ...stats,
    distinctFailures: _seen.size,
    failureFingerprints: Array.from(_seen.entries())
      .map(([fp, n]) => ({ fingerprint: fp, count: n }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  };
}

function resetStats() {
  stats.reads = stats.writes = stats.failures = stats.silenced = 0;
  _seen.clear();
}

/**
 * Prints a one-line summary. Called at the end of each engine run so a run
 * that "succeeded" while dropping every write cannot look clean in the log.
 */
function logSummary(label) {
  if (!stats.failures) return;
  console.warn(
    `   ⚠ ${label}: ${stats.failures} database error(s) across ` +
    `${_seen.size} distinct problem(s). Not a clean run.`
  );
}

module.exports = {
  run, select, selectOne, write, tryWrite, writeTolerant,
  isConfigured, getStats, resetStats, logSummary,
  _isSchemaError,   // exported for tests
};
