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

module.exports = {
  sendEmail,
  sendSMS,
  sendBookingNotification,
  sendModificationNotification
};
