# Valleymede Columbus Golf Course — AI Phone Answering System

## Architecture Document v1.0

---

## 1. System Overview

An AI-powered phone answering system for Valleymede Columbus Golf Course that handles inbound calls using xAI's Grok voice model. The system answers on the course's existing Bell Canada phone number, handles bookings, provides course information, and falls back to human staff only as a last resort.

### Core Capabilities
- Natural, low-latency voice conversations via Grok Real-time Voice API
- Caller recognition by phone number (greets returning callers by name)
- Tee time booking, modification, and cancellation
- Course info: pricing, hours, policies, weather, tournaments
- Random human-like greetings (never the same opener twice in a row)
- Bilingual: English primary, French on request
- Web-based Command Center for managing all settings without touching code
- Email/SMS notifications to staff for booking requests

---

## 2. Tech Stack

| Layer              | Technology                  | Cost Estimate     |
|--------------------|-----------------------------|-------------------|
| Telephony          | Twilio Voice (SIP Trunking) | ~$20-50/mo        |
| Voice AI           | xAI Grok Real-time Voice API| ~$5-25/mo         |
| Backend Server     | Node.js + Express           | Railway (~$5-20/mo)|
| Database           | PostgreSQL (Railway)        | Included          |
| Command Center UI  | React (single-page app)     | Served from backend|
| SMS Notifications  | Twilio SMS                  | ~$0.01/msg        |
| Email Notifications| Nodemailer (Gmail SMTP)     | Free              |
| Weather API        | OpenWeatherMap              | Free tier          |
| Hosting/Deploy     | Railway.app                 | ~$5-20/mo         |

**Estimated Total: $50-120/month**

---

## 3. System Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                    CALLERS                            │
│              (905) 655-6300                           │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│              BELL CANADA                             │
│    Call forwarding to Twilio SIP number              │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│              TWILIO                                   │
│    - Receives inbound calls                          │
│    - Streams audio via WebSocket                     │
│    - Handles multiple simultaneous calls             │
│    - Can transfer to human (staff number)            │
└──────────────────┬──────────────────────────────────┘
                   │ WebSocket (bidirectional audio)
                   ▼
┌─────────────────────────────────────────────────────┐
│         RAILWAY — NODE.JS SERVER                     │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  Call Handler│  │ Grok Voice   │  │  Tool      │ │
│  │  Manager     │  │ API Bridge   │  │  Executor  │ │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                │                  │        │
│  ┌──────┴──────────────────┴────────────────┴──────┐ │
│  │              CORE ENGINE                         │ │
│  │  - Caller lookup (phone → customer record)      │ │
│  │  - Conversation context management              │ │
│  │  - Booking request processing                   │ │
│  │  - Settings loader (hours, prices, etc.)        │ │
│  │  - Notification dispatcher (email/SMS)          │ │
│  └──────────────────┬──────────────────────────────┘ │
│                     │                                 │
│  ┌──────────────────┴──────────────────────────────┐ │
│  │           POSTGRESQL DATABASE                    │ │
│  │  - Customers (name, phone, email)               │ │
│  │  - Booking requests (pending, confirmed)        │ │
│  │  - Call logs (transcripts, duration)            │ │
│  │  - Settings (hours, prices, greetings, etc.)   │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │         COMMAND CENTER (React SPA)               │ │
│  │  - Dashboard: today's calls, pending bookings   │ │
│  │  - Settings: hours, pricing, greetings, etc.    │ │
│  │  - Booking queue: review/approve/reject          │ │
│  │  - Customer directory                            │ │
│  │  - Call logs with transcripts                    │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│            EXTERNAL SERVICES                         │
│                                                       │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ xAI Grok │  │ OpenWeather  │  │ Tee-on Cloud  │ │
│  │ Voice API│  │ API          │  │ (Phase 2)     │ │
│  └──────────┘  └──────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────┘
```

---

## 4. Call Flow

```
INCOMING CALL
     │
     ▼
[Twilio receives call, sends webhook to our server]
     │
     ▼
[Server looks up caller by phone number in DB]
     │
     ├── Known caller → Load their name + history
     │
     └── Unknown caller → Flag as new
     │
     ▼
[Open Grok WebSocket session with system prompt + caller context]
     │
     ▼
