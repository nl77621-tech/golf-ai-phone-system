/**
 * Scheduled Tasks Service
 * Handles recurring jobs like day-before reminder texts.
 *
 * Runs on a simple setInterval — no external scheduler needed.
 * Uses Eastern time (America/Toronto) for all date logic since that's the course timezone.
 */
const { query, getSetting } = require('../config/database');
const { sendSMS, formatShortDateTime } = require('./notification');

/**
 * Get current Eastern time components
 */
function getEasternNow() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = formatter.formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value;
  return {
    hour: parseInt(get('hour')),
    minute: parseInt(get('minute')),
    dateStr: `${get('year')}-${get('month')}-${get('day')}`
  };
}

/**
 * Get tomorrow's date in YYYY-MM-DD format (Eastern time)
 */
function getTomorrowDateStr() {
  const now = new Date();
  // Add a day
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' });
  return formatter.format(tomorrow);
}

/**
 * Send day-before reminder texts for tomorrow's confirmed bookings.
 * Only sends to customers who can receive SMS (mobile or alternate phone).
 */
async function sendDayBeforeReminders() {
  try {
    const settings = await getSetting('notifications');
    if (!settings?.reminder_sms_enabled) {
      console.log('[Reminders] Day-before reminders disabled — skipping');
      return { sent: 0, skipped: 0, reason: 'disabled' };
    }

    const tomorrow = getTomorrowDateStr();
    console.log(`[Reminders] Checking for confirmed bookings on ${tomorrow}...`);

    // Get all confirmed bookings for tomorrow
    const res = await query(
      `SELECT br.*, c.line_type, c.alternate_phone
       FROM booking_requests br
       LEFT JOIN customers c ON c.phone = br.customer_phone
       WHERE br.requested_date = $1
         AND br.status = 'confirmed'
         AND br.reminder_sent IS NOT TRUE`,
      [tomorrow]
    );

    const bookings = res.rows;
    if (bookings.length === 0) {
      console.log('[Reminders] No bookings to remind about tomorrow');
      return { sent: 0, skipped: 0, reason: 'no_bookings' };
    }

    console.log(`[Reminders] Found ${bookings.length} confirmed bookings for tomorrow`);

    let sent = 0;
    let skipped = 0;

    for (const booking of bookings) {
      // Determine the right phone to text
      let smsPhone = booking.customer_phone;
      if (booking.line_type === 'landline') {
        if (booking.alternate_phone) {
          smsPhone = booking.alternate_phone;
        } else {
          console.log(`[Reminders] Skipping ${booking.customer_name} — landline, no alternate`);
          skipped++;
          continue;
        }
      }

      if (!smsPhone) {
        console.log(`[Reminders] Skipping ${booking.customer_name} — no phone number`);
        skipped++;
        continue;
      }

      try {
        const when = formatShortDateTime(booking.requested_date, booking.requested_time);
        const players = booking.party_size || 1;
        const playerWord = players === 1 ? 'player' : 'players';
        const firstName = booking.customer_name?.split(' ')[0] || 'there';
        const msg = `Hey ${firstName}! Reminder: you've got a tee time tomorrow at Valleymede Columbus — ${when}, ${players} ${playerWord}. See you on the course! If plans change, call us at 905 655 6300.`;

        await sendSMS(smsPhone, msg);

        // Mark as reminded so we don't double-send
        await query('UPDATE booking_requests SET reminder_sent = TRUE WHERE id = $1', [booking.id]);

        sent++;
        console.log(`[Reminders] ✓ Sent reminder to ${booking.customer_name} at ${smsPhone}`);
      } catch (err) {
        console.error(`[Reminders] Failed to send reminder to ${booking.customer_name}:`, err.message);
        skipped++;
      }
    }

    console.log(`[Reminders] Done — sent: ${sent}, skipped: ${skipped}`);
    return { sent, skipped, total: bookings.length };
  } catch (err) {
    console.error('[Reminders] Error running reminders:', err.message);
    return { sent: 0, skipped: 0, error: err.message };
  }
}

/**
 * Start the reminder scheduler.
 * Checks every 15 minutes. Sends reminders at 6 PM Eastern.
 * The reminder_sent flag on each booking prevents double-sends.
 */
let reminderInterval = null;
function startReminderScheduler() {
  console.log('[Reminders] Scheduler started — will send reminders at 6 PM Eastern');

  // Check every 15 minutes
  reminderInterval = setInterval(async () => {
    const { hour, minute } = getEasternNow();

    // Send between 6:00 PM and 6:14 PM Eastern (one 15-min window)
    if (hour === 18 && minute < 15) {
      console.log('[Reminders] 6 PM window — triggering day-before reminders');
      await sendDayBeforeReminders();
    }
  }, 15 * 60 * 1000); // every 15 minutes

  // Also do an initial check in case server restarted during the window
  const { hour, minute } = getEasternNow();
  if (hour === 18 && minute < 15) {
    console.log('[Reminders] Server started during 6 PM window — sending now');
    sendDayBeforeReminders().catch(err => console.error('[Reminders] Initial check failed:', err.message));
  }
}

function stopReminderScheduler() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
}

module.exports = {
  sendDayBeforeReminders,
  startReminderScheduler,
  stopReminderScheduler
};
