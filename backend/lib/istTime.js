'use strict';
/**
 * India Standard Time helpers. Every "today", "is it a weekday" and "is it past
 * 07:30" decision goes through here, using the Asia/Kolkata zone explicitly —
 * never the server's local time (Render runs in UTC).
 */
const TZ = 'Asia/Kolkata';

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function istParts(now = new Date()) {
  const p = Object.fromEntries(FMT.formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    dow: DOW[p.weekday],
  };
}

/** 'YYYY-MM-DD' for the IST calendar day. */
const istDate = (now = new Date()) => istParts(now).date;
/** Minutes since IST midnight (07:30 → 450). */
const istMinutes = (now = new Date()) => istParts(now).minutes;
/** Monday–Friday in IST. */
const isIstWeekday = (now = new Date()) => { const d = istParts(now).dow; return d >= 1 && d <= 5; };
/** e.g. "Friday, 13 November" in IST, for email headers. */
const istLongDate = (now = new Date()) => new Date(now).toLocaleDateString('en-IN',
  { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });

module.exports = { TZ, istParts, istDate, istMinutes, isIstWeekday, istLongDate };
