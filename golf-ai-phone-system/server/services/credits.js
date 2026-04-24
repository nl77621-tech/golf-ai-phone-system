/**
 * Credit / Billing Service (Phase 7a)
 * ----------------------------------
 * Per-tenant balance ledger. Internally everything is in SECONDS — that
 * is the unit Twilio reports `call_logs.duration_seconds` in, so there
 * is zero rounding risk on the hot path. UI layers display hours.
 *
 * The design has three pieces, in order of importance:
 *
 *   1. `credit_ledger` is the source of truth.
 *      Every grant, usage, adjustment, or refund is one immutable row.
 *      Balance = SUM(delta_seconds) for a business. We never UPDATE an
 *      existing ledger row — corrections are new rows with a matching
 *      negative delta.
 *
 *   2. `businesses.credit_seconds_remaining` is a materialised cache.
 *      Every ledger insert is paired with an UPDATE on the business row
 *      IN THE SAME TRANSACTION. The hot path (Twilio call entry) reads
 *      this column so it never has to scan the ledger. If the two ever
 *      disagree, the ledger wins — `rebuildBalance(businessId)` exists
 *      to resync.
 *
 *   3. `plan = 'legacy'` is an unconditional enforcement bypass.
 *      Valleymede was running before billing existed; we never want a
 *      billing bug to silence the only live tenant on the platform.
 *      Legacy tenants still accumulate `call_usage` ledger rows for
 *      visibility, but `canAcceptCall()` returns `{ allowed: true }`
 *      before ever reading the balance.
 *
 * All functions are tenant-scoped. `requireBusinessId` is called at
 * entry so a missing tenant fails loudly instead of silently widening
 * a balance read across the platform.
 *
 * Never throws into a Twilio request path. Enforcement checks fail
 * OPEN on internal errors (allow the call through, log loudly) because
 * the alternative — hanging up a paying customer because the DB hiccuped
 * — is strictly worse.
 */
const { pool, query } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');

// Trial defaults. Kept here (not in env) so they're reviewed in diffs.
// If you tune these, also update the UI copy in the tenant billing page.
const TRIAL_SECONDS = 3600;       // 1 hour
const TRIAL_DAYS    = 14;

// Materialised balance is per-business. Keep this in sync with the
// column added in migration 006.
const BALANCE_COLUMN = 'credit_seconds_remaining';

// Whitelist of ledger reason codes — must match the CHECK constraint
// on credit_ledger.reason. Exported so callers don't spell-typo.
const REASON = Object.freeze({
  TRIAL_GRANT:      'trial_grant',
  PURCHASE:         'purchase',
  ADMIN_GRANT:      'admin_grant',
  ADMIN_DEDUCTION:  'admin_deduction',
  CALL_USAGE:       'call_usage',
  REFUND:           'refund',
  MIGRATION_GRANT:  'migration_grant'
});
const REASONS = new Set(Object.values(REASON));

// --------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------

/**
 * Balance snapshot for a single tenant. Cheap — one indexed row read.
 *
 * @param {number} businessId
 * @returns {Promise<{
 *   business_id: number,
 *   plan: string|null,
 *   seconds_remaining: number,
 *   trial_granted_at: Date|null,
 *   trial_expires_at: Date|null,
 *   in_trial: boolean,
 *   trial_active: boolean,
 *   is_legacy: boolean,
 *   updated_at: Date
 * }>}
 */
async function getBalance(businessId) {
  requireBusinessId(businessId, 'credits.getBalance');
  const res = await query(
    `SELECT id, plan, ${BALANCE_COLUMN} AS seconds_remaining,
            trial_granted_at, trial_expires_at
       FROM businesses
      WHERE id = $1`,
    [businessId]
  );
  const row = res.rows[0];
  if (!row) {
    const err = new Error(`credits.getBalance: business ${businessId} not found`);
    err.code = 'BUSINESS_NOT_FOUND';
    throw err;
  }
  const now = Date.now();
  const trialActive = row.trial_expires_at != null
    && new Date(row.trial_expires_at).getTime() > now
    && Number(row.seconds_remaining) > 0;
  return {
    business_id: row.id,
    plan: row.plan,
    seconds_remaining: Number(row.seconds_remaining) || 0,
    trial_granted_at: row.trial_granted_at,
    trial_expires_at: row.trial_expires_at,
    in_trial: row.trial_granted_at != null,
    trial_active: trialActive,
    is_legacy: row.plan === 'legacy',
    updated_at: new Date()
  };
}

