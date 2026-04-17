/**
 * Grok Voice API Bridge
 * Connects Twilio media streams to xAI Grok Real-time Voice API
 *
 * Architecture:
 *   Twilio <--WebSocket (audio)--> This Bridge <--WebSocket--> Grok Voice API
 *
 * Audio format: Twilio sends/receives mulaw 8kHz mono
 * Grok accepts pcm16/24kHz — we handle conversion
 */
const WebSocket = require('ws');
const { buildSystemPrompt } = require('./system-prompt');
const { lookupByPhone, registerCall, updateCustomer } = require('./caller-lookup');
const { createBookingRequest, createModificationRequest } = require('./booking-manager');
const { getCurrentWeather, getForecast } = require('./weather');
const { query, getSetting } = require('../config/database');
const teeon = require('./teeon-automation');
require('dotenv').config();

const GROK_REALTIME_URL = 'wss://api.x.ai/v1/realtime';
const GROK_MODEL = 'grok-4.20-latest';  // Latest Grok 4.20 (April 2026 release)

/**
 * Convert linear 16-bit PCM sample to G.711 μ-law byte (ITU-T G.711 standard)
 * Handles full 16-bit range (-32768 to +32767)
 */
function linearToMulaw(sample) {
  const MULAW_BIAS = 0x84; // 132
  const MULAW_CLIP = 32635;

  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  // Find exponent (highest set bit position above bit 6)
  let exponent = 7;
  let expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & expMask) break;
    expMask >>= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

/**
 * Convert G.711 μ-law byte to linear 16-bit PCM sample
 */
