/**
 * Tee-On Golf Systems - Availability Checker
 *
 * Two-tier approach:
 *  1. HTTP-based (primary): POSTs to the public tee sheet with the correct `Date`
 *     parameter — no login, no Chromium needed. The changeDate() JS function on the
 *     Tee-On page submits: { Date: 'YYYY-MM-DD', CourseCode: 'COLU', CourseGroupID: '12' }
 *  2. Puppeteer (secondary): navigates the public tee sheet and calls changeDate()
 *     directly — no login required, no ALTCHA to deal with.
 *
 * Course: Valleymede Columbus Golf Club
 *   Public CourseCode = COLU
 *   Public CourseGroupID = 12  (NOT the admin/login 11242)
 */

const https = require('https');
const http = require('http');

const PUBLIC_SHEET_BASE = 'https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingAllTimesLanding';
const COURSE_CODE = 'COLU';
const COURSE_GROUP_ID = '12'; // Public tee sheet group ID (from changeDate() source)

// ─── HTTPS helpers ────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-CA,en;q=0.9',
        ...headers
      }
    }, (res) => {
      if ([301, 302, 303].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        const setCookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        const mergedCookies = [headers.Cookie || '', setCookies].filter(Boolean).join('; ');
        return resolve(httpsGet(redirectUrl, { ...headers, Cookie: mergedCookies }, redirectCount + 1));
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP GET timed out')); });
  });
}

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
      if ([301, 302, 303].includes(res.statusCode) && res.headers.location) {
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

// ─── HTML parser ──────────────────────────────────────────────────────────────

function detectPageType(html) {
  const lower = html.toLowerCase();
  // Check for actual tee time slot boxes first — they're the real indicator
  if (lower.includes('search-results-tee-times-box') && !lower.includes('search-results-tee-times-box message-cell')) {
    // Page has slot boxes — check if any are real time slots (not just the message box)
    if (/class="time"/.test(html)) return 'SHEET';
  }
  // The "no times available" div is ALWAYS in the HTML (hidden with display:none)
  // Only treat as NO_TIMES if there are zero actual slot boxes
  if (lower.includes('signin') || lower.includes('sign in') || lower.includes('username') || lower.includes('password')) return 'LOGIN';
  // Check for time patterns in the structured slot format: <p class="time">7:30<span class="am-pm">am</span>
  if (/class="time"/.test(html)) return 'SHEET';
  // Fallback: check stripped text for time patterns
  const textOnly = html.replace(/<[^>]+>/g, ' ');
  if (/\d{1,2}:\d{2}\s*(am|pm)/i.test(textOnly)) return 'SHEET';
  return 'NO_TIMES';
}

function parseTimesFromHTML(html) {
  const slots = [];
  const seen = new Set();

  // PRIMARY: Parse structured Tee-On slot boxes
  // Format: <div class="search-results-tee-times-box nine-holes COLU-box" id="COLUB2026-04-19-07.30.00.0009">
  //           <p class="time">7:30<span class="am-pm">am</span></p>
  //           <p class="nine">Back</p>  or  <p class="eighteen">Front</p>
  //           <p class="price">$45.00</p>
  //           ...players-allowed... 2 - 4 Players ...booking-holes... 9 Holes
  const boxRegex = /<div\s+class="search-results-tee-times-box[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div\s+class="search-results-tee-times-box|<div\s+class="specials-or-search-box|<\/div>)/gi;
  // Simpler approach: extract each slot's key data with targeted regexes
  const timeBlockRegex = /<p\s+class="time">\s*(\d{1,2}:\d{2})\s*<span\s+class="am-pm">(am|pm)<\/span>\s*<\/p>/gi;
  const fullHtml = html;
  let match;

  while ((match = timeBlockRegex.exec(fullHtml)) !== null) {
    const timeNum = match[1];
    const ampm = match[2].toUpperCase();
    const full = timeNum + ampm;
    if (seen.has(full)) continue;
    seen.add(full);

    // Look at surrounding context (500 chars after the match) for course/holes/price/players
    const context = fullHtml.substring(match.index, match.index + 600);

    // Tee-On labeling for Valleymede Columbus:
    //   "Front" + eighteen-holes class = 18 holes, starts on hole 1
    //   "Back"  + nine-holes class     = 9 holes only, starts on hole 10 (back nine)
    const isNineHoles = /nine-holes/i.test(context);
    const isEighteenHoles = /eighteen-holes/i.test(context);
    const holes = isNineHoles ? 9 : 18;
    const course = (isEighteenHoles || (!isNineHoles && /Front/i.test(context)))
      ? '18 holes (starts hole 1)'
      : isNineHoles
        ? '9 holes only (starts hole 10)'
        : 'Course';
    const priceMatch = context.match(/class="price"[^>]*>\s*\$?([\d.]+)/i);
    const price = priceMatch ? '$' + priceMatch[1] : null;
    // Parse available player spots — critical for filtering by party size
    // Formats: "2 - 4 Players" (range), "1 Player" (single spot), "1 - 2 Players"
    const playersRangeMatch = context.match(/([\d]+)\s*-\s*([\d]+)\s*Players/i);
    const playersSingleMatch = !playersRangeMatch && context.match(/(\d+)\s*Player(?:s)?/i);
    const minPlayers = playersRangeMatch ? parseInt(playersRangeMatch[1]) :
                       playersSingleMatch ? parseInt(playersSingleMatch[1]) : 1;
    const maxPlayers = playersRangeMatch ? parseInt(playersRangeMatch[2]) :
                       playersSingleMatch ? parseInt(playersSingleMatch[1]) : 4;

    slots.push({
      time: timeNum + ' ' + ampm,
      raw: full,
      course,
      holes,
      price,
      minPlayers,
      maxPlayers
    });
  }

  // FALLBACK: If structured parse found nothing, try text-based extraction
  if (slots.length === 0) {
    const textOnly = html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
    const fallbackRegex = /\b(\d{1,2}:\d{2})\s*(AM|PM|am|pm)\b/g;
    while ((match = fallbackRegex.exec(textOnly)) !== null) {
      const full = match[1] + match[2].toUpperCase();
      if (seen.has(full)) continue;
      seen.add(full);
      const ctx = textOnly.substring(match.index, match.index + 100);
      const course = /front/i.test(ctx) ? 'Front' : /back/i.test(ctx) ? 'Back' : 'Course';
      const holes = /\b18\b/.test(ctx) ? 18 : /\b9\b/.test(ctx) ? 9 : 18;
      slots.push({ time: match[1] + ' ' + match[2].toUpperCase(), raw: full, course, holes });
    }
  }

  console.log(`[TeeOn-Parser] Parsed ${slots.length} slots from HTML`);
  return slots;
}

// ─── HTTP-based availability check ───────────────────────────────────────────

let httpSession = null;
let httpSessionTime = 0;
const HTTP_SESSION_TTL = 5 * 60 * 1000; // Refresh session every 5 min for fresh tee sheet data

async function checkAvailabilityHTTP(date, partySize = 1, retryCount = 0) {
  console.log(`[TeeOn-HTTP] Checking availability for ${date} (party of ${partySize})${retryCount > 0 ? ' [RETRY ' + retryCount + ']' : ''}`);

  try {
    // Step 1: Always get a fresh session for each check to ensure live data
    // (sessions can go stale quickly on Tee-On)
    const sessionExpired = !httpSession || (Date.now() - httpSessionTime > HTTP_SESSION_TTL);
    if (sessionExpired || retryCount > 0) {
      console.log('[TeeOn-HTTP] Getting fresh session...');
      const landing = await httpsGet(
        `${PUBLIC_SHEET_BASE}?CourseCode=${COURSE_CODE}&CourseGroupID=${COURSE_GROUP_ID}&Referrer=`
      );
      httpSession = landing.cookies;
      httpSessionTime = Date.now();
      const pt = detectPageType(landing.body);
      console.log(`[TeeOn-HTTP] Session established | Type: ${pt} | Cookies: ${httpSession ? 'yes' : 'none'}`);
    }

    const cookieHeader = httpSession ? { Cookie: httpSession } : {};
    const referer = `${PUBLIC_SHEET_BASE}?CourseCode=${COURSE_CODE}&CourseGroupID=${COURSE_GROUP_ID}&Referrer=`;

    // Step 2: POST with Date=YYYY-MM-DD (exactly what changeDate() does on the page)
    console.log(`[TeeOn-HTTP] POST with Date=${date}...`);
    const postResult = await httpsPost(
      `${PUBLIC_SHEET_BASE}?CourseCode=${COURSE_CODE}&Referrer=`,
      {
        Date: date,
        CourseCode: COURSE_CODE,
        CourseGroupID: COURSE_GROUP_ID
      },
      { ...cookieHeader, Referer: referer }
    );

    // Merge any new cookies from the POST response
    if (postResult.cookies) {
      httpSession = [httpSession, postResult.cookies].filter(Boolean).join('; ');
    }

    const pageType = detectPageType(postResult.body);
    console.log(`[TeeOn-HTTP] POST result | Status: ${postResult.status} | Type: ${pageType}`);

    let slots = parseTimesFromHTML(postResult.body);

    // If POST returned a login page or unknown, try GET as fallback
    if (slots.length === 0 && pageType !== 'SHEET') {
      console.log(`[TeeOn-HTTP] POST had no slots (${pageType}), trying GET...`);
      const getResult = await httpsGet(
        `${PUBLIC_SHEET_BASE}?CourseCode=${COURSE_CODE}&CourseGroupID=${COURSE_GROUP_ID}&Date=${encodeURIComponent(date)}&Referrer=`,
        { ...cookieHeader, Referer: referer }
      );
      const pt2 = detectPageType(getResult.body);
      console.log(`[TeeOn-HTTP] GET result | Status: ${getResult.status} | Type: ${pt2}`);
      slots = parseTimesFromHTML(getResult.body);

      // If we got a login page, reset session and retry once
      if ((pt2 === 'LOGIN' || pageType === 'LOGIN') && retryCount === 0) {
        console.log('[TeeOn-HTTP] Got login page — resetting session and retrying...');
        httpSession = null;
        httpSessionTime = 0;
        return checkAvailabilityHTTP(date, partySize, retryCount + 1);
      }
    }

    console.log(`[TeeOn-HTTP] Found ${slots.length} slots for ${date}`);
    return slots;

  } catch (err) {
    console.error('[TeeOn-HTTP] Error:', err.message);
    // On error, reset session so next call gets fresh state
    httpSession = null;
    httpSessionTime = 0;
    throw err;
  }
}

// ─── Puppeteer-based availability check ──────────────────────────────────────
// No login required — uses the public tee sheet and calls changeDate() directly

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.log('[TeeOn] Puppeteer not available — will use HTTP fallback');
}

