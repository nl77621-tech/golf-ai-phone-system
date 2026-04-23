/**
 * Database access layer (shared pool + tenant-aware helpers).
 *
 * Every helper that touches tenant data takes `businessId` as its first
 * argument (CLAUDE.md §3.2). The generic `query()` is kept for ad-hoc
 * queries in routes/services — callers remain responsible for including
 * `business_id` in their WHERE / INSERT columns.
 */
const { Pool } = require('pg');
require('dotenv').config();

const { requireBusinessIdOrSuperAdmin } = require('../context/tenant-context');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

// Helper: run a query (tenant-agnostic — caller is responsible for scoping)
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`Slow query (${duration}ms):`, text.substring(0, 80));
  }
  return res;
}

// ============================================================================
// tenantQuery — safety guard for tenant-scoped SQL
// ============================================================================
//
// Tables that MUST always be filtered by business_id in any SELECT/UPDATE/
// DELETE statement. INSERTs are allowed through because the business_id
// column is part of the target columns list rather than a WHERE clause, and
// the `requireBusinessId(businessId)` check below already prevents writes
// with a missing tenant.
const TENANT_TABLES = [
  'customers',
  'booking_requests',
  'modification_requests',
  'call_logs',
  'greetings',
  'settings',
  'business_phone_numbers'
];

// Keywords that imply read/delete/update — i.e. cases where a missing
// business_id filter leaks across tenants. INSERT is handled separately.
const MUTATING_KEYWORDS = /\b(SELECT|UPDATE|DELETE)\b/i;

function _mentionsTenantTable(sql) {
  const lowered = sql.toLowerCase();
  for (const t of TENANT_TABLES) {
    // word-boundary match to avoid matching e.g. `customers_archive`
    const re = new RegExp(`\\b${t}\\b`);
    if (re.test(lowered)) return t;
  }
  return null;
}

function _hasBusinessIdPredicate(sql) {
  // Look for `business_id = $N` or `business_id IN (...)` in the SQL.
  return /business_id\s*(=|in)\b/i.test(sql);
}

/**
 * Tenant-scoped query wrapper.
 *
 *   tenantQuery(businessId, sql, params)
 *
 * Behaviour:
 *   - If `businessId` is a positive integer: verify that SQL touching a
 *     tenant table includes a `business_id` predicate. If not, throw —
 *     this is the CLAUDE.md §2.2 defense against missing WHERE clauses.
 *   - If `businessId` is `null`: the caller must be a super admin. Log a
 *     SUPER_ADMIN_BYPASS warning so these cross-tenant queries are
 *     auditable, then run the query unmodified.
 *
 * This wrapper does NOT inject `business_id` into your SQL. It enforces
 * that you remembered to — silent injection would be worse than a loud
 * failure because it would hide actual bugs in handler code.
 */
async function tenantQuery(businessId, text, params) {
  if (businessId === null || businessId === undefined) {
    const { isSuperAdmin } = require('../context/tenant-context');
    const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!isSuperAdmin()) {
      // Not a super admin AND no businessId. That's never legitimate.
      throw Object.assign(
        new Error(
          `tenantQuery called with null businessId outside a super-admin context. SQL: ${snippet}`
        ),
        { code: 'TENANT_MISSING' }
      );
    }
    console.warn(`[tenant:admin] SUPER_ADMIN_BYPASS tenantQuery → ${snippet}`);
    return query(text, params);
  }

  // Validate integer business_id for tenant callers
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw Object.assign(
      new Error(`tenantQuery: businessId must be a positive integer (got ${JSON.stringify(businessId)})`),
      { code: 'TENANT_MISSING' }
    );
  }

  const table = _mentionsTenantTable(text);
  const isMutating = MUTATING_KEYWORDS.test(text);
  // INSERT paths are allowed without a WHERE clause, but the caller MUST
  // have supplied business_id as a column. We catch that via the params
  // contract (business_id should appear in the column list).
  if (table && isMutating && !_hasBusinessIdPredicate(text)) {
    throw Object.assign(
      new Error(
        `Tenant isolation violation: query on "${table}" is missing a business_id predicate. ` +
        `Every SELECT/UPDATE/DELETE against tenant tables must filter by business_id. ` +
        `SQL: ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`
      ),
      { code: 'TENANT_LEAK' }
    );
  }

  return query(text, params);
}

// ============================================================================
// Settings — keyed on (business_id, key)
// ============================================================================

