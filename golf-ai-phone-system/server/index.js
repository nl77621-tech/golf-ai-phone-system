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
    console.log('============================================');
    console.log('');
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
