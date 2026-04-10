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
require('dotenv').config();

const GROK_REALTIME_URL = 'wss://api.x.ai/v1/realtime';
const GROK_MODEL = 'grok-3-fast';

/**
 * Handle an incoming Twilio media stream WebSocket connection
 */
async function handleMediaStream(twilioWs, callerPhone, callSid) {
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

  // Look up caller (graceful fallback if DB unavailable)
  let customer = null;
  let isNew = true;
  try {
    const result = await registerCall(callerPhone);
    customer = result.customer;
    isNew = result.isNew;
  } catch (err) {
    console.error('Failed to register call (DB unavailable, continuing):', err.message);
  }

  const callerContext = {
    phone: callerPhone,
    known: !isNew && customer?.name,
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

  // Build the system prompt (with fallback if DB unavailable)
  let systemPrompt = 'You are a friendly and helpful AI assistant for Valleymede Columbus Golf Course. Help callers with tee time bookings, course information, pricing, and general inquiries. Be warm, professional, and concise.';
  try {
    systemPrompt = await buildSystemPrompt(callerContext);
  } catch (err) {
    console.error('Failed to build system prompt (using default):', err.message);
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

  let streamSid = null; // Twilio's stream SID for sending audio back
  let conversationActive = true;

  // Track state for call summary
  const callState = {
    startTime: Date.now(),
    transcriptParts: [],
    actions: []
  };

  // ---- Grok WebSocket handlers ----
  grokWs.on('open', () => {
    console.log(`[${callSid}] Connected to Grok`);

    // Send session configuration
    grokWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: systemPrompt,
        voice: 'eve', // xAI supported voice - options: eve, ara, rex, sal, leo
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        },
        tools: tools,
        tool_choice: 'auto',
        temperature: 0.8
      }
    }));

    // Send initial greeting as a conversation item
    grokWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '[System: The phone is ringing. Answer with this greeting (say it naturally, not robotically): "' + greeting + '"]'
        }]
      }
    }));

    // Trigger response
    grokWs.send(JSON.stringify({ type: 'response.create' }));
  });

  grokWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());

      switch (event.type) {
        case 'response.audio.delta':
          // Send audio back to Twilio
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: event.delta
              }
            }));
          }
          break;

        case 'response.audio_transcript.delta':
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

        case 'response.function_call_arguments.done':
          // Grok wants to call a tool
          console.log(`[${callSid}] Tool call: ${event.name}`);
          const result = await executeToolCall(event.name, JSON.parse(event.arguments || '{}'), callerContext, callLogId);
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
          break;

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
          streamSid = msg.start.streamSid;
          console.log(`[${callSid}] Twilio stream started: ${streamSid}`);
          break;

        case 'media':
          // Forward caller audio to Grok
          if (grokWs.readyState === WebSocket.OPEN) {
            grokWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
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
      name: 'book_tee_time',
      description: 'Create a new tee time booking request. Use this when a caller wants to book a tee time. Collect all required info first: date, time, party size, and customer details.',
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
      case 'book_tee_time': {
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
        return {
          success: true,
          message: `Booking request created successfully for ${args.customer_name}, ${args.date} at ${args.time || 'flexible time'}, ${args.party_size} players. Staff will confirm shortly.`,
          bookingId: booking.id
        };
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
        const cancel = await createModificationRequest({
          customerId: callerContext.customerId,
          customerName: args.customer_name,
          customerPhone: args.customer_phone || callerContext.phone,
          requestType: 'cancel',
          originalDate: args.original_date,
          originalTime: args.original_time,
          details: args.details || 'Cancellation requested by caller',
          callId: callLogId
        });
        return {
          success: true,
          message: `Cancellation request submitted. Staff will process it.`,
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
        // Check if we're in business hours
        const hours = await getSetting('business_hours');
        const personality = await getSetting('ai_personality');
        const now = new Date();
        const dayName = now.toLocaleDateString('en-US', { timeZone: 'America/Toronto', weekday: 'long' }).toLowerCase();
        const todayHours = hours?.[dayName];

        if (!todayHours) {
          return {
            success: false,
            message: personality?.after_hours_message || 'No staff available right now. But I can help you with bookings, course info, or anything else!'
          };
        }

        return {
          success: true,
          transfer_to: transferNumber,
          message: `Transferring to staff now. Reason: ${args.reason}`
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
        if (callerContext.customerId) {
          const updated = await updateCustomer(callerContext.customerId, {
            name: args.name,
            email: args.email,
            phone: args.phone
          });
          // Update the context for the rest of the call
          if (args.name) callerContext.name = args.name;
          if (args.email) callerContext.email = args.email;
          return { success: true, message: `Customer info updated: ${args.name}` };
        }
        return { success: false, message: 'Unable to update customer info' };
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
