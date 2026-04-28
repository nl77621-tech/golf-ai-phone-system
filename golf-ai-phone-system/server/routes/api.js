/**
 * REST API Routes — Command Center backend (tenant-scoped).
 *
 * Every route in this file is mounted under `/api` and gated by:
 *   1. `requireAuth`           — decodes the JWT into `req.auth`
 *   2. `attachTenantFromAuth`  — hydrates `req.business` and enforces isolation
 *
 * Per CLAUDE.md §3.2, a regular tenant user must NEVER be able to read or
 * write another business's data. That is enforced here in three ways:
 *
 *   - `req.auth.business_id` is pulled from the JWT, never from the URL or
 *     body. Clients cannot choose which tenant they're operating on.
 *   - Every SQL statement that touches tenant data includes a
 *     `business_id = $N` predicate.
 *   - Every service call that goes through `booking-manager`, `notification`,
 *     etc. passes `businessId` as its first argument; those services defend
 *     in depth with `requireBusinessId()`.
 *
 * Super-admin cross-tenant flows live under `/api/admin/*` (Phase 3+) with a
 * separate `requireSuperAdmin` middleware — none of those endpoints live in
 * this file. If a super-admin token hits this router we 403, because these
 * routes are not designed for cross-tenant use.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { attachTenantFromAuth } = require('../middleware/tenant');
const { SUPER_ADMIN_ROLE } = require('../context/tenant-context');
const {
  query,
  getSetting,
  updateSetting,
  getAllSettings,
  listBusinessPhoneNumbers,
  addBusinessPhoneNumber,
  updateBusinessPhoneNumber,
  deleteBusinessPhoneNumber
} = require('../config/database');
const {
  getAllBookings,
  updateBookingStatus,
  createBookingRequest,
  getPendingModifications,
  updateModificationStatus
} = require('../services/booking-manager');
const { normalizePhone } = require('../services/caller-lookup');
const { logEventFromReq } = require('../services/audit-log');
const {
  listTeamMembers,
  getTeamMember,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
  sendMessageToTeamMember,
  listTeamMessages,
  markTeamMessageRead
} = require('../services/team-directory');
const eventBus = require('../services/event-bus');
const userMgmt = require('../services/business-user-management');

// Apply auth + tenant hydration to every route in this router.
router.use(requireAuth);
router.use(attachTenantFromAuth);

// A valid tenant context is required for every route in this router.
//
// - Tenant users (business_admin / staff): always have `req.business`
//   hydrated from their JWT's business_id.
// - Super admins: `req.business` is hydrated ONLY if they sent an
//   `X-Business-Id` header (the business-switcher pathway). Without
//   the header the super admin must use `/api/super/*` for cross-tenant
//   work — hitting this router bare is a 403 so a forgotten scope check
//   in a sub-route can't accidentally become a cross-tenant read.
router.use((req, res, next) => {
  if (!req.business || !Number.isInteger(req.business.id)) {
    if (req.auth?.role === SUPER_ADMIN_ROLE) {
      return res.status(400).json({
        error: 'Super admin requests to /api/* must include an X-Business-Id header selecting a tenant.'
      });
    }
    return res.status(403).json({ error: 'Tenant context missing' });
  }
  next();
});

// Convenience getter.
function tenantId(req) {
  return req.business.id;
}

// ============================================
// DASHBOARD
// ============================================

// GET /api/dashboard — Dashboard stats for this tenant only
router.get('/dashboard', async (req, res) => {
  const businessId = tenantId(req);
  try {
    // Compute "today" in the tenant's timezone so "calls today" matches what
    // the staff would see on their clock, not the server's.
    const tz = req.business.timezone || 'America/Toronto';

    const [callsToday, pendingBookings, pendingMods, totalCustomers, recentCalls] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS count
           FROM call_logs
          WHERE business_id = $1
            AND (started_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date`,
        [businessId, tz]
      ),
      query(
        `SELECT COUNT(*)::int AS count FROM booking_requests
          WHERE business_id = $1 AND status = 'pending'`,
        [businessId]
      ),
      query(
        `SELECT COUNT(*)::int AS count FROM modification_requests
          WHERE business_id = $1 AND status = 'pending'`,
        [businessId]
      ),
      query(
        `SELECT COUNT(*)::int AS count FROM customers
          WHERE business_id = $1`,
        [businessId]
      ),
      query(
        `SELECT cl.*, c.name AS customer_name
           FROM call_logs cl
           LEFT JOIN customers c
             ON cl.customer_id = c.id
            AND c.business_id = cl.business_id
          WHERE cl.business_id = $1
          ORDER BY cl.started_at DESC
          LIMIT 10`,
        [businessId]
      )
    ]);

    res.json({
      callsToday: callsToday.rows[0].count,
      pendingBookings: pendingBookings.rows[0].count,
      pendingModifications: pendingMods.rows[0].count,
      totalCustomers: totalCustomers.rows[0].count,
      recentCalls: recentCalls.rows
    });
  } catch (err) {
    console.error(`[tenant:${businessId}] Dashboard error:`, err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ============================================
// SETTINGS
// ============================================

// GET /api/settings — Get all settings for this tenant
router.get('/settings', async (req, res) => {
  const businessId = tenantId(req);
  try {
    // getAllSettings already returns { key: { value, description } }, so we
    // can forward it straight to the client. (An earlier version iterated
    // as if it were an array and silently produced an empty response.)
    const settings = await getAllSettings(businessId);
    res.json(settings);
  } catch (err) {
    console.error(`[tenant:${businessId}] Settings load error:`, err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PUT /api/settings/:key — Update a specific setting for this tenant
router.put('/settings/:key', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { key } = req.params;
    const { value, description } = req.body;
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }
    const result = await updateSetting(businessId, key, value, description);
    // Audit — intentionally log only the KEY, not the full value. Settings
    // can include credentials/PII-adjacent fields (notification targets,
    // SMS numbers, etc.) and we don't want to duplicate them into audit.
    // If you need the value, the `settings` row itself is the source of
    // truth; the audit entry just tells you *who* touched *which key*.
    await logEventFromReq(req, {
      businessId,
      action: 'setting.updated',
      targetType: 'setting',
      targetId: key,
      meta: {
        key,
        description_changed: description !== undefined
      }
    });
    res.json(result);
  } catch (err) {
    console.error(`[tenant:${businessId}] Settings update error:`, err.message);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// ============================================
// PHONE NUMBERS (Phase 5) — tenant-scoped
// ============================================
//
// Business admins manage DIDs for their OWN tenant here. Staff have
// read-only access; only business_admin + super_admin may mutate. The
// routes are a thin wrapper around the same helpers used by /api/super/*,
// but they never take a businessId from the URL — it always comes from
// `req.business.id`, which is the JWT tenant (CLAUDE.md §3.2).

// Minimal E.164 validator. The UI validates too, but the backend must
// defend itself.
const PHONE_E164_RE = /^\+[1-9]\d{7,14}$/;
function isValidPhoneE164(s) {
  return typeof s === 'string' && PHONE_E164_RE.test(s.trim());
}

function requireBusinessAdmin(req, res, next) {
  const role = req.auth?.role;
  if (role === SUPER_ADMIN_ROLE || role === 'business_admin') return next();
  return res.status(403).json({ error: 'Only business admins can modify phone numbers' });
}

// GET /api/phone-numbers — List this tenant's DIDs
router.get('/phone-numbers', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const rows = await listBusinessPhoneNumbers(businessId);
    res.json({ phone_numbers: rows });
  } catch (err) {
    console.error(`[tenant:${businessId}] List phones error:`, err.message);
    res.status(500).json({ error: 'Failed to load phone numbers' });
  }
});

// POST /api/phone-numbers — Add a new DID to this tenant
router.post('/phone-numbers', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const phone = String(req.body?.phone_number || '').trim();
  if (!isValidPhoneE164(phone)) {
    return res.status(400).json({ error: 'phone_number must be E.164 (e.g. +19053334444)' });
  }
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 50) : null;
  const isPrimary = req.body?.is_primary === true;
  const status = req.body?.status === 'inactive' ? 'inactive' : 'active';
  if (isPrimary && status !== 'active') {
    return res.status(400).json({ error: 'Primary numbers must be active' });
  }
  try {
    const row = await addBusinessPhoneNumber(businessId, {
      phone_number: phone, label, is_primary: isPrimary, status
    });
    console.log(`[tenant:${businessId}] Added phone ${phone} (primary=${isPrimary}, status=${status})`);
    await logEventFromReq(req, {
      businessId,
      action: 'phone.added',
      targetType: 'phone_number',
      targetId: row.id,
      meta: {
        phone_number: row.phone_number,
        label: row.label,
        is_primary: row.is_primary,
        status: row.status
      }
    });
    res.status(201).json({ phone_number: row });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That phone number is already registered' });
    }
    console.error(`[tenant:${businessId}] Add phone error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to add phone number' });
  }
});

// PATCH /api/phone-numbers/:phoneId — Update a DID on this tenant
router.patch('/phone-numbers/:phoneId', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const phoneId = parseInt(req.params.phoneId, 10);
  if (!Number.isInteger(phoneId) || phoneId <= 0) {
    return res.status(400).json({ error: 'invalid phone id' });
  }
  const patch = {};
  if (typeof req.body?.phone_number === 'string') {
    const p = req.body.phone_number.trim();
    if (!isValidPhoneE164(p)) {
      return res.status(400).json({ error: 'phone_number must be E.164' });
    }
    patch.phone_number = p;
  }
  if (typeof req.body?.label === 'string') patch.label = req.body.label;
  if (req.body?.status === 'active' || req.body?.status === 'inactive') {
    patch.status = req.body.status;
  }
  if (req.body?.is_primary === true || req.body?.is_primary === false) {
    patch.is_primary = req.body.is_primary;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'no recognised fields to update' });
  }
  try {
    const row = await updateBusinessPhoneNumber(businessId, phoneId, patch);
    if (!row) return res.status(404).json({ error: 'Phone number not found' });
    console.log(`[tenant:${businessId}] Patched phone ${phoneId}: ${Object.keys(patch).join(', ')}`);
    await logEventFromReq(req, {
      businessId,
      action: 'phone.updated',
      targetType: 'phone_number',
      targetId: row.id,
      meta: {
        fields: Object.keys(patch),
        patch,
        phone_number: row.phone_number,
        label: row.label,
        is_primary: row.is_primary,
        status: row.status
      }
    });
    res.json({ phone_number: row });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That phone number is already registered' });
    }
    if (err.code === 'INVALID_STATE') {
      return res.status(400).json({ error: err.message });
    }
    console.error(`[tenant:${businessId}] Patch phone error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to update phone number' });
  }
});

// DELETE /api/phone-numbers/:phoneId — Remove a DID from this tenant
router.delete('/phone-numbers/:phoneId', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const phoneId = parseInt(req.params.phoneId, 10);
  if (!Number.isInteger(phoneId) || phoneId <= 0) {
    return res.status(400).json({ error: 'invalid phone id' });
  }
  try {
    // Snapshot before delete so we can record the number + primary flag
    // in the audit row (tenant-scoped on both id + business_id).
    const snapRes = await query(
      `SELECT id, phone_number, label, is_primary, status
         FROM business_phone_numbers
        WHERE id = $1 AND business_id = $2`,
      [phoneId, businessId]
    );
    const snapshot = snapRes.rows[0] || null;
    const ok = await deleteBusinessPhoneNumber(businessId, phoneId);
    if (!ok) return res.status(404).json({ error: 'Phone number not found' });
    console.log(`[tenant:${businessId}] Deleted phone ${phoneId}`);
    await logEventFromReq(req, {
      businessId,
      action: 'phone.deleted',
      targetType: 'phone_number',
      targetId: phoneId,
      meta: snapshot
        ? {
            phone_number: snapshot.phone_number,
            label: snapshot.label,
            was_primary: snapshot.is_primary,
            status_at_delete: snapshot.status
          }
        : { note: 'row already gone at read-before-delete; delete succeeded' }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[tenant:${businessId}] Delete phone error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to delete phone number' });
  }
});

// ============================================
// BOOKINGS
// ============================================

// GET /api/bookings — List bookings for this tenant
router.get('/bookings', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { page = 1, limit = 50, status } = req.query;
    const result = await getAllBookings(
      businessId,
      parseInt(page),
      parseInt(limit),
      status || null
    );
    res.json(result);
  } catch (err) {
    console.error(`[tenant:${businessId}] Bookings list error:`, err.message);
    res.status(500).json({ error: 'Failed to load bookings' });
  }
});

// POST /api/bookings — Create a booking manually from Command Center
router.post('/bookings', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const {
      customer_name, customer_phone, customer_email,
      requested_date, requested_time,
      party_size, num_carts, special_requests
    } = req.body;
    if (!customer_name || !requested_date || !party_size) {
      return res.status(400).json({ error: 'customer_name, requested_date, and party_size are required' });
    }
    const booking = await createBookingRequest({
      businessId,
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
    console.error(`[tenant:${businessId}] Failed to create booking:`, err.message);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// PUT /api/bookings/:id — Update booking details from Command Center
router.put('/bookings/:id', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { id } = req.params;
    const {
      customer_name, customer_phone, customer_email,
      requested_date, requested_time,
      party_size, num_carts, special_requests, staff_notes
    } = req.body;
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
       WHERE id = $10 AND business_id = $11
       RETURNING *`,
      [
        customer_name || null,
        customer_phone || null,
        customer_email || null,
        requested_date || null,
        requested_time || null,
        party_size ? parseInt(party_size) : null,
        num_carts !== undefined ? parseInt(num_carts) : null,
        special_requests || null,
        staff_notes || null,
        parseInt(id),
        businessId
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[tenant:${businessId}] Failed to update booking:`, err.message);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// PUT /api/bookings/:id/status — Update booking status (fires tenant SMS on change)
router.put('/bookings/:id/status', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { id } = req.params;
    const { status, staff_notes } = req.body;
    if (!['pending', 'confirmed', 'rejected', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const booking = await updateBookingStatus(businessId, parseInt(id), status, staff_notes);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json(booking);
  } catch (err) {
    console.error(`[tenant:${businessId}] Booking status error:`, err.message);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// POST /api/bookings/:id/sms — Send a custom SMS to the customer for this booking
router.post('/bookings/:id/sms', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const result = await query(
      'SELECT * FROM booking_requests WHERE id = $1 AND business_id = $2',
      [parseInt(id), businessId]
    );
    const booking = result.rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.customer_phone) return res.status(400).json({ error: 'No phone number on this booking' });

    const { sendSMS } = require('../services/notification');
    await sendSMS(businessId, booking.customer_phone, message.trim());
    res.json({ ok: true, to: booking.customer_phone });
  } catch (err) {
    console.error(`[tenant:${businessId}] Custom SMS error:`, err.message);
    res.status(500).json({ error: 'Failed to send SMS: ' + err.message });
  }
});

// PUT /api/bookings/:id/no-show — Mark a booking as no-show
router.put('/bookings/:id/no-show', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { id } = req.params;
    const { no_show } = req.body;
    const isNoShow = no_show !== false; // default to true

    // Mark the booking (scoped to this tenant)
    const result = await query(
      `UPDATE booking_requests
          SET no_show = $1
        WHERE id = $2 AND business_id = $3
        RETURNING *`,
      [isNoShow, parseInt(id), businessId]
    );
    const booking = result.rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // Update the tenant's customer row. Customer rows are scoped by
    // (business_id, phone) so this can never bump another tenant's counter.
    if (booking.customer_phone) {
      if (isNoShow) {
        await query(
          `UPDATE customers
              SET no_show_count = COALESCE(no_show_count, 0) + 1
            WHERE business_id = $1 AND phone = $2`,
          [businessId, booking.customer_phone]
        );
      } else {
        await query(
          `UPDATE customers
              SET no_show_count = GREATEST(COALESCE(no_show_count, 0) - 1, 0)
            WHERE business_id = $1 AND phone = $2`,
          [businessId, booking.customer_phone]
        );
      }
    }

    res.json(booking);
  } catch (err) {
    console.error(`[tenant:${businessId}] No-show update failed:`, err.message);
    res.status(500).json({ error: 'Failed to update no-show status' });
  }
});

// POST /api/reminders/send — Manually trigger day-before reminders for this tenant
router.post('/reminders/send', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { sendDayBeforeReminders } = require('../services/scheduled-tasks');
    const result = await sendDayBeforeReminders({ businessId, force: true });
    res.json(result);
  } catch (err) {
    console.error(`[tenant:${businessId}] Reminders error:`, err.message);
    res.status(500).json({ error: 'Failed to send reminders: ' + err.message });
  }
});

// ============================================
// ANALYTICS
// ============================================

// GET /api/analytics — Dashboard analytics data (scoped to this tenant)
router.get('/analytics', async (req, res) => {
  const businessId = tenantId(req);
  const tz = req.business.timezone || 'America/Toronto';
  try {
    // Calls per day (last 14 days in tenant tz)
    const callsPerDay = await query(
      `SELECT (started_at AT TIME ZONE $2)::date AS day,
              COUNT(*)::int AS calls
         FROM call_logs
        WHERE business_id = $1
          AND started_at >= NOW() - INTERVAL '14 days'
        GROUP BY day
        ORDER BY day`,
      [businessId, tz]
    );

    // Busiest hours (all time, tenant tz)
    const busiestHours = await query(
      `SELECT EXTRACT(HOUR FROM started_at AT TIME ZONE $2)::int AS hour,
              COUNT(*)::int AS calls
         FROM call_logs
        WHERE business_id = $1
        GROUP BY hour
        ORDER BY hour`,
      [businessId, tz]
    );

    // Booking conversion (30d, this tenant)
    const totalCalls30d = await query(
      `SELECT COUNT(*)::int AS total FROM call_logs
        WHERE business_id = $1 AND started_at >= NOW() - INTERVAL '30 days'`,
      [businessId]
    );
    const callsWithBooking30d = await query(
      `SELECT COUNT(DISTINCT cl.id)::int AS total
         FROM call_logs cl
         INNER JOIN booking_requests br
           ON br.call_id = cl.id
          AND br.business_id = cl.business_id
        WHERE cl.business_id = $1
          AND cl.started_at >= NOW() - INTERVAL '30 days'`,
      [businessId]
    );

    // Average call duration (30d, this tenant)
    const avgDuration = await query(
      `SELECT ROUND(AVG(duration_seconds))::int AS avg_seconds
         FROM call_logs
        WHERE business_id = $1
          AND duration_seconds > 0
          AND started_at >= NOW() - INTERVAL '30 days'`,
      [businessId]
    );

    // Totals (this tenant)
    const totalBookings = await query(
      `SELECT COUNT(*)::int AS total FROM booking_requests WHERE business_id = $1`,
      [businessId]
    );
    const confirmedBookings = await query(
      `SELECT COUNT(*)::int AS total FROM booking_requests
        WHERE business_id = $1 AND status = 'confirmed'`,
      [businessId]
    );
    const noShows = await query(
      `SELECT COUNT(*)::int AS total FROM booking_requests
        WHERE business_id = $1 AND no_show = TRUE`,
      [businessId]
    );

    res.json({
      callsPerDay: callsPerDay.rows,
      busiestHours: busiestHours.rows,
      totalCalls30d: totalCalls30d.rows[0]?.total || 0,
      callsWithBooking30d: callsWithBooking30d.rows[0]?.total || 0,
      avgDurationSeconds: avgDuration.rows[0]?.avg_seconds || 0,
      totalBookings: totalBookings.rows[0]?.total || 0,
      confirmedBookings: confirmedBookings.rows[0]?.total || 0,
      totalNoShows: noShows.rows[0]?.total || 0
    });
  } catch (err) {
    console.error(`[tenant:${businessId}] Analytics query failed:`, err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ============================================
// MODIFICATIONS
// ============================================

// GET /api/modifications — List pending modification/cancellation requests (tenant)
router.get('/modifications', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const mods = await getPendingModifications(businessId);
    res.json(mods);
  } catch (err) {
    console.error(`[tenant:${businessId}] Modifications list error:`, err.message);
    res.status(500).json({ error: 'Failed to load modifications' });
  }
});

// PUT /api/modifications/:id/status — Process a modification request
router.put('/modifications/:id/status', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { id } = req.params;
    const { status, staff_notes } = req.body;
    if (!['processed', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be processed, rejected, or pending.' });
    }
    const mod = await updateModificationStatus(businessId, parseInt(id), status, staff_notes);
    if (!mod) {
      return res.status(404).json({ error: 'Modification request not found' });
    }
    res.json(mod);
  } catch (err) {
    console.error(`[tenant:${businessId}] Modification status error:`, err.message);
    res.status(500).json({ error: 'Failed to update modification' });
  }
});

// ============================================
// CUSTOMERS
// ============================================

// GET /api/customers — List customers for this tenant
router.get('/customers', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql, params;

    if (search) {
      sql = `SELECT * FROM customers
              WHERE business_id = $1
                AND (LOWER(name) LIKE LOWER($2) OR phone LIKE $2 OR LOWER(email) LIKE LOWER($2))
              ORDER BY last_call_at DESC NULLS LAST
              LIMIT $3 OFFSET $4`;
      params = [businessId, `%${search}%`, parseInt(limit), offset];
    } else {
      sql = `SELECT * FROM customers
              WHERE business_id = $1
              ORDER BY last_call_at DESC NULLS LAST
              LIMIT $2 OFFSET $3`;
      params = [businessId, parseInt(limit), offset];
    }

    const result = await query(sql, params);

    let countSql, countParams;
    if (search) {
      countSql = `SELECT COUNT(*)::int AS count FROM customers
                   WHERE business_id = $1
                     AND (LOWER(name) LIKE LOWER($2) OR phone LIKE $2 OR LOWER(email) LIKE LOWER($2))`;
      countParams = [businessId, `%${search}%`];
    } else {
      countSql = `SELECT COUNT(*)::int AS count FROM customers WHERE business_id = $1`;
      countParams = [businessId];
    }
    const countResult = await query(countSql, countParams);

    res.json({
      customers: result.rows,
      total: countResult.rows[0].count,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error(`[tenant:${businessId}] Customers list error:`, err.message);
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// POST /api/customers — Manually add a new contact for this tenant
router.post('/customers', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { name, phone, email, notes } = req.body;
    if (!name && !phone) return res.status(400).json({ error: 'Name or phone required' });
    const normalized = phone ? normalizePhone(phone) : null;

    // Dedupe within this tenant only — another tenant's customer with the
    // same phone must remain independent.
    if (normalized) {
      const existing = await query(
        'SELECT * FROM customers WHERE business_id = $1 AND phone = $2',
        [businessId, normalized]
      );
      if (existing.rows.length > 0) {
        const updated = await query(
          `UPDATE customers
              SET name = COALESCE($1, name),
                  email = COALESCE($2, email),
                  notes = COALESCE($3, notes)
            WHERE business_id = $4 AND phone = $5
            RETURNING *`,
          [name || null, email || null, notes || null, businessId, normalized]
        );
        return res.json(updated.rows[0]);
      }
    }

    const result = await query(
      `INSERT INTO customers
         (business_id, name, phone, email, notes, call_count, first_call_at, last_call_at)
       VALUES ($1, $2, $3, $4, $5, 0, NOW(), NOW())
       RETURNING *`,
      [businessId, name || null, normalized, email || null, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[tenant:${businessId}] Failed to create customer:`, err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// GET /api/customers/:id — Single customer with history (tenant-scoped)
router.get('/customers/:id', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { id } = req.params;
    const [customer, bookings, calls] = await Promise.all([
      query(
        'SELECT * FROM customers WHERE id = $1 AND business_id = $2',
        [id, businessId]
      ),
      query(
        `SELECT * FROM booking_requests
          WHERE customer_id = $1 AND business_id = $2
          ORDER BY created_at DESC LIMIT 20`,
        [id, businessId]
      ),
      query(
        `SELECT * FROM call_logs
          WHERE customer_id = $1 AND business_id = $2
          ORDER BY started_at DESC LIMIT 20`,
        [id, businessId]
      )
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
    console.error(`[tenant:${businessId}] Customer load error:`, err.message);
    res.status(500).json({ error: 'Failed to load customer' });
  }
});

// PUT /api/customers/:id — Update customer info (tenant-scoped)
router.put('/customers/:id', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { id } = req.params;
    const {
      name, email, phone, notes,
      custom_greeting, custom_greetings, customer_knowledge
    } = req.body;
    const fields = [];
    const values = [];
    let p = 1;

    if (name !== undefined) { fields.push(`name = $${p++}`); values.push(name); }
    if (email !== undefined) { fields.push(`email = $${p++}`); values.push(email); }
    if (phone !== undefined) { fields.push(`phone = $${p++}`); values.push(phone ? normalizePhone(phone) : null); }
    if (notes !== undefined) { fields.push(`notes = $${p++}`); values.push(notes); }
    if (custom_greeting !== undefined) { fields.push(`custom_greeting = $${p++}`); values.push(custom_greeting || null); }
    if (custom_greetings !== undefined) {
      fields.push(`custom_greetings = $${p++}`);
      values.push(JSON.stringify(custom_greetings || []));
    }
    if (customer_knowledge !== undefined) {
      fields.push(`customer_knowledge = $${p++}`);
      values.push(customer_knowledge || null);
    }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(id, businessId);
    const result = await query(
      `UPDATE customers SET ${fields.join(', ')}
        WHERE id = $${p++} AND business_id = $${p}
        RETURNING *`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[tenant:${businessId}] Customer update error:`, err.message);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// ============================================
// CALL LOGS
// ============================================

// GET /api/calls — List call logs (tenant-scoped)
router.get('/calls', async (req, res) => {
  const businessId = tenantId(req);
  const tz = req.business.timezone || 'America/Toronto';
  try {
    const { page = 1, limit = 50, date } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql, params;

    if (date) {
      sql = `SELECT cl.*, c.name AS customer_name
               FROM call_logs cl
               LEFT JOIN customers c
                 ON cl.customer_id = c.id
                AND c.business_id = cl.business_id
              WHERE cl.business_id = $1
                AND (cl.started_at AT TIME ZONE $2)::date = $3
              ORDER BY cl.started_at DESC
              LIMIT $4 OFFSET $5`;
      params = [businessId, tz, date, parseInt(limit), offset];
    } else {
      sql = `SELECT cl.*, c.name AS customer_name
               FROM call_logs cl
               LEFT JOIN customers c
                 ON cl.customer_id = c.id
                AND c.business_id = cl.business_id
              WHERE cl.business_id = $1
              ORDER BY cl.started_at DESC
              LIMIT $2 OFFSET $3`;
      params = [businessId, parseInt(limit), offset];
    }

    const result = await query(sql, params);
    res.json({ calls: result.rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(`[tenant:${businessId}] Calls list error:`, err.message);
    res.status(500).json({ error: 'Failed to load call logs' });
  }
});

// GET /api/calls/:id — Single call log with transcript (tenant-scoped)
router.get('/calls/:id', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const result = await query(
      `SELECT cl.*, c.name AS customer_name
         FROM call_logs cl
         LEFT JOIN customers c
           ON cl.customer_id = c.id
          AND c.business_id = cl.business_id
        WHERE cl.id = $1 AND cl.business_id = $2`,
      [req.params.id, businessId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call log not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[tenant:${businessId}] Call log load error:`, err.message);
    res.status(500).json({ error: 'Failed to load call log' });
  }
});

// ============================================
// GREETINGS
// ============================================

// GET /api/greetings — List greetings for this tenant
router.get('/greetings', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const result = await query(
      `SELECT * FROM greetings
        WHERE business_id = $1
        ORDER BY for_known_caller, id`,
      [businessId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(`[tenant:${businessId}] Greetings list error:`, err.message);
    res.status(500).json({ error: 'Failed to load greetings' });
  }
});

// POST /api/greetings — Add a new greeting for this tenant
router.post('/greetings', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { message, for_known_caller = false } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const result = await query(
      `INSERT INTO greetings (business_id, message, for_known_caller, active)
       VALUES ($1, $2, $3, true)
       RETURNING *`,
      [businessId, message, for_known_caller]
    );
    const row = result.rows[0];
    await logEventFromReq(req, {
      businessId,
      action: 'greeting.created',
      targetType: 'greeting',
      targetId: row.id,
      meta: {
        for_known_caller: row.for_known_caller,
        // Clip the stored message — audit is not the place for large
        // copy-blocks, and the row itself is the source of truth.
        message_preview: String(row.message || '').slice(0, 120)
      }
    });
    res.json(row);
  } catch (err) {
    console.error(`[tenant:${businessId}] Create greeting error:`, err.message);
    res.status(500).json({ error: 'Failed to create greeting' });
  }
});

// PUT /api/greetings/:id — Update a greeting for this tenant
router.put('/greetings/:id', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { message, active } = req.body;
    const fields = [];
    const values = [];
    let p = 1;
    if (message !== undefined) { fields.push(`message = $${p++}`); values.push(message); }
    if (active !== undefined) { fields.push(`active = $${p++}`); values.push(active); }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id, businessId);
    const result = await query(
      `UPDATE greetings SET ${fields.join(', ')}
        WHERE id = $${p++} AND business_id = $${p}
        RETURNING *`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Greeting not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[tenant:${businessId}] Update greeting error:`, err.message);
    res.status(500).json({ error: 'Failed to update greeting' });
  }
});

// DELETE /api/greetings/:id — Remove a greeting (tenant-scoped)
router.delete('/greetings/:id', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const result = await query(
      'DELETE FROM greetings WHERE id = $1 AND business_id = $2 RETURNING id, for_known_caller',
      [req.params.id, businessId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Greeting not found' });
    await logEventFromReq(req, {
      businessId,
      action: 'greeting.deleted',
      targetType: 'greeting',
      targetId: result.rows[0].id,
      meta: { for_known_caller: result.rows[0].for_known_caller }
    });
    res.json({ success: true });
  } catch (err) {
    console.error(`[tenant:${businessId}] Delete greeting error:`, err.message);
    res.status(500).json({ error: 'Failed to delete greeting' });
  }
});

// ============================================
// TEAM DIRECTORY (per-tenant message routing)
// ============================================
//
// CRUD for the team members the AI can leave a message for. Every route
// is tenant-scoped via attachTenantFromAuth. POST/PATCH/DELETE require
// business_admin (same gate as phone-numbers — these rows control SMS
// destinations and shouldn't be editable by every staff user).

// GET /api/team — list members (always returns inactive too so the UI
// can offer a "re-enable" toggle).
router.get('/team', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const members = await listTeamMembers(businessId, { includeInactive: true });
    res.json(members);
  } catch (err) {
    console.error(`[tenant:${businessId}] Team list error:`, err.message);
    res.status(500).json({ error: 'Failed to load team directory' });
  }
});

// POST /api/team — create
router.post('/team', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  try {
    const member = await createTeamMember(businessId, req.body || {});
    await logEventFromReq(req, {
      businessId,
      action: 'team_member.created',
      targetType: 'team_member',
      targetId: member.id,
      meta: { name: member.name, role: member.role, sms_phone: member.sms_phone }
    }).catch(() => {});
    res.status(201).json(member);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `A team member named "${req.body?.name}" already exists.` });
    }
    if (/required|valid phone|channel|empty|provide/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error(`[tenant:${businessId}] Team create error:`, err.message);
    // Surface the underlying message so the operator can act on it
    // (e.g. CHECK constraint violations from the DB show up clearly
    // instead of being swallowed as a generic 500).
    res.status(500).json({ error: err.message || 'Failed to create team member' });
  }
});

// PATCH /api/team/:id — update
router.patch('/team/:id', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  try {
    const member = await updateTeamMember(businessId, id, req.body || {});
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    await logEventFromReq(req, {
      businessId,
      action: 'team_member.updated',
      targetType: 'team_member',
      targetId: member.id,
      meta: { fields: Object.keys(req.body || {}) }
    }).catch(() => {});
    res.json(member);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `A team member with that name already exists.` });
    }
    if (/empty|valid phone/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error(`[tenant:${businessId}] Team update error:`, err.message);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

// DELETE /api/team/:id — hard delete (history lives in audit_log).
router.delete('/team/:id', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  try {
    const existing = await getTeamMember(businessId, id);
    if (!existing) return res.status(404).json({ error: 'Team member not found' });
    await deleteTeamMember(businessId, id);
    await logEventFromReq(req, {
      businessId,
      action: 'team_member.deleted',
      targetType: 'team_member',
      targetId: id,
      meta: { name: existing.name, role: existing.role, sms_phone: existing.sms_phone }
    }).catch(() => {});
    res.json({ deleted: true, id });
  } catch (err) {
    console.error(`[tenant:${businessId}] Team delete error:`, err.message);
    res.status(500).json({ error: 'Failed to delete team member' });
  }
});

// ============================================
// TEAM MESSAGES — persisted history of messages the AI took on behalf
// of team members. Drives the "Messages" page in Command Center for
// the Business template (and is also visible on personal_assistant
// tenants since the data model is shared).
// ============================================

// GET /api/messages — recent messages, newest first.
// Optional ?status= filter (pending|sent|partial|failed|read|dashboard_only)
// and ?limit= (default 100, max 500).
router.get('/messages', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const messages = await listTeamMessages(businessId, { limit, status });
    res.json(messages);
  } catch (err) {
    console.error(`[tenant:${businessId}] Messages list error:`, err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// PATCH /api/messages/:id/read — mark a single message as read.
// Idempotent — re-reading is a no-op.
router.patch('/messages/:id/read', async (req, res) => {
  const businessId = tenantId(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  try {
    const row = await markTeamMessageRead(businessId, id);
    if (!row) return res.status(404).json({ error: 'Message not found' });
    res.json(row);
  } catch (err) {
    console.error(`[tenant:${businessId}] Mark-read error:`, err.message);
    res.status(500).json({ error: 'Failed to mark message read' });
  }
});

// ============================================
// LIVE EVENTS — Server-Sent Events stream
// ============================================
//
// One persistent HTTP connection per tab. Server pushes booking-related
// events as they happen so the dashboard / tee sheet / bookings list
// can refetch without polling.
//
// Auth: piggybacks on requireAuth above (Bearer header OR ?token= query
// — EventSource can't set custom headers in browsers). Tenant scope is
// enforced via attachTenantFromAuth, so each connection only receives
// its own tenant's events.
//
// Event format (standard SSE):
//   event: booking.created
//   data: {"id":42,"customer_name":"Bob",...}
//
// The browser EventSource auto-reconnects on drop. Server-side: if the
// client disconnects, we run the unsubscribe returned by event-bus so
// we don't leak handlers. Heartbeat comments every 25s keep proxies
// (Railway, Cloudflare, etc.) from idling out the connection.
router.get('/events', (req, res) => {
  const businessId = tenantId(req);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
  res.flushHeaders?.();

  // Friendly hello so the client knows the stream is live.
  res.write(`event: ready\ndata: {"businessId":${businessId},"ts":${Date.now()}}\n\n`);

  const send = (event) => {
    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
    } catch (err) {
      // Connection probably gone; teardown will follow.
      console.warn(`[tenant:${businessId}] SSE write failed:`, err.message);
    }
  };

  const unsubscribe = eventBus.subscribe(businessId, send);

  // Heartbeat — SSE comment lines (": ...") are ignored by the client
  // but keep the TCP connection warm against idle timeouts.
  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch (_) { /* will tear down */ }
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    try { unsubscribe(); } catch (_) { /* noop */ }
    try { res.end(); } catch (_) { /* noop */ }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

