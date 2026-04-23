/**
 * Authentication middleware + login / invite helpers.
 *
 * JWT payload shape (Phase 3):
 *   {
 *     user_id:     number | null,   // super_admins.id OR business_users.id
 *     business_id: number | null,   // tenant id; null for super_admin tokens
 *     role:        'super_admin' | 'business_admin' | 'staff',
 *     username:    string            // email (for business/super users) or env-admin username
 *   }
 *
 * `req.auth` is populated by `requireAuth`. `req.user` remains a back-compat
 * alias so any older handler that still reads it keeps working. Legacy
 * tokens minted during Phase 2 used `role: 'owner'` — we normalize those to
 * `business_admin` on decode so the front-end only ever has to reason about
 * the Phase 3 vocabulary.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const { query } = require('../config/database');
const {
  VALLEYMEDE_BUSINESS_ID,
  SUPER_ADMIN_ROLE,
  BUSINESS_ADMIN_ROLE,
  STAFF_ROLE,
  ALL_ROLES,
  isBusinessAdminRole
} = require('../context/tenant-context');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const INVITE_TTL_DAYS = parseInt(process.env.INVITE_TTL_DAYS || '7', 10);
const BCRYPT_ROUNDS = 10;

/**
 * Normalize a role string to the Phase 3 vocabulary. Unknown roles collapse
 * to 'staff' — safer to over-restrict than over-grant.
 */
function normalizeRole(raw) {
  if (raw === SUPER_ADMIN_ROLE) return SUPER_ADMIN_ROLE;
  if (isBusinessAdminRole(raw)) return BUSINESS_ADMIN_ROLE; // covers 'owner' legacy
  if (raw === STAFF_ROLE) return STAFF_ROLE;
  return STAFF_ROLE;
}

/**
 * Verify the Bearer JWT and populate `req.auth`.
 * Rejects the request with 401 if the token is missing, invalid, or expired.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const role = normalizeRole(decoded.role);

    // Super-admin tokens carry business_id = null. Every other token MUST
    // carry a positive integer business_id — older Phase 2 tokens without
    // one are rejected so we never silently grant Valleymede access to a
    // stale token minted before the field existed.
    let businessId = null;
    if (role === SUPER_ADMIN_ROLE) {
      businessId = null;
    } else if (Number.isInteger(decoded.business_id) && decoded.business_id > 0) {
      businessId = decoded.business_id;
    } else if (decoded.legacy === true) {
      // Legacy env-var admin token — always Valleymede.
      businessId = VALLEYMEDE_BUSINESS_ID;
    } else {
      return res.status(401).json({ error: 'Token is missing tenant binding — please sign in again' });
    }

    req.auth = {
      user_id: decoded.user_id || null,
      business_id: businessId,
      role,
      username: decoded.username || null,
      super_admin: role === SUPER_ADMIN_ROLE
    };

    // Back-compat alias so any code still referencing req.user keeps working.
    req.user = { ...decoded, ...req.auth };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Gate routes that require platform-operator privileges (cross-tenant admin).
 * Must be chained AFTER requireAuth.
 */
function requireSuperAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== SUPER_ADMIN_ROLE) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

/**
 * Role-based gate. Usage:
 *   router.post('/foo', requireAuth, requireRole('business_admin'), handler);
 *
 * super_admin always passes — they are the superset of everything. Pass an
 * array to allow any-of.
 */
