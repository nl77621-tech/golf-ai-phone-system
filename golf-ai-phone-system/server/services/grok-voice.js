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
const { buildSystemPrompt } = require('./system-prompt');
const { sendPostCallSummary } = require('./notification');
const { lookupByPhone, lookupByName, registerCall, updateCustomer } = require('./caller-lookup');
const {
  createBookingRequest,
  createModificationRequest,
  getConfirmedBookingsByPhone,
  getBookingById
} = require('./booking-manager');
const { getLineType } = require('./phone-lookup');
const { getCurrentWeather, getForecast } = require('./weather');
const { query, getSetting, getBusinessById } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');
const { recordCallUsage } = require('./credits');
const { resolveVoiceConfigFromSettings } = require('./voice-tiers');
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
async function getTeeOnConfigForBusiness(businessId) {
  try {
    const fromSetting = await getSetting(businessId, 'teeon').catch(() => null);
    if (fromSetting?.course_code) {
      return {
        courseCode: fromSetting.course_code,
        courseGroupId: fromSetting.course_group_id
      };
    }
    const business = await getBusinessById(businessId).catch(() => null);
    if (business?.teeon_course_code) {
      return {
        courseCode: business.teeon_course_code,
        courseGroupId: business.teeon_course_group_id
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
    noShowCount: customer?.no_show_count || 0
  };

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

  const grokConnectTimeout = setTimeout(() => {
    if (grokWs.readyState !== WebSocket.OPEN) {
      console.error(`[tenant:${businessId}][${callSid}] Grok connection timeout — closing call`);
      grokWs.close();
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    }
  }, 5000);

  let conversationActive = true;

  const callState = {
    startTime: Date.now(),
    transcriptParts: [],
    actions: []
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
        turn_detection: {
          type: 'server_vad',
          threshold: 0.30,
          prefix_padding_ms: 50,
          silence_duration_ms: 300
        },
        tools: tools,
        tool_choice: 'auto',
        input_audio_transcription: { model: 'whisper-large-v3' }
      }
    }));

    const greetingInstruction = callerContext.known && callerContext.name
      ? `[System: A returning caller named ${callerContext.name} just called. Greet them IMMEDIATELY by name — start with their name right away, warm and personal like you recognize them. Use this greeting but make it sound natural and unscripted: "${greeting}". Do NOT sound like you are reading from a script. Do NOT ask for their name.]`
      : `[System: Someone just called. Answer the phone naturally like a real person would — warm, casual, friendly. Use this greeting but make it sound natural and unscripted: "${greeting}". Do NOT sound like you are reading from a script.]`;
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
          console.log(`[tenant:${businessId}][${callSid}] Barge-in detected — cancelling AI response`);
          if (grokWs.readyState === WebSocket.OPEN) {
            grokWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
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
            callLogId
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
      console.warn(`[tenant:${businessId}][${callSid}] Grok disconnected unexpectedly while call was active — closing Twilio connection`);
      conversationActive = false;
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    }
    conversationActive = false;
  });

  grokWs.on('error', (err) => {
    console.error(`[tenant:${businessId}][${callSid}] Grok WebSocket error:`, err.message);
    conversationActive = false;
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
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
  return [
    {
      type: 'function',
      name: 'check_tee_times',
      description: 'Check live available tee times on the Tee-On tee sheet for a specific date. You MUST provide the party_size so the system can filter out times that are already partially booked and cannot fit the group. Results show 18-hole slots (start hole 1, full course) and 9-hole slots (start hole 10, back nine only) separately. If no 18-hole morning times, suggest 9-hole back nine as alternative. ALWAYS call this tool — NEVER guess or assume availability.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date to check in YYYY-MM-DD format' },
          party_size: { type: 'integer', description: 'Number of players in the group — REQUIRED so we only show times with enough open spots' }
        },
        required: ['date', 'party_size']
      }
    },
    {
      type: 'function',
      name: 'book_tee_time',
      description: 'REQUIRED to create a booking — you MUST call this tool to submit the booking request. The booking does NOT exist until this tool is called. Never tell the caller the booking was submitted without calling this first. Collect name, date, time, and party size, then call this immediately.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: { type: 'string', description: 'Full name of the customer' },
          customer_phone: { type: 'string', description: 'Customer phone number' },
          customer_email: { type: 'string', description: 'Customer email address' },
          date: { type: 'string', description: 'Requested date in YYYY-MM-DD format' },
          time: { type: 'string', description: 'Requested time in HH:MM format (24h)' },
          party_size: { type: 'integer', description: 'Number of players (1-8)' },
          num_carts: { type: 'integer', description: 'Number of golf carts requested' },
          special_requests: { type: 'string', description: 'Any special requests or notes' },
          card_last_four: { type: 'string', description: 'Last 4 digits of the credit card provided by the caller (only when credit card is required)' }
        },
        required: ['customer_name', 'date', 'party_size']
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
      description: 'Request to modify a specific confirmed booking. You MUST call lookup_my_bookings first and read the bookings back to the caller. Then use the booking_id from the booking they want to change. The modification goes to staff for approval.',
      parameters: {
        type: 'object',
        properties: {
          booking_id: { type: 'integer', description: 'The ID of the confirmed booking to modify (from lookup_my_bookings result)' },
          customer_name: { type: 'string', description: 'Customer name' },
          customer_phone: { type: 'string', description: 'Customer phone' },
          original_date: { type: 'string', description: 'Original booking date (YYYY-MM-DD)' },
          original_time: { type: 'string', description: 'Original booking time (HH:MM)' },
          new_date: { type: 'string', description: 'New requested date (YYYY-MM-DD)' },
          new_time: { type: 'string', description: 'New requested time (HH:MM)' },
          new_party_size: { type: 'integer', description: 'New party size if changing' },
          details: { type: 'string', description: 'Description of what needs to change' }
        },
        required: ['booking_id', 'details']
      }
    },
    {
      type: 'function',
      name: 'cancel_booking',
      description: 'Request to cancel a specific confirmed booking. You MUST call lookup_my_bookings first and read the bookings back to the caller. Then use the booking_id from the booking they want to cancel. The cancellation goes to staff for approval.',
      parameters: {
        type: 'object',
        properties: {
          booking_id: { type: 'integer', description: 'The ID of the confirmed booking to cancel (from lookup_my_bookings result)' },
          customer_name: { type: 'string', description: 'Customer name' },
          customer_phone: { type: 'string', description: 'Customer phone' },
          original_date: { type: 'string', description: 'Booking date being cancelled (YYYY-MM-DD)' },
          original_time: { type: 'string', description: 'Booking time being cancelled (HH:MM)' },
          details: { type: 'string', description: 'Reason for cancellation or additional notes' }
        },
        required: ['booking_id']
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
      description: 'Save or update customer information (name, email, phone) when a new or existing caller provides their details.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Customer full name' },
          email: { type: 'string', description: 'Customer email address' },
          phone: { type: 'string', description: 'Customer phone number' }
        },
        required: ['name']
      }
    }
  ];
}

