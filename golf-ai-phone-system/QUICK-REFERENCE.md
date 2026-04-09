# Quick Reference Card

## API Keys You Need (Get These First)

| Service | URL | What You Get |
|---------|-----|--------------|
| **Twilio** | https://www.twilio.com/try-twilio | Account SID, Auth Token, Phone Number |
| **xAI (Grok)** | https://console.x.ai | API Key (buy $10-20 credits) |
| **OpenWeatherMap** | https://openweathermap.org/api | API Key (free tier) |
| **Gmail** | https://myaccount.google.com/apppasswords | App Password (for email alerts) |

---

## Terminal Commands (Copy & Paste)

```bash
# Navigate to project
cd ~/Documents/Claude/Projects/golf-ai-phone-system

# Initialize git
git init

# Stage all files
git add .

# Commit
git commit -m "Initial commit: AI phone system for Valleymede Golf"

# Add GitHub remote (replace YOUR_USERNAME and repo URL)
git remote add origin https://github.com/YOUR_USERNAME/golf-ai-phone-system.git

# Push to GitHub
git branch -M main
git push -u origin main
```

---

## Environment Variables (Railway Dashboard)

Copy-paste into Railway Variables tab:

```
TWILIO_ACCOUNT_SID=your_sid_here
TWILIO_AUTH_TOKEN=your_token_here
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
XAI_API_KEY=your_key_here
OPENWEATHER_API_KEY=your_key_here
NOTIFICATION_EMAIL=info@valleymedecolumbusgolf.com
NOTIFICATION_PHONE=+19056556300
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_gmail@gmail.com
SMTP_PASS=your_app_password
JWT_SECRET=abc123def456ghi789jkl012mnopqrstu
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password
NODE_ENV=production
APP_URL=https://your-domain.up.railway.app
```

---

## Important URLs

| What | URL |
|------|-----|
| **Your App** | `https://your-domain.up.railway.app` |
| **Command Center** | `https://your-domain.up.railway.app` |
| **Twilio Webhook (Voice)** | `https://your-domain.up.railway.app/twilio/voice` |
| **Twilio Webhook (Status)** | `https://your-domain.up.railway.app/twilio/status` |
| **Health Check** | `https://your-domain.up.railway.app/health` |

---

## First Time Setup Checklist

- [ ] Create Twilio account, buy phone number
- [ ] Create xAI account, buy credits
- [ ] Create OpenWeatherMap account
- [ ] Push code to GitHub
- [ ] Create Railway project
- [ ] Add PostgreSQL to Railway
- [ ] Set all environment variables
- [ ] Generate Railway domain
- [ ] Initialize database
- [ ] Log into Command Center
- [ ] Configure Twilio webhook
- [ ] Test with a phone call
- [ ] Set up Bell call forwarding
- [ ] Disable test mode when ready to go live

---

## Passwords to Remember

- **Command Center login**: username/password you set in Railway variables
- **GitHub**: Your GitHub password
- **Gmail app password**: 16-char code from myaccount.google.com/apppasswords

---

## File Locations in Your Project

```
golf-ai-phone-system/
├── DEPLOY-STEP-BY-STEP.md     ← Follow this guide
├── SETUP-GUIDE.md              ← Full setup instructions
├── ARCHITECTURE.md             ← How the system works
├── server/index.js             ← Main app
├── command-center/src/App.jsx  ← Web dashboard
├── server/db/schema.sql        ← Database setup
└── Dockerfile                  ← Deployment config
```

---

## Test Commands (After Deployment)

```bash
# Test webhook is accessible
curl https://your-domain.up.railway.app/health

# Test app is running
curl https://your-domain.up.railway.app

# View server logs (in Railway dashboard)
Click service → Logs tab
```

---

## If Something Goes Wrong

1. **Check Railway Logs**: Click your Node.js service → Logs
2. **Check Environment Variables**: Make sure all 20+ are set correctly
3. **Verify API Keys**: Make sure they're valid and have funds/credits
4. **Test Health Endpoint**: `https://your-domain.up.railway.app/health`
5. **Contact Support**:
   - Twilio: https://www.twilio.com/help
   - Railway: https://railway.app/support
   - xAI: https://support.x.ai

---

## Monthly Maintenance

- [ ] Check xAI API usage (https://console.x.ai)
- [ ] Check Twilio usage (https://console.twilio.com)
- [ ] Review call logs in Command Center
- [ ] Update pricing if needed (Settings → Pricing)
- [ ] Add announcements if course is closed
- [ ] Test a full call (info → booking → confirmation)

---

## Contact Info When You Need Help

- **Twilio Support**: 1-844-839-5346
- **Railway Support**: https://railway.app/support
- **xAI Support**: https://support.x.ai
- **Bell Canada**: 310-BELL (310-2355) for call forwarding

---

**Remember**: You can change anything in the Command Center Settings without touching code. Settings changes take effect on the next call.
