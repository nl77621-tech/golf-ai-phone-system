/**
 * Notification Service
 * Sends email and SMS alerts to staff for bookings and modifications
 */
const nodemailer = require('nodemailer');
const { getSetting } = require('../config/database');
require('dotenv').config();

// Create email transporter
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

// Send email notification
async function sendEmail(to, subject, htmlBody) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('Email not configured. Skipping notification.');
    return null;
  }
  try {
    const info = await getTransporter().sendMail({
      from: `"Valleymede Golf AI" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html: htmlBody
    });
    console.log('Email sent:', info.messageId);
    return info;
  } catch (err) {
    console.error('Email send failed:', err.message);
    throw err;
  }
}

// Send SMS via Twilio
async function sendSMS(to, message) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('Twilio not configured. Skipping SMS.');
    return null;
  }
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const msg = await twilio.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to
    });
    console.log('SMS sent:', msg.sid);
    return msg;
  } catch (err) {
    console.error('SMS send failed:', err.message);
    throw err;
  }
}

// Notify staff of a new booking request
async function sendBookingNotification(booking) {
  const settings = await getSetting('notifications');
  if (!settings) return;

  const dateStr = new Date(booking.requested_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  if (settings.email_enabled && settings.email_to) {
    const html = `
      <h2>🏌️ New Tee Time Request</h2>
      <table style="border-collapse:collapse; font-family:sans-serif;">
        <tr><td style="padding:4px 12px; font-weight:bold;">Customer:</td><td style="padding:4px 12px;">${booking.customer_name || 'Unknown'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Phone:</td><td style="padding:4px 12px;">${booking.customer_phone || 'N/A'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Email:</td><td style="padding:4px 12px;">${booking.customer_email || 'N/A'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Date:</td><td style="padding:4px 12px;">${dateStr}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Time:</td><td style="padding:4px 12px;">${booking.requested_time || 'Flexible'}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Players:</td><td style="padding:4px 12px;">${booking.party_size}</td></tr>
        <tr><td style="padding:4px 12px; font-weight:bold;">Carts:</td><td style="padding:4px 12px;">${booking.num_carts || 0}</td></tr>
        ${booking.special_requests ? `<tr><td style="padding:4px 12px; font-weight:bold;">Notes:</td><td style="padding:4px 12px;">${booking.special_requests}</td></tr>` : ''}
      </table>
      <p style="margin-top:16px; color:#666;">Log in to the Command Center to confirm or modify this booking.</p>
    `;
    await sendEmail(settings.email_to, `New Tee Time Request - ${booking.customer_name || 'Unknown'} - ${dateStr}`, html);
  }

  if (settings.sms_enabled && settings.sms_to) {
    const sms = `New tee time request: ${booking.customer_name || 'Unknown'}, ${dateStr} ${booking.requested_time || ''}, ${booking.party_size} players. Check Command Center to confirm.`;
    await sendSMS(settings.sms_to, sms);
  }
}

// Notify staff of a modification/cancellation request
async function sendModificationNotification(modification) {
  const settings = await getSetting('notifications');
  if (!settings) return;

  const type = modification.request_type === 'cancel' ? 'Cancellation' : 'Modification';

  if (settings.email_enabled && settings.email_to) {
    const html = `
      <h2>📝 Booking ${type} Request</h2>
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
    await sendEmail(settings.email_to, `Booking ${type} - ${modification.customer_name || 'Unknown'}`, html);
  }

  if (settings.sms_enabled && settings.sms_to) {
    const sms = `Booking ${type.toLowerCase()}: ${modification.customer_name || 'Unknown'}, ${modification.original_date || ''} ${modification.original_time || ''}. ${modification.details || ''} Check Command Center.`;
    await sendSMS(settings.sms_to, sms);
  }
}

// Format a short, friendly time string: "Sun Apr 19 at 11:46 AM" — NO timezone garbage
function formatShortDateTime(dateStr, timeStr) {
  try {
    if (!dateStr) return timeStr || '';

    // Extract just the date part if it has extra junk (YYYY-MM-DD format)
    let cleanDate = String(dateStr);
    if (cleanDate.includes('T')) cleanDate = cleanDate.split('T')[0];
    if (cleanDate.includes(' ')) cleanDate = cleanDate.split(' ')[0];

    // Parse just YYYY-MM-DD
    const [year, month, day] = cleanDate.split('-').map(Number);
    if (!year || !month || !day) {
      return `${cleanDate} ${timeStr || ''}`.trim();
    }

    // Create date in UTC, then format in Toronto timezone
    const d = new Date(Date.UTC(year, month - 1, day));
    const dayPart = d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'America/Toronto'
    });

    if (!timeStr) return dayPart;

    // Parse HH:MM and convert to 12hr AM/PM
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
    // Last resort: just return the clean parts
    return `${String(dateStr).split('T')[0]} ${timeStr || ''}`.trim();
  }
}

// Send booking confirmation SMS to the CUSTOMER (not staff)
// Controlled by settings.customer_sms_enabled toggle
async function sendBookingConfirmationToCustomer(booking) {
  try {
    const settings = await getSetting('notifications');
    if (!settings?.customer_sms_enabled) return null;
    if (!booking?.customer_phone) return null;

    const when = formatShortDateTime(booking.requested_date, booking.requested_time);
    const players = booking.party_size || 1;
    const playerWord = players === 1 ? 'player' : 'players';
    const msg = `Valleymede Golf: Tee time request for ${when}, ${players} ${playerWord}. We'll confirm shortly. Reply CANCEL to cancel.`;

    return await sendSMS(booking.customer_phone, msg);
  } catch (err) {
    console.error('Customer confirmation SMS failed:', err.message);
    return null;
  }
}

// Send a final "confirmed" SMS when staff approves a booking
async function sendBookingConfirmedToCustomer(booking) {
  try {
    const settings = await getSetting('notifications');
    if (!settings?.customer_sms_enabled) return null;
    if (!booking?.customer_phone) return null;

    const when = formatShortDateTime(booking.requested_date, booking.requested_time);
    const players = booking.party_size || 1;
    const playerWord = players === 1 ? 'player' : 'players';
    const msg = `Valleymede Golf: Tee time CONFIRMED for ${when}, ${players} ${playerWord}. See you then! Reply CANCEL if plans change.`;

    return await sendSMS(booking.customer_phone, msg);
  } catch (err) {
    console.error('Customer confirmed SMS failed:', err.message);
    return null;
  }
}

// Send a cancellation acknowledgement SMS
async function sendBookingCancelledToCustomer(booking) {
  try {
    const settings = await getSetting('notifications');
    if (!settings?.customer_sms_enabled) return null;
    if (!booking?.customer_phone) return null;

    const when = formatShortDateTime(booking.requested_date, booking.requested_time);
    const msg = `Valleymede Golf: Your tee time for ${when} has been cancelled. Call us back anytime to rebook. Thank you!`;

    return await sendSMS(booking.customer_phone, msg);
  } catch (err) {
    console.error('Customer cancellation SMS failed:', err.message);
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
  formatShortDateTime
};
