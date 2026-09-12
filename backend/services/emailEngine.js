/**
 * WealthGuard Email Engine (Resend)
 *
 * Handles all outbound email:
 *   - Morning briefs (daily, Mon–Fri)
 *   - Flash alerts (as they fire, if client opted in)
 *   - Category change notifications
 *   - Payment grace-period notices
 *   - Admin anomaly alerts
 *
 * Required env vars:
 *   RESEND_API_KEY     — from resend.com
 *   EMAIL_FROM_ADDRESS — e.g. 'WealthGuard <brief@yourdomain.com>'
 *   ADMIN_EMAIL        — where anomaly alerts go
 *
 * Design notes:
 *   - Every send is logged to email_log for deliverability auditing
 *   - Failures never throw — email is best-effort, it must never crash an engine
 *   - Clients without an email address are silently skipped (logged as 'skipped')
 *   - Plain-text + HTML multipart for maximum deliverability
 */

'use strict';

const axios = require('axios');
const { supabaseAdmin } = require('../../config/supabase');

const RESEND_KEY  = process.env.RESEND_API_KEY || null;
const FROM        = process.env.EMAIL_FROM_ADDRESS || 'WealthGuard <onboarding@resend.dev>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;
const RESEND_URL  = 'https://api.resend.com/emails';

// ─────────────────────────────────────────────────────────────────────
// HTML TEMPLATE — matches the platform's visual identity
// ─────────────────────────────────────────────────────────────────────

function wrapHTML(title, bodyHTML, footerNote) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#F6F7F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F4;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E1E4DD;border-radius:10px;overflow:hidden;">
    <tr><td style="padding:20px 24px;border-bottom:1px solid #E1E4DD;">
      <div style="font-family:Georgia,serif;font-size:17px;font-weight:700;color:#16211B;">
        <span style="color:#1B5E3F;">&#9670;</span> WealthGuard
      </div>
    </td></tr>
    <tr><td style="padding:24px;color:#16211B;font-size:14px;line-height:1.65;">
      ${bodyHTML}
    </td></tr>
    <tr><td style="padding:16px 24px;border-top:1px solid #E1E4DD;background:#F6F7F4;">
      <p style="margin:0 0 8px;font-size:11px;color:#6E7A71;line-height:1.5;">
        ${footerNote || ''}
      </p>
      <p style="margin:0;font-size:10.5px;color:#6E7A71;line-height:1.5;">
        WealthGuard is an independent investment analysis platform. We are not a SEBI-registered
        investment adviser. All signals and analysis are for informational and educational purposes
        only and do not constitute financial advice. Please consult a qualified financial adviser
        before making investment decisions. Past accuracy does not guarantee future performance.
      </p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────
// CORE SEND
// ─────────────────────────────────────────────────────────────────────

async function logEmail(clientId, to, type, subject, status, errorDetail) {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('email_log').insert({
      client_id:    clientId,
      to_address:   to,
      email_type:   type,
      subject,
      status,
      error_detail: errorDetail || null,
      sent_at:      new Date().toISOString(),
    });
  } catch {}
}

/**
 * Sends an email. Never throws — returns true/false.
 */
