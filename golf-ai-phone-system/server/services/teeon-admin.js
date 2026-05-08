/**
 * Tee-On admin writes — multi-tenant.
 *
 * Companion to `teeon-automation.js`, which is read-only against the
 * public tee sheet. This module performs AUTHENTICATED actions on
 * Tee-On's admin (proshop) side:
 *
 *   - createBooking(businessId, bookingRequestId)
 *   - cancelBooking(businessId, bookingRequestId)
 *
 * The implementation is INERT until two settings are flipped on for a
 * given tenant. Without these, no Tee-On admin requests are ever made.
 *
 *   settings('teeon_admin_writes_enabled')  default false
 *   settings('teeon_admin_dry_run')         default true (when enabled)
 *
 * With dry-run on, the module logs the POST it would have sent but
 * doesn't fire it. With dry-run off and writes enabled, real writes go
 * through.
 *
 * Architecture:
 *   - Plain Node `https`, no extra deps (matches teeon-automation.js).
 *   - Per-tenant session cookie cached in memory; lazy login on first
 *     use; silent re-login on session expiry.
 *   - Per-tenant request throttle so we never hammer Tee-On.
 *   - Errors do NOT throw past the caller's expectation: this module's
 *     public functions surface errors so booking-manager can decide
 *     whether to roll back the local state transition.
 *
 * Credentials live in Railway env vars per tenant slug:
 *
 *   TEEON_USERNAME_<SLUG_UPPER>
 *   TEEON_PASSWORD_<SLUG_UPPER>
 *
 * (e.g. TEEON_USERNAME_VALLEYMEDE / TEEON_PASSWORD_VALLEYMEDE).
 * Plus a course config in settings:
 *
 *   teeon_course_code      e.g. "COLU"  (defaults to Valleymede's COLU)
 *   teeon_course_group_id  e.g. "12"    (defaults to "12")
 *
 * If credentials are missing for a tenant, every operation returns
 * { ok: false, error: 'no-credentials' } without ever hitting Tee-On.
 */

const https = require('https');
const { URL } = require('url');
const { query, getSetting, getBusinessById } = require('../config/database');

// Tee-On endpoints — kept here as constants so route changes are one-edit.
const TEEON_HOST = 'www.tee-on.com';
// SIGNIN_PATH is the SignIn PAGE (HTML form). It does NOT process credentials.
// Real credential check goes through CHECKSIGN_AJAX_PATH (an AJAX servlet
// invoked by doLogin() on the page). Hitting SIGNIN_PATH directly with a
// credentials body just re-renders the form — silent fail for our purposes.
const SIGNIN_PATH = '/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.SignInGolferSection';
const CHECKSIGN_AJAX_PATH = '/PubGolf/servlet/com.teeon.teesheet.servlets.ajax.CheckSignInCloudAjax';
const TEE_SHEET_PATH = '/PubGolf/servlet/com.teeon.teesheet.servlets.proshop.course.booking.TeeSheetFullScreen';
const PROSHOP_ENTRY_PATH = '/PubGolf/servlet/com.teeon.teesheet.servlets.proshop.course.booking.ProshopPlayerEntry';
const BOOK_TIME_PATH = '/PubGolf/servlet/com.teeon.teesheet.servlets.proshop.course.booking.BookTimeProshop';

// Defaults if a tenant hasn't configured course details yet — Valleymede.
// Existing tenants that haven't been re-provisioned still resolve.
const DEFAULT_COURSE_CODE = 'COLU';
const DEFAULT_COURSE_GROUP_ID = '12';

// Throttling — admin writes are rare so this is mostly insurance.
const MIN_REQUEST_INTERVAL_MS = 1500;

// Per-tenant session cache: businessId -> { cookies, time, slug }
const sessions = new Map();
const SESSION_TTL_MS = 25 * 60 * 1000; // refresh after 25min of inactivity
const lastRequestTime = new Map();

// ─── Generic HTTPS helpers ────────────────────────────────────────────────

function httpsRequest({ method, path, headers = {}, body = null, redirect = true, redirectCount = 0 }) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) return reject(new Error('Too many redirects'));
    const opts = {
      hostname: TEEON_HOST,
      path,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ValleymedeAI/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-CA,en;q=0.9',
        ...headers
      }
    };
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/x-www-form-urlencoded';
    }
    const req = https.request(opts, (res) => {
      const setCookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]);
      const chunks = [];
      if (redirect && [301, 302, 303].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location;
        const nextPath = loc.startsWith('http')
          ? new URL(loc).pathname + (new URL(loc).search || '')
          : loc;
        const mergedCookies = mergeCookieHeaders(headers.Cookie || '', setCookies);
        res.resume();
        return resolve(httpsRequest({
          method: 'GET',
          path: nextPath,
          headers: { ...headers, Cookie: mergedCookies },
          redirect: true,
          redirectCount: redirectCount + 1
        }).then(r => ({ ...r, cookies: mergeCookieArrays(setCookies, r.cookies) })));
      }
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        cookies: setCookies
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Tee-On request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

function mergeCookieHeaders(existingHeader, newCookies) {
  const existing = (existingHeader || '').split(';').map(s => s.trim()).filter(Boolean);
  const map = new Map();
  for (const c of existing) {
    const [k, ...rest] = c.split('=');
    if (k) map.set(k.trim(), rest.join('='));
  }
  for (const c of newCookies || []) {
    const [k, ...rest] = c.split('=');
    if (k) map.set(k.trim(), rest.join('='));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// IMPORTANT: cookie arrays must be CHRONOLOGICAL (earliest first).
// mergeCookieHeaders parses left-to-right and last-write-wins, so the
// most recently set cookie has to be the LAST element of the array
// for last-write-wins to actually pick the freshest value.
//
// Through a redirect chain we receive cookies "outside in" (the
// recursive call returns the final response's cookies first), so we
// have to reverse the order: setCookies (this hop, earlier) goes
// FIRST, r.cookies (later hops) goes AFTER.
function mergeCookieArrays(thisHopFirst, laterHopsAfter) {
  return [...(thisHopFirst || []), ...(laterHopsAfter || [])];
}

function encodeForm(obj) {
  return Object.entries(obj)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : String(v)))
    .join('&');
}

async function throttle(businessId) {
  const prev = lastRequestTime.get(businessId) || 0;
  const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - prev);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime.set(businessId, Date.now());
}

