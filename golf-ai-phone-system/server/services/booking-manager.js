/**
 * Booking Manager Service — tenant-scoped.
 *
 * Every function takes `businessId` as its first argument. List-style
 * functions (used by Super Admin dashboards later) accept `null` when the
 * caller is a super admin; pass the explicit businessId for tenant users.
 */
const { query, getBusinessById } = require('../config/database');
const {
  requireBusinessId,
  requireBusinessIdOrSuperAdmin
} = require('../context/tenant-context');
const eventBus = require('./event-bus');
const {
  sendBookingNotification,
  sendModificationNotification,
  sendBookingConfirmationToCustomer,
  sendBookingConfirmedToCustomer,
  sendBookingCancelledToCustomer,
  sendBookingRejectedToCustomer
} = require('./notification');

// Resolve a business's timezone with a safe default. All date math in this
// file uses the tenant's timezone rather than hardcoded America/Toronto.
async function getBusinessTimezone(businessId) {
  try {
    const business = await getBusinessById(businessId);
    return business?.timezone || 'America/Toronto';
  } catch (_) {
    return 'America/Toronto';
  }
}

// Create a new booking request
async function createBookingRequest({
  businessId, customerId, customerName, customerPhone, customerEmail,
  requestedDate, requestedTime, partySize, numCarts, specialRequests, cardLastFour, callId,
  holes
}) {
  requireBusinessId(businessId, 'createBookingRequest');

  // Validate required fields
  if (!customerName || typeof customerName !== 'string') {
    throw new Error('customer_name is required');
  }
  if (!requestedDate || typeof requestedDate !== 'string') {
    throw new Error('requested_date is required');
  }
  // Normalize date — ensure it's a valid YYYY-MM-DD format for PostgreSQL
  let normalizedDate = requestedDate.trim();
  const parsed = new Date(normalizedDate + 'T12:00:00');
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid date format: "${requestedDate}". Expected YYYY-MM-DD.`);
  }
  normalizedDate = parsed.toISOString().split('T')[0];

  const size = parseInt(partySize) || 1;
  if (size < 1 || size > 20) {
    throw new Error('party_size must be between 1 and 20');
  }
  const carts = parseInt(numCarts) || 0;

  // 9 or 18 only — anything else (incl. undefined / null / 0) gets stored
  // as NULL so old client paths and pre-tee-on tenants still work. The DB
  // CHECK constraint enforces the same; this is just defense-in-depth so
  // the INSERT never fails on the constraint.
  let normalizedHoles = null;
  if (holes === 9 || holes === 18 || holes === '9' || holes === '18') {
    normalizedHoles = parseInt(holes, 10);
  }

  try {
    const cardDigits = cardLastFour ? String(cardLastFour).replace(/\D/g, '').slice(-4) : null;

    const res = await query(
      `INSERT INTO booking_requests
       (business_id, customer_id, customer_name, customer_phone, customer_email,
        requested_date, requested_time, party_size, num_carts, holes, special_requests, card_last_four, call_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
       RETURNING *`,
      [businessId, customerId || null, customerName.trim(), customerPhone || null,
       customerEmail || null, normalizedDate, requestedTime || null, size, carts,
       normalizedHoles, specialRequests || null, cardDigits, callId || null]
    );

    const booking = res.rows[0];
    if (!booking) {
      console.error(`[tenant:${businessId}] Booking insert returned no rows`);
      throw new Error('Booking insertion returned no rows');
    }

    console.log(`[tenant:${businessId}] ✓ Booking created:`, {
      id: booking.id,
      customer: customerName,
      date: requestedDate,
      time: requestedTime,
      status: booking.status,
      phone: customerPhone
    });

    // Notify staff of new pending booking (tenant-scoped)
    try {
      await sendBookingNotification(businessId, booking);
    } catch (err) {
      console.error(`[tenant:${businessId}] Failed to send booking notification:`, err.message);
    }

    // Live broadcast — every browser tab open on this tenant's Command
    // Center gets a 'booking.created' SSE event so the dashboard / tee
    // sheet / bookings list can refetch without a page reload. Best-
    // effort; a publish failure must not roll back the booking.
    eventBus.publish(businessId, 'booking.created', {
      id: booking.id,
      customer_name: booking.customer_name,
      requested_date: booking.requested_date,
      requested_time: booking.requested_time,
      party_size: booking.party_size,
      holes: booking.holes,
      status: booking.status
    });

    return booking;
  } catch (err) {
    console.error(`[tenant:${businessId}] Failed to create booking:`, err.message, {
      customerName, requestedDate, requestedTime, partySize: size
    });
    throw err;
  }
}

// Create a modification or cancellation request
async function createModificationRequest({
  businessId, customerId, customerName, customerPhone, requestType,
  originalDate, originalTime, newDate, newTime, details, callId
}) {
  requireBusinessId(businessId, 'createModificationRequest');

  if (!requestType || !['modify', 'cancel'].includes(requestType)) {
    throw new Error('requestType must be "modify" or "cancel"');
  }
  if (!customerName && !customerPhone) {
    throw new Error('At least customerName or customerPhone is required');
  }
  const res = await query(
    `INSERT INTO modification_requests
     (business_id, customer_id, customer_name, customer_phone, request_type,
      original_date, original_time, new_date, new_time, details, call_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [businessId, customerId, customerName, customerPhone, requestType,
     originalDate, originalTime, newDate, newTime, details, callId]
  );

  const modification = res.rows[0];
  try {
    await sendModificationNotification(businessId, modification);
  } catch (err) {
    console.error(`[tenant:${businessId}] Failed to send modification notification:`, err.message);
  }
  // Live broadcast — same as bookings, so the Pending Changes tile
  // updates as soon as a caller asks to modify or cancel.
  eventBus.publish(businessId, 'modification.created', {
    id: modification.id,
    request_type: modification.request_type,
    customer_name: modification.customer_name,
    original_date: modification.original_date,
    original_time: modification.original_time,
    new_date: modification.new_date,
    new_time: modification.new_time
  });
  return modification;
}

// Get all pending booking requests for a tenant
async function getPendingBookings(businessId) {
  requireBusinessId(businessId, 'getPendingBookings');
  const res = await query(
    `SELECT * FROM booking_requests
      WHERE business_id = $1 AND status = 'pending'
      ORDER BY created_at DESC`,
    [businessId]
  );
  return res.rows;
}

// Get all pending modification requests for a tenant
async function getPendingModifications(businessId) {
  requireBusinessId(businessId, 'getPendingModifications');
  const res = await query(
    `SELECT * FROM modification_requests
      WHERE business_id = $1 AND status = 'pending'
      ORDER BY created_at DESC`,
    [businessId]
  );
  return res.rows;
}

// Update booking status (from Command Center)
//
// Tee-On sync hook (Phase 13):
//   When a booking transitions to 'confirmed' we optionally push it to
//   the live Tee-On admin tee sheet. The push is gated by per-tenant
//   feature flags (`teeon_admin_writes_enabled` + `teeon_admin_dry_run`)
//   in the settings table — both default to off / dry-run, so EXISTING
//   tenants see ZERO behaviour change until ops opts them in.
//   - Push happens BEFORE the local UPDATE on confirm. If Tee-On rejects
//     the booking, we throw and the row stays 'pending' so staff can
//     retry — no half-confirmed state, no premature SMS.
//   - On 'cancelled' transitions from 'confirmed', we mirror the cancel
//     to Tee-On AFTER the local UPDATE, best-effort. A Tee-On hiccup
//     must never trap a customer in a confirmed booking they cancelled.
async function updateBookingStatus(businessId, id, status, staffNotes) {
  requireBusinessId(businessId, 'updateBookingStatus');

  // Capture previous status so we only notify on actual transitions, and
  // ensure the booking belongs to this tenant before touching it.
  const prev = await query(
    'SELECT status FROM booking_requests WHERE id = $1 AND business_id = $2',
    [id, businessId]
  );
  if (prev.rows.length === 0) return null; // belongs to a different tenant (or doesn't exist)
  const prevStatus = prev.rows[0].status;

  // Pre-update Tee-On push for confirm transitions. createBooking is a
  // no-op when the feature flag is off, so this branch is dormant by
  // default and incurs only a single getSetting() round-trip.
  if (status === 'confirmed' && prevStatus !== 'confirmed') {
    const teeonAdmin = require('./teeon-admin');
    const result = await teeonAdmin.createBooking(businessId, id);
    if (result && !result.ok && !result.skipped) {
      // Real failure (not flag-off, not dry-run) — refuse to confirm so
      // staff sees the error and the booking stays pending for retry.
      const err = new Error(`Tee-On push failed: ${result.error || 'unknown'}`);
      err.code = 'TEEON_WRITE_FAILED';
      throw err;
    }
  }

  const res = await query(
    `UPDATE booking_requests
        SET status = $1, staff_notes = $2, updated_at = NOW()
      WHERE id = $3 AND business_id = $4
      RETURNING *`,
    [status, staffNotes, id, businessId]
  );
  const booking = res.rows[0];

  if (booking && prevStatus !== status) {
    // Mirror cancellations to Tee-On (best-effort — local cancel wins).
    if (status === 'cancelled' && prevStatus === 'confirmed') {
      try {
        const teeonAdmin = require('./teeon-admin');
        await teeonAdmin.cancelBooking(businessId, id);
      } catch (err) {
        console.error(`[tenant:${businessId}] Tee-On cancel mirror failed:`, err.message);
      }
    }

    try {
      if (status === 'confirmed') {
        await sendBookingConfirmedToCustomer(businessId, booking);
      } else if (status === 'cancelled') {
        await sendBookingCancelledToCustomer(businessId, booking);
      } else if (status === 'rejected') {
        await sendBookingRejectedToCustomer(businessId, booking, staffNotes);
      }
    } catch (err) {
      console.error(`[tenant:${businessId}] Status-change SMS failed:`, err.message);
    }
    // Broadcast the transition so other open browser tabs can re-render
    // their list / dashboard counters without polling.
    eventBus.publish(businessId, 'booking.updated', {
      id: booking.id,
      from_status: prevStatus,
      to_status: status,
      requested_date: booking.requested_date,
      requested_time: booking.requested_time,
      customer_name: booking.customer_name
    });
  }

  return booking;
}

// Update modification status
// When a cancellation request is processed, also cancel the matching booking
async function updateModificationStatus(businessId, id, status, staffNotes) {
  requireBusinessId(businessId, 'updateModificationStatus');

  const res = await query(
    `UPDATE modification_requests
        SET status = $1, staff_notes = $2, updated_at = NOW()
      WHERE id = $3 AND business_id = $4
      RETURNING *`,
    [status, staffNotes, id, businessId]
  );
  const mod = res.rows[0];
  if (!mod) return null;

  // If staff processed a cancellation request, auto-cancel the matching booking
  if (mod.request_type === 'cancel' && status === 'processed') {
    try {
      const matchQuery = await query(
        `SELECT id FROM booking_requests
           WHERE business_id = $1
             AND customer_phone = $2
             AND status IN ('pending', 'confirmed')
             AND ($3::date IS NULL OR requested_date = $3::date)
           ORDER BY requested_date ASC
           LIMIT 1`,
        [businessId, mod.customer_phone, mod.original_date || null]
      );
      if (matchQuery.rows[0]) {
        await updateBookingStatus(
          businessId,
          matchQuery.rows[0].id,
          'cancelled',
          staffNotes || 'Cancelled by customer via phone call'
        );
      }
    } catch (err) {
      console.error(`[tenant:${businessId}] Auto-cancel failed:`, err.message);
    }
  }

  // Live broadcast — Pending Changes tile + modifications list refetch
  // when staff marks a request processed/rejected.
  eventBus.publish(businessId, 'modification.updated', {
    id: mod.id,
    status: mod.status,
    request_type: mod.request_type,
    customer_name: mod.customer_name
  });

  return mod;
}

/**
 * Get all PENDING holds for a tenant on a given date. Used by the AI's
 * `check_tee_times` tool to subtract slots the assistant has already
 * promised on this call (or earlier today) but that staff hasn't yet
 * pushed to the live tee sheet — without this, two callers in quick
 * succession could each be offered the same time.
 *
 * Only `status = 'pending'` rows are returned. Once staff marks a row
 * `confirmed`, it should already be on Tee-On, so the live availability
 * check will reflect it directly — subtracting it here would double-count.
 *
 * Returns rows with `requested_time` normalised to "HH:MM" (24-hour) so
 * the caller can match them against tee-sheet slot times. Postgres
 * returns TIME as a string like "08:00:00" — we slice to "HH:MM".
 */
async function getPendingHoldsForDate(businessId, dateYMD) {
  requireBusinessId(businessId, 'getPendingHoldsForDate');
  if (!dateYMD || typeof dateYMD !== 'string') return [];
  const res = await query(
    `SELECT id, requested_time, party_size, customer_name, created_at
       FROM booking_requests
      WHERE business_id = $1
        AND status = 'pending'
        AND requested_date = $2::date`,
    [businessId, dateYMD]
  );
  return res.rows.map(r => {
    const raw = r.requested_time;
    let time_24h = null;
    if (raw) {
      const s = String(raw).trim();
      // Postgres TIME comes back as "HH:MM:SS" — slice off seconds.
      time_24h = s.slice(0, 5);
    }
    return {
      id: r.id,
      time_24h,
      party_size: Number(r.party_size) || 1,
      customer_name: r.customer_name || null,
      created_at: r.created_at
    };
  });
}

// Get bookings for a date range
async function getBookingsForDateRange(businessId, startDate, endDate) {
  requireBusinessId(businessId, 'getBookingsForDateRange');
  const res = await query(
    `SELECT * FROM booking_requests
      WHERE business_id = $1
        AND requested_date BETWEEN $2 AND $3
      ORDER BY requested_date, requested_time`,
    [businessId, startDate, endDate]
  );
  return res.rows;
}

/**
 * Get all bookings (with pagination). Scoped to one tenant.
 * Super-admin callers that need cross-tenant listings should hit a dedicated
 * /api/admin/* endpoint that doesn't go through this function.
 */
async function getAllBookings(businessId, page = 1, limit = 50, status = null) {
  requireBusinessId(businessId, 'getAllBookings');

  const offset = (page - 1) * limit;
  let sql = 'SELECT * FROM booking_requests WHERE business_id = $1';
  const params = [businessId];

  if (status) {
    sql += ` AND status = $${params.length + 1}`;
    params.push(status);
  }

  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const res = await query(sql, params);

  let countSql = 'SELECT COUNT(*) FROM booking_requests WHERE business_id = $1';
  const countParams = [businessId];
  if (status) {
    countSql += ` AND status = $${countParams.length + 1}`;
    countParams.push(status);
  }
  const countRes = await query(countSql, countParams);

  return {
    bookings: res.rows,
    total: parseInt(countRes.rows[0].count),
    page,
    limit
  };
}

// Find the most recent active booking for a phone number (one tenant)
// Used by the SMS CANCEL reply handler.
async function findActiveBookingByPhone(businessId, phone) {
  requireBusinessId(businessId, 'findActiveBookingByPhone');
  if (!phone) return null;
  const tz = await getBusinessTimezone(businessId);
  const res = await query(
    `SELECT * FROM booking_requests
      WHERE business_id = $1
        AND customer_phone = $2
        AND status IN ('pending', 'confirmed')
        AND requested_date >= (NOW() AT TIME ZONE $3)::date
      ORDER BY requested_date ASC, requested_time ASC
      LIMIT 1`,
    [businessId, phone, tz]
  );
  return res.rows[0] || null;
}

/**
 * Get all active upcoming bookings for a phone number (confirmed + pending).
 * Used by the AI to read back bookings when the caller wants to cancel/modify
 * or check their tee time. Uses the business's configured timezone.
 */
async function getConfirmedBookingsByPhone(businessId, phone) {
  requireBusinessId(businessId, 'getConfirmedBookingsByPhone');
  if (!phone) return [];
  const tz = await getBusinessTimezone(businessId);
  const res = await query(
    `SELECT * FROM booking_requests
      WHERE business_id = $1
        AND customer_phone = $2
        AND status IN ('confirmed', 'pending')
        AND requested_date >= (NOW() AT TIME ZONE $3)::date
      ORDER BY requested_date ASC, requested_time ASC`,
    [businessId, phone, tz]
  );
  return res.rows;
}

// Get a specific booking by ID, scoped to one tenant
async function getBookingById(businessId, id) {
  requireBusinessId(businessId, 'getBookingById');
  const res = await query(
    'SELECT * FROM booking_requests WHERE id = $1 AND business_id = $2',
    [id, businessId]
  );
  return res.rows[0] || null;
}

module.exports = {
  createBookingRequest,
  createModificationRequest,
  getPendingBookings,
  getPendingHoldsForDate,
  getPendingModifications,
  updateBookingStatus,
  updateModificationStatus,
  getBookingsForDateRange,
  getAllBookings,
  findActiveBookingByPhone,
  getConfirmedBookingsByPhone,
  getBookingById
};
