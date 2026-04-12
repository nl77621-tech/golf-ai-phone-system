/**
 * Tee-On Golf Systems - Availability Checker
 *
 * Two-tier approach:
 *  1. HTTP-based (primary, always available): GETs the public tee sheet page and
 *     parses available times directly from HTML — no login, no Chromium needed.
 *  2. Puppeteer (secondary, when Chromium installed): logs in as admin for richer data.
 *
 * Course: Valleymede Columbus Golf Club (CourseCode=COLU, CourseGroupID=11242)
 * Credentials (for Puppeteer only): TEEON_USERNAME, TEEON_PASSWORD env vars
 */

const https = require('https');
const http = require('http');

// ─── HTTP-based availability check (no Puppeteer needed) ─────────────────────

const PUBLIC_SHEET_BASE = 'https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingAllTimesLanding';
const COURSE_CODE = 'COLU';
const COURSE_GROUP_ID = '11242';

/**
 * Make an HTTPS GET request, following redirects, returning { body, cookies, finalUrl }
 */
function httpsGet(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...headers
      }
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        const setCookies = res.headers['set-cookie'] || [];
        const cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');
        const newHeaders = cookieStr ? { ...headers, Cookie: ((headers.Cookie || '') + '; ' + cookieStr).trim().replace(/^;/, '') } : headers;
        return resolve(httpsGet(redirectUrl, newHeaders, redirectCount + 1));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        cookies: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '),
        finalUrl: url,
        status: res.statusCode
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP request timed out')); });
  });
}

/**
 * Make an HTTPS POST request
 */
function httpsPost(url, formData, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(formData)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');

    const urlObj = new URL(url);
    const lib = url.startsWith('https') ? https : http;

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers
      }
    };

    const req = lib.request(options, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        const setCookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        const allCookies = [headers.Cookie || '', setCookies].filter(Boolean).join('; ');
        return resolve(httpsGet(redirectUrl, { ...headers, Cookie: allCookies }));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        cookies: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '),
        status: res.statusCode
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP POST timed out')); });
    req.write(body);
    req.end();
  });
}

/**
 * Parse available tee times from Tee-On HTML page body
 * Tile times appear as "7:30AM", "10:02AM" (uppercase AM/PM) in innerText rendering
 */
function parseTimesFromHTML(html) {
  if (html.includes('No times available') || html.includes('no times available')) {
    return [];
  }

  const slots = [];
  const seen = new Set();

  // Match time patterns in the HTML text: e.g., >7:30<, 7:30AM, 7:30 AM
  // Tee-On renders times split across span elements like: <span>7:30</span><span class="am-pm">am</span>
  // So we look for digit:digit patterns near am/pm indicators

  // First try: find all times in text content (strip tags)
  const textOnly = html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');

  // Match uppercase AM/PM times (from page text rendering)
  const timeRegex = /\b(\d{1,2}:\d{2})\s*(AM|PM)\b/g;
  let match;
  while ((match = timeRegex.exec(textOnly)) !== null) {
    const full = match[1] + match[2];
    if (seen.has(full)) continue;
    seen.add(full);

    // Get surrounding context (next 80 chars) for course/holes info
    const context = textOnly.substring(match.index, match.index + 100);
    const course = context.toLowerCase().includes('front') ? 'Front' : context.toLowerCase().includes('back') ? 'Back' : 'Course';
    const holes = context.includes('18') ? 18 : context.includes('9') ? 9 : 18;
    const displayTime = match[1] + ' ' + match[2];

    slots.push({ time: displayTime, raw: full, course, holes });
  }

  // Also try lowercase am/pm (some contexts)
  if (slots.length === 0) {
    const timeRegex2 = /\b(\d{1,2}:\d{2})\s*(am|pm)\b/g;
    while ((match = timeRegex2.exec(textOnly)) !== null) {
      const full = match[1] + match[2].toUpperCase();
      if (seen.has(full)) continue;
      seen.add(full);
      const displayTime = match[1] + ' ' + match[2].toUpperCase();
      slots.push({ time: displayTime, raw: full, course: 'Course', holes: 18 });
    }
  }

  return slots;
}

/**
 * Session cache for HTTP approach (avoids re-fetching on each request)
 */
let httpSession = null;
let httpSessionTime = 0;
const HTTP_SESSION_TTL = 20 * 60 * 1000; // 20 minutes

/**
 * Detect page type from HTML body
 */