// POST /api/team/:id/test-sms — fire a test SMS to verify the phone number.
// Useful so the operator can confirm "I get pinged at the right number"
// before relying on the AI to fire it on a real call. Body is optional.
router.post('/team/:id/test-sms', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  try {
    const result = await sendMessageToTeamMember(businessId, id, {
      callerName: 'Test',
      callerPhone: req.business?.twilio_phone_number || null,
      message: req.body?.message || 'This is a test of your team-message SMS routing. If you got this, you’ll hear from the AI when a caller leaves you a real message.',
      businessName: req.business?.name
    });
    await logEventFromReq(req, {
      businessId,
      action: 'team_member.test_sms',
      targetType: 'team_member',
      targetId: id,
      meta: { delivered: result.delivered, message_sid: result.message_sid }
    }).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[tenant:${businessId}] Team test-sms error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to send test SMS' });
  }
});

// ============================================
// TENANT USER MANAGEMENT — business_admin self-service
// ============================================
//
// Same surface as the super-admin user-management endpoints, but scoped
// to req.business.id (the caller's own tenant). Gated by
// requireBusinessAdmin so a `staff` role can't add/remove users.
//
// All logic lives in services/business-user-management.js — both this
// router and the super-admin router call into the same helpers, so a
// fix or audit-log shape change shows up in both places automatically.

