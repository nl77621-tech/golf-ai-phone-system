/**
 * Business switchboard system-prompt builder — tenant-scoped.
 *
 * Sibling of `services/system-prompt.js` and `personal-assistant-prompt.js`.
 * The default builder in system-prompt.js is golf-specific; the personal-
 * assistant builder models a single owner. This builder is purpose-built
 * for the new "Business" template: a multi-person team where the AI's
 * primary job is to take a message for a named teammate and route it to
 * that person via SMS / email per their preferences.
 *
 * Inputs:
 *   - businessId (int, required)         — tenant id for settings + team scoping
 *   - callerContext (object, optional)   — same shape used by grok-voice
 *
 * Output: a plain-text system prompt suitable for Grok Real-time Voice.
 *
 * Settings keys this reads (all optional; defaults kick in when missing):
 *   - ai_personality      → { name, style, language, after_hours_message }
 *   - business_hours      → weekly object of { open, close } per day
 *   - announcements       → [{ active, message }]
 *   - policies            → free-form notes the AI can quote
 *
 * Team directory is loaded from `business_team_members` (NOT settings).
 * Default-recipient routing is the only fallback when the AI can't match
 * a name; if no default is set, the AI is told to apologize and offer to
 * take a general message.
 *
 * Important: this file does NOT reference Valleymede, golf, tee times,
 * green fees, carts, or any other vertical-specific concept. Valleymede
 * runs the golf_course template and never hits this code path.
 */
const { getSetting, getBusinessById } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');
const { listTeamMembers, getDefaultRecipient } = require('./team-directory');

function safeStr(v, fallback = '') {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function formatBusinessHours(hours) {
  if (!hours || typeof hours !== 'object') return 'Hours not configured.';
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const lines = days.map(d => {
    const h = hours[d];
    if (!h || (!h.open && !h.close)) return `${d[0].toUpperCase() + d.slice(1)}: Closed`;
    if (h.closed) return `${d[0].toUpperCase() + d.slice(1)}: Closed`;
    return `${d[0].toUpperCase() + d.slice(1)}: ${h.open || '?'}–${h.close || '?'}`;
  });
  return lines.join('\n');
}

function isCurrentlyOpen(todayHours, timezone) {
  if (!todayHours || todayHours.closed) return false;
  if (!todayHours.open || !todayHours.close) return false;
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(now);
    const hh = parts.find(p => p.type === 'hour')?.value || '00';
    const mm = parts.find(p => p.type === 'minute')?.value || '00';
    const nowHHMM = `${hh}:${mm}`;
    return nowHHMM >= todayHours.open && nowHHMM <= todayHours.close;
  } catch (_) {
    return false;
  }
}