function detectPageType(html) {
  const lower = html.toLowerCase();
  if (lower.includes('signin') || lower.includes('sign in') || lower.includes('login') || lower.includes('username') || lower.includes('password')) return 'LOGIN';
  if (lower.includes('no times available')) return 'NO_TIMES';
  if (lower.includes('am') || lower.includes('pm')) return 'SHEET';
  return 'UNKNOWN';
}

/**
 * Check available tee times via plain HTTP (no Puppeteer/Chromium required)
 * Fetches the public Tee-On tee sheet page for a given date.
 */
async function checkAvailabilityHTTP(date, partySize = 1) {
  const [year, month, day] = date.split('-');
  const teeonDate = `${month}/${day}/${year}`; // MM/DD/YYYY
  // Also try YYYY-MM-DD format some Tee-On servlets accept
  const teeonDateISO = date;

  console.log(`[TeeOn-HTTP] Checking availability for ${date} (party of ${partySize})`);

  try {
    // Step 1: Always get a fresh session by loading the public tee sheet page
    // ComboLanding redirects to WebBookingAllTimesLanding — follow full redirect chain
    // so we land on the actual tee sheet page (today's by default) with a live session
    const sessionExpired = !httpSession || (Date.now() - httpSessionTime > HTTP_SESSION_TTL);
    if (sessionExpired) {
      console.log('[TeeOn-HTTP] Getting fresh session via ComboLanding...');
      const landing = await httpsGet(
        `https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.ComboLanding?CourseCode=${COURSE_CODE}&FromCourseWebsite=true`
      );
      httpSession = landing.cookies;
      httpSessionTime = Date.now();
      const pageType = detectPageType(landing.body);
      console.log(`[TeeOn-HTTP] Session established | FinalURL: ${landing.finalUrl} | PageType: ${pageType}`);
      console.log(`[TeeOn-HTTP] Body preview: ${landing.body.substring(0, 300).replace(/\s+/g, ' ')}`);
    }

    const cookieHeader = httpSession ? { Cookie: httpSession } : {};

    // Step 2: GET the tee sheet directly with SelectedDate in query string
    // Tee-On public pages accept SelectedDate as a URL parameter
    console.log(`[TeeOn-HTTP] Fetching tee sheet for ${teeonDate}...`);
    const getResult = await httpsGet(
      `${PUBLIC_SHEET_BASE}?CourseCode=${COURSE_CODE}&CourseGroupID=${COURSE_GROUP_ID}&SelectedDate=${encodeURIComponent(teeonDate)}&NumberOfPlayers=${partySize}&LoginType=`,
      cookieHeader
    );

    const pageType1 = detectPageType(getResult.body);
    console.log(`[TeeOn-HTTP] GET result | Status: ${getResult.status} | PageType: ${pageType1}`);
    console.log(`[TeeOn-HTTP] Body preview: ${getResult.body.substring(0, 400).replace(/\s+/g, ' ')}`);

    let slots = parseTimesFromHTML(getResult.body);

    // Step 3: If GET didn't work, try POST (some Tee-On versions prefer POST)
    if (slots.length === 0 && pageType1 !== 'NO_TIMES') {
      console.log('[TeeOn-HTTP] GET returned no times, trying POST...');
      const postResult = await httpsPost(
        `${PUBLIC_SHEET_BASE}?CourseCode=${COURSE_CODE}`,
        {
          CourseCode: COURSE_CODE,
          CourseGroupID: COURSE_GROUP_ID,
          SelectedDate: teeonDate,
          NumberOfPlayers: String(partySize),
          Referrer: '',
          LoginType: ''
        },
        { ...cookieHeader, 'Referer': `https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingAllTimesLanding?CourseCode=${COURSE_CODE}` }
      );

      const pageType2 = detectPageType(postResult.body);
      console.log(`[TeeOn-HTTP] POST result | Status: ${postResult.status} | PageType: ${pageType2}`);
      console.log(`[TeeOn-HTTP] POST body preview: ${postResult.body.substring(0, 400).replace(/\s+/g, ' ')}`);
      slots = parseTimesFromHTML(postResult.body);
    }

    // Step 4: If still nothing, force a fresh session and retry once (session may have expired)
    if (slots.length === 0) {
      const freshPageType = detectPageType(getResult.body);
      if (freshPageType === 'LOGIN') {
        console.log('[TeeOn-HTTP] Got login page — resetting session and retrying...');
        httpSession = null;
        httpSessionTime = 0;
        // Recursive call with fresh session (only once)
        return checkAvailabilityHTTP(date, partySize);
      }
    }

    console.log(`[TeeOn-HTTP] Found ${slots.length} slots for ${date}`);
    return slots;

  } catch (err) {
    console.error('[TeeOn-HTTP] Error:', err.message);
    throw err;
  }
}

