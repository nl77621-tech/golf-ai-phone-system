/**
 * Personal Assistant system-prompt builder — tenant-scoped.
 *
 * This is a sibling of `services/system-prompt.js`. The default prompt
 * builder there is heavily golf-specific (green fees, tee sheet, cart
 * rules) and would confuse a solo professional who wanted an AI
 * receptionist. When a tenant's `template_key = 'personal_assistant'`
 * the dispatcher in system-prompt.js calls this function instead.
 *
 * Inputs:
 *   - businessId (int, required)         — tenant id for settings scoping
 *   - callerContext (object, optional)   — same shape used by grok-voice:
 *       { known, name, phone, email, isAnonymous, isLandline, callCount,
 *         customerKnowledge, alternatePhone }
 *
 * Output: a plain-text system prompt suitable for Grok Real-time Voice.
 *
 * Settings keys this reads (all optional; defaults kick in when missing):
 *   - ai_personality          → { name, style, language, after_hours_message }
 *   - owner_profile           → { owner_name, business_name, business_description,
 *                                 pronouns, family[], preferences, notable_details }
 *   - schedule_preferences    → { typical_hours, busy_days[], do_not_disturb,
 *                                 appointment_buffer_min }
 *   - important_contacts      → [{ name, relationship, phone, note }]
 *   - call_handling_rules     → { screen_unknown_callers, always_take_message,
 *                                 can_book_appointments, can_reschedule_appointments,
 *                                 can_transfer_to_owner, topics_to_avoid,
 *                                 topics_to_handle_directly }
 *   - business_hours          → weekly object of { open, close } per day
 *   - announcements           → [{ active, message }]
 *
 * This file has NO hardcoded references to Valleymede, golf, or any
 * vertical content — it is fully driven by the tenant's settings rows.
 */
const { getSetting, getBusinessById } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');

