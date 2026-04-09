/**
 * Caller Lookup Service
 * Identifies callers by phone number and manages customer records
 */
const { query } = require('../config/database');

// Look up a customer by phone number
async function lookupByPhone(phone) {
  const normalized = normalizePhone(phone);
  const res = await query(
    'SELECT * FROM customers WHERE phone = $1',
    [normalized]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

// Look up a customer by name (partial match)
async function lookupByName(name) {
  const res = await query(
    'SELECT * FROM customers WHERE LOWER(name) LIKE LOWER($1) ORDER BY last_call_at DESC LIMIT 5',
    [`%${name}%`]
  );
  return res.rows;
}

// Create or update a customer record when they call
async function registerCall(phone, name = null, email = null) {
  const normalized = normalizePhone(phone);
  const existing = await lookupByPhone(normalized);

  if (existing) {
    // Update existing customer
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name && name !== existing.name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (email && email !== existing.email) {
      updates.push(`email = $${paramCount++}`);
      values.push(email);
    }

    updates.push(`call_count = call_count + 1`);
    updates.push(`last_call_at = NOW()`);

    values.push(normalized);
    const res = await query(
      `UPDATE customers SET ${updates.join(', ')} WHERE phone = $${paramCount} RETURNING *`,
      values
    );
    return { customer: res.rows[0], isNew: false };
  } else {
    // Create new customer
    const res = await query(
      `INSERT INTO customers (phone, name, email, call_count, first_call_at, last_call_at)
       VALUES ($1, $2, $3, 1, NOW(), NOW()) RETURNING *`,
      [normalized, name, email]
    );
    return { customer: res.rows[0], isNew: true };
  }
}

// Update customer info (from AI collecting details)
async function updateCustomer(id, updates) {
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

  values.push(id);
  const res = await query(
    `UPDATE customers SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
    values
  );
  return res.rows[0];
}

// Normalize phone number to +1XXXXXXXXXX format
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

module.exports = { lookupByPhone, lookupByName, registerCall, updateCustomer, normalizePhone };