[Play random greeting]
  Examples:
  - "Hey there! Thanks for calling Valleymede Columbus. What can I do for you?"
  - "Good afternoon, Valleymede Columbus Golf Course! How can I help?"
  - "Hi! You've reached Valleymede Columbus Golf. What's on your mind?"
  - (If known caller): "Hey Dave! Good to hear from you again. What can I help with?"
     │
     ▼
[Conversation loop — Grok handles naturally]
     │
     ├── INFO REQUEST → Grok answers from knowledge base
     │     (pricing, hours, directions, policies, course info)
     │
     ├── BOOKING REQUEST → Grok collects details via tool calls
     │     │
     │     ├── Known customer → Confirm identity, collect date/time/party size
     │     └── New customer → Collect name, phone, email, then date/time/party size
     │     │
     │     ▼
     │   [Save to booking queue + notify staff via email/SMS]
     │   [Confirm to caller: "Got it! We'll confirm your booking shortly."]
     │
     ├── EDIT/CANCEL REQUEST → Grok collects details
     │     [Save modification request + notify staff]
     │
     ├── WEATHER REQUEST → Grok calls weather API
     │     [Provides current/forecast for Oshawa]
     │
     ├── TRANSFER REQUEST → Check if during business hours
     │     ├── During hours → Transfer via Twilio to staff number
     │     └── After hours → "No one's available right now, but I can help with anything!"
     │
     └── UNKNOWN/COMPLEX → Offer to transfer or take a message
```

---

## 5. Command Center Features

### 5.1 Dashboard
- Active calls (real-time)
- Today's call count
- Pending booking requests
- Recent call log

### 5.2 Settings Page
- **Business Hours**: Set daily open/close times, seasonal schedules
- **Staff Transfer Number(s)**: Phone number(s) for human transfers
- **Greeting Messages**: Add/edit/remove random greetings
- **Max Booking Size**: Default 8 (two foursomes), adjustable
- **Pricing Table**: Weekday/weekend rates, cart fees — editable
- **Course Announcements**: Temporary messages (e.g., "Course closed for maintenance April 15")
- **Notification Settings**: Email/phone for booking alerts
- **AI Personality Notes**: Additional instructions for the AI's behavior
- **Test Phone Number**: Number to use for testing before going live

### 5.3 Booking Queue
- List of pending booking requests
- Customer details, requested date/time, party size
- Actions: Confirm, Modify, Reject (with reason)
- Status tracking

### 5.4 Customer Directory
- All known customers (from calls)
- Name, phone, email, call history
- Booking history
- Notes field for staff

### 5.5 Call Logs
- All calls with date, time, duration, caller
- AI-generated summary of each call
- Full transcript (optional, stored if enabled in settings)

---

## 6. Grok System Prompt Strategy

The AI's personality and knowledge are driven by a system prompt composed from:

1. **Base personality**: Friendly, natural, knowledgeable golf course staff member
2. **Course knowledge**: Injected from database (prices, hours, policies, etc.)
3. **Caller context**: Name, history if known
4. **Current settings**: Today's hours, any announcements, weather
5. **Tool definitions**: Functions for booking, weather lookup, transfer, etc.

This means when you change pricing in the Command Center, the AI immediately knows the new prices on the next call — no code changes needed.

---

## 7. Tee-on Integration Plan (Phase 2)

### Option A: API Access (Preferred)
- Contact Tee-on at 1-877-432-5448 or info@teeon.com
- Request API credentials for Tee-on Cloud
- Integrate: read tee sheet availability, create/modify/cancel bookings
- Real-time availability checks during calls

### Option B: Browser Automation (Fallback)
- Use Playwright/Puppeteer to automate Tee-on Cloud web interface
- Login, navigate tee sheet, read availability, make bookings
- More fragile but functional
- Would run as a separate service on Railway

### What Changes with Tee-on Integration
- AI can check real-time availability: "Let me check... I have 10:20 and 10:40 open Saturday morning"
- AI can book directly: "You're all set for 10:20 Saturday, foursome under Dave Thompson"
- AI can cancel/modify instantly
- No more manual booking queue — everything automated

---

## 8. Bell Canada Setup

### Steps to Connect Existing Number:
1. Call Bell Canada business support
2. Request **call forwarding** on (905) 655-6300
3. Forward to your Twilio phone number
4. Options:
   - **Unconditional forwarding**: All calls go to AI (recommended)
   - **Busy/no-answer forwarding**: AI only picks up if staff don't answer
5. Approximate Bell cost: $5-15/month for call forwarding feature

### Alternative: SIP Trunking (More Advanced)
- Bell offers SIP trunking for business lines
- More control over routing but more complex setup
- Recommended for Phase 2 if you want sophisticated routing

---

## 9. Project Structure

```
golf-ai-phone-system/
├── server/
│   ├── index.js                 # Express server entry point
│   ├── config/
│   │   └── database.js          # PostgreSQL connection
│   ├── routes/
│   │   ├── twilio.js            # Twilio webhook handlers
│   │   ├── api.js               # REST API for Command Center
│   │   └── auth.js              # Login/authentication
│   ├── services/
│   │   ├── grok-voice.js        # Grok WebSocket voice bridge
│   │   ├── call-manager.js      # Call lifecycle management
│   │   ├── caller-lookup.js     # Customer recognition
│   │   ├── booking-manager.js   # Booking request handling
│   │   ├── notification.js      # Email/SMS dispatch
│   │   ├── weather.js           # OpenWeatherMap integration
│   │   └── system-prompt.js     # Dynamic prompt builder
│   ├── tools/
│   │   ├── book-tee-time.js     # Tool: create booking request
│   │   ├── edit-booking.js      # Tool: modify booking
│   │   ├── cancel-booking.js    # Tool: cancel booking
│   │   ├── check-weather.js     # Tool: get weather forecast
│   │   ├── transfer-call.js     # Tool: transfer to human
│   │   └── lookup-customer.js   # Tool: find customer in DB
│   ├── db/
│   │   ├── schema.sql           # Database schema
│   │   └── seed.sql             # Initial data (pricing, hours, etc.)
│   └── middleware/
│       └── auth.js              # JWT authentication
├── command-center/
│   ├── index.html               # Single-page React app
│   ├── src/
│   │   ├── App.jsx
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Settings.jsx
│   │   │   ├── Bookings.jsx
│   │   │   ├── Customers.jsx
│   │   │   ├── CallLogs.jsx
│   │   │   └── Login.jsx
│   │   └── components/
│   │       ├── Sidebar.jsx
│   │       ├── BookingCard.jsx
│   │       ├── CallLogEntry.jsx
│   │       └── SettingsForm.jsx
│   └── vite.config.js
├── .env.example                  # Environment variables template
├── package.json
├── railway.json                  # Railway deployment config
├── Dockerfile
└── README.md
```

---

## 10. Environment Variables Needed

```
# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=        # Your Twilio number
TWILIO_TWIML_APP_SID=

