/**
 * Twilio Webhook Routes
 * Handles incoming calls and media stream connections
 */
const express = require('express');
const router = express.Router();
const { handleMediaStream } = require('../services/grok-voice');
const { normalizePhone } = require('../services/caller-lookup');
const { getSetting } = require('../config/database');
const { findActiveBookingByPhone, updateBookingStatus } = require('../services/booking-manager');
require('dotenv').config();

/**
 * POST /twilio/voice — Twilio calls this when an inbound call arrives
 * Returns TwiML that tells Twilio to open a WebSocket media stream to our server
 */
router.post('/voice', async (req, res) => {
  const callerPhone = req.body.From || 'unknown';
  const callSid = req.body.CallSid;
  console.log(`Incoming call from ${callerPhone} (SID: ${callSid})`);

  // Check if test mode — optionally restrict to test phone number
  try {
    const testMode = await getSetting('test_mode');
    if (testMode?.enabled && testMode?.test_phone) {
      const normalized = normalizePhone(callerPhone);
      const testNormalized = normalizePhone(testMode.test_phone);
      if (normalized !== testNormalized) {
        // Not the test phone — play a message and hang up
        res.type('text/xml');
        res.send(`
          <Response>
            <Say voice="alice">Thank you for calling Valleymede Columbus Golf Course. Our phone system is currently being updated. Please call back shortly or visit our website at valleymede columbus golf dot com.</Say>
            <Hangup/>
          </Response>
        `);
        return;
      }
    }
  } catch (err) {
    console.error('Test mode check failed:', err.message);
  }

  // Get the app URL for WebSocket connection
  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  const wsUrl = appUrl.replace('https://', 'wss://').replace('http://', 'ws://');

  // Return TwiML to connect the call to our WebSocket media stream
  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="${wsUrl}/twilio/media-stream">
          <Parameter name="callerPhone" value="${callerPhone}" />
          <Parameter name="callSid" value="${callSid}" />
        </Stream>
      </Connect>
    </Response>
  `);
});

/**
 * POST /twilio/status — Call status callback (optional)
 * Twilio calls this when a call status changes
 */
router.post('/status', (req, res) => {
  const { CallSid, CallStatus, Duration } = req.body;
  console.log(`Call ${CallSid} status: ${CallStatus} (duration: ${Duration}s)`);
  res.sendStatus(200);
});

/**
 * POST /twilio/transfer — Handle call transfer
 * Called when the AI decides to transfer to a human
 */
router.post('/transfer', async (req, res) => {
  try {
    const transferNumber = await getSetting('transfer_number');
    if (!transferNumber) {
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
          ${JSON.parse(transferNumber)}
        </Dial>
      </Response>
    `);
  } catch (err) {
    console.error('Transfer error:', err.message);
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
 * POST /twilio/transfer-fallback — If transfer fails (no answer, busy)
 */
router.post('/transfer-fallback', (req, res) => {
  const dialStatus = req.body.DialCallStatus;
  res.type('text/xml');

  if (dialStatus === 'completed') {
    res.send('<Response><Hangup/></Response>');
  } else {
    res.send(`
      <Response>
        <Say voice="alice">Sorry, nobody was able to pick up. You can try again later, or I can continue helping you. Goodbye!</Say>
        <Hangup/>
      </Response>
    `);
  }
});

/**
 * POST /twilio/sms — Incoming SMS webhook
 * Handles CANCEL replies from customers who got a booking confirmation text
 */
router.post('/sms', async (req, res) => {
  const fromPhone = req.body.From;
  const body = (req.body.Body || '').trim();
  const bodyUpper = body.toUpperCase();

  console.log(`📩 Incoming SMS from ${fromPhone}: "${body}"`);

  // Helper to respond with TwiML containing a reply
  const twimlReply = (text) => {
    res.type('text/xml');
    res.send(`<Response><Message>${text}</Message></Response>`);
  };
  const twimlSilent = () => {
    res.type('text/xml');
    res.send('<Response></Response>');
  };

  try {
    const normalized = normalizePhone(fromPhone);
    if (!normalized) return twimlSilent();

    // CANCEL keyword → cancel most recent active booking
    if (bodyUpper === 'CANCEL' || bodyUpper === 'CANCEL ALL') {
      const booking = await findActiveBookingByPhone(normalized);
      if (!booking) {
        return twimlReply('Valleymede Golf: No upcoming tee time found on file. Call us if you need help.');
      }
      await updateBookingStatus(booking.id, 'cancelled', 'Cancelled by customer via SMS reply');
      // Note: updateBookingStatus already sends the cancellation SMS; TwiML reply acts as immediate ack
      return twimlReply(`Valleymede Golf: Your tee time on ${booking.requested_date} at ${booking.requested_time || ''} is cancelled. Thank you!`);
    }

    // HELP keyword
    if (bodyUpper === 'HELP') {
      return twimlReply('Valleymede Golf: For any changes or cancellations, please call us at 905 655 6300. Msg&data rates may apply.');
    }

    // STOP / UNSUBSCRIBE — Twilio handles opt-out automatically but we acknowledge
    if (bodyUpper === 'STOP' || bodyUpper === 'UNSUBSCRIBE') {
      return twimlSilent(); // Twilio auto-responds with opt-out confirmation
    }

    // Unknown reply — gently guide them to call
    return twimlReply('Valleymede Golf: For any changes or requests, please call us at 905 655 6300. Thank you!');
  } catch (err) {
    console.error('SMS handler error:', err.message);
    return twimlSilent();
  }
});

module.exports = router;