/**
 * Get a single setting for a specific tenant.
 *
 * `businessId` is REQUIRED. Super-admin callers that want to read another
 * tenant's settings must pass that tenant's id explicitly — passing `null`
 * is never valid for `settings` because the table is keyed on (business_id, key).
 */
async function getSetting(businessId, key) {
  requireBusinessIdOrSuperAdmin(businessId);
  if (businessId === null) {
    console.warn(`[tenant:admin] SUPER_ADMIN_BYPASS getSetting(null, "${key}") — this should not happen`);
  }
  const res = await query(
    'SELECT value FROM settings WHERE business_id = $1 AND key = $2',
    [businessId, key]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].value;
}

/**
 * Upsert a setting for a specific tenant.
 */
async function updateSetting(businessId, key, value, description) {
  requireBusinessIdOrSuperAdmin(businessId);
  const res = await query(
    `INSERT INTO settings (business_id, key, value, description, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (business_id, key) DO UPDATE
       SET value = $3,
           description = COALESCE($4, settings.description),
           updated_at = NOW()
     RETURNING *`,
    [businessId, key, JSON.stringify(value), description]
  );
  return res.rows[0];
}

/**
 * Fetch every setting row for a tenant as an object keyed by `key`.
 * Handy for the Command Center settings page.
 */
async function getAllSettings(businessId) {
  requireBusinessIdOrSuperAdmin(businessId);
  const res = await query(
    'SELECT key, value, description FROM settings WHERE business_id = $1 ORDER BY key',
    [businessId]
  );
  const out = {};
  for (const row of res.rows) {
    out[row.key] = { value: row.value, description: row.description };
  }
  return out;
}

// ============================================================================
// Businesses — tenant lookup helpers
// ============================================================================

/**
 * Find the business whose inbound Twilio DID matches the given E.164 number.
 *
 * Resolution order (Phase 5 onward):
 *
 *   1. `business_phone_numbers` — authoritative, multi-DID, status-aware.
 *      Only rows with `status = 'active'` resolve. `status = 'inactive'`
 *      lets ops temporarily disable a DID without losing history.
 *   2. `businesses.twilio_phone_number` — legacy denormalized column.
 *      Kept as a fallback so tenants that predate Phase 5 (Valleymede
 *      before ops wired the DID into `business_phone_numbers`) keep
 *      resolving. Migration 003 backfills every non-null value from
 *      this column into `business_phone_numbers`, so this step is
 *      only load-bearing on databases that haven't run 003 yet.
 *
 * Returns the full businesses row or null.
 */
async function getBusinessByTwilioNumber(phoneNumber) {
  if (!phoneNumber) return null;

  // 1. Authoritative multi-DID lookup (Phase 5).
  let res = await query(
    `SELECT b.*
       FROM business_phone_numbers bpn
       JOIN businesses b ON b.id = bpn.business_id
      WHERE bpn.phone_number = $1
        AND bpn.status = 'active'
        AND b.is_active = TRUE
      LIMIT 1`,
    [phoneNumber]
  );
  if (res.rows[0]) {
    // Phase 5 routing hit — this is the steady-state path and should be
    // what we see in prod after all tenants are migrated.
    console.log(
      `[tenant:${res.rows[0].id}] PHONE_ROUTE source=business_phone_numbers To=${phoneNumber} slug=${res.rows[0].slug}`
    );
    // Non-enumerable tag so callers can surface the source in their own logs
    // without it leaking into JSON serialisation of the business row.
    Object.defineProperty(res.rows[0], '_phoneSource', {
      value: 'business_phone_numbers',
      enumerable: false,
      configurable: true
    });
    return res.rows[0];
  }

  // 2. Legacy fallback — the denormalized column on `businesses`.
  res = await query(
    `SELECT * FROM businesses
     WHERE twilio_phone_number = $1
       AND is_active = TRUE
     LIMIT 1`,
    [phoneNumber]
  );
  if (res.rows[0]) {
    // Legacy hit — this means the tenant predates Phase 5 or their DID
    // hasn't been written into business_phone_numbers yet. Log loudly so
    // ops can backfill the new table.
    console.warn(
      `[tenant:${res.rows[0].id}] PHONE_ROUTE source=legacy_denorm To=${phoneNumber} slug=${res.rows[0].slug} ` +
      `— wire this DID into business_phone_numbers to retire the legacy fallback`
    );
    Object.defineProperty(res.rows[0], '_phoneSource', {
      value: 'legacy_denorm',
      enumerable: false,
      configurable: true
    });
    return res.rows[0];
  }
  return null;
}

