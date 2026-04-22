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

// ─── Tee time cache ──────────────────────────────────────────────────────────
// Tee-On rate-limits repeated requests (returns content-length:0 after too many).
// Cache results per date to avoid hammering their server.
const teeTimeCache = new Map(); // key: 'YYYY-MM-DD', value: { slots, timestamp }
const CACHE_TTL = 10 * 60 * 1000; // 10 min cache — tee times don't change that fast
const MIN_REQUEST_INTERVAL = 3000; // At least 3s between requests to Tee-On
let lastRequestTime = 0;

function getCachedSlots(date) {
  const cached = teeTimeCache.get(date);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log(`[TeeOn-Cache] HIT for ${date} (${Math.round((Date.now() - cached.timestamp) / 1000)}s old, ${cached.slots.length} slots)`);
    return cached.slots;
  }
  return null;
}

function setCachedSlots(date, slots) {
  // Only cache if we got actual results (don't cache empty rate-limited responses)
  if (slots.length > 0) {
    teeTimeCache.set(date, { slots, timestamp: Date.now() });
    console.log(`[TeeOn-Cache] STORED ${slots.length} slots for ${date}`);
  }
  // Clean old entries
  for (const [key, val] of teeTimeCache) {
    if (Date.now() - val.timestamp > CACHE_TTL * 3) teeTimeCache.delete(key);
  }
}

async function throttledWait() {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    const wait = MIN_REQUEST_INTERVAL - elapsed;
    console.log(`[TeeOn] Throttling ${wait}ms to avoid rate limit`);
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}

// ─── HTTP-based availability check ───────────────────────────────────────────

let httpSession = null;
let httpSessionTime = 0;
const HTTP_SESSION_TTL = 10 * 60 * 1000; // Reuse session for 10 min (was 5 — reduce requests)

