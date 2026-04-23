/**
 * Scheduled Tasks Service — multi-tenant.
 *
 * Runs once per 15 minutes and iterates every active business. For each
 * tenant we honour that tenant's timezone and reminder settings, so a
 * tenant in Vancouver gets 6 PM reminders at their local 6 PM and not
 * 6 PM in Toronto.
 */
const { query, getSetting, listActiveBusinesses } = require('../config/database');
const { sendSMS, formatShortDateTime } = require('./notification');

/**
 * Return the current hour/minute/date-string for a given IANA timezone.
 */
function getNowInTimezone(timezone) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = formatter.formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value;
  return {
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
    dateStr: `${get('year')}-${get('month')}-${get('day')}`
  };
}

/**
 * Return YYYY-MM-DD for "tomorrow" in the given timezone.
 */
function getTomorrowDateStr(timezone) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  return formatter.format(tomorrow);
}

/**
 * Send day-before reminders for one tenant.
 * Scoped by `business.id` on every query.
 */
async function sendDayBeforeRemindersForBusiness(business) {
  const businessId = business.id;
  const timezone = business.timezone || 'America/Toronto';
  const businessName = business.name || 'Golf Course';
  const transferNumber = business.transfer_number || '';

  try {
    const settings = await getSetting(businessId, 'notifications');
    if (!settings?.reminder_sms_enabled) {
      console.log(`[tenant:${businessId}] Day-before reminders disabled — skipping`);
      return { sent: 0, skipped: 0, reason: 'disabled' };
    }

    const tomorrow = getTomorrowDateStr(timezone);
    console.log(`[tenant:${businessId}] Checking for confirmed bookings on ${tomorrow}...`);

    // Join on customers scoped by the same business so a landline customer
    // in a different tenant with the same phone can never satisfy this join.
    const res = await query(
      `SELECT br.*, c.line_type, c.alternate_phone
         FROM booking_requests br
         LEFT JOIN customers c
           ON c.business_id = br.business_id
          AND c.phone = br.customer_phone
        WHERE br.business_id = $1
          AND br.requested_date = $2
          AND br.status = 'confirmed'
          AND br.reminder_sent IS NOT TRUE`,
      [businessId, tomorrow]
    );

    const bookings = res.rows;
    if (bookings.length === 0) {
      console.log(`[tenant:${businessId}] No bookings to remind about tomorrow`);
      return { sent: 0, skipped: 0, reason: 'no_bookings' };
    }

    console.log(`[tenant:${businessId}] Found ${bookings.length} confirmed bookings for tomorrow`);

    let sent = 0;
    let skipped = 0;

    for (const booking of bookings) {
      let smsPhone = booking.customer_phone;
      if (booking.line_type === 'landline') {
        if (booking.alternate_phone) {
          smsPhone = booking.alternate_phone;
        } else {
          console.log(`[tenant:${businessId}] Skipping ${booking.customer_name} — landline, no alternate`);
          skipped++;
          continue;
        }
      }
      if (!smsPhone) {
        console.log(`[tenant:${businessId}] Skipping ${booking.customer_name} — no phone number`);
        skipped++;
        continue;
      }

      try {
        const when = formatShortDateTime(booking.requested_date, booking.requested_time, timezone);
        const players = booking.party_size || 1;
        const playerWord = players === 1 ? 'player' : 'players';
        const firstName = booking.customer_name?.split(' ')[0] || 'there';
        const tail = transferNumber
          ? `If plans change, call us at ${transferNumber}.`
          : 'If plans change, please call us back.';
        const msg = `Hey ${firstName}! Reminder: you've got a tee time tomorrow at ${businessName} — ${when}, ${players} ${playerWord}. See you on the course! ${tail}`;

        await sendSMS(businessId, smsPhone, msg);

        await query(
          'UPDATE booking_requests SET reminder_sent = TRUE WHERE id = $1 AND business_id = $2',
          [booking.id, businessId]
        );

        sent++;
        console.log(`[tenant:${businessId}] ✓ Sent reminder to ${booking.customer_name} at ${smsPhone}`);
      } catch (err) {
        console.error(`[tenant:${businessId}] Failed to send reminder to ${booking.customer_name}:`, err.message);
        skipped++;
      }
    }

    console.log(`[tenant:${businessId}] Reminders done — sent: ${sent}, skipped: ${skipped}`);
    return { sent, skipped, total: bookings.length };
  } catch (err) {
    console.error(`[tenant:${businessId}] Error running reminders:`, err.message);
    return { sent: 0, skipped: 0, error: err.message };
  }
}

/**
 * Iterate every active tenant and fire reminders in that tenant's local
 * evening window. Exposed for ad-hoc manual runs and for scheduled
 * invocation every 15 minutes.
 *
 * `options.force = true` sends regardless of the local clock — used from
 * debug/admin endpoints so ops can manually kick off a run.
 * `options.businessId` restricts the run to one tenant.
 */
async function sendDayBeforeReminders(options = {}) {
  const { force = false, businessId = null } = options;
  const results = [];
  try {
    const tenants = await listActiveBusinesses();
    const scoped = businessId ? tenants.filter(t => t.id === businessId) : tenants;

    for (const business of scoped) {
      const tz = business.timezone || 'America/Toronto';
      const { hour, minute } = getNowInTimezone(tz);
      const inWindow = hour === 18 && minute < 15;

      if (!force && !inWindow) continue;

      const result = await sendDayBeforeRemindersForBusiness(business);
      results.push({ business_id: business.id, slug: business.slug, ...result });
    }
  } catch (err) {
    console.error('[Reminders] Failed to iterate tenants:', err.message);
    return { error: err.message, results };
  }
  return { results };
}

/**
 * Start the reminder scheduler. One shared interval fires every 15 minutes
 * and each tenant decides independently whether the local 6 PM window is open.
 */
let reminderInterval = null;
function startReminderScheduler() {
  console.log('[Reminders] Scheduler started — each tenant fires at their local 6 PM');

  reminderInterval = setInterval(() => {
    sendDayBeforeReminders().catch(err =>
      console.error('[Reminders] Scheduled run failed:', err.message)
    );
  }, 15 * 60 * 1000);

  // Catch a restart that lands inside any tenant's window.
  sendDayBeforeReminders().catch(err =>
    console.error('[Reminders] Initial check failed:', err.message)
  );
}

function stopReminderScheduler() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
}

module.exports = {
  sendDayBeforeReminders,
  sendDayBeforeRemindersForBusiness,
  startReminderScheduler,
  stopReminderScheduler
};
