/**
 * REST API Routes — Command Center Backend
 * All routes require authentication (JWT)
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { query, getSetting, updateSetting } = require('../config/database');
const {
  getAllBookings, updateBookingStatus, createBookingRequest,
  getPendingModifications, updateModificationStatus
} = require('../services/booking-manager');

// Apply auth middleware to all API routes
router.use(requireAuth);

// ============================================
// DASHBOARD
// ============================================

// GET /api/dashboard — Dashboard stats
router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [callsToday, pendingBookings, pendingMods, totalCustomers, recentCalls] = await Promise.all([
      query(`SELECT COUNT(*) FROM call_logs WHERE started_at::date = $1`, [today]),
      query(`SELECT COUNT(*) FROM booking_requests WHERE status = 'pending'`),
      query(`SELECT COUNT(*) FROM modification_requests WHERE status = 'pending'`),
      query(`SELECT COUNT(*) FROM customers`),
      query(`SELECT cl.*, c.name as customer_name
             FROM call_logs cl LEFT JOIN customers c ON cl.customer_id = c.id
             ORDER BY cl.started_at DESC LIMIT 10`)
    ]);

    res.json({
      callsToday: parseInt(callsToday.rows[0].count),
      pendingBookings: parseInt(pendingBookings.rows[0].count),
      pendingModifications: parseInt(pendingMods.rows[0].count),
      totalCustomers: parseInt(totalCustomers.rows[0].count),
      recentCalls: recentCalls.rows
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ============================================
// SETTINGS
// ============================================

// GET /api/settings — Get all settings
router.get('/settings', async (req, res) => {
  try {
    const result = await query('SELECT key, value, description FROM settings ORDER BY key');
    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = { value: row.value, description: row.description };
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PUT /api/settings/:key — Update a specific setting
router.put('/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }
    const result = await updateSetting(key, value);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// ============================================
// BOOKINGS
// ============================================

// GET /api/bookings — List all bookings (with optional status filter)
router.get('/bookings', async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const result = await getAllBookings(parseInt(page), parseInt(limit), status || null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load bookings' });
  }
});

// POST /api/bookings — Create a booking manually from Command Center
router.post('/bookings', async (req, res) => {
  try {
    const { customer_name, customer_phone, customer_email, requested_date, requested_time, party_size, num_carts, special_requests } = req.body;
    if (!customer_name || !requested_date || !party_size) {
      return res.status(400).json({ error: 'customer_name, requested_date, and party_size are required' });
    }
    const booking = await createBookingRequest({
      customerName: customer_name,
      customerPhone: customer_phone || null,
      customerEmail: customer_email || null,
      requestedDate: requested_date,
      requestedTime: requested_time || null,
      partySize: parseInt(party_size),
      numCarts: parseInt(num_carts) || 0,
      specialRequests: special_requests || null,
      callId: null
    });
    res.json(booking);
  } catch (err) {
    console.error('Failed to create booking:', err);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// PUT /api/bookings/:id — Update booking details from Command Center
router.put('/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_name, customer_phone, customer_email, requested_date, requested_time, party_size, num_carts, special_requests, staff_notes } = req.body;
    const result = await query(
      `UPDATE booking_requests SET
        customer_name = COALESCE($1, customer_name),
        customer_phone = COALESCE($2, customer_phone),
        customer_email = COALESCE($3, customer_email),
        requested_date = COALESCE($4, requested_date),
        requested_time = COALESCE($5, requested_time),
        party_size = COALESCE($6, party_size),
        num_carts = COALESCE($7, num_carts),
        special_requests = COALESCE($8, special_requests),
        staff_notes = COALESCE($9, staff_notes),
        updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [customer_name || null, customer_phone || null, customer_email || null,
       requested_date || null, requested_time || null,
       party_size ? parseInt(party_size) : null, num_carts !== undefined ? parseInt(num_carts) : null,
       special_requests || null, staff_notes || null, parseInt(id)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Failed to update booking:', err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// PUT /api/bookings/:id/status — Update booking status
router.put('/bookings/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, staff_notes } = req.body;
    if (!['pending', 'confirmed', 'rejected', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const booking = await updateBookingStatus(parseInt(id), status, staff_notes);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// POST /api/bookings/:id/sms — Send a custom SMS to the customer for this booking
router.post('/bookings/:id/sms', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const result = await query('SELECT * FROM booking_requests WHERE id = $1', [parseInt(id)]);
    const booking = result.rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.customer_phone) return res.status(400).json({ error: 'No phone number on this booking' });

    const { sendSMS } = require('../services/notification');
    await sendSMS(booking.customer_phone, message.trim());
    res.json({ ok: true, to: booking.customer_phone });
  } catch (err) {
    console.error('Custom SMS error:', err.message);
    res.status(500).json({ error: 'Failed to send SMS: ' + err.message });
  }
});

// ============================================
// MODIFICATIONS
// ============================================

// GET /api/modifications — List pending modification/cancellation requests
router.get('/modifications', async (req, res) => {
  try {
    const mods = await getPendingModifications();
    res.json(mods);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load modifications' });
  }
});

// PUT /api/modifications/:id/status — Process a modification request
router.put('/modifications/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, staff_notes } = req.body;
    if (!['processed', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be processed, rejected, or pending.' });
    }
    const mod = await updateModificationStatus(parseInt(id), status, staff_notes);
    if (!mod) {
      return res.status(404).json({ error: 'Modification request not found' });
    }
    res.json(mod);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update modification' });
  }
});

// ============================================
// CUSTOMERS
// ============================================

// GET /api/customers — List all customers
router.get('/customers', async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql, params;

    if (search) {
      sql = `SELECT * FROM customers
             WHERE LOWER(name) LIKE LOWER($1) OR phone LIKE $1 OR LOWER(email) LIKE LOWER($1)
             ORDER BY last_call_at DESC LIMIT $2 OFFSET $3`;
      params = [`%${search}%`, parseInt(limit), offset];
    } else {
      sql = 'SELECT * FROM customers ORDER BY last_call_at DESC LIMIT $1 OFFSET $2';
      params = [parseInt(limit), offset];
    }

    const result = await query(sql, params);
    let countSql, countParams;
    if (search) {
      countSql = `SELECT COUNT(*) FROM customers WHERE LOWER(name) LIKE LOWER($1) OR phone LIKE $1 OR LOWER(email) LIKE LOWER($1)`;
      countParams = [`%${search}%`];
    } else {
      countSql = 'SELECT COUNT(*) FROM customers';
      countParams = [];
    }
    const countResult = await query(countSql, countParams);

    res.json({
      customers: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// POST /api/customers — Manually add a new contact
router.post('/customers', async (req, res) => {
  try {
    const { name, phone, email, notes } = req.body;
    if (!name && !phone) return res.status(400).json({ error: 'Name or phone required' });
    const { normalizePhone } = require('../services/caller-lookup');
    const normalized = phone ? normalizePhone(phone) : null;

    // Check if phone already exists
    if (normalized) {
      const existing = await query('SELECT * FROM customers WHERE phone = $1', [normalized]);
      if (existing.rows.length > 0) {
        // Update with name if missing
        const updated = await query(
          `UPDATE customers SET name = COALESCE($1, name), email = COALESCE($2, email), notes = COALESCE($3, notes) WHERE phone = $4 RETURNING *`,
          [name || null, email || null, notes || null, normalized]
        );
        return res.json(updated.rows[0]);
      }
    }

    const result = await query(
      `INSERT INTO customers (name, phone, email, notes, call_count, first_call_at, last_call_at)
       VALUES ($1, $2, $3, $4, 0, NOW(), NOW()) RETURNING *`,
      [name || null, normalized, email || null, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Failed to create customer:', err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// GET /api/customers/:id — Get a single customer with history
router.get('/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [customer, bookings, calls] = await Promise.all([
      query('SELECT * FROM customers WHERE id = $1', [id]),
      query('SELECT * FROM booking_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20', [id]),
      query('SELECT * FROM call_logs WHERE customer_id = $1 ORDER BY started_at DESC LIMIT 20', [id])
    ]);

    if (customer.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({
      customer: customer.rows[0],
      bookings: bookings.rows,
      calls: calls.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load customer' });
  }
});

// PUT /api/customers/:id — Update customer info
router.put('/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, notes, custom_greeting, custom_greetings, customer_knowledge } = req.body;
    const fields = [];
    const values = [];
    let p = 1;

    if (name !== undefined) { fields.push(`name = $${p++}`); values.push(name); }
    if (email !== undefined) { fields.push(`email = $${p++}`); values.push(email); }
    if (phone !== undefined) { fields.push(`phone = $${p++}`); values.push(phone); }
    if (notes !== undefined) { fields.push(`notes = $${p++}`); values.push(notes); }
    if (custom_greeting !== undefined) { fields.push(`custom_greeting = $${p++}`); values.push(custom_greeting || null); }
    if (custom_greetings !== undefined) { fields.push(`custom_greetings = $${p++}`); values.push(JSON.stringify(custom_greetings || [])); }
    if (customer_knowledge !== undefined) { fields.push(`customer_knowledge = $${p++}`); values.push(customer_knowledge || null); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(id);
    const result = await query(
      `UPDATE customers SET ${fields.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// ============================================
// CALL LOGS
// ============================================

// GET /api/calls — List call logs
router.get('/calls', async (req, res) => {
  try {
    const { page = 1, limit = 50, date } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql, params;

    if (date) {
      sql = `SELECT cl.*, c.name as customer_name
             FROM call_logs cl LEFT JOIN customers c ON cl.customer_id = c.id
             WHERE cl.started_at::date = $1
             ORDER BY cl.started_at DESC LIMIT $2 OFFSET $3`;
      params = [date, parseInt(limit), offset];
    } else {
      sql = `SELECT cl.*, c.name as customer_name
             FROM call_logs cl LEFT JOIN customers c ON cl.customer_id = c.id
             ORDER BY cl.started_at DESC LIMIT $1 OFFSET $2`;
      params = [parseInt(limit), offset];
    }

    const result = await query(sql, params);
    res.json({ calls: result.rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load call logs' });
  }
});

// GET /api/calls/:id — Get a single call log with transcript
router.get('/calls/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT cl.*, c.name as customer_name
       FROM call_logs cl LEFT JOIN customers c ON cl.customer_id = c.id
       WHERE cl.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call log not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load call log' });
  }
});

// ============================================
// GREETINGS
// ============================================

// GET /api/greetings — List all greetings
router.get('/greetings', async (req, res) => {
  try {
    const result = await query('SELECT * FROM greetings ORDER BY for_known_caller, id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load greetings' });
  }
});

// POST /api/greetings — Add a new greeting
router.post('/greetings', async (req, res) => {
  try {
    const { message, for_known_caller = false } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const result = await query(
      'INSERT INTO greetings (message, for_known_caller, active) VALUES ($1, $2, true) RETURNING *',
      [message, for_known_caller]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create greeting' });
  }
});

// PUT /api/greetings/:id — Update a greeting
router.put('/greetings/:id', async (req, res) => {
  try {
    const { message, active } = req.body;
    const fields = [];
    const values = [];
    let p = 1;
    if (message !== undefined) { fields.push(`message = $${p++}`); values.push(message); }
    if (active !== undefined) { fields.push(`active = $${p++}`); values.push(active); }
    values.push(req.params.id);
    const result = await query(
      `UPDATE greetings SET ${fields.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update greeting' });
  }
});

// DELETE /api/greetings/:id — Remove a greeting
router.delete('/greetings/:id', async (req, res) => {
  try {
    await query('DELETE FROM greetings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete greeting' });
  }
});

module.exports = router;