function requireRole(allowed) {
  const allowedList = Array.isArray(allowed) ? allowed : [allowed];
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
    if (req.auth.role === SUPER_ADMIN_ROLE) return next();
    if (allowedList.includes(req.auth.role)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

/**
 * Mint a JWT for a business_users row.
 */
function signBusinessUser(row) {
  const role = normalizeRole(row.role);
  return jwt.sign(
    { user_id: row.id, business_id: row.business_id, role, username: row.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/** Mint a JWT for a super_admins row. */
function signSuperAdmin(row) {
  return jwt.sign(
    { user_id: row.id, business_id: null, role: SUPER_ADMIN_ROLE, username: row.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Validate credentials and mint a JWT.
 *
 * Resolution order (identical to Phase 2 plus role normalization):
 *   1. `business_users` by lowercased email
 *   2. `super_admins` by lowercased email
 *   3. Legacy env-var admin → Valleymede business_admin
 */
async function login(usernameOrEmail, password) {
  const identity = String(usernameOrEmail || '').trim().toLowerCase();

  // 1. business_users
  try {
    const res = await query(
      `SELECT id, business_id, email, password_hash, role, name, active
         FROM business_users
        WHERE LOWER(email) = $1
        LIMIT 1`,
      [identity]
    );
    const u = res.rows[0];
    if (u && u.active) {
      const ok = u.password_hash.startsWith('$2')
        ? await bcrypt.compare(password, u.password_hash)
        : password === u.password_hash;
      if (!ok) throw new Error('Invalid credentials');

      await query('UPDATE business_users SET last_login_at = NOW() WHERE id = $1', [u.id])
        .catch(err => console.warn('Could not record last_login_at:', err.message));

      const role = normalizeRole(u.role);
      const token = signBusinessUser({ ...u, role });
      return {
        token,
        username: u.email,
        name: u.name,
        role,
        business_id: u.business_id
      };
    }
  } catch (err) {
    if (err.message === 'Invalid credentials') throw err;
    if (!/does not exist|relation|undefined/i.test(err.message)) {
      console.warn('business_users lookup failed:', err.message);
    }
  }

  // 2. super_admins
  try {
    const res = await query(
      `SELECT id, email, password_hash, name, active
         FROM super_admins
        WHERE LOWER(email) = $1
        LIMIT 1`,
      [identity]
    );
    const sa = res.rows[0];
    if (sa && sa.active) {
      const ok = sa.password_hash.startsWith('$2')
        ? await bcrypt.compare(password, sa.password_hash)
        : password === sa.password_hash;
      if (!ok) throw new Error('Invalid credentials');

      await query('UPDATE super_admins SET last_login_at = NOW() WHERE id = $1', [sa.id])
        .catch(err => console.warn('Could not record last_login_at:', err.message));

      const token = signSuperAdmin(sa);
      return {
        token,
        username: sa.email,
        name: sa.name,
        role: SUPER_ADMIN_ROLE,
        business_id: null
      };
    }
  } catch (err) {
    if (err.message === 'Invalid credentials') throw err;
    if (!/does not exist|relation|undefined/i.test(err.message)) {
      console.warn('super_admins lookup failed:', err.message);
    }
  }

  // 3. Legacy env-var admin → Valleymede business_admin.
  // This keeps the existing single-tenant Command Center login working
  // until Valleymede's staff are migrated into `business_users`.
  const adminUser = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD || 'admin';
  if (identity === adminUser) {
    const ok = adminPass.startsWith('$2')
      ? await bcrypt.compare(password, adminPass)
      : password === adminPass;
    if (!ok) throw new Error('Invalid credentials');

    const token = jwt.sign(
      {
        user_id: null,
        business_id: VALLEYMEDE_BUSINESS_ID,
        role: BUSINESS_ADMIN_ROLE,
        username: adminUser,
        legacy: true
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    return {
      token,
      username: adminUser,
      name: 'Admin',
      role: BUSINESS_ADMIN_ROLE,
      business_id: VALLEYMEDE_BUSINESS_ID
    };
  }

  throw new Error('Invalid credentials');
}

// ============================================================================
// Invites (magic-link signup)
// ============================================================================

/**
 * Generate a cryptographically-strong invite token. 32 random bytes → 43
 * chars of base64url, which is comfortably fits under the VARCHAR(120)
 * `user_invites.token` column.
 */
function newInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Create a user_invites row. Returns the plaintext token so the caller
 * can build the accept-invite URL.
 *
 * If an outstanding (un-accepted) invite already exists for the same
 * (business_id, email), we rotate the token rather than creating a
 * duplicate — the partial unique index enforces this.
 *
 * Params:
 *   - businessId: number | null (null = super-admin invite)
 *   - email
 *   - role
 *   - inviter: { super_admin_id | business_user_id }
 */
async function createInvite({ businessId, email, role, inviter }) {
  if (!email) throw new Error('email required');
  if (!ALL_ROLES.includes(role)) throw new Error(`role must be one of ${ALL_ROLES.join(', ')}`);
  if (role === SUPER_ADMIN_ROLE && businessId !== null) {
    throw new Error('super_admin invites must have businessId === null');
  }
  if (role !== SUPER_ADMIN_ROLE && (!Number.isInteger(businessId) || businessId <= 0)) {
    throw new Error('tenant invites must carry a positive businessId');
  }

  const token = newInviteToken();
  const ttlMs = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);

  // Upsert-style: nuke any previous open invite for the same target, then
  // insert. Simpler than juggling the partial unique index.
  await query(
    `DELETE FROM user_invites
      WHERE COALESCE(business_id, 0) = COALESCE($1::int, 0)
        AND LOWER(email) = LOWER($2)
        AND accepted_at IS NULL`,
    [businessId, email]
  );

  const res = await query(
    `INSERT INTO user_invites
       (business_id, email, role, token, invited_by_super_admin_id,
        invited_by_business_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, business_id, email, role, token, expires_at, created_at`,
    [
      businessId,
      email,
      role,
      token,
      inviter?.super_admin_id || null,
      inviter?.business_user_id || null,
      expiresAt
    ]
  );
  return res.rows[0];
}

/**
 * Look up an outstanding invite by token. Returns the row or null.
 * Does NOT mark the invite as accepted — that's `acceptInvite`'s job.
 */
async function findOpenInviteByToken(token) {
  if (!token) return null;
  const res = await query(
    `SELECT * FROM user_invites
      WHERE token = $1
        AND accepted_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [token]
  );
  return res.rows[0] || null;
}

/**
 * Consume an invite: create the super_admin or business_user row, stamp
 * `accepted_at` / `accepted_user_id`, and return a freshly-minted JWT.
 * Runs in a single transaction so a halfway failure can't leave a
 * half-accepted invite lying around.
 *
 * Pre-condition: `invite` is a fresh row from `findOpenInviteByToken`.
 */
async function acceptInvite(invite, { password, name }) {
  if (!invite) throw new Error('invite required');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');

  const { pool } = require('../config/database');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let createdId;
    let loginPayload;

    if (invite.role === SUPER_ADMIN_ROLE) {
      const ins = await client.query(
        `INSERT INTO super_admins (email, password_hash, name, active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               name = COALESCE(EXCLUDED.name, super_admins.name),
               active = TRUE
         RETURNING id, email, name`,
        [invite.email, passwordHash, name || null]
      );
      createdId = ins.rows[0].id;
      loginPayload = {
        token: signSuperAdmin(ins.rows[0]),
        username: ins.rows[0].email,
        name: ins.rows[0].name,
        role: SUPER_ADMIN_ROLE,
        business_id: null
      };
    } else {
      // business_admin | staff
      const ins = await client.query(
        `INSERT INTO business_users (business_id, email, password_hash, name, role, active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (business_id, email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               name = COALESCE(EXCLUDED.name, business_users.name),
               role = EXCLUDED.role,
               active = TRUE
         RETURNING id, business_id, email, name, role`,
        [invite.business_id, invite.email, passwordHash, name || null, invite.role]
      );
      createdId = ins.rows[0].id;
      // Accepting a business_admin invite completes tenant setup.
      if (invite.role === BUSINESS_ADMIN_ROLE) {
        await client.query(
          'UPDATE businesses SET setup_complete = TRUE WHERE id = $1',
          [invite.business_id]
        );
      }
      loginPayload = {
        token: signBusinessUser(ins.rows[0]),
        username: ins.rows[0].email,
        name: ins.rows[0].name,
        role: normalizeRole(ins.rows[0].role),
        business_id: ins.rows[0].business_id
      };
    }

    await client.query(
      `UPDATE user_invites
          SET accepted_at = NOW(), accepted_user_id = $1
        WHERE id = $2`,
      [createdId, invite.id]
    );
    await client.query('COMMIT');
    return loginPayload;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  requireRole,
  login,
  normalizeRole,
  // invites
  createInvite,
  findOpenInviteByToken,
  acceptInvite,
  // helpers used by routes
  signBusinessUser,
  signSuperAdmin,
  JWT_SECRET,
  JWT_EXPIRES_IN
};
