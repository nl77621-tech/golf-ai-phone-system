/**
 * Tenant-resolution middleware + Twilio webhook security.
 *
 * Two entry points into the system need to know "which business is this?":
 *
 *   1. Authenticated API requests: the tenant comes from the JWT
 *      (`req.auth.business_id`). `attachTenantFromAuth` verifies and hydrates
 *      `req.business` so handlers can read per-tenant config directly. Source
 *      tag bound into AsyncLocalStorage: `'jwt'`.
 *
 *   2. Twilio webhooks (unauthenticated, but the called DID identifies the
 *      tenant): `attachTenantFromTwilioTo` resolves the business from
 *      `req.body.To`, rejecting unknown numbers with a generic TwiML hangup.
 *      Source tag: `'twilio_to'`. For status / transfer-action callbacks that
 *      don't carry a meaningful To, `attachTenantFromCallSid` resolves via
 *      `call_logs`. Source tag: `'twilio_callsid'`.
 *
 * CLAUDE.md §3.3 requires that an unknown inbound number is rejected — we
 * do NOT silently fall back to Valleymede. The one exception is a
 * single-tenant bootstrap where Valleymede's DID has not yet been written
 * into `businesses.twilio_phone_number`: when exactly one business exists
 * in the DB, we resolve to that business and log a warning. The moment a
 * second tenant is onboarded, the fallback path can no longer fire.
 *
 * This file also exports `validateTwilioSignature` — a thin wrapper around
 * `twilio.webhook()` that verifies the `X-Twilio-Signature` header against
 * the platform auth token. Now that inbound requests can route to any
 * tenant, any unsigned webhook is treated as hostile.
 */
const twilio = require('twilio');
const {
  getBusinessByTwilioNumber,
  getBusinessById,
  countBusinesses,
  listActiveBusinesses
} = require('../config/database');
const { runWithTenant, SUPER_ADMIN_ROLE } = require('../context/tenant-context');

/**
 * For authenticated routes. Runs after `requireAuth`. Hydrates `req.business`
 * with the full businesses row so handlers don't have to re-fetch.
 *
 * Super admins (business_id === null) skip hydration — they don't belong to
 * any single tenant.
 */
function attachTenantFromAuth(req, res, next) {
  const auth = req.auth;
  if (!auth) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Super admins MAY opt into a specific tenant by sending an
  // `X-Business-Id` header. This powers the Business Switcher in the
  // Command Center UI. Without the header, `req.business` stays null
  // and only /api/admin + /api/super endpoints are useful to them.
  if (auth.role === SUPER_ADMIN_ROLE) {
    const headerId = parseInt(req.headers['x-business-id'], 10);
    if (Number.isInteger(headerId) && headerId > 0) {
      return getBusinessById(headerId)
        .then(business => {
          if (!business) return res.status(404).json({ error: 'Selected business not found' });
          req.business = business;
          req.super_admin_switch = true;
          console.warn(
            `[tenant:${business.id}] SUPER_ADMIN_BUSINESS_SWITCH — super_admin ${auth.user_id} ` +
            `acting as tenant ${business.id} (${business.slug})`
          );
          runWithTenant(
            { businessId: business.id, role: auth.role, userId: auth.user_id, source: 'jwt' },
            () => next()
          );
        })
        .catch(err => {
          console.error('attachTenantFromAuth super-switch error:', err.message);
          res.status(500).json({ error: 'Failed to resolve selected tenant' });
        });
    }
    req.business = null;
    return runWithTenant(
      { businessId: null, role: auth.role, userId: auth.user_id, source: 'jwt' },
      () => next()
    );
  }

  const businessId = auth.business_id;
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return res.status(403).json({ error: 'Account is not associated with a tenant' });
  }

  // Tenant users are NEVER allowed to pick a different business via header —
  // reject early so a confused client can't fall through to the JWT tenant
  // silently.
  if ('x-business-id' in req.headers) {
    const headerId = parseInt(req.headers['x-business-id'], 10);
    if (Number.isInteger(headerId) && headerId !== businessId) {
      return res.status(403).json({ error: 'Tenant users cannot switch businesses' });
    }
  }

  getBusinessById(businessId)
    .then(business => {
      if (!business) {
        return res.status(403).json({ error: 'Tenant not found' });
      }
      if (!business.is_active || business.status === 'suspended' || business.status === 'cancelled') {
        return res.status(403).json({ error: 'Tenant is not active' });
      }
      req.business = business;
      runWithTenant(
        { businessId: business.id, role: auth.role, userId: auth.user_id, source: 'jwt' },
        () => next()
      );
    })
    .catch(err => {
      console.error('attachTenantFromAuth error:', err.message);
      res.status(500).json({ error: 'Failed to resolve tenant' });
    });
}

/**
 * Resolve a business from an inbound Twilio `To` number.
 *
 * Resolution order (Phase 5 onward; delegates to
 * `getBusinessByTwilioNumber` which does step 1 + 2):
 *   1. `business_phone_numbers.phone_number = To AND status = 'active'`
 *      — the authoritative multi-DID table. Any DID listed here resolves.
 *   2. `businesses.twilio_phone_number = To` — legacy denormalized
 *      fallback for tenants that haven't run migration 003 yet.
 *   3. Bootstrap: if exactly one business exists in the DB, use it. This
 *      keeps Valleymede working before the ops step wires its DID into
 *      `business_phone_numbers`. Once a second tenant is added this path
 *      can no longer fire, which is exactly what CLAUDE.md §3.3 requires.
 *
 * Returns the business row or null.
 */