/**
 * Paged ledger reader for UI timelines. Positive deltas (grants) + negative
 * deltas (usage / deductions) interleaved, newest first.
 *
 * @param {number} businessId
 * @param {object} [opts]
 * @param {number} [opts.limit=50]    1..500
 * @param {number} [opts.beforeId]    keyset cursor (ledger.id is BIGSERIAL)
 * @param {string} [opts.reason]      optional reason filter
 */
async function listLedger(businessId, { limit, beforeId, reason } = {}) {
  requireBusinessId(businessId, 'credits.listLedger');
  const params = [businessId];
  const conds = ['business_id = $1'];
  if (typeof reason === 'string' && REASONS.has(reason)) {
    params.push(reason);
    conds.push(`reason = $${params.length}`);
  }
  if (Number.isInteger(beforeId) && beforeId > 0) {
    params.push(beforeId);
    conds.push(`id < $${params.length}`);
  }
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  params.push(cappedLimit);
  const res = await query(
    `SELECT id, delta_seconds, reason, source_type, source_id,
            note, created_by_user_id, balance_after, created_at
       FROM credit_ledger
      WHERE ${conds.join(' AND ')}
      ORDER BY id DESC
      LIMIT $${params.length}`,
    params
  );
  return res.rows.map(r => ({ ...r, delta_seconds: Number(r.delta_seconds), balance_after: Number(r.balance_after) }));
}

/**
 * Catalog read. Consumed by the tenant billing page and by the super
 * admin "add credits" UI (where the operator can pick a preset pack).
 */
async function listPackages({ activeOnly = true } = {}) {
  const res = await query(
    `SELECT key, label, seconds_included, price_cents, currency,
            active, sort_order, description
       FROM credit_packages
      ${activeOnly ? 'WHERE active = TRUE' : ''}
      ORDER BY sort_order ASC, id ASC`
  );
  return res.rows.map(r => ({ ...r, seconds_included: Number(r.seconds_included) }));
}

// --------------------------------------------------------------------
// Writes
// --------------------------------------------------------------------

/**
 * Low-level ledger append. INSIDE A TRANSACTION — caller owns the
 * client. Writes one ledger row, updates the materialised balance on
 * the businesses row, and returns the new balance_after.
 *
 * @param {import('pg').PoolClient} client   A pg client mid-transaction.
 * @param {number} businessId
 * @param {object} entry
 * @param {number} entry.deltaSeconds     signed. positive grants, negative deducts.
 * @param {string} entry.reason           one of REASON.*
 * @param {string} [entry.sourceType]     free-form, e.g. 'call_log', 'package'
 * @param {number} [entry.sourceId]       polymorphic; call_log id, package id, etc.
 * @param {string} [entry.note]
 * @param {number} [entry.createdByUserId]  super_admins.id for admin actions; omit for usage
 * @returns {Promise<{ ledgerId: number, balanceAfter: number }>}
 */
