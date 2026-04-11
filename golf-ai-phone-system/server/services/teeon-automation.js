/**
 * Tee-On Golf Systems Automation
 * Uses Puppeteer (headless Chrome) to log into Tee-On and:
 *  - Check available tee times for a given date
 *
 * Credentials stored as env vars: TEEON_USERNAME, TEEON_PASSWORD
 * Course: Valleymede Columbus Golf Club (CourseCode=COLU, CourseGroupID=11242)
 *
 * NOTE: The TEEON_USERNAME account is an Administrator. Tee-On blocks admins
 * from completing bookings through the golfer web interface. Availability
 * checking works fine. Bookings are handled as "booking requests" stored in
 * the database and confirmed by staff. To enable live bookings in the future,
 * create a non-admin golfer account and update the credentials.
 */

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.warn('Puppeteer not available — Tee-On automation disabled');
}

const TEEON_LOGIN_URL = 'https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.SignInGolferSection?LoginType=-1&GrabFocus=true&FromTeeOn=true';
const TEEON_SHEET_URL = 'https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingAllTimesLanding?CourseGroupID=11242&CourseCode=COLU&LoginType=-1';

let browser = null;
let lastLoginTime = null;
const SESSION_TTL_MS = 25 * 60 * 1000; // re-login every 25 minutes

/**
 * Get or create a logged-in Puppeteer browser session
 */
async function getSession() {
  if (!puppeteer) throw new Error('Puppeteer not installed');
  if (!process.env.TEEON_USERNAME || !process.env.TEEON_PASSWORD) {
    throw new Error('TEEON_USERNAME and TEEON_PASSWORD environment variables not set');
  }

  const sessionExpired = !lastLoginTime || (Date.now() - lastLoginTime > SESSION_TTL_MS);

  if (!browser || !browser.connected || sessionExpired) {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }

    console.log('[TeeOn] Launching browser and logging in...');

    // Use system Chromium if available (Railway/Linux), otherwise fall back to bundled
    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    if (!executablePath) {
      const fs = require('fs');
      const { execSync } = require('child_process');
      if (fs.existsSync('/usr/bin/chromium')) {
        executablePath = '/usr/bin/chromium';
      } else if (fs.existsSync('/usr/bin/chromium-browser')) {
        executablePath = '/usr/bin/chromium-browser';
      } else {
        try {
          const p = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null', { encoding: 'utf8' }).trim();
          if (p) executablePath = p;
        } catch (e) {}
      }
    }

    const launchOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking'
      ]
    };
    if (executablePath) {
      launchOpts.executablePath = executablePath;
      console.log(`[TeeOn] Using Chrome at: ${executablePath}`);
    }

    browser = await puppeteer.launch(launchOpts);
    await login(browser);
    lastLoginTime = Date.now();
    console.log('[TeeOn] Logged in successfully');
  }

  return browser;
}

/**
 * Perform login on Tee-On
 */
async function login(br) {
  const page = await br.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  await page.goto(TEEON_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for ALTCHA to auto-solve (it's a proof-of-work, not visual CAPTCHA)
  console.log('[TeeOn] Waiting for ALTCHA to solve...');
  await page.waitForSelector('altcha-widget', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 6000)); // Give ALTCHA time to compute

  // Fill credentials
  await page.waitForSelector('input[name="UserName"], input[id="UserName"]', { timeout: 10000 });
  await page.type('input[name="UserName"], input[id="UserName"]', process.env.TEEON_USERNAME);
  await page.type('input[name="Password"], input[id="Password"]', process.env.TEEON_PASSWORD);

  // Submit
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    page.click('input[type="submit"], button[type="submit"]')
  ]);

  const currentUrl = page.url();
  if (currentUrl.includes('SignIn') || currentUrl.includes('Error')) {
    const bodyText = await page.evaluate(() => document.body.innerText);
    throw new Error(`Login failed. URL: ${currentUrl}. Body: ${bodyText.slice(0, 200)}`);
  }

  await page.close();
}

/**
 * Check available tee times for a given date
 *
 * Page structure (confirmed via DOM inspection Apr 2026):
 * - Times appear as "7:30AM", "9:22AM" etc. (uppercase AM/PM) in innerText
 * - Each tile also shows course ("Front" or "Back") and price
 * - Tile times can be filtered for 18 Holes / 9 Holes
 *
 * @param {string} date - YYYY-MM-DD format
 * @param {number} partySize - 1-4 (used to navigate to correct date)
 * @returns {Array} list of available time slot objects
 */
async function checkAvailability(date, partySize = 1) {
  const br = await getSession();
  const page = await br.newPage();

  try {
    // Format date for Tee-On URL (MM/DD/YYYY)
    const [year, month, day] = date.split('-');
    const teeonDate = `${month}/${day}/${year}`;

    const url = `${TEEON_SHEET_URL}&SelectedDate=${encodeURIComponent(teeonDate)}&NumberOfPlayers=${partySize}`;
    console.log(`[TeeOn] Checking availability for ${date}, party of ${partySize}`);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for tee times to render (the date nav always appears)
    await page.waitForSelector('[class*="toggle-players-wrapper"]', { timeout: 10000 })
      .catch(() => console.log('[TeeOn] No player wrapper found — may be no times available'));

    // Give JS time to render tiles
    await new Promise(r => setTimeout(r, 1500));

    // Extract times from page text
    // Tiles show times as "7:30AM" or "2:15PM" (uppercase) in innerText
    // The popup titles show "18 Holes - 7:30am" (lowercase) — we exclude those
    const result = await page.evaluate(() => {
      const text = document.body.innerText;

      // Check for "No times available" message
      if (text.includes('No times available')) {
        return { noTimes: true, slots: [] };
      }

      const slots = [];
      // Match tile times: digit:digit followed immediately by AM or PM (uppercase only)
      // Example matches: "7:30AM", "10:02AM", "12:10PM"
      const timeRegex = /\b(\d{1,2}:\d{2})(AM|PM)\b/g;
      let match;
      const seen = new Set();

      while ((match = timeRegex.exec(text)) !== null) {
        const timeStr = match[1] + ':' + match[2]; // e.g. "7:30:AM" — fix below
        const full = match[1] + match[2]; // e.g. "7:30AM"

        if (seen.has(full)) continue;
        seen.add(full);

        // Get context around this time (next 60 chars) to extract course + holes
        const context = text.substring(match.index, match.index + 80);
        const course = context.includes('Front') ? 'Front 9' : context.includes('Back') ? 'Back 9' : 'Course';
        const holes = context.includes('18 Holes') || context.includes('18 H') ? 18 : 9;

        // Format nicely: "7:30 AM"
        const displayTime = match[1] + ' ' + match[2];

        slots.push({ time: displayTime, raw: full, course, holes });
      }

      return { noTimes: false, slots };
    });

    if (result.noTimes) {
      console.log(`[TeeOn] No times available for ${date}`);
      return [];
    }

    console.log(`[TeeOn] Found ${result.slots.length} available slots for ${date}`);
    return result.slots;

  } finally {
    await page.close();
  }
}

/**
 * Close the browser (call on server shutdown)
 */
async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch (e) {}
    browser = null;
  }
}

/**
 * Check if Tee-On automation is available
 */
function isAvailable() {
  return !!puppeteer && !!process.env.TEEON_USERNAME && !!process.env.TEEON_PASSWORD;
}

module.exports = { checkAvailability, closeBrowser, isAvailable };