async function resolveBusinessFromTwilioTo(toNumber) {
  if (toNumber) {
    const direct = await getBusinessByTwilioNumber(toNumber);
    if (direct) return direct;
  }

  // Bootstrap fallback — only fires when there's literally one tenant.
  const count = await countBusinesses();
  if (count === 1) {
    const [sole] = await listActiveBusinesses();
    if (sole) {
      console.warn(
        `[tenant:${sole.id}] PHONE_ROUTE source=single_tenant_bootstrap To=${toNumber} slug=${sole.slug} ` +
        `— neither business_phone_numbers nor businesses.twilio_phone_number matched. ` +
        `Register ${sole.slug}'s DID in business_phone_numbers to retire this fallback.`
      );
      // Tag the source so Twilio route handlers can print it alongside the
      // tenant id without re-deriving the resolution path.
      Object.defineProperty(sole, '_phoneSource', {
        value: 'single_tenant_bootstrap',
        enumerable: false,
        configurable: true
      });
      return sole;
    }
  }
  return null;
}

/**
 * Middleware for Twilio webhooks. Populates `req.business` or responds with
 * a generic TwiML hangup if the `To` number doesn't map to any tenant.
 *
 * Endpoints that need this: /twilio/voice, /twilio/sms. Status callbacks and
 * transfer follow-ups don't carry a meaningful `To`, so they use
 * `attachTenantFromCallSid` (lookup via existing call_logs) instead.
 */
async function attachTenantFromTwilioTo(req, res, next) {
  const to = req.body?.To;
  try {
    const business = await resolveBusinessFromTwilioTo(to);
    if (!business) {
      console.warn(`[tenant] Rejecting Twilio request — no business for To=${to}`);
      res.type('text/xml');
      return res.send(
        `<Response><Say voice="alice">We're sorry, this number is not currently in service. Goodbye.</Say><Hangup/></Response>`
      );
    }
    req.business = business;
    runWithTenant(
      { businessId: business.id, role: 'system', userId: null, source: 'twilio_to' },
      () => next()
    );
  } catch (err) {
    console.error('attachTenantFromTwilioTo error:', err.message);
    res.type('text/xml');
    res.send('<Response><Say voice="alice">Sorry, something went wrong. Please try again.</Say><Hangup/></Response>');
  }
}

/**
 * Fallback resolver for Twilio webhooks that don't carry a `To` (status
 * callbacks, transfer action URLs). Looks up the business_id by CallSid in
 * call_logs. If the CallSid was never registered, falls back to the
 * single-tenant bootstrap rule used by the main resolver.
 */
async function attachTenantFromCallSid(req, res, next) {
  const callSid = req.body?.CallSid || req.body?.ParentCallSid || null;
  try {
    if (callSid) {
      const { query } = require('../config/database');
      const r = await query(
        'SELECT business_id FROM call_logs WHERE twilio_call_sid = $1 ORDER BY id DESC LIMIT 1',
        [callSid]
      );
      if (r.rows[0]?.business_id) {
        const business = await getBusinessById(r.rows[0].business_id);
        if (business) {
          req.business = business;
          return runWithTenant(
            { businessId: business.id, role: 'system', userId: null, source: 'twilio_callsid' },
            () => next()
          );
        }
      }
    }
    // No CallSid mapping — reuse the bootstrap resolver
    const business = await resolveBusinessFromTwilioTo(req.body?.To);
    if (!business) {
      res.type('text/xml');
      return res.send('<Response><Hangup/></Response>');
    }
    req.business = business;
    runWithTenant(
      { businessId: business.id, role: 'system', userId: null, source: 'twilio_callsid' },
      () => next()
    );
  } catch (err) {
    console.error('attachTenantFromCallSid error:', err.message);
    res.type('text/xml');
    res.send('<Response><Hangup/></Response>');
  }
}

/**
 * Verify the `X-Twilio-Signature` header on inbound webhook requests.
 *
 * Behaviour:
 *   - In production (TWILIO_AUTH_TOKEN set, TWILIO_SKIP_VALIDATION !== '1'):
 *     delegates to `twilio.webhook()`, which rejects unsigned / tampered
 *     requests with a 403.
 *   - In local dev (TWILIO_AUTH_TOKEN missing OR TWILIO_SKIP_VALIDATION=1):
 *     skips validation and logs a one-time warning so the operator knows
 *     the server is running in an insecure mode. This preserves the
 *     existing local-dev ergonomics while making prod strict by default.
 *
 * CLAUDE.md §3.3 requires that webhook requests can route to any tenant;
 * allowing unsigned calls in production would let anyone send a crafted
 * POST to /twilio/voice with an arbitrary `To` and impersonate a tenant.
 *
 * This MUST be mounted AFTER `express.urlencoded()` because
 * `twilio.webhook()` computes the signature over the form body.
 */
let _twilioSkipWarned = false;
function validateTwilioSignature(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const skipFlag = process.env.TWILIO_SKIP_VALIDATION === '1';

  if (!token || skipFlag) {
    if (!_twilioSkipWarned) {
      console.warn(
        `[tenant] Twilio signature validation is DISABLED (` +
        `${!token ? 'TWILIO_AUTH_TOKEN not set' : 'TWILIO_SKIP_VALIDATION=1'}). ` +
        `Do NOT run this configuration in production.`
      );
      _twilioSkipWarned = true;
    }
    return next();
  }

  // twilio.webhook() returns a middleware; delegate to it on every call so
  // that behaviour tracks any live changes to TWILIO_AUTH_TOKEN (e.g. a
  // rotation via process manager restart).
  return twilio.webhook({ validate: true })(req, res, next);
}

module.exports = {
  attachTenantFromAuth,
  attachTenantFromTwilioTo,
  attachTenantFromCallSid,
  resolveBusinessFromTwilioTo,
  validateTwilioSignature
};