function mapUserMgmtError(err, res) {
  if (err && err.code === 'INVALID')   return res.status(400).json({ error: err.message });
  if (err && err.code === 'CONFLICT')  return res.status(409).json({ error: err.message });
  if (err && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
  console.error('[tenant] user mgmt error:', err?.message);
  return res.status(500).json({ error: err?.message || 'User management failed' });
}

// GET /api/users — list users on THIS tenant.
router.get('/users', async (req, res) => {
  const businessId = tenantId(req);
  try {
    const users = await userMgmt.listUsers(businessId);
    res.json({ business_id: businessId, users });
  } catch (err) {
    mapUserMgmtError(err, res);
  }
});

// POST /api/users — create a user on THIS tenant. Returns plaintext
// password + signin_url ONCE in the response.
router.post('/users', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  try {
    const { user, plaintext, generated } = await userMgmt.createUser(businessId, req.body || {});
    await logEventFromReq(req, {
      businessId,
      action: 'user.created_by_admin',
      targetType: 'business_user',
      targetId: user.id,
      meta: {
        target_email: user.email,
        target_role: user.role,
        method: generated ? 'auto_generated' : 'operator_supplied',
        actor_user_id: req.auth?.user_id || null
      }
    }).catch(() => {});
    const signinUrl = userMgmt.buildSigninUrl(req, user.email);
    res.status(201).json({
      ok: true,
      user,
      password: plaintext,
      generated,
      signin_url: signinUrl,
      note: 'This password is shown once. Save or share it now — we cannot retrieve it later.'
    });
  } catch (err) {
    mapUserMgmtError(err, res);
  }
});

