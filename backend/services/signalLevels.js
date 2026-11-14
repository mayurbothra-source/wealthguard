/**
 * Target, stop-loss and reward:risk for a directional signal — or a reason why
 * the signal may not carry any.
 *
 * Replaces the old fixed percentages (a G-Sec got +0.5% target against a −3%
 * stop: reward:risk 0.17). Rules:
 *
 *   1. Trusted price only. price_mode 'static', no price timestamp, or a price
 *      older than 2 IST trading days → no levels, and a BUY becomes WATCH.
 *   2. Equity, ETFs, gold (volatility + recent range):
 *        σh     = annual volatility × √(horizon / 252)
 *        stop   = entry × (1 − 1.5 σh)              — 1.5 typical moves away
 *        target = entry × (1 + 2.5 σh), capped at the 52-week high unless the
 *                 price is already within 1% of it (a breakout has no ceiling)
 *   3. Debt funds and bond ETFs (yield based):
 *        target = entry × (1 + trailing 1-year return × horizon / 365)  — accrual
 *        stop   = entry × (1 − 2 σh)
 *   4. Reward:risk = (target − entry) / (entry − stop) must be ≥ 1.5, else no
 *      levels and a BUY becomes WATCH, with the reason recorded.
 *
 * Pure function; the caller supplies the data.
 */
'use strict';

const { istDate } = require('../lib/istTime');
const { previousTradingDate } = require('./indexData');

const MIN_REWARD_RISK = 1.5;
const MAX_PRICE_AGE_TRADING_DAYS = 2;
const STOP_SIGMAS = 1.5;
const TARGET_SIGMAS = 2.5;
const DEBT_STOP_SIGMAS = 2;
const DEBT_CATEGORIES = ['debt_fund', 'bond_gsec'];

const r2 = n => Math.round(n * 100) / 100;

/** 'live' | 'daily_nav' | 'static' — from the column, or derived before migration 012. */
function priceModeOf(instrument) {
  if (instrument?.price_mode) return instrument.price_mode;
  const src = instrument?.price_source;
  if (src === 'static' || src === 'static_reference') return 'static';
  if (src === 'mfapi') return instrument.amfi_code ? 'daily_nav' : 'static';
  return 'live';
}

/** Is a price dated `asOf` recent enough (within 2 IST trading days of `now`)? */
function priceIsFresh(asOf, now = new Date()) {
  if (!asOf) return false;
  let oldest = istDate(now);
  for (let i = 0; i < MAX_PRICE_AGE_TRADING_DAYS; i++) oldest = previousTradingDate(oldest);
  return istDate(new Date(asOf)) >= oldest;
}

/**
 * @param {object} p
 * @param {'BUY'|'SELL'} p.action
 * @param {number} p.entry
 * @param {number} p.horizonDays
 * @param {object} p.instrument   { category, price_mode | price_source, amfi_code }
 * @param {string|null} p.priceAsOf
 * @param {object|null} p.stats   price_stats: volatility_pct, pct_from_52w_high, return_1y
 * @returns {{ ok: boolean, target?: number, stop?: number, rewardRisk?: number, method?: string, reason?: string }}
 */
function computeLevels({ action, entry, horizonDays, instrument, priceAsOf, stats, now = new Date() }) {
  const mode = priceModeOf(instrument);
  if (mode === 'static') return { ok: false, reason: 'price not live (static reference price)' };
  if (!(entry > 0)) return { ok: false, reason: 'no current price' };
  if (!priceIsFresh(priceAsOf, now)) {
    return { ok: false, reason: priceAsOf ? `price is stale (last ${istDate(new Date(priceAsOf))})` : 'price time unknown' };
  }
  const vol = Number(stats?.volatility_pct);
  if (!(vol > 0)) return { ok: false, reason: 'no price history to size target and stop' };

  const sigmaH = (vol / 100) * Math.sqrt(horizonDays / 252);
  const isDebt = DEBT_CATEGORIES.includes(instrument.category);
  let upMove, downMove, method;

  if (isDebt) {
    const y = Number(stats?.return_1y);
    if (!isFinite(y)) return { ok: false, reason: 'no 1-year return to estimate accrual' };
    upMove = Math.max(0, (y / 100) * horizonDays / 365);
    downMove = DEBT_STOP_SIGMAS * sigmaH;
    method = 'yield';
  } else {
    upMove = TARGET_SIGMAS * sigmaH;
    downMove = STOP_SIGMAS * sigmaH;
    method = 'volatility';
    const fromHigh = Number(stats?.pct_from_52w_high);       // ≤ 0, % below the 52-week high
    if (action === 'BUY' && isFinite(fromHigh) && fromHigh < -1) {
      const room = -fromHigh / 100 / (1 + fromHigh / 100);    // upside to the 52-week high, as a fraction of entry
      if (room < upMove) { upMove = room; method = 'volatility, capped at 52-week high'; }
    }
  }
  if (!(downMove > 0)) return { ok: false, reason: 'volatility too low to set a stop' };

  const rewardRisk = r2(upMove / downMove);
  const target = action === 'SELL' ? r2(entry * (1 - upMove)) : r2(entry * (1 + upMove));
  const stop = action === 'SELL' ? r2(entry * (1 + downMove)) : r2(entry * (1 - downMove));
  if (rewardRisk < MIN_REWARD_RISK) {
    return { ok: false, rewardRisk, method, reason: `reward:risk ${rewardRisk.toFixed(2)} is below ${MIN_REWARD_RISK}` };
  }
  return { ok: true, target, stop, rewardRisk, method };
}

module.exports = { computeLevels, priceModeOf, priceIsFresh, MIN_REWARD_RISK, MAX_PRICE_AGE_TRADING_DAYS };
