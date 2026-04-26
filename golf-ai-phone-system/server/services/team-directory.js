/**
 * Team directory service — per-tenant message routing.
 *
 * Each tenant maintains a small directory of named people who can receive
 * messages left by callers. The AI's `take_message_for_team_member` tool
 * (in grok-voice.js) calls `findTeamMemberByName` during a call to resolve
 * a caller-spoken name to a row, then `sendMessageToTeamMember` to fire an
 * SMS via the existing notification.sendSMS helper.
 *
 * Every helper here requires `businessId` and runs a tenant-scoped query —
 * defense-in-depth for the same reason every other service in this folder
 * does so. A route-level missing predicate would still be safe.
 */
const { query } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');
const { sendSMS } = require('./notification');
const { normalizeToE164 } = require('./caller-lookup');

const NAME_MAX = 80;
const ROLE_MAX = 80;
const NOTES_MAX = 1000;
const SMS_TRANSCRIPT_MAX = 1100; // safe under multi-segment limit

function trimOrNull(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function normalizeAliases(aliases) {
  if (!Array.isArray(aliases)) return [];
  return aliases
    .map(a => (typeof a === 'string' ? a.trim().slice(0, NAME_MAX) : ''))
    .filter(Boolean)
    .slice(0, 10); // cap to avoid runaway lists
}

/**
 * List every team member for a tenant. Optional includeInactive flag
 * surfaces disabled rows for the management UI; the call-time lookup
 * always filters to active rows.
 */
async function listTeamMembers(businessId, { includeInactive = true } = {}) {
  requireBusinessId(businessId, 'listTeamMembers');
  const sql = includeInactive
    ? `SELECT id, business_id, name, role, sms_phone, email, aliases, notes,
              is_active, created_at, updated_at
         FROM business_team_members
        WHERE business_id = $1
        ORDER BY is_active DESC, LOWER(name) ASC`
    : `SELECT id, business_id, name, role, sms_phone, email, aliases, notes,
              is_active, created_at, updated_at
         FROM business_team_members
        WHERE business_id = $1 AND is_active = TRUE
        ORDER BY LOWER(name) ASC`;
  const { rows } = await query(sql, [businessId]);
  return rows;
}

/**
 * Resolve a caller-spoken name to a team member row. Tries:
 *   1. Exact case-insensitive match on `name`
 *   2. Exact case-insensitive match on any entry in `aliases`
 *   3. Substring match on `name` (e.g. caller says "Bobby", row is "Bobby Lee")
 *
 * Only ACTIVE members are matched — disabled rows are invisible to the AI.
 * Returns the row, or null if no unambiguous match.
 *
 * If the search is ambiguous (>1 active member matches), returns
 * { ambiguous: true, candidates: [...] } so the caller can disambiguate.
 */
async function findTeamMemberByName(businessId, spokenName) {
  requireBusinessId(businessId, 'findTeamMemberByName');
  if (typeof spokenName !== 'string' || !spokenName.trim()) return null;
  const needle = spokenName.trim().toLowerCase();

  const { rows } = await query(
    `SELECT id, business_id, name, role, sms_phone, email, aliases, notes,
            is_active, created_at, updated_at
       FROM business_team_members
      WHERE business_id = $1 AND is_active = TRUE`,
    [businessId]
  );

  // Tier 1: exact name
  const exact = rows.find(r => r.name && r.name.toLowerCase() === needle);
  if (exact) return exact;

  // Tier 2: alias exact
  const aliasMatch = rows.find(r =>
    Array.isArray(r.aliases) && r.aliases.some(a => typeof a === 'string' && a.toLowerCase() === needle)
  );
  if (aliasMatch) return aliasMatch;

  // Tier 3: prefix-or-substring on name (and aliases). If multiple match,
  // bail with ambiguous so the AI can ask "did you mean X or Y?".
  const fuzzy = rows.filter(r => {
    if (r.name && r.name.toLowerCase().includes(needle)) return true;
    if (Array.isArray(r.aliases) && r.aliases.some(a => typeof a === 'string' && a.toLowerCase().includes(needle))) return true;
    return false;
  });
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    return { ambiguous: true, candidates: fuzzy.map(r => ({ id: r.id, name: r.name, role: r.role })) };
  }
  return null;
}

async function getTeamMember(businessId, memberId) {
  requireBusinessId(businessId, 'getTeamMember');
  const { rows } = await query(
    `SELECT id, business_id, name, role, sms_phone, email, aliases, notes,
            is_active, created_at, updated_at
       FROM business_team_members
      WHERE business_id = $1 AND id = $2`,
    [businessId, memberId]
  );
  return rows[0] || null;
}