async function buildBusinessSwitchboardPrompt(businessId, callerContext = {}) {
  requireBusinessId(businessId, 'buildBusinessSwitchboardPrompt');

  const [
    business,
    personality,
    hours,
    policies,
    announcements,
    members,
    defaultRecipient
  ] = await Promise.all([
    getBusinessById(businessId),
    getSetting(businessId, 'ai_personality'),
    getSetting(businessId, 'business_hours'),
    getSetting(businessId, 'policies'),
    getSetting(businessId, 'announcements'),
    listTeamMembers(businessId, { includeInactive: false }).catch(() => []),
    getDefaultRecipient(businessId).catch(() => null)
  ]);

  const businessName = safeStr(business?.name, 'the business');
  const timezone = business?.timezone || 'America/Toronto';
  const assistantName = safeStr(personality?.name, 'Receptionist');
  const style = safeStr(personality?.style,
    'Warm, professional, efficient — like a great front-desk receptionist who knows everyone on the team.');
  const language = safeStr(personality?.language,
    'English primary. Switch if the caller prefers another language.');
  const afterHoursMessage = safeStr(personality?.after_hours_message,
    "The team isn't here right now — I can take your message and make sure the right person gets it first thing.");

  // Day/time context in tenant timezone.
  const now = new Date();
  const tzOpts = { timeZone: timezone };
  const dayName = now.toLocaleDateString('en-US', { ...tzOpts, weekday: 'long' }).toLowerCase();
  const timeStr = now.toLocaleTimeString('en-US', { ...tzOpts, hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-US', { ...tzOpts, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const todayHours = hours?.[dayName];
  const isOpen = todayHours ? isCurrentlyOpen(todayHours, timezone) : false;

  // ----------------- Caller context (mirrors golf prompt) ----------------
  let callerSection;
  if (callerContext.known && callerContext.name) {
    callerSection = `## CALLER CONTEXT
This is a RETURNING caller.
- Name: ${callerContext.name}
- Phone: ${callerContext.phone}
${callerContext.email ? `- Email: ${callerContext.email}\n` : ''}- Calls on file: ${callerContext.callCount || 0}
Greet them by name immediately. Do NOT ask for their name or number again.`;
  } else if (callerContext.isAnonymous) {
    callerSection = `## CALLER CONTEXT
This caller has NO caller ID — their number is hidden.
Early in the call, casually ask for their name AND a callback number so the recipient can get back to them. Use save_customer_info once you have both.`;
  } else {
    callerSection = `## CALLER CONTEXT
This is a NEW caller. We have their phone number (${callerContext.phone || 'unknown'}) but not their name.
Ask casually for their name early in the call: "Can I get your name?" Use save_customer_info once you have it.`;
  }

  // ----------------- Team directory section -----------------------------
  // The whole point of this template — the AI MUST know exactly who is on
  // the team and how to spell their canonical names. We surface aliases too
  // so callers saying "Paulie" or "the manager" still resolve correctly.
  let teamSection;
  if (Array.isArray(members) && members.length > 0) {
    const lines = members.map(m => {
      const aliases = Array.isArray(m.aliases) && m.aliases.length
        ? ` (also: ${m.aliases.join(', ')})`
        : '';
      const defaultMark = m.is_default_recipient ? ' [DEFAULT INBOX]' : '';
      const role = m.role ? ` — ${m.role}` : '';
      return `- ${m.name}${role}${aliases}${defaultMark}`;
    });
    teamSection = `## TEAM DIRECTORY (people you can leave a message for)
${lines.join('\n')}

When the caller asks for someone, match by canonical name OR any alias above (case-insensitive). If you're unsure between two names, ask the caller to clarify ("Did you mean Paul or Paulie?"). NEVER invent a recipient that isn't on this list.

${defaultRecipient
  ? `If the caller asks for someone NOT on this list, take the message anyway and tell them you'll make sure the right person gets it — the system will route it to ${defaultRecipient.name} (the default inbox).`
  : `If the caller asks for someone NOT on this list, apologize: "I don't have anyone by that name on my team — I can take a general message and make sure it gets to the right person, or transfer you if you'd like." Do NOT invent a recipient.`}`;
  } else {
    teamSection = `## TEAM DIRECTORY
No team members are configured yet. If a caller asks to leave a message for someone, apologize and explain you can take a general message that will be reviewed by staff. Do not pretend a teammate exists.`;
  }

  // ----------------- Active announcements --------------------------------
  let announceSection = '';
  if (Array.isArray(announcements) && announcements.length) {
    const active = announcements.filter(a => a && a.active && a.message);
    if (active.length) {
      announceSection = `\n## ACTIVE ANNOUNCEMENTS
${active.map(a => `- ${a.message}`).join('\n')}\n`;
    }
  }

  // ----------------- Policies (free-form) --------------------------------
  let policiesSection = '';
  if (policies && typeof policies === 'object' && Object.keys(policies).length > 0) {
    const flat = Object.entries(policies)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
      .join('\n');
    if (flat) {
      policiesSection = `\n## POLICIES (quote naturally only when relevant)
${flat}\n`;
    }
  }

  // ----------------- Final prompt ----------------------------------------
  const prompt = `You are ${assistantName}, an AI receptionist answering calls for ${businessName}.

## YOUR JOB
You are a SWITCHBOARD: take messages for the right teammate, accurately and efficiently. You are NOT a salesperson, a therapist, or a generalist. Get the message, confirm the recipient, end the call.

## STYLE
${style}

## LANGUAGE
${language}

## TODAY
${dateStr}, ${timeStr} (${timezone}).
The business is currently ${isOpen ? 'OPEN' : 'CLOSED'}.

## BUSINESS HOURS
${formatBusinessHours(hours)}

${isOpen ? '' : `## AFTER-HOURS MESSAGE
When closed, the AI may say: "${afterHoursMessage}"
Still take the message — it will be delivered as soon as the team is back.\n`}
${callerSection}

${teamSection}
${announceSection}${policiesSection}
## HOW TO TAKE A MESSAGE (the main flow)
1. Greet the caller warmly and naturally — don't sound like a robot.
2. Ask who the message is for. Listen carefully and CONFIRM the name back ("So this is for Paul, in sales?").
3. Get the caller's name and a callback number. The inbound caller-ID is the default callback unless they give you a different number.
4. Listen to the message. Capture key facts (what, when, why) — don't paraphrase loosely.
5. Read the message back briefly: "Just to confirm — you're letting Paul know that the shipment was delayed, and you'd like him to call you back at this number."
6. Call the take_message_for_team_member tool with team_member_name, caller_name, caller_phone, and message.
7. Close warmly: "I'll get that to {name} right away — thanks for calling."

## RULES
- NEVER invent a teammate. Only call take_message_for_team_member with names from the TEAM DIRECTORY above (canonical names — you can match by alias, but pass the canonical name to the tool).
- If the caller asks for someone not on the list and you have a default inbox, take the message and the system routes it. Don't tell the caller about the routing — just take it normally.
- Don't transfer calls. There is no transfer flow on this template — your job is messages.
- Don't quote pricing or policies unless the caller specifically asks AND the answer is in the POLICIES section.
- Keep calls short. A good message-taking call is 60–90 seconds. Don't drag it out.
- After every save_customer_info or take_message_for_team_member tool call, briefly tell the caller what happened ("Got your number saved" / "Got it — Paul will have your message shortly") and then move on or close the call.

## AVAILABLE TOOLS
- take_message_for_team_member(team_member_name, caller_name, caller_phone, message) — main tool. Call AFTER you've confirmed name + callback + message back to the caller.
- save_customer_info(name, email, phone) — save what you learn about the caller so they're recognized next time.
`;

  return prompt;
}

module.exports = { buildBusinessSwitchboardPrompt };
