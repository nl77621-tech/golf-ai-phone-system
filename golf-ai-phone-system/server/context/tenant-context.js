/**
 * Tenant Context
 * ----------------------------------------------------------------------------
 * Centralized helpers for the multi-tenant boundary enforced by `business_id`.
 *
 * Two ways tenant context flows through the code:
 *
 *   1. Explicit parameter — every data-layer function takes `businessId` as its
 *      first argument (see CLAUDE.md §3.2). This is the primary, enforced path.
 *
 *   2. AsyncLocalStorage fallback — HTTP and WebSocket entry points wrap their
 *      work in `runWithTenant(businessId, fn)` so deep logging / defensive
 *      sanity checks can see the "current" tenant without threading it
 *      through every function signature.
 *
 * The enforced contract:
 *   - A regular business user MUST have a non-null `business_id`.
 *   - A Super Admin is represented by `business_id === null` (they intentionally
 *     cross tenants via /api/admin/* routes).
 *   - Any data function that gets passed `undefined` or a forbidden null
 *     should throw via `requireBusinessId()` rather than silently return
 *     everyone's rows — that's the core tenant-isolation guarantee.
 */
const { AsyncLocalStorage } = require('async_hooks');

// Valleymede Columbus Golf Course is pinned to business_id = 1 by the initial
// seed and migration 001. Hardcoding the constant avoids magic numbers
// littered through the codebase and keeps CLAUDE.md §4.6 visible.
const VALLEYMEDE_BUSINESS_ID = 1;

// Role vocabulary (Phase 3).
//
// `super_admin`     — platform operator, business_id === null, crosses tenants.
// `business_admin`  — tenant owner/admin; full access within one tenant.
//                     Legacy `owner` rows are normalized to `business_admin`
//                     by migration 002; both strings are treated as equivalent
//                     by `isBusinessAdmin()` below for back-compat.
// `staff`           — tenant staff user; same data scope as business_admin but
//                     no ability to invite users or change billing.
const SUPER_ADMIN_ROLE = 'super_admin';
const BUSINESS_ADMIN_ROLE = 'business_admin';
const STAFF_ROLE = 'staff';
const ALL_ROLES = [SUPER_ADMIN_ROLE, BUSINESS_ADMIN_ROLE, STAFF_ROLE];

/** True if `role` resolves to a tenant admin (including legacy `owner`). */
function isBusinessAdminRole(role) {
  return role === BUSINESS_ADMIN_ROLE || role === 'owner';
}

const storage = new AsyncLocalStorage();

/**
 * Run the given async function with a tenant context bound to the current
 * request/stream. `ctx` should be { businessId, role, userId } — nulls
 * are allowed for super-admin flows.
 */
function runWithTenant(ctx, fn) {
  return storage.run({ businessId: null, role: null, userId: null, ...ctx }, fn);
}

/** Read the currently-bound tenant context, or {} if none. */
function getTenantContext() {
  return storage.getStore() || {};
}

/** Shortcut for `getTenantContext().businessId`. Returns null if unset. */
function getCurrentBusinessId() {
  const ctx = storage.getStore();
  return ctx ? ctx.businessId : null;
}

/**
 * Read the tenant resolution source from the current AsyncLocalStorage
 * context. Valid values:
 *   - 'jwt'            — resolved from an authenticated API JWT
 *   - 'twilio_to'      — resolved from an inbound Twilio `To` number
 *   - 'twilio_callsid' — resolved from a status/transfer callback's CallSid
 *   - 'system'         — server-initiated work (no tenant entry point)
 * Returns `null` when no context is bound (e.g. a CLI script forgot to
 * call `runWithTenant`).
 */
function getTenantSource() {
  const ctx = storage.getStore();
  return ctx ? (ctx.source || null) : null;
}

/** True if the currently-bound context belongs to a Super Admin. */
function isSuperAdmin() {
  const ctx = storage.getStore();
  return !!ctx && ctx.role === SUPER_ADMIN_ROLE;
}

/**
 * Guard: throw if `businessId` is not a positive integer.
 * Use this at the top of any data-layer helper that MUST be tenant-scoped.
 * Super-admin paths should call `requireBusinessIdOrSuperAdmin()` instead.
 *
 * The thrown error embeds the current resolution source (JWT, Twilio To,
 * CallSid, system) so operators can tell *which* entry point failed to
 * stamp the request — that's usually what points to the real bug.
 */
function requireBusinessId(businessId, fnName = 'query') {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    const source = getTenantSource();
    const sourceTag = source ? `source=${source}` : 'source=<none bound>';
    const err = new Error(
      `Tenant isolation violation: ${fnName} called without a valid business_id ` +
      `(got ${JSON.stringify(businessId)}, ${sourceTag}). ` +
      `Resolution paths: JWT (requireAuth) | twilio_to (attachTenantFromTwilioTo) | ` +
      `twilio_callsid (attachTenantFromCallSid). Check that the request entered through ` +
      `one of these and that runWithTenant() wrapped the handler.`
    );
    err.code = 'TENANT_MISSING';
    err.source = source;
    throw err;
  }
  return businessId;
}

/**
 * Like `requireBusinessId` but allows `null` when the caller is a Super Admin
 * (e.g. platform-wide dashboards). For all other callers, `businessId` must
 * be a positive integer.
 */
function requireBusinessIdOrSuperAdmin(businessId, { allowSuperAdmin = false } = {}) {
  if (businessId === null || businessId === undefined) {
    if (allowSuperAdmin) return null;
    throw Object.assign(
      new Error('Tenant isolation violation: business_id is required for non-super-admin callers'),
      { code: 'TENANT_MISSING' }
    );
  }
  return requireBusinessId(businessId);
}

/**
 * Lightweight tenant-aware logger. Prepends [tenant:N] (or [tenant:admin]) to
 * any console.log so cross-tenant debugging is tractable.
 */
function tlog(businessId, ...args) {
  const tag = businessId === null ? '[tenant:admin]' : `[tenant:${businessId}]`;
  console.log(tag, ...args);
}

function twarn(businessId, ...args) {
  const tag = businessId === null ? '[tenant:admin]' : `[tenant:${businessId}]`;
  console.warn(tag, ...args);
}

function terror(businessId, ...args) {
  const tag = businessId === null ? '[tenant:admin]' : `[tenant:${businessId}]`;
  console.error(tag, ...args);
}

module.exports = {
  VALLEYMEDE_BUSINESS_ID,
  SUPER_ADMIN_ROLE,
  BUSINESS_ADMIN_ROLE,
  STAFF_ROLE,
  ALL_ROLES,
  isBusinessAdminRole,
  runWithTenant,
  getTenantContext,
  getCurrentBusinessId,
  getTenantSource,
  isSuperAdmin,
  requireBusinessId,
  requireBusinessIdOrSuperAdmin,
  tlog,
  twarn,
  terror
};
