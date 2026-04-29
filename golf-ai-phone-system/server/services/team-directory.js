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
const { pool, query } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');
const { sendSMS, sendEmail } = require('./notification');
// caller-lookup exports `normalizePhone` (not `normalizeToE164`).
// Both names mean the same thing — accept any reasonable input and
// return +1XXXXXXXXXX. We alias to E164 here so the rest of this
// file reads cleanly.
const { normalizePhone: normalizeToE164 } = require('./caller-lookup');
// Live updates — same eventBus the booking-manager uses to push booking
// changes to open Command Center tabs. Failing publish is non-fatal.
const eventBus = require('./event-bus');

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
// Columns we always read back. Centralized so a future column doesn't get
// silently omitted from one query — every consumer expects the full row.
const MEMBER_COLUMNS = `
  id, business_id, name, role, sms_phone, email,
  sms_enabled, email_enabled, is_default_recipient,
  aliases, notes, is_active, created_at, updated_at
`.trim();

async function listTeamMembers(businessId, { includeInactive = true } = {}) {
  requireBusinessId(businessId, 'listTeamMembers');
  const sql = includeInactive
    ? `SELECT ${MEMBER_COLUMNS}
         FROM business_team_members
        WHERE business_id = $1
        ORDER BY is_default_recipient DESC, is_active DESC, LOWER(name) ASC`
    : `SELECT ${MEMBER_COLUMNS}
         FROM business_team_members
        WHERE business_id = $1 AND is_active = TRUE
        ORDER BY is_default_recipient DESC, LOWER(name) ASC`;
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
    `SELECT ${MEMBER_COLUMNS}
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
    `SELECT ${MEMBER_COLUMNS}
       FROM business_team_members
      WHERE business_id = $1 AND id = $2`,
    [businessId, memberId]
  );
  return rows[0] || null;
}

/**
 * Return the active default-recipient row for a tenant, or null.
 * Used by the AI's take-message executor: when a spoken name doesn't
 * match anyone, the message routes here so nothing is dropped.
 */
async function getDefaultRecipient(businessId) {
  requireBusinessId(businessId, 'getDefaultRecipient');
  const { rows } = await query(
    `SELECT ${MEMBER_COLUMNS}
       FROM business_team_members
      WHERE business_id = $1
        AND is_default_recipient = TRUE
        AND is_active = TRUE
      LIMIT 1`,
    [businessId]
  );
  return rows[0] || null;
}

/**
 * Create a team member.
 *
 * sms_phone is now optional — an email-only contact (e.g. accounting) is
 * fine, but at least one of sms_phone or email must be present (the DB
 * also enforces this via business_team_members_at_least_one_channel).
 *
 * is_default_recipient: if true and another active default exists for
 * this tenant, the existing default is cleared first inside a single
 * transaction so the partial unique index doesn't reject the insert.
 */
async function createTeamMember(businessId, input) {
  requireBusinessId(businessId, 'createTeamMember');
  const name = trimOrNull(input?.name, NAME_MAX);
  if (!name) throw new Error('name is required');

  const role = trimOrNull(input?.role, ROLE_MAX);

  // Phone is optional now — only validate format when something was supplied.
  let smsPhone = null;
  if (input?.sms_phone && String(input.sms_phone).trim()) {
    smsPhone = normalizeToE164(input.sms_phone);
    if (!smsPhone) throw new Error('sms_phone must be a valid phone number');
  }

  const email = trimOrNull(input?.email, 120);
  if (!smsPhone && !email) {
    throw new Error('Provide a phone number or an email — every team member needs at least one channel.');
  }

  const notes = trimOrNull(input?.notes, NOTES_MAX);
  const aliases = normalizeAliases(input?.aliases);
  const isActive = input?.is_active === false ? false : true;
  const smsEnabled = input?.sms_enabled === false ? false : !!smsPhone;
  const emailEnabled = input?.email_enabled === false ? false : !!email;
  const isDefault = !!input?.is_default_recipient;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isDefault) {
      // Clear any existing default for this tenant first so the partial
      // unique index doesn't reject the insert.
      await client.query(
        `UPDATE business_team_members
            SET is_default_recipient = FALSE, updated_at = NOW()
          WHERE business_id = $1 AND is_default_recipient = TRUE`,
        [businessId]
      );
    }
    const { rows } = await client.query(
      `INSERT INTO business_team_members
          (business_id, name, role, sms_phone, email,
           sms_enabled, email_enabled, is_default_recipient,
           aliases, notes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       RETURNING *`,
      [businessId, name, role, smsPhone, email,
       smsEnabled, emailEnabled, isDefault,
       JSON.stringify(aliases), notes, isActive]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
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
    // Allow clearing the phone (email-only contact) by passing '' or null.
    if (input.sms_phone === null || input.sms_phone === '') {
      push('sms_phone', null);
    } else {
      const smsPhone = normalizeToE164(input.sms_phone);
      if (!smsPhone) throw new Error('sms_phone must be a valid phone number');
      push('sms_phone', smsPhone);
    }
  }
  if ('email' in (input || {})) push('email', trimOrNull(input.email, 120));
  if ('sms_enabled' in (input || {})) push('sms_enabled', !!input.sms_enabled);
  if ('email_enabled' in (input || {})) push('email_enabled', !!input.email_enabled);
  if ('notes' in (input || {})) push('notes', trimOrNull(input.notes, NOTES_MAX));
  if ('aliases' in (input || {})) {
    push('aliases', JSON.stringify(normalizeAliases(input.aliases)));
  }
  if ('is_active' in (input || {})) push('is_active', !!input.is_active);

  // is_default_recipient toggle is special — switching ON requires clearing
  // the previous default to satisfy the partial unique index. We do that
  // inside a transaction so the tenant never has zero or two defaults.
  const flippingDefaultOn = 'is_default_recipient' in (input || {}) && !!input.is_default_recipient;
  const flippingDefaultOff = 'is_default_recipient' in (input || {}) && !input.is_default_recipient;

  if (sets.length === 0 && !flippingDefaultOn && !flippingDefaultOff) {
    return await getTeamMember(businessId, memberId);
  }

  if (flippingDefaultOff) {
    push('is_default_recipient', false);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (flippingDefaultOn) {
      await client.query(
        `UPDATE business_team_members
            SET is_default_recipient = FALSE, updated_at = NOW()
          WHERE business_id = $1
            AND is_default_recipient = TRUE
            AND id <> $2`,
        [businessId, memberId]
      );
      push('is_default_recipient', true);
    }

    if (sets.length === 0) {
      // Only the no-op "set default off when it was already off" path —
      // re-fetch and return.
      await client.query('COMMIT');
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
    const { rows } = await client.query(sql, params);
    await client.query('COMMIT');
    return rows[0] || null;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
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
 * Format an HTML email body for a message-taken handoff. Plain enough that
 * a recipient can scan it on their phone, but readable on desktop too.
 */
function formatTeamMessageEmail({ recipientName, callerName, callerPhone, message, businessName, routedToDefault }) {
  // Escape every HTML-significant char including quotes — defense-in-depth
  // for attribute contexts like `href="tel:${safe(callerPhone)}"`. callerPhone
  // is upstream-normalized to E.164 (digits + leading +) so a `"` here is
  // theoretical, but a one-char addition closes the gap.
  const safe = (s) => String(s || '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const headerNote = routedToDefault
    ? `<p style="margin:0 0 12px; color:#92400e; background:#fef3c7; padding:8px 12px; border-radius:6px; font-size:13px;">⚠️ The caller didn't name a specific person, so this was routed to you as the default recipient.</p>`
    : '';
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif; max-width:520px; color:#111;">
      <h2 style="margin:0 0 8px; font-size:18px;">📞 New message at ${safe(businessName || 'your business')}</h2>
      ${headerNote}
      <table style="border-collapse:collapse; font-size:14px; margin-top:8px;">
        <tr><td style="padding:4px 12px 4px 0; font-weight:600;">For:</td><td style="padding:4px 0;">${safe(recipientName)}</td></tr>
        ${callerName ? `<tr><td style="padding:4px 12px 4px 0; font-weight:600;">From:</td><td style="padding:4px 0;">${safe(callerName)}</td></tr>` : ''}
        ${callerPhone ? `<tr><td style="padding:4px 12px 4px 0; font-weight:600;">Callback:</td><td style="padding:4px 0;"><a href="tel:${safe(callerPhone)}" style="color:#2563eb; text-decoration:none;">${safe(callerPhone)}</a></td></tr>` : ''}
      </table>
      <div style="margin-top:14px; padding:12px; background:#f3f4f6; border-radius:8px; white-space:pre-wrap; font-size:14px; line-height:1.5;">${safe(message || '(no transcript captured)')}</div>
    </div>
  `;
}

/**
 * Persist + dispatch a message taken on behalf of a team member.
 *
 * Two reasons we always insert into team_messages BEFORE attempting
 * SMS/email:
 *   1. Audit trail — if the carrier eats the SMS we still have the row.
 *   2. The Messages page in Command Center is the source of truth so
 *      ops can re-deliver from the dashboard if a recipient missed it.
 *
 * Channel selection per member:
 *   - sms_enabled  + sms_phone present → SMS attempted
 *   - email_enabled + email present    → email attempted
 *   - if neither attempt is possible (member has no enabled channel),
 *     status stays 'dashboard_only' so the message lives in the UI.
 *
 * Caller passes either the resolved row OR memberId; we re-fetch for
 * safety so a stale `member` object can't bypass the active check.
 */
async function sendMessageToTeamMember(businessId, memberId, payload) {
  requireBusinessId(businessId, 'sendMessageToTeamMember');
  const member = await getTeamMember(businessId, memberId);
  if (!member) throw new Error(`Team member ${memberId} not found for business ${businessId}`);
  if (!member.is_active) throw new Error(`Team member ${memberId} is inactive — message not sent`);

  const callerName = payload?.callerName || null;
  const callerPhone = payload?.callerPhone || null;
  const messageBody = (payload?.message || '').toString();
  const businessName = payload?.businessName || null;
  const routedToDefault = !!payload?.routedToDefault;
  const callId = Number.isInteger(payload?.callId) ? payload.callId : null;

  // Decide which channels we'll try.
  const willSendSms = !!(member.sms_enabled && member.sms_phone);
  const willSendEmail = !!(member.email_enabled && member.email);
  const channelLabel =
    willSendSms && willSendEmail ? 'both'
    : willSendSms ? 'sms'
    : willSendEmail ? 'email'
    : 'dashboard_only';

  // 1) Persist the row up front — even before dispatch attempts. If the
  //    Twilio API call hangs, we still have the message in the dashboard.
  const insertRes = await query(
    `INSERT INTO team_messages
        (business_id, recipient_id, recipient_name, caller_name, caller_phone,
         body, channel, status, routed_to_default, call_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
     RETURNING id`,
    [businessId, member.id, member.name, callerName, callerPhone,
     messageBody, channelLabel, routedToDefault, callId]
  );
  const messageRowId = insertRes.rows[0].id;

  // Live broadcast — every Command Center tab open on this tenant
  // gets a `team_message.created` event so the Messages page can
  // re-fetch without polling. Best-effort: a publish failure must not
  // affect SMS/email dispatch below.
  try {
    eventBus.publish(businessId, 'team_message.created', {
      id: messageRowId,
      recipient_id: member.id,
      recipient_name: member.name,
      caller_name: callerName,
      channel: channelLabel,
      routed_to_default: routedToDefault
    });
  } catch (_) { /* swallow — SSE failure must not break call flow */ }

  // 2) Fire each channel best-effort. Failures don't throw — they get
  //    captured into delivery_detail and the row's final status reflects
  //    the partial state ("sent" / "partial" / "failed" / "dashboard_only").
  const detail = {};
  let smsOk = null;
  let emailOk = null;

  if (willSendSms) {
    try {
      const smsBody = formatTeamMessageSms({
        recipientName: member.name,
        callerName,
        callerPhone,
        message: messageBody,
        businessName
      });
      const result = await sendSMS(businessId, member.sms_phone, smsBody);
      smsOk = !!result;
      detail.sms = { ok: smsOk, sid: result?.sid || null, to: member.sms_phone };
    } catch (err) {
      smsOk = false;
      detail.sms = { ok: false, error: err.message, to: member.sms_phone };
    }
  }

  if (willSendEmail) {
    try {
      const html = formatTeamMessageEmail({
        recipientName: member.name,
        callerName,
        callerPhone,
        message: messageBody,
        businessName,
        routedToDefault
      });
      const subject = `New message for ${member.name}${callerName ? ` from ${callerName}` : ''}`;
      const result = await sendEmail(businessId, member.email, subject, html);
      emailOk = !!result;
      detail.email = { ok: emailOk, message_id: result?.messageId || null, to: member.email };
    } catch (err) {
      emailOk = false;
      detail.email = { ok: false, error: err.message, to: member.email };
    }
  }

  // 3) Decide final status. Both channels successful → sent. Both
  //    attempted but mixed → partial. None succeeded → failed (unless
  //    we never tried, in which case it's dashboard_only).
  let finalStatus;
  if (channelLabel === 'dashboard_only') {
    finalStatus = 'dashboard_only';
  } else if (channelLabel === 'both') {
    if (smsOk && emailOk) finalStatus = 'sent';
    else if (smsOk || emailOk) finalStatus = 'partial';
    else finalStatus = 'failed';
  } else {
    // single-channel
    finalStatus = (smsOk || emailOk) ? 'sent' : 'failed';
  }

  await query(
    `UPDATE team_messages
        SET status = $1, delivery_detail = $2::jsonb, updated_at = NOW()
      WHERE id = $3 AND business_id = $4`,
    [finalStatus, JSON.stringify(detail), messageRowId, businessId]
  );

  // Broadcast the dispatch outcome so the Messages page swaps the row's
  // "Sending…" badge for "Delivered" / "Partial" / "Failed" without a
  // manual refresh. Same try/swallow pattern.
  try {
    eventBus.publish(businessId, 'team_message.updated', {
      id: messageRowId,
      status: finalStatus,
      channel: channelLabel
    });
  } catch (_) { /* non-fatal */ }

  return {
    delivered: finalStatus === 'sent' || finalStatus === 'partial',
    status: finalStatus,
    message_id: messageRowId,
    message_sid: detail.sms?.sid || null,
    recipient: member,
    delivery_detail: detail
  };
}

/**
 * List recent team_messages for a tenant — drives the Messages page in
 * the Command Center. Joins recipient name from the directory when
 * available (recipient_id may be NULL after a hard-delete; recipient_name
 * snapshot in the row keeps the message readable either way).
 */
async function listTeamMessages(businessId, { limit = 100, status = null } = {}) {
  requireBusinessId(businessId, 'listTeamMessages');
  const params = [businessId];
  let whereStatus = '';
  if (status) {
    params.push(status);
    whereStatus = ` AND tm.status = $${params.length}`;
  }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const sql = `
    SELECT tm.id, tm.business_id, tm.recipient_id, tm.recipient_name,
           tm.caller_name, tm.caller_phone, tm.body,
           tm.channel, tm.status, tm.delivery_detail, tm.routed_to_default,
           tm.call_id, tm.created_at, tm.updated_at,
           btm.is_active AS recipient_active
      FROM team_messages tm
      LEFT JOIN business_team_members btm ON btm.id = tm.recipient_id
     WHERE tm.business_id = $1${whereStatus}
     ORDER BY tm.created_at DESC
     LIMIT $${params.length}`;
  const { rows } = await query(sql, params);
  return rows;
}

/**
 * Mark a message as read. Returns the updated row, or null if the
 * message belongs to a different tenant / doesn't exist.
 */
async function markTeamMessageRead(businessId, messageId) {
  requireBusinessId(businessId, 'markTeamMessageRead');
  const { rows } = await query(
    `UPDATE team_messages
        SET status = 'read', updated_at = NOW()
      WHERE id = $1 AND business_id = $2
      RETURNING *`,
    [messageId, businessId]
  );
  return rows[0] || null;
}

module.exports = {
  listTeamMembers,
  findTeamMemberByName,
  getTeamMember,
  getDefaultRecipient,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
  sendMessageToTeamMember,
  listTeamMessages,
  markTeamMessageRead,
  formatTeamMessageSms,
  formatTeamMessageEmail
};
