/**
 * Valleymede Columbus Golf Course — AI Phone Answering System
 * Main Server Entry Point
 *
 * Express server handling:
 * - Twilio webhooks (inbound calls)
 * - WebSocket media streams (Twilio <-> Grok bridge)
 * - REST API (Command Center backend)
 * - Static file serving (Command Center UI)
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

// Routes
const twilioRoutes = require('./routes/twilio');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

// Services
const { handleMediaStream } = require('./services/grok-voice');
const { pool } = require('./config/database');

const app = express();
const server = http.createServer(app);

// ============================================
// Middleware
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  if (!req.path.includes('/health')) {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  }
  next();
});

// ============================================
// Routes
// ============================================

// Health check (Railway uses this) — verifies DB connectivity
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: 'database unreachable', uptime: process.uptime() });
  }
});

// Diagnostic: test tee time scraper directly from production
// Usage: GET /test-tee-times?date=2026-04-19&party_size=4
const teeon = require('./services/teeon-automation');

// Diagnostic: show raw HTML from Tee-On to debug production issues
app.get('/test-tee-times-raw', async (req, res) => {
  const https = require('https');
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const baseUrl = 'https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingAllTimesLanding';

  try {
    // Step 1: GET landing to get session cookie
    const landing = await new Promise((resolve, reject) => {
      https.get(`${baseUrl}?CourseCode=COLU&CourseGroupID=12&Referrer=`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
      }, (resp) => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => resolve({
          status: resp.statusCode,
          cookies: (resp.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '),
          body: Buffer.concat(chunks).toString('utf8'),
          headers: resp.headers
        }));
      }).on('error', reject);
    });

    // Step 2: POST with date
    const postBody = `Date=${encodeURIComponent(date)}&CourseCode=COLU&CourseGroupID=12`;
    const postResult = await new Promise((resolve, reject) => {
      const postReq = https.request({
        hostname: 'www.tee-on.com',
        path: `/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingAllTimesLanding?CourseCode=COLU&Referrer=`,
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
          'Cookie': landing.cookies || '',
          'Referer': `${baseUrl}?CourseCode=COLU&CourseGroupID=12&Referrer=`
        }
      }, (resp) => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => resolve({
          status: resp.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: resp.headers
        }));
      });
      postReq.on('error', reject);
      postReq.write(postBody);
      postReq.end();
    });

    const hasTimeClass = /class="time"/.test(postResult.body);
    const hasSlotBox = /search-results-tee-times-box/.test(postResult.body);
    const hasLogin = /signin|sign in|username|password/i.test(postResult.body);
    const hasNoTimes = /no-times-available|no times/i.test(postResult.body);

    res.json({
      date,
      landingStatus: landing.status,
      landingBodyLength: landing.body.length,
      landingHasTimeClass: /class="time"/.test(landing.body),
      landingCookies: landing.cookies ? 'yes' : 'none',
      postStatus: postResult.status,
      postBodyLength: postResult.body.length,
      postHasTimeClass: hasTimeClass,
      postHasSlotBox: hasSlotBox,
      postHasLogin: hasLogin,
      postHasNoTimes: hasNoTimes,
      // Show snippets around key elements
      firstTimeSnippet: (() => {
        const m = postResult.body.match(/class="time"[^>]*>[\s\S]{0,100}/);
        return m ? m[0] : 'NO TIME CLASS FOUND';
      })(),
      bodyFirst500: postResult.body.substring(0, 500),
      bodySnippetAroundSlots: (() => {
        const idx = postResult.body.indexOf('search-results-tee-times-box');
        return idx >= 0 ? postResult.body.substring(idx, idx + 300) : 'NO SLOT BOX FOUND';
      })()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/test-tee-times', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const partySize = parseInt(req.query.party_size) || 4;
  console.log(`[Diagnostic] Testing tee times for ${date}, party of ${partySize}`);
  try {
    const startTime = Date.now();
    const allSlots = await teeon.checkAvailability(date, partySize);
    const filtered = allSlots.filter(s => s.maxPlayers >= partySize);
    const elapsed = Date.now() - startTime;
    res.json({
      date,
      partySize,
      totalSlots: allSlots.length,
      fittingParty: filtered.length,
      elapsedMs: elapsed,
      slots: allSlots.slice(0, 10), // First 10 for debugging
      allTimes: allSlots.map(s => `${s.time} (${s.course}, ${s.minPlayers}-${s.maxPlayers} players, ${s.price})`)
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Twilio webhooks
app.use('/twilio', twilioRoutes);

// Authentication
app.use('/auth', authRoutes);

// Command Center API
app.use('/api', apiRoutes);

// Serve Command Center static files (built React app)
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath, {
  setHeaders: (res, filePath) => {
    // Serve .jsx files as JavaScript so browsers load them as ES modules
    if (filePath.endsWith('.jsx')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// SPA fallback — serve index.html for any unmatched route
app.get('*', (req, res) => {
  // Don't serve index.html for API/webhook routes
  if (req.path.startsWith('/api') || req.path.startsWith('/twilio') || req.path.startsWith('/auth')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

// ============================================
// WebSocket Server for Twilio Media Streams
// ============================================
const wss = new WebSocket.Server({ server, path: '/twilio/media-stream' });

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection from Twilio');

  // We'll get the caller info from the first 'start' message
  let initialized = false;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // On the first 'start' event, extract caller info and spin up Grok
      if (msg.event === 'start' && !initialized) {
        initialized = true;
        const params = msg.start.customParameters || {};
        const callerPhone = params.callerPhone || 'unknown';
        const callSid = params.callSid || msg.start.callSid || 'unknown';
        const appUrl = params.appUrl || process.env.APP_URL || '';

        const streamSid = msg.start.streamSid;
        console.log(`Media stream started: caller=${callerPhone}, sid=${callSid}, stream=${streamSid}, appUrl=${appUrl}`);

        // Hand off to the Grok voice bridge — pass streamSid and appUrl so transfer can work
        handleMediaStream(ws, callerPhone, callSid, streamSid, appUrl);
      }
    } catch (err) {
      // Not JSON or not a start event — ignore, the handler will process it
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    try { ws.close(); } catch (_) {}
  });
});

// ============================================
// Auto-Initialize Database (if DATABASE_URL is set)
// ============================================
async function initializeDatabaseIfNeeded() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️  DATABASE_URL not set — skipping database initialization');
    return;
  }

  try {
    console.log('🔧 Checking database schema...');
    const client = await pool.connect();

    // Check if tables exist
    const result = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'call_logs'
      ) as exists
    `);

    if (!result.rows[0].exists) {
      console.log('📋 Creating database schema...');
      const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
      await client.query(schema);
      console.log('✅ Schema created');

      console.log('🌱 Seeding initial data...');
      const seed = fs.readFileSync(path.join(__dirname, 'db', 'seed.sql'), 'utf8');
      await client.query(seed);
      console.log('✅ Seed data inserted');
    } else {
      console.log('✅ Database tables already exist');
    }

    // Run migrations — add new columns if they don't exist
    try {
      await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS custom_greeting TEXT`);
      await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS custom_greetings JSONB DEFAULT '[]'`);
      await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_knowledge TEXT`);
      // Migrate old custom_greeting → custom_greetings array if needed
      await client.query(`
        UPDATE customers
        SET custom_greetings = jsonb_build_array(custom_greeting)
        WHERE custom_greeting IS NOT NULL
          AND custom_greeting != ''
          AND (custom_greetings IS NULL OR custom_greetings = '[]'::jsonb)
      `);
      // Phone type detection + credit card fields
      await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS line_type VARCHAR(20)`);
      await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS alternate_phone VARCHAR(20)`);
      await client.query(`ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS card_last_four VARCHAR(4)`);
      await client.query(`
        INSERT INTO settings (key, value, description)
        VALUES ('booking_settings', '{"require_credit_card": false}', 'Booking behavior settings (credit card requirement, etc.)')
        ON CONFLICT (key) DO NOTHING
      `);
      // Day-before reminders + no-show tracking
      await client.query(`ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS no_show BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS no_show_count INTEGER DEFAULT 0`);
      console.log('✅ Migrations applied');
    } catch (migErr) {
      console.warn('⚠️  Migration warning:', migErr.message);
    }

    client.release();
  } catch (err) {
    console.error('⚠️  Database initialization warning:', err.message);
    // Don't crash the server if DB init fails — it might be a temporary connection issue
  }
}

// ============================================
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;

async function startServer() {
  // Initialize database before starting server
  await initializeDatabaseIfNeeded();

  server.listen(PORT, () => {
    console.log('');
    console.log('🏌️ ============================================');
    console.log('🏌️  Valleymede Columbus Golf Course');
    console.log('🏌️  AI Phone Answering System');
    console.log('🏌️ ============================================');
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📞 Twilio webhook: /twilio/voice`);
    console.log(`🔌 WebSocket: /twilio/media-stream`);
    console.log(`🎛️  Command Center: http://localhost:${PORT}`);
    console.log(`📡 API: /api/*`);
    console.log(`⏰ Reminder scheduler: active (6 PM ET daily)`);
    console.log('============================================');
    console.log('');

    // Start the day-before reminder scheduler
    const { startReminderScheduler } = require('./services/scheduled-tasks');
    startReminderScheduler();
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);
  // Close WebSocket server first
  wss.clients.forEach(ws => {
    try { ws.close(); } catch (_) {}
  });
  server.close(async () => {
    try {
      await pool.end();
      console.log('Database pool closed.');
    } catch (_) {}
    console.log('Server closed.');
    process.exit(0);
  });
  // Force exit after 10s if graceful shutdown stalls
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
