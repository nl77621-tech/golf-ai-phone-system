# Valleymede Golf AI Phone System — Setup Guide

Follow these steps in order. Total setup time: ~1-2 hours.

---

## Step 1: Create Your Accounts & Get API Keys

You need 3 API keys. Here's how to get each one:

### 1A. Twilio (Phone System)
1. Go to https://www.twilio.com/try-twilio and create an account
2. Once logged in, go to **Console** → you'll see your **Account SID** and **Auth Token**
3. Go to **Phone Numbers** → **Buy a Number**
4. Buy a Canadian number (choose area code 905 or 289 for local Oshawa)
5. Cost: ~$1.50/month for the number

### 1B. xAI / Grok (Voice AI)
1. Go to https://console.x.ai and create an account
2. Go to **API Keys** and create a new key
3. Add some credits (start with $10 — that's about 200 minutes of calls)

### 1C. OpenWeatherMap (Weather)
1. Go to https://openweathermap.org/api and sign up (free)
2. Go to **API Keys** and copy your key
3. The free tier gives 1,000 calls/day (more than enough)

---

## Step 2: Deploy to Railway

### 2A. Push Code to GitHub
1. Open Terminal on your Mac
2. Navigate to the project folder:
   ```
   cd "path/to/golf-ai-phone-system"
   ```
3. Initialize git and push:
   ```
   git init
   git add .
   git commit -m "Initial commit - Golf AI Phone System"
   git remote add origin https://github.com/YOUR_USERNAME/golf-ai-phone-system.git
   git push -u origin main
   ```

### 2B. Deploy on Railway
1. Go to https://railway.app and log in
2. Click **New Project** → **Deploy from GitHub Repo**
3. Select your `golf-ai-phone-system` repository
4. Railway will auto-detect the Dockerfile

### 2C. Add PostgreSQL Database
1. In your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Railway automatically creates the `DATABASE_URL` environment variable

### 2D. Set Environment Variables
1. Click on your service in Railway
2. Go to **Variables** tab
3. Add ALL these variables:

```
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
XAI_API_KEY=your_xai_key
OPENWEATHER_API_KEY=your_openweather_key
NOTIFICATION_EMAIL=info@valleymedecolumbusgolf.com
NOTIFICATION_PHONE=+19056556300
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_gmail@gmail.com
SMTP_PASS=your_gmail_app_password
JWT_SECRET=generate-a-random-32-char-string
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password
NODE_ENV=production
APP_URL=https://your-app-name.up.railway.app
```

> **Gmail App Password**: Go to Google Account → Security → 2-Step Verification → App Passwords → Generate one for "Mail"

### 2E. Initialize the Database
1. In Railway, go to your service → **Settings** → **Deploy**
2. Temporarily change the start command to: `node server/db/init.js && node server/index.js`
3. Deploy once, then change it back to: `node server/index.js`
4. Or use Railway's **Run Command** feature to run `node server/db/init.js`

### 2F. Get Your Railway URL
1. Go to **Settings** → **Networking** → **Generate Domain**
2. You'll get something like: `golf-ai-phone.up.railway.app`
3. Update the `APP_URL` variable with this URL

---

## Step 3: Configure Twilio

### 3A. Set Up Webhook
1. Go to Twilio Console → **Phone Numbers** → click your number
2. Under **Voice Configuration**:
   - **When a call comes in**: Webhook
   - **URL**: `https://your-app.up.railway.app/twilio/voice`
   - **Method**: POST
3. Under **Call Status Changes**:
   - **URL**: `https://your-app.up.railway.app/twilio/status`
   - **Method**: POST
4. Click **Save**

### 3B. Test with Twilio Number
1. Call your Twilio phone number from your home phone
2. You should hear the AI answer!
3. Test various scenarios: ask about pricing, book a tee time, ask for weather

---

## Step 4: Connect Your Bell Canada Number

### Option A: Simple Call Forwarding (Easiest)
1. Call Bell Canada business support: 310-BELL (310-2355)
2. Request to add **Call Forwarding** to your line (905) 655-6300
3. Forward all calls to your Twilio number
4. Approximate cost: $5-15/month

### Option B: Conditional Forwarding
1. Same call to Bell
2. Request **Call Forward Busy/No Answer**
3. This way, if staff picks up first, the AI doesn't answer
4. If nobody answers after X rings, it forwards to the AI

### To Activate (once Bell enables the feature):
- **Activate**: Pick up the phone and dial `*72` then the Twilio number
- **Deactivate**: Pick up the phone and dial `*73`

---

## Step 5: Set Up the Command Center

1. Go to `https://your-app.up.railway.app` in your browser
2. Log in with the username/password you set in the environment variables
3. Go to **Settings** and configure:
   - **Test Mode**: Enable it and enter your home phone number
   - **Business Hours**: Set your daily hours
   - **Staff Transfer Number**: Your course phone or cell
   - **Notification Email/Phone**: Where to receive booking alerts
   - **Greetings**: Add or modify random greetings
   - **Pricing**: Verify all green fees are correct

---

## Step 6: Test Everything

With Test Mode enabled, only your home phone number will reach the AI:

### Test Scenarios:
1. **Basic info**: "What are your hours?" / "How much is 18 holes on Saturday?"
2. **New booking**: "I'd like to book a tee time for Saturday morning, 4 players"
3. **Price check**: "What's the twilight rate on a weekday?"
4. **Weather**: "What's the weather looking like for Thursday?"
5. **Cancel**: "I need to cancel my booking for Saturday at 10am"
6. **Modify**: "Can I move my tee time from 10am to 2pm?"
7. **Transfer**: "Can I speak to someone?"
8. **After hours**: Call outside business hours and ask for a person
9. **French**: Start speaking in French
10. **Membership**: "Are memberships available?"

### Check the Command Center:
- Verify calls appear in **Call Logs**
- Verify bookings appear in **Bookings** queue
- Verify new callers appear in **Customers**
- Verify you receive email/SMS for bookings

---

## Step 7: Go Live

1. Go to Command Center → Settings → **Test Mode** → Disable it
2. All callers will now reach the AI
3. Monitor the Dashboard for the first few days
4. Adjust greetings, pricing, and AI behavior as needed

---

## Ongoing Maintenance

### Updating Pricing
Settings → Pricing → Edit the JSON → Save

### Adding Announcements
Settings → General → Course Announcements
Example: `[{"message": "Course closed Monday April 15 for maintenance", "active": true}]`

### Changing Hours
Settings → Hours → Adjust times per day

### Viewing Call Activity
Dashboard shows today's calls and pending bookings
Call Logs page shows all calls with transcripts

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| AI doesn't answer | Check Twilio webhook URL matches your Railway URL |
| No audio / silence | Check XAI_API_KEY is valid and has credits |
| No booking emails | Check SMTP settings and notification email in settings |
| Command Center won't load | Check Railway deployment logs for errors |
| Database error | Re-run `node server/db/init.js` via Railway |

### Getting Help
- Railway logs: Click your service → **Deployments** → View logs
- Twilio debugger: Console → **Monitor** → **Logs** → **Errors**

---

## Phase 2: Tee-on Integration (Future)

When you have API access to Tee-on Cloud:
1. We'll add a `tee-on.js` service to the server
2. The AI will be able to check real-time tee sheet availability
3. Bookings will be made directly in Tee-on — no more manual queue
4. Contact Tee-on: 1-877-432-5448 or info@teeon.com to request API access