// PATCH /api/users/:userId — toggle is_active.
router.patch('/users/:userId', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'invalid user id' });
  }
  if (typeof req.body?.is_active !== 'boolean') {
    return res.status(400).json({ error: 'Body must include { is_active: boolean }' });
  }
  try {
    const user = await userMgmt.setActive(businessId, userId, req.body.is_active);
    await logEventFromReq(req, {
      businessId,
      action: 'user.activation_changed',
      targetType: 'business_user',
      targetId: userId,
      meta: { target_email: user.email, is_active: user.is_active }
    }).catch(() => {});
    res.json({ user });
  } catch (err) {
    mapUserMgmtError(err, res);
  }
});

// DELETE /api/users/:userId — hard-delete with last-admin guard. The
// guard is critical here because a confused business_admin could
// otherwise lock themselves (and their team) out by deleting their own
// row. The service refuses if they're the last active admin.
router.delete('/users/:userId', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'invalid user id' });
  }
  // Belt-and-braces: don't let an admin delete THEIR OWN row even if
  // there's another admin around. Forces them to ask another admin to
  // do it, which is the safer "lock-out-prevention via human in the
  // loop" pattern.
  if (Number(req.auth?.user_id) === userId) {
    return res.status(409).json({
      error: 'You cannot remove your own account. Ask another admin on this tenant, or use Disable instead.'
    });
  }
  try {
    const user = await userMgmt.deleteUser(businessId, userId);
    await logEventFromReq(req, {
      businessId,
      action: 'user.deleted_by_admin',
      targetType: 'business_user',
      targetId: userId,
      meta: {
        target_email: user.email,
        target_role: user.role,
        was_active: user.is_active,
        actor_user_id: req.auth?.user_id || null
      }
    }).catch(() => {});
    res.json({ ok: true, deleted: true, id: userId });
  } catch (err) {
    mapUserMgmtError(err, res);
  }
});

