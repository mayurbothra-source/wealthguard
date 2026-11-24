/**
 * NSE trading-day arithmetic for track-record checkpoints.
 *
 * Dates are IST calendar dates as 'YYYY-MM-DD' strings, so no timezone maths
 * leaks into the window logic.
 *
 * HOLIDAYS lists only weekday NSE closures that several published sources
 * agreed on when this was written. A holiday missing from this list makes a
 * checkpoint window one real trading day narrower, never wider, so the error
 * is on the conservative side. The engine then picks prices from the
 * instrument's own published closes, which never include a holiday.
 */
'use strict';

const HOLIDAYS = new Set([
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-10-02', // Gandhi Jayanti
  '2026-12-25', // Christmas
]);

function parse(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(dt) { return dt.toISOString().slice(0, 10); }

function addCalendarDays(ymd, n) {
  const dt = parse(ymd);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmt(dt);
}

function isTradingDay(ymd) {
  const dow = parse(ymd).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(ymd);
}

/**
 * The k-th trading day before (k < 0) or after (k > 0) ymd, not counting ymd
 * itself. k = 0 returns ymd when it trades, otherwise the previous trading day.
 */
function shiftTradingDays(ymd, k) {
  if (k === 0) {
    let d = ymd;
    while (!isTradingDay(d)) d = addCalendarDays(d, -1);
    return d;
  }
  const step = k > 0 ? 1 : -1;
  let d = ymd, left = Math.abs(k);
  while (left > 0) {
    d = addCalendarDays(d, step);
    if (isTradingDay(d)) left--;
  }
  return d;
}

/** IST calendar date of a timestamp. */
function istDateOf(ts) {
  return new Date(new Date(ts).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Checkpoint window for a signal generated at `generatedAt`:
 *   target = signal date (IST) + `days` calendar days
 *   start  = `tol` trading days before target, end = `tol` trading days after.
 * When the target is a weekend or holiday, the trading day on either side of it
 * is one trading day away.
 */
function checkpointWindow(generatedAt, days, tol) {
  const signalDate = istDateOf(generatedAt);
  const target = addCalendarDays(signalDate, days);
  return {
    signalDate,
    target,
    start: shiftTradingDays(target, -tol),
    end:   shiftTradingDays(target, tol),
  };
}

/**
 * The close a checkpoint is measured at: of the closes inside [start, end],
 * the one nearest the target; on a tie, the earlier one (no look-ahead favoured).
 * `series` is [{ date: 'YYYY-MM-DD', close }] in any order. Null when none.
 */
function pickCheckpointClose(series, win) {
  const tgt = parse(win.target).getTime();
  let best = null;
  for (const p of series || []) {
    if (p.date < win.start || p.date > win.end || !(p.close > 0)) continue;
    const dist = Math.abs(parse(p.date).getTime() - tgt);
    if (!best || dist < best.dist || (dist === best.dist && p.date < best.date)) best = { ...p, dist };
  }
  return best ? { date: best.date, close: best.close } : null;
}

/** Latest close on or before ymd (the price a client could have traded on that day). */
function closeOnOrBefore(series, ymd) {
  let best = null;
  for (const p of series || []) if (p.date <= ymd && p.close > 0 && (!best || p.date > best.date)) best = p;
  return best;
}

module.exports = {
  HOLIDAYS, isTradingDay, shiftTradingDays, addCalendarDays, istDateOf,
  checkpointWindow, pickCheckpointClose, closeOnOrBefore,
};
