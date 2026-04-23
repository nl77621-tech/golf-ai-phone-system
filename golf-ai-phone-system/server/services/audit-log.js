/**
 * Audit Log Service (Phase 6)
 * ---------------------------
 * High-signal, append-only record of state changes. Keeps a forensic
 * trail answer for questions like:
 *   - "Who created Valleymede's second DID, and when?"
 *   - "Which super admin impersonated this tenant on Tuesday?"
 *   - "What settings did business_admin X change last week?"
 *
 * Design principles:
 *   1. Never throw into the caller's control flow. Audit-log failures
 *      must NEVER break the main request — we log the internal error
 *      and return. Mutations are more important than the audit trail.
 *   2. Action names are dotted, past-tense, short: e.g.
 *         'business.created'
 *         'business.updated'
 *         'phone.added' / 'phone.updated' / 'phone.deleted'
 *         'setting.updated'
 *         'greeting.created' / 'greeting.deleted'
 *         'invite.created' / 'invite.accepted'
 *         'user.login'
 *         'super_admin.impersonate'
 *   3. Every tenant-scoped action MUST carry a `businessId`. Platform
 *      events (super-admin bootstrap, cross-tenant reads) carry
 *      `businessId: null` — the table allows it.
 *   4. `actor_email` is denormalized so an audit row is still legible
 *      after a user row is later deleted or renamed.
 *
 * Helpers:
 *   - `logEvent(...)` — primary entry point, returns the new row or null.
 *   - `extractActor(req)` — pulls `user_id`/`user_type`/`email`/`ip`/
 *      `user_agent` off a standard Express request (req.auth + req.ip +
 *      headers), so route handlers don't have to assemble that blob by hand.
 *   - `listAuditEvents({ businessId, limit, before })` — paged reader
 *      used by the super-admin "recent activity" panel.
 *   - `truncateMeta(obj)` — defensively clips oversized meta payloads so
 *      a pathological caller can't inflate a single row past PG's toast
 *      limits.
 */
const { query } = require('../config/database');

const MAX_META_BYTES = 16 * 1024; // 16 KB per row is plenty for audit-level context

/**
 * Pluck a stable "actor" tuple off an Express request. Safe to call on
 * any authenticated or unauthenticated request.
 */
function extractActor(req) {
  const auth = (req && req.auth) || {};
  const role = auth.role || 'anonymous';
  const email = auth.email || auth.username || null;
  // Trim to the first IP in x-forwarded-for; fall back to req.ip.
  let ip = null;
  try {
    const fwd = req?.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      ip = fwd.split(',')[0].trim();
    }
    if (!ip) ip = req?.ip || req?.connection?.remoteAddress || null;
    if (typeof ip === 'string') ip = ip.slice(0, 64);
  } catch {
    ip = null;
  }
  const user_agent = (req?.headers?.['user-agent'] || '').toString().slice(0, 500) || null;
  return {
    user_id: Number.isInteger(auth.user_id) ? auth.user_id : null,
    user_type: role,
    actor_email: typeof email === 'string' ? email.slice(0, 200) : null,
    ip,
    user_agent
  };
}

function truncateMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  try {
    const s = JSON.stringify(meta);
    if (Buffer.byteLength(s, 'utf8') <= MAX_META_BYTES) return meta;
    // Over budget — drop big leaves and stamp a marker.
    return { _truncated: true, _original_bytes: Buffer.byteLength(s, 'utf8') };
  } catch {
    return { _truncated: true, _reason: 'unserializable' };
  }
}

/**
 * Primary audit entry point.
 *
 * @param {object} evt
 * @param {number|null} evt.businessId    Required unless this is a platform-wide event.
 * @param {string}      evt.action        Short dotted name. REQUIRED.
 * @param {number|null} [evt.userId]      DB id of the acting user (null for 'system').
 * @param {string}      [evt.userType]    'super_admin' | 'business_admin' | 'staff' | 'system' | 'anonymous'.
 * @param {string|null} [evt.actorEmail]  Denormalized for forensic readability.
 * @param {string}      [evt.targetType]  'business' | 'phone_number' | 'setting' | ...
 * @param {string|number|null} [evt.targetId]  Polymorphic id (stringified on write).
 * @param {object}      [evt.meta]        Arbitrary JSON — truncated to 16 KB.
 * @param {string|null} [evt.ip]          Client IP (extracted by `extractActor`).
 * @param {string|null} [evt.userAgent]
 * @returns {Promise<object|null>}        The inserted row, or null on failure.
 */
