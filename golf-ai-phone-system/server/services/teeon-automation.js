/**
 * Tee-On Golf Systems — Availability Checker (multi-tenant).
 *
 * Each tenant has its own public tee sheet identified by a CourseCode /
 * CourseGroupID pair. Instead of hardcoding Valleymede's codes, callers now
 * pass a `teeOnConfig = { courseCode, courseGroupId }` object. The defaults
 * fall back to Valleymede (COLU / 12) so any caller that hasn't been
 * updated yet still works end-to-end.
 *
 * Cache and HTTP session state are keyed per (courseCode, courseGroupId)
 * so different tenants never share their responses or cookies.
 *
 * Two-tier approach:
 *  1. HTTP-based (primary): POSTs to the public tee sheet — no login,
 *     no Chromium needed.
 *  2. Puppeteer (secondary): navigates the public tee sheet and calls
 *     changeDate() directly — no login required.
 */

const https = require('https');
const http = require('http');

const PUBLIC_SHEET_BASE = 'https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingAllTimesLanding';
// Valleymede defaults — used when a tenant hasn't been configured yet so
// Phase 2 rollout is smooth. Remove once every tenant is provisioned.
const DEFAULT_COURSE_CODE = 'COLU';
const DEFAULT_COURSE_GROUP_ID = '12';

function resolveConfig(cfg) {
  const courseCode = (cfg?.courseCode || DEFAULT_COURSE_CODE).toString();
  const courseGroupId = (cfg?.courseGroupId || DEFAULT_COURSE_GROUP_ID).toString();
  return { courseCode, courseGroupId, key: `${courseCode}:${courseGroupId}` };
}

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
  if (lower.includes('search-results-tee-times-box') && !lower.includes('search-results-tee-times-box message-cell')) {
    if (/class="time"/.test(html)) return 'SHEET';
  }
  if (lower.includes('signin') || lower.includes('sign in') || lower.includes('username') || lower.includes('password')) return 'LOGIN';
  if (/class="time"/.test(html)) return 'SHEET';
  const textOnly = html.replace(/<[^>]+>/g, ' ');
  if (/\d{1,2}:\d{2}\s*(am|pm)/i.test(textOnly)) return 'SHEET';
  return 'NO_TIMES';
}