/**
 * Execute a tool call from Grok and return the result.
 * Every branch is scoped to the caller's tenant via `ctx.businessId`.
 */
async function executeToolCall(toolName, args, ctx) {
  const { businessId, callerContext, callLogId } = ctx;
  requireBusinessId(businessId, `executeToolCall/${toolName}`);

  try {
    switch (toolName) {
      case 'check_tee_times': {
        if (!teeon.isAvailable()) {
          return { available: null, message: 'Live tee sheet not connected. I can take your preferred date and time and staff will confirm availability.' };
        }
        try {
          const partySize = args.party_size || 1;
          const teeOnCfg = await getTeeOnConfigForBusiness(businessId);
          console.log(`[tenant:${businessId}][${callLogId}] check_tee_times | date: ${args.date} | party_size: ${partySize} | raw args:`, JSON.stringify(args));
          const allSlots = await teeon.checkAvailability(args.date, partySize, teeOnCfg);

          const slots = allSlots.filter(s => s.maxPlayers >= partySize);

          console.log(`[tenant:${businessId}][${callLogId}] Tee times for ${args.date}: ${allSlots.length} total slots, ${slots.length} fit party of ${partySize}`);

          if (slots.length === 0 && allSlots.length > 0) {
            const maxAvail = Math.max(...allSlots.map(s => s.maxPlayers));
            return {
              available: false,
              message: `No tee times available for a group of ${partySize} on ${args.date}. The open time slots only have room for ${maxAvail} or fewer players. Each tee time holds a maximum of 4 golfers, and some spots are already booked. You could suggest the caller split into smaller groups or try a different date.`
            };
          }

          if (slots.length === 0) {
            return { available: false, message: `No available tee times showing online for ${args.date}. This could mean the tee sheet is fully booked, or the online system may not have updated yet. Offer to take a booking request with their preferred date and time — staff will check directly and confirm by text or phone call.` };
          }

          const full18 = slots.filter(s => s.holes === 18);
          const back9 = slots.filter(s => s.holes === 9);
          const morning18 = full18.filter(s => s.time.includes('AM'));
          const afternoon18 = full18.filter(s => s.time.includes('PM'));
          const morningBack9 = back9.filter(s => s.time.includes('AM'));

          let message = `AVAILABLE tee times for ${args.date} (${partySize} players):\n`;

          if (morning18.length > 0) {
            message += `\nMorning 18-hole times: ${morning18.map(s => s.time).join(', ')}`;
            if (morning18[0].price) message += ` (${morning18[0].price} each)`;
          }

          if (afternoon18.length > 0) {
            const earlyPM = afternoon18.slice(0, 6);
            const latePM = afternoon18.filter(s => {
              const h = parseInt(s.time.split(':')[0]);
              const isPM = s.time.includes('PM');
              return isPM && h >= 3 && h < 6;
            });
            message += `\nAfternoon 18-hole times: ${earlyPM.map(s => s.time).join(', ')}`;
            if (afternoon18.length > 6) message += ` and ${afternoon18.length - 6} more`;
            if (latePM.length > 0 && latePM[0].price && latePM[0].price !== morning18?.[0]?.price) {
              message += ` (twilight rate ${latePM[0].price} starts around 3 PM)`;
            }
          }

          if (morningBack9.length > 0) {
            message += `\nMorning 9-hole only (back nine, starts hole 10): ${morningBack9.map(s => s.time).join(', ')}`;
            if (morningBack9[0].price) message += ` (${morningBack9[0].price} each)`;
          }

          if (morning18.length === 0 && morningBack9.length > 0) {
            message += '\nNOTE: No morning 18-hole times for this group size, but morning 9-hole back nine is available.';
          }
          if (full18.length === 0 && back9.length > 0) {
            message += '\nNOTE: No 18-hole times for this group size today. Only 9-hole back nine available.';
          }

          message += '\n\nRULES: 18 holes = start hole 1, full course. 9 holes = start hole 10, back nine only. ONLY offer times from this list.';

          console.log(`[tenant:${businessId}][${callLogId}] Tee times for ${args.date}: ${full18.length} x 18-hole, ${back9.length} x 9-hole (party of ${partySize})`);
          return { available: true, date: args.date, partySize, total: slots.length, message };
        } catch (err) {
          console.error(`[tenant:${businessId}][TeeOn] checkAvailability error:`, err.message);
          return { available: null, message: 'Unable to check live availability right now. I can take a booking request.' };
        }
      }

      case 'book_tee_time': {
        if (!args.customer_name || typeof args.customer_name !== 'string' || !args.customer_name.trim()) {
          console.warn(`[tenant:${businessId}][${callLogId}] ⚠️ book_tee_time called with invalid customer_name:`, args.customer_name);
          return { success: false, message: 'I need your name to complete the booking. Can you tell me your name?' };
        }
        if (!args.date || typeof args.date !== 'string') {
          console.warn(`[tenant:${businessId}][${callLogId}] ⚠️ book_tee_time called with invalid date:`, args.date);
          return { success: false, message: 'I need a date for the booking. What date works for you?' };
        }
        if (!args.party_size || args.party_size < 1 || args.party_size > 8) {
          console.warn(`[tenant:${businessId}][${callLogId}] ⚠️ book_tee_time called with invalid party_size:`, args.party_size);
          return { success: false, message: 'How many players will be in your group?' };
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
            specialRequests: args.special_requests,
            cardLastFour: args.card_last_four || null,
            callId: callLogId
          });

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
        // Prefer the denormalized business.transfer_number; fall back to the
        // per-tenant settings row.
        const business = await getBusinessById(businessId).catch(() => null);
        let transferNumber = business?.transfer_number || null;
        if (!transferNumber) {
          transferNumber = await getSetting(businessId, 'transfer_number').catch(() => null);
        }
        console.log(`[tenant:${businessId}][${callLogId}] 📞 Transfer setting: ${JSON.stringify(transferNumber)}`);
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

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`[tenant:${businessId}] Tool execution error (${toolName}):`, err.message);
    return { error: `Failed to execute ${toolName}: ${err.message}` };
  }
}

module.exports = { handleMediaStream };
