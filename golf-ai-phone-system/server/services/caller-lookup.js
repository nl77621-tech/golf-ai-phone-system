/**
 * Caller Lookup Service — tenant-scoped.
 *
 * Every function takes `businessId` as its first argument. A null or missing
 * business_id throws via `requireBusinessId` rather than silently returning
 * every tenant's customers.
 */
const { query } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');
const bcrypt = require('bcryptjs');

// Bcrypt cost for PIN hashes. The same value the regular auth path uses
// (server/middleware/auth.js BCRYPT_ROUNDS=10). 4-digit PINs are
// inherently low-entropy; the hash protects them from passive disclosure
// if the DB ever leaks, but rate-limiting the verify path matters more
// (handled in grok-voice via callState).
const ADMIN_PIN_BCRYPT_ROUNDS = 10;

// Look up a customer by phone number (scoped to one business)
async function lookupByPhone(businessId, phone) {
  requireBusinessId(businessId, 'lookupByPhone');
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const res = await query(
    'SELECT * FROM customers WHERE business_id = $1 AND phone = $2',
    [businessId, normalized]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

// Look up a customer by name (partial match), scoped to one business
async function lookupByName(businessId, name) {
  requireBusinessId(businessId, 'lookupByName');
  const res = await query(
    `SELECT * FROM customers
      WHERE business_id = $1 AND LOWER(name) LIKE LOWER($2)
      ORDER BY last_call_at DESC
      LIMIT 5`,
    [businessId, `%${name}%`]
  );
  return res.rows;
}

/**
 * Create or update a customer record when they call.
 * Uses INSERT ... ON CONFLICT (business_id, phone) to avoid race conditions
 * with concurrent inbound calls.
 */
async function registerCall(businessId, phone, name = null, email = null) {
  requireBusinessId(businessId, 'registerCall');
  const normalized = normalizePhone(phone);
  if (!normalized) {
    // No valid phone — can't register, return null customer
    return { customer: null, isNew: false };
  }

  const res = await query(
    `INSERT INTO customers (business_id, phone, name, email, call_count, first_call_at, last_call_at)
     VALUES ($1, $2, $3, $4, 1, NOW(), NOW())
     ON CONFLICT (business_id, phone) DO UPDATE SET
       name = COALESCE(NULLIF($3, ''), customers.name),
       email = COALESCE(NULLIF($4, ''), customers.email),
       call_count = customers.call_count + 1,
       last_call_at = NOW()
     RETURNING *, (xmax = 0) AS is_new`,
    [businessId, normalized, name, email]
  );

  const row = res.rows[0];
  const isNew = row.is_new;
  delete row.is_new;
  return { customer: row, isNew };
}

/**
 * Update customer info (from AI collecting details).
 * businessId is required so a forged id cannot mutate another tenant's customer.
 */
async function updateCustomer(businessId, id, updates) {
  requireBusinessId(businessId, 'updateCustomer');
  const fields = [];
  const values = [];
  let paramCount = 1;

  if (updates.name) {
    fields.push(`name = $${paramCount++}`);
    values.push(updates.name);
  }
  if (updates.email) {
    fields.push(`email = $${paramCount++}`);
    values.push(updates.email);
  }
  if (updates.phone) {
    fields.push(`phone = $${paramCount++}`);
    values.push(normalizePhone(updates.phone));
  }
  if (updates.notes) {
    fields.push(`notes = $${paramCount++}`);
    values.push(updates.notes);
  }

  if (fields.length === 0) return null;

  values.push(businessId, id);
  const res = await query(
    `UPDATE customers SET ${fields.join(', ')}
      WHERE business_id = $${paramCount++} AND id = $${paramCount}
      RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

// Normalize phone number to +1XXXXXXXXXX format (tenant-agnostic helper)
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

// ─── Business admin (admin call-in line) ──────────────────────────────────
//
// When a call comes in from a phone number listed in business_admins
// for this tenant, the AI greets by name and asks for a PIN before
// allowing any state-change operations (add/list/remove announcements,
// etc.). Customer-mode tools (book_tee_time, check_tee_times, …) stay
// available — admins can call to make a normal booking too — but
// admin-mode tools are gated on PIN.
//
// Per CLAUDE.md §3.1, every function here is scoped by business_id.

/**
 * Look up an active admin record for a (business, phone) pair.
 * Returns null when the caller is NOT an admin for this business,
 * so the caller flow can fall through to normal customer mode.
 *
 * The pin_hash is NEVER returned to the caller. Use verifyAdminPin()
 * to check a PIN attempt — the hash stays inside this module.
 */
async function lookupAdminByPhone(businessId, phone) {
  requireBusinessId(businessId, 'lookupAdminByPhone');
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const res = await query(
    `SELECT id, business_id, phone_number, name, is_active, last_used_at, created_at
       FROM business_admins
      WHERE business_id = $1 AND phone_number = $2 AND is_active = TRUE
      LIMIT 1`,
    [businessId, normalized]
  );
  return res.rows[0] || null;
}

/**
 * Verify a PIN attempt against an admin row. Returns boolean.
 * Throws if adminId or pin is missing/invalid type.
 *
 * The caller is responsible for rate-limiting attempts — typically by
 * tracking failedPinAttempts on per-call state in grok-voice and
 * refusing further attempts after N misses.
 */
async function verifyAdminPin(adminId, pin) {
  if (!adminId || pin === undefined || pin === null) return false;
  const pinStr = String(pin).trim();
  if (!pinStr) return false;
  const res = await query(
    'SELECT pin_hash FROM business_admins WHERE id = $1 AND is_active = TRUE LIMIT 1',
    [adminId]
  );
  if (!res.rows[0]) return false;
  return bcrypt.compare(pinStr, res.rows[0].pin_hash);
}

/**
 * Stamp last_used_at on the admin row after a successful PIN.
 * Best-effort — failure here is logged but doesn't block the call.
 */
async function markAdminPinSuccess(adminId) {
  if (!adminId) return;
  try {
    await query(
      'UPDATE business_admins SET last_used_at = NOW() WHERE id = $1',
      [adminId]
    );
  } catch (err) {
    console.warn(`[caller-lookup] markAdminPinSuccess failed for admin ${adminId}:`, err.message);
  }
}

/**
 * Hash a plaintext PIN for storage. Used by the API route that
 * creates/updates admin rows. Never store plaintext.
 */
async function hashAdminPin(pin) {
  const pinStr = String(pin || '').trim();
  if (pinStr.length < 4 || pinStr.length > 12) {
    throw new Error('PIN must be 4–12 characters');
  }
  return bcrypt.hash(pinStr, ADMIN_PIN_BCRYPT_ROUNDS);
}

// ─── Business announcements (admin-set ops notes) ──────────────────────────
//
// Active rows get injected into the customer-facing system prompt so the
// AI can apply them to all subsequent calls. 'today' rows auto-expire
// via expires_at; 'persistent' rows live until staff or an admin
// deactivates them.

/**
 * Fetch active announcements for a business.
 *   - is_active = TRUE
 *   - expires_at IS NULL OR expires_at > NOW()
 *
 * Ordered newest first so the most recent guidance lands at the top of
 * the system prompt.
 */
async function getActiveAnnouncements(businessId) {
  requireBusinessId(businessId, 'getActiveAnnouncements');
  const res = await query(
    `SELECT id, business_id, instruction_text, scope, expires_at, created_at,
            created_by_admin_id, created_by_phone
       FROM business_announcements
      WHERE business_id = $1
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC`,
    [businessId]
  );
  return res.rows;
}

/**
 * Create a new announcement. The caller (API route or admin tool
 * handler) is responsible for choosing the expires_at — typically
 * end-of-local-day for scope='today' or NULL for 'persistent'.
 */
async function createAnnouncement({ businessId, instructionText, scope, expiresAt, adminId, adminPhone }) {
  requireBusinessId(businessId, 'createAnnouncement');
  if (!instructionText || !String(instructionText).trim()) {
    throw new Error('instructionText is required');
  }
  if (!['today', 'persistent'].includes(scope)) {
    throw new Error("scope must be 'today' or 'persistent'");
  }
  const res = await query(
    `INSERT INTO business_announcements
       (business_id, instruction_text, scope, expires_at, created_by_admin_id, created_by_phone)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, business_id, instruction_text, scope, expires_at, created_at,
               created_by_admin_id, created_by_phone, is_active`,
    [businessId, String(instructionText).trim(), scope, expiresAt || null, adminId || null, adminPhone || null]
  );
  return res.rows[0];
}

/**
 * Soft-delete an announcement. Sets is_active=false and stamps
 * deactivated_at + deactivated_by for the audit trail. Returns the
 * deactivated row (or null if it didn't exist / belonged to a
 * different business).
 */
async function deactivateAnnouncement(businessId, id, deactivatedBy) {
  requireBusinessId(businessId, 'deactivateAnnouncement');
  const res = await query(
    `UPDATE business_announcements
        SET is_active = FALSE,
            deactivated_at = NOW(),
            deactivated_by = $1
      WHERE id = $2
        AND business_id = $3
        AND is_active = TRUE
      RETURNING *`,
    [String(deactivatedBy || 'system').slice(0, 100), id, businessId]
  );
  return res.rows[0] || null;
}

module.exports = {
  lookupByPhone, lookupByName, registerCall, updateCustomer, normalizePhone,
  // Admin-line:
  lookupAdminByPhone, verifyAdminPin, markAdminPinSuccess, hashAdminPin,
  // Announcements:
  getActiveAnnouncements, createAnnouncement, deactivateAnnouncement,
};
