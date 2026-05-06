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
const SIGNIN_PATH = '/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.SignInGolferSection';
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
        }).then(r => ({ ...r, cookies: mergeCookieArrays(r.cookies, setCookies) })));
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

function mergeCookieArrays(a, b) {
  return [...(a || []), ...(b || [])];
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
  await throttle(cfg.businessId);
  const body = encodeForm({
    Username: cfg.creds.username,
    Password: cfg.creds.password,
    BackTarget: '',
    Language: 'en',
    LockerString: '',
    FromTeeOn: 'true',
    GrabFocus: 'true',
    LoginType: '-1',
    SaveSignIn: 'false'
  });
  const res = await httpsRequest({
    method: 'POST',
    path: SIGNIN_PATH,
    body,
    redirect: true
  });
  // After redirect-following we should be on a logged-in page. If we
  // ended up back at SignIn it means credentials were rejected.
  const html = (res.body || '').toLowerCase();
  const looksLikeLogin = html.includes('forgot username') && html.includes('sign in');
  const cookies = (res.cookies || []).join('; ');
  if (!cookies || looksLikeLogin) {
    throw new Error('login-failed');
  }
  return cookies;
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
  if (!date || !time) return { ok: false, error: 'missing-date-or-time' };

  let cfg;
  try {
    cfg = (await getSession(businessId)).cfg;
  } catch (err) {
    await recordSyncError(businessId, bookingRequestId, err);
    return { ok: false, error: err.message };
  }

  const payload = buildBookingPayload({
    cfg,
    date, time, nine: nine || 'F',
    partySize: booking.party_size,
    holes: booking.holes,
    numCarts: booking.num_carts,
    customerName: booking.customer_name,
    customerPhone: booking.customer_phone,
    customerEmail: booking.customer_email
  });

  if (dry) {
    console.log(`[tenant:${businessId}] [TeeOn-Admin] DRY-RUN createBooking`, {
      bookingRequestId, date, time, nine: nine || 'F',
      partySize: booking.party_size, holes: booking.holes,
      payloadKeys: Object.keys(payload).length
    });
    return { ok: true, dryRun: true };
  }

  // Real write path. Caller has explicitly opted in by setting
  // teeon_admin_dry_run=false in settings.
  try {
    const { cookies } = await getSession(businessId);
    await throttle(businessId);
    const body = encodeForm(payload);
    const res = await httpsRequest({
      method: 'POST',
      path: BOOK_TIME_PATH,
      headers: { Cookie: cookies, Referer: `https://${TEEON_HOST}${PROSHOP_ENTRY_PATH}` },
      body
    });
    if (res.status >= 400) throw new Error(`Tee-On responded ${res.status}`);

    // Re-fetch tee sheet to discover the new BookerID.
    await throttle(businessId);
    const sheet = await httpsRequest({
      method: 'GET',
      path: `${TEE_SHEET_PATH}?Course=${cfg.courseCode}&Date=${encodeURIComponent(date)}&Default=true`,
      headers: { Cookie: cookies }
    });
    const bookerId = extractBookerIdForSlot(sheet.body, time, nine || 'F');
    if (!bookerId) {
      // Booking might still have succeeded but we couldn't find it (race
      // with the redirect, or the slot moved). Surface an error so ops
      // can investigate. Local row stays pending.
      throw new Error('Could not locate BookerID after POST — verify on Tee-On');
    }

    await recordSyncSuccess(businessId, bookingRequestId, bookerId);
    console.log(`[tenant:${businessId}] [TeeOn-Admin] createBooking OK booker=${bookerId} date=${date} time=${time}`);
    return { ok: true, bookerId };
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
  if (!date || !time) return { ok: false, error: 'missing-date-or-time' };

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

  const payload = buildBookingPayload({
    cfg,
    date, time, nine: nine || 'F',
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

  try {
    const { cookies } = await getSession(businessId);
    await throttle(businessId);
    const body = encodeForm(payload);
    const res = await httpsRequest({
      method: 'POST',
      path: BOOK_TIME_PATH,
      headers: { Cookie: cookies, Referer: `https://${TEEON_HOST}${PROSHOP_ENTRY_PATH}` },
      body
    });
    if (res.status >= 400) throw new Error(`Tee-On responded ${res.status}`);
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
