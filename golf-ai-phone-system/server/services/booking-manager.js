/**
 * Booking Manager Service
 * Handles booking requests, modifications, and cancellations
 */
const { query } = require('../config/database');
const {
  sendBookingNotification,
  sendModificationNotification,
  sendBookingConfirmationToCustomer,
  sendBookingConfirmedToCustomer,
  sendBookingCancelledToCustomer
} = require('./notification');

// Create a new booking request
async function createBookingRequest({
  customerId, customerName, customerPhone, customerEmail,
  requestedDate, requestedTime, partySize, numCarts, specialRequests, callId
}) {
  // Validate required fields
  if (!customerName || typeof customerName !== 'string') {
    throw new Error('customer_name is required');
  }
  if (!requestedDate || typeof requestedDate !== 'string') {
    throw new Error('requested_date is required');
  }
  const size = parseInt(partySize) || 1;
  if (size < 1 || size > 20) {
    throw new Error('party_size must be between 1 and 20');
  }
  const carts = parseInt(numCarts) || 0;

  try {
    const res = await query(
      `INSERT INTO booking_requests
       (customer_id, customer_name, customer_phone, customer_email,
        requested_date, requested_time, party_size, num_carts, special_requests, call_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
       RETURNING *`,
      [customerId || null, customerName.trim(), customerPhone || null, customerEmail || null,
       requestedDate, requestedTime || null, size, carts, specialRequests || null, callId || null]
    );

    const booking = res.rows[0];

    if (!booking) {
      console.error('Booking insert returned no rows. Expected booking with status=pending');
      throw new Error('Booking insertion returned no rows');
    }

    console.log('✓ Booking created:', {
      id: booking.id,
      customer: customerName,
      date: requestedDate,
      time: requestedTime,
      status: booking.status,
      phone: customerPhone
    });

    // Notify staff of new pending booking
    try {
      await sendBookingNotification(booking);
    } catch (err) {
      console.error('Failed to send booking notification:', err.message);
    }

    // NOTE: We do NOT send SMS to the customer here.
    // The customer only receives a confirmation text when staff CONFIRMS the booking in Command Center.

    return booking;
  } catch (err) {
    console.error('Failed to create booking:', err.message, {
      customerName,
      requestedDate,
      requestedTime,
      partySize: size
    });
    throw err;
  }
}

// Create a modification or cancellation request
async function createModificationRequest({
  customerId, customerName, customerPhone, requestType,
  originalDate, originalTime, newDate, newTime, details, callId
}) {
  const res = await query(
    `INSERT INTO modification_requests
     (customer_id, customer_name, customer_phone, request_type,
      original_date, original_time, new_date, new_time, details, call_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [customerId, customerName, customerPhone, requestType,
     originalDate, originalTime, newDate, newTime, details, callId]
  );

  const modification = res.rows[0];

  try {
    await sendModificationNotification(modification);
  } catch (err) {
    console.error('Failed to send modification notification:', err.message);
  }

  return modification;
}

// Get all pending booking requests
async function getPendingBookings() {
  const res = await query(
    `SELECT * FROM booking_requests WHERE status = 'pending' ORDER BY created_at DESC`
  );
  return res.rows;
}

// Get all pending modification requests
async function getPendingModifications() {
  const res = await query(
    `SELECT * FROM modification_requests WHERE status = 'pending' ORDER BY created_at DESC`
  );
  return res.rows;
}

// Update booking status (from Command Center)
async function updateBookingStatus(id, status, staffNotes) {
  // Capture previous status so we only notify on actual transitions
  const prev = await query('SELECT status FROM booking_requests WHERE id = $1', [id]);
  const prevStatus = prev.rows[0]?.status;

  const res = await query(
    `UPDATE booking_requests SET status = $1, staff_notes = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [status, staffNotes, id]
  );
  const booking = res.rows[0];

  // Send customer SMS on status transitions
  if (booking && prevStatus !== status) {
    try {
      if (status === 'confirmed') {
        await sendBookingConfirmedToCustomer(booking);
      } else if (status === 'cancelled') {
        await sendBookingCancelledToCustomer(booking);
      }
    } catch (err) {
      console.error('Failed to send status-change SMS to customer:', err.message);
    }
  }

  return booking;
}

// Update modification status
// When a cancellation request is processed, also cancel the matching booking
async function updateModificationStatus(id, status, staffNotes) {
  const res = await query(
    `UPDATE modification_requests SET status = $1, staff_notes = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [status, staffNotes, id]
  );
  const mod = res.rows[0];

  // If staff processed a cancellation request, auto-cancel the matching booking
  if (mod && mod.request_type === 'cancel' && status === 'processed') {
    try {
      // Find the matching active booking by phone + date
      const matchQuery = await query(
        `SELECT id FROM booking_requests
         WHERE customer_phone = $1
           AND status IN ('pending', 'confirmed')
           AND ($2::date IS NULL OR requested_date = $2::date)
         ORDER BY requested_date ASC
         LIMIT 1`,
        [mod.customer_phone, mod.original_date || null]
      );
      if (matchQuery.rows[0]) {
        await updateBookingStatus(matchQuery.rows[0].id, 'cancelled', staffNotes || 'Cancelled by customer via phone call');
      }
    } catch (err) {
      console.error('Failed to auto-cancel matching booking:', err.message);
    }
  }

  return mod;
}

// Get bookings for a date range
async function getBookingsForDateRange(startDate, endDate) {
  const res = await query(
    `SELECT * FROM booking_requests
     WHERE requested_date BETWEEN $1 AND $2
     ORDER BY requested_date, requested_time`,
    [startDate, endDate]
  );
  return res.rows;
}

// Get all bookings (with pagination)
async function getAllBookings(page = 1, limit = 50, status = null) {
  const offset = (page - 1) * limit;
  let sql = 'SELECT * FROM booking_requests';
  const params = [];

  if (status) {
    sql += ' WHERE status = $1';
    params.push(status);
  }

  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const res = await query(sql, params);

  // Get total count
  let countSql = 'SELECT COUNT(*) FROM booking_requests';
  const countParams = [];
  if (status) {
    countSql += ' WHERE status = $1';
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

// Find the most recent active booking for a phone number
// Used by the SMS CANCEL reply handler
async function findActiveBookingByPhone(phone) {
  if (!phone) return null;
  const res = await query(
    `SELECT * FROM booking_requests
     WHERE customer_phone = $1
       AND status IN ('pending', 'confirmed')
       AND requested_date >= CURRENT_DATE
     ORDER BY requested_date ASC, requested_time ASC
     LIMIT 1`,
    [phone]
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
  findActiveBookingByPhone
};
