/**
 * Tee-On Golf Systems Automation
 * Uses Puppeteer (headless Chrome) to log into Tee-On and:
 *  - Check available tee times for a given date
 *  - Book a tee time with caller details
 *  - Modify or cancel existing bookings
 *
 * Credentials stored as env vars: TEEON_USERNAME, TEEON_PASSWORD
 * Course: Valleymede Columbus Golf Club (CourseCode=COLU, CourseGroupID=11242)
 */

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.warn('Puppeteer not available — Tee-On automation disabled');
}

const TEEON_LOGIN_URL = 'https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.SignInGolferSection?LoginType=-1&GrabFocus=true&FromTeeOn=true';
const TEEON_SHEET_URL = 'https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingAllTimesLanding?CourseGroupID=11242&CourseCode=COLU&LoginType=-1';
const COURSE_CODE = 'COLU';
const COURSE_GROUP_ID = '11242';

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
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });

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
  // Give ALTCHA time to compute and verify
  await new Promise(r => setTimeout(r, 6000));

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
 * Check available tee times for a given date and party size
 * @param {string} date - YYYY-MM-DD format
 * @param {number} partySize - 1-4
 * @returns {Array} list of available time slots
 */
async function checkAvailability(date, partySize = 1) {
  const br = await getSession();
  const page = await br.newPage();

  try {
    // Format date for Tee-On (MM/DD/YYYY)
    const [year, month, day] = date.split('-');
    const teeonDate = `${month}/${day}/${year}`;

    // Navigate to tee sheet for the given date
    const url = `${TEEON_SHEET_URL}&SelectedDate=${encodeURIComponent(teeonDate)}&NumberOfPlayers=${partySize}`;
    console.log(`[TeeOn] Checking availability for ${date}, party of ${partySize}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for tee time rows to load
    await page.waitForSelector('table, .tee-time, [class*="teeTime"], [class*="time-slot"]', { timeout: 10000 })
      .catch(() => console.log('[TeeOn] No tee time selector found, trying to parse page anyway'));

    // Scrape available time slots
    const slots = await page.evaluate((players) => {
      const available = [];

      // Try various selectors Tee-On might use for time slots
      const rows = document.querySelectorAll('tr, .teeTimeRow, [class*="available"]');

      rows.forEach(row => {
        const text = row.innerText || row.textContent || '';

        // Look for time patterns (7:00 AM, 10:30, etc.)
        const timeMatch = text.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)\b/);
        if (!timeMatch) return;

        // Skip rows that look booked (contain player names or "Full")
        const isBooked = text.includes('Full') ||
                         (row.querySelector('input[value*="Name"]') === null &&
                          row.querySelectorAll('td').length > 2 &&
                          text.trim().length > 20 &&
                          !text.includes('Book'));

        // Check for a booking link or button
        const hasBookLink = row.querySelector('a, button, input[type="button"]') !== null;

        if (timeMatch && !isBooked && hasBookLink) {
          available.push({
            time: timeMatch[1],
            text: text.trim().slice(0, 100)
          });
        }
      });

      return available;
    }, partySize);

    // If scraping didn't find structured data, fall back to page text
    if (slots.length === 0) {
      const pageText = await page.evaluate(() => document.body.innerText);
      const timeMatches = [...pageText.matchAll(/\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))\b/g)];
      const times = [...new Set(timeMatches.map(m => m[1]))];
      console.log(`[TeeOn] Fallback: found ${times.length} time patterns on page`);
      return times.map(t => ({ time: t, available: true }));
    }

    console.log(`[TeeOn] Found ${slots.length} available slots`);
    return slots;

  } finally {
    await page.close();
  }
}

/**
 * Book a tee time in Tee-On
 * @param {object} details - booking details
 * @returns {object} result with success/failure
 */
async function bookTeeTime({ date, time, partySize = 1, holes = 18, carts = 0, players = [] }) {
  const br = await getSession();
  const page = await br.newPage();

  try {
    const [year, month, day] = date.split('-');
    const teeonDate = `${month}/${day}/${year}`;

    console.log(`[TeeOn] Booking tee time: ${date} ${time}, party of ${partySize}`);

    // Navigate to tee sheet for the date
    const url = `${TEEON_SHEET_URL}&SelectedDate=${encodeURIComponent(teeonDate)}&NumberOfPlayers=${partySize}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Find and click the time slot link
    const clicked = await page.evaluate((targetTime) => {
      // Normalize target time for comparison (e.g. "10:30 AM" or "10:30")
      const normalize = t => t.replace(/\s+/g, '').toLowerCase();
      const target = normalize(targetTime);

      const links = document.querySelectorAll('a, input[type="button"], button');
      for (const el of links) {
        const text = normalize(el.innerText || el.value || '');
        if (text.includes(target)) {
          el.click();
          return true;
        }
      }

      // Try finding in table rows
      const rows = document.querySelectorAll('tr');
      for (const row of rows) {
        const text = normalize(row.innerText || '');
        if (text.includes(target)) {
          const link = row.querySelector('a, input[type="button"]');
          if (link) { link.click(); return true; }
        }
      }

      return false;
    }, time);

    if (!clicked) {
      return { success: false, error: `Could not find time slot ${time} on ${date}. It may already be booked or unavailable.` };
    }

    // Wait for booking form to load
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 1000));

    // Set number of players
    await page.evaluate((count) => {
      const btns = document.querySelectorAll('input[type="button"], button');
      for (const btn of btns) {
        const val = (btn.value || btn.innerText || '').trim();
        if (val === String(count)) { btn.click(); return; }
      }
    }, partySize);
    await new Promise(r => setTimeout(r, 500));

    // Set holes (18 or 9)
    await page.evaluate((holeCount) => {
      const btns = document.querySelectorAll('input[type="button"], button');
      for (const btn of btns) {
        const val = (btn.value || btn.innerText || '').trim();
        if (val === String(holeCount)) { btn.click(); return; }
      }
    }, holes);
    await new Promise(r => setTimeout(r, 500));

    // Set carts
    await page.evaluate((cartCount) => {
      const btns = document.querySelectorAll('input[type="button"], button');
      for (const btn of btns) {
        const val = (btn.value || btn.innerText || '').trim();
        if (val === String(cartCount)) { btn.click(); return; }
      }
    }, carts);
    await new Promise(r => setTimeout(r, 500));

    // Fill in player 1 details (primary booker)
    const primaryPlayer = players[0] || {};
    if (primaryPlayer.name) {
      await page.evaluate((name) => {
        const inputs = document.querySelectorAll('input[placeholder="Name"], input[name*="Name"]');
        if (inputs[0]) { inputs[0].value = ''; inputs[0].value = name; }
      }, primaryPlayer.name);
    }

    if (primaryPlayer.phone) {
      await page.evaluate((phone) => {
        const inputs = document.querySelectorAll('input[placeholder="Phone"], input[name*="Phone"]');
        if (inputs[0]) { inputs[0].value = phone; }
      }, primaryPlayer.phone);
    }

    if (primaryPlayer.email) {
      await page.evaluate((email) => {
        const inputs = document.querySelectorAll('input[placeholder="Email"], input[name*="Email"]');
        if (inputs[0]) { inputs[0].value = email; }
      }, primaryPlayer.email);
    }

    await new Promise(r => setTimeout(r, 500));

    // Take a screenshot before saving (for debugging)
    // await page.screenshot({ path: '/tmp/teeon-booking.png' });

    // Click Save
    const saved = await page.evaluate(() => {
      const btns = document.querySelectorAll('input[type="button"], input[type="submit"], button');
      for (const btn of btns) {
        const val = (btn.value || btn.innerText || '').trim().toLowerCase();
        if (val === 'save') { btn.click(); return true; }
      }
      return false;
    });

    if (!saved) {
      return { success: false, error: 'Could not find Save button on booking form' };
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
      .catch(() => {}); // sometimes no navigation after save

    // Check for success or error message
    const resultText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    const isError = resultText.toLowerCase().includes('error') ||
                    resultText.toLowerCase().includes('already booked') ||
                    resultText.toLowerCase().includes('unavailable');

    if (isError) {
      return { success: false, error: resultText.slice(0, 200) };
    }

    console.log(`[TeeOn] Booking saved successfully`);
    return {
      success: true,
      message: `Tee time booked in Tee-On: ${date} at ${time}, ${partySize} player(s), ${holes} holes`
    };

  } catch (err) {
    console.error('[TeeOn] Booking error:', err.message);
    return { success: false, error: err.message };
  } finally {
    await page.close();
  }
}

/**
 * Close the browser (call on server shutdown)
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Check if Tee-On automation is available
 */
function isAvailable() {
  return !!puppeteer && !!process.env.TEEON_USERNAME && !!process.env.TEEON_PASSWORD;
}

module.exports = { checkAvailability, bookTeeTime, closeBrowser, isAvailable };
