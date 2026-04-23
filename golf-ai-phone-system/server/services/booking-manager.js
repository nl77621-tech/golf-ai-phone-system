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
  requestedDate, requestedTime, partySize, numCarts, specialRequests, cardLastFour, callId
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

  try {
    const cardDigits = cardLastFour ? String(cardLastFour).replace(/\D/g, '').slice(-4) : null;

    const res = await query(
      `INSERT INTO booking_requests
       (business_id, customer_id, customer_name, customer_phone, customer_email,
        requested_date, requested_time, party_size, num_carts, special_requests, card_last_four, call_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
       RETURNING *`,
      [businessId, customerId || null, customerName.trim(), customerPhone || null,
       customerEmail || null, normalizedDate, requestedTime || null, size, carts,
       specialRequests || null, cardDigits, callId || null]
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

  const res = await query(
    `UPDATE booking_requests
        SET status = $1, staff_notes = $2, updated_at = NOW()
      WHERE id = $3 AND business_id = $4
      RETURNING *`,
    [status, staffNotes, id, businessId]
  );
  const booking = res.rows[0];

  if (booking && prevStatus !== status) {
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

  return mod;
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
  getPendingModifications,
  updateBookingStatus,
  updateModificationStatus,
  getBookingsForDateRange,
  getAllBookings,
  findActiveBookingByPhone,
  getConfirmedBookingsByPhone,
  getBookingById
};