// POST /api/users/:userId/reset-password — same one-time-reveal contract
// as the super-admin endpoint.
router.post('/users/:userId/reset-password', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'invalid user id' });
  }
  try {
    const { user, plaintext, generated } = await userMgmt.resetPassword(businessId, userId, req.body || {});
    await logEventFromReq(req, {
      businessId,
      action: 'user.password_reset_by_admin',
      targetType: 'business_user',
      targetId: userId,
      meta: {
        target_email: user.email,
        target_role: user.role,
        method: generated ? 'auto_generated' : 'operator_supplied',
        actor_user_id: req.auth?.user_id || null
      }
    }).catch(() => {});
    res.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, is_active: user.is_active },
      password: plaintext,
      generated,
      note: 'This password is shown once. Save or share it now — we cannot retrieve it later.'
    });
  } catch (err) {
    mapUserMgmtError(err, res);
  }
});

// POST /api/users/:userId/send-credentials-sms — texts the new
// credentials FROM the tenant's primary Twilio number.
router.post('/users/:userId/send-credentials-sms', requireBusinessAdmin, async (req, res) => {
  const businessId = tenantId(req);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'invalid user id' });
  }
  try {
    const { user, to, message_sid, from } = await userMgmt.dispatchCredentialsSms(businessId, userId, {
      to: req.body?.to,
      password: req.body?.password,
      signinUrl: req.body?.signin_url
    });
    await logEventFromReq(req, {
      businessId,
      action: 'user.credentials_sms_sent',
      targetType: 'business_user',
      targetId: userId,
      meta: {
        target_email: user.email,
        target_phone: to,
        message_sid,
        actor_user_id: req.auth?.user_id || null
      }
    }).catch(() => {});
    res.json({ ok: true, message_sid, to, from });
  } catch (err) {
    mapUserMgmtError(err, res);
  }
});

module.exports = router;