async function adjustBalance(client, businessId, entry) {
  requireBusinessId(businessId, 'credits.adjustBalance');
  if (!entry || typeof entry !== 'object') {
    throw new Error('credits.adjustBalance: entry is required');
  }
  const deltaSeconds = Number(entry.deltaSeconds);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) {
    throw new Error(`credits.adjustBalance: deltaSeconds must be a non-zero number, got ${entry.deltaSeconds}`);
  }
  if (!REASONS.has(entry.reason)) {
    throw new Error(`credits.adjustBalance: unknown reason '${entry.reason}'`);
  }

  // Materialised-balance UPDATE first so we can feed the post-update
  // value into the ledger row's balance_after column in the same tx.
  // GREATEST(..., 0) guards against a bad deduction driving the balance
  // negative — we never want a negative balance in the cache. Legacy
  // tenants can still go "negative" in the ledger (call_usage rows
  // accumulate) but the materialised column stays non-negative.
  const balRes = await client.query(
    `UPDATE businesses
        SET ${BALANCE_COLUMN} = GREATEST(${BALANCE_COLUMN} + $1, 0)
      WHERE id = $2
      RETURNING ${BALANCE_COLUMN} AS balance_after`,
    [deltaSeconds, businessId]
  );
  if (balRes.rowCount === 0) {
    const err = new Error(`credits.adjustBalance: business ${businessId} not found`);
    err.code = 'BUSINESS_NOT_FOUND';
    throw err;
  }
  const balanceAfter = Number(balRes.rows[0].balance_after);

  const ledgerRes = await client.query(
    `INSERT INTO credit_ledger
       (business_id, delta_seconds, reason, source_type, source_id,
        note, created_by_user_id, balance_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      businessId,
      deltaSeconds,
      entry.reason,
      entry.sourceType || null,
      Number.isInteger(entry.sourceId) ? entry.sourceId : null,
      typeof entry.note === 'string' ? entry.note.slice(0, 4000) : null,
      Number.isInteger(entry.createdByUserId) ? entry.createdByUserId : null,
      balanceAfter
    ]
  );
  return { ledgerId: Number(ledgerRes.rows[0].id), balanceAfter };
}

/**
 * Trial grant helper. Opens its own transaction. Idempotent on
 * `businesses.trial_granted_at` — a second call is a no-op, so it's
 * safe to invoke from the super-admin onboarding wizard even if the
 * wizard retries.
 *
 * @param {number} businessId
 * @param {object} [opts]
 * @param {number} [opts.seconds=TRIAL_SECONDS]
 * @param {number} [opts.days=TRIAL_DAYS]
 * @param {import('pg').PoolClient} [opts.client]   pass an open client to run in an existing tx
 * @returns {Promise<{ granted: boolean, balanceAfter?: number, trialExpiresAt?: Date }>}
 */
async function grantTrial(businessId, opts = {}) {
  requireBusinessId(businessId, 'credits.grantTrial');
  const seconds = Number.isInteger(opts.seconds) && opts.seconds > 0 ? opts.seconds : TRIAL_SECONDS;
  const days = Number.isInteger(opts.days) && opts.days > 0 ? opts.days : TRIAL_DAYS;

  const ownTx = !opts.client;
  const client = opts.client || await pool.connect();
  try {
    if (ownTx) await client.query('BEGIN');

    // Idempotence — if trial already granted, do nothing.
    const existing = await client.query(
      `SELECT trial_granted_at FROM businesses WHERE id = $1`,
      [businessId]
    );
    if (existing.rowCount === 0) {
      if (ownTx) await client.query('ROLLBACK');
      const err = new Error(`credits.grantTrial: business ${businessId} not found`);
      err.code = 'BUSINESS_NOT_FOUND';
      throw err;
    }
    if (existing.rows[0].trial_granted_at != null) {
      if (ownTx) await client.query('ROLLBACK');
      return { granted: false };
    }

    const now = new Date();
    const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    await client.query(
      `UPDATE businesses
          SET trial_granted_at = $1,
              trial_expires_at = $2
        WHERE id = $3`,
      [now, expires, businessId]
    );
    const { balanceAfter } = await adjustBalance(client, businessId, {
      deltaSeconds: seconds,
      reason: REASON.TRIAL_GRANT,
      sourceType: 'super_admin',
      note: `Free trial — ${Math.round(seconds / 60)} minutes, expires ${expires.toISOString()}.`
    });

    if (ownTx) await client.query('COMMIT');
    return { granted: true, balanceAfter, trialExpiresAt: expires };
  } catch (err) {
    if (ownTx) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (ownTx) client.release();
  }
}

/**
 * Admin-initiated top-up / deduction. Opens its own transaction.
 * Called from the super-admin "Add credits" endpoint.
 *
 * @param {number} businessId
 * @param {object} opts
 * @param {number} opts.deltaSeconds    signed
 * @param {string} opts.note
 * @param {number} opts.createdByUserId super_admins.id
 * @param {boolean} [opts.isFree=false] purely for the note; ledger reason is unchanged
 */
async function adminAdjust(businessId, { deltaSeconds, note, createdByUserId, isFree } = {}) {
  requireBusinessId(businessId, 'credits.adminAdjust');
  if (!Number.isFinite(Number(deltaSeconds)) || Number(deltaSeconds) === 0) {
    throw new Error('credits.adminAdjust: deltaSeconds must be a non-zero number');
  }
  const reason = Number(deltaSeconds) > 0 ? REASON.ADMIN_GRANT : REASON.ADMIN_DEDUCTION;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { ledgerId, balanceAfter } = await adjustBalance(client, businessId, {
      deltaSeconds: Number(deltaSeconds),
      reason,
      sourceType: 'super_admin',
      sourceId: Number.isInteger(createdByUserId) ? createdByUserId : null,
      note: [isFree ? '[free]' : '[paid]', note || ''].join(' ').trim(),
      createdByUserId
    });
    await client.query('COMMIT');
    return { ledgerId, balanceAfter, reason };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Post-call usage hook. Called fire-and-forget from grok-voice.js
 * close handler. Deducts `ceil(durationSeconds)` from the balance and
 * writes one `call_usage` ledger row. Never throws — the call has
 * already hung up and the call_logs row is already written, so a
 * billing failure here must not tank the whole cleanup path.
 *
 * @param {number} businessId
 * @param {object} details
 * @param {number} details.durationSeconds     raw seconds from Twilio; fractional is fine
 * @param {number} [details.callLogId]         call_logs.id — populated in ledger.source_id
 * @returns {Promise<number|null>}             new balance, or null on failure
 */
async function recordCallUsage(businessId, { durationSeconds, callLogId } = {}) {
  try {
    requireBusinessId(businessId, 'credits.recordCallUsage');
    const duration = Math.max(0, Math.ceil(Number(durationSeconds) || 0));
    if (duration === 0) return null; // 0-duration failed calls — nothing to bill

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { balanceAfter } = await adjustBalance(client, businessId, {
        deltaSeconds: -duration,
        reason: REASON.CALL_USAGE,
        sourceType: 'call_log',
        sourceId: Number.isInteger(callLogId) ? callLogId : null,
        note: `Call usage: ${duration}s`
      });
      await client.query('COMMIT');
      return balanceAfter;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`[tenant:${businessId}] credits.recordCallUsage failed: ${err.message}`);
    return null;
  }
}

// --------------------------------------------------------------------
// Enforcement
// --------------------------------------------------------------------

/**
 * Call-entry gate. Run this at the very top of the Twilio inbound
 * handler — before we spin up a Grok WebSocket — and hang up the call
 * politely if the tenant is not allowed to answer.
 *
 * Rules, in order:
 *   1. plan = 'legacy' → always allowed. Valleymede bypass.
 *   2. trial active (trial_expires_at in the future AND seconds > 0) → allowed.
 *   3. seconds_remaining > 0 → allowed.
 *   4. otherwise → denied.
 *
 * FAILS OPEN: any internal error is logged and treated as allowed.
 * Better to let a call through on a DB hiccup than block a paying
 * customer mid-deploy.
 *
 * @param {number} businessId
 * @returns {Promise<{
 *   allowed: boolean,
 *   reason: string,        // 'legacy' | 'trial' | 'paid' | 'no_credit' | 'error_open'
 *   seconds_remaining?: number,
 *   trial_expires_at?: Date|null
 * }>}
 */
async function canAcceptCall(businessId) {
  try {
    const snap = await getBalance(businessId);
    if (snap.is_legacy) {
      return { allowed: true, reason: 'legacy', seconds_remaining: snap.seconds_remaining };
    }
    if (snap.trial_active) {
      return {
        allowed: true,
        reason: 'trial',
        seconds_remaining: snap.seconds_remaining,
        trial_expires_at: snap.trial_expires_at
      };
    }
    if (snap.seconds_remaining > 0) {
      return { allowed: true, reason: 'paid', seconds_remaining: snap.seconds_remaining };
    }
    return { allowed: false, reason: 'no_credit', seconds_remaining: 0 };
  } catch (err) {
    console.error(`[tenant:${businessId}] credits.canAcceptCall error (failing open): ${err.message}`);
    return { allowed: true, reason: 'error_open' };
  }
}

/**
 * Rebuild the materialised balance from the ledger. Ops-only — used
 * after ledger surgery or to self-heal if the cache ever drifts.
 *
 * @param {number} businessId
 * @returns {Promise<number>}  the resynced balance
 */
async function rebuildBalance(businessId) {
  requireBusinessId(businessId, 'credits.rebuildBalance');
  const res = await query(
    `UPDATE businesses b
        SET ${BALANCE_COLUMN} = GREATEST(COALESCE(
               (SELECT SUM(delta_seconds) FROM credit_ledger WHERE business_id = b.id), 0
             ), 0)
      WHERE b.id = $1
      RETURNING ${BALANCE_COLUMN} AS balance_after`,
    [businessId]
  );
  if (res.rowCount === 0) {
    const err = new Error(`credits.rebuildBalance: business ${businessId} not found`);
    err.code = 'BUSINESS_NOT_FOUND';
    throw err;
  }
  return Number(res.rows[0].balance_after);
}

module.exports = {
  // Reads
  getBalance,
  listLedger,
  listPackages,
  // Writes
  adjustBalance,     // low-level; inside caller's tx
  grantTrial,        // onboarding helper
  adminAdjust,       // super-admin endpoint
  recordCallUsage,   // grok-voice close hook
  // Enforcement
  canAcceptCall,
  // Ops
  rebuildBalance,
  // Constants
  REASON,
  TRIAL_SECONDS,
  TRIAL_DAYS
};
