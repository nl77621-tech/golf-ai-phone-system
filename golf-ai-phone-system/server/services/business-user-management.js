/**
 * Business User Management — shared CRUD + password helpers.
 *
 * Used by BOTH:
 *   - Super-admin path: routes/super-admin.js → /api/super/businesses/:id/users/*
 *     (super-admin manages users on any tenant)
 *   - Tenant path: routes/api.js → /api/users/*
 *     (a business_admin manages users on their OWN tenant)
 *
 * Every helper takes `businessId` as its first arg and runs tenant-scoped
 * queries (`WHERE business_id = $businessId`). Same defense-in-depth as
 * every other service in this folder. The route layer enforces who the
 * caller is (requireBusinessAdmin vs requireSuperAdmin); this module
 * just guarantees the SQL never accidentally crosses tenants.
 *
 * Plaintext passwords are returned exactly ONCE per call (when created
 * or reset) so the caller can show them to the operator. They're never
 * logged or persisted unhashed.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, getBusinessById } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');
const { sendSMS } = require('./notification');
const { normalizeToE164 } = require('./caller-lookup');

const BCRYPT_ROUNDS = 10;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

// 14-char URL-safe-ish alphabet without ambiguous chars (0/O, 1/l/I)
// so dictating it over the phone is less error-prone.
function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (let i = 0; i < 14; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function validateSuppliedPassword(p) {
  if (typeof p !== 'string') return 'password must be a string';
  if (p.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (p.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  if (/\s/.test(p)) return 'password cannot contain whitespace';
  return null;
}

// Build the sign-in URL pre-filled with the user's email. We accept the
// request as input (not a hardcoded base URL) so this works on any
// deployment — Railway preview, custom domain, localhost, anything.
function buildSigninUrl(req, email) {
  if (!req || !email) return null;
  const proto = (req.headers?.['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0].trim();
  const host = req.get?.('host');
  if (!host) return null;
  return `${proto}://${host}/?email=${encodeURIComponent(email)}`;
}

async function listUsers(businessId) {
  requireBusinessId(businessId, 'business-user.listUsers');
  const { rows } = await query(
    `SELECT id, email, name, role,
            active AS is_active,
            last_login_at, created_at
       FROM business_users
      WHERE business_id = $1
      ORDER BY active DESC, LOWER(email) ASC`,
    [businessId]
  );
  return rows;
}

async function getUser(businessId, userId) {
  requireBusinessId(businessId, 'business-user.getUser');
  const { rows } = await query(
    `SELECT id, email, name, role, business_id,
            active AS is_active
       FROM business_users
      WHERE id = $1 AND business_id = $2
      LIMIT 1`,
    [userId, businessId]
  );
  return rows[0] || null;
}

// Errors thrown here carry a `.code` property the route layer maps to
// HTTP status: 'INVALID' → 400, 'CONFLICT' → 409, 'NOT_FOUND' → 404.
class UserMgmtError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

async function createUser(businessId, input = {}) {
  requireBusinessId(businessId, 'business-user.createUser');
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UserMgmtError('INVALID', 'A valid email is required');
  }
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : null;
  const rawRole = typeof input.role === 'string' ? input.role.trim() : 'business_admin';
  const role = rawRole === 'staff' || rawRole === 'business_admin' ? rawRole : 'business_admin';

  const wantGenerate = input.generate === true;
  const supplied = typeof input.password === 'string' ? input.password : null;
  if (!wantGenerate && !supplied) {
    throw new UserMgmtError('INVALID', 'Provide either { password: "..." } or { generate: true }');
  }
  let plaintext;
  if (supplied) {
    const err = validateSuppliedPassword(supplied);
    if (err) throw new UserMgmtError('INVALID', err);
    plaintext = supplied;
  } else {
    plaintext = generateTempPassword();
  }

  const biz = await getBusinessById(businessId);
  if (!biz) throw new UserMgmtError('NOT_FOUND', 'Business not found');

  const passwordHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
  try {
    const { rows } = await query(
      `INSERT INTO business_users (business_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, active AS is_active, created_at`,
      [businessId, email, passwordHash, name, role]
    );
    return { user: rows[0], plaintext, generated: !supplied };
  } catch (err) {
    if (err.code === '23505') {
      throw new UserMgmtError('CONFLICT', `A user with email "${email}" already exists on this tenant.`);
    }
    throw err;
  }
}

async function setActive(businessId, userId, isActive) {
  requireBusinessId(businessId, 'business-user.setActive');
  const { rows } = await query(
    `UPDATE business_users
        SET active = $1
      WHERE id = $2 AND business_id = $3
      RETURNING id, email, name, role, active AS is_active`,
    [!!isActive, userId, businessId]
  );
  if (rows.length === 0) throw new UserMgmtError('NOT_FOUND', 'User not found in this tenant');
  return rows[0];
}

// Hard-delete with last-active-admin guard. Counting only ACTIVE admins
// because disabled ones can't sign in anyway — they're not the safety net.
async function deleteUser(businessId, userId) {
  requireBusinessId(businessId, 'business-user.deleteUser');
  const user = await getUser(businessId, userId);
  if (!user) throw new UserMgmtError('NOT_FOUND', 'User not found in this tenant');
  if (user.role === 'business_admin' && user.is_active) {
    const { rows: [count] } = await query(
      `SELECT COUNT(*)::int AS n
         FROM business_users
        WHERE business_id = $1 AND role = 'business_admin' AND active = TRUE`,
      [businessId]
    );
    if ((count?.n || 0) <= 1) {
      throw new UserMgmtError(
        'CONFLICT',
        'Cannot delete the last active business admin — this would lock the tenant out. Add another admin first, then remove this one.'
      );
    }
  }
  await query(
    `DELETE FROM business_users WHERE id = $1 AND business_id = $2`,
    [userId, businessId]
  );
  return user; // pre-delete snapshot for audit log
}

async function resetPassword(businessId, userId, input = {}) {
  requireBusinessId(businessId, 'business-user.resetPassword');
  const wantGenerate = input.generate === true;
  const supplied = typeof input.password === 'string' ? input.password : null;
  if (!wantGenerate && !supplied) {
    throw new UserMgmtError('INVALID', 'Provide either { password: "..." } or { generate: true }');
  }
  let plaintext;
  if (supplied) {
    const err = validateSuppliedPassword(supplied);
    if (err) throw new UserMgmtError('INVALID', err);
    plaintext = supplied;
  } else {
    plaintext = generateTempPassword();
  }
  const user = await getUser(businessId, userId);
  if (!user) throw new UserMgmtError('NOT_FOUND', 'User not found in this tenant');

  const passwordHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
  await query(
    `UPDATE business_users
        SET password_hash = $1
      WHERE id = $2 AND business_id = $3`,
    [passwordHash, userId, businessId]
  );
  return { user, plaintext, generated: !supplied };
}

// Compose + dispatch credentials SMS via notification.sendSMS, which
// uses the tenant's primary Twilio number as the From. Password is
// only used to compose the message body — it's not logged or stored.
async function dispatchCredentialsSms(businessId, userId, { to, password, signinUrl } = {}) {
  requireBusinessId(businessId, 'business-user.dispatchCredentialsSms');
  const e164 = normalizeToE164(to || '');
  if (!e164) throw new UserMgmtError('INVALID', 'to must be a valid phone number (E.164 — e.g. +14165551234)');
  if (typeof password !== 'string' || !password) {
    throw new UserMgmtError('INVALID', 'password is required (the value to text to the user)');
  }

  const user = await getUser(businessId, userId);
  if (!user) throw new UserMgmtError('NOT_FOUND', 'User not found in this tenant');
  const business = await getBusinessById(businessId);
  const tenantName = business?.name || 'your account';
  const greeting = user.name ? `Hi ${user.name.split(' ')[0]}` : 'Hi';

  const lines = [`${greeting}, your ${tenantName} account is ready.`];
  if (signinUrl && typeof signinUrl === 'string') lines.push(`Sign in: ${signinUrl.trim()}`);
  lines.push(`Email: ${user.email}`);
  lines.push(`Temporary password: ${password}`);
  lines.push('Please sign in and change your password.');
  const body = lines.join('\n');

  const result = await sendSMS(businessId, e164, body);
  if (!result) {
    throw new UserMgmtError(
      'INVALID',
      'SMS dispatch returned no result — check that Twilio is configured and the tenant has a primary phone number.'
    );
  }
  return { user, to: e164, message_sid: result.sid || null, from: result.from || null };
}

module.exports = {
  listUsers,
  getUser,
  createUser,
  setActive,
  deleteUser,
  resetPassword,
  dispatchCredentialsSms,
  buildSigninUrl,
  generateTempPassword,
  validateSuppliedPassword,
  UserMgmtError
};
