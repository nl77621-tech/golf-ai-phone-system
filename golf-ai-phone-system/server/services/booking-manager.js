/**
 * Booking Manager Service
 * Handles booking requests, modifications, and cancellations
 */
const { query } = require('../config/database');
const { sendBookingNotification, sendModificationNotification } = require('./notification');

// Create a new booking request
async function createBookingRequest({
  customerId, customerName, customerPhone, customerEmail,
  requestedDate, requestedTime, partySize, numCarts, specialRequests, callId
}) {
  const res = await query(
    `INSERT INTO booking_requests
     (customer_id, customer_name, customer_phone, customer_email,
      requested_date, requested_time, party_size, num_carts, special_requests, call_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [customerId, customerName, customerPhone, customerEmail,
     requestedDate, requestedTime, partySize || 1, numCarts || 0, specialRequests, callId]
  );

  const booking = res.rows[0];

  // Notify staff
  try {
    await sendBookingNotification(booking);
  } catch (err) {
    console.error('Failed to send booking notification:', err.message);
  }

  return booking;
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
  const res = await query(
    `UPDATE booking_requests SET status = $1, staff_notes = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [status, staffNotes, id]
  );
  return res.rows[0];
}

// Update modification status
async function updateModificationStatus(id, status, staffNotes) {
  const res = await query(
    `UPDATE modification_requests SET status = $1, staff_notes = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [status, staffNotes, id]
  );
  return res.rows[0];
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

module.exports = {
  createBookingRequest,
  createModificationRequest,
  getPendingBookings,
  getPendingModifications,
  updateBookingStatus,
  updateModificationStatus,
  getBookingsForDateRange,
  getAllBookings
};
