/**
 * Holdings: status for the brief, and alerts when something needs the client.
 *
 * Status per holding (shared by the morning brief and the alerts):
 *   EXIT   — price is at or below the stop-loss
 *   REVIEW — our signal is SELL, a CRITICAL AI flag is active, or the price is
 *            within 3% of the stop-loss
 *   HOLD   — none of the above
 * The stop-loss is the client's own (portfolios.stop_loss_price) if set, else
 * the stop of our current BUY signal.
 *
 * Alert events (each emailed at most once per client — alert_deliveries has a
 * unique (client_id, event_key)):
 *   stop:<holding id>:<stop>   price at/below the stop-loss
 *   ai:<flag id>               CRITICAL AI flag on an instrument they hold
 *   flash:<flash alert id>     sharp hourly move (flashAlertEngine)
 *
 * Demo-seeded holdings (entry_source 'demo_seed') alert the ADMIN address, not
 * the demo account, unless DEMO_ALERTS_TO_CLIENTS=true.
 */
'use strict';

const { supabaseAdmin } = require('../../config/supabase');

const NEAR_STOP_PCT = 3;

function holdingStatus({ price, stop, signalAction, aiCritical }) {
  const reasons = [];
  if (price > 0 && stop > 0 && price <= stop) {
    reasons.push(`price ₹${price} is at or below the stop-loss ₹${stop}`);
    return { status: 'EXIT', reasons };
  }
  if (signalAction === 'SELL') reasons.push('our signal on it has turned negative (SELL)');
  if (aiCritical) reasons.push('our AI scan has flagged a critical risk for it');
  if (price > 0 && stop > 0 && (price - stop) / price * 100 <= NEAR_STOP_PCT) {
    reasons.push(`price is within ${NEAR_STOP_PCT}% of the stop-loss ₹${stop}`);
  }
  return { status: reasons.length ? 'REVIEW' : 'HOLD', reasons };
}

const isMissingTable = e => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|Could not find the table/i.test(e.message || ''));

/**
 * Sends one alert, once. Returns { sent, deduped, recipient, error }.
 * @param {object} client  clients row
 * @param {object} ev      { key, type, title, body, demo }
 * @param {object} [opts]  { forceAdmin }
 */
async function deliverAlert(client, ev, opts = {}) {
  const email = require('./emailEngine');
  const toAdmin = opts.forceAdmin || (ev.demo && String(process.env.DEMO_ALERTS_TO_CLIENTS).toLowerCase() !== 'true');
  const recipient = toAdmin ? 'admin' : 'client';

  // Claim the event first: a duplicate key means this client already had it.
  const { data: row, error } = await supabaseAdmin.from('alert_deliveries')
    .insert({ client_id: client.id, event_key: ev.key, event_type: ev.type, recipient, status: 'sending' })
    .select('id').maybeSingle();
  if (error) {
    if (error.code === '23505') return { sent: false, deduped: true, recipient };
    if (isMissingTable(error)) {
      console.warn('   ⚠ alert_deliveries missing (run migration 013) — alert not emailed, to avoid repeats');
      return { sent: false, deduped: false, recipient, error: 'alert_deliveries table missing' };
    }
    return { sent: false, deduped: false, recipient, error: error.message };
  }

  // In-app notification for the client (never for admin-only test sends).
  if (!opts.forceAdmin) {
    await supabaseAdmin.from('client_notifications').insert({
      client_id: client.id, type: ev.type, title: ev.title, body: ev.body,
      instrument_id: ev.instrumentId || null, is_read: false, created_at: new Date().toISOString(),
    });
  }

  let res;
  if (toAdmin) {
    const ok = await email.sendAdminAlert(`[${opts.forceAdmin ? 'TEST' : 'DEMO'} alert for ${client.full_name || client.id}] ${ev.title}`, ev.body);
    res = { ok, error: ok ? null : 'admin email not sent (ADMIN_EMAIL / RESEND_API_KEY?)' };
  } else if (!client.email || client.email_alerts_enabled === false) {
    res = { ok: false, error: !client.email ? 'no email on file' : 'client opted out of alerts' };
  } else {
    res = await email.sendHoldingAlert(client, ev);
  }
  await supabaseAdmin.from('alert_deliveries').update({
    status: res.ok ? 'sent' : 'failed', provider_message_id: res.id || null,
    error: res.ok ? null : String(res.error || 'unknown').slice(0, 500), sent_at: res.ok ? new Date().toISOString() : null,
  }).eq('id', row.id);
  return { sent: !!res.ok, deduped: false, recipient, error: res.ok ? null : res.error };
}

