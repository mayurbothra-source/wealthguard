/**
 * The price-history fetcher must survive Yahoo's rate limiting (HTTP 429): the 2 Nov
 * scoring run lost 74 of 120 instruments to it, which made most scores identical.
 * No network: axios is mocked.
 */
process.env.NODE_ENV = 'test';
const ck = require('./_check');
const Module = require('module'), orig = Module._load;

let script = [];            // each call shifts one outcome: 'ok' | status code | 'timeout'
const hosts = [];
const okBody = { data: { chart: { result: [{ indicators: { quote: [{ close: [100, 101, null, 103] }] } }] } } };
Module._load = function (r, p, i) {
  if (r === 'axios') return { get: async (url) => {
    hosts.push(url.split('/')[2]);
    const o = script.shift();
    if (o === 'ok') return okBody;
    if (o === 'timeout') throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    throw Object.assign(new Error('http'), { response: { status: o } });
  } };
  if (r.includes('config/supabase')) return { supabaseAdmin: null, supabase: null };
  return orig(r, p, i);
};
const fp = require('../backend/services/fundamentalsProvider');

(async () => {
  console.log('\n── price history survives rate limiting ──');
  script = ['ok'];
  let r = await fp.fetchPriceHistory('RELIANCE.NS');
  ck('a normal fetch returns the closes (blanks removed)', r.closes && r.closes.length === 3);

  script = [429, 429, 'ok']; hosts.length = 0;
  r = await fp.fetchPriceHistory('TCS.NS');
  ck('two 429s then success → still gets the data', !!r.closes && r.closes.length === 3);
  ck('…and the retry used the second Yahoo host', hosts.includes('query1.finance.yahoo.com') && hosts.includes('query2.finance.yahoo.com'));

  script = ['timeout', 'ok'];
  r = await fp.fetchPriceHistory('INFY.NS');
  ck('a timeout is retried too', !!r.closes);

  script = [404]; hosts.length = 0;
  r = await fp.fetchPriceHistory('GONE.NS');
  ck('a 404 (delisted) is NOT retried', r.closes === null && hosts.length === 1 && /404/.test(r.reason));

  script = [429, 429, 429, 429];
  r = await fp.fetchPriceHistory('BUSY.NS');
  ck('if every retry is refused it gives up with a clear reason', r.closes === null && /429/.test(r.reason));

  console.log('\n── failed fetches are not served from cache ──');
  ck('a 429 failure is treated as a failed fetch', fp.isFailedFetch({ price_stats: null, price_reason: 'chart fetch failed (HTTP 429)' }));
  ck('a timeout is a failed fetch', fp.isFailedFetch({ price_stats: null, price_reason: 'chart fetch failed (timed out)' }));
  ck('"statically priced" is a fact, not a failure', !fp.isFailedFetch({ price_stats: null, price_reason: 'statically priced — no market history exists' }));
  ck('a row that HAS price stats is never a failure', !fp.isFailedFetch({ price_stats: { data_points: 250 }, price_reason: 'chart fetch failed (HTTP 429)' }));
})();

// ── track record: a checkpoint can only be measured once its day has arrived ──
(async () => {
  const { checkpointDue } = require('../backend/services/trackRecordEngine');
  console.log('\n── checkpoint timing ──');
  ck('weekly check does NOT fire on day 0 (this stored fake 0.0% results)', !checkpointDue(0, 7));
  ck('weekly check does not fire on day 3', !checkpointDue(3, 7));
  ck('weekly fires from day 7', checkpointDue(7, 7) && checkpointDue(7.2, 7));
  ck('weekly still catches up a few days late (sleeping server)', checkpointDue(12, 7));
  ck('weekly stops after the catch-up window', !checkpointDue(25, 7));
  ck('monthly not due on day 20, due on day 31', !checkpointDue(20, 30) && checkpointDue(31, 30));
  ck('quarterly due around day 90', !checkpointDue(75, 90) && checkpointDue(91, 90));
})();