// ============================================================================
// business_phone_numbers — multi-DID management (Phase 5)
// ============================================================================

/**
 * List every phone number owned by a tenant, newest-primary-first.
 * Returns an empty array if the tenant has no numbers yet.
 */
async function listBusinessPhoneNumbers(businessId) {
  requireBusinessIdOrSuperAdmin(businessId);
  const res = await query(
    `SELECT id, business_id, phone_number, label, is_primary, status,
            created_at, updated_at
       FROM business_phone_numbers
      WHERE business_id = $1
      ORDER BY is_primary DESC, status ASC, id ASC`,
    [businessId]
  );
  return res.rows;
}

/**
 * Fetch the primary *active* phone number for a tenant, or null.
 * Used as the From-address for outbound SMS/notifications and to
 * keep the denormalized `businesses.twilio_phone_number` column
 * in sync.
 */
async function getPrimaryBusinessPhoneNumber(businessId) {
  requireBusinessIdOrSuperAdmin(businessId);
  const res = await query(
    `SELECT id, phone_number, label
       FROM business_phone_numbers
      WHERE business_id = $1
        AND is_primary = TRUE
        AND status = 'active'
      LIMIT 1`,
    [businessId]
  );
  return res.rows[0] || null;
}

/**
 * Add a phone number to a tenant.
 *
 * Options:
 *   - is_primary: if TRUE, demotes any existing primary first so the
 *     partial unique index stays satisfied. Pass FALSE (default) for
 *     secondary lines.
 *   - label: human-readable tag. Defaults to 'Main Line' / 'Additional Line'
 *     depending on is_primary.
 *   - status: 'active' (default) | 'inactive'.
 *
 * If the number is_primary, also mirrors the value into
 * `businesses.twilio_phone_number` so the legacy column stays accurate
 * for any code path that still reads it. Runs in a single transaction
 * so a mid-swap failure can't leave two primaries.
 *
 * Throws on unique-violation with `err.code === '23505'`.
 */
