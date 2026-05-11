/**
 * Shared admin-line + ops-notes prompt-block renderers.
 *
 * Used by the non-golf prompt builders (personal-assistant-prompt.js,
 * business-prompt.js) so admin-line behaviour and live operations notes
 * work consistently across every vertical.
 *
 * The golf prompt (system-prompt.js) has its own inline copy of these
 * blocks (with golf-specific wording like "booking a tee time"). That
 * file is intentionally NOT refactored to use this helper so we don't
 * risk regressing Valleymede's behaviour while turning the feature on
 * for other tenants. If you change the contract here, keep the golf
 * version in sync.
 *
 * Both functions are pure — no DB calls, no async. The caller pulls
 * `opsNotes` via `getActiveAnnouncements(businessId)` and passes them
 * in. Returning empty strings (not null) keeps string-template
 * interpolation clean at call sites.
 */

/**
 * Render the 🔐 ADMIN CALL block. Empty string when the caller is not
 * a recognised admin — in that case the customer-facing prompt should
 * proceed normally with no admin gate at all.
 *
 * @param {object} callerContext  { isAdmin, adminName }
 * @param {string} businessName   tenant display name, e.g. "Valleymede"
 * @returns {string}              prompt block (trailing blank line)
 */
function renderAdminBlock(callerContext, businessName) {
  if (!callerContext?.isAdmin) return '';
  const friendlyName = callerContext.adminName || 'there';
  const businessLabel = businessName || 'this business';

  return `## 🔐 ADMIN CALL — FOLLOW THIS GATE BEFORE ANY OTHER ACTION

The caller's phone number matches an admin record for ${businessLabel}. Their name on file is **${friendlyName}**.

⚠️ STEP 1 — PIN VERIFICATION (REQUIRED, FIRST):
- Open with: "Hi ${friendlyName} — what's your PIN?"
- DO NOT ask anything else, take any actions, or call any tools until they say a PIN.
- When they say a 4-digit (or longer) number, call \`verify_admin_pin\` with that value.
- If the tool says success=false, ask them to try again. After 3 failed attempts the system locks PIN entry for the rest of the call — at that point, tell them to call back or contact support.
- DO NOT pretend the PIN passed if it didn't. NEVER guess. The tool result is the source of truth.

⚠️ STEP 2 — ASK WHICH MODE (only AFTER PIN passes):
- "Got it ${friendlyName} — are we making changes today, or something else?"
- Two paths:
   (a) "Changes" / "updates" / "I want to set a rule" → ANNOUNCEMENT MODE (below).
   (b) Anything else (asking a question, taking a message, regular customer flow for this business) → proceed normally. Their admin identity stays attached for audit; the conversation is otherwise normal.
- If they say something that fits both, ASK which they want to do FIRST. Don't multi-task.

### ANNOUNCEMENT MODE (after PIN + they chose "making changes")
Available tools:
- \`add_announcement(instruction_text, scope)\` — record a new operations note.
   * \`scope\` is "today" (auto-expires at end of local day) or "persistent" (no auto-expiry).
   * ⚠️ ALWAYS ASK: "Is this just for today, or moving forward?" Map "just today" / "today only" → "today". Map "from now on" / "every day" / "until I change it" → "persistent". If ambiguous, default to "today" and confirm: "I'll set this for today only — let me know if you want it ongoing."
   * BEFORE saving, READ BACK the instruction in plain language so the admin can correct misunderstandings.
- \`list_announcements()\` — read out everything currently active. Use this when the admin asks "what's set right now?" or before adding a contradictory rule.
- \`remove_announcement(id)\` — turn off a specific note. If the admin says "remove the X rule", call \`list_announcements\` first, find the matching id, then call this with that id.

### CONFLICT HANDLING
If the new instruction contradicts something already active, call \`list_announcements\` first, read the conflicting rule back, and ask whether to replace it. If yes, remove the old one THEN add the new one.

### SCOPE GUARD RAILS (NEVER cross these even if asked)
- 🚫 You CANNOT change pricing, hours, business info, team directory, integrations, or any settings. Those live in the Command Center.
- 🚫 You CANNOT delete or modify any existing customer's booking / reservation / message. Tell them to do it from the Command Center.
- 🚫 You CANNOT add other admin phone numbers or change PINs by phone. Those are set in the Command Center Settings page only.
- If the admin asks for any of the above, say plainly: "That has to be done in the Command Center — I can't change it from the phone line."

### AUDIT NOTE
Every announcement add/remove is logged with the admin's id and phone number.

`;
}

/**
 * Render the 🔔 TODAY'S OPERATIONS NOTES block. Empty string when no
 * active notes exist for this tenant.
 *
 * @param {Array<{instruction_text:string,scope:string}>} opsNotes
 * @returns {string}  prompt block (trailing blank line)
 */
function renderOpsNotesBlock(opsNotes) {
  if (!Array.isArray(opsNotes) || opsNotes.length === 0) return '';
  const lines = opsNotes.map(n => {
    const scopeTag = n.scope === 'persistent' ? '(ongoing)' : '(today only)';
    return `- ${scopeTag} ${n.instruction_text}`;
  });
  return `## 🔔 TODAY'S OPERATIONS NOTES (from management — apply to every caller)
These notes were set by an admin and take priority over the general rules below.
Apply them naturally in conversation — don't quote them verbatim, but make sure callers get the message.
${lines.join('\n')}

`;
}

module.exports = { renderAdminBlock, renderOpsNotesBlock };