// ─── Per-tenant config & credentials ──────────────────────────────────────

function credsFromEnv(slug) {
  if (!slug) return null;
  const k = String(slug).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const username = process.env[`TEEON_USERNAME_${k}`];
  const password = process.env[`TEEON_PASSWORD_${k}`];
  if (!username || !password) return null;
  return { username, password };
}

async function getTenantTeeOnConfig(businessId) {
  const business = await getBusinessById(businessId);
  if (!business) return null;
  const courseCode = (await getSetting(businessId, 'teeon_course_code')) || DEFAULT_COURSE_CODE;
  const courseGroupId = (await getSetting(businessId, 'teeon_course_group_id')) || DEFAULT_COURSE_GROUP_ID;
  const creds = credsFromEnv(business.slug);
  return { businessId, slug: business.slug, courseCode: String(courseCode), courseGroupId: String(courseGroupId), creds };
}

// ─── Feature flag helpers (the ONLY thing that gates real network IO) ─────

async function isEnabledForBusiness(businessId) {
  const v = await getSetting(businessId, 'teeon_admin_writes_enabled');
  // Stored as JSON via updateSetting → can be true/false/null.
  return v === true;
}

async function isDryRun(businessId) {
  const v = await getSetting(businessId, 'teeon_admin_dry_run');
  // Default-on when the parent flag is on but this one isn't set —
  // the only way to do real writes is to explicitly set false.
  if (v === false) return false;
  return true;
}

// ─── Login + session management ───────────────────────────────────────────