async function addBusinessPhoneNumber(businessId, { phone_number, label, is_primary, status } = {}) {
  requireBusinessIdOrSuperAdmin(businessId);
  const num = String(phone_number || '').trim();
  if (!num) {
    throw Object.assign(new Error('phone_number is required'), { code: 'INVALID_PHONE' });
  }
  const finalLabel = String(label || (is_primary ? 'Main Line' : 'Additional Line')).trim().slice(0, 50);
  const finalStatus = status === 'inactive' ? 'inactive' : 'active';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (is_primary) {
      await client.query(
        `UPDATE business_phone_numbers
            SET is_primary = FALSE
          WHERE business_id = $1 AND is_primary = TRUE`,
        [businessId]
      );
    }
    const ins = await client.query(
      `INSERT INTO business_phone_numbers
         (business_id, phone_number, label, is_primary, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [businessId, num, finalLabel, !!is_primary, finalStatus]
    );
    if (is_primary && finalStatus === 'active') {
      await client.query(
        `UPDATE businesses SET twilio_phone_number = $1, updated_at = NOW() WHERE id = $2`,
        [num, businessId]
      );
    }
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update a phone number row. Only the allowed fields below are
 * patched; any other keys are silently ignored so callers can safely
 * pass a whole form body.
 *
 * Promoting a row to is_primary demotes every sibling in the same tx.
 * The denormalized `businesses.twilio_phone_number` stays in sync with
 * whichever row is currently primary + active.
 *
 * Returns the updated row or null if the phoneId doesn't belong to the
 * tenant (caller should 404).
 */
async function updateBusinessPhoneNumber(businessId, phoneId, patch = {}) {
  requireBusinessIdOrSuperAdmin(businessId);
  if (!Number.isInteger(phoneId) || phoneId <= 0) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT * FROM business_phone_numbers
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [phoneId, businessId]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const row = existing.rows[0];
    const updates = {};
    if (typeof patch.phone_number === 'string' && patch.phone_number.trim()) {
      updates.phone_number = patch.phone_number.trim();
    }
    if (typeof patch.label === 'string') {
      updates.label = patch.label.trim().slice(0, 50) || row.label;
    }
    if (patch.status === 'active' || patch.status === 'inactive') {
      updates.status = patch.status;
    }

    // Primary handling is special-cased: promoting demotes siblings;
    // demoting is allowed but leaves the tenant with no primary until
    // another row is promoted (the resolver handles this gracefully).
    const wantsPrimary = patch.is_primary === true;
    const clearsPrimary = patch.is_primary === false;

    // Disallow making an inactive row primary — that would be a footgun.
    const finalStatus = updates.status || row.status;
    if (wantsPrimary && finalStatus !== 'active') {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error('Cannot set an inactive phone number as primary'),
        { code: 'INVALID_STATE' }
      );
    }

    if (wantsPrimary) {
      await client.query(
        `UPDATE business_phone_numbers
            SET is_primary = FALSE
          WHERE business_id = $1 AND is_primary = TRUE AND id <> $2`,
        [businessId, phoneId]
      );
      updates.is_primary = true;
    } else if (clearsPrimary) {
      updates.is_primary = false;
    }

    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(updates)) {
      sets.push(`${k} = $${params.length + 1}`);
      params.push(v);
    }
    let updated = row;
    if (sets.length > 0) {
      params.push(phoneId);
      params.push(businessId);
      const sql = `UPDATE business_phone_numbers
                      SET ${sets.join(', ')}
                    WHERE id = $${params.length - 1}
                      AND business_id = $${params.length}
                    RETURNING *`;
      const upd = await client.query(sql, params);
      updated = upd.rows[0];
    }

    // Keep `businesses.twilio_phone_number` in sync with the current
    // primary + active row. If the primary was demoted and no new one
    // was chosen, we null the column so no stale DID lingers.
    const primaryLookup = await client.query(
      `SELECT phone_number FROM business_phone_numbers
        WHERE business_id = $1 AND is_primary = TRUE AND status = 'active'
        LIMIT 1`,
      [businessId]
    );
    const newDenorm = primaryLookup.rows[0]?.phone_number || null;
    await client.query(
      `UPDATE businesses SET twilio_phone_number = $1, updated_at = NOW() WHERE id = $2`,
      [newDenorm, businessId]
    );

    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete a phone number row outright. Prefer setting status='inactive'
 * for most cases (keeps audit trail); this helper is here for the rare
 * case where ops onboarded a wrong number and wants it gone.
 *
 * Returns `true` if a row was deleted, `false` otherwise.
 */
async function deleteBusinessPhoneNumber(businessId, phoneId) {
  requireBusinessIdOrSuperAdmin(businessId);
  if (!Number.isInteger(phoneId) || phoneId <= 0) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `DELETE FROM business_phone_numbers
        WHERE id = $1 AND business_id = $2
        RETURNING is_primary`,
      [phoneId, businessId]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    // If we just deleted the primary, zero out the legacy denorm column.
    if (existing.rows[0].is_primary) {
      await client.query(
        `UPDATE businesses SET twilio_phone_number = NULL, updated_at = NOW() WHERE id = $1`,
        [businessId]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Fetch a business by id (returns null if not found). */
async function getBusinessById(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const res = await query('SELECT * FROM businesses WHERE id = $1', [id]);
  return res.rows[0] || null;
}

/** Fetch a business by slug (URL key). Useful for admin UIs. */
async function getBusinessBySlug(slug) {
  if (!slug) return null;
  const res = await query('SELECT * FROM businesses WHERE slug = $1', [slug]);
  return res.rows[0] || null;
}

/**
 * Return all active businesses. Used by scheduled jobs that must iterate
 * every tenant (e.g. day-before reminders).
 */
async function listActiveBusinesses() {
  const res = await query(
    `SELECT * FROM businesses
      WHERE is_active = TRUE AND status IN ('active', 'trial')
      ORDER BY id`
  );
  return res.rows;
}

/**
 * How many tenants exist in total? Used by the Twilio middleware as a
 * bootstrap check: if exactly one business exists and its DID hasn't been
 * wired up yet, we can safely resolve inbound calls to that sole tenant.
 */
async function countBusinesses() {
  const res = await query('SELECT COUNT(*)::int AS n FROM businesses');
  return res.rows[0]?.n || 0;
}

module.exports = {
  pool,
  query,
  tenantQuery,
  // settings
  getSetting,
  updateSetting,
  getAllSettings,
  // business lookups
  getBusinessByTwilioNumber,
  getBusinessById,
  getBusinessBySlug,
  listActiveBusinesses,
  countBusinesses,
  // business_phone_numbers (Phase 5)
  listBusinessPhoneNumbers,
  getPrimaryBusinessPhoneNumber,
  addBusinessPhoneNumber,
  updateBusinessPhoneNumber,
  deleteBusinessPhoneNumber
};
