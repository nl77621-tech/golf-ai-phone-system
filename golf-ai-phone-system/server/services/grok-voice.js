/**
 * Grok Voice API Bridge — tenant-scoped.
 *
 * Every live call is owned by exactly one tenant (resolved from the called
 * DID in the Twilio webhook middleware). That `businessId` is threaded
 * through this file so every DB write, settings lookup, and tool call is
 * scoped to that tenant:
 *
 *   handleMediaStream(twilioWs, businessId, callerPhone, callSid, streamSid, appUrl)
 *
 * Architecture:
 *   Twilio <--WebSocket (audio)--> This Bridge <--WebSocket--> Grok Voice API
 *
 * Audio format: Twilio sends/receives mulaw 8kHz mono. Grok accepts pcm16/24kHz.
 */
const WebSocket = require('ws');
// Twilio REST client — used to inject a graceful "we're having trouble"
// TwiML mid-call when the Grok WebSocket fails. Without this the caller
// hears 5+ seconds of dead silence before Twilio drops the call.
let twilioClient = null;
function getTwilioClient() {
  if (twilioClient) return twilioClient;
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  try {
    twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    return twilioClient;
  } catch (_) { return null; }
}
const { buildSystemPrompt } = require('./system-prompt');
const { sendPostCallSummary, sendSMS, sendEmail } = require('./notification');
const {
  lookupByPhone, lookupByName, registerCall, updateCustomer,
  lookupAdminByPhone, verifyAdminPin, markAdminPinSuccess,
  getActiveAnnouncements, createAnnouncement, deactivateAnnouncement,
} = require('./caller-lookup');
const {
  createBookingRequest,
  createModificationRequest,
  getConfirmedBookingsByPhone,
  getBookingById,
  getPendingHoldsForDate
} = require('./booking-manager');
const { getLineType } = require('./phone-lookup');
const { getCurrentWeather, getForecast } = require('./weather');
const { query, getSetting, getBusinessById } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');
const { recordCallUsage } = require('./credits');
const { resolveVoiceConfigFromSettings } = require('./voice-tiers');
const { findTeamMemberByName, sendMessageToTeamMember, getDefaultRecipient } = require('./team-directory');
const teeon = require('./teeon-automation');
require('dotenv').config();

const GROK_REALTIME_URL = 'wss://api.x.ai/v1/realtime';

// ─── Audio conversion ────────────────────────────────────────────────────────

function linearToMulaw(sample) {
  const MULAW_BIAS = 0x84;
  const MULAW_CLIP = 32635;

  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  let expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & expMask) break;
    expMask >>= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

function mulawToLinear(byte) {
  byte = ~byte & 0xFF;
  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0F;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function pcm16ToMulaw8k(inputBuf) {
  const numSamples = Math.floor(inputBuf.length / 2);
  const outputSamples = Math.floor(numSamples / 3);
  const output = Buffer.alloc(outputSamples);
  for (let i = 0; i < outputSamples; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < 3; j++) {
      const srcIdx = (i * 3 + j) * 2;
      if (srcIdx + 1 < inputBuf.length) {
        sum += inputBuf.readInt16LE(srcIdx);
        count++;
      }
    }
    output[i] = linearToMulaw(count > 0 ? Math.round(sum / count) : 0);
  }
  return output;
}

function mulaw8kToPcm16(inputBuf) {
  const output = Buffer.alloc(inputBuf.length * 3 * 2);
  for (let i = 0; i < inputBuf.length; i++) {
    const s0 = mulawToLinear(inputBuf[i]);
    const s1 = (i + 1 < inputBuf.length) ? mulawToLinear(inputBuf[i + 1]) : s0;
    for (let j = 0; j < 3; j++) {
      const interp = Math.round(s0 + (j / 3) * (s1 - s0));
      output.writeInt16LE(interp, (i * 3 + j) * 2);
    }
  }
  return output;
}

// ─── Per-tenant Tee-On config resolver ───────────────────────────────────────

/**
 * Pull the tenant's Tee-On course configuration from either:
 *   - a `teeon` setting JSON blob { course_code, course_group_id }
 *   - columns on the `businesses` row (teeon_course_code, teeon_course_group_id)
 * Returns null to let teeon-automation fall back to Valleymede defaults.
 */
/**
 * Detect a party-size number from free-form caller speech.
 *
 * Used as a SAFETY NET when the AI calls check_tee_times with
 * party_size=1 (the default) — we re-scan recent caller utterances
 * for an explicit party-size phrase and, if found, override the
 * arg before calling Tee-On. This prevents the "AI defaults to 1
 * but caller actually said four" failure mode that surfaces when
 * the AI ignores the prompt's "don't re-ask party size" rule.
 *
 * Returns a number 1..8 if confidently detected, else null.
 *
 * Patterns recognised (text is lowercased upstream):
 *   - "(N|number-word) players|golfers|guys|people"
 *   - "(N|number-word) of us"
 *   - "for (N|number-word)"
 *   - "group of (N|number-word)"
 *   - "foursome" → 4, "threesome" → 3, "twosome" → 2
 *   - "just me", "by myself", "myself", "for myself" → 1
 *   - "me and my buddy", "myself and a friend" → 2
 *
 * Conservative: returns null on ambiguity rather than guessing.
 */
function detectPartySizeFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase();

  // Word-form numbers (one..eight). Higher first so "fourteen" doesn't
  // match "four" accidentally — though party sizes never go that high
  // and we cap at 8 anyway.
  const wordToNum = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8,
    single: 1, solo: 1
  };

  // Single-word collective nouns map directly to a size.
  if (/\b(foursome)\b/.test(t)) return 4;
  if (/\b(threesome)\b/.test(t)) return 3;
  if (/\b(twosome|pair)\b/.test(t)) return 2;
  // Multi-person phrases must be checked BEFORE the solo "just me"
  // pattern — "just me and my buddy" is 2, not 1.
  if (/\b(me|myself) (and|plus|with|\+) (a |my |one |another )?(friend|buddy|partner|wife|husband|son|daughter|kid|guest|colleague)\b/.test(t)) return 2;
  // "play with my wife", "going with my buddy" → 2 (caller + 1 partner)
  if (/\b(with|alongside|plus) my (wife|husband|partner|friend|buddy|son|daughter|kid|colleague)\b/.test(t)) return 2;
  // Solo patterns last.
  if (/\b(just me|by myself|for myself|playing alone|all alone|on my own)\b/.test(t)) return 1;

  // Numeric forms.
  // "for 4 players", "for four players", "for 3 golfers", "for two guys"
  const playersRe = /\b(\d+|one|two|three|four|five|six|seven|eight)\s+(players?|golfers?|guys|people|of us)\b/;
  const pm = t.match(playersRe);
  if (pm) {
    const n = /^\d+$/.test(pm[1]) ? parseInt(pm[1], 10) : wordToNum[pm[1]];
    if (n >= 1 && n <= 8) return n;
  }

  // "group of 5", "party of three"
  const groupRe = /\b(?:group|party) of (\d+|one|two|three|four|five|six|seven|eight)\b/;
  const gm = t.match(groupRe);
  if (gm) {
    const n = /^\d+$/.test(gm[1]) ? parseInt(gm[1], 10) : wordToNum[gm[1]];
    if (n >= 1 && n <= 8) return n;
  }

  // "we are 4" / "we're a group of 5" / "there are 3 of us"
  const usRe = /\bthere (?:are|will be) (\d+|one|two|three|four|five|six|seven|eight)\b/;
  const um = t.match(usRe);
  if (um) {
    const n = /^\d+$/.test(um[1]) ? parseInt(um[1], 10) : wordToNum[um[1]];
    if (n >= 1 && n <= 8) return n;
  }

  return null;
}

async function getTeeOnConfigForBusiness(businessId) {
  // Reuse teeon-admin's tenant config lookup (matching settings →
  // businesses → DEFAULT_COURSE_CODE chain) so we never return null
  // for a tenant that has Tee-On admin configured. Valleymede has no
  // explicit teeon_course_code setting; teeon-admin falls back to
  // DEFAULT_COURSE_CODE='COLU', but this function was returning null
  // and check_tee_times' admin-sheet Tier-0 path was being skipped
  // (cfg.businessId was null), routing every call to the public
  // sheet — which today's morning hides for lead-time reasons.
  // Real-call observed 2026-05-12 10:29 EDT: check_tee_times returned
  // 0 slots even though the admin tee sheet had 88 rows + 110 player
  // tiles (per a TeeSheet-Mirror log line three minutes later).
  try {
    const { getTenantTeeOnConfig } = require('./teeon-admin');
    const cfg = await getTenantTeeOnConfig(businessId).catch(() => null);
    if (cfg?.courseCode) {
      return {
        businessId,
        courseCode: cfg.courseCode,
        courseGroupId: cfg.courseGroupId
      };
    }
  } catch (err) {
    console.warn(`[tenant:${businessId}] getTeeOnConfigForBusiness error:`, err.message);
  }
  return null;
}

// ─── Media stream handler ────────────────────────────────────────────────────

/**
 * Handle an incoming Twilio media stream WebSocket connection.
 *
 * @param {WebSocket} twilioWs
 * @param {number}    businessId  — tenant id (required)
 * @param {string}    callerPhone
 * @param {string}    callSid
 * @param {string}    streamSid
 * @param {string}    appUrl
 */