async function login(cfg) {
  if (!cfg.creds) throw new Error('no-credentials');

  // Tee-On's auth is a stateful Java-servlet session: the server only
  // accepts a sign-in POST whose request carries a JSESSIONID it
  // previously issued. POSTing cold (which is what we used to do) gets
  // a 200 OK that LOOKS authenticated — Set-Cookie comes back, body
  // doesn't contain "forgot username" — but those cookies are NOT bound
  // to a logged-in session on the server side. Subsequent GETs to
  // ProshopPlayerEntry get the "your session has timed out" page.
  //
  // Fix: prime the session with a GET to the sign-in URL first, capture
  // its JSESSIONID, then POST the credentials with that cookie attached.
  // This mirrors what a browser does when the user types the URL.

  const signInUrl = SIGNIN_PATH + '?LoginType=-1&GrabFocus=true&FromTeeOn=true';

  // Diagnostic helper: list cookie names only (never values).
  const cookieNames = (header) => (header || '').split(';')
    .map(s => s.split('=')[0].trim()).filter(Boolean).join(',');
  const titleOf = (html) => (html || '').match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '(no title)';

  await throttle(cfg.businessId);
  const primer = await httpsRequest({
    method: 'GET',
    path: signInUrl,
    redirect: true
  });
  let cookieHeader = mergeCookieHeaders('', primer.cookies);
  console.log(
    `[tenant:${cfg.businessId}] [TeeOn-Admin] login primer: ` +
    `status=${primer.status} title="${titleOf(primer.body)}" ` +
    `cookies=[${cookieNames(cookieHeader)}]`
  );

  // Credential check goes through CheckSignInCloudAjax — an AJAX servlet
  // invoked by the page's doLogin() function via jQuery. SignInGolferSection
  // (the page) doesn't process credentials, it only renders the form.
  // Verified by intercepting jQuery.ajax in the live browser: doLogin POSTs
  // exactly Username/Password/SaveSignIn/CourseCode to that AJAX endpoint.
  await throttle(cfg.businessId);
  const body = encodeForm({
    Username: cfg.creds.username,
    Password: cfg.creds.password,
    SaveSignIn: 'false',
    CourseCode: cfg.courseCode
  });
  const res = await httpsRequest({
    method: 'POST',
    path: CHECKSIGN_AJAX_PATH,
    headers: {
      Cookie: cookieHeader,
      Referer: `https://${TEEON_HOST}${signInUrl}`,
      // jQuery sets this for $.ajax — Tee-On may use it to gate the AJAX
      // servlet from non-AJAX callers.
      'X-Requested-With': 'XMLHttpRequest',
      // The AJAX servlet typically returns JSON.
      Accept: 'application/json, text/javascript, */*; q=0.01'
    },
    body,
    redirect: true
  });
  cookieHeader = mergeCookieHeaders(cookieHeader, res.cookies);
  console.log(
    `[tenant:${cfg.businessId}] [TeeOn-Admin] login post: ` +
    `status=${res.status} cookies=[${cookieNames(cookieHeader)}] body=${res.body?.length || 0}b`
  );

  // We don't try to parse CheckSignInCloudAjax's JSON shape — Tee-On's
  // AJAX responses vary per tenant and we got bitten by guessing. The
  // most reliable success signal is "can we now access an admin-only
  // page with this session?" so we do a sanity GET to TeeSheetFullScreen
  // (the proshop tee sheet) and check the response.
  //
  // If we see the proshop grid markup → login worked.
  // If we see the "session has timed out" page → credentials rejected
  //   or session not authenticated.
  await throttle(cfg.businessId);
  const verify = await httpsRequest({
    method: 'GET',
    path: `${TEE_SHEET_PATH}?Default=true`,
    headers: { Cookie: cookieHeader },
    redirect: true
  });
  // Carry any further cookies the verify GET set.
  cookieHeader = mergeCookieHeaders(cookieHeader, verify.cookies);
  const sessionTimedOut =
    /session\s+has\s+tim/i.test(verify.body || '') ||
    /you\s+must\s+be\s+signed\s+in/i.test(verify.body || '') ||
    /not\s+signed\s+in\s+yet/i.test(verify.body || '');
  // Positive signals — proshop tee sheet markers we know exist on the
  // authenticated page (from the original recon).
  const looksLikeTeeSheet =
    /tee-sheet-body/i.test(verify.body || '') ||
    /submitTime\(/i.test(verify.body || '') ||
    /ChangeDate|changeDate/.test(verify.body || '');
  console.log(
    `[tenant:${cfg.businessId}] [TeeOn-Admin] login verify: ` +
    `status=${verify.status} body=${verify.body?.length || 0}b ` +
    `looksLikeTeeSheet=${looksLikeTeeSheet} sessionTimedOut=${sessionTimedOut}`
  );
  if (sessionTimedOut || !looksLikeTeeSheet) {
    throw new Error('login-failed (session not authenticated post-AJAX)');
  }
  return cookieHeader;
}

async function getSession(businessId, { force = false } = {}) {
  const cfg = await getTenantTeeOnConfig(businessId);
  if (!cfg) throw new Error('no-business');
  if (!cfg.creds) throw new Error('no-credentials');

  const cached = sessions.get(businessId);
  const stale = cached && (Date.now() - cached.time > SESSION_TTL_MS);
  if (cached && !stale && !force) {
    return { cookies: cached.cookies, cfg };
  }
  console.log(`[tenant:${businessId}] [TeeOn-Admin] Logging in as ${cfg.creds.username}`);
  const cookies = await login(cfg);
  sessions.set(businessId, { cookies, time: Date.now(), slug: cfg.slug });
  console.log(`[tenant:${businessId}] [TeeOn-Admin] Login OK`);
  return { cookies, cfg };
}

// ─── Booking-form payload builders ────────────────────────────────────────

function timeToHHmm(t) {
  // booking_requests.requested_time is a Postgres TIME — pg returns it
  // as a string "HH:MM:SS". Tee-On wants "HH:mm". Slice safely.
  if (!t) return null;
  const s = String(t).trim();
  if (/^\d{2}:\d{2}/.test(s)) return s.slice(0, 5);
  return null;
}

function holesValue(holes) {
  // booking_requests.holes is INTEGER (9, 18, or NULL). Tee-On's radio
  // wants the literal value. Default to 18 when unknown.
  if (holes === 9 || holes === '9') return '9';
  return '18';
}

function cartsValue(numCarts) {
  // Tee-On has 0 / 1 / 2 / More. We map 3+ to 2 conservatively — booking-
  // manager validates 0..20 already so a freak value is bounded.
  const n = Number(numCarts) || 0;
  if (n <= 0) return '0';
  if (n === 1) return '1';
  return '2';
}

/**
 * Build the form body for BookTimeProshop. `bookerId` is null for new
 * bookings, set to the existing BookerID for edits, and "Delete" flags
 * are set externally for cancellations.
 */
function buildBookingPayload({
  cfg,
  date, time, nine = 'F',
  partySize, holes, numCarts,
  customerName, customerPhone, customerEmail,
  bookerId = null,
  deleteSlots = []
}) {
  const safeName = String(customerName || '').slice(0, 80);
  const safePhone = String(customerPhone || '').slice(0, 20);
  const safeEmail = String(customerEmail || '').slice(0, 80);
  const size = Math.max(1, Math.min(4, Number(partySize) || 1));

  const fields = {
    Date: date,
    Time: time,
    CourseCode: cfg.courseCode,
    Nine: nine,
    Players: String(size),
    Holes: holesValue(holes),
    Carts: cartsValue(numCarts),
    BookerID: bookerId || '',
    BookerIndex: '0',
    NoMemberUpdate: 'false',
    ExtraSlotsReserved: '',
    MultipleSlotSize: '',
    SendDirections: 'false',
    BlockConfirmations: 'true',          // we send confirmation SMS ourselves
    BlockCancellations: 'true',          // we send cancellation SMS ourselves
    IncludePricingInConfirmations: 'false',
    ExcludePricingInConfirmations: 'true',
    CartsAvail: '',
    CartsAvailable: '',
    OtherCartsAvailable: '',
    OtherPartyCarts: '',
    CartsBlockedAnswered: 'false'
  };

  // Slot 0 = primary booker (the caller).
  fields.MemberID0 = '';
  fields.GolferName0 = safeName || 'Guest';
  fields.Phone0 = safePhone;
  fields.Ext0 = '';
  fields.Email0 = safeEmail;
  fields.Cart0 = '';
  fields.Notes0 = '';
  fields.AppendSecureNote0 = '';
  fields.SecureNote0 = '';
  fields.CardNum0 = '';
  fields.CardMonth0 = '';
  fields.CardYear0 = '';
  fields.Paid0 = '';
  fields.NoShow0 = '';
  fields.Holes0 = holesValue(holes);
  fields.SlotBookerID0 = bookerId || '';
  fields.OpenSlot0 = '';
  fields.GreenFee0ItemID = '';
  fields.CartFee0ItemID = '';
  fields.CartFee0Type = '';
  fields.SaveFavourites0 = 'false';
  fields.Delete0 = deleteSlots.includes(0) ? 'on' : '';

  // Slots 1..3 = guests (or empty if outside party size).
  for (let i = 1; i < 4; i++) {
    const occupied = i < size;
    fields[`MemberID${i}`] = '';
    fields[`GolferName${i}`] = occupied ? 'Guest' : '';
    fields[`Phone${i}`] = '';
    fields[`Ext${i}`] = '';
    fields[`Email${i}`] = '';
    fields[`Cart${i}`] = '';
    fields[`Notes${i}`] = '';
    fields[`AppendSecureNote${i}`] = '';
    fields[`SecureNote${i}`] = '';
    fields[`CardNum${i}`] = '';
    fields[`CardMonth${i}`] = '';
    fields[`CardYear${i}`] = '';
    fields[`Paid${i}`] = '';
    fields[`NoShow${i}`] = '';
    fields[`Holes${i}`] = holesValue(holes);
    fields[`SlotBookerID${i}`] = bookerId && occupied ? bookerId : '';
    fields[`OpenSlot${i}`] = '';
    fields[`GreenFee${i}ItemID`] = '';
    fields[`CartFee${i}ItemID`] = '';
    fields[`CartFee${i}Type`] = '';
    fields[`SaveFavourites${i}`] = 'false';
    fields[`Delete${i}`] = deleteSlots.includes(i) ? 'on' : '';
  }

  return fields;
}

// ─── Form-HTML field parser ───────────────────────────────────────────────
//
// Extracts every <input>/<select>/<textarea> inside id="form" so we can
// use the live form's values as the base payload. The submitted POST
// then overrides ONLY the user-driven fields (player names, phones,
// players/holes/carts choice). This preserves all the server-populated
// hidden state (cart inventory, pricing item IDs, etc.) that Tee-On
// expects to round-trip exactly.
function parseFormFields(html) {
  if (!html) return {};
  // Narrow to the booking form. The page also has profileForm + price-form
  // — we want only id="form".
  const formStart = html.search(/<form[^>]*\bid=['"]form['"]/i);
  if (formStart < 0) return {};
  // Find the matching </form>. Forms aren't nested in this app.
  const formEndRel = html.slice(formStart).search(/<\/form>/i);
  const formHtml = formEndRel < 0 ? html.slice(formStart) : html.slice(formStart, formStart + formEndRel);

  const out = {};
  // <input ... name="X" ... value="Y">
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(formHtml)) !== null) {
    const tag = m[0];
    const nm = (tag.match(/\bname=['"]([^'"]+)['"]/i) || [])[1];
    if (!nm) continue;
    const type = ((tag.match(/\btype=['"]([^'"]+)['"]/i) || [])[1] || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'image') continue;
    let v = (tag.match(/\bvalue=['"]([^'"]*)['"]/i) || [])[1] || '';
    if (type === 'checkbox' || type === 'radio') {
      const isChecked = /\bchecked\b/i.test(tag);
      if (!isChecked) continue; // unchecked → not submitted
      // checked checkbox without explicit value → "on"
      if (!v) v = 'on';
    }
    // Already-set entries (multiple radios with same name): keep the
    // checked one; we just continue past unchecked above.
    out[nm] = v;
  }
  // <select name="X">...<option value="Y" selected>...</select>
  const selectRe = /<select\b[^>]*\bname=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(formHtml)) !== null) {
    const nm = m[1];
    const inner = m[2];
    const sel = inner.match(/<option\b[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/i);
    let val = '';
    if (sel) {
      const beforeSel = sel[0];
      val = (beforeSel.match(/\bvalue=['"]([^'"]*)['"]/i) || [])[1];
      if (val === undefined) val = (sel[1] || '').trim();
    } else {
      // Default to first option's value
      const first = inner.match(/<option\b[^>]*>/i);
      if (first) val = (first[0].match(/\bvalue=['"]([^'"]*)['"]/i) || [])[1] || '';
    }
    out[nm] = val || '';
  }
  // <textarea name="X">value</textarea>
  const taRe = /<textarea\b[^>]*\bname=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(formHtml)) !== null) {
    out[m[1]] = m[2] || '';
  }
  return out;
}