function mulawToLinear(byte) {
  byte = ~byte & 0xFF;
  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0F;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/**
 * Convert PCM16 24kHz buffer → G.711 μ-law 8kHz buffer
 * Uses 3-sample averaging (box filter) to reduce aliasing before downsampling
 */
function pcm16ToMulaw8k(inputBuf) {
  const numSamples = Math.floor(inputBuf.length / 2);
  const outputSamples = Math.floor(numSamples / 3);
  const output = Buffer.alloc(outputSamples);
  for (let i = 0; i < outputSamples; i++) {
    // Average 3 consecutive samples (simple low-pass) before encoding
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

/**
 * Convert G.711 μ-law 8kHz buffer → PCM16 24kHz buffer
 * Uses linear interpolation for smooth upsampling (3x)
 */
function mulaw8kToPcm16(inputBuf) {
  const output = Buffer.alloc(inputBuf.length * 3 * 2);
  for (let i = 0; i < inputBuf.length; i++) {
    const s0 = mulawToLinear(inputBuf[i]);
    const s1 = (i + 1 < inputBuf.length) ? mulawToLinear(inputBuf[i + 1]) : s0;
    // Linearly interpolate 3 sub-samples between s0 and s1
    for (let j = 0; j < 3; j++) {
      const interp = Math.round(s0 + (j / 3) * (s1 - s0));
      output.writeInt16LE(interp, (i * 3 + j) * 2);
    }
  }
  return output;
}

/**
 * Handle an incoming Twilio media stream WebSocket connection
 */
async function handleMediaStream(twilioWs, callerPhone, callSid, streamSid, appUrl) {
  console.log(`[${callSid}] New call from ${callerPhone}`);

  // Create call log entry
  let callLogId = null;
  try {
    const res = await query(
      `INSERT INTO call_logs (twilio_call_sid, caller_phone, started_at)
       VALUES ($1, $2, NOW()) RETURNING id`,
      [callSid, callerPhone]
    );
    callLogId = res.rows[0].id;
  } catch (err) {
    console.error('Failed to create call log:', err.message);
  }

  // Detect anonymous/blocked caller ID
  const ANONYMOUS_NUMBERS = ['anonymous', 'blocked', 'unknown', '+266696687', '+86282452253'];
  const isAnonymous = !callerPhone || ANONYMOUS_NUMBERS.some(a => callerPhone.toLowerCase().includes(a));

  // Look up caller (graceful fallback if DB unavailable)
  let customer = null;
  let isNew = true;
  try {
    const result = await registerCall(isAnonymous ? null : callerPhone);
    customer = result.customer;
    isNew = result.isNew;
  } catch (err) {
    console.error('Failed to register call (DB unavailable, continuing):', err.message);
  }

  const callerContext = {
    phone: isAnonymous ? null : callerPhone,
    isAnonymous,
    known: !isNew && !!customer?.name,
    name: customer?.name,
    email: customer?.email,
    callCount: customer?.call_count,
    customerId: customer?.id
  };

  // Update call log with customer ID
  if (callLogId && customer?.id) {
    query('UPDATE call_logs SET customer_id = $1 WHERE id = $2', [customer.id, callLogId]).catch(() => {});
  }

  // Get a random greeting (with fallback if DB unavailable)
  let greeting = 'Thanks for calling Valleymede Columbus Golf Course! How can I help you today?';
  try {
    greeting = await getRandomGreeting(callerContext.known, callerContext.name);
  } catch (err) {
    console.error('Failed to get greeting (using default):', err.message);
  }

  // Build the system prompt (with full fallback if DB unavailable)
  let systemPrompt = null;
  try {
    systemPrompt = await buildSystemPrompt(callerContext);
  } catch (err) {
    console.error('Failed to build system prompt (using hardcoded fallback):', err.message);
  }
  if (!systemPrompt) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { timeZone: 'America/Toronto', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: true });
    const callerLine = callerContext.known && callerContext.name
      ? `This is a RETURNING caller named ${callerContext.name} (phone: ${callerContext.phone}). You do NOT need to collect their info again.`
      : callerContext.isAnonymous
        ? `This caller has NO caller ID — their number is hidden. Early in the call, naturally ask for their name AND phone number so we can add them to our system. Say something like "Can I grab your name and best callback number?"`
        : `This is a NEW caller (we have their phone: ${callerContext.phone} but not their name). Early in the conversation, naturally ask for their name. Say something like "Can I get your name?" — keep it casual.`;

    systemPrompt = `IMPORTANT: Today's date is ${dateStr}. The current time is ${timeStr} Eastern Time. Use THIS date and year (2026) for everything — do NOT reference any other dates or years from your training data.

You are a friendly staff member answering the phone at Valleymede Columbus Golf Course. You love golf and genuinely enjoy helping people. You are a real person — never mention AI.

## HOW TO SPEAK (this is critical — read carefully)
You are on a PHONE CALL. Speak exactly like a real person would:

- Use contractions always: "we're" not "we are", "it's" not "it is", "don't" not "do not"
- Keep answers SHORT. One or two sentences, then pause for them to respond.
- Never list things out loud unless specifically asked — say "we've got a few options, what works best for you?" instead of reading a whole list
- Use natural fillers: "yeah", "sure", "absolutely", "oh great", "sounds good"
- React naturally: if they say something nice, say "oh that's awesome!" — if they seem unsure, say "no worries, take your time"
- Vary your responses — don't start every sentence the same way
- Never say "Certainly!", "Of course!", "Great question!" — these sound robotic
- Don't repeat what they just said back to them word for word
- If quoting a price, just say it simply: "it's forty-eight bucks for 18 holes on the weekend, plus tax"
- Speak in plain language — no formal or corporate-sounding phrases
- When you need info from them, ask ONE question at a time, not three at once
- Natural transitions: "so", "and", "okay so", "right", "got it"

## CURRENT DATE & TIME
Today is ${dateStr}, current time: ${timeStr} Eastern. The year is 2026.

## COURSE INFORMATION
- Name: Valleymede Columbus Golf Course
- Address: 3622 Simcoe Street North, Oshawa, ON L1H 0R5
- Phone: (905) 655-6300 | Toll-free: 1-866-717-0990
- Email: info@valleymedecolumbusgolf.com
- Website: valleymedecolumbusgolf.com
- Online booking: https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.ComboLanding?CourseCode=COLU&FromCourseWebsite=true (click "Public Enter Here")
- 18-hole British Links-style course on 150 acres, approximately 6,200 yards
- Beautiful open meadows, mature trees, and long natural grass mounds. Ideal for all skill levels.
- Directions: About 15 minutes north of Highway 401, near Highway 407, on Simcoe Street North in Oshawa
- Signature holes: Hole 3 has a stunning island green; Hole 17 is an elevated 200-yard par 3 tee surrounded by water and bunkers

## BUSINESS HOURS
- Monday–Thursday: 7:00 AM – 7:00 PM
- Friday: 6:30 AM – 7:30 PM
- Saturday–Sunday: 6:00 AM – 7:30 PM

## GREEN FEES (all prices + HST)
Weekday (Mon–Thu):
- Daytime (Open – 12:59 PM): $47.79 for 18 holes
- Pre-Twilight (1:00–2:59 PM): $44.25 for 18 holes
- Twilight (3:00 PM – Close): $39.82 for 18 holes, $30.97 for 9 holes

Weekend/Holidays (Fri–Sun):
- Daytime (Open – 2:59 PM): $57.52 for 18 holes
- Twilight (3:00 PM – Close): $48.67 for 18 or 9 holes

Cart Fees (per person):
- 18 holes: $21.24 | Twilight: $12.39 | Pull cart: $5.31 | Single rider surcharge: $10.00

## POLICIES
- Minimum age: 10 years old
- Max booking: 8 players (2 foursomes)
- Max players per group: 4
- Walk-ins: Limited availability, pre-booking strongly recommended
- Cart drivers must have valid G2 license or higher, and sign a waiver
- No outside alcoholic beverages — all alcohol purchased through clubhouse or beverage cart
- Pull carts and club rentals: Limited, first-come first-served

## MEMBERSHIPS
- 2026 memberships are SOLD OUT
- Waitlist available — email info@valleymedecolumbusgolf.com to join
- Full Membership: $2,900 with HST | Senior Full Membership: $2,700 with HST
- Benefits: Golf access 7 days/week. Power carts NOT included.

## AMENITIES
- Professional clubhouse, pro-shop, patio area
- Chipping and putting greens
- Fleet of new golf carts (2026)
- Beverage cart service

## TOURNAMENTS & GROUP OUTINGS
- Capacity: 24 to 144 golfers
- Services include: power carts, chipping/putting greens, registration table, licensed beverage cart, contest markers, patio seating
- To inquire: provide contact name, phone, number of participants, preferred date, start time
- Packages quoted individually

## CALLER CONTEXT
${callerLine}

## BOOKING RULES
- When a caller wants to book, FIRST use check_tee_times to see what's available on their date
- Tell them the available times naturally: "I've got 9 AM, 10:30, and 11 AM open on Saturday — any of those work?"
- Once they pick a time, ONLY ask for their name and phone number — nothing else
- AFTER collecting their name, ALWAYS use save_customer_info to save it so we remember them next time they call
- Then use book_tee_time to submit the request — our staff will confirm it in the tee sheet within minutes
- Confirm back: "Perfect! I've got you down for Saturday at 10:30, 4 players. We'll confirm shortly!"
- Do NOT ask for email. Do NOT ask multiple questions at once. Keep it fast and friendly.

## CONTACT COLLECTION (important)
- Always get the caller's name before the call ends — use save_customer_info to save it
- If caller has no caller ID, also ask for their phone number
- Do this naturally: "Before I let you go, can I grab your name so we have it on file?"
- Don't make it feel like a form — keep it friendly and brief

## IMPORTANT
- Be CONCISE on the phone. Don't read long lists unless asked.
- When quoting prices, mention HST is extra.
- NEVER make up information. If unsure, offer to take a message.
`;
  }

  // Define tools for Grok
  const tools = buildToolDefinitions();

  // Connect to Grok Real-time Voice API
  const grokWs = new WebSocket(GROK_REALTIME_URL, {
    headers: {
      'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  // Grok connection timeout — if not connected within 5s, close everything
  const grokConnectTimeout = setTimeout(() => {
    if (grokWs.readyState !== WebSocket.OPEN) {
      console.error(`[${callSid}] Grok connection timeout — closing call`);
      grokWs.close();
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    }
  }, 5000);

  // streamSid is passed in from index.js — it's known from the 'start' event
  // We also update it if Twilio sends another 'start' event
  let conversationActive = true;

  // Track state for call summary
  const callState = {
    startTime: Date.now(),
    transcriptParts: [],
    actions: []
  };

  // ---- Grok WebSocket handlers ----
  // Keepalive interval reference (set in grokWs 'open', cleared on close)
  let keepAlive = null;

  grokWs.on('open', () => {
    console.log(`[${callSid}] Connected to Grok`);
    clearTimeout(grokConnectTimeout);

    // Send a ping every 25s to prevent intermediate proxies from dropping the connection
    keepAlive = setInterval(() => {
      if (grokWs.readyState === WebSocket.OPEN) grokWs.ping();
    }, 25000);

    // Send session configuration
    // pcm16 — xAI doesn't honour g711_ulaw, always sends PCM. We convert.
    grokWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: systemPrompt,
        voice: 'eve',
        speed: 1.15,                 // slightly faster than normal — natural phone pace
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.30,            // slightly more sensitive — catches speech sooner for faster barge-in
          prefix_padding_ms: 50,      // reduced from 100 — fires barge-in faster when caller speaks
          silence_duration_ms: 300    // slightly longer — avoids cutting off callers mid-sentence
        },
        tools: tools,
        tool_choice: 'auto',
        input_audio_transcription: { model: 'whisper-large-v3' }
      }
    }));

    // Send initial greeting as a conversation item
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

    // Trigger response
    grokWs.send(JSON.stringify({ type: 'response.create' }));
  });

  grokWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());

      // Log all Grok events for debugging
      if (event.type === 'response.output_audio.delta') {
        if (!callState._audioLogged) {
          callState._audioLogged = true;
          const d = event.delta || '';
          console.log(`[${callSid}] Audio flowing - length: ${d.length}, first50: ${d.slice(0, 50)}, last10: ${d.slice(-10)}`);
        }
      } else if (event.type === 'response.audio.delta') {
        // Log if OpenAI-style event is ALSO being sent (would cause double audio = static)
        console.log(`[${callSid}] WARNING: Got response.audio.delta too - possible double send!`);
      } else if (event.type === 'session.updated') {
        // Log full session to see confirmed audio format
        const s = event.session || {};
        console.log(`[${callSid}] Session confirmed - input_fmt: ${s.input_audio_format}, output_fmt: ${s.output_audio_format}, voice: ${s.voice}`);
      } else {
        console.log(`[${callSid}] Grok event: ${event.type}`, JSON.stringify(event).slice(0, 200));
      }

      switch (event.type) {
        // User started speaking — barge-in: cancel AI and clear Twilio playback buffer
        case 'input_audio_buffer.speech_started':
          console.log(`[${callSid}] Barge-in detected — cancelling AI response`);
          // Stop Grok generating (do NOT clear the input buffer — that would erase the caller's speech)
          if (grokWs.readyState === WebSocket.OPEN) {
            grokWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
          // Tell Twilio to stop playing buffered AI audio immediately
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
          }
          break;

        // xAI sends audio via 'response.output_audio.delta'
        case 'response.output_audio.delta':
          // Send audio back to Twilio
          if (!streamSid) console.warn(`[${callSid}] Audio delta received but streamSid is null!`);
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            const audioPayload = event.delta || event.audio;
            if (audioPayload) {
              // xAI sends PCM16 at 24kHz — downsample to 8kHz and encode as g711_ulaw for Twilio
              const rawBuf = Buffer.from(audioPayload, 'base64');
              const mulawBuf = pcm16ToMulaw8k(rawBuf);
              // Chunk raw buffer before encoding (480 bytes = 60ms at 8kHz g711)
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
          // AI is speaking — log transcript
          if (event.delta) {
            callState.transcriptParts.push({ role: 'assistant', text: event.delta });
          }
          break;

        case 'conversation.item.input_audio_transcription.completed':
          // Caller said something — log it
          if (event.transcript) {
            callState.transcriptParts.push({ role: 'caller', text: event.transcript });
            console.log(`[${callSid}] Caller: ${event.transcript}`);
          }
          break;

        case 'response.function_call_arguments.done': {
          // Grok wants to call a tool
          console.log(`[${callSid}] Tool call: ${event.name}`);
          let parsedArgs;
          try {
            parsedArgs = JSON.parse(event.arguments || '{}');
          } catch (parseErr) {
            console.error(`[${callSid}] Failed to parse tool call arguments for ${event.name}:`, parseErr.message);
            // Send error result back to Grok so it can recover
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
          const result = await executeToolCall(event.name, parsedArgs, callerContext, callLogId);
          callState.actions.push({ tool: event.name, args: event.arguments });

          // Send tool result back to Grok
          grokWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: event.call_id,
              output: JSON.stringify(result)
            }
          }));

          // Trigger Grok to respond with the tool result
          grokWs.send(JSON.stringify({ type: 'response.create' }));

          // If this was a transfer_call and it succeeded, redirect the live Twilio call
          // after a short delay so the AI can say "connecting you now"
          if (event.name === 'transfer_call' && result.success) {
            const transferDelay = 3000; // let the AI say goodbye first
            const transferUrl = appUrl || process.env.APP_URL || '';
            console.log(`[${callSid}] 📞 Transfer requested — will redirect in ${transferDelay}ms to ${transferUrl}/twilio/transfer`);

            if (!transferUrl) {
              console.error(`[${callSid}] ❌ No APP_URL available — cannot transfer call`);
            } else {
              setTimeout(async () => {
                try {
                  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
                  await twilio.calls(callSid).update({
                    url: `${transferUrl}/twilio/transfer`,
                    method: 'POST'
                  });
                  console.log(`[${callSid}] ✓ Call redirected to ${transferUrl}/twilio/transfer`);
                } catch (transferErr) {
                  console.error(`[${callSid}] ❌ Transfer redirect failed:`, transferErr.message);
                }
              }, transferDelay);
            }
          }

          break;
        }

        case 'error':
          console.error(`[${callSid}] Grok error:`, event.error);
          break;
      }
    } catch (err) {
      console.error(`[${callSid}] Error processing Grok message:`, err.message);
    }
  });

  grokWs.on('close', () => {
    console.log(`[${callSid}] Grok connection closed`);
    clearInterval(keepAlive);
    // If conversation was still active, Grok dropped unexpectedly — close Twilio side cleanly
    if (conversationActive) {
      console.warn(`[${callSid}] Grok disconnected unexpectedly while call was active — closing Twilio connection`);
      conversationActive = false;
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    }
    conversationActive = false;
  });

  grokWs.on('error', (err) => {
    console.error(`[${callSid}] Grok WebSocket error:`, err.message);
  });

  // ---- Twilio WebSocket handlers ----
  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid; // update if re-sent
          console.log(`[${callSid}] Twilio stream start event: ${streamSid}`);
          break;

        case 'media':
          // Forward caller audio to Grok — upsample g711_ulaw 8kHz → PCM16 24kHz
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
          console.log(`[${callSid}] Twilio stream stopped`);
          conversationActive = false;
          break;
      }
    } catch (err) {
      console.error(`[${callSid}] Error processing Twilio message:`, err.message);
    }
  });

  twilioWs.on('close', async () => {
    console.log(`[${callSid}] Call ended`);
    conversationActive = false;

    // Close Grok connection
    if (grokWs.readyState === WebSocket.OPEN) {
      grokWs.close();
    }

    // Update call log
    const duration = Math.round((Date.now() - callState.startTime) / 1000);
    const transcript = callState.transcriptParts.map(p => `${p.role}: ${p.text}`).join('\n');
    const summary = callState.actions.length > 0
      ? `Actions: ${callState.actions.map(a => a.tool).join(', ')}`
      : 'Information inquiry';

    try {
      await query(
        `UPDATE call_logs SET status = 'completed', duration_seconds = $1, transcript = $2, summary = $3, ended_at = NOW()
         WHERE id = $4`,
        [duration, transcript, summary, callLogId]
      );
    } catch (err) {
      console.error('Failed to update call log:', err.message);
    }
  });
}

