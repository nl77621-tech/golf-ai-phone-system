/**
 * Twilio Webhook Routes — tenant-aware.
 *
 * Tenant resolution:
 *   /voice   → `attachTenantFromTwilioTo` (business resolved from req.body.To)
 *   /sms     → `attachTenantFromTwilioTo` (same)
 *   /status, /transfer, /transfer-fallback → `attachTenantFromCallSid`
 *     because these callbacks don't carry a meaningful To; we look the tenant
 *     up by CallSid in call_logs (and fall back to the single-tenant bootstrap
 *     rule baked into the middleware).
 *
 * After middleware runs, `req.business` is the full businesses row. Handlers
 * use `req.business.id` to scope every downstream call.
 */
const express = require('express');
const router = express.Router();
const { normalizePhone } = require('../services/caller-lookup');
const { getSetting } = require('../config/database');
const { findActiveBookingByPhone, updateBookingStatus } = require('../services/booking-manager');
const {
  attachTenantFromTwilioTo,
  attachTenantFromCallSid,
  resolveBusinessFromTwilioTo,
  validateTwilioSignature
} = require('../middleware/tenant');
require('dotenv').config();

// Every webhook on this router must carry a valid X-Twilio-Signature.
// In dev (no TWILIO_AUTH_TOKEN) this short-circuits with a warning; see
// validateTwilioSignature in middleware/tenant.js.
router.use(validateTwilioSignature);

// -------- small helpers --------

// Escape text for safe inclusion inside TwiML. Keeps `'` legal in <Say> too.
function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Normalize a phone number to E.164 for Twilio <Dial>.
function toE164(raw) {
  let n = String(raw || '').replace(/[^+\d]/g, '');
  if (!n) return null;
  if (!n.startsWith('+')) {
    if (n.length === 10) n = '+1' + n;
    else if (n.length === 11 && n.startsWith('1')) n = '+' + n;
    else n = '+' + n;
  }
  return n;
}

// Friendly "call us at X" string for a number, used in SMS replies.
function spokenTransferNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }
  return raw;
}

/**
 * POST /twilio/voice — Twilio calls this when an inbound call arrives.
 * Returns TwiML that opens a WebSocket media stream and passes the
 * business id, caller phone, and call sid through `<Parameter>` tags.
 */
