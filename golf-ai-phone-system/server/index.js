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

// Routes
const twilioRoutes = require('./routes/twilio');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

// Services
const { handleMediaStream } = require('./services/grok-voice');

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

// Health check (Railway uses this)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
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

        const streamSid = msg.start.streamSid;
        console.log(`Media stream started: caller=${callerPhone}, sid=${callSid}, stream=${streamSid}`);

        // Hand off to the Grok voice bridge — pass streamSid so audio can flow back
        handleMediaStream(ws, callerPhone, callSid, streamSid);
      }
    } catch (err) {
      // Not JSON or not a start event — ignore, the handler will process it
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ============================================
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;

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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