// ─── Puppeteer-based availability check (when Chromium is available) ──────────

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.log('[TeeOn] Puppeteer not available — will use HTTP fallback');
}

const TEEON_LOGIN_URL = 'https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.SignInGolferSection?LoginType=-1&GrabFocus=true&FromTeeOn=true';
const TEEON_SHEET_URL = `${PUBLIC_SHEET_BASE}?CourseGroupID=${COURSE_GROUP_ID}&CourseCode=${COURSE_CODE}&LoginType=-1`;

let browser = null;
let lastLoginTime = null;
const SESSION_TTL_MS = 25 * 60 * 1000;

async function getSession() {
  if (!puppeteer) throw new Error('Puppeteer not installed');
  const sessionExpired = !lastLoginTime || (Date.now() - lastLoginTime > SESSION_TTL_MS);
  if (!browser || !browser.connected || sessionExpired) {
    if (browser) { try { await browser.close(); } catch (e) {} }
    console.log('[TeeOn] Launching browser...');
    const fs = require('fs');
    const { execSync } = require('child_process');
    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    if (!executablePath) {
      for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser']) {
        if (fs.existsSync(p)) { executablePath = p; break; }
      }
      if (!executablePath) {
        try { executablePath = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null', { encoding: 'utf8' }).trim() || null; } catch (e) {}
      }
    }
    const opts = {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process','--no-zygote']
    };
    if (executablePath) { opts.executablePath = executablePath; console.log(`[TeeOn] Chrome at: ${executablePath}`); }
    browser = await puppeteer.launch(opts);
    await loginPuppeteer(browser);
    lastLoginTime = Date.now();
  }
  return browser;
}

async function loginPuppeteer(br) {
  const page = await br.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.goto(TEEON_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('altcha-widget', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 6000));
  await page.waitForSelector('input[name="UserName"], input[id="UserName"]', { timeout: 10000 });
  await page.type('input[name="UserName"], input[id="UserName"]', process.env.TEEON_USERNAME);
  await page.type('input[name="Password"], input[id="Password"]', process.env.TEEON_PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    page.click('input[type="submit"], button[type="submit"]')
  ]);
  await page.close();
  console.log('[TeeOn] Logged in via Puppeteer');
}

async function checkAvailabilityPuppeteer(date, partySize = 1) {
  const br = await getSession();
  const page = await br.newPage();
  try {
    const [year, month, day] = date.split('-');
    const url = `${TEEON_SHEET_URL}&SelectedDate=${month}/${day}/${year}&NumberOfPlayers=${partySize}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('[class*="toggle-players-wrapper"]', { timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const result = await page.evaluate(() => {
      const text = document.body.innerText;
      if (text.includes('No times available')) return { noTimes: true, slots: [] };
      const slots = [];
      const seen = new Set();
      const timeRegex = /\b(\d{1,2}:\d{2})(AM|PM)\b/g;
      let match;
      while ((match = timeRegex.exec(text)) !== null) {
        const full = match[1] + match[2];
        if (seen.has(full)) continue;
        seen.add(full);
        const context = text.substring(match.index, match.index + 80);
        const course = context.includes('Front') ? 'Front' : context.includes('Back') ? 'Back' : 'Course';
        const holes = context.includes('18') ? 18 : 9;
        slots.push({ time: match[1] + ' ' + match[2], raw: full, course, holes });
      }
      return { noTimes: false, slots };
    });

    if (result.noTimes) return [];
    return result.slots;
  } finally {
    await page.close();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check available tee times for a date.
 * Tries Puppeteer first (if available), falls back to HTTP.
 */
async function checkAvailability(date, partySize = 1) {
  // Try Puppeteer first if credentials and puppeteer are available
  if (puppeteer && process.env.TEEON_USERNAME && process.env.TEEON_PASSWORD) {
    try {
      console.log('[TeeOn] Trying Puppeteer method...');
      return await checkAvailabilityPuppeteer(date, partySize);
    } catch (err) {
      console.warn('[TeeOn] Puppeteer failed, falling back to HTTP:', err.message);
    }
  }

  // HTTP fallback — always available, no Chromium needed
  return await checkAvailabilityHTTP(date, partySize);
}

function isAvailable() {
  // Always available now — HTTP fallback doesn't need Puppeteer
  return true;
}

async function closeBrowser() {
  if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
}

module.exports = { checkAvailability, closeBrowser, isAvailable };