async function send({ to, subject, html, text, clientId = null, type = 'general' }) {
  if (!RESEND_KEY) {
    console.warn('   ⚠ Email: RESEND_API_KEY not set — skipping send');
    await logEmail(clientId, to, type, subject, 'skipped', 'RESEND_API_KEY not configured');
    return false;
  }
  if (!to) {
    await logEmail(clientId, to, type, subject, 'skipped', 'No recipient address');
    return false;
  }

  try {
    await axios.post(
      RESEND_URL,
      { from: FROM, to: [to], subject, html, text: text || undefined },
      {
        timeout: 20000,
        headers: {
          'Authorization': `Bearer ${RESEND_KEY}`,
          'Content-Type':  'application/json',
        },
      }
    );
    await logEmail(clientId, to, type, subject, 'sent', null);
    return true;
  } catch (e) {
    const detail = e.response
      ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data).slice(0, 200)}`
      : e.message;
    console.warn(`   ⚠ Email send failed to ${to}: ${detail}`);
    await logEmail(clientId, to, type, subject, 'failed', detail);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// SPECIFIC EMAIL TYPES
// ─────────────────────────────────────────────────────────────────────

async function sendMorningBrief(client, brief) {
  if (!client.email || client.email_brief_enabled === false) {
    await logEmail(client.id, client.email, 'morning_brief', 'Morning Brief', 'skipped',
      !client.email ? 'No email on file' : 'Client opted out');
    return false;
  }

  const dateStr = new Date().toLocaleDateString('en-IN',
    { weekday: 'long', day: 'numeric', month: 'long' });

  const sections = [];
  if (brief.market_snapshot) {
    sections.push(`<h3 style="margin:0 0 6px;font-size:13px;color:#1B5E3F;text-transform:uppercase;letter-spacing:.04em;">Market Snapshot</h3>
      <p style="margin:0 0 18px;">${brief.market_snapshot}</p>`);
  }
  if (brief.portfolio_note) {
    sections.push(`<h3 style="margin:0 0 6px;font-size:13px;color:#1B5E3F;text-transform:uppercase;letter-spacing:.04em;">Your Portfolio</h3>
      <p style="margin:0 0 18px;">${brief.portfolio_note}</p>`);
  }
  if (brief.top_signals?.length) {
    const rows = brief.top_signals.map(s => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #E1E4DD;">
          <strong style="color:#16211B;">${s.symbol}</strong>
          <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;
            background:${s.action === 'BUY' ? '#E8F5EE' : s.action === 'SELL' ? '#FBEAE7' : '#F6F7F4'};
            color:${s.action === 'BUY' ? '#2E7D52' : s.action === 'SELL' ? '#A23B2E' : '#6E7A71'};">${s.action}</span>
          <div style="font-size:12px;color:#6E7A71;margin-top:3px;">${s.rationale || ''}</div>
        </td>
      </tr>`).join('');
    sections.push(`<h3 style="margin:0 0 6px;font-size:13px;color:#1B5E3F;text-transform:uppercase;letter-spacing:.04em;">Today's Signals For You</h3>
      <table role="presentation" width="100%" style="margin:0 0 18px;">${rows}</table>`);
  }
  if (brief.goal_note) {
    sections.push(`<h3 style="margin:0 0 6px;font-size:13px;color:#1B5E3F;text-transform:uppercase;letter-spacing:.04em;">Your Goals</h3>
      <p style="margin:0 0 18px;">${brief.goal_note}</p>`);
  }
  if (brief.education_point) {
    sections.push(`<div style="background:#F6F7F4;border-radius:8px;padding:14px 16px;margin:0 0 8px;">
      <h3 style="margin:0 0 6px;font-size:12px;color:#1B5E3F;text-transform:uppercase;letter-spacing:.04em;">Learn Something Today</h3>
      <p style="margin:0;font-size:13px;">${brief.education_point}</p></div>`);
  }

  const html = wrapHTML(
    'Your Morning Brief',
    `<p style="margin:0 0 4px;font-size:12px;color:#6E7A71;">${dateStr}</p>
     <h2 style="margin:0 0 18px;font-family:Georgia,serif;font-size:19px;color:#16211B;">Good morning, ${client.full_name?.split(' ')[0] || 'there'}</h2>
     ${sections.join('')}`,
    'You are receiving this because you have morning briefs enabled. You can turn them off in your profile settings.'
  );

  return send({
    to:       client.email,
    subject:  `WealthGuard Morning Brief — ${dateStr}`,
    html,
    text:     brief.full_text || undefined,
    clientId: client.id,
    type:     'morning_brief',
  });
}

async function sendFlashAlert(client, alert) {
  if (!client.email || client.email_alerts_enabled === false) return false;

  const dir = alert.move_pct > 0 ? 'rising' : 'falling';
  const color = alert.move_pct > 0 ? '#2E7D52' : '#A23B2E';

  const html = wrapHTML(
    'Flash Alert',
    `<h2 style="margin:0 0 4px;font-family:Georgia,serif;font-size:19px;color:#16211B;">
       Flash Alert: ${alert.instrument_name}</h2>
     <p style="margin:0 0 16px;font-size:22px;font-weight:700;color:${color};">
       ${alert.move_pct > 0 ? '+' : ''}${Number(alert.move_pct).toFixed(1)}% this hour</p>
     <p style="margin:0 0 12px;">${alert.instrument_name} is ${dir} sharply.</p>
     <p style="margin:0 0 12px;color:#6E7A71;font-size:13px;">${alert.context_note || ''}</p>
     ${alert.signal_context ? `<div style="background:#F6F7F4;border-radius:8px;padding:12px 14px;margin-top:14px;">
       <p style="margin:0;font-size:13px;">${alert.signal_context}</p></div>` : ''}`,
    'You are receiving this because you hold this instrument and have alerts enabled.'
  );

  return send({
    to:       client.email,
    subject:  `⚡ ${alert.instrument_name} ${alert.move_pct > 0 ? '+' : ''}${Number(alert.move_pct).toFixed(1)}% — WealthGuard Alert`,
    html,
    clientId: client.id,
    type:     'flash_alert',
  });
}