async function handleMediaStream(twilioWs, businessId, callerPhone, callSid, streamSid, appUrl) {
  requireBusinessId(businessId, 'handleMediaStream');
  console.log(`[tenant:${businessId}][${callSid}] New call from ${callerPhone}`);

  // Create call log entry (business-scoped)
  let callLogId = null;
  try {
    const res = await query(
      `INSERT INTO call_logs (business_id, twilio_call_sid, caller_phone, started_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [businessId, callSid, callerPhone]
    );
    callLogId = res.rows[0].id;
  } catch (err) {
    console.error(`[tenant:${businessId}][${callSid}] Failed to create call log:`, err.message);
  }

  // Detect anonymous/blocked caller ID
  const ANONYMOUS_NUMBERS = ['anonymous', 'blocked', 'unknown', '+266696687', '+86282452253'];
  const isAnonymous = !callerPhone || ANONYMOUS_NUMBERS.some(a => callerPhone.toLowerCase().includes(a));

  // Look up/register caller scoped to this tenant
  let customer = null;
  let isNew = true;
  try {
    const result = await registerCall(businessId, isAnonymous ? null : callerPhone);
    customer = result.customer;
    isNew = result.isNew;
  } catch (err) {
    console.error(`[tenant:${businessId}][${callSid}] Failed to register call (DB unavailable, continuing):`, err.message);
  }

  // Look up line type — cache lives on the tenant's customer row
  let lineType = null;
  if (!isAnonymous && callerPhone) {
    try {
      lineType = await getLineType(businessId, callerPhone, customer?.id);
    } catch (err) {
      console.warn(`[tenant:${businessId}][${callSid}] Phone lookup failed (continuing):`, err.message);
    }
  }

  // Admin-line detection. If the caller's phone number matches a row in
  // business_admins for this tenant, we mark the call as an admin call.
  // The system prompt then leads with a PIN gate before allowing any
  // state-change operations. Customer-mode tools (book_tee_time, etc.)
  // stay available so admins can still place normal bookings from the
  // same line — they just need to clear the PIN first.
  let adminRow = null;
  if (!isAnonymous && callerPhone) {
    try {
      adminRow = await lookupAdminByPhone(businessId, callerPhone);
    } catch (err) {
      console.warn(`[tenant:${businessId}][${callSid}] Admin lookup failed (treating as normal caller):`, err.message);
    }
  }

  const callerContext = {
    phone: isAnonymous ? null : callerPhone,
    isAnonymous,
    known: !isNew && !!customer?.name,
    name: customer?.name,
    email: customer?.email,
    callCount: customer?.call_count,
    customerId: customer?.id,
    customerKnowledge: customer?.customer_knowledge || null,
    lineType,
    isLandline: lineType === 'landline',
    alternatePhone: customer?.alternate_phone || null,
    noShowCount: customer?.no_show_count || 0,
    // Admin call context. isAdmin gates the system-prompt's admin
    // section + tool availability; pinVerified flips to true after a
    // successful verify_admin_pin call within this call's lifetime.
    isAdmin: !!adminRow,
    adminId: adminRow?.id || null,
    adminName: adminRow?.name || null,
  };
  if (adminRow) {
    console.log(`[tenant:${businessId}][${callSid}] Admin caller detected: ${adminRow.name} (id=${adminRow.id}, phone=${adminRow.phone_number})`);
  }

  // Update call log with customer ID (business-scoped)
  if (callLogId && customer?.id) {
    query(
      'UPDATE call_logs SET customer_id = $1 WHERE id = $2 AND business_id = $3',
      [customer.id, callLogId, businessId]
    ).catch(() => {});
  }

  // Load the business row — used for greeting + transfer copy fallback
  const business = await getBusinessById(businessId).catch(() => null);
  const businessName = business?.name || 'the Golf Course';

  // Greeting — per-customer > tenant-DB > generic fallback
  let greeting = `Thanks for calling ${businessName}! How can I help you today?`;
  try {
    const greetings = customer?.custom_greetings;
    const hasCustomGreetings = Array.isArray(greetings) && greetings.filter(g => g && g.trim()).length > 0;

    if (hasCustomGreetings && callerContext.known) {
      const validGreetings = greetings.filter(g => g && g.trim());
      const picked = validGreetings[Math.floor(Math.random() * validGreetings.length)];
      greeting = picked.replace(/{name}/g, callerContext.name || '');
      console.log(`[tenant:${businessId}][${callLogId}] Using custom greeting ${validGreetings.indexOf(picked) + 1}/${validGreetings.length} for ${callerContext.name}`);
    } else if (customer?.custom_greeting && callerContext.known) {
      greeting = customer.custom_greeting.replace(/{name}/g, callerContext.name || '');
      console.log(`[tenant:${businessId}][${callLogId}] Using legacy custom greeting for ${callerContext.name}`);
    } else {
      greeting = await getRandomGreeting(businessId, callerContext.known, callerContext.name, businessName);
    }
  } catch (err) {
    console.error(`[tenant:${businessId}][${callLogId}] Failed to get greeting (using default):`, err.message);
  }

  // Admin-call greeting override. When the caller is a recognised admin
  // (PR #25), the regular "Hi {name}, how can I help" greeting wins the
  // first turn and the system prompt's "ask for PIN first" rule loses,
  // because the greetingInstruction below is injected as a user message
  // BEFORE the AI gets a chance to weigh the admin block. Override the
  // greeting here so the very first thing the AI says is the PIN ask.
  // The admin's preferred display name comes from the customers row
  // (their normal contact name) — falls back to the admins.name field
  // and then a generic "there".
  if (adminRow) {
    const friendlyName = (callerContext.name && callerContext.name.split(' ')[0])
      || (adminRow.name && !adminRow.name.includes('@') ? adminRow.name.split(' ')[0] : null)
      || 'there';
    greeting = `Hi ${friendlyName} — what's your PIN?`;
    console.log(`[tenant:${businessId}][${callLogId}] Admin greeting override — leading with PIN ask for ${friendlyName}`);
  }

  // System prompt — tenant-scoped
  let systemPrompt = null;
  try {
    systemPrompt = await buildSystemPrompt(businessId, callerContext);
  } catch (err) {
    console.error(`[tenant:${businessId}][${callLogId}] Failed to build system prompt (using minimal fallback):`, err.message);
  }
  if (!systemPrompt) {
    // Minimal fallback: no Valleymede-specific hardcodes, just enough to take
    // a booking request. This fires only when the DB is unreachable.
    const now = new Date();
    const tz = business?.timezone || 'America/Toronto';
    const dateStr = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true });
    const callerLine = callerContext.known && callerContext.name
      ? `This is a RETURNING caller named ${callerContext.name} (phone: ${callerContext.phone}). You do NOT need to collect their info again.`
      : callerContext.isAnonymous
        ? `This caller has NO caller ID. Early in the call, naturally ask for their name AND phone number.`
        : `This is a NEW caller (we have their phone: ${callerContext.phone} but not their name). Early in the conversation, naturally ask for their name.`;

    systemPrompt = `You are a friendly staff member answering the phone at ${businessName}. Today is ${dateStr}, current time ${timeStr} (${tz}).

## HOW TO SPEAK
- Use contractions. Keep answers short. One or two sentences, then pause.
- Never list things out loud unless asked. Ask one question at a time.
- NEVER say dates in numeric format like "2026-04-19". Say "Sunday, April nineteenth" or "tomorrow". Use YYYY-MM-DD ONLY inside tool calls.

## CALLER CONTEXT
${callerLine}

## BOOKING RULES
- CRITICAL: Convert "today", "tomorrow", etc. yourself to YYYY-MM-DD before calling tools.
- ALWAYS call check_tee_times with date AND party_size before saying anything about availability.
- You MUST call the book_tee_time tool to create a booking — the booking does NOT exist until you call it.
- After booking: tell them it's a REQUEST — staff will confirm by text.
`;
  }

  const tools = buildToolDefinitions();

  // ─── Per-tenant voice tier resolution ──────────────────────────────────────
  //
  // Resolve the (model, voice, speed) triple this tenant should use. If the
  // `voice_config` settings row is missing (e.g. Valleymede during rollout)
  // resolveVoiceConfigFromSettings returns LEGACY_FALLBACK exactly — same
  // model/voice/speed as the hard-coded values prior to this file.
  let voiceCfg;
  try {
    const rawVoiceConfig = await getSetting(businessId, 'voice_config').catch(() => null);
    voiceCfg = resolveVoiceConfigFromSettings(rawVoiceConfig);
  } catch (err) {
    console.warn(`[tenant:${businessId}][${callSid}] voice_config lookup failed, using legacy fallback:`, err.message);
    voiceCfg = resolveVoiceConfigFromSettings(null);
  }
  console.log(`[tenant:${businessId}][${callSid}] Voice tier: ${voiceCfg.tier || 'legacy'} | model=${voiceCfg.model} voice=${voiceCfg.voice} speed=${voiceCfg.speed}`);

  // IMPORTANT: do NOT put `?model=...` on the WebSocket URL.
  //
  // Earlier iterations of this file assumed xAI's realtime endpoint mirrored
  // the OpenAI-realtime `?model=` convention, but in production that caused
  // the handshake to complete at the TCP level while no audio ever streamed
  // back — phone answered, dead silence on the caller's end. xAI picks the
  // realtime model server-side; the documented override for the non-default
  // model lives in session.update, not the URL.
  //
  // For now every tenant connects to the bare realtime endpoint and the tier
  // plumbing still controls `voice` + `speed` in the session.update payload
  // below. Once we've verified the correct way to activate
  // `grok-think-fast-1.0` we can re-add a per-tier model override — but it
  // must go into the session payload, not the URL.
  const grokUrl = GROK_REALTIME_URL;

  // Connect to Grok Real-time Voice API
  const grokWs = new WebSocket(grokUrl, {
    headers: {
      'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  // When Grok fails, redirect the in-progress Twilio call to a static
  // TwiML that says a short apology and hangs up — instead of just
  // closing our WS and leaving the caller on a dead-air line. The
  // audit reviewer flagged this as "5 seconds of silence then drop"
  // which is a terrible caller experience for a service outage.
  // failoverFired prevents double-firing if multiple handlers run.
  let failoverFired = false;
  const playFailoverAndHangup = async (reason) => {
    if (failoverFired) return;
    failoverFired = true;
    try {
      const client = getTwilioClient();
      if (!client || !callSid) return;
      const business = await getBusinessById(businessId).catch(() => null);
      const tenantName = business?.name || 'us';
      const xmlEscape = (s) => String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
      const twiml = `<Response><Say voice="alice">Thanks for calling ${xmlEscape(tenantName)}. Our voice system is having a brief hiccup. Please call back in a minute and we'll get you sorted out.</Say><Hangup/></Response>`;
      await client.calls(callSid).update({ twiml });
      console.log(`[tenant:${businessId}][${callSid}] Failover TwiML sent (${reason})`);
    } catch (err) {
      console.error(`[tenant:${businessId}][${callSid}] Failover dispatch failed:`, err.message);
    }
  };

  const grokConnectTimeout = setTimeout(() => {
    if (grokWs.readyState !== WebSocket.OPEN) {
      console.error(`[tenant:${businessId}][${callSid}] Grok connection timeout — playing failover message`);
      playFailoverAndHangup('connect_timeout').finally(() => {
        try { grokWs.close(); } catch (_) {}
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      });
    }
  }, 5000);

  let conversationActive = true;

  const callState = {
    startTime: Date.now(),
    transcriptParts: [],
    actions: [],
    // Admin-line gate state. pinVerified flips true only after a
    // successful verify_admin_pin tool call within this call. The admin
    // tools (add/list/remove_announcement) check this flag and reject
    // before-PIN attempts. failedPinAttempts is a soft rate-limit — at
    // 3 misses we lock out further attempts for the rest of the call.
    pinVerified: false,
    failedPinAttempts: 0,
  };

  let keepAlive = null;

  grokWs.on('open', () => {
    console.log(`[tenant:${businessId}][${callSid}] Connected to Grok`);
    clearTimeout(grokConnectTimeout);

    keepAlive = setInterval(() => {
      if (grokWs.readyState === WebSocket.OPEN) grokWs.ping();
    }, 25000);

    grokWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: systemPrompt,
        voice: voiceCfg.voice,
        speed: voiceCfg.speed,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        // Voice Activity Detection — controls how snappy the AI feels.
        //   threshold: lower = AI cuts itself off faster when the caller
        //     starts talking. 0.25 is responsive without firing on
        //     background noise (passing cars, AC hum). 0.30 was the prior
        //     value and felt sluggish; below 0.20 starts false-positiving
        //     on phone-line noise.
        //   prefix_padding_ms: how much audio BEFORE detected speech to
        //     capture. 50ms is already minimal — going lower can clip the
        //     first phoneme.
        //   silence_duration_ms: how long the caller must be silent
        //     before we consider their turn done and ask Grok to reply.
        //     200ms makes turn-taking feel like a real conversation.
        //     Below ~150ms makes the AI cut off callers who pause to
        //     think mid-sentence ("I'd like... uh... a tee time").
        // Pair this with the existing speech_started handler at line
        // ~402 which fires response.cancel + buffer clear the moment
        // Grok detects the caller's voice — that's the actual barge-in.
        turn_detection: {
          type: 'server_vad',
          threshold: 0.25,
          prefix_padding_ms: 50,
          silence_duration_ms: 200
        },
        tools: tools,
        tool_choice: 'auto',
        input_audio_transcription: { model: 'whisper-large-v3' }
      }
    }));

    const greetingInstruction = callerContext.isAdmin
      // Admin call — short, businesslike. PIN gate is mandatory; the
      // system prompt's 🔐 ADMIN CALL block covers what to do with the
      // answer. We just kick off the gate here.
      ? `[System: An admin caller just dialed in. This is NOT a normal customer call. Open IMMEDIATELY with: "${greeting}" — exact words, no embellishment, no "how can I help". Do NOT ask their name (you know them). Do NOT offer to book a tee time yet. Wait for them to say a PIN, then call verify_admin_pin. The system prompt's 🔐 ADMIN CALL section explains the full gate.]`
      : (callerContext.known && callerContext.name
        ? `[System: A returning caller named ${callerContext.name} just called. Greet them IMMEDIATELY by name — start with their name right away, warm and personal like you recognize them. Use this greeting but make it sound natural and unscripted: "${greeting}". Do NOT sound like you are reading from a script. Do NOT ask for their name.]`
        : `[System: Someone just called. Answer the phone naturally like a real person would — warm, casual, friendly. Use this greeting but make it sound natural and unscripted: "${greeting}". Do NOT sound like you are reading from a script.]`);
    grokWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: greetingInstruction
        }]
      }
    }));

    grokWs.send(JSON.stringify({ type: 'response.create' }));
  });

  grokWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());

      // Track whether Grok currently has a response being generated.
      // The barge-in handler uses this to decide whether sending
      // `response.cancel` is valid — cancelling when no response is
      // active makes Grok return "Cancellation failed: no active
      // response found" (observed 15× in one day's logs). `response.
      // created` opens the window; `response.done` (and the cancelled
      // / failed terminals) close it.
      if (event.type === 'response.created') {
        callState.responseActive = true;
      } else if (event.type === 'response.done'
              || event.type === 'response.cancelled'
              || event.type === 'response.failed') {
        callState.responseActive = false;
        // The FIRST response of every call is the greeting. Mark the
        // greeting as delivered the moment it reaches a terminal state
        // so the barge-in handler can stop protecting it. Until then,
        // barge-in is suppressed (see speech_started handler) so a
        // false VAD trigger at call-pickup can't cut off the greeting.
        if (!callState.greetingComplete) {
          callState.greetingComplete = true;
        }
      }

      if (event.type === 'response.output_audio.delta') {
        if (!callState._audioLogged) {
          callState._audioLogged = true;
          const d = event.delta || '';
          console.log(`[tenant:${businessId}][${callSid}] Audio flowing - length: ${d.length}, first50: ${d.slice(0, 50)}, last10: ${d.slice(-10)}`);
        }
      } else if (event.type === 'response.audio.delta') {
        console.log(`[tenant:${businessId}][${callSid}] WARNING: Got response.audio.delta too - possible double send!`);
      } else if (event.type === 'session.updated') {
        const s = event.session || {};
        console.log(`[tenant:${businessId}][${callSid}] Session confirmed - input_fmt: ${s.input_audio_format}, output_fmt: ${s.output_audio_format}, voice: ${s.voice}`);
      } else {
        console.log(`[tenant:${businessId}][${callSid}] Grok event: ${event.type}`, JSON.stringify(event).slice(0, 200));
      }

      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          // ─── GREETING GUARD ──────────────────────────────────────
          // NEVER barge in over the greeting. Grok's VAD frequently
          // fires a FALSE speech_started within the first ~700ms of a
          // call — line noise, echo, or the caller's handset settling.
          // If we honour that as a barge-in we cancel the greeting
          // before the caller hears a single word: the call goes dead
          // silent and the golfer hangs up + calls back.
          //
          // Real-call bug observed 2026-05/06: ~18% of calls had the
          // greeting killed this way; the golf-course manager reported
          // "the AI just stayed silent." Until the greeting has fully
          // played (first response.done → greetingComplete=true), we
          // ignore barge-in entirely — no cancel, no Twilio clear.
          if (!callState.greetingComplete) {
            console.log(`[tenant:${businessId}][${callSid}] speech_started during greeting — ignoring (greeting must play fully)`);
            break;
          }

          // Only send response.cancel when Grok actually has a response
          // in progress. Cancelling when nothing is active is rejected
          // with "Cancellation failed: no active response found" — noise,
          // and an invalid request to Grok.
          if (callState.responseActive) {
            console.log(`[tenant:${businessId}][${callSid}] Barge-in detected — cancelling AI response`);
            if (grokWs.readyState === WebSocket.OPEN) {
              grokWs.send(JSON.stringify({ type: 'response.cancel' }));
            }
          }
          // The Twilio audio-buffer clear ALWAYS fires: even after Grok
          // finished generating (response.done), the generated audio can
          // still be draining out to the caller. Clearing it cuts the AI
          // off mid-sentence in the caller's ear, which is the point of
          // barge-in. Harmless when the buffer is already empty.
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
          }
          break;

        case 'response.output_audio.delta':
          if (!streamSid) console.warn(`[tenant:${businessId}][${callSid}] Audio delta received but streamSid is null!`);
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            const audioPayload = event.delta || event.audio;
            if (audioPayload) {
              const rawBuf = Buffer.from(audioPayload, 'base64');
              const mulawBuf = pcm16ToMulaw8k(rawBuf);
              const CHUNK_BYTES = 480;
              for (let i = 0; i < mulawBuf.length; i += CHUNK_BYTES) {
                const chunk = mulawBuf.slice(i, i + CHUNK_BYTES);
                if (twilioWs.readyState === WebSocket.OPEN) {
                  twilioWs.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: chunk.toString('base64') }
                  }));
                }
              }
            }
          }
          break;

        case 'response.output_audio_transcript.delta':
          if (event.delta) {
            callState.transcriptParts.push({ role: 'assistant', text: event.delta });
          }
          break;

        case 'conversation.item.input_audio_transcription.completed':
          if (event.transcript) {
            callState.transcriptParts.push({ role: 'caller', text: event.transcript });
            console.log(`[tenant:${businessId}][${callSid}] Caller: ${event.transcript}`);
          }
          break;

        case 'response.function_call_arguments.done': {
          console.log(`[tenant:${businessId}][${callSid}] Tool call: ${event.name} | raw args: ${event.arguments}`);
          let parsedArgs;
          try {
            parsedArgs = JSON.parse(event.arguments || '{}');
          } catch (parseErr) {
            console.error(`[tenant:${businessId}][${callSid}] Failed to parse tool call arguments for ${event.name}:`, parseErr.message);
            grokWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: event.call_id,
                output: JSON.stringify({ error: `Invalid arguments: ${parseErr.message}` })
              }
            }));
            grokWs.send(JSON.stringify({ type: 'response.create' }));
            break;
          }
          const result = await executeToolCall(event.name, parsedArgs, {
            businessId,
            callerContext,
            callLogId,
            // Per-call mutable state — used by check_tee_times to stash
            // the authoritative valid_times list and by book_tee_time to
            // reject any time not in that list (anti-hallucination guard).
            callState
          });
          callState.actions.push({ tool: event.name, args: event.arguments });
          const resultStr = JSON.stringify(result);
          console.log(`[tenant:${businessId}][${callSid}] Tool result for ${event.name} (${resultStr.length} chars): ${resultStr.substring(0, 500)}`);

          grokWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: event.call_id,
              output: JSON.stringify(result)
            }
          }));

          grokWs.send(JSON.stringify({ type: 'response.create' }));

          if (event.name === 'transfer_call' && result.success) {
            const transferDelay = 3000;
            const transferUrl = appUrl || process.env.APP_URL || '';
            console.log(`[tenant:${businessId}][${callSid}] 📞 Transfer requested — will redirect in ${transferDelay}ms to ${transferUrl}/twilio/transfer`);

            if (!transferUrl) {
              console.error(`[tenant:${businessId}][${callSid}] ❌ No APP_URL available — cannot transfer call`);
            } else {
              setTimeout(async () => {
                try {
                  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
                  await twilio.calls(callSid).update({
                    url: `${transferUrl}/twilio/transfer`,
                    method: 'POST'
                  });
                  console.log(`[tenant:${businessId}][${callSid}] ✓ Call redirected to ${transferUrl}/twilio/transfer`);
                } catch (transferErr) {
                  console.error(`[tenant:${businessId}][${callSid}] ❌ Transfer redirect failed:`, transferErr.message);
                }
              }, transferDelay);
            }
          }

          break;
        }

        case 'error':
          // Suppress the harmless "Cancellation failed: no active
          // response found" race. When a caller barges in IMMEDIATELY
          // after response.created (before any audio is generated),
          // Grok's own server-side VAD often terminates the response
          // before our manual response.cancel arrives. Our state
          // tracking (PR #66) already prevents most of these, but a
          // race window exists between our response.created update
          // and our cancel reaching Grok. It's not a real error — the
          // call continues normally — but it's log noise.
          if (event.error
              && event.error.code === 'invalid_request_error'
              && /Cancellation failed: no active response/i.test(event.error.message || '')) {
            // Silently ignore. (Comment kept so future ops can grep
            // for the message and find this rationale.)
            break;
          }
          console.error(`[tenant:${businessId}][${callSid}] Grok error:`, event.error);
          break;
      }
    } catch (err) {
      console.error(`[tenant:${businessId}][${callSid}] Error processing Grok message:`, err.message);
    }
  });

  grokWs.on('close', () => {
    console.log(`[tenant:${businessId}][${callSid}] Grok connection closed`);
    clearInterval(keepAlive);
    if (conversationActive) {
      console.warn(`[tenant:${businessId}][${callSid}] Grok disconnected unexpectedly while call was active — playing failover message`);
      conversationActive = false;
      // Fire-and-forget failover so the caller hears something instead
      // of dead air. We close the Twilio WS afterward so Twilio knows
      // we're done streaming audio; calls.update() supersedes our
      // <Stream> with a fresh <Say>+<Hangup> on Twilio's side.
      playFailoverAndHangup('grok_close').finally(() => {
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      });
      return;
    }
    conversationActive = false;
  });

  grokWs.on('error', (err) => {
    console.error(`[tenant:${businessId}][${callSid}] Grok WebSocket error:`, err.message);
    conversationActive = false;
    playFailoverAndHangup('grok_error').finally(() => {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    });
  });

  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          console.log(`[tenant:${businessId}][${callSid}] Twilio stream start event: ${streamSid}`);
          break;

        case 'media':
          if (grokWs.readyState === WebSocket.OPEN) {
            const inBuf = Buffer.from(msg.media.payload, 'base64');
            const pcmBuf = mulaw8kToPcm16(inBuf);
            grokWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: pcmBuf.toString('base64')
            }));
          }
          break;

        case 'stop':
          console.log(`[tenant:${businessId}][${callSid}] Twilio stream stopped`);
          conversationActive = false;
          break;
      }
    } catch (err) {
      console.error(`[tenant:${businessId}][${callSid}] Error processing Twilio message:`, err.message);
    }
  });

  twilioWs.on('close', async () => {
    console.log(`[tenant:${businessId}][${callSid}] Call ended`);
    conversationActive = false;

    if (grokWs.readyState === WebSocket.OPEN) {
      grokWs.close();
    }

    const duration = Math.round((Date.now() - callState.startTime) / 1000);
    const transcript = callState.transcriptParts.map(p => `${p.role}: ${p.text}`).join('\n');
    const summary = callState.actions.length > 0
      ? `Actions: ${callState.actions.map(a => a.tool).join(', ')}`
      : 'Information inquiry';

    try {
      await query(
        `UPDATE call_logs SET status = 'completed', duration_seconds = $1, transcript = $2, summary = $3, ended_at = NOW()
         WHERE id = $4 AND business_id = $5`,
        [duration, transcript, summary, callLogId, businessId]
      );
    } catch (err) {
      console.error(`[tenant:${businessId}] Failed to update call log:`, err.message);
    }

    // Phase 7a — credit usage. Fire-and-forget so a billing blip never holds
    // the WebSocket cleanup path open. `recordCallUsage` swallows its own
    // errors and returns null on failure; it never throws.
    // Legacy tenants (Valleymede, plan='legacy') accumulate call_usage ledger
    // rows for visibility but bypass the enforcement gate — billing is
    // decoupled from the ability to answer calls for them by design.
    recordCallUsage(businessId, { durationSeconds: duration, callLogId })
      .then((balanceAfter) => {
        if (balanceAfter != null) {
          console.log(`[tenant:${businessId}][${callLogId}] Credits: -${duration}s, remaining ${balanceAfter}s`);
        }
      })
      .catch((err) => {
        // Belt-and-braces — recordCallUsage already catches, but a .catch here
        // guards against a future refactor accidentally letting one through.
        console.error(`[tenant:${businessId}] recordCallUsage unexpected throw:`, err.message);
      });

    // Personal Assistant post-call recap — owner gets a concise SMS summary
    // of every call. Gated on the tenant's template so golf courses are
    // unaffected. Never throws: sendPostCallSummary already swallows errors,
    // but we also fire-and-forget so a slow SMS API can't keep the call
    // cleanup path open.
    if (business?.template_key === 'personal_assistant') {
      sendPostCallSummary(businessId, {
        transcript,
        summary,
        duration,
        callerName: callerContext?.name || null,
        callerPhone: callerContext?.phone || null,
        startedAt: callState?.startTime ? new Date(callState.startTime) : new Date()
      }).catch((err) => {
        console.error(`[tenant:${businessId}] Post-call recap fire-and-forget failed:`, err.message);
      });
    }
  });
}