# xAI Grok
XAI_API_KEY=

# Database
DATABASE_URL=               # Railway provides this

# OpenWeatherMap
OPENWEATHER_API_KEY=

# Notifications
NOTIFICATION_EMAIL=         # Where to send booking alerts
NOTIFICATION_PHONE=         # SMS alerts
SMTP_HOST=smtp.gmail.com
SMTP_USER=
SMTP_PASS=

# Auth
JWT_SECRET=
ADMIN_USERNAME=
ADMIN_PASSWORD=

# App
NODE_ENV=production
PORT=3000
```

---

## 11. Accounts to Set Up

| Service         | URL                        | What You Need         |
|-----------------|----------------------------|-----------------------|
| Twilio          | twilio.com                 | Account + phone number|
| xAI             | console.x.ai              | API key               |
| Railway         | railway.app                | Already have          |
| GitHub          | github.com                 | Already have          |
| OpenWeatherMap  | openweathermap.org/api     | Free API key          |

---

## 12. Estimated Monthly Costs at Your Volume

| Item                        | 50 calls/day avg | 100 calls/day avg |
|-----------------------------|------------------|--------------------|
| Twilio Phone Number         | $1.50            | $1.50              |
| Twilio Voice (inbound)      | $15              | $30                |
| Grok API (avg 3 min/call)   | $7.50            | $15                |
| Railway Hosting             | $10              | $15                |
| Twilio SMS (notifications)  | $2               | $5                 |
| OpenWeatherMap              | Free             | Free               |
| **TOTAL**                   | **~$36/mo**      | **~$67/mo**        |

*Note: Bell Canada call forwarding adds ~$5-15/month*