router.post('/voice', attachTenantFromTwilioTo, async (req, res) => {
  const callerPhone = req.body.From || 'unknown';
  const callSid = req.body.CallSid;
  const business = req.business;
  const businessId = business.id;
  const businessName = business.name || 'our course';
  // Phase 5: resolver tags req.business._phoneSource with one of
  // 'business_phone_numbers' | 'legacy_denorm' | 'single_tenant_bootstrap'
  // so we can watch the routing switch over in production logs.
  const phoneSource = business._phoneSource || 'unknown';

  console.log(
    `[tenant:${businessId}] Incoming call from ${callerPhone} to ${req.body.To} ` +
    `(SID: ${callSid}) — routed via ${phoneSource}`
  );

  // Optional per-tenant test mode — only let the configured test phone through.
  try {
    const testMode = await getSetting(businessId, 'test_mode');
    if (testMode?.enabled && testMode?.test_phone) {
      const normalized = normalizePhone(callerPhone);
      const testNormalized = normalizePhone(testMode.test_phone);
      if (normalized !== testNormalized) {
        res.type('text/xml');
        res.send(`
          <Response>
            <Say voice="alice">Thank you for calling ${xmlEscape(businessName)}. Our phone system is currently being updated. Please call back shortly.</Say>
            <Hangup/>
          </Response>
        `);
        return;
      }
    }
  } catch (err) {
    console.error(`[tenant:${businessId}] Test mode check failed:`, err.message);
  }

  // Get the app URL for WebSocket connection
  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  const wsUrl = appUrl.replace('https://', 'wss://').replace('http://', 'ws://');

  // Return TwiML to connect the call to our WebSocket media stream. The
  // businessId parameter is what lets `server/index.js` spin the Grok bridge
  // up under the correct tenant context.
  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="${xmlEscape(wsUrl)}/twilio/media-stream">
          <Parameter name="businessId" value="${businessId}" />
          <Parameter name="callerPhone" value="${xmlEscape(callerPhone)}" />
          <Parameter name="callSid" value="${xmlEscape(callSid)}" />
          <Parameter name="appUrl" value="${xmlEscape(appUrl)}" />
        </Stream>
      </Connect>
    </Response>
  `);
});

/**
 * POST /twilio/status — Call status callback (optional).
 * No tenant resolution required; we just log. Twilio status callbacks don't
 * need to hit per-tenant settings.
 */
router.post('/status', (req, res) => {
  const { CallSid, CallStatus, Duration } = req.body;
  console.log(`Call ${CallSid} status: ${CallStatus} (duration: ${Duration}s)`);
  res.sendStatus(200);
});

/**
 * POST /twilio/transfer — Handle call transfer.
 * Called mid-call when the AI decides to hand off to a human. The tenant is
 * resolved by CallSid from call_logs. Transfer number resolution order:
 *   1. businesses.transfer_number (tenant column)
 *   2. getSetting(businessId, 'transfer_number')  (per-tenant setting blob)
 */
router.post('/transfer', attachTenantFromCallSid, async (req, res) => {
  const business = req.business;
  const businessId = business.id;
  try {
    let rawNumber = business.transfer_number || null;
    if (!rawNumber) {
      const fromSettings = await getSetting(businessId, 'transfer_number').catch(() => null);
      rawNumber = typeof fromSettings === 'string'
        ? fromSettings
        : (fromSettings?.number || fromSettings?.value || null);
    }

    const transferNumber = toE164(rawNumber);
    console.log(`[tenant:${businessId}] 📞 Transfer endpoint hit — resolved number: ${transferNumber}`);

    if (!transferNumber) {
      console.error(`[tenant:${businessId}] ❌ No transfer number configured`);
      res.type('text/xml');
      res.send(`
        <Response>
          <Say voice="alice">I'm sorry, no staff members are available right now. Please try again later.</Say>
          <Hangup/>
        </Response>
      `);
      return;
    }

    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="alice">One moment, I'm connecting you with a staff member.</Say>
        <Dial timeout="30" action="/twilio/transfer-fallback">
          ${xmlEscape(transferNumber)}
        </Dial>
      </Response>
    `);
  } catch (err) {
    console.error(`[tenant:${businessId}] Transfer error:`, err.message);
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="alice">I'm sorry, I wasn't able to transfer your call. Please try calling again.</Say>
        <Hangup/>
      </Response>
    `);
  }
});

/**
 * POST /twilio/transfer-fallback — If transfer fails (no answer, busy).
 */
router.post('/transfer-fallback', attachTenantFromCallSid, (req, res) => {
  const dialStatus = req.body.DialCallStatus;
  const dialSid = req.body.DialCallSid;
  const businessId = req.business?.id;
  console.log(`[tenant:${businessId}] 📞 Transfer fallback — DialCallStatus: ${dialStatus}, DialCallSid: ${dialSid}`);
  res.type('text/xml');

  if (dialStatus === 'completed') {
    res.send('<Response><Hangup/></Response>');
  } else {
    console.log(`[tenant:${businessId}] 📞 Transfer failed (${dialStatus}) — telling caller nobody picked up`);
    res.send(`
      <Response>
        <Say voice="alice">Sorry, nobody was able to pick up. You can try again later, or I can continue helping you. Goodbye!</Say>
        <Hangup/>
      </Response>
    `);
  }
});

/**
 * POST /twilio/sms — Incoming SMS webhook.
 * Handles CANCEL / HELP / STOP replies to booking confirmation texts.
 * Scoped to the tenant whose Twilio number received the SMS.
 */
router.post('/sms', attachTenantFromTwilioTo, async (req, res) => {
  const business = req.business;
  const businessId = business.id;
  const businessName = business.name || 'Golf Course';
  const transferNumber = business.transfer_number || null;
  const spokenTransfer = spokenTransferNumber(transferNumber);

  const fromPhone = req.body.From;
  const body = (req.body.Body || '').trim();
  const bodyUpper = body.toUpperCase();

  const phoneSource = business._phoneSource || 'unknown';
  console.log(
    `[tenant:${businessId}] 📩 Incoming SMS from ${fromPhone} to ${req.body.To}: "${body}" ` +
    `— routed via ${phoneSource}`
  );

  // Respond with TwiML containing a single reply message.
  const twimlReply = (text) => {
    res.type('text/xml');
    res.send(`<Response><Message>${xmlEscape(text)}</Message></Response>`);
  };
  const twimlSilent = () => {
    res.type('text/xml');
    res.send('<Response></Response>');
  };

  try {
    const normalized = normalizePhone(fromPhone);
    if (!normalized) return twimlSilent();

    // CANCEL keyword → cancel most recent active booking (this tenant only)
    if (bodyUpper === 'CANCEL' || bodyUpper === 'CANCEL ALL') {
      const booking = await findActiveBookingByPhone(businessId, normalized);
      if (!booking) {
        const fallback = spokenTransfer
          ? `${businessName}: No upcoming booking found on file. Call us at ${spokenTransfer} if you need help.`
          : `${businessName}: No upcoming booking found on file. Please call us if you need help.`;
        return twimlReply(fallback);
      }
      await updateBookingStatus(
        businessId,
        booking.id,
        'cancelled',
        'Cancelled by customer via SMS reply'
      );
      // updateBookingStatus already sends the cancellation SMS; this reply is
      // just the immediate ack for the Twilio webhook.
      return twimlReply(
        `${businessName}: Your booking on ${booking.requested_date} at ${booking.requested_time || ''} is cancelled. Thank you!`
      );
    }

    // HELP keyword
    if (bodyUpper === 'HELP') {
      const helpMsg = spokenTransfer
        ? `${businessName}: For any changes or cancellations, please call us at ${spokenTransfer}. Msg&data rates may apply.`
        : `${businessName}: For any changes or cancellations, please call us. Msg&data rates may apply.`;
      return twimlReply(helpMsg);
    }

    // STOP / UNSUBSCRIBE — Twilio handles opt-out automatically but we ack
    if (bodyUpper === 'STOP' || bodyUpper === 'UNSUBSCRIBE') {
      return twimlSilent();
    }

    // Unknown reply — gently guide them to call
    const guide = spokenTransfer
      ? `${businessName}: For any changes or requests, please call us at ${spokenTransfer}. Thank you!`
      : `${businessName}: For any changes or requests, please call us. Thank you!`;
    return twimlReply(guide);
  } catch (err) {
    console.error(`[tenant:${businessId}] SMS handler error:`, err.message);
    return twimlSilent();
  }
});

/**
 * GET /twilio/_debug/phone-resolve?To=+19053334444
 *
 * Non-production helper that runs the exact same resolution path as an
 * inbound /voice webhook and returns `{ to, source, business }` as JSON.
 * Useful during the Phase 5 cutover to prove "this DID now resolves via
 * business_phone_numbers, not the legacy denormalized column" without
 * having to place a real call.
 *
 * Gated on `DEBUG_PHONE_RESOLVE=1` so it's never accidentally exposed in
 * production. The route bypasses `validateTwilioSignature` because no
 * Twilio request ever hits it — it's for operator curl/Postman use.
 */
router.get('/_debug/phone-resolve', async (req, res) => {
  if (process.env.DEBUG_PHONE_RESOLVE !== '1') {
    return res.status(404).json({ error: 'Not found' });
  }
  const to = String(req.query.To || '').trim();
  if (!to) {
    return res.status(400).json({ error: 'Missing ?To=+1... query param' });
  }
  try {
    const business = await resolveBusinessFromTwilioTo(to);
    if (!business) {
      return res.status(404).json({
        to,
        resolved: false,
        source: null,
        reason: 'No business matched via business_phone_numbers, legacy denorm, or single-tenant bootstrap.'
      });
    }
    return res.json({
      to,
      resolved: true,
      source: business._phoneSource || 'unknown',
      business: {
        id: business.id,
        slug: business.slug,
        name: business.name,
        twilio_phone_number: business.twilio_phone_number,
        is_active: business.is_active,
        status: business.status
      }
    });
  } catch (err) {
    console.error('[tenant] phone-resolve debug error:', err.message);
    return res.status(500).json({ error: 'resolve failed', detail: err.message });
  }
});

module.exports = router;