async function createTeamMember(businessId, input) {
  requireBusinessId(businessId, 'createTeamMember');
  const name = trimOrNull(input?.name, NAME_MAX);
  if (!name) throw new Error('name is required');

  const role = trimOrNull(input?.role, ROLE_MAX);
  const rawSms = typeof input?.sms_phone === 'string' ? input.sms_phone : '';
  const smsPhone = normalizeToE164(rawSms);
  if (!smsPhone) throw new Error('sms_phone must be a valid phone number');

  const email = trimOrNull(input?.email, 120);
  const notes = trimOrNull(input?.notes, NOTES_MAX);
  const aliases = normalizeAliases(input?.aliases);
  const isActive = input?.is_active === false ? false : true;

  const { rows } = await query(
    `INSERT INTO business_team_members
        (business_id, name, role, sms_phone, email, aliases, notes, is_active)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING *`,
    [businessId, name, role, smsPhone, email, JSON.stringify(aliases), notes, isActive]
  );
  return rows[0];
}

async function updateTeamMember(businessId, memberId, input) {
  requireBusinessId(businessId, 'updateTeamMember');
  const sets = [];
  const params = [];
  const push = (col, val) => {
    sets.push(`${col} = $${params.length + 1}`);
    params.push(val);
  };

  if ('name' in (input || {})) {
    const name = trimOrNull(input.name, NAME_MAX);
    if (!name) throw new Error('name cannot be empty');
    push('name', name);
  }
  if ('role' in (input || {})) push('role', trimOrNull(input.role, ROLE_MAX));
  if ('sms_phone' in (input || {})) {
    const smsPhone = normalizeToE164(input.sms_phone);
    if (!smsPhone) throw new Error('sms_phone must be a valid phone number');
    push('sms_phone', smsPhone);
  }
  if ('email' in (input || {})) push('email', trimOrNull(input.email, 120));
  if ('notes' in (input || {})) push('notes', trimOrNull(input.notes, NOTES_MAX));
  if ('aliases' in (input || {})) {
    push('aliases', JSON.stringify(normalizeAliases(input.aliases)));
  }
  if ('is_active' in (input || {})) push('is_active', !!input.is_active);

  if (sets.length === 0) {
    return await getTeamMember(businessId, memberId);
  }
  sets.push(`updated_at = NOW()`);
  params.push(businessId, memberId);

  const sql = `
    UPDATE business_team_members
       SET ${sets.join(', ')}
     WHERE business_id = $${params.length - 1}
       AND id = $${params.length}
     RETURNING *`;
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

async function deleteTeamMember(businessId, memberId) {
  requireBusinessId(businessId, 'deleteTeamMember');
  const { rowCount } = await query(
    `DELETE FROM business_team_members
      WHERE business_id = $1 AND id = $2`,
    [businessId, memberId]
  );
  return rowCount > 0;
}

/**
 * Format the SMS body for a message-taken handoff. Keeps under ~1100 chars
 * so it fits a couple of SMS segments and reads well on a phone.
 */
function formatTeamMessageSms({ recipientName, callerName, callerPhone, message, businessName }) {
  const parts = [];
  parts.push(`📞 New message at ${businessName || 'your business'}`);
  parts.push(`For: ${recipientName}`);
  if (callerName) parts.push(`From: ${callerName}`);
  if (callerPhone) parts.push(`Callback: ${callerPhone}`);
  parts.push('');
  parts.push((message || '').slice(0, SMS_TRANSCRIPT_MAX).trim() || '(no transcript captured)');
  return parts.join('\n');
}

/**
 * Send a transcript-of-message SMS to a specific team member. Caller passes
 * the resolved row OR the memberId; we re-fetch for safety either way.
 */
async function sendMessageToTeamMember(businessId, memberId, payload) {
  requireBusinessId(businessId, 'sendMessageToTeamMember');
  const member = await getTeamMember(businessId, memberId);
  if (!member) throw new Error(`Team member ${memberId} not found for business ${businessId}`);
  if (!member.is_active) throw new Error(`Team member ${memberId} is inactive — message not sent`);

  const body = formatTeamMessageSms({
    recipientName: member.name,
    callerName: payload?.callerName,
    callerPhone: payload?.callerPhone,
    message: payload?.message,
    businessName: payload?.businessName
  });

  const result = await sendSMS(businessId, member.sms_phone, body);
  return { delivered: !!result, message_sid: result?.sid || null, recipient: member };
}

module.exports = {
  listTeamMembers,
  findTeamMemberByName,
  getTeamMember,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
  sendMessageToTeamMember,
  formatTeamMessageSms
};
