/**
 * Notification Service — tenant-scoped.
 *
 * Every exported function takes `businessId` as its first argument so that
 * customer SMS copy, From addresses, and notification recipients all come
 * from the tenant that actually owns the booking. Falls back to sensible
 * defaults (Valleymede) when a business row is missing a field, but never
 * mixes settings or recipients across tenants.
 */
const nodemailer = require('nodemailer');
const {
  getSetting,
  getBusinessById,
  getPrimaryBusinessPhoneNumber,
  query: dbQuery
} = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');
require('dotenv').config();

// Create email transporter (shared across tenants — SMTP is a platform resource)
let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }
  return transporter;
}

/**
 * Resolve a business row, tolerating lookup failures. Returns null if the
 * tenant can't be loaded — callers are expected to fall back to safe defaults.
 */
async function safeGetBusiness(businessId) {
  try {
    return await getBusinessById(businessId);
  } catch (err) {
    console.warn(`[tenant:${businessId}] Could not load business row:`, err.message);
    return null;
  }
}

/**
 * Send an email. The From name is personalized with the tenant's business
 * name so each tenant's staff see an identifiable sender.
 */
async function sendEmail(businessId, to, subject, htmlBody) {
  requireBusinessId(businessId, 'sendEmail');
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn(`[tenant:${businessId}] Email not configured. Skipping notification.`);
    return null;
  }
  const business = await safeGetBusiness(businessId);
  const fromName = business?.name ? `${business.name} AI` : 'Golf AI';
  try {
    const info = await getTransporter().sendMail({
      from: `"${fromName}" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html: htmlBody
    });
    console.log(`[tenant:${businessId}] Email sent:`, info.messageId);
    return info;
  } catch (err) {
    console.error(`[tenant:${businessId}] Email send failed:`, err.message);
    throw err;
  }
}

// Normalize phone to E.164 format for Twilio (tenant-agnostic)
function normalizeToE164(phone) {
  if (!phone) return null;
  let num = String(phone).replace(/[^+\d]/g, '');
  if (!num) return null;
  if (!num.startsWith('+')) {
    if (num.length === 10) num = '+1' + num;
    else if (num.length === 11 && num.startsWith('1')) num = '+' + num;
  }
  return num;
}

/**
 * Resolve the outbound "From" number for a tenant.
 *
 * Resolution order (Phase 5):
 *   1. Active primary row in `business_phone_numbers` — authoritative.
 *   2. Legacy denormalized `businesses.twilio_phone_number` column —
 *      kept as a safety net for tenants that haven't run migration 003
 *      or that briefly have no primary row.
 *   3. Platform-wide `TWILIO_PHONE_NUMBER` env var — last-resort fallback
 *      so Valleymede keeps working even if ops hasn't wired the DID yet.
 */
async function resolveFromNumber(businessId) {
  try {
    const primary = await getPrimaryBusinessPhoneNumber(businessId);
    if (primary?.phone_number) return primary.phone_number;
  } catch (err) {
    console.warn(`[tenant:${businessId}] Primary phone lookup failed:`, err.message);
  }
  const business = await safeGetBusiness(businessId);
  return business?.twilio_phone_number || process.env.TWILIO_PHONE_NUMBER || null;
}

/**
 * Send SMS via Twilio. From number comes from `business_phone_numbers`
 * (primary + active) and falls back to the legacy denorm column and then
 * the platform env var so Valleymede bootstraps keep working.
 */
async function sendSMS(businessId, to, message) {
  requireBusinessId(businessId, 'sendSMS');
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn(`[tenant:${businessId}] Twilio not configured. Skipping SMS.`);
    return null;
  }
  const normalized = normalizeToE164(to);
  if (!normalized) {
    console.warn(`[tenant:${businessId}] SMS skipped — invalid phone number: ${to}`);
    return null;
  }

  const fromNumber = await resolveFromNumber(businessId);
  if (!fromNumber) {
    console.warn(`[tenant:${businessId}] SMS skipped — no From number configured.`);
    return null;
  }

  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const msg = await twilio.messages.create({
      body: message,
      from: fromNumber,
      to: normalized
    });
    console.log(`[tenant:${businessId}] SMS sent to ${normalized}:`, msg.sid);
    return msg;
  } catch (err) {
    console.error(`[tenant:${businessId}] SMS send failed to ${normalized}:`, err.message);
    throw err;
  }
}

/**
 * Load the notifications settings blob for a tenant. Returns null if none.
 */
async function getTenantNotifications(businessId) {
  try {
    return await getSetting(businessId, 'notifications');
  } catch (err) {
    console.warn(`[tenant:${businessId}] Could not load notifications setting:`, err.message);
    return null;
  }
}

/**
 * Pull the customer-facing display name and transfer number for SMS copy.
 * Falls back to env defaults so early Valleymede bootstrap still works.
 */
async function getTenantDisplay(businessId) {
  const business = await safeGetBusiness(businessId);
  const name = business?.name || 'Golf Course';
  const transferNumber =
    business?.transfer_number ||
    (await getSetting(businessId, 'transfer_number').catch(() => null)) ||
    '';
  const timezone = business?.timezone || 'America/Toronto';
  return { name, transferNumber, timezone };
}

// Notify staff of a new booking request — scoped to the booking's tenant
async function sendBookingNotification(businessId, booking) {
  requireBusinessId(businessId, 'sendBookingNotification');
  const settings = await getTenantNotifications(businessId);
  if (!settings) return;

  const smsEnabled = settings.sms_enabled ?? true;
  const emailEnabled = settings.email_enabled ?? true;
  const { name: businessName } = await getTenantDisplay(businessId);

  const dateStr = new Date(booking.requested_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  // Holes — explicit row + value when known. "Unknown" when null so staff
  // see the gap and can ask the caller before approving (rather than
  // assuming 18, which is what bit us with the original incident).
  const holesRowValue = (booking.holes === 18 || booking.holes === '18')
    ? '18 holes'
    : (booking.holes === 9 || booking.holes === '9')
      ? '9 holes (back nine)'
      : 'Unknown — confirm with caller';
  const holesSmsValue = (booking.holes === 18 || booking.holes === '18')
    ? '18 holes'
    : (booking.holes === 9 || booking.holes === '9')
      ? '9 holes'
      : 'holes UNKNOWN';

  if (emailEnabled && settings.email_to) {
    const html = `
      <h2>🏌️ New Tee Time Request — ${businessName}</h2>
      <table style="border-collapse:collapse; font-family:sans-serif;">
        <tr><td style="padding:4px 12px; font-weight:bold;">Customer:</td><td style="padding:4px 12px;">${booking.customer_name || 'Unknown'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Phone:</td><td style="padding:4px 12px;">${booking.customer_phone || 'N/A'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Email:</td><td style="padding:4px 12px;">${booking.customer_email || 'N/A'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Date:</td><td style="padding:4px 12px;">${dateStr}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Time:</td><td style="padding:4px 12px;">${booking.requested_time || 'Flexible'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Players:</td><td style="padding:4px 12px;">${booking.party_size}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Holes:</td><td style="padding:4px 12px;">${holesRowValue}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Carts:</td><td style="padding:4px 12px;">${booking.num_carts || 0}</td></tr>
        ${booking.card_last_four ? `<tr><td style="padding:4px 12px; font-weight:bold;">Card:</td><td style="padding:4px 12px;">****${booking.card_last_four}</td></tr>` : ''}
        ${booking.special_requests ? `<tr><td style="padding:4px 12px; font-weight:bold;">Notes:</td><td style="padding:4px 12px;">${booking.special_requests}</td></tr>` : ''}
      </table>
      <p style="margin-top:16px; color:#666;">Log in to the Command Center to confirm or modify this booking.</p>
    `;
    await sendEmail(
      businessId,
      settings.email_to,
      `[${businessName}] New Tee Time Request - ${booking.customer_name || 'Unknown'} - ${dateStr}`,
      html
    );
  }

  if (smsEnabled && settings.sms_to) {
    const ccNote = booking.card_last_four ? ` Card: ****${booking.card_last_four}.` : '';
    const sms = `[${businessName}] New tee time request: ${booking.customer_name || 'Unknown'}, ${dateStr} ${booking.requested_time || ''}, ${booking.party_size} players, ${holesSmsValue}.${ccNote} Check Command Center to confirm.`;
    await sendSMS(businessId, settings.sms_to, sms);
  }
}

// Notify staff of a modification/cancellation request
async function sendModificationNotification(businessId, modification) {
  requireBusinessId(businessId, 'sendModificationNotification');
  const settings = await getTenantNotifications(businessId);
  if (!settings) return;

  const smsEnabled = settings.sms_enabled ?? true;
  const emailEnabled = settings.email_enabled ?? true;
  const type = modification.request_type === 'cancel' ? 'Cancellation' : 'Modification';
  const { name: businessName } = await getTenantDisplay(businessId);

  if (emailEnabled && settings.email_to) {
    const html = `
      <h2>📝 Booking ${type} Request — ${businessName}</h2>
      <table style="border-collapse:collapse; font-family:sans-serif;">
        <tr><td style="padding:4px 12px; font-weight:bold;">Customer:</td><td style="padding:4px 12px;">${modification.customer_name || 'Unknown'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Phone:</td><td style="padding:4px 12px;">${modification.customer_phone || 'N/A'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Type:</td><td style="padding:4px 12px;">${type}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Original:</td><td style="padding:4px 12px;">${modification.original_date || 'N/A'} ${modification.original_time || ''}</td></tr>
        ${modification.request_type === 'modify' ? `<tr><td style="padding:4px 12px; font-weight:bold;">New:</td><td style="padding:4px 12px;">${modification.new_date || 'N/A'} ${modification.new_time || ''}</td></tr>` : ''}
        ${modification.details ? `<tr><td style="padding:4px 12px; font-weight:bold;">Details:</td><td style="padding:4px 12px;">${modification.details}</td></tr>` : ''}
      </table>
      <p style="margin-top:16px; color:#666;">Log in to the Command Center to process this request.</p>
    `;
    await sendEmail(
      businessId,
      settings.email_to,
      `[${businessName}] Booking ${type} - ${modification.customer_name || 'Unknown'}`,
      html
    );
  }

  if (smsEnabled && settings.sms_to) {
    const sms = `[${businessName}] Booking ${type.toLowerCase()}: ${modification.customer_name || 'Unknown'}, ${modification.original_date || ''} ${modification.original_time || ''}. ${modification.details || ''} Check Command Center.`;
    await sendSMS(businessId, settings.sms_to, sms);
  }
}

/**
 * Format a short, friendly time string in a given IANA timezone.
 * Example: "Sun Apr 19 at 11:46 AM"
 *
 * Tenant-agnostic helper — caller passes the business's timezone. Defaults
 * to America/Toronto so legacy callers that didn't pass a tz keep working.
 */
function formatShortDateTime(dateStr, timeStr, timezone = 'America/Toronto') {
  try {
    if (!dateStr) return timeStr || '';

    // Extract just the date part if it has extra junk (YYYY-MM-DD format)
    let cleanDate = String(dateStr);
    if (cleanDate.includes('T')) cleanDate = cleanDate.split('T')[0];
    if (cleanDate.includes(' ')) cleanDate = cleanDate.split(' ')[0];

    const [year, month, day] = cleanDate.split('-').map(Number);
    if (!year || !month || !day) {
      return `${cleanDate} ${timeStr || ''}`.trim();
    }

    const d = new Date(Date.UTC(year, month - 1, day));
    const dayPart = d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: timezone
    });

    if (!timeStr) return dayPart;

    const timeParts = String(timeStr).split(':');
    const h = parseInt(timeParts[0], 10);
    const m = parseInt(timeParts[1], 10) || 0;
    if (isNaN(h)) return dayPart;

    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr12 = h % 12 === 0 ? 12 : h % 12;
    const mm = String(m).padStart(2, '0');

    return `${dayPart} at ${hr12}:${mm} ${ampm}`;
  } catch (err) {
    console.error('formatShortDateTime error:', err.message, { dateStr, timeStr });
    return `${String(dateStr).split('T')[0]} ${timeStr || ''}`.trim();
  }
}

/**
 * Get the best SMS-capable number for a customer — scoped by business_id
 * so we never accidentally read another tenant's customer row with the same
 * phone number.
 */
async function getSmsPhoneForCustomer(businessId, booking) {
  requireBusinessId(businessId, 'getSmsPhoneForCustomer');
  if (!booking?.customer_phone) return null;
  try {
    const res = await dbQuery(
      'SELECT line_type, alternate_phone FROM customers WHERE business_id = $1 AND phone = $2',
      [businessId, booking.customer_phone]
    );
    const customer = res.rows[0];
    if (customer?.line_type === 'landline' && customer?.alternate_phone) {
      console.log(`[tenant:${businessId}] Customer ${booking.customer_phone} is landline — using alternate: ${customer.alternate_phone}`);
      return customer.alternate_phone;
    }
    if (customer?.line_type === 'landline' && !customer?.alternate_phone) {
      console.log(`[tenant:${businessId}] Customer ${booking.customer_phone} is landline with no alternate — skipping SMS`);
      return null;
    }
  } catch (err) {
    console.warn(`[tenant:${businessId}] Could not check line type:`, err.message);
  }
  return booking.customer_phone;
}

/**
 * Build the short "Call us at 905 655 6300" style tail, pulling the tenant's
 * configured transfer number. Returns an empty string when no number is set.
 */
function transferTail(transferNumber) {
  return transferNumber ? ` call us at ${transferNumber}` : ' call us back';
}

/**
 * Format the holes count for customer-facing copy.
 *
 * A real customer booked 9 holes and the staff confirmed it as 18 because
 * we never wrote that distinction anywhere visible. The booking record now
 * carries a `holes` integer (9 or 18, or null for legacy rows) — we surface
 * that explicitly in every SMS/email so the caller can self-correct before
 * they show up at the course.
 *
 * Returns "" when holes is null (legacy rows) so older bookings don't grow
 * a misleading "(undefined-hole)" tail.
 */
function holesLabel(holes) {
  if (holes === 18 || holes === '18') return '18-hole';
  if (holes === 9 || holes === '9') return '9-hole';
  return '';
}

// Send booking confirmation SMS to the CUSTOMER (not staff)
async function sendBookingConfirmationToCustomer(businessId, booking) {
  requireBusinessId(businessId, 'sendBookingConfirmationToCustomer');
  try {
    const settings = await getTenantNotifications(businessId);
    if (!settings?.customer_sms_enabled) return null;

    const smsPhone = await getSmsPhoneForCustomer(businessId, booking);
    if (!smsPhone) return null;

    const { name, transferNumber, timezone } = await getTenantDisplay(businessId);
    const when = formatShortDateTime(booking.requested_date, booking.requested_time, timezone);
    const players = booking.party_size || 1;
    const playerWord = players === 1 ? 'player' : 'players';
    const holes = holesLabel(booking.holes);
    const holesPart = holes ? ` (${holes})` : '';
    const msg = `${name}: Tee time request for ${when}, ${players} ${playerWord}${holesPart}. Your booking is not confirmed until you receive a confirmation text!! If plans change please${transferTail(transferNumber)}.`;

    return await sendSMS(businessId, smsPhone, msg);
  } catch (err) {
    console.error(`[tenant:${businessId}] Customer confirmation SMS failed:`, err.message);
    return null;
  }
}

// Send a final "confirmed" SMS when staff approves a booking
async function sendBookingConfirmedToCustomer(businessId, booking) {
  requireBusinessId(businessId, 'sendBookingConfirmedToCustomer');
  try {
    const settings = await getTenantNotifications(businessId);
    if (!settings?.customer_sms_enabled) return null;

    const smsPhone = await getSmsPhoneForCustomer(businessId, booking);
    if (!smsPhone) return null;

    const { name, transferNumber, timezone } = await getTenantDisplay(businessId);
    const when = formatShortDateTime(booking.requested_date, booking.requested_time, timezone);
    const players = booking.party_size || 1;
    const playerWord = players === 1 ? 'player' : 'players';
    const holes = holesLabel(booking.holes);
    const holesPart = holes ? ` (${holes})` : '';
    const msg = `${name}: Tee time CONFIRMED for ${when}, ${players} ${playerWord}${holesPart}. See you then! If plans change please${transferTail(transferNumber)}.`;

    return await sendSMS(businessId, smsPhone, msg);
  } catch (err) {
    console.error(`[tenant:${businessId}] Customer confirmed SMS failed:`, err.message);
    return null;
  }
}

// Send a cancellation acknowledgement SMS
async function sendBookingCancelledToCustomer(businessId, booking) {
  requireBusinessId(businessId, 'sendBookingCancelledToCustomer');
  try {
    const settings = await getTenantNotifications(businessId);
    if (!settings?.customer_sms_enabled) return null;

    const smsPhone = await getSmsPhoneForCustomer(businessId, booking);
    if (!smsPhone) return null;

    const { name, timezone } = await getTenantDisplay(businessId);
    const when = formatShortDateTime(booking.requested_date, booking.requested_time, timezone);
    const msg = `${name}: Your tee time for ${when} has been cancelled. Call us back anytime to rebook. Thank you!`;

    return await sendSMS(businessId, smsPhone, msg);
  } catch (err) {
    console.error(`[tenant:${businessId}] Customer cancellation SMS failed:`, err.message);
    return null;
  }
}

// Send a rejection SMS with the reason
async function sendBookingRejectedToCustomer(businessId, booking, reason) {
  requireBusinessId(businessId, 'sendBookingRejectedToCustomer');
  try {
    const settings = await getTenantNotifications(businessId);
    if (!settings?.customer_sms_enabled) return null;

    const smsPhone = await getSmsPhoneForCustomer(businessId, booking);
    if (!smsPhone) return null;

    const { name, transferNumber, timezone } = await getTenantDisplay(businessId);
    const when = formatShortDateTime(booking.requested_date, booking.requested_time, timezone);
    const reasonText = reason ? ` Reason: ${reason}` : '';
    const tail = transferNumber ? ` Please call us at ${transferNumber} to find an alternative time.` : ' Please call us back to find an alternative time.';
    const msg = `${name}: Unfortunately your tee time request for ${when} could not be accommodated.${reasonText}${tail} Thank you!`;

    return await sendSMS(businessId, smsPhone, msg);
  } catch (err) {
    console.error(`[tenant:${businessId}] Customer rejection SMS failed:`, err.message);
    return null;
  }
}

/**
 * Send a concise post-call recap SMS to the owner — used by the
 * Personal Assistant template after every inbound call.
 *
 * The Personal Assistant vertical sits on top of tenants where a single
 * human ("the owner") wants the AI to handle their calls and report back.
 * After each call we text the owner a short summary so they can triage
 * without listening to recordings.
 *
 * Shape of the SMS (example):
 *   "Alex called at 2:15pm - wants to reschedule Thursday meeting.
 *    Left message: Can we move to Friday 3pm?"
 *
 * Controls read from the `post_call_sms` setting on the tenant:
 *   - enabled (bool)            — master switch
 *   - to_number (string)        — where to text. Falls back to the business
 *                                 row's transfer_number, then the tenant's
 *                                 notifications.sms_to.
 *   - include_transcript_preview (bool) — append a short preview of the
 *                                 final caller turn when true (default true).
 *
 * Returns the Twilio message object on success, or null when the feature
 * is disabled / misconfigured / no recipient is known. Never throws — a
 * failure here must not kill the call-cleanup path.
 */
async function sendPostCallSummary(businessId, details = {}) {
  requireBusinessId(businessId, 'sendPostCallSummary');
  try {
    const cfg = (await getSetting(businessId, 'post_call_sms').catch(() => null)) || {};
    if (cfg.enabled === false) {
      console.log(`[tenant:${businessId}] post_call_sms disabled — skipping owner recap`);
      return null;
    }

    // Recipient resolution: explicit owner number > business transfer > staff sms_to.
    let to = cfg.to_number;
    if (!to) {
      const business = await safeGetBusiness(businessId);
      to = business?.transfer_number || null;
    }
    if (!to) {
      const notif = await getTenantNotifications(businessId);
      to = notif?.sms_to || null;
    }
    if (!to) {
      console.warn(`[tenant:${businessId}] Post-call SMS skipped — no owner number configured.`);
      return null;
    }

    const {
      transcript,
      summary,
      callerName,
      callerPhone,
      startedAt
    } = details;

    const { timezone } = await getTenantDisplay(businessId);

    // Caller label: prefer a known name, fall back to the raw number, then "Someone".
    const who = callerName && callerName.trim()
      ? callerName.trim()
      : (callerPhone ? callerPhone : 'Someone');

    // Local time-of-call. "2:15pm" reads more naturally than "14:15".
    let when = '';
    try {
      const t = startedAt ? new Date(startedAt) : new Date();
      when = t.toLocaleTimeString('en-US', {
        timeZone: timezone || 'America/Toronto',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }).replace(/\s?(AM|PM)/, (m) => m.trim().toLowerCase());
    } catch (_) {
      when = '';
    }

    const lead = when ? `${who} called at ${when}` : `${who} called`;

    // ------------------------------------------------------------------
    // Body shape — deliberately TWO lines max (user-requested).
    //   Line 1: "{Who} called at {time} — {summary}."
    //   Line 2: "Left message: {short preview}."   (omitted if no preview
    //                                               or include_transcript_preview=false)
    // No business tag, no duration — owner knows who they are, and the
    // duration just adds noise to a glance-able text.
    // ------------------------------------------------------------------
    const summaryText = (summary && String(summary).trim()) || 'No details captured.';

    // Preview — pull the LAST caller line from the transcript (owner cares
    // about how the call ended, not how it opened). Short-circuit to a
    // trimmed tail when the transcript doesn't have "caller:" markers. We
    // strip the "caller:" / "user:" speaker tag itself before including the
    // text — the owner reading the SMS doesn't care about the label.
    let preview = '';
    if (cfg.include_transcript_preview !== false && transcript) {
      const flat = String(transcript);
      const speakerRe = /(?:^|\n)\s*(?:caller|user)\s*:\s*([^\n]+)/gi;
      let lastMatch = null;
      let m;
      while ((m = speakerRe.exec(flat)) !== null) {
        lastMatch = m[1];
      }
      let raw = lastMatch
        ? lastMatch.trim()
        : flat.replace(/\s+/g, ' ').trim();
      if (raw && raw.length > 90) raw = raw.slice(0, 87) + '\u2026';
      preview = raw;
    }

    const line1 = `${lead} \u2014 ${summaryText}`.replace(/\s+$/, '');
    const line2 = preview ? `Left message: ${preview}` : '';

    let body = line2 ? `${line1}\n${line2}` : line1;
    // Trim any accidental end punctuation dupes, then hard-cap so a runaway
    // summary from the model doesn't turn into a multi-segment SMS charge.
    body = body.replace(/([.!?])\.$/g, '$1');
    if (body.length > 320) body = body.slice(0, 317) + '\u2026';

    return await sendSMS(businessId, to, body);
  } catch (err) {
    console.error(`[tenant:${businessId}] Post-call recap SMS failed:`, err.message);
    return null;
  }
}

module.exports = {
  sendEmail,
  sendSMS,
  sendBookingNotification,
  sendModificationNotification,
  sendBookingConfirmationToCustomer,
  sendBookingConfirmedToCustomer,
  sendBookingCancelledToCustomer,
  sendBookingRejectedToCustomer,
  sendPostCallSummary,
  getSmsPhoneForCustomer,
  formatShortDateTime
};