async function checkAvailabilityHTTP(date, partySize = 1, retryCount = 0) {
  console.log(`[TeeOn-HTTP] Checking availability for ${date} (party of ${partySize})${retryCount > 0 ? ' [RETRY ' + retryCount + ']' : ''}`);

  try {
    // Step 1: Get or reuse session
    const sessionExpired = !httpSession || (Date.now() - httpSessionTime > HTTP_SESSION_TTL);
    if (sessionExpired || retryCount > 0) {
      await throttledWait();
      console.log('[TeeOn-HTTP] Getting fresh session...');
      const landing = await httpsGet(
        `${PUBLIC_SHEET_BASE}?CourseCode=${COURSE_CODE}&CourseGroupID=${COURSE_GROUP_ID}&Referrer=`
      );
      httpSession = landing.cookies;
      httpSessionTime = Date.now();

      // The landing page shows TODAY's tee times — parse and cache them
      if (landing.body && landing.body.length > 1000) {
        const pt = detectPageType(landing.body);
        console.log(`[TeeOn-HTTP] Session established | Type: ${pt} | Cookies: ${httpSession ? 'yes' : 'none'} | Body: ${landing.body.length} chars`);
        const todayStr = new Date().toISOString().split('T')[0];
        const landingSlots = parseTimesFromHTML(landing.body);
        if (landingSlots.length > 0) {
          setCachedSlots(todayStr, landingSlots);
          // If the requested date is today, we already have the answer
          if (date === todayStr) {
            console.log(`[TeeOn-HTTP] Landing page had today's times — using directly (${landingSlots.length} slots)`);
            return landingSlots;
          }
        }
      } else {
        console.log(`[TeeOn-HTTP] Session response was empty/short (${landing.body?.length || 0} chars) — possible rate limit`);
        // If we got rate-limited on the session request, return cached or empty
        if (landing.body?.length === 0) {
          const cached = getCachedSlots(date);
          if (cached) return cached;
          throw new Error('Tee-On returned empty response (rate limited). Try again in a few minutes.');
        }
      }
    }

    const cookieHeader = httpSession ? { Cookie: httpSession } : {};
    const referer = `${PUBLIC_SHEET_BASE}?CourseCode=${COURSE_CODE}&CourseGroupID=${COURSE_GROUP_ID}&Referrer=`;

    // Step 2: POST with Date=YYYY-MM-DD (exactly what changeDate() does on the page)
    await throttledWait();
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

    // Detect empty/rate-limited response
    if (!postResult.body || postResult.body.length < 500) {
      console.log(`[TeeOn-HTTP] POST returned short/empty response (${postResult.body?.length || 0} chars) — likely rate-limited`);
      const cached = getCachedSlots(date);
      if (cached) return cached;
      // Reset session so next try gets fresh one
      httpSession = null;
      httpSessionTime = 0;
      return [];
    }

    const pageType = detectPageType(postResult.body);
    const hasTimeClass = /class="time"/.test(postResult.body);
    const hasSlotBox = /search-results-tee-times-box/.test(postResult.body);
    console.log(`[TeeOn-HTTP] POST result | Status: ${postResult.status} | Type: ${pageType} | HTML: ${postResult.body.length} chars | hasTimeClass: ${hasTimeClass} | hasSlotBox: ${hasSlotBox}`);

    let slots = parseTimesFromHTML(postResult.body);

    // If POST returned a login page or unknown, try GET as fallback
    if (slots.length === 0 && pageType !== 'SHEET') {
      console.log(`[TeeOn-HTTP] POST had no slots (${pageType}), trying GET...`);
      await throttledWait();
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

    // Cache successful results
    if (slots.length > 0) {
      setCachedSlots(date, slots);
    }

    console.log(`[TeeOn-HTTP] Found ${slots.length} slots for ${date}`);
    return slots;

  } catch (err) {
    console.error('[TeeOn-HTTP] Error:', err.message);
    // On error, check cache before giving up
    const cached = getCachedSlots(date);
    if (cached) {
      console.log(`[TeeOn-HTTP] Error occurred but returning cached data (${cached.length} slots)`);
      return cached;
    }
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
    console.log(`[TeeOn-Puppeteer] Calling changeDate('${date}')...`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.evaluate((d) => changeDate(d), date)
    ]);

    // Wait briefly for any lazy rendering
    await new Promise(r => setTimeout(r, 1000));

    // Get the raw HTML instead of innerText — use same parser as HTTP path
    const html = await page.content();
    console.log(`[TeeOn-Puppeteer] Got page HTML (${html.length} chars)`);

    const pageType = detectPageType(html);
    console.log(`[TeeOn-Puppeteer] Page type: ${pageType}`);

    if (pageType === 'LOGIN') {
      throw new Error('Got login page — session invalid');
    }

    const slots = parseTimesFromHTML(html);
    console.log(`[TeeOn-Puppeteer] Found ${slots.length} slots for ${date}`);
    return slots;
  } finally {
    await page.close();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function checkAvailability(date, partySize = 1) {
  // Check cache FIRST — avoid hitting Tee-On if we have recent data
  const cached = getCachedSlots(date);
  if (cached) {
    return cached;
  }

  // HTTP-first: it's faster, lighter (no browser), and our HTML parser is battle-tested.
  // Puppeteer is a fallback only — in case Tee-On blocks raw HTTP or requires JS rendering.
  try {
    console.log('[TeeOn] Trying HTTP method (primary)...');
    const httpSlots = await checkAvailabilityHTTP(date, partySize);
    if (httpSlots.length > 0) {
      return httpSlots;
    }
    console.log('[TeeOn] HTTP returned 0 slots — will try Puppeteer fallback if available');
  } catch (err) {
    console.warn('[TeeOn] HTTP method failed:', err.message);
  }

  // Puppeteer fallback — renders the actual page with JS
  if (puppeteer) {
    try {
      console.log('[TeeOn] Trying Puppeteer fallback...');
      const puppeteerSlots = await checkAvailabilityPuppeteer(date, partySize);
      if (puppeteerSlots.length > 0) {
        setCachedSlots(date, puppeteerSlots);
      }
      return puppeteerSlots;
    } catch (err) {
      console.warn('[TeeOn] Puppeteer also failed:', err.message);
      if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
    }
  }

  // Both methods failed — return empty
  console.error('[TeeOn] All methods exhausted — returning empty');
  return [];
}

function isAvailable() {
  return true; // Always try — HTTP fallback works without any dependencies
}

async function closeBrowser() {
  if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
}

module.exports = { checkAvailability, closeBrowser, isAvailable };
