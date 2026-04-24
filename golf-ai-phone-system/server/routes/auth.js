/**
 * Authentication routes (Phase 3).
 *
 * Endpoints:
 *
 *   POST /auth/login
 *     Public. Email/username + password. Returns a JWT whose payload is
 *     `{ user_id, business_id, role, username }`. Role is one of
 *     'super_admin' | 'business_admin' | 'staff'. Legacy env-var admin
 *     resolves to business_admin + Valleymede.
 *
 *   GET  /auth/verify
 *     Auth-required. Decodes the bearer token and echoes the auth payload
 *     so the front-end can recover session state on reload.
 *
 *   POST /auth/register-super-admin
 *     BOOTSTRAP only. Succeeds once — when the `super_admins` table is
 *     empty — and creates the first platform operator. After that, all
 *     super-admin provisioning goes through the invite flow. Gated by a
 *     one-shot env var `SUPER_ADMIN_BOOTSTRAP_TOKEN` if set, otherwise
 *     open on an empty table (so local dev can bootstrap without friction).
 *
 *   POST /auth/invite
 *     Auth-required. Super admins can invite any role (including other
 *     super_admins or business_admins for a chosen tenant). Business admins
 *     can invite additional business_admins or staff INTO THEIR OWN tenant
 *     only; attempts to invite into another tenant 403. Staff cannot invite.
 *
 *   POST /auth/accept-invite
 *     Public. Exchanges an invite token + password (+ optional name) for a
 *     signed-in session. Creates the super_admins or business_users row,
 *     marks the invite as consumed, and returns a JWT.
 *
 *   GET  /auth/invite/:token
 *     Public. Returns the "safe to show on signup page" subset of the
 *     invite record (email, role, business name if any). Used by the
 *     React signup page to pre-fill the form.
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const {
  requireAuth,
  login,
  createInvite,
  findOpenInviteByToken,
  acceptInvite,
  signSuperAdmin
} = require('../middleware/auth');
const {
  SUPER_ADMIN_ROLE,
  BUSINESS_ADMIN_ROLE,
  STAFF_ROLE,
  ALL_ROLES
} = require('../context/tenant-context');
const { query, getBusinessById } = require('../config/database');
const { logEvent, extractActor } = require('../services/audit-log');

// ----- helpers ---------------------------------------------------------

function buildInviteUrl(req, token) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/accept-invite?token=${encodeURIComponent(token)}`;
}

// ----- POST /auth/login ------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const result = await login(username, password);

    // Attach the tenant's template_key + plan + business_name so the
    // Command Center can pick the right sidebar / dashboard on first
    // render without an extra /auth/verify round-trip. `plan` is the
    // Valleymede safety lock — the UI forces the full golf sidebar when
    // plan='legacy' regardless of template_key, so a DB drift that sets
    // template_key to 'other' never hides Tee Sheet / Bookings from the
    // original tenant. Non-fatal on failure.
    if (Number.isInteger(result.business_id)) {
      try {
        const biz = await getBusinessById(result.business_id);
        if (biz) {
          result.template_key = biz.template_key || null;
          result.plan = biz.plan || null;
          result.business_name = biz.name || null;
        }
      } catch (err) {
        console.warn('[auth/login] template_key lookup failed:', err.message);
      }
    } else {
      result.template_key = null;
      result.plan = null;
    }

    // Audit — fire-and-forget. The login result contains the role +
    // business_id we want on the row. `login()` doesn't hand back the
    // numeric user_id, so we denormalize only what it gives us (email
    // + role + business_id). We intentionally do NOT audit FAILED
    // logins here — that would give an attacker a free "does this
    // email exist" oracle in the audit feed.
    const actor = extractActor(req);
    await logEvent({
      businessId: Number.isInteger(result.business_id) ? result.business_id : null,
      action: 'user.login',
      userType: result.role || null,
      actorEmail: result.username || null,
      targetType: 'user',
      ip: actor.ip,
      userAgent: actor.user_agent,
      meta: { role: result.role }
    });
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

// ----- GET /auth/verify ------------------------------------------------
//
// Rehydrates session state on reload. Adds `template_key` and
// `business_name` for the caller's tenant so the Command Center can
// pick the right sidebar / dashboard without a second round-trip.
// Super admins get template_key = null (they aren't bound to a tenant).
router.get('/verify', requireAuth, async (req, res) => {
  let template_key = null;
  let plan = null;
  let business_name = null;
  if (Number.isInteger(req.auth.business_id) && req.auth.business_id > 0) {
    try {
      const biz = await getBusinessById(req.auth.business_id);
      if (biz) {
        template_key = biz.template_key || null;
        plan = biz.plan || null;
        business_name = biz.name || null;
      }
    } catch (err) {
      // Non-fatal — fall through to null so the UI renders the default
      // (golf) view rather than erroring out on rehydrate.
      console.warn('[auth/verify] template_key lookup failed:', err.message);
    }
  }
  res.json({
    valid: true,
    user: {
      user_id: req.auth.user_id,
      business_id: req.auth.business_id,
      role: req.auth.role,
      username: req.auth.username,
      template_key,
      plan,
      business_name
    }
  });
});

// ----- POST /auth/register-super-admin (bootstrap) ---------------------
//
// Creates the FIRST super admin on an empty `super_admins` table. After
// any row exists, this endpoint always 403s — further super admins must
// come through an invite from an existing one.
router.post('/register-super-admin', async (req, res) => {
  try {
    const { email, password, name, bootstrap_token } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Gate 1: empty table.
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM super_admins');
    if ((rows[0]?.n || 0) > 0) {
      return res.status(403).json({
        error: 'Super admin already provisioned — use /auth/invite + /auth/accept-invite to add more.'
      });
    }

    // Gate 2: optional one-shot token (set by ops via env).
    const expected = process.env.SUPER_ADMIN_BOOTSTRAP_TOKEN;
    if (expected && expected !== bootstrap_token) {
      return res.status(403).json({ error: 'Invalid bootstrap token' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const ins = await query(
      `INSERT INTO super_admins (email, password_hash, name, active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, email, name`,
      [String(email).trim().toLowerCase(), passwordHash, name || null]
    );

    const token = signSuperAdmin(ins.rows[0]);
    res.json({
      token,
      username: ins.rows[0].email,
      name: ins.rows[0].name,
      role: SUPER_ADMIN_ROLE,
      business_id: null
    });
  } catch (err) {
    console.error('register-super-admin error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A super admin with that email already exists' });
    }
    res.status(500).json({ error: 'Failed to register super admin' });
  }
});

// ----- POST /auth/invite -----------------------------------------------
router.post('/invite', requireAuth, async (req, res) => {
  const auth = req.auth;
  if (auth.role === STAFF_ROLE) {
    return res.status(403).json({ error: 'Staff users cannot send invites' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role;
  const targetBusinessId = req.body?.business_id === null || req.body?.business_id === undefined
    ? null
    : parseInt(req.body.business_id, 10);

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  if (!ALL_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${ALL_ROLES.join(', ')}` });
  }

  try {
    let resolvedBusinessId = null;
    let inviter = {};

    if (auth.role === SUPER_ADMIN_ROLE) {
      inviter = { super_admin_id: auth.user_id };
      if (role === SUPER_ADMIN_ROLE) {
        resolvedBusinessId = null;
      } else {
        if (!Number.isInteger(targetBusinessId) || targetBusinessId <= 0) {
          return res.status(400).json({ error: 'business_id is required for tenant invites' });
        }
        const biz = await getBusinessById(targetBusinessId);
        if (!biz) return res.status(404).json({ error: 'Business not found' });
        resolvedBusinessId = biz.id;
      }
    } else {
      // business_admin: own tenant only, and never super_admin role.
      if (role === SUPER_ADMIN_ROLE) {
        return res.status(403).json({ error: 'Only super admins can invite super admins' });
      }
      if (targetBusinessId !== null && targetBusinessId !== auth.business_id) {
        return res.status(403).json({ error: 'Cannot invite into a different tenant' });
      }
      resolvedBusinessId = auth.business_id;
      inviter = { business_user_id: auth.user_id };
    }

    const invite = await createInvite({
      businessId: resolvedBusinessId,
      email,
      role,
      inviter
    });

    const invite_url = buildInviteUrl(req, invite.token);
    console.log(
      `[auth] Invite created: business_id=${resolvedBusinessId}, email=${email}, role=${role}, ` +
      `expires=${new Date(invite.expires_at).toISOString()}`
    );
    const actor = extractActor(req);
    await logEvent({
      businessId: resolvedBusinessId,
      action: 'invite.created',
      userId: auth.user_id,
      userType: actor.user_type,
      actorEmail: actor.actor_email,
      targetType: 'invite',
      targetId: invite.id,
      ip: actor.ip,
      userAgent: actor.user_agent,
      meta: {
        email: invite.email,
        role: invite.role,
        expires_at: invite.expires_at,
        source: auth.role === SUPER_ADMIN_ROLE ? 'super_admin_auth_invite' : 'business_admin_auth_invite'
      }
    });
    res.json({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      business_id: invite.business_id,
      expires_at: invite.expires_at,
      token: invite.token,
      invite_url
    });
  } catch (err) {
    console.error('invite error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to create invite' });
  }
});

// ----- GET /auth/invite/:token (public) --------------------------------
router.get('/invite/:token', async (req, res) => {
  try {
    const invite = await findOpenInviteByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invite not found or expired' });
    let businessName = null;
    if (invite.business_id) {
      const biz = await getBusinessById(invite.business_id);
      businessName = biz?.name || null;
    }
    res.json({
      email: invite.email,
      role: invite.role,
      business_id: invite.business_id,
      business_name: businessName,
      expires_at: invite.expires_at
    });
  } catch (err) {
    console.error('GET invite error:', err.message);
    res.status(500).json({ error: 'Failed to load invite' });
  }
});

// ----- POST /auth/accept-invite ----------------------------------------
router.post('/accept-invite', async (req, res) => {
  try {
    const { token, password, name } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: 'token and password are required' });
    }
    const invite = await findOpenInviteByToken(token);
    if (!invite) return res.status(404).json({ error: 'Invite not found or expired' });

    const session = await acceptInvite(invite, { password, name });
    // Audit — invite acceptance is a user-creation moment. The actor
    // IS the invitee (this is a public endpoint), so we stamp email
    // + role directly from the session, and the inviting super_admin
    // is preserved in meta for traceability.
    const actor = extractActor(req);
    await logEvent({
      businessId: Number.isInteger(session.business_id) ? session.business_id : null,
      action: 'invite.accepted',
      userType: session.role || null,
      actorEmail: session.username || invite.email || null,
      targetType: 'invite',
      targetId: invite.id,
      ip: actor.ip,
      userAgent: actor.user_agent,
      meta: {
        role: session.role,
        invite_id: invite.id,
        invited_by_super_admin_id: invite.invited_by_super_admin_id || null,
        invited_by_business_user_id: invite.invited_by_business_user_id || null
      }
    });
    res.json(session);
  } catch (err) {
    console.error('accept-invite error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to accept invite' });
  }
});

module.exports = router;