/**
 * Checks every active holding (or one client's) for stop-loss breaches and
 * CRITICAL AI flags, and alerts each client once per event.
 * @param {object} [opts]
 * @param {string} [opts.clientId]       only this client
 * @param {object} [opts.priceOverride]  { SYMBOL: price } — admin tests only
 * @param {boolean} [opts.forceAdmin]    send every alert to the admin address
 * @param {function} [opts.priceFor]     async (instrumentRow) => { price } (defaults to the scoring engine's router)
 */
async function runHoldingAlertScan(opts = {}) {
  if (!supabaseAdmin) return { events: [], deliveries: [] };
  let q = supabaseAdmin.from('portfolios').select('*').eq('is_active', true);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  const { data: holdings } = await q;
  if (!holdings?.length) return { events: [], deliveries: [] };

  const symbols = [...new Set(holdings.map(h => h.instrument_name))];
  const { data: insts } = await supabaseAdmin.from('instrument_universe').select('*').in('symbol', symbols);
  const inst = Object.fromEntries((insts || []).map(i => [i.symbol, i]));
  const { data: sigs } = await supabaseAdmin.from('recommendations')
    .select('instrument_name, action, stop_loss_inr, generated_at').in('instrument_name', symbols)
    .is('client_id', null).eq('is_active', true).order('generated_at', { ascending: false });
  const sig = {};
  for (const s of sigs || []) if (!sig[s.instrument_name]) sig[s.instrument_name] = s;
  const ids = (insts || []).map(i => i.id);
  const { data: flags } = ids.length ? await supabaseAdmin.from('ai_instrument_flags')
    .select('id, instrument_id, risk_level, is_active').eq('is_active', true).eq('risk_level', 'CRITICAL').in('instrument_id', ids) : { data: [] };
  const critical = {};
  for (const f of flags || []) critical[f.instrument_id] = f;

  const priceFor = opts.priceFor || (async i => require('./instrumentEngine').fetchInstrumentPrice(i));
  const prices = {};
  for (const sym of symbols) {
    if (opts.priceOverride && opts.priceOverride[sym] != null) { prices[sym] = Number(opts.priceOverride[sym]); continue; }
    try { const p = inst[sym] ? await priceFor(inst[sym]) : null; prices[sym] = p?.price ?? null; } catch { prices[sym] = null; }
  }

  const clientIds = [...new Set(holdings.map(h => h.client_id))];
  const { data: clients } = await supabaseAdmin.from('clients').select('*').in('id', clientIds);
  const clientOf = Object.fromEntries((clients || []).map(c => [c.id, c]));

  const events = [], deliveries = [];
  for (const h of holdings) {
    const i = inst[h.instrument_name] || {};
    const s = sig[h.instrument_name];
    const stop = Number(h.stop_loss_price) || (s?.action === 'BUY' ? Number(s.stop_loss_inr) : null) || null;
    const price = prices[h.instrument_name];
    const flag = critical[i.id];
    const st = holdingStatus({ price, stop, signalAction: s?.action, aiCritical: !!flag });
    const name = i.name || h.instrument_name;
    const demo = h.entry_source === 'demo_seed';
    const evs = [];
    if (st.status === 'EXIT') {
      evs.push({ key: `stop:${h.id}:${stop}`, type: 'stop_loss', instrumentId: i.id, demo,
        title: `Stop-loss reached: ${name}`,
        body: `${name} is at ₹${price}, at or below your stop-loss of ₹${stop} (you bought at ₹${h.avg_buy_price_inr}). ` +
              'This is the level you set to limit losses. Review the holding today. Not investment advice.' });
    }
    if (flag) {
      evs.push({ key: `ai:${flag.id}`, type: 'ai_critical', instrumentId: i.id, demo,
        title: `Critical risk flagged: ${name}`,
        body: `Our AI scan has flagged a critical risk that may affect ${name}, which you hold. ` +
              'Open WealthGuard to see what this means for your holding. Not investment advice.' });
    }
    for (const ev of evs) {
      events.push({ client_id: h.client_id, symbol: h.instrument_name, ...ev });
      const c = clientOf[h.client_id];
      if (c) deliveries.push({ client_id: h.client_id, key: ev.key, ...(await deliverAlert(c, ev, { forceAdmin: opts.forceAdmin })) });
    }
  }
  const sent = deliveries.filter(d => d.sent).length;
  if (events.length) console.log(`   🔔 Holding alerts: ${events.length} event(s), ${sent} sent, ${deliveries.filter(d => d.deduped).length} already sent`);
  return { events, deliveries };
}

module.exports = { holdingStatus, deliverAlert, runHoldingAlertScan, NEAR_STOP_PCT };
