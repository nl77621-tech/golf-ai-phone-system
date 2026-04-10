# Deploy to GitHub & Railway — Step by Step

This guide walks you through deploying your AI phone system to GitHub and then to Railway. **Total time: ~45 minutes**

---

## PART 1: GitHub Setup (15 minutes)

### Step 1.1: Create a GitHub Repository

1. Go to https://github.com/new
2. Log in if prompted
3. Fill in:
   - **Repository name**: `golf-ai-phone-system`
   - **Description**: `AI Phone Answering System for Valleymede Columbus Golf Course`
   - **Public** or **Private** (up to you — doesn't matter for this project)
   - **Add .gitignore**: Select `Node`
4. Click **Create repository**
5. You'll see a page with instructions. **Copy the HTTPS URL** at the top. It looks like:
   ```
   https://github.com/YOUR_USERNAME/golf-ai-phone-system.git
   ```
   Keep this handy — you'll need it next.

### Step 1.2: Push Code from Your Computer

1. **Open Terminal** on your Mac
   - Press `Cmd + Space`, type `Terminal`, hit Enter

2. **Navigate to your project folder**:
   ```bash
   cd ~/Documents/Claude/Projects/golf-ai-phone-system
   ```

3. **Initialize git** (only do this once):
   ```bash
   git init
   ```

4. **Add all files**:
   ```bash
   git add .
   ```

5. **Create your first commit**:
   ```bash
   git commit -m "Initial commit: AI phone system for Valleymede Golf"
   ```

6. **Connect to GitHub** (paste YOUR repository URL):
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/golf-ai-phone-system.git
   ```

7. **Push to GitHub**:
   ```bash
   git branch -M main
   git push -u origin main
   ```

8. **Wait for it to finish** — you'll see:
   ```
   Enumerating objects: 45, done.
   ...
   * [new branch]      main -> main
   Branch 'main' set up to track remote branch 'main' from 'origin'.
   ```

✅ **Your code is now on GitHub!** Go to your GitHub repo URL in the browser and refresh — you'll see all your files.

---

## PART 2: Railway Setup (30 minutes)

### Step 2.1: Create a Railway Account

1. Go to https://railway.app
2. Click **Login** or **Sign Up**
3. Sign up with GitHub (easiest) or email
4. Complete onboarding

### Step 2.2: Create a New Project

1. In Railway, click **+ New Project**
2. Click **Deploy from GitHub Repo**
3. You'll see **"Install GitHub App"** — click it
4. Authorize Railway to access your GitHub
5. Select your `golf-ai-phone-system` repository
6. Click **Deploy**

Railway will start building your app from the Dockerfile. **This takes 2-3 minutes.** While it's building, move to Step 2.3.

### Step 2.3: Add PostgreSQL Database

While the app is deploying:

1. In your Railway project, click **+ New**
2. Select **Database** → **PostgreSQL**
3. Wait for it to create (should be instant)
4. You'll see your PostgreSQL service in the project

Railway **automatically creates** a `DATABASE_URL` environment variable — you'll see it in a moment.

### Step 2.4: Add All Environment Variables

1. **Back to your app service** (the Node.js one that's deploying)
2. Click on it to open the service details
3. Click the **Variables** tab
4. Click **New Variable** and add each of these:

**Twilio Variables:**
```
TWILIO_ACCOUNT_SID = (your value from Twilio)
TWILIO_AUTH_TOKEN = (your value from Twilio)
TWILIO_PHONE_NUMBER = +12893679150
```

✅ **Canadian number purchased**: +1 (289) 367-9150 — 289 is the Oshawa/Durham Region area code, no long-distance charges when forwarding from your Bell Canada line.

**xAI Grok Variables:**
```
XAI_API_KEY = (your API key from console.x.ai)
```

**Weather:**
```
OPENWEATHER_API_KEY = (your key from openweathermap.org)
```

**Email Notifications:**
```
NOTIFICATION_EMAIL = info@valleymedecolumbusgolf.com
NOTIFICATION_PHONE = +19056556300
SMTP_HOST = smtp.gmail.com
SMTP_PORT = 587
SMTP_USER = your_gmail@gmail.com
SMTP_PASS = (your Gmail app password - see note below)
```

**Authentication:**
```
JWT_SECRET = (generate random 32 character string - use this: abc123def456ghi789jkl012mnopqrstu)
ADMIN_USERNAME = admin
ADMIN_PASSWORD = (create a secure password for Command Center login)
```

**App Configuration:**
```
NODE_ENV = production
APP_URL = (we'll get this in Step 2.5)
```

> **📌 Gmail App Password**: If using Gmail for email notifications:
> 1. Go to https://myaccount.google.com/apppasswords
> 2. Select Mail → macOS
> 3. Google generates a 16-character password
> 4. Copy that and paste it as SMTP_PASS

### Step 2.5: Get Your Railway Domain

1. On your Node.js service, click **Settings**
2. Scroll to **Networking**
3. Click **Generate Domain**
4. You'll get a domain like: `golf-ai-phone.up.railway.app`
5. Copy this and go back to **Variables**
6. Find the `APP_URL` variable and set it to:
   ```
   https://golf-ai-phone.up.railway.app
   ```
   (Replace `golf-ai-phone` with whatever your domain is)

### Step 2.6: Initialize the Database

Your app is running now, but the database tables haven't been created yet. Do this:

1. In your Node.js service, click **Logs** tab — you should see the server running
2. Click **Settings** → **Deploy** → **Deploy on Push**
3. Temporarily change the **Command** from:
   ```
   node server/index.js
   ```
   to:
   ```
   node server/db/init.js && node server/index.js
   ```
4. Click **Save**
5. This will trigger a redeploy. Wait for it to finish (watch the Logs tab)
6. Once you see `🎉 Database initialization complete!`, change the command back to:
   ```
   node server/index.js
   ```
7. Save and redeploy

✅ **Database is ready!**

### Step 2.7: Test Your Deployment

1. Go to your Railway domain in a browser:
   ```
   https://your-domain.up.railway.app
   ```

2. You should see the Command Center login page (golf flag emoji ⛳)

3. **Log in** with:
   - Username: `admin`
   - Password: (whatever you set in ADMIN_PASSWORD)

4. You should see the Dashboard!

✅ **Your app is live!**

---

## PART 3: Connect to Twilio (10 minutes)

### Step 3.1: Get a Canadian Twilio Phone Number

⚠️ **IMPORTANT**: Do NOT use a US Twilio number for this system!

**Why?** If you forward your Bell Canada number (905-655-6300) to a US Twilio number, Bell will charge you **long distance rates** for every forwarded call — potentially $0.10-0.50+ per call. With 50-100 calls/day, this adds up quickly.

**Solution**: Get a **Canadian Twilio phone number** instead:

1. Go to https://console.twilio.com
2. Click **Phone Numbers** in the left menu
3. Click **Buy a Number**
4. **Country**: Select **Canada**
5. **Area Code**: Choose **905** (Ontario local to Columbus area) OR **416/647** (GTA) OR **1-800** (toll-free)
6. Click **Search** — pick a number you like
7. Click **Buy** (trial account gets free Canadian numbers)
8. Once purchased, you'll see your number in **Phone Numbers** → **Active Numbers**
9. Note the number in format: `+1XXXXXXXXXX`
10. Also note your **Account SID** and **Auth Token** at the top of the console
11. Add all three to your Railway environment variables (already done in Step 2.4, but verify)

### Step 3.2: Set Up the Webhook

1. In Twilio Console, go to **Phone Numbers**
2. Click your phone number
3. Under **Voice & Fax**:
   - Find **"When a call comes in"**
   - Select **Webhook**
   - Set the URL to:
     ```
     https://your-domain.up.railway.app/twilio/voice
     ```
   - Method: **POST**
4. Scroll down and find **"Call Status Changes"**
   - Set URL to:
     ```
     https://your-domain.up.railway.app/twilio/status
     ```
   - Method: **POST**
5. Click **Save**

### Step 3.3: Test the Connection

1. From your home phone, **call your Twilio number**
2. You should hear the AI answer with a random greeting!
3. Try saying: "What are your hours?"
4. Or: "I'd like to book a tee time Saturday morning"

✅ **The AI is live!**

### Step 3.4: Check the Command Center

1. Go back to your Command Center (`https://your-domain.up.railway.app`)
2. Go to **Dashboard**
3. You should see your call logged in "Recent Calls"
4. Go to **Call Logs** — your call should be there with a transcript

---

## PART 4: Enable Test Mode (Optional but Recommended)

Before going fully live, test with just your phone number:

1. In Command Center, go to **Settings** → **Test Mode** tab
2. **Enable Test Mode** checkbox
3. Enter your home phone number
4. Click **Save**

Now only your phone number reaches the AI. Everyone else hears: *"Our phone system is being updated. Please call back shortly."*

Test scenarios:
- "What's the green fee for Saturday?"
- "Can I book 4 players for Saturday at 10am?"
- "I need to cancel my booking"
- Call after hours and ask for someone

Once you're confident, go back to **Test Mode** and **disable it** to go fully live.

---

## PART 5: Connect Bell Canada Number (Before Going Live)

This is important — so people can reach you on your existing number:

### ⚠️ CRITICAL: Use a Canadian Twilio Number

✅ **Your Canadian Twilio number is ready**: +1 (289) 367-9150 — no long-distance charges when forwarding from Bell Canada.

### Option A: Simple Call Forwarding (Recommended)

1. **Call Bell Canada**: 310-BELL (310-2355) or visit bell.ca
2. Tell them: *"I want to add call forwarding to line (905) 655-6300. Forward all calls to +12893679150."*
3. They'll set it up (usually instant)
4. Cost: ~$10/month (or included in your plan)
5. To test: Dial `*72` then `2893679150` then `#`
6. To disable: Dial `*73`

### Option B: Conditional Forwarding (Better for Mixed Use)

If your business sometimes needs to answer calls manually:

1. Same call to Bell
2. Ask for: **"Call Forward Busy/No Answer"**
3. This way if staff picks up, AI doesn't answer
4. If nobody answers after 30 seconds, forwards to AI
5. Cost: Same as Option A (~$10/month)

### Testing Bell Forwarding

Once forwarding is active, **test it thoroughly**:
- Call your actual (905) 655-6300 number from another phone
- You should hear the AI answer
- Check Command Center → **Call Logs** to verify the call was recorded
- Try making a booking request to test the full flow

---

## PART 6: Monitor & Maintain

### Daily
- **Command Center** → **Dashboard** — see today's calls and pending bookings

### Weekly
- **Settings** → Update pricing if needed
- **Settings** → Check greetings

### As Needed
- **Settings** → Add course announcements
- **Bookings** → Confirm, reject, or modify booking requests
- **Customers** → View customer history

### Important Reminders
- ✅ Back up your settings periodically (take a screenshot of Settings pages)
- ✅ Monitor your xAI/Twilio usage to avoid surprises
- ✅ Test the system monthly with a real call

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Deployment fails** | Check Railway logs. Usually missing environment variable. Add all vars from Step 2.4 |
| **AI doesn't answer calls** | Check Twilio webhook URL matches your Railway domain |
| **No audio / silent call** | Check XAI_API_KEY is valid and has credits |
| **Emails not sending** | Verify SMTP settings and Gmail app password |
| **Can't log into Command Center** | Check ADMIN_USERNAME and ADMIN_PASSWORD in Railway variables |
| **Database errors** | Re-run initialization: change deploy command, wait for init, change back |

### Get Logs
- **Railway**: Click service → **Logs** tab — shows everything
- **Twilio**: Console → **Monitor** → **Logs** → **Errors**
- **xAI**: Go to console.x.ai → check API usage

---

## Success Checklist

✅ Code pushed to GitHub
✅ Railway deployment successful
✅ PostgreSQL database created & initialized
✅ All 20+ environment variables set
✅ Twilio webhook configured
✅ Can log into Command Center
✅ Test call to Twilio number works
✅ AI responds with greeting
✅ Call appears in Command Center logs
✅ Booking request generates email alert
✅ Bell Canada forwarding set up (optional)
✅ Test mode enabled before going fully live

**You're done! Your AI phone system is live.** 🎉

---

## Next Steps

1. **Monitor the first week** — make sure everything works
2. **Adjust greetings** in Settings if you want them more/less formal
3. **When Tee-on API is ready**: Contact me to add Phase 2 (direct tee sheet integration)
4. **Ongoing**: Process booking requests in Command Center and confirm in Tee-on

Need help with any step? Let me know!