// ─── BookerID extraction ──────────────────────────────────────────────────
//
// After a successful create POST, Tee-On redirects back to TeeSheetFullScreen.
// To find the new booking's BookerID we re-fetch the day grid and grep for
// a player tile whose onclick matches the slot we just booked. The HTML
// contains lines like:
//   <div class="player paid clickable party-1" onclick="submitExistingTime('06:54','F','COLU4130',true,2,0);">

function extractBookerIdForSlot(html, time, nine) {
  if (!html) return null;
  // Time on the tee sheet is rendered as "HH:MM" (24h, zero-padded).
  // Build a regex that matches submitExistingTime('06:54','F',<id>,...)
  const re = new RegExp(
    `submitExistingTime\\('${time}','${nine}','([A-Z0-9]+)'`,
    'g'
  );
  const m = re.exec(html);
  return m ? m[1] : null;
}

/**
 * Multi-strategy BookerID extraction. The single-pattern extractor above
 * is brittle: Tee-On's tee sheet uses different markup for booked-vs-empty
 * slots, time strings can vary in format, and the nine indicator (F/B)
 * isn't always what we passed. This walks 3 strategies, returning the
 * first hit + which strategy succeeded so the log shows what worked.
 *
 *   1. exact          — submitExistingTime('HH:MM','<nine>','<id>'...)
 *   2. time-any-nine  — submitExistingTime('HH:MM','<*>','<id>'...)
 *   3. name-proximity — find customer name in HTML, then the nearest
 *                       submitExistingTime within ±1500 chars
 *
 * Returns { bookerId, strategy }. bookerId is null if all strategies
 * fail; strategy is then 'none' (or 'no-html' if input was empty).
 */
function extractBookerIdMultiStrategy(html, { time, nine, customerName }) {
  if (!html) return { bookerId: null, strategy: 'no-html' };

  // 1. Exact match for the slot we just booked.
  const exactRe = new RegExp(
    `submitExistingTime\\('${time}','${nine}','([A-Z0-9]+)'`,
    'i'
  );
  const exact = html.match(exactRe);
  if (exact) return { bookerId: exact[1], strategy: 'exact-time-nine' };

  // 2. Time matches but nine indicator differs (we may have booked F
  //    but Tee-On now reports B for it, or vice versa).
  const timeOnlyRe = new RegExp(
    `submitExistingTime\\('${time}','[A-Z]','([A-Z0-9]+)'`,
    'i'
  );
  const timeOnly = html.match(timeOnlyRe);
  if (timeOnly) return { bookerId: timeOnly[1], strategy: 'time-any-nine' };

  // 3. Customer name proximity: find name, find nearest submitExistingTime.
  if (customerName && customerName.length >= 3) {
    const nameIdx = html.indexOf(customerName);
    if (nameIdx >= 0) {
      // ±1500 chars window around the name. The booker call usually
      // sits in the same row, well within that range.
      const start = Math.max(0, nameIdx - 1500);
      const end = Math.min(html.length, nameIdx + 1500);
      const window = html.slice(start, end);
      const nearby = window.match(/submitExistingTime\('([^']+)','([A-Z])','([A-Z0-9]+)'/i);
      if (nearby) {
        return {
          bookerId: nearby[3],
          strategy: `name-proximity(slot=${nearby[1]}/${nearby[2]})`
        };
      }
    }
  }

  return { bookerId: null, strategy: 'none' };
}

// ─── Public ops: createBooking + cancelBooking ────────────────────────────

async function loadBookingRow(businessId, bookingRequestId) {
  const res = await query(
    `SELECT id, business_id, customer_name, customer_phone, customer_email,
            requested_date, requested_time, party_size, num_carts, holes,
            teeon_booking_id, status
       FROM booking_requests
      WHERE id = $1 AND business_id = $2`,
    [bookingRequestId, businessId]
  );
  return res.rows[0] || null;
}

async function recordSyncSuccess(businessId, bookingRequestId, bookerId) {
  await query(
    `UPDATE booking_requests
        SET teeon_booking_id = $1,
            teeon_synced_at  = NOW(),
            teeon_last_error = NULL,
            updated_at       = NOW()
      WHERE id = $2 AND business_id = $3`,
    [bookerId, bookingRequestId, businessId]
  );
}