/**
 * Get a random greeting from the tenant's greetings table rows.
 */
async function getRandomGreeting(businessId, isKnown, callerName, businessName) {
  try {
    const res = await query(
      `SELECT message FROM greetings
        WHERE business_id = $1 AND for_known_caller = $2 AND active = true
        ORDER BY RANDOM() LIMIT 1`,
      [businessId, isKnown && callerName ? true : false]
    );
    if (res.rows.length > 0) {
      let greeting = res.rows[0].message;
      if (callerName) {
        greeting = greeting.replace(/{name}/g, callerName);
      }
      return greeting;
    }
  } catch (err) {
    console.error(`[tenant:${businessId}] Failed to get greeting:`, err.message);
  }
  return `Thanks for calling ${businessName || 'the Golf Course'}! How can I help you?`;
}

/**
 * Define the tools (functions) available to Grok.
 */
function buildToolDefinitions() {
  const all = [
    {
      type: 'function',
      name: 'check_tee_times',
      description: 'Check live available tee times on the Tee-On tee sheet for a specific date. ⚠️ DO NOT CALL THIS TOOL UNTIL YOU HAVE THE CALLER\'S EXPLICIT PARTY SIZE. If the caller said "I want a tee time Monday morning" but did NOT say how many players, you MUST first ASK "How many players?" and WAIT for their answer — do not call this tool with a guessed or default party_size. BUT — if the caller ALREADY mentioned the party size in the same utterance ("for four players", "three of us", "a foursome", "twosome", "just me", "a group of 5"), USE IT DIRECTLY and call this tool immediately. Do not re-ask. Real-call regression 2026-05-13: caller said "tee time for May 21 for four players around 10 AM" and the AI replied "How many players?" — the answer was right there. Listen to the whole utterance. Defaulting party_size to 1 returns slots that fit a single player but may NOT fit the actual group, leading to false "available" claims that staff has to clean up. Once you have the date AND the actual party size, call this tool. Results show 18-hole slots (start hole 1, full course) and 9-hole slots (start hole 10, back nine only) separately. If no 18-hole times fit, suggest 9-hole back nine as alternative. NEVER guess or assume availability.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date to check in YYYY-MM-DD format' },
          party_size: { type: 'integer', description: 'Number of players in the group — MUST come from the caller\'s explicit verbal answer ("just me", "two of us", "a foursome", "for four players", "three of us", etc.). NEVER default to 1 or any other value. If the caller has not told you how many players, ASK FIRST and wait for their reply BEFORE calling this tool. BUT — if the caller said the party size IN THE SAME UTTERANCE as their request (e.g. "tee time for May 21 FOR FOUR PLAYERS around 10 AM"), extract that number and use it directly. Do NOT re-ask "to confirm" — the number is right there. A guessed party_size returns inflated availability and produces times that don\'t actually fit the group.' }
        },
        required: ['date', 'party_size']
      }
    },
    {
      type: 'function',
      name: 'book_tee_time',
      description: 'REQUIRED to create a booking — you MUST call this tool to submit the booking request. The booking does NOT exist until this tool is called. Never tell the caller the booking was submitted without calling this first. Collect name, date, time, party size, AND number of power carts verbally — always ask "Would you like a power cart?" before calling this tool. ⚠️ HOLES: do NOT ask "18 or 9?" again at confirmation time — you already determined the answer when you offered the time. If the slot the caller picked was tagged "18-only" in your check_tee_times response, pass holes=18 without asking. If it was "9-only", pass holes=9 without asking. ONLY ask "18 or 9?" if the picked slot was tagged "18+9" (i.e. both options exist at that exact minute). Asking redundantly when there is no choice frustrates callers and slows the booking. Then call this tool immediately. CRITICAL: the `time` you pass MUST be the EXACT minute of the slot from your most recent check_tee_times response. Tee-On uses 8-minute intervals — slots end in 1:58, 2:06, 2:14, etc. NEVER round to the nearest 5 or 10 minutes. A customer was burned showing up for "2 PM" when the actual slot was 1:58 PM.',
      parameters: {
        type: 'object',
        properties: {
          // NOTE: never use a real name (especially the owner's) as the
          // example — the AI sometimes leaks it back to unknown callers
          // as a greeting ("Hey Nelson, great to hear from you again").
          // Real-call regression observed 2026-05-13: three different
          // unknown callers got addressed as "Nelson" because that was
          // the example name. Use neutral placeholder names instead.
          customer_name: { type: 'string', description: 'FULL name of the customer — MUST include both first AND last name (e.g. "Jane Smith", not just "Jane"). If the caller gave only one name, ASK for their surname before calling this tool. The Tee-On tee sheet shows this name to staff and other golfers; a single first name looks unprofessional and creates ambiguity when there are multiple bookings under the same first name. NEVER pass a single-word name to this tool.' },
          customer_phone: { type: 'string', description: 'Customer phone number' },
          // `customer_email` removed 2026-05-12: we send SMS confirmations,
          // never email, so collecting an email address adds friction and
          // surprised callers with an irrelevant question. Confirmation
          // texts use the inbound phone (or save_alternate_phone if it
          // was a landline). Re-add only when a tenant actually needs it.
          date: { type: 'string', description: 'Requested date in YYYY-MM-DD format' },
          time: { type: 'string', description: 'EXACT slot time in HH:MM 24h format — must be character-for-character one of the times from your most recent check_tee_times response. If check_tee_times offered "1:58 PM", pass "13:58" (NOT "14:00"). NEVER round to a friendlier minute. If you don\'t have an exact slot from check_tee_times, do not call this tool — call check_tee_times first.' },
          party_size: { type: 'integer', description: 'Number of players (1-8)' },
          num_carts: { type: 'integer', description: 'Number of power carts the caller wants (0 if walking / no cart). REQUIRED — you must explicitly ask the caller "Would you like a power cart?" during booking. Do NOT assume or default. If they say no, pass 0. If yes, ask how many (one cart fits two players: 4 players → 2 carts, 2 players → 1 cart). Carts are booked on the tee sheet at the same time as the tee time, so this value must be collected before calling this tool.' },
          holes: { type: 'integer', enum: [9, 18], description: '18 for full course (start hole 1) or 9 for back-nine only (start hole 10). REQUIRED — must match what the slot in check_tee_times offered. If the picked slot was tagged "18-only", pass 18 without asking. If "9-only", pass 9 without asking. Only ask the caller "18 or 9?" if the slot was tagged "18+9" (both available at that minute). Do NOT ask redundantly when only one option exists — the caller already made their pick.' },
          special_requests: { type: 'string', description: 'Any special requests or notes' },
          card_last_four: { type: 'string', description: 'Last 4 digits of the credit card provided by the caller (only when credit card is required)' }
        },
        required: ['customer_name', 'date', 'time', 'party_size', 'holes', 'num_carts']
      }
    },
    {
      type: 'function',
      name: 'save_alternate_phone',
      description: 'Save a mobile/cell phone number for a caller who is calling from a landline. This allows us to send them text message confirmations. Call this when a landline caller provides their cell number.',
      parameters: {
        type: 'object',
        properties: {
          mobile_number: { type: 'string', description: 'The mobile/cell phone number provided by the caller' }
        },
        required: ['mobile_number']
      }
    },
    {
      type: 'function',
      name: 'lookup_my_bookings',
      description: 'Look up the caller\'s confirmed upcoming bookings. Call this when: (1) a caller wants to cancel or modify — read bookings back so they can pick which one, (2) a caller forgot their tee time or wants to know when they\'re booked — read their bookings back to them. Only returns confirmed upcoming bookings.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      type: 'function',
      name: 'edit_booking',
      description: 'Request to modify a booking — change party size, time, etc. PREFERRED FLOW: call lookup_my_bookings first, read the bookings back to the caller, then pass the booking_id from the result. FALLBACK FLOW (no booking_id): if lookup_my_bookings returns no results (e.g. caller is calling from a different number than the one used to book originally), STILL call this tool — just OMIT the booking_id and pass original_date + original_time + customer_name + details so staff can manually reconcile. Never tell the caller "I\'ve submitted the request" without actually calling this tool — the modification will NOT exist in our system unless this tool runs. Real-call bug observed 2026-05-13: caller asked to add a 4th player to a 3-player booking but called from a different number, lookup returned nothing, AI said "submitted" without calling any tool. The modification was lost.',
      parameters: {
        type: 'object',
        properties: {
          booking_id: { type: 'integer', description: 'The ID of the confirmed booking to modify (from lookup_my_bookings result). OMIT this field if lookup_my_bookings did not find the booking — staff will reconcile manually using the other fields.' },
          customer_name: { type: 'string', description: 'Customer name (REQUIRED when booking_id is omitted)' },
          customer_phone: { type: 'string', description: 'Customer phone' },
          original_date: { type: 'string', description: 'Original booking date (YYYY-MM-DD). REQUIRED when booking_id is omitted so staff can find the booking on Tee-On.' },
          original_time: { type: 'string', description: 'Original booking time (HH:MM 24h). REQUIRED when booking_id is omitted.' },
          new_date: { type: 'string', description: 'New requested date (YYYY-MM-DD)' },
          new_time: { type: 'string', description: 'New requested time (HH:MM)' },
          new_party_size: { type: 'integer', description: 'New party size if changing' },
          details: { type: 'string', description: 'Description of what needs to change (e.g. "add 4th player", "move to 10 AM")' }
        },
        required: ['details']
      }
    },
    {
      type: 'function',
      name: 'cancel_booking',
      description: 'Request to cancel a booking. PREFERRED FLOW: call lookup_my_bookings first, read the bookings back, then pass the booking_id from the result. FALLBACK FLOW (no booking_id): if lookup_my_bookings returns no results, STILL call this tool — just OMIT the booking_id and pass original_date + original_time + customer_name so staff can manually reconcile. Never tell the caller "I\'ve cancelled" without actually calling this tool.',
      parameters: {
        type: 'object',
        properties: {
          booking_id: { type: 'integer', description: 'The ID of the confirmed booking to cancel (from lookup_my_bookings result). OMIT this field if lookup_my_bookings did not find the booking — staff will reconcile manually using the other fields.' },
          customer_name: { type: 'string', description: 'Customer name (REQUIRED when booking_id is omitted)' },
          customer_phone: { type: 'string', description: 'Customer phone' },
          original_date: { type: 'string', description: 'Booking date being cancelled (YYYY-MM-DD). REQUIRED when booking_id is omitted.' },
          original_time: { type: 'string', description: 'Booking time being cancelled (HH:MM 24h). REQUIRED when booking_id is omitted.' },
          details: { type: 'string', description: 'Reason for cancellation or additional notes' }
        },
        required: []
      }
    },
    {
      type: 'function',
      name: 'check_weather',
      description: 'Get current weather and forecast for the golf course location.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['current', 'forecast'],
            description: 'Get current weather or multi-day forecast'
          }
        },
        required: ['type']
      }
    },
    {
      type: 'function',
      name: 'transfer_call',
      description: 'Transfer the call to a human staff member. Use as a last resort when the AI cannot help.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the transfer is needed' }
        },
        required: ['reason']
      }
    },
    {
      type: 'function',
      name: 'lookup_customer',
      description: 'Look up a customer in the system by phone number or name.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Phone number to search' },
          name: { type: 'string', description: 'Name to search' }
        }
      }
    },
    {
      type: 'function',
      name: 'save_customer_info',
      // `email` parameter removed 2026-05-12: we don't email customers
      // (SMS only), and mentioning email in the description was enough
      // to make the AI proactively ask for one even when the caller had
      // no reason to provide it. Re-add only when a tenant actually
      // needs email for notifications.
      description: 'Save or update customer information (name, phone) when a new or existing caller provides their details.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Customer full name' },
          phone: { type: 'string', description: 'Customer phone number' }
        },
        required: ['name']
      }
    },
    {
      type: 'function',
      name: 'take_topic_message',
      description: 'Take a message for one of the operator-defined CUSTOM TOPICS in your system prompt (e.g. "Lost & Found", "Catering", "League Sign-Up"). Call this AFTER you have: (1) confirmed the topic name back to the caller, (2) collected the relevant details per the topic\'s instructions, (3) collected the caller\'s callback number. NEVER invent a topic — only call this for topics that appear in your CUSTOM TOPICS list. The summary should be concise (1-3 sentences) and capture the key facts staff need.',
      parameters: {
        type: 'object',
        properties: {
          topic_name: { type: 'string', description: 'The exact topic name from the CUSTOM TOPICS list (case-insensitive match). Use the canonical name as listed.' },
          summary: { type: 'string', description: 'Concise 1-3 sentence summary of what the caller needs. Capture key facts (what, when, where, why). Do not paraphrase loosely.' },
          caller_name: { type: 'string', description: 'The caller\'s name as they gave it. If they declined to share, pass "Unknown caller".' },
          caller_callback_number: { type: 'string', description: 'A callback number for staff. Default to the caller\'s incoming number unless they gave you a different one.' }
        },
        required: ['topic_name', 'summary']
      }
    },
    {
      type: 'function',
      name: 'take_message_for_team_member',
      description: 'Take a message for a specific team member from the TEAM DIRECTORY in your system prompt and dispatch it as an SMS to that person. Call this AFTER you have: (1) confirmed the recipient name back to the caller, (2) collected the caller\'s name and a callback number, (3) listened to the message. NEVER invent a recipient — only call this for names that appear in your TEAM DIRECTORY. If the directory is empty or the caller asks for a name not on the list, do not call this tool — apologize and offer to take a general message or transfer them.',
      parameters: {
        type: 'object',
        properties: {
          team_member_name: { type: 'string', description: 'The exact name from the TEAM DIRECTORY this message is for. Use the canonical name as listed (you can match by alias, but pass the canonical name).' },
          caller_name: { type: 'string', description: 'The caller\'s name as they gave it. If they declined to share, pass "Unknown caller".' },
          caller_phone: { type: 'string', description: 'A callback number for the recipient. Default to the caller\'s incoming number unless they gave you a different one.' },
          message: { type: 'string', description: 'A short transcript of what the caller wants to convey. Keep it under ~200 words. Do not paraphrase loosely — capture key facts (what, when, why).' }
        },
        required: ['team_member_name', 'message']
      }
    },
    // ─── Admin-line tools ─────────────────────────────────────────────
    // These four tools are exposed on EVERY call but only function for
    // calls whose caller is recognised as an admin (server-side check).
    // verify_admin_pin must be called and succeed before any of the
    // mutation tools (add/remove_announcement) will run.
    {
      type: 'function',
      name: 'verify_admin_pin',
      description: 'Verify the admin caller\'s PIN. ONLY call this when the system prompt indicates this is an admin call (the 🔐 ADMIN CALL section appears at the top). Pass the digits the caller said as a string. The tool returns { success: true } when the PIN matches, { success: false, locked: true } after 3 failed attempts (no further attempts allowed this call), or { success: false, attempts_remaining } otherwise. NEVER fabricate a success result — the tool result is the source of truth.',
      parameters: {
        type: 'object',
        properties: {
          pin: { type: 'string', description: 'The PIN the caller said, as digits (e.g. "1234"). Strip any "the PIN is" prefix the caller may have included.' }
        },
        required: ['pin']
      }
    },
    {
      type: 'function',
      name: 'add_announcement',
      description: 'Record a new operations note that will be applied to every customer call until it expires or is removed. ONLY call this for an admin caller whose PIN has been verified in this call. ALWAYS confirm the wording and scope with the admin by speaking it back before calling this tool. The scope parameter is REQUIRED: "today" means the note auto-expires at end of local day; "persistent" means it stays until manually removed. If the admin says "for today" / "just today" use "today". If they say "from now on" / "every day" / "until I change it" use "persistent". When unsure, ASK them: "Is this just for today, or moving forward?"',
      parameters: {
        type: 'object',
        properties: {
          instruction_text: { type: 'string', description: 'The full instruction in plain English, e.g. "No power carts today due to wet course conditions" or "Course closed Tuesday May 12 for tournament". Write it clearly — the AI will use this text verbatim as context for future calls.' },
          scope: { type: 'string', enum: ['today', 'persistent'], description: 'How long this note stays active. "today" auto-expires at end of local day. "persistent" stays until removed. ALWAYS ask the admin which they want — never guess.' }
        },
        required: ['instruction_text', 'scope']
      }
    },
    {
      type: 'function',
      name: 'list_announcements',
      description: 'List all currently-active operations notes for this business. Use this when the admin asks "what\'s set right now?", BEFORE adding a contradictory rule (to read back the conflict), or before removing a specific note (to find its id). Returns each note with its id, text, scope, and expires_at. Read them out naturally to the admin — don\'t list ids verbatim unless they ask.',
      parameters: { type: 'object', properties: {} }
    },
    {
      type: 'function',
      name: 'remove_announcement',
      description: 'Deactivate an existing operations note by id. ONLY call this for an admin caller whose PIN has been verified. If the admin says "remove the cart rule" without giving a number, call list_announcements first to find the matching id, then call this. Soft-delete only — the row is retained for audit.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The numeric id of the announcement to deactivate, obtained from list_announcements.' }
        },
        required: ['id']
      }
    }
  ];

  // ─── Conditional removal: check_weather ───────────────────────────
  //
  // The weather tool always returns `{ error: 'Weather service not
  // configured' }` when OPENWEATHER_API_KEY is unset, but the AI
  // happily calls it anyway and then HALLUCINATES a weather answer
  // ("No rain issues today" with zero data). Real-call regression
  // observed 2026-05-13: caller asked if it had rained, AI invented
  // a confident no, caller transferred to clubhouse to verify.
  //
  // Cleanest fix: don't even expose the tool if there's no API key.
  // No tool → no hallucinated tool call → AI falls back to "I don't
  // have current weather info, let me transfer you."
  if (!process.env.OPENWEATHER_API_KEY) {
    return all.filter(t => t.name !== 'check_weather');
  }
  return all;
}