async function sendPaymentGraceNotice(client, stage, daysRemaining) {
  if (!client.email) return false;

  const messages = {
    1: {
      subject: 'Payment issue — your access continues',
      heading: 'We could not process your payment',
      body:    `No action has been taken on your account. Your full access continues normally for the next ${daysRemaining} days while you update your payment method.`,
    },
    2: {
      subject: `Reminder: ${daysRemaining} days to update your payment`,
      heading: 'A quick reminder about your payment',
      body:    `Your payment is still pending. You have ${daysRemaining} days of full access remaining. After that your account moves to read-only — you will keep access to your history and track record, but new signals will pause.`,
    },
    3: {
      subject: 'Your account is now read-only',
      heading: 'Your account has moved to read-only',
      body:    `Your history, goals, and track record remain fully accessible. New signals and briefs are paused until payment is updated. Nothing has been deleted.`,
    },
  };

  const m = messages[stage] || messages[1];

  const html = wrapHTML(
    m.subject,
    `<h2 style="margin:0 0 14px;font-family:Georgia,serif;font-size:19px;color:#16211B;">${m.heading}</h2>
     <p style="margin:0 0 14px;">${m.body}</p>
     <p style="margin:0 0 14px;">You can update your payment method any time from your profile page.</p>
     <p style="margin:0;color:#6E7A71;font-size:13px;">If you believe this is an error, simply reply to this email.</p>`,
    'This is an account notice and cannot be turned off.'
  );

  return send({
    to:       client.email,
    subject:  `WealthGuard — ${m.subject}`,
    html,
    clientId: client.id,
    type:     'payment_grace',
  });
}

async function sendCategoryChangeNotice(client, instrumentName, oldCat, newCat, guidance) {
  if (!client.email || client.email_alerts_enabled === false) return false;

  const html = wrapHTML(
    'Risk Category Change',
    `<h2 style="margin:0 0 14px;font-family:Georgia,serif;font-size:19px;color:#16211B;">
       Risk category updated: ${instrumentName}</h2>
     <p style="margin:0 0 12px;">Our weekly scoring engine has moved <strong>${instrumentName}</strong>
        from <em>${oldCat}</em> to <em>${newCat}</em>.</p>
     <div style="background:#FBF0DA;border-radius:8px;padding:12px 14px;margin:0 0 14px;">
       <p style="margin:0;font-size:13px;color:#9A6B12;">${guidance}</p></div>
     <p style="margin:0;color:#6E7A71;font-size:13px;">
       This is an automated notification based on our 9-lever analysis. It is not a
       recommendation to buy or sell — please review against your own investment horizon.</p>`,
    'You are receiving this because you hold this instrument.'
  );

  return send({
    to:       client.email,
    subject:  `WealthGuard — risk category change on ${instrumentName}`,
    html,
    clientId: client.id,
    type:     'category_change',
  });
}

async function sendAdminAlert(subject, bodyText) {
  if (!ADMIN_EMAIL) {
    console.warn('   ⚠ ADMIN_EMAIL not set — anomaly alert not emailed');
    return false;
  }
  const html = wrapHTML(
    subject,
    `<h2 style="margin:0 0 14px;font-family:Georgia,serif;font-size:18px;color:#A23B2E;">System Alert</h2>
     <pre style="margin:0;font-family:ui-monospace,Menlo,monospace;font-size:12px;
       background:#F6F7F4;padding:14px;border-radius:8px;white-space:pre-wrap;">${bodyText}</pre>`,
    'Internal system alert — sent to platform administrators only.'
  );
  return send({ to: ADMIN_EMAIL, subject, html, text: bodyText, type: 'admin_alert' });
}

function isConfigured() {
  return !!RESEND_KEY;
}

module.exports = {
  send,
  sendMorningBrief,
  sendFlashAlert,
  sendPaymentGraceNotice,
  sendCategoryChangeNotice,
  sendAdminAlert,
  isConfigured,
};