function parseTimesFromHTML(html) {
  const slots = [];
  const seen = new Set();

  const timeBlockRegex = /<p\s+class="time">\s*(\d{1,2}:\d{2})\s*<span\s+class="am-pm">(am|pm)<\/span>\s*<\/p>/gi;
  const fullHtml = html;
  let match;

  while ((match = timeBlockRegex.exec(fullHtml)) !== null) {
    const timeNum = match[1];
    const ampm = match[2].toUpperCase();
    const full = timeNum + ampm;

    const context = fullHtml.substring(match.index, match.index + 600);

    const isNineHoles = /nine-holes/i.test(context);
    const isEighteenHoles = /eighteen-holes/i.test(context);
    const holes = isNineHoles ? 9 : 18;

    // CRITICAL: dedupe by (time, ampm, holes) — NOT just (time, ampm).
    // Tee-On lists the SAME minute twice when both 18-hole and 9-hole
    // products are available (e.g. 4:46 PM 18-hole AND 4:46 PM 9-hole
    // back-nine). The previous version of this loop deduped by
    // time+ampm only, silently dropping half the inventory and causing
    // the AI to wrongly tell callers "no slots available" when in fact
    // matching slots existed on the other product. Real customer was
    // told "no full slots for four players after 4 PM" when 4:46-5:58
    // 18-hole all had 4 open seats.
    const dedupeKey = full + '|' + holes;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const course = (isEighteenHoles || (!isNineHoles && /Front/i.test(context)))
      ? '18 holes (starts hole 1)'
      : isNineHoles
        ? '9 holes only (starts hole 10)'
        : 'Course';
    const priceMatch = context.match(/class="price"[^>]*>\s*\$?([\d.]+)/i);
    const price = priceMatch ? '$' + priceMatch[1] : null;
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

// ─── Per-tenant cache & session state ────────────────────────────────────────
// Keyed by `${courseCode}:${courseGroupId}` so two tenants never share cookies
// or cached slot lists.

const teeTimeCache = new Map(); // cfgKey → Map<date, { slots, timestamp }>
// Two-tier cache TTL:
//   - "fresh" — return cached data confidently as if just queried
//   - "stale" — return cached data when a fresh Tee-On query fails;
//     better to give the caller a slightly-old answer than silence.
// Today's slots change fastest (real bookings filling up), so keep the
// fresh window short. Future dates change much more slowly, so we let
// them ride longer to dramatically cut Tee-On API hits during busy
// hours.
const CACHE_TTL_TODAY_FRESH  =  3 * 60 * 1000;  //  3 min — today, served as live
const CACHE_TTL_FUTURE_FRESH = 20 * 60 * 1000;  // 20 min — future dates, slower-changing
const CACHE_TTL_STALE_FALLBACK = 30 * 60 * 1000; // 30 min — used only when Tee-On goes empty

const MIN_REQUEST_INTERVAL = 3000;
const lastRequestTime = new Map(); // cfgKey → timestamp

function isToday(date) {
  // Compare the requested date against today in the server's local
  // tz. Tee-On treats dates as plain YYYY-MM-DD strings, so this is
  // fine for our purposes (a few hours of TZ skew at midnight either
  // way doesn't matter — the cache distinction is "today vs not".)
  if (!date) return false;
  const today = new Date().toISOString().split('T')[0];
  return date === today;
}

function cacheFor(cfgKey) {
  if (!teeTimeCache.has(cfgKey)) teeTimeCache.set(cfgKey, new Map());
  return teeTimeCache.get(cfgKey);
}

// Return the cached entry if it's within the FRESH window for that
// date type (today vs future). Returns null if nothing cached or if
// the cache is too old to be considered fresh. Does NOT return stale
// entries — those go through getStaleSlotsFallback() below.
function getCachedSlots(cfgKey, date) {
  const c = cacheFor(cfgKey);
  const cached = c.get(date);
  if (!cached) return null;
  const age = Date.now() - cached.timestamp;
  const ttl = isToday(date) ? CACHE_TTL_TODAY_FRESH : CACHE_TTL_FUTURE_FRESH;
  if (age < ttl) {
    console.log(`[TeeOn-Cache] HIT (fresh) for ${cfgKey}/${date} (${Math.round(age / 1000)}s old, ${cached.slots.length} slots)`);
    return cached.slots;
  }
  return null;
}

// Stale-cache fallback — only consulted when a fresh Tee-On query
// returned empty/failed AND we have data from up to STALE_FALLBACK
// minutes ago. Returning a slightly-old answer beats telling the
// caller "nothing available" when Tee-On is rate-limiting us.
function getStaleSlotsFallback(cfgKey, date) {
  const c = cacheFor(cfgKey);
  const cached = c.get(date);
  if (!cached) return null;
  const age = Date.now() - cached.timestamp;
  if (age < CACHE_TTL_STALE_FALLBACK && cached.slots.length > 0) {
    console.log(
      `[TeeOn-Cache] STALE FALLBACK for ${cfgKey}/${date} ` +
      `(${Math.round(age / 1000)}s old, ${cached.slots.length} slots). ` +
      `Using because fresh query returned empty.`
    );
    return cached.slots;
  }
  return null;
}

function setCachedSlots(cfgKey, date, slots) {
  const c = cacheFor(cfgKey);
  if (slots.length > 0) {
    c.set(date, { slots, timestamp: Date.now() });
    console.log(`[TeeOn-Cache] STORED ${slots.length} slots for ${cfgKey}/${date}`);
  }
  // Garbage-collect entries older than the longest TTL we use.
  for (const [key, val] of c) {
    if (Date.now() - val.timestamp > CACHE_TTL_STALE_FALLBACK * 2) c.delete(key);
  }
}

async function throttledWait(cfgKey) {
  const prev = lastRequestTime.get(cfgKey) || 0;
  const elapsed = Date.now() - prev;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    const wait = MIN_REQUEST_INTERVAL - elapsed;
    console.log(`[TeeOn] Throttling ${wait}ms for ${cfgKey}`);
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime.set(cfgKey, Date.now());
}

// ─── HTTP-based availability check ───────────────────────────────────────────

const httpSessions = new Map(); // cfgKey → { cookies, time }
const HTTP_SESSION_TTL = 10 * 60 * 1000;

async function checkAvailabilityHTTP(date, partySize, cfg, retryCount = 0) {
  const { courseCode, courseGroupId, key: cfgKey } = cfg;
  console.log(`[TeeOn-HTTP:${cfgKey}] Checking availability for ${date} (party of ${partySize})${retryCount > 0 ? ' [RETRY ' + retryCount + ']' : ''}`);

  try {
    let session = httpSessions.get(cfgKey);
    const sessionExpired = !session || (Date.now() - session.time > HTTP_SESSION_TTL);

    if (sessionExpired || retryCount > 0) {
      await throttledWait(cfgKey);
      console.log(`[TeeOn-HTTP:${cfgKey}] Getting fresh session...`);
      const landing = await httpsGet(
        `${PUBLIC_SHEET_BASE}?CourseCode=${courseCode}&CourseGroupID=${courseGroupId}&Referrer=`
      );
      session = { cookies: landing.cookies, time: Date.now() };
      httpSessions.set(cfgKey, session);

      if (landing.body && landing.body.length > 1000) {
        const pt = detectPageType(landing.body);
        console.log(`[TeeOn-HTTP:${cfgKey}] Session established | Type: ${pt} | Body: ${landing.body.length} chars`);
        const todayStr = new Date().toISOString().split('T')[0];
        const landingSlots = parseTimesFromHTML(landing.body);
        if (landingSlots.length > 0) {
          setCachedSlots(cfgKey, todayStr, landingSlots);
          if (date === todayStr) {
            console.log(`[TeeOn-HTTP:${cfgKey}] Landing page had today's times — using directly (${landingSlots.length} slots)`);
            return landingSlots;
          }
        }
      } else {
        console.log(`[TeeOn-HTTP:${cfgKey}] Session response empty/short (${landing.body?.length || 0} chars) — possible rate limit`);
        if (landing.body?.length === 0) {
          const cached = getCachedSlots(cfgKey, date);
          if (cached) return cached;
          throw new Error('Tee-On returned empty response (rate limited). Try again in a few minutes.');
        }
      }
    }

    const cookieHeader = session?.cookies ? { Cookie: session.cookies } : {};
    const referer = `${PUBLIC_SHEET_BASE}?CourseCode=${courseCode}&CourseGroupID=${courseGroupId}&Referrer=`;

    await throttledWait(cfgKey);
    console.log(`[TeeOn-HTTP:${cfgKey}] POST with Date=${date}...`);
    const postResult = await httpsPost(
      `${PUBLIC_SHEET_BASE}?CourseCode=${courseCode}&Referrer=`,
      {
        Date: date,
        CourseCode: courseCode,
        CourseGroupID: courseGroupId
      },
      { ...cookieHeader, Referer: referer }
    );

    if (postResult.cookies) {
      session.cookies = [session.cookies, postResult.cookies].filter(Boolean).join('; ');
      httpSessions.set(cfgKey, session);
    }

    if (!postResult.body || postResult.body.length < 500) {
      console.log(`[TeeOn-HTTP:${cfgKey}] POST returned short/empty response (${postResult.body?.length || 0} chars) — likely rate-limited`);
      const cached = getCachedSlots(cfgKey, date);
      if (cached) return cached;
      httpSessions.delete(cfgKey);
      return [];
    }

    const pageType = detectPageType(postResult.body);
    const hasTimeClass = /class="time"/.test(postResult.body);
    const hasSlotBox = /search-results-tee-times-box/.test(postResult.body);
    console.log(`[TeeOn-HTTP:${cfgKey}] POST result | Status: ${postResult.status} | Type: ${pageType} | HTML: ${postResult.body.length} chars | hasTimeClass: ${hasTimeClass} | hasSlotBox: ${hasSlotBox}`);

    let slots = parseTimesFromHTML(postResult.body);

    if (slots.length === 0 && pageType !== 'SHEET') {
      console.log(`[TeeOn-HTTP:${cfgKey}] POST had no slots (${pageType}), trying GET...`);
      await throttledWait(cfgKey);
      const getResult = await httpsGet(
        `${PUBLIC_SHEET_BASE}?CourseCode=${courseCode}&CourseGroupID=${courseGroupId}&Date=${encodeURIComponent(date)}&Referrer=`,
        { ...cookieHeader, Referer: referer }
      );
      const pt2 = detectPageType(getResult.body);
      console.log(`[TeeOn-HTTP:${cfgKey}] GET result | Status: ${getResult.status} | Type: ${pt2}`);
      slots = parseTimesFromHTML(getResult.body);

      if ((pt2 === 'LOGIN' || pageType === 'LOGIN') && retryCount === 0) {
        console.log(`[TeeOn-HTTP:${cfgKey}] Got login page — resetting session and retrying...`);
        httpSessions.delete(cfgKey);
        return checkAvailabilityHTTP(date, partySize, cfg, retryCount + 1);
      }
    }

    if (slots.length > 0) {
      setCachedSlots(cfgKey, date, slots);
    }

    console.log(`[TeeOn-HTTP:${cfgKey}] Found ${slots.length} slots for ${date}`);
    return slots;

  } catch (err) {
    console.error(`[TeeOn-HTTP:${cfgKey}] Error:`, err.message);
    const cached = getCachedSlots(cfgKey, date);
    if (cached) {
      console.log(`[TeeOn-HTTP:${cfgKey}] Error occurred but returning cached data (${cached.length} slots)`);
      return cached;
    }
    httpSessions.delete(cfgKey);
    throw err;
  }
}

// ─── Puppeteer-based availability check ──────────────────────────────────────

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.log('[TeeOn] Puppeteer not available — will use HTTP fallback');
}

let browser = null;
let browserLaunchTime = null;
const BROWSER_TTL_MS = 30 * 60 * 1000;

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

async function checkAvailabilityPuppeteer(date, partySize, cfg) {
  const { courseCode, courseGroupId, key: cfgKey } = cfg;
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    const publicUrl = `${PUBLIC_SHEET_BASE}?CourseCode=${courseCode}&CourseGroupID=${courseGroupId}&Referrer=`;
    console.log(`[TeeOn-Puppeteer:${cfgKey}] Loading public tee sheet...`);
    await page.goto(publicUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    console.log(`[TeeOn-Puppeteer:${cfgKey}] Calling changeDate('${date}')...`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.evaluate((d) => changeDate(d), date)
    ]);

    await new Promise(r => setTimeout(r, 1000));

    const html = await page.content();
    console.log(`[TeeOn-Puppeteer:${cfgKey}] Got page HTML (${html.length} chars)`);

    const pageType = detectPageType(html);
    console.log(`[TeeOn-Puppeteer:${cfgKey}] Page type: ${pageType}`);

    if (pageType === 'LOGIN') {
      throw new Error('Got login page — session invalid');
    }

    const slots = parseTimesFromHTML(html);
    console.log(`[TeeOn-Puppeteer:${cfgKey}] Found ${slots.length} slots for ${date}`);
    return slots;
  } finally {
    await page.close();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check tee time availability for a tenant.
 *
 * @param {string} date YYYY-MM-DD
 * @param {number} partySize
 * @param {object} [teeOnConfig] { courseCode, courseGroupId } — falls back to
 *   Valleymede defaults so existing callers keep working. New callers should
 *   always pass the tenant's config.
 */
async function checkAvailability(date, partySize = 1, teeOnConfig = null) {
  const cfg = resolveConfig(teeOnConfig);

  // Tier 1 — fresh cache hit. Today's data is held for 3 min (real
  // bookings fill up fast); future dates ride 20 min (much steadier).
  // This single optimization absorbs ~80% of customer-traffic queries
  // on busy days because a handful of popular dates dominate.
  const cached = getCachedSlots(cfg.key, date);
  if (cached) {
    return cached;
  }

  // Tier 2 — try Tee-On HTTP. If it returns slots, cache + return.
  // If it returns empty, save that fact and try the other paths
  // before giving up.
  let httpSlots = null;
  try {
    console.log(`[TeeOn:${cfg.key}] Trying HTTP method (primary)...`);
    httpSlots = await checkAvailabilityHTTP(date, partySize, cfg);
    if (httpSlots.length > 0) {
      // checkAvailabilityHTTP already calls setCachedSlots internally.
      return httpSlots;
    }
    console.log(`[TeeOn:${cfg.key}] HTTP returned 0 slots — checking Puppeteer + stale-cache fallback`);
  } catch (err) {
    console.warn(`[TeeOn:${cfg.key}] HTTP method failed:`, err.message);
  }

  // Tier 3 — Puppeteer fallback (if installed). Slower but more
  // resilient against flaky API responses.
  if (puppeteer) {
    try {
      console.log(`[TeeOn:${cfg.key}] Trying Puppeteer fallback...`);
      const puppeteerSlots = await checkAvailabilityPuppeteer(date, partySize, cfg);
      if (puppeteerSlots.length > 0) {
        setCachedSlots(cfg.key, date, puppeteerSlots);
        return puppeteerSlots;
      }
    } catch (err) {
      console.warn(`[TeeOn:${cfg.key}] Puppeteer also failed:`, err.message);
      if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
    }
  }

  // Tier 4 — stale-cache fallback. Tee-On's HTTP endpoint occasionally
  // returns empty pages when rate-limited (a single Railway IP can
  // hit ~5-10 req/min before getting muted). Rather than tell the
  // caller "fully booked" — which would be a lie based on stale data
  // — return the most recent cached slots within 30 min. The grok-
  // voice prompt already explicitly bans "fully booked" wording for
  // empty tool results, so callers get accurate "slightly stale"
  // data with an offer to take a request.
  const stale = getStaleSlotsFallback(cfg.key, date);
  if (stale) {
    return stale;
  }

  console.error(`[TeeOn:${cfg.key}] All methods exhausted (no fresh, no puppeteer, no stale) — returning empty for ${date}`);
  return [];
}

function isAvailable() {
  return true;
}

async function closeBrowser() {
  if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
}

module.exports = { checkAvailability, closeBrowser, isAvailable };
