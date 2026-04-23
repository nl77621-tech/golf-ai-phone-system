/**
 * Caller Lookup Service — tenant-scoped.
 *
 * Every function takes `businessId` as its first argument. A null or missing
 * business_id throws via `requireBusinessId` rather than silently returning
 * every tenant's customers.
 */
const { query } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');

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

module.exports = { lookupByPhone, lookupByName, registerCall, updateCustomer, normalizePhone };
