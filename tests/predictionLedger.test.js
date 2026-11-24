/**
 * Prediction ledger: one row per prediction, per-checkpoint verdicts, row
 * colour (green right / red wrong), honest accuracy summary, token check.
 */
'use strict';
process.env.NODE_ENV = 'test';
const ck = require('./_check');
const L = require('../backend/services/predictionLedger');

const now = new Date('2026-11-24T12:00:00Z');
const rec = (id, action, d, sym = id) => ({ id, instrument_name: sym, action, entry_price_inr: 100, generated_at: `${d}T04:00:00Z` });
const o = (label, ret, extra = {}) => ({ checkpoint_label: label, outcome_status: 'measured', actual_price_inr: 100 + ret, price_as_of: '2026-10-08',
  [{ Weekly: 'return_1w_pct', Monthly: 'return_1m_pct', Quarterly: 'return_3m_pct', Annual: 'return_1y_pct' }[label]]: ret, ...extra });

console.log('\nRows and verdicts');
const recs = [
  rec('b1', 'BUY', '2026-10-01'),  rec('s1', 'SELL', '2026-10-01'), rec('w1', 'WATCH', '2026-10-01'),
  rec('w2', 'WATCH', '2026-10-01'), rec('h1', 'HOLD', '2026-10-01'), rec('z1', 'SELL', '2026-10-01'),
  rec('d1', 'SELL', '2026-10-01'), rec('n1', 'BUY', '2026-11-20'), rec('b1dup', 'BUY', '2026-10-01', 'b1'),
  rec('mix', 'BUY', '2026-09-01'),
];
const outs = {
  b1: [o('Weekly', 2.1), o('Monthly', 4)],
  s1: [o('Weekly', 8.15)],
  w1: [o('Weekly', 1.2)],
  w2: [o('Weekly', -5.4)],
  h1: [o('Weekly', -1.93)],
  z1: [o('Weekly', 0)],
  d1: [o('Weekly', 0, { outcome_status: 'price_suspect' })],
  mix: [o('Weekly', 1.5), o('Monthly', -2)],
};
const L1 = L.buildLedger(recs, outs, now);
const row = id => L1.rows.find(r => r.id === id);

ck('one row per instrument per day (a second run the same day is not a new prediction)', !L1.rows.some(r => r.id === 'b1dup') && L1.rows.length === 9);
ck('newest predictions first', L1.rows[0].id === 'n1');
ck('BUY that rose → ✓ and green', row('b1').weekly.startsWith('✓ +2.10%') && row('b1').overall === 'Right' && row('b1').color === 'green');
ck('the checkpoint cell shows the price and date used, so it can be checked by hand', /₹102\.1 on 8 Oct 2026/.test(row('b1').weekly));
ck('SELL that rose → ✗ and red', row('s1').weekly.startsWith('✗ +8.15%') && row('s1').color === 'red');
ck('WATCH within ±3% → right; beyond → wrong', row('w1').overall === 'Right' && row('w2').overall === 'Wrong');
ck('HOLD within ±2% → right', row('h1').overall === 'Right');
ck('0.00% SELL → inconclusive, uncoloured (never "right")', /inconclusive/.test(row('z1').weekly) && row('z1').color === null);
ck('price feed not updating → no verdict, uncoloured', /price feed not updating/.test(row('d1').weekly) && row('d1').color === null);
ck('not yet due → "due <date>", row Pending', /^due /.test(row('n1').weekly) && row('n1').overall === 'Pending');
ck('past due but not yet scored → "awaiting scoring"', row('s1').monthly === 'awaiting scoring' && /^due \d+ Jan 2027$/.test(row('s1').quarterly), `${row('s1').monthly} | ${row('s1').quarterly}`);
ck('strictest: right at Weekly, wrong at Monthly → red', row('mix').overall === 'Wrong' && row('mix').color === 'red');
ck('Annual column exists and shows its due date', /^due .*2027$/.test(row('b1').annual));

console.log('\nAccuracy summary');
const t = (cp, a) => L1.summary.table.find(x => x.checkpoint === cp && x.prediction === a);
ck('Weekly BUY: 2 right, 0 wrong', t('Weekly', 'BUY').right === 2 && t('Weekly', 'BUY').wrong === 0);
ck('fewer than 10 verdicts → "building (N scored)", no percentage', t('Weekly', 'ALL').accuracy === null && /^building \(\d+ scored\)$/.test(t('Weekly', 'ALL').accuracy_text));
const many = Array.from({ length: 12 }, (_, i) => rec(`m${i}`, 'BUY', `2026-09-${String(i + 1).padStart(2, '0')}`));
const L2 = L.buildLedger(many, Object.fromEntries(many.map((m, i) => [m.id, [o('Weekly', i < 9 ? 1 : -1)]])), now);
ck('10+ verdicts → a real percentage (9 of 12 = 75.0%)', L2.summary.table.find(x => x.checkpoint === 'Weekly' && x.prediction === 'BUY').accuracy_text === '75.0%');
ck('overall counts right / wrong / pending', L1.summary.overall.right === 3 && L1.summary.overall.wrong === 3 && L1.summary.overall.pending >= 1);

console.log('\nEndpoint token');
process.env.LEDGER_TOKEN = 'ledger-secret';
delete require.cache[require.resolve('../backend/routes/ledger')];
const { tokenMatches } = require('../backend/routes/ledger')._test;
ck('right token accepted (whitespace trimmed), wrong refused', tokenMatches(' ledger-secret ') && !tokenMatches('nope') && !tokenMatches(''));