async function recordSyncError(businessId, bookingRequestId, error) {
  const msg = (error && error.message) ? error.message : String(error);
  await query(
    `UPDATE booking_requests
        SET teeon_last_error = $1,
            updated_at       = NOW()
      WHERE id = $2 AND business_id = $3`,
    [msg.slice(0, 500), bookingRequestId, businessId]
  );
}

/**
 * Create a booking on Tee-On for an existing local booking_requests row.
 *
 * Returns { ok, bookerId?, dryRun?, error? }. Never throws past the caller —
 * booking-manager.js inspects the result and decides whether to allow the
 * 'confirmed' transition. (If ok=false and not dry-run, the caller should
 * keep the booking pending.)
 */
async function createBooking(businessId, bookingRequestId, { dateOverride, nine } = {}) {
  if (!(await isEnabledForBusiness(businessId))) {
    return { ok: true, skipped: true, reason: 'flag-off' };
  }
  const dry = await isDryRun(businessId);
  const booking = await loadBookingRow(businessId, bookingRequestId);
  if (!booking) return { ok: false, error: 'booking-not-found' };

  const date = dateOverride || (booking.requested_date instanceof Date
    ? booking.requested_date.toISOString().slice(0, 10)
    : String(booking.requested_date).slice(0, 10));
  const time = timeToHHmm(booking.requested_time);
  // A booking row without a date or time is one we cannot push to
  // Tee-On (Tee-On requires both to identify the slot). Rather than
  // blocking the local confirm — which would regress the existing
  // staff workflow for any booking the AI saved without a precise
  // time — we treat this as a best-effort skip: log it, mark the
  // local row's teeon_last_error so ops can see it, and let the
  // confirm proceed unchanged. Staff who still want it on Tee-On
  // can enter it manually on the live tee sheet.
  if (!date || !time) {
    console.log(
      `[tenant:${businessId}] [TeeOn-Admin] skipping push for booking ${bookingRequestId} ` +
      `— no ${!date ? 'date' : 'time'} on row (legacy/loose booking)`
    );
    await recordSyncError(businessId, bookingRequestId, new Error('missing-date-or-time (skipped)'));
    return { ok: true, skipped: true, reason: 'missing-date-or-time' };
  }

  let cfg;
  try {
    cfg = (await getSession(businessId)).cfg;
  } catch (err) {
    await recordSyncError(businessId, bookingRequestId, err);
    return { ok: false, error: err.message };
  }

  // Route 9-hole bookings to the Back nine, 18-hole to the Front. Tee-On
  // models the two nines as separate columns (NineCode=F vs B) and the
  // booking POST must target the right one. Without this, every 9-hole
  // call hit Front 9 (which at peak times is full of 18-hole groups),
  // Tee-On rejected silently, and our extractor matched an existing
  // group's BookerID — false-positive success.
  const resolvedNine = nine || (Number(booking.holes) === 9 ? 'B' : 'F');

  const payload = buildBookingPayload({
    cfg,
    date, time, nine: resolvedNine,
    partySize: booking.party_size,
    holes: booking.holes,
    numCarts: booking.num_carts,
    customerName: booking.customer_name,
    customerPhone: booking.customer_phone,
    customerEmail: booking.customer_email
  });

  if (dry) {
    console.log(`[tenant:${businessId}] [TeeOn-Admin] DRY-RUN createBooking`, {
      bookingRequestId, date, time, nine: resolvedNine,
      partySize: booking.party_size, holes: booking.holes,
      payloadKeys: Object.keys(payload).length
    });
    return { ok: true, dryRun: true };
  }

  // Real write path. Caller has explicitly opted in by setting
  // teeon_admin_dry_run=false in settings.
  //
  // Tee-On's BookTimeProshop expects the proshop session to already
  // know which slot is being edited — that state is established by
  // GETting ProshopPlayerEntry first (the same flow a real user
  // follows when they click an empty slot). Skipping the GET means
  // the POST is silently treated as a no-op: HTTP 200 comes back, but
  // no booking row appears on the tee sheet. We saw this in practice.
  // So: GET the form page, THEN POST.
  try {
    let { cookies } = await getSession(businessId);
    const proshopFormUrl =
      `${PROSHOP_ENTRY_PATH}?Date=${encodeURIComponent(date)}` +
      `&Time=${encodeURIComponent(time)}` +
      `&Course=${cfg.courseCode}` +
      `&Nine=${resolvedNine}` +
      `&ClickedGolfer=-1` +
      `&CacheTime=true`;

    await throttle(businessId);
    const formPage = await httpsRequest({
      method: 'GET',
      path: proshopFormUrl,
      headers: { Cookie: cookies, Referer: `https://${TEEON_HOST}${TEE_SHEET_PATH}?Default=true` }
    });
    if (formPage.status >= 400) {
      throw new Error(`Tee-On rejected ProshopPlayerEntry GET (${formPage.status})`);
    }
    // Session-expired detection: ONLY fire when we're clearly on a login
    // page. The previous regex (`/SignInGolferSection|sign\s*in/i`) was
    // a false-positive magnet because the proshop form page contains
    // "Sign Out" links and other "sign"-prefixed text. Now we look for
    // the actual login form fields — `name="Username"` + `name="Password"`
    // — which only co-occur on Tee-On's SignIn page itself.
    const looksLikeLoginPage =
      /name=['"]?Username['"]?/i.test(formPage.body || '') &&
      /name=['"]?Password['"]?/i.test(formPage.body || '');
    if (looksLikeLoginPage) {
      sessions.delete(businessId);
      throw new Error('Session expired before POST — re-auth required');
    }
    // Sanity check: confirm we landed on the booking form. The POST
    // form has id="form" and submits to BookTimeProshop. If both are
    // missing, something else has happened (maintenance page, session
    // hiccup) and we should bail loudly rather than send a doomed POST.
    const looksLikeBookingForm =
      /id=['"]?form['"]?/i.test(formPage.body || '') ||
      /BookTimeProshop/i.test(formPage.body || '');
    if (!looksLikeBookingForm) {
      // Diagnostic: log the page title + first chunk of body so ops can
      // see WHAT Tee-On is actually returning. Never include cookies or
      // form values (could leak session tokens). Trim to 800 chars and
      // collapse whitespace.
      const title = (formPage.body || '').match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '(no title)';
      const bodySnippet = (formPage.body || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '<script…/>')
        .replace(/<style[\s\S]*?<\/style>/gi, '<style…/>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800);
      console.warn(
        `[tenant:${businessId}] [TeeOn-Admin] unrecognised page diagnostic:\n` +
        `  title:    ${title}\n` +
        `  bytes:    ${formPage.body?.length || 0}\n` +
        `  status:   ${formPage.status}\n` +
        `  snippet:  ${bodySnippet}`
      );
      throw new Error(
        `ProshopPlayerEntry GET returned an unrecognised page ` +
        `(title="${title.slice(0, 80)}"; ${formPage.body?.length || 0} bytes; status ${formPage.status})`
      );
    }
    // Carry any cookies the form page set into the POST.
    if (formPage.cookies && formPage.cookies.length) {
      cookies = mergeCookieHeaders(cookies, formPage.cookies);
      const cached = sessions.get(businessId);
      if (cached) sessions.set(businessId, { ...cached, cookies });
    }
    console.log(
      `[tenant:${businessId}] [TeeOn-Admin] form page loaded ` +
      `(${formPage.body?.length || 0} bytes) — proceeding with POST`
    );

    // Parse the live form's hidden + select + radio values and use them
    // as the base payload. Tee-On populates many fields from the slot's
    // server-side state (cart inventory, pricing item IDs, etc.); if we
    // submit empty strings for those it 500s. Override ONLY the user-
    // driven fields we want to set: player names/contact, party
    // size/holes/carts choice.
    const liveFields = parseFormFields(formPage.body || '');
    const overrides = {
      Players: payload.Players,
      Holes: payload.Holes,
      Carts: payload.Carts,
      // Slot identity — Tee-On sets these as hidden inputs on the form
      // page already (matches our query params), but we re-assert them
      // for safety.
      Date: payload.Date,
      Time: payload.Time,
      CourseCode: payload.CourseCode,
      Nine: payload.Nine,
      // Slot 0 player (the booker)
      GolferName0: payload.GolferName0,
      Phone0: payload.Phone0,
      Email0: payload.Email0,
      Holes0: payload.Holes0
    };
    // For party >1, also override slot 1..n with "Guest"
    for (let i = 1; i < 4; i++) {
      if (payload[`GolferName${i}`]) overrides[`GolferName${i}`] = payload[`GolferName${i}`];
      if (payload[`Holes${i}`]) overrides[`Holes${i}`] = payload[`Holes${i}`];
    }
    const merged = { ...liveFields, ...overrides };
    console.log(
      `[tenant:${businessId}] [TeeOn-Admin] payload merge: ` +
      `live=${Object.keys(liveFields).length} overrides=${Object.keys(overrides).length} ` +
      `merged=${Object.keys(merged).length}`
    );

    await throttle(businessId);
    const body = encodeForm(merged);
    const res = await httpsRequest({
      method: 'POST',
      path: BOOK_TIME_PATH,
      headers: {
        Cookie: cookies,
        Referer: `https://${TEEON_HOST}${proshopFormUrl}`
      },
      body
    });
    if (res.status >= 400) {
      // Log a sanitised snippet so we can see WHY Tee-On rejected.
      const snippet = (res.body || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '<script…/>')
        .replace(/<style[\s\S]*?<\/style>/gi, '<style…/>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
      console.warn(
        `[tenant:${businessId}] [TeeOn-Admin] POST ${res.status} body snippet: ${snippet}`
      );
      throw new Error(`Tee-On responded ${res.status} on POST`);
    }
    console.log(
      `[tenant:${businessId}] [TeeOn-Admin] POST status=${res.status} ` +
      `body=${res.body?.length || 0} bytes`
    );
    // ─── POST response interpretation ─────────────────────────────────
    //
    // Tee-On returns one of two shapes:
    //   (a) the booking FORM re-rendered with error markup       → FAILURE
    //   (b) the FULL TEE SHEET (with our new booking visible)    → SUCCESS
    //
    // Distinguishing them is the single most reliable signal we have.
    // Past iterations relied on a regex that matched keywords like
    // "not allowed" anywhere in the raw body — that fired on bundled
    // analytics JS ("Session Replay is not allowed and will not be
    // started") and sent us down the failure path on real successes.
    // Strip scripts/styles BEFORE running any error-hint regex.
    const rawBody = res.body || '';
    const cleanBody = rawBody
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');

    const looksLikeReRenderedForm =
      /<form[^>]*\bid=['"]?form['"]?[^>]*>/i.test(cleanBody) &&
      /BookTimeProshop/i.test(cleanBody);
    const looksLikeTeeSheet =
      /<title[^>]*>[^<]*Tee\s*Sheet[^<]*<\/title>/i.test(cleanBody) &&
      !looksLikeReRenderedForm;

    // Customer name reflected in the POST response = we definitely
    // hit Tee-On with our payload and it accepted enough of it to
    // render the name back. Strongest "did the booking land" signal.
    const customerName = booking.customer_name || '';
    const customerNameInPostBody = customerName.length >= 3 && cleanBody.includes(customerName);

    // errorHint only meaningful inside a re-rendered form — keywords
    // inside a tee-sheet body are almost always tooltip / help text.
    const errorHintRe = /(class="[^"]*\berror\b|please correct|already booked|not allowed|conflict)/i;
    const errorHintMatchInForm = looksLikeReRenderedForm ? cleanBody.match(errorHintRe) : null;
    const errorHint = !!errorHintMatchInForm;
    const errorContext = errorHintMatchInForm
      ? cleanBody.slice(Math.max(0, errorHintMatchInForm.index - 250), errorHintMatchInForm.index + 350)
          .replace(/\s+/g, ' ')
          .trim()
      : '';

    // GenericMessage popups — kept for diagnostics. Most are routine UI
    // overlays (Settings, Messages, Directions). On a re-rendered form
    // an error popup may surface here — that's the high-value signal.
    const popupRe = /<div[^>]*class="[^"]*GenericPopup[^"]*"[^>]*id="(GenericMessage\d+)"[^>]*>([\s\S]{0,800}?)<\/div>\s*<\/div>/gi;
    const popups = [];
    let popupMatch;
    while ((popupMatch = popupRe.exec(cleanBody)) !== null) {
      popups.push(`${popupMatch[1]}: ${popupMatch[2].replace(/\s+/g, ' ').trim().slice(0, 220)}`);
      if (popups.length >= 6) break;
    }

    // Re-fetch tee sheet to discover the new BookerID. We try multiple
    // strategies so one HTML quirk doesn't sink the whole sync.
    await throttle(businessId);
    const sheet = await httpsRequest({
      method: 'GET',
      path: `${TEE_SHEET_PATH}?Course=${cfg.courseCode}&Date=${encodeURIComponent(date)}&Default=true`,
      headers: { Cookie: cookies }
    });
    const sheetBody = sheet.body || '';
    const extracted = extractBookerIdMultiStrategy(sheetBody, {
      time, nine: resolvedNine, customerName
    });

    // ─── Decision matrix ─────────────────────────────────────────────
    //   bookerId  | post-body shape       | outcome
    //   --------- | --------------------- | -------------------------
    //   FOUND     | (any)                 | SUCCESS, full sync
    //   not found | tee sheet + name      | SUCCESS (lenient — log warn)
    //   not found | tee sheet, no name    | UNCERTAIN — fail loudly
    //   not found | re-rendered form      | FAILURE (real)
    //
    // The "lenient" path was missing before. We were throwing on every
    // BookerID extraction miss, which masquerades as "form re-rendered
    // with error" even when Tee-On clearly accepted the booking.
    if (extracted.bookerId) {
      await recordSyncSuccess(businessId, bookingRequestId, extracted.bookerId);
      console.log(
        `[tenant:${businessId}] [TeeOn-Admin] createBooking OK ` +
        `booker=${extracted.bookerId} via=${extracted.strategy} date=${date} time=${time}`
      );
      return { ok: true, bookerId: extracted.bookerId, strategy: extracted.strategy };
    }
    if (looksLikeTeeSheet && customerNameInPostBody) {
      // Booking landed; we just couldn't pin the BookerID. Mark synced
      // so the local row reads "confirmed". Cancel-from-our-UI for
      // this booking will need ops to manually reconcile the BookerID
      // (rare path — log loudly).
      await recordSyncSuccess(businessId, bookingRequestId, null);
      console.warn(
        `[tenant:${businessId}] [TeeOn-Admin] createBooking PROBABLY OK ` +
        `(tee-sheet body + customer name "${customerName}" reflected) ` +
        `but BookerID extraction failed for date=${date} time=${time}/${resolvedNine}. ` +
        `Booking is on Tee-On; cancel from our UI may need manual reconcile. ` +
        `Strategies tried: exact, time-any-nine, name-proximity (all missed).`
      );
      return { ok: true, bookerId: null, warning: 'no-booker-id', strategy: 'lenient-name-match' };
    }

    // Real failure path — dump full forensic diagnostic.
    const allSubmitTimes = [];
    const submitRe = /submitExistingTime\('([^']+)','([A-Z])','([A-Z0-9]+)'/g;
    let st;
    while ((st = submitRe.exec(sheetBody)) !== null) {
      allSubmitTimes.push(`${st[1]}/${st[2]}/${st[3]}`);
      if (allSubmitTimes.length >= 30) break;
    }
    const nameInSheet = customerName && sheetBody.includes(customerName);
    const nameSheetIdx = customerName ? sheetBody.indexOf(customerName) : -1;
    console.warn(
      `[tenant:${businessId}] [TeeOn-Admin] POST rejected body snippet:\n` +
      `  bodyShape:    looksLikeReRenderedForm=${looksLikeReRenderedForm} looksLikeTeeSheet=${looksLikeTeeSheet}\n` +
      `  customerName: "${customerName}" inPostBody=${customerNameInPostBody} inSheet=${nameInSheet}${nameSheetIdx >= 0 ? ` @${nameSheetIdx}` : ''}\n` +
      `  errorHint:    ${errorHint}${errorHintMatchInForm ? ` (matched "${errorHintMatchInForm[0]}" @${errorHintMatchInForm.index})` : ''}\n` +
      `  errorContext: ${errorContext || '(none — errorHint only fires on re-rendered form)'}\n` +
      `  popups (${popups.length}):\n` +
      (popups.length ? popups.map(p => `    - ${p}`).join('\n') + '\n' : '    (none found)\n') +
      `  bookingTime:  ${time}/${resolvedNine}\n` +
      `  sheetSlots (${allSubmitTimes.length}): ${allSubmitTimes.slice(0, 12).join(', ')}${allSubmitTimes.length > 12 ? ', …' : ''}\n` +
      `  postBytes:    ${rawBody.length}\n` +
      `  sheetBytes:   ${sheetBody.length}\n` +
      `  postSnippet[0..1500]: ${cleanBody.replace(/\s+/g, ' ').trim().slice(0, 1500)}`
    );
    const reason = errorHint
      ? 'Tee-On rejected the POST (form re-rendered with error)'
      : (looksLikeTeeSheet
        ? 'POST returned tee sheet but customer name not reflected — booking may not have landed'
        : 'POST returned an unrecognised page — verify on Tee-On');
    throw new Error(reason);
  } catch (err) {
    await recordSyncError(businessId, bookingRequestId, err);
    console.error(`[tenant:${businessId}] [TeeOn-Admin] createBooking failed:`, err.message);
    // Force a fresh login next time in case the failure was a stale cookie.
    sessions.delete(businessId);
    return { ok: false, error: err.message };
  }
}

/**
 * Cancel a booking on Tee-On. Looks up the cached BookerID. If we don't
 * have one, returns { ok:true, skipped:true, reason:'no-teeon-id' } —
 * locally the booking still cancels normally; nothing on Tee-On to do.
 */
async function cancelBooking(businessId, bookingRequestId, { nine } = {}) {
  if (!(await isEnabledForBusiness(businessId))) {
    return { ok: true, skipped: true, reason: 'flag-off' };
  }
  const dry = await isDryRun(businessId);
  const booking = await loadBookingRow(businessId, bookingRequestId);
  if (!booking) return { ok: false, error: 'booking-not-found' };
  if (!booking.teeon_booking_id) {
    return { ok: true, skipped: true, reason: 'no-teeon-id' };
  }

  const date = booking.requested_date instanceof Date
    ? booking.requested_date.toISOString().slice(0, 10)
    : String(booking.requested_date).slice(0, 10);
  const time = timeToHHmm(booking.requested_time);
  if (!date || !time) {
    // Same fail-open posture as createBooking: a row without a usable
    // date/time can't be cancelled on Tee-On either, but blocking the
    // local cancel would be a worse outcome than a quiet skip.
    console.log(
      `[tenant:${businessId}] [TeeOn-Admin] skipping cancel for booking ${bookingRequestId} ` +
      `— no ${!date ? 'date' : 'time'} on row`
    );
    return { ok: true, skipped: true, reason: 'missing-date-or-time' };
  }

  let cfg;
  try {
    cfg = (await getSession(businessId)).cfg;
  } catch (err) {
    await recordSyncError(businessId, bookingRequestId, err);
    return { ok: false, error: err.message };
  }

  // Tick Delete# for every slot in the party so the whole booking
  // disappears. We don't track per-slot indices yet so we conservatively
  // delete the maximum possible number of slots.
  const partySize = Math.max(1, Math.min(4, Number(booking.party_size) || 1));
  const deleteSlots = [];
  for (let i = 0; i < partySize; i++) deleteSlots.push(i);

  // Same nine routing as createBooking so a 9-hole booking on the Back
  // nine gets cancelled on the Back nine, not the Front.
  const resolvedNine = nine || (Number(booking.holes) === 9 ? 'B' : 'F');

  const payload = buildBookingPayload({
    cfg,
    date, time, nine: resolvedNine,
    partySize: booking.party_size,
    holes: booking.holes,
    numCarts: booking.num_carts,
    customerName: booking.customer_name,
    customerPhone: booking.customer_phone,
    customerEmail: booking.customer_email,
    bookerId: booking.teeon_booking_id,
    deleteSlots
  });

  if (dry) {
    console.log(`[tenant:${businessId}] [TeeOn-Admin] DRY-RUN cancelBooking`, {
      bookingRequestId, bookerId: booking.teeon_booking_id, deleteSlots
    });
    return { ok: true, dryRun: true };
  }

  // Cancel uses the same GET-then-POST pattern as create. The form page
  // for an EXISTING booking takes BookerID + AllowDel so Tee-On knows
  // which booking is being edited; without that GET, our delete POST
  // can hit the same silent no-op as a missing-state create.
  try {
    let { cookies } = await getSession(businessId);
    const proshopFormUrl =
      `${PROSHOP_ENTRY_PATH}?Date=${encodeURIComponent(date)}` +
      `&Time=${encodeURIComponent(time)}` +
      `&Course=${cfg.courseCode}` +
      `&Nine=${resolvedNine}` +
      `&BookerID=${encodeURIComponent(booking.teeon_booking_id)}` +
      `&AllowDel=true` +
      `&ClickedGolfer=0` +
      `&CacheTime=true`;

    await throttle(businessId);
    const formPage = await httpsRequest({
      method: 'GET',
      path: proshopFormUrl,
      headers: { Cookie: cookies, Referer: `https://${TEEON_HOST}${TEE_SHEET_PATH}?Default=true` }
    });
    if (formPage.status >= 400) {
      throw new Error(`Tee-On rejected ProshopPlayerEntry GET on cancel (${formPage.status})`);
    }
    if (formPage.cookies && formPage.cookies.length) {
      cookies = mergeCookieHeaders(cookies, formPage.cookies);
      const cached = sessions.get(businessId);
      if (cached) sessions.set(businessId, { ...cached, cookies });
    }

    // Same form-hiddens merge as createBooking. The booking edit form
    // populates server-side state (cart inventory, pricing item IDs,
    // SlotBookerIDs, etc.) that BookTimeProshop validates on submit.
    // POSTing without those values 500s — same root cause we hit on
    // create. Parse the live form, use it as the base, override only
    // the Delete# flags + BookerID + slot identity.
    const liveFields = parseFormFields(formPage.body || '');
    const cancelOverrides = {
      Date: payload.Date,
      Time: payload.Time,
      CourseCode: payload.CourseCode,
      Nine: payload.Nine,
      BookerID: payload.BookerID || booking.teeon_booking_id || '',
    };
    // Stamp Delete# = 'on' for every slot in the party so the whole
    // booking disappears.
    for (let i = 0; i < 4; i++) {
      cancelOverrides[`Delete${i}`] = deleteSlots.includes(i) ? 'on' : '';
    }
    const merged = { ...liveFields, ...cancelOverrides };
    console.log(
      `[tenant:${businessId}] [TeeOn-Admin] cancel payload merge: ` +
      `live=${Object.keys(liveFields).length} overrides=${Object.keys(cancelOverrides).length} ` +
      `merged=${Object.keys(merged).length}`
    );

    await throttle(businessId);
    const body = encodeForm(merged);
    const res = await httpsRequest({
      method: 'POST',
      path: BOOK_TIME_PATH,
      headers: {
        Cookie: cookies,
        Referer: `https://${TEEON_HOST}${proshopFormUrl}`
      },
      body
    });
    if (res.status >= 400) {
      const snippet = (res.body || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '<script…/>')
        .replace(/<style[\s\S]*?<\/style>/gi, '<style…/>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
      console.warn(
        `[tenant:${businessId}] [TeeOn-Admin] cancel POST ${res.status} body snippet: ${snippet}`
      );
      throw new Error(`Tee-On responded ${res.status} on cancel POST`);
    }
    console.log(
      `[tenant:${businessId}] [TeeOn-Admin] cancel POST status=${res.status} ` +
      `body=${res.body?.length || 0}b`
    );
    // Clear the teeon_booking_id since the row no longer exists on Tee-On.
    await query(
      `UPDATE booking_requests
          SET teeon_booking_id = NULL,
              teeon_synced_at  = NOW(),
              teeon_last_error = NULL,
              updated_at       = NOW()
        WHERE id = $1 AND business_id = $2`,
      [bookingRequestId, businessId]
    );
    console.log(`[tenant:${businessId}] [TeeOn-Admin] cancelBooking OK booker=${booking.teeon_booking_id}`);
    return { ok: true };
  } catch (err) {
    await recordSyncError(businessId, bookingRequestId, err);
    console.error(`[tenant:${businessId}] [TeeOn-Admin] cancelBooking failed:`, err.message);
    sessions.delete(businessId);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  createBooking,
  cancelBooking,
  isEnabledForBusiness,
  isDryRun
};