/**
 * Execute a tool call from Grok and return the result.
 * Every branch is scoped to the caller's tenant via `ctx.businessId`.
 */
async function executeToolCall(toolName, args, ctx) {
  const { businessId, callerContext, callLogId, callState } = ctx;
  requireBusinessId(businessId, `executeToolCall/${toolName}`);

  try {
    switch (toolName) {
      case 'check_tee_times': {
        if (!teeon.isAvailable()) {
          return {
            available: null,
            error: 'tee_sheet_not_connected',
            message: '⚠️ TEE SHEET NOT CONNECTED — DO NOT say "no slots available" or "fully booked". The live tee sheet integration is offline. Tell the caller: "I\'m not able to see the live tee sheet right now — let me take your preferred date and time as a request, and staff will confirm by text once they verify."'
          };
        }
        try {
          let partySize = args.party_size || 1;

          // ─── Server-side party-size recovery ──────────────────────
          // If the AI called check_tee_times with party_size=1 (or
          // defaulted), scan the caller's recent utterances for an
          // explicit party-size mention and OVERRIDE the arg. This is
          // the belt-and-braces backup to the prompt's "don't re-ask
          // party size" rule. Even if the AI ignores the prompt and
          // either guesses or asks again, this guarantees we don't
          // pass a wrong size to the tee-sheet filter.
          //
          // Real-call bug observed 2026-05-13 (twice): caller said
          // "tee time for four players" and the AI still asked +
          // sometimes defaulted to 1.
          if (partySize === 1 && callState?.transcriptParts?.length) {
            const recentCallerText = callState.transcriptParts
              .filter(p => p.role === 'caller')
              .slice(-6) // last 6 caller turns is plenty
              .map(p => p.text)
              .join(' ')
              .toLowerCase();
            const detected = detectPartySizeFromText(recentCallerText);
            if (detected && detected !== 1) {
              console.warn(`[tenant:${businessId}][${callLogId}] ⚠️ check_tee_times called with party_size=1 but caller said "${detected}" — overriding to ${detected}`);
              partySize = detected;
              args.party_size = detected;
            }
          }

          const teeOnCfg = await getTeeOnConfigForBusiness(businessId);
          console.log(`[tenant:${businessId}][${callLogId}] check_tee_times | date: ${args.date} | party_size: ${partySize} | raw args:`, JSON.stringify(args));
          let allSlots = await teeon.checkAvailability(args.date, partySize, teeOnCfg);

          // Per-tenant 9-hole policy filter.
          //
          // Tee-On's tee sheet may legitimately list 9-hole back-nine slots
          // at times when course management does NOT want them offered to
          // callers (e.g. Valleymede only offers 9-hole back-nine before
          // ~7:26 AM and after 4 PM "twilight"). Without this filter, those
          // mid-day 9-hole entries flow through to the per-time holes
          // annotation, get tagged "18+9", and the AI asks "18 or 9?" at
          // a time when 9-hole shouldn't be on the table.
          //
          // Setting shape: nine_hole_windows = JSON array of {from, to}
          // HH:mm strings (24-hour). Slots with holes === 9 whose time
          // falls outside ALL configured windows are dropped here, before
          // any downstream code sees them. Tenants with the setting unset
          // or empty get the legacy unfiltered behaviour, so this is
          // strictly opt-in.
          try {
            const nineHoleWindows = await getSetting(businessId, 'nine_hole_windows');
            if (Array.isArray(nineHoleWindows) && nineHoleWindows.length > 0) {
              const to24 = (timeStr) => {
                const m = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
                if (!m) return null;
                let h = parseInt(m[1], 10);
                const ampm = m[3].toUpperCase();
                if (ampm === 'PM' && h !== 12) h += 12;
                if (ampm === 'AM' && h === 12) h = 0;
                return `${String(h).padStart(2, '0')}:${m[2]}`;
              };
              const inWindow = (time24, windows) => {
                if (!time24) return false;
                for (const w of windows) {
                  if (typeof w?.from === 'string' && typeof w?.to === 'string'
                      && time24 >= w.from && time24 <= w.to) return true;
                }
                return false;
              };
              const before = allSlots.length;
              allSlots = allSlots.filter(s => {
                if (s.holes !== 9) return true;
                return inWindow(to24(s.time), nineHoleWindows);
              });
              if (allSlots.length !== before) {
                console.log(
                  `[tenant:${businessId}][${callLogId}] nine_hole_windows: ` +
                  `dropped ${before - allSlots.length} 9-hole slot(s) outside policy windows`
                );
              }
            }
          } catch (filterErr) {
            console.warn(
              `[tenant:${businessId}][${callLogId}] nine_hole_windows filter failed (continuing unfiltered):`,
              filterErr.message
            );
          }

          // Subtract any pending holds — bookings the AI has taken on this
          // call (or earlier today) that staff hasn't yet pushed to Tee-On.
          // Without this, two callers in quick succession could both be
          // offered the same slot. We only subtract `status='pending'` rows
          // because once staff confirms, the row is on Tee-On and the live
          // availability already reflects it (subtracting again would
          // double-count). Group holds by HH:MM, then for each Tee-On slot
          // reduce maxPlayers by the matching held seats.
          let pendingHolds = [];
          try {
            pendingHolds = await getPendingHoldsForDate(businessId, args.date);
          } catch (holdErr) {
            console.warn(`[tenant:${businessId}][${callLogId}] pending-holds lookup failed, proceeding with live capacity only:`, holdErr.message);
          }
          const heldByTime = new Map();
          for (const h of pendingHolds) {
            if (!h.time_24h) continue;
            heldByTime.set(h.time_24h, (heldByTime.get(h.time_24h) || 0) + (h.party_size || 0));
          }
          const slotTimeTo24h = (str) => {
            if (!str) return null;
            const m = String(str).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
            if (m) {
              let h = parseInt(m[1], 10);
              const mins = m[2];
              const ampm = m[3].toUpperCase();
              if (ampm === 'PM' && h !== 12) h += 12;
              if (ampm === 'AM' && h === 12) h = 0;
              return `${String(h).padStart(2, '0')}:${mins}`;
            }
            const m2 = String(str).trim().match(/^(\d{1,2}):(\d{2})/);
            return m2 ? `${m2[1].padStart(2, '0')}:${m2[2]}` : null;
          };
          let heldSubtractions = 0;
          if (heldByTime.size > 0) {
            for (const slot of allSlots) {
              const key = slotTimeTo24h(slot.time);
              const held = key ? heldByTime.get(key) : 0;
              if (held && held > 0) {
                slot.maxPlayers = Math.max(0, (slot.maxPlayers || 0) - held);
                heldSubtractions++;
              }
            }
            console.log(
              `[tenant:${businessId}][${callLogId}] Applied ${pendingHolds.length} pending hold(s) — adjusted ${heldSubtractions} slot(s) on ${args.date}`
            );
          }

          const slots = allSlots.filter(s => s.maxPlayers >= partySize);

          console.log(`[tenant:${businessId}][${callLogId}] Tee times for ${args.date}: ${allSlots.length} total slots, ${slots.length} fit party of ${partySize}`);

          // Show every slot that has ANY open seats — don't pre-filter by
          // requested party_size. Operators want the AI to be a transparent
          // reporter of the live tee sheet, not a strict filter that hides
          // partial-capacity slots. We annotate each slot with its remaining
          // seats; the AI explains what fits the caller's party (and offers
          // to split if needed).
          const openSlots = allSlots.filter(s => s.maxPlayers > 0);

          if (openSlots.length === 0) {
            // Diagnostic logging so ops can see in Railway logs what Tee-On
            // actually returned. The most common reasons for empty
            // allSlots: (a) Tee-On's API filters past times so a same-day
            // query late in the day is empty, (b) advance-booking cutoff
            // (public callers often can't see >7 days out), (c) a real
            // tournament/maintenance day, (d) Tee-On session issue.
            // Without this log we can't tell which.
            console.log(
              `[tenant:${businessId}][${callLogId}] check_tee_times empty result for ${args.date} ` +
              `(party=${partySize}). Raw slot count from teeon=${allSlots.length}, after-holds open=${openSlots.length}. ` +
              `pendingHoldsCount=${pendingHolds.length}.`
            );
            // Friendlier message — never tell the caller "fully booked"
            // and never offer a "booking request" path: per current
            // operations policy we ONLY book real, confirmed live slots.
            // If genuinely none are open, the AI suggests a different
            // date or asks the caller to call back later. Real-call
            // policy correction observed 2026-05-12: we don't accept
            // requests, only confirmed bookings.
            return {
              available: false,
              message: `I'm not seeing any open tee times for ${args.date} in our online system right now. That could mean a busy day, a private event, weather, or an advance-booking window. ⚠️ POLICY: do NOT offer to "take a booking request" or have staff "confirm later" — we only book real, currently-open slots. Instead, tell the caller: "I don't see any open slots for that date right now. Would you like to try a different day, or check back later?" Then either re-run check_tee_times for a different date, or end the call politely.`
            };
          }

          // Split every category into "fits the party" vs "partial capacity"
          // BEFORE building the message. Partial slots can't be the headline
          // answer for a party of N — they're only useful if the caller is
          // willing to split or if no full-fit slot exists. Mixing the two
          // in the same line confused the AI: it would read out the first
          // few times in time order, which often hits partial slots first
          // and never warns the caller they don't fit.
          const full18 = openSlots.filter(s => s.holes === 18);
          const back9 = openSlots.filter(s => s.holes === 9);

          const full18Fits = full18.filter(s => s.maxPlayers >= partySize);
          const full18Partial = full18.filter(s => s.maxPlayers < partySize);
          const back9Fits = back9.filter(s => s.maxPlayers >= partySize);
          const back9Partial = back9.filter(s => s.maxPlayers < partySize);

          const morning18Fits = full18Fits.filter(s => s.time.includes('AM'));
          const afternoon18Fits = full18Fits.filter(s => s.time.includes('PM'));
          const morning18Partial = full18Partial.filter(s => s.time.includes('AM'));
          const afternoon18Partial = full18Partial.filter(s => s.time.includes('PM'));
          const morningBack9Fits = back9Fits.filter(s => s.time.includes('AM'));
          const morningBack9Partial = back9Partial.filter(s => s.time.includes('AM'));

          const fitsParty = full18Fits.length + back9Fits.length;

          // Highlights — computed up front so the AI sees them in KEY FACTS
          // regardless of which category section happened to render.
          const earliestFits18 = full18Fits[0] || null;
          const earliestPartial18 = full18Partial[0] || null;
          const fitsList18 = full18Fits.map(s => s.time);

          // Format helper. For partial slots ALWAYS show seat count so the
          // AI can never accidentally treat them as full-fit times.
          const fmtPartial = (s) => `${s.time} (only ${s.maxPlayers} seat${s.maxPlayers === 1 ? '' : 's'})`;

          let message = '';
          // Self-correcting safeguard: if the AI called us with partySize=1
          // it may have defaulted/guessed. A real "I just want to play
          // alone" caller is rarer than an AI calling speculatively before
          // asking the caller. Prepend a loud reminder so the AI re-checks
          // before offering any times. False positives (genuine singles)
          // cost the AI one extra question; false negatives (offering
          // foursome-incompatible slots) cost a real customer the booking.
          if (partySize === 1) {
            message += `⚠️⚠️⚠️ PARTY SIZE = 1 — VERIFY BEFORE OFFERING ANY TIMES ⚠️⚠️⚠️\n` +
              `You called check_tee_times with party_size=1. If the caller has NOT explicitly told you ` +
              `they want to play alone (e.g. "just me", "for myself"), STOP and ASK "How many players?" ` +
              `before reading any of the times below. After they answer, RE-CALL this tool with the actual ` +
              `party size. The slots below are filtered for 1 player — many will NOT fit a group of 2-4.\n\n`;
          }
          message += `LIVE tee sheet for ${args.date}, party of ${partySize}: ${openSlots.length} open slot${openSlots.length === 1 ? '' : 's'} total — ${fitsParty} of those fit your full party of ${partySize}.\n`;

          // ---------- TIMES THAT FIT THE FULL PARTY (the headline answer) ----------
          if (full18Fits.length > 0 || back9Fits.length > 0) {
            message += `\n=== TIMES THAT FIT YOUR FULL PARTY OF ${partySize} ===`;
            if (morning18Fits.length > 0) {
              message += `\nMorning 18-hole: ${morning18Fits.map(s => s.time).join(', ')}`;
              if (morning18Fits[0].price) message += ` (${morning18Fits[0].price} each)`;
            }
            if (afternoon18Fits.length > 0) {
              const earlyPM = afternoon18Fits.slice(0, 6);
              message += `\nAfternoon 18-hole: ${earlyPM.map(s => s.time).join(', ')}`;
              if (afternoon18Fits.length > 6) message += ` and ${afternoon18Fits.length - 6} more`;
              // Twilight starts at 4 PM May–September, 3 PM from Oct 1
              // (Valleymede policy). Was hardcoded to 3 PM year-round,
              // which mislabeled summer 3 PM slots as twilight (manager
              // report). Compute the season-correct cutoff in 24h.
              const twMonth = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto', month: 'numeric' }));
              const twilightHour24 = (twMonth >= 5 && twMonth <= 9) ? 16 : 15;
              const to24h = (t) => { const m = String(t).match(/(\d+):(\d+)\s*(AM|PM)/i); if (!m) return 0; let h = parseInt(m[1], 10); if (/PM/i.test(m[3]) && h !== 12) h += 12; if (/AM/i.test(m[3]) && h === 12) h = 0; return h; };
              const latePM = afternoon18Fits.filter(s => { const h = to24h(s.time); return h >= twilightHour24 && h < 21; });
              if (latePM.length > 0 && latePM[0].price && latePM[0].price !== morning18Fits?.[0]?.price) {
                message += ` (twilight rate ${latePM[0].price} starts at ${twilightHour24 === 16 ? '4 PM' : '3 PM'})`;
              }
            }
            if (morningBack9Fits.length > 0) {
              message += `\nMorning 9-hole (back nine, starts hole 10): ${morningBack9Fits.map(s => s.time).join(', ')}`;
              if (morningBack9Fits[0].price) message += ` (${morningBack9Fits[0].price} each)`;
            }
          } else {
            message += `\n=== NO TIMES FIT ALL ${partySize} PLAYERS TODAY ===`;
            message += `\nThere are open seats on the sheet but no single slot has ${partySize} consecutive open spots. Options for the caller:`;
            message += `\n  1. Split the group across two adjacent partial slots (e.g. a pair + a single).`;
            message += `\n  2. Downsize the party (e.g. 2 of you go now, 1 follows another day).`;
            message += `\n  3. Try a different date — staff often have moves coming.`;
            message += `\n  4. Take a booking REQUEST and let staff confirm by text/phone.`;
          }

          // ---------- PARTIAL SLOTS (only mention if asked OR if no full-fit) ----------
          // Always include the data so the AI has it when the caller asks
          // "what about earlier times?" or volunteers to split — but flag
          // it loudly so the AI never opens with these.
          const hasPartial = full18Partial.length + back9Partial.length > 0;
          if (hasPartial) {
            message += `\n\n=== PARTIAL-CAPACITY SLOTS (DO NOT OFFER UNLESS CALLER ASKS OR NO FULL-FIT EXISTS) ===`;
            message += `\nThese are open but have FEWER than ${partySize} seats — your party would need to split or downsize.`;
            if (morning18Partial.length > 0) {
              message += `\nMorning 18-hole partial: ${morning18Partial.slice(0, 6).map(fmtPartial).join(', ')}`;
              if (morning18Partial.length > 6) message += ` and ${morning18Partial.length - 6} more`;
            }
            if (afternoon18Partial.length > 0) {
              message += `\nAfternoon 18-hole partial: ${afternoon18Partial.slice(0, 6).map(fmtPartial).join(', ')}`;
              if (afternoon18Partial.length > 6) message += ` and ${afternoon18Partial.length - 6} more`;
            }
            if (morningBack9Partial.length > 0) {
              message += `\nMorning 9-hole partial: ${morningBack9Partial.slice(0, 4).map(fmtPartial).join(', ')}`;
            }
          }

          // ---------- PER-TIME HOLES AVAILABILITY ----------
          // Real customer feedback: AI was asking "18 or 9 holes?" for
          // morning slots like 8:06 AM that have NO 9-hole version, just
          // because 9-hole exists earlier in the morning (6:30-7:26 AM).
          // The morning_9 / afternoon_9 booleans were too coarse — the AI
          // needs to know what's available AT THE SPECIFIC TIMES IT'S
          // OFFERING, not in the broad morning/afternoon bucket.
          //
          // Build a map: for each unique time string, which holes options
          // are listed. Then surface this per-time when the AI is choosing
          // what to offer. AI rule: only ask "18 or 9?" if AT LEAST ONE of
          // the offered times has BOTH listed.
          const holesByTime = {};
          for (const s of openSlots) {
            const t = s.time;
            if (!holesByTime[t]) holesByTime[t] = { eighteen: false, nine: false };
            if (s.holes === 18) holesByTime[t].eighteen = true;
            if (s.holes === 9)  holesByTime[t].nine = true;
          }
          // Stringify for prompt embedding. Sort by time so AI reads in order.
          const holesAnnotated = Object.entries(holesByTime)
            .map(([time, h]) => {
              const both = h.eighteen && h.nine;
              const tag = both ? '18+9' : (h.eighteen ? '18-only' : '9-only');
              return `${time} (${tag})`;
            });

          // Whole-period booleans — kept for backwards compat, but the
          // AI is now told NOT to base the holes question on these.
          const has_morning_18  = morning18Fits.length > 0 || morning18Partial.length > 0;
          const has_morning_9   = morningBack9Fits.length > 0 || morningBack9Partial.length > 0;
          const has_afternoon_18 = afternoon18Fits.length > 0 || afternoon18Partial.length > 0;
          const has_afternoon_9 = back9Fits.filter(s => s.time.includes('PM')).length > 0
                              || back9Partial.filter(s => s.time.includes('PM')).length > 0;
          const holes_available = {
            morning:    { eighteen: has_morning_18,    nine: has_morning_9 },
            afternoon:  { eighteen: has_afternoon_18,  nine: has_afternoon_9 }
          };

          message += `\n\nPER-TIME HOLES AVAILABILITY (CRITICAL — use this, NOT the morning/afternoon bucket):`;
          message += `\nEach time below is annotated with what's actually open at THAT minute:`;
          message += `\n  • "18+9" — both 18-hole AND 9-hole back-nine are open at this exact time`;
          message += `\n  • "18-only" — only 18-hole at this minute. NO 9-hole version exists here.`;
          message += `\n  • "9-only" — only 9-hole back-nine at this minute. NO 18-hole version.`;
          message += `\n\nAnnotated times: ${holesAnnotated.length === 0 ? '(none)' : holesAnnotated.join(' | ')}`;
          message += `\n\n⚠️ HOW TO DECIDE WHETHER TO ASK "18 OR 9?":`;
          message += `\n  1. Look at the SPECIFIC times you are about to offer the caller.`;
          message += `\n  2. If ALL of those times are tagged "18-only" → DO NOT ASK. Just say "for 18 holes" and continue.`;
          message += `\n  3. If ALL of those times are tagged "9-only" → DO NOT ASK. Just say "for 9 holes back nine" and continue.`;
          message += `\n  4. ONLY if AT LEAST ONE offered time is tagged "18+9" should you ask the holes question.`;
          message += `\n  5. Real example: caller asks for "around 8 AM" and you offer 8:06 AM (18-only), 8:14 AM (18-only), 8:22 AM (18-only) — ALL 18-only — so DON'T ask the holes question. Just say "I've got 8:06, 8:14, and 8:22 open for 18 holes — which works?"`;

          // ---------- KEY FACTS — flat facts the AI can quote directly ----------
          message += `\n\nKEY FACTS:`;
          if (earliestFits18) {
            message += `\n• Earliest 18-hole that fits all ${partySize}: ${earliestFits18.time}`;
          }
          if (fitsList18.length > 0) {
            const sample = fitsList18.slice(0, 6).join(', ');
            message += `\n• All 18-hole times that fit ${partySize}: ${sample}${fitsList18.length > 6 ? ` and ${fitsList18.length - 6} more` : ''}`;
          }
          if (!earliestFits18 && earliestPartial18) {
            message += `\n• No 18-hole slot fits all ${partySize}. Earliest partial 18-hole is ${earliestPartial18.time} with only ${earliestPartial18.maxPlayers} seat${earliestPartial18.maxPlayers === 1 ? '' : 's'}.`;
          }

          // ---------- HARD RULES — strongly-worded so the AI doesn't drift ----------
          // ---------- AUTHORITATIVE WHITELIST — every time string the AI is allowed to say ----------
          // Exhaustive list of every slot returned by Tee-On for this date,
          // both fits + partials, both 18-hole and 9-hole. The AI is told
          // (in big letters below, AND in the system prompt, AND in the
          // book_tee_time tool description) that EVERY time it says aloud
          // must appear character-for-character in this list. The server-side
          // book_tee_time validator also rejects times not in this whitelist
          // (callState.lastValidTimes), so even if the model hallucinates
          // a time verbally, it can't actually book one.
          const valid_times = openSlots.map(s => s.time);
          // Also stash on the per-call state so book_tee_time can validate.
          if (callState && typeof callState === 'object') {
            callState.lastValidTimes = valid_times;
            callState.lastValidTimesDate = args.date;
            callState.lastValidTimesAt = Date.now();
          }

          message += `\n\n=== AUTHORITATIVE TIME LIST — EVERY VALID TIME FOR ${args.date} ===
Below is the EXACT list of times you may speak aloud. NO OTHER TIMES EXIST. NEVER offer a time that isn't in this list. NEVER round, interpolate, extrapolate, or invent times based on patterns from other times.

VALID TIMES: ${valid_times.length === 0 ? '(none)' : valid_times.join(' | ')}

If you are about to say a time and it does NOT appear above, STOP. Either re-call check_tee_times, or tell the caller you don't have that time.`;

          message += `\n\nRULES (FOLLOW EXACTLY):
- The caller asked for a party of ${partySize}. Your default answer MUST come from the "TIMES THAT FIT YOUR FULL PARTY" section above. NEVER offer a partial-capacity slot as if it fits — those slots have FEWER than ${partySize} seats and would force the group to split.
- When the caller asks for "earliest" or "what's available" — lead with the EARLIEST FULL-FIT time. Do NOT lead with a partial slot. Only mention partial slots if (a) the caller explicitly asks about a different time, (b) the caller volunteers to split the group, or (c) no full-fit slot exists at all.
- If NO full-fit slot exists today, say so plainly: "I'm not seeing a single tee time that has all ${partySize} of you together on ${args.date}. I have a couple of slots with 1 or 2 seats — would you want to split the group, try a different day, or have me take a request and let staff confirm by text?"
- If they ask about a SPECIFIC time, answer for that time directly — including its seat count if it's partial.
- 18 holes = start hole 1, full course. 9 holes = start hole 10, back nine only.
- 🚫 NEVER INVENT TIMES. Tee-On uses an irregular 8-minute grid (e.g. 4:06, 4:22, 4:46, 4:54 — NOT 4:02, 4:10, 4:18). If you don't see a specific time in the AUTHORITATIVE TIME LIST above, that time DOES NOT EXIST. A real customer was nearly told to show up for "4:02 PM" — a slot that never existed. NEVER do that. Read times from the list verbatim.
- ⚠️ CRITICAL — When you say a time aloud, say the EXACT minute as it appears in the list. When you eventually call book_tee_time, pass the EXACT slot time character-for-character. If the caller asked for "2 PM" and the closest valid time is 1:58 PM, you MUST say "1:58 PM" — never paraphrase as "2 PM" or "around 2".`;

          console.log(`[tenant:${businessId}][${callLogId}] Tee times for ${args.date}: ${openSlots.length} open (${fitsParty} fit ${partySize}); ${full18.length} 18-hole / ${back9.length} 9-hole; whitelist=${valid_times.length} times; AM18=${has_morning_18} AM9=${has_morning_9} PM18=${has_afternoon_18} PM9=${has_afternoon_9}`);
          return { available: true, date: args.date, partySize, total: openSlots.length, fits_party: fitsParty, valid_times, holes_available, message };
        } catch (err) {
          console.error(`[tenant:${businessId}][TeeOn] checkAvailability error:`, err.message);
          // Explicit, AI-readable contract: this is a "could not reach
          // Tee-On" state, NOT a "no slots" state. Real-call observed
          // 2026-05-11: AI translated this into "No open slots for three
          // players Friday" because the prior wording was ambiguous.
          return {
            available: null,
            error: 'tee_sheet_unreachable',
            message: '⚠️ TEE SHEET UNREACHABLE — DO NOT say "no slots available" or "fully booked". The live tee sheet is temporarily unreachable (rate limit, network, or Tee-On maintenance). Tell the caller: "I\'m having trouble reaching the live tee sheet right now — let me take your request and have staff confirm by text once they verify the time." Then collect name, phone, date, party size, holes, carts and call book_tee_time normally; staff will confirm manually.'
          };
        }
      }

      case 'book_tee_time': {
        if (!args.customer_name || typeof args.customer_name !== 'string' || !args.customer_name.trim()) {
          console.warn(`[tenant:${businessId}][${callLogId}] ⚠️ book_tee_time called with invalid customer_name:`, args.customer_name);
          return { success: false, message: 'I need your name to complete the booking. Can you tell me your name?' };
        }
        // First-AND-last-name guard. Tee-On displays the booker's name to
        // staff and other golfers, and a single first name creates ambiguity
        // when multiple bookings share the same first name. The AI prompt
        // tells the model to collect both, but we enforce server-side too.
        const trimmedName = args.customer_name.trim();
        const nameWords = trimmedName.split(/\s+/).filter(w => w.length > 0);
        if (nameWords.length < 2) {
          console.warn(`[tenant:${businessId}][${callLogId}] ⚠️ book_tee_time called with single-word name: "${trimmedName}"`);
          return {
            success: false,
            message: `The name you passed ("${trimmedName}") only has one word. Tee-On bookings need both first AND last name. ASK the caller now: "And your last name?" Then re-call book_tee_time with the full name (e.g. "Jane Smith"). Do NOT proceed with just a first name.`
          };
        }
        if (!args.date || typeof args.date !== 'string') {
          console.warn(`[tenant:${businessId}][${callLogId}] ⚠️ book_tee_time called with invalid date:`, args.date);
          return { success: false, message: 'I need a date for the booking. What date works for you?' };
        }
        if (!args.party_size || args.party_size < 1 || args.party_size > 8) {
          console.warn(`[tenant:${businessId}][${callLogId}] ⚠️ book_tee_time called with invalid party_size:`, args.party_size);
          return { success: false, message: 'How many players will be in your group?' };
        }

        // ⚠️ ANTI-HALLUCINATION GUARD ⚠️
        // The model has been observed inventing tee-time slots that don't
        // exist on the live tee sheet (e.g. "4:02 PM, 4:10 PM, 4:18 PM"
        // when Tee-On's real after-4-PM slots are 4:06, 4:22, 4:46, 4:54).
        // We refuse to write a booking_request for any time that wasn't
        // returned by check_tee_times during this call.
        //
        // The whitelist is stashed on callState by check_tee_times. If
        // callState has a list AND the date matches AND the time isn't on
        // the list, we reject the booking and force the AI to re-check.
        // If callState is empty (e.g. caller hasn't asked about availability
        // yet — booking-by-request flow), we let it through; the existing
        // booking flow always treats requests as pending until staff
        // confirms via Tee-On directly.
        if (args.time && callState?.lastValidTimes?.length > 0 &&
            callState.lastValidTimesDate === args.date) {
          const askedTime = String(args.time).trim();
          // Match either the raw slot string ("4:46 PM") or 24h equivalent.
          // The whitelist holds slot strings as Tee-On returned them
          // ("4:46 PM"); the AI may pass either format.
          const whitelist = callState.lastValidTimes;
          const askedAs24h = (() => {
            const m = askedTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
            if (!m) return askedTime;
            let h = parseInt(m[1], 10); const min = m[2]; const ampm = (m[3] || '').toUpperCase();
            if (ampm === 'PM' && h !== 12) h += 12;
            if (ampm === 'AM' && h === 12) h = 0;
            return `${String(h).padStart(2, '0')}:${min}`;
          })();
          // Convert each whitelist entry to 24h for comparison.
          const whitelist24 = whitelist.map(t => {
            const m = String(t).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
            if (!m) return null;
            let h = parseInt(m[1], 10); const min = m[2]; const ampm = (m[3] || '').toUpperCase();
            if (ampm === 'PM' && h !== 12) h += 12;
            if (ampm === 'AM' && h === 12) h = 0;
            return `${String(h).padStart(2, '0')}:${min}`;
          }).filter(Boolean);
          const matched = whitelist24.includes(askedAs24h);
          if (!matched) {
            console.warn(
              `[tenant:${businessId}][${callLogId}] ⚠️ book_tee_time REJECTED — ` +
              `time "${askedTime}" (24h=${askedAs24h}) not in whitelist for ${args.date}. ` +
              `Whitelist had ${whitelist.length} times: ${whitelist.slice(0, 8).join(', ')}${whitelist.length > 8 ? '…' : ''}`
            );
            return {
              success: false,
              error: 'time_not_in_whitelist',
              message: `That specific time isn't on the live tee sheet. Re-call check_tee_times with the same date and party size — DO NOT pick a time from memory or pattern. Pass the EXACT slot time you see in the AUTHORITATIVE TIME LIST in the response. Then call book_tee_time again with that exact value.`
            };
          }
        }

        console.log(`[tenant:${businessId}][${callLogId}] 📅 Processing booking:`, {
          customer: args.customer_name,
          phone: args.customer_phone || callerContext.phone,
          date: args.date,
          time: args.time,
          partySize: args.party_size,
          carts: args.num_carts
        });

        try {
          // Coerce holes to 9 or 18 if the AI passed it; otherwise null
          // and the column stays NULL (legacy behaviour). The AI tool
          // schema has it as required + enum, but defense-in-depth.
          const holesArg = args.holes === 9 || args.holes === '9' ? 9
                         : args.holes === 18 || args.holes === '18' ? 18
                         : null;

          // ─── Idempotency guard ──────────────────────────────────────
          //
          // The AI has been observed firing book_tee_time TWICE in
          // rapid succession (within 1 second) with identical args
          // during a single call. That creates duplicate
          // booking_request rows that staff sees on the Bookings page.
          // Real bookings observed twinning this way: Kevin Hornberg
          // (#109/#110), Brian Duff (#118/#119), Dave Taylor
          // (#120/#121), Carter Biekle (#123/#124), Mark Stewart
          // (#127/#128), Craig Neil (#130/#131) — same call_id,
          // <2s apart, identical args.
          //
          // We stash each successful booking on callState.recentBookings.
          // Before creating a new one, we check whether the same call
          // already booked the same (customerName, date, time, partySize)
          // within the last 30 seconds. If so, return the EXISTING
          // booking_request_id with the same success message — the AI
          // sees no behavioural change but no duplicate row is created.
          //
          // 30 sec window is generous; the typical retry-burst is <2s.
          // We keep the array small (last 8) so the linear scan stays
          // cheap.
          if (!Array.isArray(callState.recentBookings)) {
            callState.recentBookings = [];
          }
          const dedupKey = `${(args.customer_name || '').toLowerCase().trim()}|${args.date}|${args.time}|${args.party_size}`;
          const now = Date.now();
          const recent = callState.recentBookings.find(b =>
            b.key === dedupKey && (now - b.t) < 30_000
          );
          if (recent) {
            console.warn(
              `[tenant:${businessId}][${callLogId}] ⚠️ book_tee_time DUPLICATE suppressed — ` +
              `same (${dedupKey}) was just booked as #${recent.id} ` +
              `${Math.round((now - recent.t) / 100) / 10}s ago. ` +
              `Returning existing booking instead of creating a new row.`
            );
            return {
              success: true,
              message: `Booking request already submitted for ${args.customer_name}, ${args.date} at ${args.time}, ${args.party_size} player${args.party_size === 1 ? '' : 's'}. Confirmation text will follow once staff approves.`,
              bookingId: recent.id,
              deduplicated: true
            };
          }

          const booking = await createBookingRequest({
            businessId,
            customerId: callerContext.customerId,
            customerName: args.customer_name,
            customerPhone: args.customer_phone || callerContext.phone,
            customerEmail: args.customer_email,
            requestedDate: args.date,
            requestedTime: args.time,
            partySize: args.party_size,
            numCarts: args.num_carts || 0,
            holes: holesArg,
            specialRequests: args.special_requests,
            cardLastFour: args.card_last_four || null,
            callId: callLogId
          });

          // Record for the idempotency guard above. Trim to last 8 to
          // keep callState small for long calls.
          callState.recentBookings.push({ key: dedupKey, id: booking.id, t: now });
          if (callState.recentBookings.length > 8) {
            callState.recentBookings.splice(0, callState.recentBookings.length - 8);
          }

          // Auto-save caller's name into the tenant's customer row
          if (callerContext.customerId && args.customer_name) {
            try {
              await updateCustomer(businessId, callerContext.customerId, {
                name: args.customer_name,
                phone: args.customer_phone || undefined,
                email: args.customer_email || undefined
              });
              callerContext.name = args.customer_name;
              console.log(`[tenant:${businessId}][${callLogId}] Auto-saved customer name from booking: ${args.customer_name}`);
            } catch (saveErr) {
              console.warn(`[tenant:${businessId}][${callLogId}] Could not auto-save customer name:`, saveErr.message);
            }
          }

          const smsNote = callerContext.isLandline && !callerContext.alternatePhone
            ? 'Since they called from a home phone and did not provide a cell number, let them know staff will call them back to confirm instead of texting.'
            : callerContext.isLandline && callerContext.alternatePhone
            ? `They WILL receive a confirmation TEXT MESSAGE at their cell number (${callerContext.alternatePhone}) once staff approves it.`
            : 'They WILL receive a confirmation TEXT MESSAGE once staff approves it. The tee time is NOT guaranteed until they get that text. Make sure they understand to watch for the text.';

          return {
            success: true,
            message: `Booking REQUEST submitted for ${args.customer_name}, ${args.date} at ${args.time || 'flexible time'}, ${args.party_size} players. IMPORTANT: Tell the caller this is a REQUEST only — it is NOT confirmed yet. ${smsNote}`,
            bookingId: booking.id
          };
        } catch (dbErr) {
          console.error(`[tenant:${businessId}][${callLogId}] ❌ BOOKING CREATION FAILED:`, dbErr.message, {
            customer: args.customer_name,
            date: args.date,
            time: args.time,
            partySize: args.party_size
          });
          return {
            success: false,
            message: `I had trouble saving your booking request. Please try again or call us back.`,
            error: dbErr.message
          };
        }
      }

      case 'lookup_my_bookings': {
        const phone = callerContext.phone;
        if (!phone) {
          return { found: false, message: 'I don\'t have your phone number on file, so I can\'t look up your bookings. Can you give me the name or date of your booking?' };
        }
        const bookings = await getConfirmedBookingsByPhone(businessId, phone);
        console.log(`[tenant:${businessId}][${callLogId}] lookup_my_bookings for ${phone}: ${bookings.length} confirmed bookings`);

        if (bookings.length === 0) {
          return { found: false, count: 0, message: 'No confirmed upcoming bookings found for this phone number. If they believe they have a booking, take their details and create a cancellation/modification request for staff.' };
        }

        const formatted = bookings.map(b => {
          const date = new Date(b.requested_date);
          const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
          const monthDay = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
          const time = b.requested_time || 'no specific time';
          return {
            booking_id: b.id,
            date: b.requested_date,
            display_date: `${dayName}, ${monthDay}`,
            time: time,
            party_size: b.party_size,
            name: b.customer_name
          };
        });

        let message = `Found ${bookings.length} confirmed upcoming booking${bookings.length > 1 ? 's' : ''}:\n`;
        formatted.forEach((b, i) => {
          message += `\n${i + 1}. ${b.display_date} at ${b.time} — ${b.party_size} player${b.party_size !== 1 ? 's' : ''} (booking #${b.booking_id})`;
        });
        message += '\n\nRead these back to the caller naturally and ask which booking they want to cancel or change. Use the booking_id when calling cancel_booking or edit_booking.';

        return { found: true, count: bookings.length, bookings: formatted, message };
      }

      case 'edit_booking': {
        let originalBooking = null;
        if (args.booking_id) {
          originalBooking = await getBookingById(businessId, args.booking_id);
        }

        const mod = await createModificationRequest({
          businessId,
          customerId: callerContext.customerId,
          customerName: args.customer_name || originalBooking?.customer_name || callerContext.name,
          customerPhone: args.customer_phone || callerContext.phone,
          requestType: 'modify',
          originalDate: args.original_date || originalBooking?.requested_date,
          originalTime: args.original_time || originalBooking?.requested_time,
          newDate: args.new_date,
          newTime: args.new_time,
          details: (args.details || '') + (args.new_party_size ? ` | New party size: ${args.new_party_size}` : '') + (args.booking_id ? ` | Booking #${args.booking_id}` : ''),
          callId: callLogId
        });
        return {
          success: true,
          message: `Modification request submitted for ${originalBooking ? originalBooking.requested_date : args.original_date || 'the booking'}. Tell the caller: this change is a REQUEST — it is NOT confirmed yet. They will receive a confirmation TEXT MESSAGE once staff processes it.`,
          requestId: mod.id
        };
      }

      case 'cancel_booking': {
        let bookingToCancel = null;
        if (args.booking_id) {
          bookingToCancel = await getBookingById(businessId, args.booking_id);
        }

        const cancel = await createModificationRequest({
          businessId,
          customerId: callerContext.customerId,
          customerName: args.customer_name || bookingToCancel?.customer_name || callerContext.name,
          customerPhone: args.customer_phone || callerContext.phone,
          requestType: 'cancel',
          originalDate: args.original_date || bookingToCancel?.requested_date,
          originalTime: args.original_time || bookingToCancel?.requested_time,
          details: (args.details || 'Cancellation requested by caller') + (args.booking_id ? ` | Booking #${args.booking_id}` : ''),
          callId: callLogId
        });
        return {
          success: true,
          message: `Cancellation request submitted for ${bookingToCancel ? bookingToCancel.requested_date : args.original_date || 'the booking'}. Tell the caller: this cancellation is a REQUEST — it will be processed by staff. They will receive a confirmation TEXT MESSAGE once it's done.`,
          requestId: cancel.id
        };
      }

      case 'check_weather': {
        if (args.type === 'forecast') {
          return await getForecast(businessId, 3);
        }
        return await getCurrentWeather(businessId);
      }

      case 'transfer_call': {
        // Settings → column precedence. The Settings UI writes to the
        // settings.transfer_number row; Edit Tenant writes to the
        // businesses.transfer_number column. Originally we read the
        // column first and fell through to settings only if empty —
        // which meant the in-tenant Settings UI was effectively
        // ignored when the column had a stale auto-populated value.
        // Settings wins now because that's the more-recent operator
        // intent in the common case (tenant admin setting their own
        // dispatcher number from inside the tenant UI).
        const fromSettingsRaw = await getSetting(businessId, 'transfer_number').catch(() => null);
        const fromSettings = typeof fromSettingsRaw === 'string'
          ? fromSettingsRaw
          : (fromSettingsRaw?.number || fromSettingsRaw?.value || null);
        let transferNumber = fromSettings || null;
        if (!transferNumber) {
          const business = await getBusinessById(businessId).catch(() => null);
          transferNumber = business?.transfer_number || null;
        }
        console.log(`[tenant:${businessId}][${callLogId}] 📞 Transfer setting: ${JSON.stringify(transferNumber)} (source: ${fromSettings ? 'settings' : 'column'})`);
        if (!transferNumber) {
          return {
            success: false,
            message: 'No staff phone number configured. I can take a message and have someone call you back.'
          };
        }

        const normalizedForLog = String(transferNumber).replace(/[^+\d]/g, '');
        console.log(`[tenant:${businessId}][${callLogId}] 📞 Transfer requested — will redirect to ${normalizedForLog}. Reason: ${args.reason}`);
        return {
          success: true,
          transfer_to: transferNumber,
          message: `Tell the caller you're connecting them to a staff member now. Say something brief like "One sec, let me connect you." Then STOP talking — the call will be transferred automatically.`
        };
      }

      case 'lookup_customer': {
        let results = [];
        if (args.phone) {
          const customer = await lookupByPhone(businessId, args.phone);
          if (customer) results.push(customer);
        }
        if (args.name) {
          const customers = await lookupByName(businessId, args.name);
          results = results.concat(customers);
        }
        if (results.length === 0) {
          return { found: false, message: 'No customer found with that information.' };
        }
        return {
          found: true,
          customers: results.map(c => ({
            name: c.name,
            phone: c.phone,
            email: c.email,
            callCount: c.call_count
          }))
        };
      }

      case 'save_customer_info': {
        console.log(`[tenant:${businessId}][${callLogId}] save_customer_info | customerId: ${callerContext.customerId} | name: ${args.name} | email: ${args.email}`);
        if (callerContext.customerId) {
          try {
            const updated = await updateCustomer(businessId, callerContext.customerId, {
              name: args.name,
              email: args.email,
              phone: args.phone
            });
            console.log(`[tenant:${businessId}][${callLogId}] Customer saved: ${updated?.name} (ID: ${updated?.id})`);
            if (args.name) callerContext.name = args.name;
            if (args.email) callerContext.email = args.email;
            return { success: true, message: `Got it! I've saved your info as ${args.name}.` };
          } catch (err) {
            console.error(`[tenant:${businessId}][${callLogId}] Failed to save customer info:`, err.message);
            return { success: false, message: 'I had trouble saving your info, but we can still complete your booking.' };
          }
        }
        console.warn(`[tenant:${businessId}][${callLogId}] save_customer_info: No customerId available`);
        return { success: false, message: 'I had trouble saving your info, but we can still complete your booking.' };
      }

      case 'save_alternate_phone': {
        console.log(`[tenant:${businessId}][${callLogId}] save_alternate_phone | customerId: ${callerContext.customerId} | mobile: ${args.mobile_number}`);
        if (callerContext.customerId && args.mobile_number) {
          try {
            await query(
              'UPDATE customers SET alternate_phone = $1 WHERE id = $2 AND business_id = $3',
              [args.mobile_number, callerContext.customerId, businessId]
            );
            callerContext.alternatePhone = args.mobile_number;
            console.log(`[tenant:${businessId}][${callLogId}] Saved alternate phone ${args.mobile_number} for customer ${callerContext.customerId}`);
            return { success: true, message: `Got it! I'll send text confirmations to ${args.mobile_number} instead.` };
          } catch (err) {
            console.error(`[tenant:${businessId}][${callLogId}] Failed to save alternate phone:`, err.message);
            return { success: false, message: 'I had trouble saving that number, but no worries — staff will follow up with you.' };
          }
        }
        return { success: false, message: 'I had trouble saving that number, but no worries — staff will follow up with you.' };
      }

      case 'take_topic_message': {
        // Operator-defined topics (lost & found, catering inquiries, etc.)
        // are stored in the per-tenant `custom_topics` setting. The AI
        // recognizes a match in conversation, calls this tool with a
        // summary, and we (a) persist a row to team_messages so it
        // shows on the Messages page, (b) fire SMS to the topic's
        // notify_sms (or fall back to notifications.sms_to).
        const topicName = typeof args.topic_name === 'string' ? args.topic_name.trim() : '';
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
        if (!topicName) {
          return { success: false, error: 'missing_topic', message: 'Tell me which topic, and I’ll take the message.' };
        }
        if (!summary) {
          return { success: false, error: 'missing_summary', message: 'What would you like me to pass along?' };
        }
        console.log(
          `[tenant:${businessId}][${callLogId}] take_topic_message | topic="${topicName}" | from=${args.caller_name || 'n/a'}`
        );

        // Look up the topic config from settings.
        let topics = [];
        try {
          const raw = await getSetting(businessId, 'custom_topics');
          topics = Array.isArray(raw) ? raw : (Array.isArray(raw?.topics) ? raw.topics : []);
        } catch (err) {
          console.warn(`[tenant:${businessId}][${callLogId}] custom_topics lookup failed:`, err.message);
        }
        const topic = topics.find(t => t && t.enabled !== false && typeof t.name === 'string' &&
          t.name.toLowerCase() === topicName.toLowerCase());
        if (!topic) {
          return {
            success: false,
            error: 'topic_not_found',
            message: `That topic isn't in my list. I can take a general message and someone will follow up.`
          };
        }

        // Resolve callback. Caller-supplied beats inbound DID.
        const callerPhone =
          (typeof args.caller_callback_number === 'string' && args.caller_callback_number.trim()) ||
          callerContext?.callerPhone ||
          callerContext?.alternatePhone ||
          null;
        const callerName =
          (typeof args.caller_name === 'string' && args.caller_name.trim()) ||
          callerContext?.name ||
          'Unknown caller';

        // Where to SMS: topic's own notify_sms first, fall back to
        // notifications.sms_to so the message always reaches someone.
        let notifySmsRaw = topic.notify_sms || null;
        if (!notifySmsRaw) {
          try {
            const notif = await getSetting(businessId, 'notifications').catch(() => null);
            notifySmsRaw = notif?.sms_to || null;
          } catch (_) { /* fine — Messages page is still recorded */ }
        }
        const notifyEmailRaw = topic.notify_email || null;

        // Persist on Messages page first (audit trail), then dispatch.
        // Reuses team_messages with recipient_id=NULL (it's a topic, not
        // a team member) and recipient_name="Topic: <name>" so the dash
        // can render with a distinct label.
        let messageRowId = null;
        try {
          const business = await getBusinessById(businessId);
          const businessName = business?.name || null;
          const body = [
            `📬 ${topic.name} message at ${businessName || 'your business'}`,
            callerName ? `From: ${callerName}` : null,
            callerPhone ? `Callback: ${callerPhone}` : null,
            '',
            summary
          ].filter(x => x !== null).join('\n');

          const insertRes = await query(
            `INSERT INTO team_messages
                (business_id, recipient_id, recipient_name, caller_name, caller_phone,
                 body, channel, status, routed_to_default, call_id)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', FALSE, $7)
             RETURNING id`,
            [
              businessId,
              `Topic: ${topic.name}`,
              callerName,
              callerPhone,
              body,
              notifySmsRaw && notifyEmailRaw ? 'both' : notifySmsRaw ? 'sms' : notifyEmailRaw ? 'email' : 'dashboard_only',
              Number.isInteger(callLogId) ? callLogId : null
            ]
          );
          messageRowId = insertRes.rows[0].id;

          const detail = {};
          let smsOk = null;
          if (notifySmsRaw) {
            try {
              const r = await sendSMS(businessId, notifySmsRaw, body);
              smsOk = !!r;
              detail.sms = { ok: smsOk, sid: r?.sid || null, to: notifySmsRaw };
            } catch (err) {
              smsOk = false;
              detail.sms = { ok: false, error: err.message, to: notifySmsRaw };
            }
          }
          let emailOk = null;
          if (notifyEmailRaw) {
            try {
              const r = await sendEmail(
                businessId,
                notifyEmailRaw,
                `[${businessName || 'Voice'}] ${topic.name} — ${callerName}`,
                `<pre style="font-family: -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif; white-space: pre-wrap; font-size: 14px;">${String(body).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`
              );
              emailOk = !!r;
              detail.email = { ok: emailOk, message_id: r?.messageId || null, to: notifyEmailRaw };
            } catch (err) {
              emailOk = false;
              detail.email = { ok: false, error: err.message, to: notifyEmailRaw };
            }
          }

          let finalStatus;
          if (!notifySmsRaw && !notifyEmailRaw) finalStatus = 'dashboard_only';
          else if (notifySmsRaw && notifyEmailRaw) {
            finalStatus = (smsOk && emailOk) ? 'sent' : (smsOk || emailOk) ? 'partial' : 'failed';
          } else {
            finalStatus = (smsOk || emailOk) ? 'sent' : 'failed';
          }
          await query(
            `UPDATE team_messages
                SET status = $1, delivery_detail = $2::jsonb, updated_at = NOW()
              WHERE id = $3 AND business_id = $4`,
            [finalStatus, JSON.stringify(detail), messageRowId, businessId]
          );
          // Live broadcast for the Messages page (matches the
          // team-directory dispatch flow).
          try {
            require('./event-bus').publish(businessId, 'team_message.created', {
              id: messageRowId, recipient_name: `Topic: ${topic.name}`, caller_name: callerName, status: finalStatus
            });
            require('./event-bus').publish(businessId, 'team_message.updated', {
              id: messageRowId, status: finalStatus
            });
          } catch (_) { /* non-fatal */ }

          console.log(
            `[tenant:${businessId}][${callLogId}] Topic "${topic.name}" message id=${messageRowId} status=${finalStatus}`
          );
          return {
            success: true,
            topic: topic.name,
            status: finalStatus,
            message: `I’ve passed your ${topic.name.toLowerCase()} message along — staff will get it right away.`
          };
        } catch (err) {
          console.error(`[tenant:${businessId}][${callLogId}] take_topic_message dispatch failed:`, err.message);
          return {
            success: false,
            error: 'dispatch_failed',
            message: `I’ve noted your ${topic.name.toLowerCase()} message — there was a hiccup with the alert just now, but it’s logged.`
          };
        }
      }

      case 'take_message_for_team_member': {
        // Resolve the spoken name to a directory row, then dispatch SMS via
        // notification.sendSMS. Three return shapes the AI knows how to
        // handle (matched language in the system-prompt's TEAM DIRECTORY
        // section): success / ambiguous / not_found / inactive.
        console.log(
          `[tenant:${businessId}][${callLogId}] take_message_for_team_member | for=${args.team_member_name} | from=${args.caller_name || 'n/a'}`
        );
        const spokenName = typeof args.team_member_name === 'string' ? args.team_member_name : '';
        if (!spokenName.trim()) {
          return { success: false, error: 'missing_name', message: 'Tell me who the message is for, and I’ll get it to them.' };
        }
        if (typeof args.message !== 'string' || !args.message.trim()) {
          return { success: false, error: 'missing_message', message: 'What would you like me to pass along?' };
        }

        let match;
        try {
          match = await findTeamMemberByName(businessId, spokenName);
        } catch (err) {
          console.error(`[tenant:${businessId}][${callLogId}] team lookup failed:`, err.message);
          return { success: false, error: 'lookup_failed', message: 'I’m having trouble looking that up — let me take a general message and someone will follow up.' };
        }

        // Default-recipient fallback. When we can't match a name (or the
        // match was ambiguous and we'd rather just deliver than pingpong),
        // route to the tenant's marked default recipient if one exists.
        // This is what makes the new "Business" template's switchboard
        // actually trustworthy — no message is ever silently dropped.
        let routedToDefault = false;
        let resolvedMember = null;

        if (match && !match.ambiguous) {
          resolvedMember = match;
        } else if (match && match.ambiguous) {
          // Ambiguity — keep the existing "ask the caller to pick" flow.
          // Falling back to default here would mask a name collision the
          // caller almost certainly meant a specific person to receive.
          return {
            success: false,
            error: 'ambiguous',
            candidates: match.candidates,
            message: `I have a couple of people by that name — ${match.candidates.map(c => c.name + (c.role ? ` (${c.role})` : '')).join(' or ')}. Which one?`
          };
        } else {
          // No match — try the default recipient.
          let fallback = null;
          try {
            fallback = await getDefaultRecipient(businessId);
          } catch (err) {
            console.warn(`[tenant:${businessId}][${callLogId}] default recipient lookup failed:`, err.message);
          }
          if (fallback) {
            resolvedMember = fallback;
            routedToDefault = true;
            console.log(
              `[tenant:${businessId}][${callLogId}] No match for "${spokenName}" — routing to default recipient ${fallback.name} (id=${fallback.id})`
            );
          } else {
            return {
              success: false,
              error: 'not_found',
              message: `I don’t have ${spokenName} on my list of people I can leave a message for. I can take a general message and pass it along, or transfer you if you’d like.`
            };
          }
        }

        // Resolve callback number — caller-supplied beats the inbound DID,
        // and the inbound DID beats nothing.
        const callerPhone =
          (typeof args.caller_phone === 'string' && args.caller_phone.trim()) ||
          callerContext?.callerPhone ||
          callerContext?.alternatePhone ||
          null;
        const callerName =
          (typeof args.caller_name === 'string' && args.caller_name.trim()) ||
          callerContext?.name ||
          'Unknown caller';

        try {
          const business = await getBusinessById(businessId);
          const result = await sendMessageToTeamMember(businessId, resolvedMember.id, {
            callerName,
            callerPhone,
            message: args.message,
            businessName: business?.name,
            routedToDefault,
            callId: callLogId
          });
          console.log(
            `[tenant:${businessId}][${callLogId}] Routed message to ${resolvedMember.name} (id=${resolvedMember.id})${routedToDefault ? ' [default fallback]' : ''} — status=${result.status}, sid=${result.message_sid || 'n/a'}`
          );
          // Note: the per-call action log is appended at the WebSocket
          // dispatch site (see `callState.actions.push` near the
          // function_call_arguments.done handler) — no need to do it here.
          return {
            success: true,
            recipient: resolvedMember.name,
            routed_to_default: routedToDefault,
            status: result.status,
            message: routedToDefault
              ? `I’ve noted your message — I’ll make sure the right person gets it.`
              : `I’ll get that to ${resolvedMember.name} right away.`
          };
        } catch (err) {
          console.error(`[tenant:${businessId}][${callLogId}] team message dispatch failed:`, err.message);
          return {
            success: false,
            error: 'dispatch_failed',
            message: `I’ll make sure ${resolvedMember.name} gets your message — there was a hiccup just now, but I’ve noted it.`
          };
        }
      }

      // ─── Admin-line handlers ────────────────────────────────────────
      // All four admin tools defend in depth: they refuse if the caller
      // isn't a registered admin (server-side check, independent of the
      // system prompt). Mutation tools additionally require pinVerified.
      // The bcrypt PIN comparison happens inside caller-lookup so the
      // hash never reaches this file.
      case 'verify_admin_pin': {
        if (!callerContext?.isAdmin || !callerContext?.adminId) {
          console.warn(`[tenant:${businessId}][${callLogId}] verify_admin_pin called by non-admin caller (phone=${callerContext?.phone || 'n/a'})`);
          return { success: false, error: 'not_admin', message: 'This line is not configured for admin access. If you meant to make a booking, just let me know.' };
        }
        if (callState?.failedPinAttempts >= 3) {
          return {
            success: false, locked: true,
            message: 'PIN entry is locked for this call after too many failed attempts. Please call back, or contact support if you need help.'
          };
        }
        let ok = false;
        try {
          ok = await verifyAdminPin(callerContext.adminId, args.pin);
        } catch (err) {
          console.error(`[tenant:${businessId}][${callLogId}] verify_admin_pin error:`, err.message);
          return { success: false, error: 'verify_failed', message: 'I had trouble checking the PIN. Try again in a moment.' };
        }
        if (ok) {
          callState.pinVerified = true;
          markAdminPinSuccess(callerContext.adminId).catch(() => {});
          console.log(`[tenant:${businessId}][${callLogId}] Admin PIN verified for ${callerContext.adminName} (id=${callerContext.adminId})`);
          return {
            success: true,
            admin_name: callerContext.adminName || 'Admin',
            message: `PIN accepted for ${callerContext.adminName || 'Admin'}. Ask if they're making changes or doing something else like booking a tee time.`
          };
        }
        callState.failedPinAttempts = (callState.failedPinAttempts || 0) + 1;
        const remaining = Math.max(0, 3 - callState.failedPinAttempts);
        console.warn(`[tenant:${businessId}][${callLogId}] Admin PIN failed for ${callerContext.adminName} (attempt ${callState.failedPinAttempts}/3)`);
        return {
          success: false,
          attempts_remaining: remaining,
          locked: remaining === 0,
          message: remaining > 0
            ? `That PIN didn't match. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} left.`
            : 'That PIN didn\'t match. PIN entry is now locked for the rest of this call.'
        };
      }

      case 'add_announcement': {
        if (!callerContext?.isAdmin || !callerContext?.adminId) {
          return { success: false, error: 'not_admin', message: 'Only admin callers can set operations notes.' };
        }
        if (!callState?.pinVerified) {
          return { success: false, error: 'pin_required', message: 'Verify the admin PIN first before adding an announcement.' };
        }
        const text = typeof args.instruction_text === 'string' ? args.instruction_text.trim() : '';
        if (!text) {
          return { success: false, error: 'missing_text', message: 'I need the instruction text — what should I tell callers?' };
        }
        const scope = args.scope === 'persistent' ? 'persistent' : 'today';
        // Compute expires_at for scope='today' as end-of-local-day in
        // the business's timezone. Tomorrow 00:00 in that zone, converted
        // to UTC for the timestamp. Falls back to UTC midnight + 1 day
        // if timezone lookup fails — the announcement still expires, just
        // off by hours.
        let expiresAt = null;
        if (scope === 'today') {
          try {
            const tz = (await getBusinessById(businessId).catch(() => null))?.timezone || 'America/Toronto';
            const now = new Date();
            // Compute the local date string, then re-parse as that date 00:00 + 1 day in UTC,
            // then offset by the timezone's UTC offset for that wall-clock moment.
            const localDateStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
            // Use a stable trick: midnight UTC of (next day) minus the tz offset of midnight in that tz.
            const tomorrowLocal = new Date(localDateStr + 'T23:59:59');
            // tomorrowLocal is approximately end-of-local-day in *server local* time. Convert via tz offset:
            const offsetMins = (() => {
              const probe = new Date(localDateStr + 'T12:00:00Z');
              const localProbe = new Date(probe.toLocaleString('en-US', { timeZone: tz }));
              return (probe - localProbe) / 60000;
            })();
            expiresAt = new Date(tomorrowLocal.getTime() + offsetMins * 60000);
          } catch (err) {
            // Conservative fallback — 18 hours from now. Worst case the
            // announcement lingers a few extra hours, never less than 0.
            expiresAt = new Date(Date.now() + 18 * 60 * 60 * 1000);
          }
        }
        let row;
        try {
          row = await createAnnouncement({
            businessId,
            instructionText: text,
            scope,
            expiresAt,
            adminId: callerContext.adminId,
            adminPhone: callerContext.phone || null,
          });
        } catch (err) {
          console.error(`[tenant:${businessId}][${callLogId}] add_announcement failed:`, err.message);
          return { success: false, error: 'save_failed', message: 'I couldn\'t save that just now. Try again in a sec.' };
        }
        console.log(`[tenant:${businessId}][${callLogId}] Announcement added id=${row.id} scope=${scope} by admin=${callerContext.adminId}`);
        return {
          success: true,
          id: row.id,
          scope,
          instruction_text: row.instruction_text,
          expires_at: row.expires_at,
          message: scope === 'today'
            ? 'Saved for today only. It\'ll automatically expire at end of day. Anything else?'
            : 'Saved as ongoing. It\'ll stay active until you remove it. Anything else?'
        };
      }

      case 'list_announcements': {
        if (!callerContext?.isAdmin || !callerContext?.adminId) {
          return { success: false, error: 'not_admin' };
        }
        let rows = [];
        try {
          rows = await getActiveAnnouncements(businessId);
        } catch (err) {
          console.error(`[tenant:${businessId}][${callLogId}] list_announcements failed:`, err.message);
          return { success: false, error: 'load_failed', message: 'I couldn\'t pull the list just now.' };
        }
        if (rows.length === 0) {
          return { success: true, count: 0, announcements: [], message: 'No active notes right now.' };
        }
        return {
          success: true,
          count: rows.length,
          announcements: rows.map(r => ({
            id: r.id,
            scope: r.scope,
            instruction_text: r.instruction_text,
            expires_at: r.expires_at,
          })),
          message: `${rows.length} active note${rows.length === 1 ? '' : 's'}. Read them to the admin and ask if they want to add, change, or remove anything.`
        };
      }

      case 'remove_announcement': {
        if (!callerContext?.isAdmin || !callerContext?.adminId) {
          return { success: false, error: 'not_admin' };
        }
        if (!callState?.pinVerified) {
          return { success: false, error: 'pin_required', message: 'Verify the admin PIN first.' };
        }
        const id = Number(args.id);
        if (!Number.isInteger(id) || id <= 0) {
          return { success: false, error: 'bad_id', message: 'I need the numeric id of the note to remove.' };
        }
        let removed;
        try {
          removed = await deactivateAnnouncement(businessId, id, `admin:${callerContext.adminId}`);
        } catch (err) {
          console.error(`[tenant:${businessId}][${callLogId}] remove_announcement failed:`, err.message);
          return { success: false, error: 'remove_failed', message: 'I couldn\'t remove that just now.' };
        }
        if (!removed) {
          return { success: false, error: 'not_found', message: `I don\'t see an active note with id ${id} — it may already be removed.` };
        }
        console.log(`[tenant:${businessId}][${callLogId}] Announcement removed id=${id} by admin=${callerContext.adminId}`);
        return { success: true, id, message: 'Removed. Anything else?' };
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`[tenant:${businessId}] Tool execution error (${toolName}):`, err.message);
    return { error: `Failed to execute ${toolName}: ${err.message}` };
  }
}

module.exports = { handleMediaStream };