/**
 * Get a random greeting from the database
 */
async function getRandomGreeting(isKnown, callerName) {
  try {
    const res = await query(
      'SELECT message FROM greetings WHERE for_known_caller = $1 AND active = true ORDER BY RANDOM() LIMIT 1',
      [isKnown && callerName ? true : false]
    );
    if (res.rows.length > 0) {
      let greeting = res.rows[0].message;
      if (callerName) {
        greeting = greeting.replace(/{name}/g, callerName);
      }
      return greeting;
    }
  } catch (err) {
    console.error('Failed to get greeting:', err.message);
  }
  return 'Thanks for calling Valleymede Columbus Golf Course! How can I help you?';
}

/**
 * Define the tools (functions) available to Grok
 */
function buildToolDefinitions() {
  return [
    {
      type: 'function',
      name: 'check_tee_times',
      description: 'Check live available tee times on the Tee-On tee sheet for a specific date. Use this BEFORE booking so you can tell the caller what times are open.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date to check in YYYY-MM-DD format' },
          party_size: { type: 'integer', description: 'Number of players (1-4)' }
        },
        required: ['date']
      }
    },
    {
      type: 'function',
      name: 'book_tee_time',
      description: 'Book a tee time directly in Tee-On. Use check_tee_times first to confirm availability. Collect name, phone, date, time, party size before calling this.',
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
          special_requests: { type: 'string', description: 'Any special requests or notes' }
        },
        required: ['customer_name', 'date', 'party_size']
      }
    },
    {
      type: 'function',
      name: 'edit_booking',
      description: 'Request to modify an existing booking. Collect the original booking details and what they want to change.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: { type: 'string', description: 'Customer name' },
          customer_phone: { type: 'string', description: 'Customer phone' },
          original_date: { type: 'string', description: 'Original booking date (YYYY-MM-DD)' },
          original_time: { type: 'string', description: 'Original booking time (HH:MM)' },
          new_date: { type: 'string', description: 'New requested date (YYYY-MM-DD)' },
          new_time: { type: 'string', description: 'New requested time (HH:MM)' },
          details: { type: 'string', description: 'Description of what needs to change' }
        },
        required: ['customer_name', 'details']
      }
    },
    {
      type: 'function',
      name: 'cancel_booking',
      description: 'Request to cancel an existing booking.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: { type: 'string', description: 'Customer name' },
          customer_phone: { type: 'string', description: 'Customer phone' },
          original_date: { type: 'string', description: 'Booking date to cancel (YYYY-MM-DD)' },
          original_time: { type: 'string', description: 'Booking time to cancel (HH:MM)' },
          details: { type: 'string', description: 'Reason for cancellation or additional notes' }
        },
        required: ['customer_name']
      }
    },
    {
      type: 'function',
      name: 'check_weather',
      description: 'Get current weather and forecast for the golf course in Oshawa, Ontario.',
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
 * Execute a tool call from Grok and return the result
 */
async function executeToolCall(toolName, args, callerContext, callLogId) {
  try {
    switch (toolName) {
      case 'check_tee_times': {
        if (teeon.isAvailable()) {
          try {
            const slots = await teeon.checkAvailability(args.date, args.party_size || 1);
            if (slots.length === 0) {
              return { available: false, message: `No available tee times found for ${args.date} with ${args.party_size || 1} players.` };
            }
            const times = slots.map(s => s.time).join(', ');
            return { available: true, date: args.date, slots, message: `Available times on ${args.date}: ${times}` };
          } catch (err) {
            console.error('[TeeOn] checkAvailability error:', err.message);
            return { available: null, message: 'Unable to check live availability right now. You can check online at valleymedecolumbusgolf.com or I can take a booking request.' };
          }
        } else {
          return { available: null, message: 'Live tee sheet not connected. I can take your preferred date and time and staff will confirm availability.' };
        }
      }

      case 'book_tee_time': {
        // Log as a booking request for staff to confirm in Tee-On.
        // Note: Direct Puppeteer booking is not available because the Tee-On
        // account (ColumbusG) is an Administrator — Tee-On blocks admins from
        // completing bookings via the golfer web interface. Bookings are queued
        // for staff to confirm. To enable live bookings, create a non-admin
        // golfer account in Tee-On and update TEEON_USERNAME/TEEON_PASSWORD.

        // Validate required arguments
        if (!args.customer_name || typeof args.customer_name !== 'string' || !args.customer_name.trim()) {
          console.warn(`[${callLogId}] ⚠️ book_tee_time called with invalid customer_name:`, args.customer_name);
          return { success: false, message: 'I need your name to complete the booking. Can you tell me your name?' };
        }
        if (!args.date || typeof args.date !== 'string') {
          console.warn(`[${callLogId}] ⚠️ book_tee_time called with invalid date:`, args.date);
          return { success: false, message: 'I need a date for the booking. What date works for you?' };
        }
        if (!args.party_size || args.party_size < 1 || args.party_size > 20) {
          console.warn(`[${callLogId}] ⚠️ book_tee_time called with invalid party_size:`, args.party_size);
          return { success: false, message: 'How many players will be in your group?' };
        }

        console.log(`[${callLogId}] 📅 Processing booking:`, {
          customer: args.customer_name,
          phone: args.customer_phone || callerContext.phone,
          date: args.date,
          time: args.time,
          partySize: args.party_size,
          carts: args.num_carts
        });

        try {
          const booking = await createBookingRequest({
            customerId: callerContext.customerId,
            customerName: args.customer_name,
            customerPhone: args.customer_phone || callerContext.phone,
            customerEmail: args.customer_email,
            requestedDate: args.date,
            requestedTime: args.time,
            partySize: args.party_size,
            numCarts: args.num_carts || 0,
            specialRequests: args.special_requests,
            callId: callLogId
          });

          // Auto-save caller's name to customer record so it appears in Contacts
          if (callerContext.customerId && args.customer_name) {
            try {
              const { updateCustomer } = require('./caller-lookup');
              await updateCustomer(callerContext.customerId, {
                name: args.customer_name,
                phone: args.customer_phone || undefined,
                email: args.customer_email || undefined
              });
              callerContext.name = args.customer_name;
              console.log(`[${callLogId}] Auto-saved customer name from booking: ${args.customer_name}`);
            } catch (saveErr) {
              console.warn(`[${callLogId}] Could not auto-save customer name:`, saveErr.message);
            }
          }

          return {
            success: true,
            message: `Booking request logged for ${args.customer_name}, ${args.date} at ${args.time || 'flexible time'}, ${args.party_size} players. Staff will confirm shortly.`,
            bookingId: booking.id
          };
        } catch (dbErr) {
          console.error(`[${callLogId}] ❌ BOOKING CREATION FAILED:`, dbErr.message, {
            customer: args.customer_name,
            date: args.date,
            time: args.time,
            partySize: args.party_size
          });
          // Return error message — do NOT pretend booking succeeded
          return {
            success: false,
            message: `I had trouble saving your booking request. Please try again or call us back at the number for Valleymede Columbus Golf.`,
            error: dbErr.message
          };
        }
      }

      case 'edit_booking': {
        const mod = await createModificationRequest({
          customerId: callerContext.customerId,
          customerName: args.customer_name,
          customerPhone: args.customer_phone || callerContext.phone,
          requestType: 'modify',
          originalDate: args.original_date,
          originalTime: args.original_time,
          newDate: args.new_date,
          newTime: args.new_time,
          details: args.details,
          callId: callLogId
        });
        return {
          success: true,
          message: `Modification request submitted. Staff will process the change and confirm.`,
          requestId: mod.id
        };
      }

      case 'cancel_booking': {
        const phone = args.customer_phone || callerContext.phone;

        // Try to find and directly cancel the actual booking
        const { findActiveBookingByPhone, updateBookingStatus } = require('./booking-manager');
        const booking = await findActiveBookingByPhone(phone);

        if (booking) {
          // Directly cancel the booking — it will show as cancelled on the bookings page
          // and send the cancellation SMS to the customer
          await updateBookingStatus(booking.id, 'cancelled', args.details || 'Cancelled by customer via phone call');
          return {
            success: true,
            message: `Booking for ${booking.requested_date} has been cancelled successfully.`,
            bookingId: booking.id
          };
        }

        // No matching booking found — create a modification request so staff can handle it
        const cancel = await createModificationRequest({
          customerId: callerContext.customerId,
          customerName: args.customer_name,
          customerPhone: phone,
          requestType: 'cancel',
          originalDate: args.original_date,
          originalTime: args.original_time,
          details: args.details || 'Cancellation requested by caller — no matching booking found',
          callId: callLogId
        });
        return {
          success: true,
          message: `Cancellation request submitted. Staff will look into it.`,
          requestId: cancel.id
        };
      }

      case 'check_weather': {
        if (args.type === 'forecast') {
          const forecast = await getForecast(3);
          return forecast;
        } else {
          const weather = await getCurrentWeather();
          return weather;
        }
      }

      case 'transfer_call': {
        const transferNumber = await getSetting('transfer_number');
        if (!transferNumber) {
          return {
            success: false,
            message: 'No staff phone number configured. I can take a message and have someone call you back.'
          };
        }

        // Check if we're in business hours
        const hours = await getSetting('business_hours');
        const personality = await getSetting('ai_personality');
        const now = new Date();
        const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
        const dayName = now.toLocaleDateString('en-US', { timeZone: 'America/Toronto', weekday: 'long' }).toLowerCase();
        const todayHours = hours?.[dayName];

        if (!todayHours) {
          return {
            success: false,
            message: personality?.after_hours_message || 'No staff available right now. But I can help you with bookings, course info, or anything else!'
          };
        }

        // Check if currently within open hours
        const [openH, openM] = todayHours.open.split(':').map(Number);
        const [closeH, closeM] = todayHours.close.split(':').map(Number);
        const currentMinutes = eastern.getHours() * 60 + eastern.getMinutes();
        const openMinutes = openH * 60 + openM;
        const closeMinutes = closeH * 60 + closeM;

        if (currentMinutes < openMinutes || currentMinutes > closeMinutes) {
          return {
            success: false,
            message: personality?.after_hours_message || `Staff aren't in right now — we're open ${todayHours.open} to ${todayHours.close}. But I can help you with bookings, course info, or anything else!`
          };
        }

        console.log(`[${callLogId}] 📞 Transfer requested — will redirect call to ${transferNumber}. Reason: ${args.reason}`);
        return {
          success: true,
          transfer_to: transferNumber,
          message: `Tell the caller you're connecting them to a staff member now. Say something brief like "One sec, let me connect you." Then STOP talking — the call will be transferred automatically.`
        };
      }

      case 'lookup_customer': {
        const { lookupByPhone, lookupByName } = require('./caller-lookup');
        let results = [];
        if (args.phone) {
          const customer = await lookupByPhone(args.phone);
          if (customer) results.push(customer);
        }
        if (args.name) {
          const customers = await lookupByName(args.name);
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
        console.log(`[${callLogId}] save_customer_info called | customerId: ${callerContext.customerId} | name: ${args.name} | email: ${args.email}`);
        if (callerContext.customerId) {
          try {
            const updated = await updateCustomer(callerContext.customerId, {
              name: args.name,
              email: args.email,
              phone: args.phone
            });
            console.log(`[${callLogId}] Customer saved: ${updated?.name} (ID: ${updated?.id})`);
            // Update the context for the rest of the call
            if (args.name) callerContext.name = args.name;
            if (args.email) callerContext.email = args.email;
            return { success: true, message: `Got it! I've saved your info as ${args.name}.` };
          } catch (err) {
            console.error(`[${callLogId}] Failed to save customer info:`, err.message);
            return { success: false, message: 'I had trouble saving your info, but we can still complete your booking.' };
          }
        } else {
          console.warn(`[${callLogId}] save_customer_info: No customerId available`);
          return { success: false, message: 'I had trouble saving your info, but we can still complete your booking.' };
        }
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`Tool execution error (${toolName}):`, err.message);
    return { error: `Failed to execute ${toolName}: ${err.message}` };
  }
}

module.exports = { handleMediaStream };