async function buildPersonalAssistantPrompt(businessId, callerContext = {}) {
  requireBusinessId(businessId, 'buildPersonalAssistantPrompt');

  const [
    business,
    personality,
    ownerProfile,
    schedulePrefs,
    importantContacts,
    callRules,
    hours,
    announcements
  ] = await Promise.all([
    getBusinessById(businessId),
    getSetting(businessId, 'ai_personality'),
    getSetting(businessId, 'owner_profile'),
    getSetting(businessId, 'schedule_preferences'),
    getSetting(businessId, 'important_contacts'),
    getSetting(businessId, 'call_handling_rules'),
    getSetting(businessId, 'business_hours'),
    getSetting(businessId, 'announcements')
  ]);

  const timezone = business?.timezone || 'America/Toronto';

  // ----- Assistant name resolution -----
  // Source of truth is owner_profile.assistant_name — a customizable field
  // the owner fills in during onboarding / on the My Info page. We fall
  // back to ai_personality.name (legacy) and finally to "Your Assistant"
  // so a brand-new tenant that hasn't filled anything in yet still reads
  // naturally on the phone. The default is intentionally generic — we do
  // NOT want the AI to introduce itself with a fake proper name the owner
  // hasn't approved.
  const rawAssistantName =
    (ownerProfile && typeof ownerProfile.assistant_name === 'string' ? ownerProfile.assistant_name : '') ||
    (personality && typeof personality.name === 'string' ? personality.name : '') ||
    '';
  const assistantName = rawAssistantName.trim() || 'Your Assistant';
  const ownerName = (ownerProfile?.owner_name || '').trim();
  const businessName =
    (ownerProfile?.business_name || '').trim() ||
    business?.name ||
    'the business';

  // Day / time in the tenant's timezone — used for after-hours + date hints.
  const now = new Date();
  const tzOpts = { timeZone: timezone };
  const dayName = now.toLocaleDateString('en-US', { ...tzOpts, weekday: 'long' }).toLowerCase();
  const timeStr = now.toLocaleTimeString('en-US', { ...tzOpts, hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-US', { ...tzOpts, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const todayHours = hours?.[dayName];
  const isAvailable = todayHours ? isCurrentlyOpen(todayHours, timezone) : true;

  // ------- Owner section -------
  const ownerLines = [];
  if (ownerName) ownerLines.push(`- Owner's name: ${ownerName}`);
  if (ownerProfile?.pronouns) ownerLines.push(`- Pronouns: ${ownerProfile.pronouns}`);
  if (ownerProfile?.business_name) ownerLines.push(`- Business: ${ownerProfile.business_name}`);
  if (ownerProfile?.business_description) ownerLines.push(`- What they do: ${ownerProfile.business_description}`);
  if (Array.isArray(ownerProfile?.family) && ownerProfile.family.length > 0) {
    const fam = ownerProfile.family
      .map(f => {
        if (!f) return null;
        const rel = (f.relationship || '').trim();
        const nm = (f.name || '').trim();
        if (rel && nm) return `${rel} ${nm}`;
        return rel || nm || null;
      })
      .filter(Boolean);
    if (fam.length > 0) ownerLines.push(`- Family: ${fam.join(', ')}`);
  }
  if (ownerProfile?.preferences) ownerLines.push(`- Preferences: ${ownerProfile.preferences}`);
  if (ownerProfile?.notable_details) ownerLines.push(`- Notable details: ${ownerProfile.notable_details}`);

  const ownerSection = ownerLines.length > 0
    ? `## WHO YOU WORK FOR\n${ownerLines.join('\n')}`
    : `## WHO YOU WORK FOR\nYou work for the owner of ${businessName}. Their profile hasn't been filled in yet — if callers ask personal details, take a message and say you'll pass it along.`;

  // ------- Schedule section -------
  const scheduleLines = [];
  if (schedulePrefs?.typical_hours) scheduleLines.push(`- Typical availability: ${schedulePrefs.typical_hours}`);
  if (Array.isArray(schedulePrefs?.busy_days) && schedulePrefs.busy_days.length > 0) {
    scheduleLines.push(`- Usually busy: ${schedulePrefs.busy_days.join(', ')}`);
  }
  if (schedulePrefs?.do_not_disturb) scheduleLines.push(`- Do-not-disturb windows: ${schedulePrefs.do_not_disturb}`);
  if (schedulePrefs?.appointment_buffer_min) {
    scheduleLines.push(`- Leave at least ${schedulePrefs.appointment_buffer_min} minutes between appointments`);
  }

  // ------- Important contacts -------
  const vipList = Array.isArray(importantContacts) ? importantContacts : [];
  const vipLines = vipList
    .filter(c => c && (c.name || c.phone))
    .map(c => {
      const bits = [c.name, c.relationship && `(${c.relationship})`, c.phone && `→ ${c.phone}`, c.note && `— ${c.note}`]
        .filter(Boolean);
      return `- ${bits.join(' ')}`;
    });
  const vipSection = vipLines.length > 0
    ? `## VIP CONTACTS (treat these callers warmly — they're known)\n${vipLines.join('\n')}`
    : '';

  // ------- Call handling rules -------
  const rules = callRules || {};
  const screening = rules.screen_unknown_callers !== false;
  const canBook = rules.can_book_appointments !== false;
  const canReschedule = rules.can_reschedule_appointments !== false;
  const canTransfer = !!rules.can_transfer_to_owner;
  const alwaysMessage = rules.always_take_message !== false;

  const handlingLines = [];
  handlingLines.push(`- ${screening ? 'Screen unknown callers politely — get their name, the reason for the call, and a callback number before taking a message.' : 'You do not need to screen callers — help them directly whenever possible.'}`);
  handlingLines.push(`- ${canBook ? 'You CAN book new appointments on behalf of the owner.' : 'You cannot book appointments directly — take the caller\'s preferred time and put it in the message.'}`);
  handlingLines.push(`- ${canReschedule ? 'You CAN help reschedule existing appointments.' : 'You cannot reschedule — note the request and pass it to the owner.'}`);
  if (canTransfer) {
    handlingLines.push('- You may offer to transfer the caller when it\u2019s clearly urgent or a known VIP.');
  } else {
    handlingLines.push('- Do NOT offer to transfer the call. Instead, take a detailed message and the owner will follow up.');
  }
  if (alwaysMessage) {
    handlingLines.push('- Always end by confirming you\u2019ll pass the message along — callers appreciate knowing it was received.');
  }
  if (rules.topics_to_avoid) handlingLines.push(`- AVOID these topics: ${rules.topics_to_avoid}`);
  if (rules.topics_to_handle_directly) handlingLines.push(`- Feel free to discuss: ${rules.topics_to_handle_directly}`);

  // ------- Caller context -------
  let callerSection = '';
  if (callerContext.known && callerContext.name) {
    callerSection = `## CALLER CONTEXT
This is a RETURNING caller.
- Name: ${callerContext.name}
- Phone: ${callerContext.phone}
- Total calls on file: ${callerContext.callCount || 0}
${callerContext.customerKnowledge ? `\n### What you know about them:\n${callerContext.customerKnowledge}\n` : ''}
Greet them by name right away. Do NOT ask for their name or number again.`;
  } else if (callerContext.isAnonymous) {
    callerSection = `## CALLER CONTEXT
The caller has no caller ID — early in the call, naturally ask for their name AND a good callback number so you can pass the message along.`;
  } else {
    callerSection = `## CALLER CONTEXT
New caller. We have their phone (${callerContext.phone || 'unknown'}) but not their name.
Early in the conversation ask for their name — something natural like "Who\u2019s this?" — and use save_customer_info to save it.`;
  }

  // ------- Announcements -------
  const activeAnn = (announcements || []).filter(a => a?.active && a?.message);
  const announcementSection = activeAnn.length > 0
    ? `## CURRENT ANNOUNCEMENTS (mention if relevant)\n${activeAnn.map(a => `- ${a.message}`).join('\n')}`
    : '';

  // ------- Availability copy -------
  const availabilityLine = todayHours
    ? `${isAvailable ? 'The owner is likely AVAILABLE now' : 'The owner is likely UNAVAILABLE now'} (today's hours: ${todayHours.open}\u2013${todayHours.close} ${timezone}).`
    : `Availability today isn\u2019t set — err toward "they're not free right now, let me take a message".`;

  const afterHoursLine =
    personality?.after_hours_message ||
    `They\u2019re not available right now, but I\u2019ll make sure they get the message.`;

  // ------- Assemble -------
  const prompt = `You are ${assistantName}, a warm and capable personal assistant answering the phone for ${ownerName || 'the owner'}${ownerProfile?.business_name ? ` of ${ownerProfile.business_name}` : ''}. You are NOT a robot — you sound like a real person who has worked alongside them for a long time and genuinely cares about being helpful.

## YOUR PERSONALITY
${personality?.style || 'Friendly, warm, and proactive. Confident without being pushy. You pick up on what the caller actually needs and adapt.'}
- Language: ${personality?.language || 'English primary. Switch if the caller prefers another language.'}
- NEVER say "I'm an AI" or "As an AI" — you are ${assistantName}, ${ownerName ? `${ownerName}'s personal assistant` : 'the assistant'}.
- If you don't know something, say "Let me check on that and have ${ownerName || 'them'} get back to you" — don\u2019t make things up.

## BREVITY RULES — THIS IS A PHONE CALL
- 1\u20132 sentences at a time, then pause. Let the caller speak.
- No long greetings, no listing multiple things unless asked.
- No "Great!" / "Absolutely!" filler — just answer.
- Short, warm, attentive. Silence is okay.

## DATE SPEAKING RULES
- NEVER read dates in numeric / ISO format out loud ("2026-04-23"). Say "this Thursday" or "April twenty-third".
- Never say the year unless the caller asks.
- Use YYYY-MM-DD format only inside tool calls.

## CURRENT DATE & TIME
- Today: ${dateStr}
- Current time: ${timeStr} (${timezone})
- ${availabilityLine}

## DATE REFERENCE (use this to convert natural phrases to YYYY-MM-DD)
${buildDateReference(timezone)}

${ownerSection}

${scheduleLines.length > 0 ? `## OWNER'S SCHEDULE PREFERENCES\n${scheduleLines.join('\n')}` : ''}

${vipSection}

## HOW TO HANDLE THIS CALL
${handlingLines.join('\n')}

${callerSection}

${announcementSection}

## AFTER-HOURS BEHAVIOR
${afterHoursLine}

## TOOLS AVAILABLE
You have access to these tools — use them at the right moments:
- save_customer_info: Save the caller's name, phone, and/or email so we remember them next time. Use this as soon as you learn a new caller's name.
- lookup_customer: Check whether a caller is already on file.
- save_alternate_phone: Save a mobile number for a landline caller so they can get text follow-ups.
${canTransfer ? '- transfer_call: Only use for clear urgencies or known VIPs. Confirm first: "Let me see if I can get them on the line."' : ''}

## CORE BEHAVIORS
1. Greet the caller warmly. If returning caller — use their name immediately.
2. Find out what they need and who they are (name + reason + callback number).
3. If it's an appointment request:
   ${canBook ? 'a. Offer a few reasonable times that fit the owner\u2019s schedule preferences above.\n   b. Confirm the time back and tell them the owner will follow up by text to confirm.' : 'Take their preferred time and note it clearly in the message for the owner.'}
4. If it's a message: capture it completely. Read the key part back once to confirm you heard it right. Ask if there's anything urgent the owner should know.
5. Close warmly: "I'll make sure ${ownerName || 'they'} get${ownerName && !/s$/i.test(ownerName) ? 's' : ''} this — thanks for calling!"

## IMPORTANT REMINDERS
- You represent ${ownerName || 'the owner'} — be the kind of assistant they'd be proud of.
- Never share pricing, commitments, or sensitive details unless they appear in the sections above.
- If the caller is upset, de-escalate: acknowledge, take the message, promise a prompt callback.
- ALWAYS use save_customer_info to save new callers' info so we remember them next time.
- At the end of the call the system will send ${ownerName || 'the owner'} a short text recap — the richer the notes you gather, the better that recap will be.
`;

  return prompt;
}

/**
 * Build a short "today / tomorrow / this Friday" reference block. Same
 * shape as the helper in system-prompt.js so the two builders behave
 * consistently when Grok converts spoken dates to ISO form.
 */
function buildDateReference(timezone = 'America/Toronto') {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const [y, m, d] = todayStr.split('-').map(Number);
  const localToday = new Date(y, m - 1, d);

  const lines = [];
  for (let i = 0; i <= 7; i++) {
    const dt = new Date(localToday);
    dt.setDate(dt.getDate() + i);
    const dateKey = dt.toLocaleDateString('en-CA');
    const dayLabel = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const prefix = i === 0 ? ' (TODAY)' : i === 1 ? ' (tomorrow)' : '';
    lines.push(`- ${dayLabel}${prefix} = ${dateKey}`);
  }
  return lines.join('\n');
}

function getCurrentLocalTime(timezone) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false
  });
  const parts = fmt.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

function isCurrentlyOpen(todayHours, timezone = 'America/Toronto') {
  if (!todayHours) return false;
  const { totalMinutes } = getCurrentLocalTime(timezone);
  const [oh, om] = String(todayHours.open || '09:00').split(':').map(Number);
  const [ch, cm] = String(todayHours.close || '17:00').split(':').map(Number);
  return totalMinutes >= (oh * 60 + om) && totalMinutes <= (ch * 60 + cm);
}

module.exports = { buildPersonalAssistantPrompt };
