'use strict';
/**
 * The launch free-period rule, in ONE place (frozen 3 Nov 2026):
 *   - Joined before 30 Dec 2026  -> full access until 31 Dec 2026 (end of day IST)
 *   - Joined on/after 30 Dec     -> full access for 30 days from joining
 *   - Paid checkout opens 1 Jan 2027 (override with env PAID_PLANS_OPEN_FROM, ISO date,
 *     e.g. set it to a past date temporarily to test Razorpay in test mode)
 */
const FREE_UNTIL      = new Date('2026-12-31T18:29:59Z');   // 31 Dec 2026 23:59:59 IST
const SHORT_FREE_FROM = new Date('2026-12-30T00:00:00+05:30');
const SHORT_FREE_DAYS = 30;
const TRIAL_PLAN      = 'builder';

function freeExpiryFor(joinedAt = new Date()) {
  const j = new Date(joinedAt);
  return j < SHORT_FREE_FROM ? FREE_UNTIL : new Date(j.getTime() + SHORT_FREE_DAYS * 86400e3);
}
function paidPlansOpenFrom() {
  const e = process.env.PAID_PLANS_OPEN_FROM;
  const d = e ? new Date(e) : null;
  return d && !isNaN(d) ? d : new Date('2027-01-01T00:00:00+05:30');
}
function paidPlansOpen(now = new Date()) { return now >= paidPlansOpenFrom(); }

module.exports = { FREE_UNTIL, TRIAL_PLAN, freeExpiryFor, paidPlansOpenFrom, paidPlansOpen };