let browser = null;
let browserLaunchTime = null;
const BROWSER_TTL_MS = 30 * 60 * 1000; // Reuse browser for 30 min

function getLaunchOpts() {
  const fs = require('fs');
  const { execSync } = require('child_process');
  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  if (!executablePath) {
    for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
      if (fs.existsSync(p)) { executablePath = p; break; }
    }
    if (!executablePath) {
      try { executablePath = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null', { encoding: 'utf8' }).trim() || null; } catch (e) {}
    }
  }
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--single-process', '--no-zygote']
  };
  if (executablePath) {
    opts.executablePath = executablePath;
    console.log(`[TeeOn] Chrome at: ${executablePath}`);
  }
  return opts;
}

async function getBrowser() {
  const stale = !browserLaunchTime || (Date.now() - browserLaunchTime > BROWSER_TTL_MS);
  if (!browser || !browser.connected || stale) {
    if (browser) { try { await browser.close(); } catch (e) {} }
    console.log('[TeeOn] Launching browser...');
    browser = await puppeteer.launch(getLaunchOpts());
    browserLaunchTime = Date.now();
  }
  return browser;
}

async function checkAvailabilityPuppeteer(date, partySize = 1) {
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    // Navigate to the public tee sheet (no login required)
    const publicUrl = `${PUBLIC_SHEET_BASE}?CourseCode=${COURSE_CODE}&CourseGroupID=${COURSE_GROUP_ID}&Referrer=`;
    console.log(`[TeeOn-Puppeteer] Loading public tee sheet...`);
    await page.goto(publicUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Use changeDate() exactly as the page's date-navigation arrows do
    // This submits the form with Date=YYYY-MM-DD, CourseCode, CourseGroupID
    console.log(`[TeeOn-Puppeteer] Calling changeDate('${date}')...`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.evaluate((d) => changeDate(d), date)
    ]);

    // Wait briefly for any lazy rendering
    await new Promise(r => setTimeout(r, 1000));

    const result = await page.evaluate(() => {
      const text = document.body.innerText || '';
      if (/no times available/i.test(text)) return { noTimes: true, slots: [] };
      const slots = [];
      const seen = new Set();
      const re = /\b(\d{1,2}:\d{2})(AM|PM)\b/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const full = m[1] + m[2];
        if (seen.has(full)) continue;
        seen.add(full);
        const ctx = text.substring(m.index, m.index + 80);
        const course = /Front/i.test(ctx) ? 'Front' : /Back/i.test(ctx) ? 'Back' : 'Course';
        const holes = /\b18\b/.test(ctx) ? 18 : 9;
        slots.push({ time: m[1] + ' ' + m[2], raw: full, course, holes });
      }
      return { noTimes: false, slots };
    });

    console.log(`[TeeOn-Puppeteer] Found ${result.slots.length} slots for ${date}`);
    if (result.noTimes) return [];
    return result.slots;
  } finally {
    await page.close();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function checkAvailability(date, partySize = 1) {
  // Try Puppeteer first (if available) — uses public page, no login/ALTCHA
  if (puppeteer) {
    try {
      console.log('[TeeOn] Trying Puppeteer method (public page, no login)...');
      return await checkAvailabilityPuppeteer(date, partySize);
    } catch (err) {
      console.warn('[TeeOn] Puppeteer failed, falling back to HTTP:', err.message);
      // Reset browser so next call gets a fresh one
      if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
    }
  }

  return await checkAvailabilityHTTP(date, partySize);
}

function isAvailable() {
  return true; // Always try — HTTP fallback works without any dependencies
}

async function closeBrowser() {
  if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
}

module.exports = { checkAvailability, closeBrowser, isAvailable };