async function logEvent(evt) {
  if (!evt || typeof evt.action !== 'string' || evt.action.length === 0) {
    console.warn('[audit] Refusing to log event with missing action:', evt);
    return null;
  }
  const businessId = Number.isInteger(evt.businessId) ? evt.businessId : null;
  const userId = Number.isInteger(evt.userId) ? evt.userId : null;
  const userType = typeof evt.userType === 'string' ? evt.userType.slice(0, 20) : null;
  const actorEmail = typeof evt.actorEmail === 'string' ? evt.actorEmail.slice(0, 200) : null;
  const action = evt.action.slice(0, 80);
  const targetType = typeof evt.targetType === 'string' ? evt.targetType.slice(0, 40) : null;
  const targetId = evt.targetId === undefined || evt.targetId === null
    ? null
    : String(evt.targetId).slice(0, 80);
  const meta = truncateMeta(evt.meta);
  const ip = typeof evt.ip === 'string' ? evt.ip.slice(0, 64) : null;
  const userAgent = typeof evt.userAgent === 'string' ? evt.userAgent.slice(0, 500) : null;

  try {
    const res = await query(
      `INSERT INTO audit_log
         (business_id, user_id, user_type, actor_email, action,
          target_type, target_id, meta, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, created_at`,
      [businessId, userId, userType, actorEmail, action,
       targetType, targetId, JSON.stringify(meta), ip, userAgent]
    );
    // Include business_id + actor in the stdout log so we can correlate
    // audit rows with the regular request log.
    const tenantTag = businessId === null ? '[tenant:platform]' : `[tenant:${businessId}]`;
    const actorTag = userType && userId !== null
      ? `${userType}#${userId}`
      : (userType || 'anonymous');
    console.log(
      `${tenantTag} AUDIT ${action}` +
      (targetType ? ` target=${targetType}:${targetId ?? '-'}` : '') +
      ` actor=${actorTag}`
    );
    return res.rows[0];
  } catch (err) {
    // NEVER rethrow — audit failure must not break the request.
    console.error(
      `[audit] FAILED to record ${action} ` +
      `(business=${businessId}, user=${userType}#${userId}): ${err.message}`
    );
    return null;
  }
}

/**
 * Convenience wrapper for route handlers. Pulls the actor off `req` and
 * merges with the caller-supplied event fields. Use this everywhere you
 * have a req in scope; use `logEvent` directly from services or jobs.
 */
async function logEventFromReq(req, evt) {
  const actor = extractActor(req);
  return logEvent({
    businessId: evt.businessId ?? (req.business && req.business.id) ?? null,
    userId: actor.user_id,
    userType: actor.user_type,
    actorEmail: actor.actor_email,
    ip: actor.ip,
    userAgent: actor.user_agent,
    ...evt
  });
}

/**
 * Paged reader for the audit_log surface. Used by /api/super/audit-log
 * on the platform dashboard.
 *
 * @param {object} opts
 * @param {number|null} [opts.businessId]  Filter to one tenant. Pass null to read
 *                                         all rows (platform view — super-admin only).
 * @param {string}      [opts.action]      Optional exact-match action filter.
 * @param {number}      [opts.limit]       Default 50, max 500.
 * @param {number|null} [opts.beforeId]    Keyset pagination cursor (ids are BIGSERIAL).
 */
async function listAuditEvents({ businessId, action, limit, beforeId } = {}) {
  const conds = [];
  const params = [];
  if (businessId !== undefined && businessId !== null) {
    if (!Number.isInteger(businessId) || businessId <= 0) return [];
    params.push(businessId);
    conds.push(`business_id = $${params.length}`);
  }
  if (typeof action === 'string' && action.length > 0) {
    params.push(action.slice(0, 80));
    conds.push(`action = $${params.length}`);
  }
  if (Number.isInteger(beforeId) && beforeId > 0) {
    params.push(beforeId);
    conds.push(`id < $${params.length}`);
  }
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  params.push(cappedLimit);
  const where = conds.length === 0 ? '' : `WHERE ${conds.join(' AND ')}`;
  const res = await query(
    `SELECT id, business_id, user_id, user_type, actor_email, action,
            target_type, target_id, meta, ip, user_agent, created_at
       FROM audit_log
       ${where}
      ORDER BY id DESC
      LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

module.exports = {
  logEvent,
  logEventFromReq,
  listAuditEvents,
  extractActor,
  truncateMeta
};
