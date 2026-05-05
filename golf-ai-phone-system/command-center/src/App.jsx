import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// ============================================
// API Helper + session storage
// ============================================
// localStorage keys
//   gc_token              — JWT bearer token
//   gc_session            — JSON { role, business_id, business_name, template_key, username, name }
//   gc_selected_business  — super-admin only: numeric id of the tenant they're
//                           currently acting as via the Business Switcher.
//                           When set, the UI reads/writes tenant data via
//                           /api/* with X-Business-Id: <id>.
// ============================================
const API_BASE = '';

function getToken() {
  return localStorage.getItem('gc_token');
}

function getSession() {
  try {
    const raw = localStorage.getItem('gc_session');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setSession(session) {
  if (!session) {
    localStorage.removeItem('gc_session');
  } else {
    localStorage.setItem('gc_session', JSON.stringify(session));
  }
}

function getSelectedBusinessId() {
  const v = localStorage.getItem('gc_selected_business');
  return v ? parseInt(v, 10) : null;
}

function setSelectedBusinessId(id) {
  if (id === null || id === undefined) {
    localStorage.removeItem('gc_selected_business');
  } else {
    localStorage.setItem('gc_selected_business', String(id));
  }
}

function clearAuth() {
  localStorage.removeItem('gc_token');
  localStorage.removeItem('gc_session');
  localStorage.removeItem('gc_selected_business');
}

// ============================================
// Brand color theming
// ============================================
//
// The wizard captures a `primary_color` (hex) per tenant, but every
// component in this file uses hardcoded Tailwind `golf-XXX` classes
// (golf-600 backgrounds, golf-700 hover, golf-200 sidebar text, etc.)
// from a build-time palette. Replacing every class would mean editing
// hundreds of lines and risking regressions on Valleymede.
//
// Instead, we apply the brand at runtime by *remapping* the existing
// golf classes to the tenant's color via injected CSS:
//
//   1. Compute lighter/darker shades from the chosen hex via HSL.
//   2. Inject one <style> tag whose selectors override the known
//      golf-XXX background / text / border classes with the new shades.
//   3. Every component that already uses `bg-golf-600` automatically
//      picks up the new color — no component-level changes required.
//
// Valleymede has primary_color = NULL → applyBrand(null) removes the
// override sheet, so the original Tailwind palette wins. Pixel-identical
// to the pre-change UI.
// ============================================

function _hexToHsl(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = hex.trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(m)) return null;
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return [h, s, l];
}

function _hslToHex(h, s, l) {
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h / 60) % 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r, g, b;
  if (0 <= hp && hp < 1)      [r, g, b] = [c, x, 0];
  else if (1 <= hp && hp < 2) [r, g, b] = [x, c, 0];
  else if (2 <= hp && hp < 3) [r, g, b] = [0, c, x];
  else if (3 <= hp && hp < 4) [r, g, b] = [0, x, c];
  else if (4 <= hp && hp < 5) [r, g, b] = [x, 0, c];
  else                        [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Apply (or clear) a brand color override. Pass null/undefined to remove
 * any previously-injected sheet and let the Tailwind defaults render.
 *
 * The shade map below targets the golf-XXX values most commonly used as
 * brand surfaces (600/700/800 backgrounds, 200 text, 300 borders, 50/100
 * tints). Light tints stay close to the brand hue but very desaturated
 * so they don't visually overpower the page.
 */
function applyBrand(hex) {
  if (typeof document === 'undefined') return;
  const ID = 'brand-override-style';
  const existing = document.getElementById(ID);
  if (existing) existing.remove();

  const hsl = _hexToHsl(hex);
  if (!hsl) {
    // No / invalid color → leave the Tailwind palette alone (Valleymede default).
    return;
  }
  const [h, s] = hsl;

  // Tailwind-ish lightness ladder. We force a consistent rhythm regardless
  // of the input lightness so a too-bright or too-dark brand color still
  // produces a usable palette of states (hover, active, sidebar, tint).
  const shade = (l) => _hslToHex(h, Math.max(0.25, Math.min(0.85, s)), l);
  const c50  = shade(0.96);
  const c100 = shade(0.92);
  const c200 = shade(0.85);
  const c300 = shade(0.74);
  const c500 = shade(0.50);
  const c600 = shade(0.42);
  const c700 = shade(0.34);
  const c800 = shade(0.26);
  const c900 = shade(0.18);

  // Light text on dark brand backgrounds (sidebar) reads better at a
  // slightly desaturated, lifted shade. Match the existing golf-200
  // pattern (a pale tint of the brand hue, not pure white).
  const cText200 = _hslToHex(h, Math.min(0.4, s), 0.78);

  const css = `
    :root { --brand: ${hex}; --brand-700: ${c700}; --brand-50: ${c50}; }

    /* Backgrounds */
    .bg-golf-50  { background-color: ${c50}  !important; }
    .bg-golf-100 { background-color: ${c100} !important; }
    .bg-golf-500 { background-color: ${c500} !important; }
    .bg-golf-600 { background-color: ${c600} !important; }
    .bg-golf-700 { background-color: ${c700} !important; }
    .bg-golf-800 { background-color: ${c800} !important; }
    .bg-golf-900 { background-color: ${c900} !important; }

    /* Hover backgrounds (Tailwind compiles to .hover\\:bg-golf-XXX:hover) */
    .hover\\:bg-golf-50:hover  { background-color: ${c50}  !important; }
    .hover\\:bg-golf-100:hover { background-color: ${c100} !important; }
    .hover\\:bg-golf-600:hover { background-color: ${c600} !important; }
    .hover\\:bg-golf-700:hover { background-color: ${c700} !important; }

    /* Text */
    .text-golf-200 { color: ${cText200} !important; }
    .text-golf-600 { color: ${c600} !important; }
    .text-golf-700 { color: ${c700} !important; }
    .text-golf-800 { color: ${c800} !important; }
    .hover\\:text-golf-700:hover { color: ${c700} !important; }

    /* Borders */
    .border-golf-200 { border-color: ${c200} !important; }
    .border-golf-300 { border-color: ${c300} !important; }
    .border-golf-600 { border-color: ${c600} !important; }
    .border-golf-700 { border-color: ${c700} !important; }
    .border-b-golf-600 { border-bottom-color: ${c600} !important; }

    /* Focus rings (Tailwind: ring-golf-XXX) */
    .focus\\:ring-golf-500:focus { --tw-ring-color: ${c500} !important; }
  `;

  const tag = document.createElement('style');
  tag.id = ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}

// Decide whether to attach X-Business-Id for this request. Only super-admin
// sessions do — tenant users must not try to override their JWT binding.
function inferBusinessHeader(path) {
  const session = getSession();
  if (!session || session.role !== 'super_admin') return null;
  const selected = getSelectedBusinessId();
  if (!selected) return null;
  // Don't send it on super-admin-only endpoints or on auth routes.
  if (path.startsWith('/api/super') || path.startsWith('/auth')) return null;
  return selected;
}

async function api(path, options = {}) {
  const token = getToken();
  const businessHeader = inferBusinessHeader(path);
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(businessHeader ? { 'X-Business-Id': String(businessHeader) } : {}),
      ...options.headers
    }
  });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    // Surface the full server payload (status + JSON body) on the thrown
    // Error so callers can read structured fields like `step`, `field`, or
    // `constraint`. Existing callers that only read err.message are
    // unaffected — the attached `status`/`body` properties are extras.
    const thrown = new Error(err.error || 'Request failed');
    thrown.status = res.status;
    thrown.body = err;
    throw thrown;
  }
  return res.json();
}

// ============================================
// LOGIN PAGE
// ============================================
function LoginPage({ onLogin }) {
  // Pre-fill email from `?email=` query param. Used by the "Add user"
  // flow in Super Admin — the create-user response includes a sign-in
  // URL with the email baked in so the new tenant pastes one link
  // instead of typing both fields. We only read it on first mount;
  // if the user changes the field manually, that wins.
  const [username, setUsername] = useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      const params = new URLSearchParams(window.location.search);
      const e = params.get('email');
      return e ? e.trim() : '';
    } catch (_) { return ''; }
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      localStorage.setItem('gc_token', data.token);
      setSession({
        role: data.role,
        business_id: data.business_id,
        business_name: data.business_name || null,
        template_key: data.template_key || null,
        primary_color: data.primary_color || null,
        username: data.username,
        name: data.name
      });
      // Super admin starts with no business selected; tenant users bind
      // the switcher to their own tenant so api() header logic is uniform.
      if (data.role === 'super_admin') {
        setSelectedBusinessId(null);
      } else {
        setSelectedBusinessId(data.business_id);
      }
      onLogin(data);
    } catch (err) {
      setError('Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  return React.createElement('div', { className: 'min-h-screen flex items-center justify-center bg-gradient-to-br from-golf-800 to-golf-900' },
    React.createElement('div', { className: 'bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md' },
      React.createElement('div', { className: 'text-center mb-8' },
        React.createElement('div', { className: 'text-5xl mb-3' }, '\u26f3'),
        React.createElement('h1', { className: 'text-2xl font-bold text-gray-800' }, 'Command Center'),
        React.createElement('p', { className: 'text-gray-500 mt-1' }, 'AI Phone Platform')
      ),
      React.createElement('form', { onSubmit: handleSubmit },
        error && React.createElement('div', { className: 'bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm' }, error),
        React.createElement('div', { className: 'mb-4' },
          React.createElement('label', { className: 'block text-sm font-medium text-gray-700 mb-1' }, 'Username'),
          React.createElement('input', {
            type: 'text', value: username, onChange: e => setUsername(e.target.value),
            className: 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none',
            placeholder: 'admin'
          })
        ),
        React.createElement('div', { className: 'mb-6' },
          React.createElement('label', { className: 'block text-sm font-medium text-gray-700 mb-1' }, 'Password'),
          React.createElement('input', {
            type: 'password', value: password, onChange: e => setPassword(e.target.value),
            className: 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none',
            placeholder: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
          })
        ),
        React.createElement('button', {
          type: 'submit', disabled: loading,
          className: 'w-full bg-golf-600 hover:bg-golf-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50'
        }, loading ? 'Signing in...' : 'Sign In')
      )
    )
  );
}

// ============================================
// SIDEBAR
// ============================================
// The sidebar and page router branch on `templateKey` so each vertical can
// show only the tools it actually needs. Golf keeps its full nav; Personal
// Assistant gets a focused four-item menu; everything else ("other",
// "restaurant", …) shares a minimal baseline until Phase 7 fleshes them
// out. Add a new template → add a case in sidebarItemsFor() and
// tenantPagesFor() below.
const DEFAULT_SIDEBAR_ICON = '\ud83c\udfe0'; // fallback emoji

// Shared golf sidebar — used by the plan='legacy' safety lock and by the
// regular golf_course / driving_range path so they stay in lockstep.
const GOLF_SIDEBAR_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '\ud83d\udcca' },
  { id: 'teesheet',  label: 'Tee Sheet', icon: '\u26f3' },
  { id: 'bookings',  label: 'Bookings',  icon: '\ud83d\udcc5' },
  { id: 'customers', label: 'Customers', icon: '\ud83d\udc65' },
  { id: 'calls',     label: 'Call Logs', icon: '\ud83d\udcde' },
  { id: 'settings',  label: 'Settings',  icon: '\u2699\ufe0f' }
];

function sidebarItemsFor(templateKey, plan) {
  // Valleymede-safety lock. `plan='legacy'` means this is the original
  // single-tenant bootstrap row (Valleymede); keep the historical golf
  // sidebar no matter what template_key resolves to. If ops or a DB
  // drift sets the column to 'other' / NULL / 'restaurant', the tenant
  // still sees Tee Sheet + Bookings.
  if (plan === 'legacy') return GOLF_SIDEBAR_ITEMS;

  if (templateKey === 'personal_assistant') {
    return [
      { id: 'dashboard', label: 'Personal Assistant', icon: '\ud83d\udc64' },
      { id: 'messages',  label: 'Messages',           icon: '\ud83d\udce8' },
      { id: 'calls',     label: 'Call History',       icon: '\ud83d\udcde' },
      { id: 'my_info',   label: 'My Info',            icon: '\ud83d\udccb' },
      { id: 'settings',  label: 'Settings',           icon: '\u2699\ufe0f' }
    ];
  }
  // Business switchboard template \u2014 pure messaging operation.
  // No bookings, no customers list (those are golf-shaped concepts).
  // Just: Dashboard (call summary), Messages (the heart), Calls, Settings.
  if (templateKey === 'business') {
    return [
      { id: 'dashboard', label: 'Dashboard',  icon: '\ud83d\udcca' },
      { id: 'messages',  label: 'Messages',   icon: '\ud83d\udce8' },
      { id: 'calls',     label: 'Call Logs',  icon: '\ud83d\udcde' },
      { id: 'settings',  label: 'Settings',   icon: '\u2699\ufe0f' }
    ];
  }
  // Restaurant — same general shape as golf (dashboard + booking-flavoured
  // page + customers + calls + settings) but with restaurant-friendly
  // labels and no Tee Sheet. The `reservations` id maps to BookingsPage in
  // tenantPagesFor — bookings table is generic, only the label changes.
  if (templateKey === 'restaurant') {
    return [
      { id: 'dashboard',    label: 'Dashboard',    icon: '\ud83d\udcca' },
      { id: 'reservations', label: 'Reservations', icon: '\ud83d\udcc5' },
      { id: 'customers',    label: 'Customers',    icon: '\ud83d\udc65' },
      { id: 'calls',        label: 'Call Logs',    icon: '\ud83d\udcde' },
      { id: 'settings',     label: 'Settings',     icon: '\u2699\ufe0f' }
    ];
  }
  // Golf-style (driving_range reuses this shape for now) — keep the exact
  // menu Valleymede has been running on. `!templateKey` keeps pre-Phase-7
  // rows (before migration 005 backfilled the column) on the golf path
  // rather than stripping them down.
  if (templateKey === 'golf_course' || templateKey === 'driving_range' || !templateKey) {
    return GOLF_SIDEBAR_ITEMS;
  }
  // Neutral baseline for "other" until a dedicated vertical ships. No
  // golf-specific pages, but the essentials (calls, settings) are always
  // available.
  return [
    { id: 'dashboard', label: 'Dashboard', icon: '\ud83d\udcca' },
    { id: 'calls',     label: 'Call Logs', icon: '\ud83d\udcde' },
    { id: 'customers', label: 'Customers', icon: '\ud83d\udc65' },
    { id: 'settings',  label: 'Settings',  icon: '\u2699\ufe0f' }
  ];
}

function Sidebar({ currentPage, onNavigate, onLogout, tenantName, templateKey, plan }) {
  // plan is threaded through so sidebarItemsFor can short-circuit to the
  // golf menu for legacy tenants (Valleymede).
  const menuItems = sidebarItemsFor(templateKey, plan);

  return React.createElement('aside', { className: 'w-64 bg-golf-800 text-white min-h-screen flex flex-col' },
    React.createElement('div', { className: 'p-6 border-b border-golf-700' },
      React.createElement('div', { className: 'text-2xl mb-1' }, '\u26f3'),
      React.createElement('h2', { className: 'font-bold text-lg truncate' }, tenantName || 'Command Center'),
      React.createElement('p', { className: 'text-golf-200 text-sm' }, tenantName ? 'Command Center' : 'AI Phone Platform')
    ),
    React.createElement('nav', { className: 'flex-1 p-4' },
      menuItems.map(item =>
        React.createElement('button', {
          key: item.id,
          onClick: () => onNavigate(item.id),
          className: `w-full flex items-center gap-3 px-4 py-3 rounded-lg mb-1 transition-colors text-left ${
            currentPage === item.id ? 'bg-golf-600 text-white' : 'text-golf-200 hover:bg-golf-700'
          }`
        },
          React.createElement('span', { className: 'text-lg' }, item.icon),
          React.createElement('span', null, item.label)
        )
      )
    ),
    React.createElement('div', { className: 'p-4 border-t border-golf-700' },
      React.createElement('button', {
        onClick: onLogout,
        className: 'w-full text-golf-200 hover:text-white text-sm py-2 transition-colors'
      }, 'Sign Out')
    )
  );
}

// ============================================
// DASHBOARD PAGE
// ============================================
function DashboardPage() {
  const [data, setData] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const refetch = () => Promise.all([
      api('/api/dashboard'),
      api('/api/analytics').catch(() => null)
    ]).then(([d, a]) => { setData(d); setAnalytics(a); })
      .catch(console.error);
    refetch().finally(() => setLoading(false));
    const interval = setInterval(refetch, 30000);
    // Live refresh — App's EventSource broadcasts a window event whenever
    // the server pushes a booking/modification update. Polling stays in
    // place as a belt-and-braces fallback if the SSE stream drops.
    const onLive = () => refetch();
    window.addEventListener('cmdcenter:refresh', onLive);
    return () => {
      clearInterval(interval);
      window.removeEventListener('cmdcenter:refresh', onLive);
    };
  }, []);

  if (loading) return React.createElement('div', { className: 'p-8 text-gray-500' }, 'Loading dashboard...');

  const stats = [
    { label: 'Calls Today', value: data?.callsToday || 0, color: 'bg-blue-50 text-blue-700' },
    { label: 'Pending Bookings', value: data?.pendingBookings || 0, color: 'bg-yellow-50 text-yellow-700' },
    { label: 'Pending Changes', value: data?.pendingModifications || 0, color: 'bg-orange-50 text-orange-700' },
    { label: 'Total Customers', value: data?.totalCustomers || 0, color: 'bg-green-50 text-green-700' }
  ];

  // Analytics helper: format hour as 12h
  const formatHour = (h) => {
    if (h === 0) return '12 AM';
    if (h < 12) return `${h} AM`;
    if (h === 12) return '12 PM';
    return `${h - 12} PM`;
  };

  // Analytics helper: format date label
  const formatDay = (dateStr) => {
    if (!dateStr) return '?';
    // PostgreSQL returns dates as ISO timestamps (e.g. "2026-04-22T04:00:00.000Z")
    // or as "YYYY-MM-DD". Extract just the date part either way.
    const dateOnly = String(dateStr).split('T')[0];
    const parts = dateOnly.split('-');
    if (parts.length !== 3) return String(dateStr).slice(0, 10);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(parts[1], 10) - 1]} ${parseInt(parts[2], 10)}`;
  };

  // Bar chart helper (CSS-based)
  const barChart = (items, labelFn, valueFn, color) => {
    const maxVal = Math.max(...items.map(valueFn), 1);
    return React.createElement('div', { className: 'space-y-1' },
      items.map((item, i) =>
        React.createElement('div', { key: i, className: 'flex items-center gap-2 text-xs' },
          React.createElement('div', { className: 'w-16 text-right text-gray-500 flex-shrink-0' }, labelFn(item)),
          React.createElement('div', { className: 'flex-1 bg-gray-100 rounded-full h-5 overflow-hidden' },
            React.createElement('div', {
              className: `${color} h-full rounded-full flex items-center justify-end pr-2 text-white font-medium`,
              style: { width: `${Math.max((valueFn(item) / maxVal) * 100, valueFn(item) > 0 ? 8 : 0)}%`, minWidth: valueFn(item) > 0 ? '28px' : '0' }
            }, valueFn(item) > 0 ? valueFn(item) : '')
          )
        )
      )
    );
  };

  // Conversion rate
  const conversionRate = analytics && analytics.totalCalls30d > 0
    ? Math.round((analytics.callsWithBooking30d / analytics.totalCalls30d) * 100)
    : 0;

  // Average duration formatted
  const avgDur = analytics?.avgDurationSeconds || 0;
  const avgDurFormatted = avgDur > 0 ? `${Math.floor(avgDur / 60)}:${String(avgDur % 60).padStart(2, '0')}` : '--';

  return React.createElement('div', null,
    React.createElement('h1', { className: 'text-2xl font-bold text-gray-800 mb-6' }, 'Dashboard'),
    React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8' },
      stats.map(s =>
        React.createElement('div', { key: s.label, className: `${s.color} rounded-xl p-6` },
          React.createElement('div', { className: 'text-3xl font-bold' }, s.value),
          React.createElement('div', { className: 'text-sm mt-1 opacity-75' }, s.label)
        )
      )
    ),

    // Call Analytics Section
    analytics && React.createElement('div', { className: 'grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8' },

      // Calls per Day (14-day trend)
      React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border p-6' },
        React.createElement('h2', { className: 'text-lg font-semibold text-gray-800 mb-4' }, '\uD83D\uDCC8 Calls Per Day'),
        (analytics.callsPerDay || []).length > 0
          ? barChart(analytics.callsPerDay, r => formatDay(r.day), r => parseInt(r.calls), 'bg-blue-500')
          : React.createElement('p', { className: 'text-gray-400 text-sm' }, 'No call data yet')
      ),

      // Busiest Hours
      React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border p-6' },
        React.createElement('h2', { className: 'text-lg font-semibold text-gray-800 mb-4' }, '\u23F0 Busiest Hours'),
        (analytics.busiestHours || []).length > 0
          ? barChart(
              analytics.busiestHours.filter(r => parseInt(r.calls) > 0),
              r => formatHour(parseInt(r.hour)),
              r => parseInt(r.calls),
              'bg-purple-500'
            )
          : React.createElement('p', { className: 'text-gray-400 text-sm' }, 'No call data yet')
      ),

      // Booking Stats
      React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border p-6' },
        React.createElement('h2', { className: 'text-lg font-semibold text-gray-800 mb-4' }, '\uD83D\uDCCB Booking Stats'),
        React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
          React.createElement('div', { className: 'bg-blue-50 rounded-lg p-4 text-center' },
            React.createElement('div', { className: 'text-2xl font-bold text-blue-700' }, analytics.totalBookings || 0),
            React.createElement('div', { className: 'text-xs text-blue-600 mt-1' }, 'Total Bookings')
          ),
          React.createElement('div', { className: 'bg-green-50 rounded-lg p-4 text-center' },
            React.createElement('div', { className: 'text-2xl font-bold text-green-700' }, analytics.confirmedBookings || 0),
            React.createElement('div', { className: 'text-xs text-green-600 mt-1' }, 'Confirmed')
          ),
          React.createElement('div', { className: 'bg-red-50 rounded-lg p-4 text-center' },
            React.createElement('div', { className: 'text-2xl font-bold text-red-700' }, analytics.totalNoShows || 0),
            React.createElement('div', { className: 'text-xs text-red-600 mt-1' }, 'No-Shows')
          ),
          React.createElement('div', { className: 'bg-indigo-50 rounded-lg p-4 text-center' },
            React.createElement('div', { className: 'text-2xl font-bold text-indigo-700' }, `${conversionRate}%`),
            React.createElement('div', { className: 'text-xs text-indigo-600 mt-1' }, 'Conversion Rate')
          )
        )
      ),

      // Call Performance
      React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border p-6' },
        React.createElement('h2', { className: 'text-lg font-semibold text-gray-800 mb-4' }, '\uD83D\uDCDE Call Performance'),
        React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
          React.createElement('div', { className: 'bg-gray-50 rounded-lg p-4 text-center' },
            React.createElement('div', { className: 'text-2xl font-bold text-gray-700' }, analytics.totalCalls30d || 0),
            React.createElement('div', { className: 'text-xs text-gray-500 mt-1' }, 'Calls (30 days)')
          ),
          React.createElement('div', { className: 'bg-gray-50 rounded-lg p-4 text-center' },
            React.createElement('div', { className: 'text-2xl font-bold text-gray-700' }, avgDurFormatted),
            React.createElement('div', { className: 'text-xs text-gray-500 mt-1' }, 'Avg Duration')
          ),
          React.createElement('div', { className: 'bg-gray-50 rounded-lg p-4 text-center' },
            React.createElement('div', { className: 'text-2xl font-bold text-gray-700' }, analytics.callsWithBooking30d || 0),
            React.createElement('div', { className: 'text-xs text-gray-500 mt-1' }, 'Resulted in Booking')
          ),
          React.createElement('div', { className: 'bg-gray-50 rounded-lg p-4 text-center' },
            React.createElement('div', { className: 'text-2xl font-bold text-gray-700' },
              analytics.totalCalls30d > 0 ? Math.round(analytics.totalCalls30d / 30) : 0
            ),
            React.createElement('div', { className: 'text-xs text-gray-500 mt-1' }, 'Avg Calls/Day')
          )
        )
      )
    ),

    React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border p-6' },
      React.createElement('h2', { className: 'text-lg font-semibold text-gray-800 mb-4' }, 'Recent Calls'),
      React.createElement('div', { className: 'overflow-x-auto' },
        React.createElement('table', { className: 'w-full text-sm' },
          React.createElement('thead', null,
            React.createElement('tr', { className: 'border-b text-left text-gray-500' },
              React.createElement('th', { className: 'pb-3 pr-4' }, 'Time'),
              React.createElement('th', { className: 'pb-3 pr-4' }, 'Caller'),
              React.createElement('th', { className: 'pb-3 pr-4' }, 'Duration'),
              React.createElement('th', { className: 'pb-3' }, 'Summary')
            )
          ),
          React.createElement('tbody', null,
            (data?.recentCalls || []).map(call =>
              React.createElement('tr', { key: call.id, className: 'border-b last:border-0' },
                React.createElement('td', { className: 'py-3 pr-4 text-gray-500' },
                  new Date(call.started_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                ),
                React.createElement('td', { className: 'py-3 pr-4 font-medium' },
                  call.customer_name || call.caller_phone || 'Unknown'
                ),
                React.createElement('td', { className: 'py-3 pr-4 text-gray-500' },
                  call.duration_seconds ? `${Math.floor(call.duration_seconds / 60)}:${String(call.duration_seconds % 60).padStart(2, '0')}` : '--'
                ),
                React.createElement('td', { className: 'py-3 text-gray-600 truncate max-w-xs' },
                  call.summary || 'No summary'
                )
              )
            )
          )
        )
      ),
      (!data?.recentCalls || data.recentCalls.length === 0) &&
        React.createElement('p', { className: 'text-gray-400 text-center py-8' }, 'No calls yet today')
    )
  );
}

// ============================================
// BOOKINGS PAGE
// ============================================

// Helper to format booking date/time nicely
function formatBookingDateTime(dateStr, timeStr) {
  try {
    if (!dateStr) return 'No date';

    // Parse date - handle YYYY-MM-DD format
    let date;
    if (dateStr.includes('-')) {
      const [year, month, day] = dateStr.split('-');
      date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    } else if (dateStr.includes('/')) {
      // Handle MM/DD/YYYY format if needed
      const [month, day, year] = dateStr.split('/');
      date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    } else {
      // Try parsing as ISO string or timestamp
      date = new Date(dateStr);
    }

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return `${dateStr} ${timeStr || ''}`.trim();
    }

    const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
    const monthName = date.toLocaleDateString('en-US', { month: 'long' });
    const dayNum = date.getDate();

    if (!timeStr || timeStr === 'Flexible') {
      return `${dayName}, ${monthName} ${dayNum}`;
    }

    const [hours, mins] = timeStr.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    const timeFormatted = `${displayHour}:${mins} ${ampm}`;

    return `${dayName}, ${monthName} ${dayNum} at ${timeFormatted}`;
  } catch (e) {
    return `${dateStr} ${timeStr || ''}`.trim();
  }
}

function BookingsPage() {
  const [bookings, setBookings] = useState([]);
  const [modifications, setModifications] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [replyOpenId, setReplyOpenId] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [b, m] = await Promise.all([
        api(`/api/bookings${filter !== 'all' ? '?status=' + filter : ''}`),
        api('/api/modifications')
      ]);
      setBookings(b.bookings || []);
      setModifications(m || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => {
    loadData();
    // Live refresh — refetch when the server pushes a booking or
    // modification event over SSE.
    const onLive = () => loadData();
    window.addEventListener('cmdcenter:refresh', onLive);
    return () => window.removeEventListener('cmdcenter:refresh', onLive);
  }, [loadData]);

  const updateStatus = async (id, status) => {
    const notes = status === 'rejected' ? prompt('Reason for rejection:') : '';
    try {
      await api(`/api/bookings/${id}/status`, { method: 'PUT', body: JSON.stringify({ status, staff_notes: notes || '' }) });
      loadData();
    } catch (err) { alert('Failed to update: ' + err.message); }
  };

  const openReply = (booking) => {
    setReplyOpenId(booking.id);
    setReplyText(`Hi ${booking.customer_name?.split(' ')[0] || 'there'}, unfortunately that time isn't available. Can I offer you `);
  };

  const sendReply = async (booking) => {
    if (!replyText.trim()) return;
    setReplySending(true);
    try {
      await api(`/api/bookings/${booking.id}/sms`, { method: 'POST', body: JSON.stringify({ message: replyText.trim() }) });
      setReplyOpenId(null);
      setReplyText('');
      alert('Message sent!');
    } catch (err) {
      alert('Failed to send: ' + err.message);
    } finally {
      setReplySending(false);
    }
  };

  const processModification = async (id, status) => {
    try {
      await api(`/api/modifications/${id}/status`, { method: 'PUT', body: JSON.stringify({ status, staff_notes: '' }) });
      loadData();
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const markNoShow = async (id, noShow) => {
    try {
      await api(`/api/bookings/${id}/no-show`, { method: 'PUT', body: JSON.stringify({ no_show: noShow }) });
      loadData();
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const statusColors = { pending: 'bg-yellow-100 text-yellow-800', confirmed: 'bg-green-100 text-green-800', rejected: 'bg-red-100 text-red-800', cancelled: 'bg-gray-100 text-gray-800' };

  return React.createElement('div', null,
    React.createElement('h1', { className: 'text-2xl font-bold text-gray-800 mb-6' }, 'Bookings'),

    // Modification requests (if any)
    modifications.length > 0 && React.createElement('div', { className: 'bg-orange-50 border border-orange-200 rounded-xl p-6 mb-6' },
      React.createElement('h2', { className: 'text-lg font-semibold text-orange-800 mb-4' },
        `\u270f\ufe0f ${modifications.length} Pending Change Request${modifications.length > 1 ? 's' : ''}`
      ),
      modifications.map(m =>
        React.createElement('div', { key: m.id, className: 'bg-white rounded-lg p-4 mb-3 flex items-center justify-between' },
          React.createElement('div', null,
            React.createElement('div', { className: 'font-medium' }, `${m.customer_name} — ${m.request_type === 'cancel' ? 'Cancellation' : 'Modification'}`),
            React.createElement('div', { className: 'text-sm text-gray-500' },
              `Original: ${m.original_date || 'N/A'} ${m.original_time || ''}`,
              m.new_date ? ` \u2192 New: ${m.new_date} ${m.new_time || ''}` : ''
            ),
            m.details && React.createElement('div', { className: 'text-sm text-gray-600 mt-1' }, m.details)
          ),
          React.createElement('div', { className: 'flex gap-2' },
            React.createElement('button', {
              onClick: () => processModification(m.id, 'processed'),
              className: 'bg-green-500 hover:bg-green-600 text-white px-3 py-1 rounded text-sm'
            }, 'Done'),
            React.createElement('button', {
              onClick: () => processModification(m.id, 'rejected'),
              className: 'bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded text-sm'
            }, 'Reject')
          )
        )
      )
    ),

    // Filter tabs
    React.createElement('div', { className: 'flex gap-2 mb-4' },
      ['all', 'pending', 'confirmed', 'rejected', 'cancelled'].map(s =>
        React.createElement('button', {
          key: s, onClick: () => setFilter(s),
          className: `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${filter === s ? 'bg-golf-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`
        }, s.charAt(0).toUpperCase() + s.slice(1))
      )
    ),

    // Bookings list
    React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border' },
      loading
        ? React.createElement('p', { className: 'p-8 text-gray-400 text-center' }, 'Loading...')
        : bookings.length === 0
          ? React.createElement('p', { className: 'p-8 text-gray-400 text-center' }, filter === 'all' ? 'No bookings yet' : `No ${filter} bookings`)
          : React.createElement('div', { className: 'divide-y' },
              bookings.map(b =>
                React.createElement('div', { key: b.id, className: 'border-b last:border-0' },
                  // Main booking row
                  React.createElement('div', { className: 'p-4 flex items-center justify-between hover:bg-gray-50' },
                    React.createElement('div', { className: 'flex-1' },
                      React.createElement('div', { className: 'flex items-center gap-3 flex-wrap' },
                        React.createElement('span', { className: 'font-semibold' }, b.customer_name || 'Unknown'),
                        React.createElement('span', { className: `px-2 py-0.5 rounded-full text-xs ${statusColors[b.status] || ''}` }, b.status),
                        // Holes badge \u2014 LARGE on purpose. A real customer was
                        // booked for the wrong number of holes when this was
                        // surfaced as a tiny text-xs pill; staff missed it. We
                        // upsize the 9 / 18 markers so they\u2019re the most visible
                        // thing in the row aside from the customer name. NULL
                        // rows (pre-migration 010) stay subtle so they don\u2019t
                        // visually compete with real, captured data.
                        b.holes === 18 && React.createElement('span', {
                          className: 'px-3 py-1.5 rounded-lg text-base font-bold bg-emerald-100 text-emerald-800 border-2 border-emerald-300 shadow-sm'
                        }, '\u26f3 18 HOLES'),
                        b.holes === 9 && React.createElement('span', {
                          className: 'px-3 py-1.5 rounded-lg text-base font-bold bg-amber-100 text-amber-800 border-2 border-amber-300 shadow-sm'
                        }, '\u26f3 9 HOLES (back nine)'),
                        b.holes == null && React.createElement('span', {
                          className: 'px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600',
                          title: 'Holes not captured at booking time \u2014 confirm with caller before approving'
                        }, '\u26f3 holes: ?'),
                        b.no_show && React.createElement('span', { className: 'px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-800 font-medium' }, 'NO-SHOW')
                      ),
                      React.createElement('div', { className: 'text-sm text-gray-600 font-medium mt-1' },
                        formatBookingDateTime(b.requested_date, b.requested_time)
                      ),
                      React.createElement('div', { className: 'text-sm text-gray-500 mt-1' },
                        `${b.party_size} player${b.party_size > 1 ? 's' : ''} \u2022 ${b.num_carts || 0} cart${b.num_carts !== 1 ? 's' : ''}`
                      ),
                      React.createElement('div', { className: 'text-sm text-gray-400 flex items-center gap-2' },
                        `${b.customer_phone || ''} ${b.customer_email ? '\u2022 ' + b.customer_email : ''}`,
                        b.card_last_four && React.createElement('span', {
                          className: 'inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-700',
                          title: `Card on file ending in ${b.card_last_four}`
                        }, `\uD83D\uDCB3 ****${b.card_last_four}`)
                      ),
                      b.special_requests && React.createElement('div', { className: 'text-sm text-gray-600 mt-1 italic' }, b.special_requests)
                    ),
                    b.status === 'pending' && React.createElement('div', { className: 'flex gap-2 ml-4' },
                      React.createElement('button', {
                        onClick: () => updateStatus(b.id, 'confirmed'),
                        className: 'bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium'
                      }, 'Confirm'),
                      React.createElement('button', {
                        onClick: () => updateStatus(b.id, 'rejected'),
                        className: 'bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium'
                      }, 'Reject'),
                      b.customer_phone && React.createElement('button', {
                        onClick: () => replyOpenId === b.id ? setReplyOpenId(null) : openReply(b),
                        className: 'bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium'
                      }, '\uD83D\uDCAC Reply')
                    ),
                    b.status === 'confirmed' && React.createElement('div', { className: 'flex gap-2 ml-4' },
                      !b.no_show
                        ? React.createElement('button', {
                            onClick: () => { if (confirm(`Mark ${b.customer_name} as no-show?`)) markNoShow(b.id, true); },
                            className: 'bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium'
                          }, 'No-Show')
                        : React.createElement('button', {
                            onClick: () => markNoShow(b.id, false),
                            className: 'bg-gray-400 hover:bg-gray-500 text-white px-3 py-1.5 rounded-lg text-sm font-medium'
                          }, 'Undo No-Show')
                    )
                  ),
                  // Inline reply panel — expands when Reply is clicked
                  replyOpenId === b.id && React.createElement('div', { className: 'px-4 pb-4 bg-blue-50 border-t border-blue-100' },
                    React.createElement('p', { className: 'text-xs text-blue-600 font-medium mt-3 mb-2' },
                      `\uD83D\uDCF1 Text to ${b.customer_name?.split(' ')[0] || 'customer'} at ${b.customer_phone}`
                    ),
                    React.createElement('textarea', {
                      className: 'w-full border border-blue-200 rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-300',
                      rows: 3,
                      value: replyText,
                      onChange: e => setReplyText(e.target.value),
                      placeholder: 'Type your message...'
                    }),
                    React.createElement('div', { className: 'flex items-center justify-between mt-2' },
                      React.createElement('span', { className: `text-xs ${replyText.length > 160 ? 'text-red-500 font-medium' : 'text-gray-400'}` },
                        `${replyText.length}/160 chars${replyText.length > 160 ? ' — will split into 2 messages' : ''}`
                      ),
                      React.createElement('div', { className: 'flex gap-2' },
                        React.createElement('button', {
                          onClick: () => { setReplyOpenId(null); setReplyText(''); },
                          className: 'px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700'
                        }, 'Cancel'),
                        React.createElement('button', {
                          onClick: () => sendReply(b),
                          disabled: replySending || !replyText.trim(),
                          className: 'bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-sm font-medium'
                        }, replySending ? 'Sending...' : 'Send Text')
                      )
                    )
                  )
                )
              )
            )
    )
  );
}

// ============================================
// CUSTOMERS PAGE — Contact List
// ============================================
function ContactModal({ contact, onClose, onSave }) {
  // Parse custom_greetings from DB (JSONB array) or fall back to legacy custom_greeting
  const initGreetings = () => {
    if (contact?.custom_greetings && Array.isArray(contact.custom_greetings) && contact.custom_greetings.length > 0) {
      return contact.custom_greetings;
    }
    if (contact?.custom_greeting) return [contact.custom_greeting];
    return [''];
  };

  const [form, setForm] = useState({
    name: contact?.name || '',
    phone: contact?.phone || '',
    email: contact?.email || '',
    notes: contact?.notes || '',
    customer_knowledge: contact?.customer_knowledge || ''
  });
  const [greetings, setGreetings] = useState(initGreetings);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!form.name && !form.phone) return alert('Please enter at least a name or phone number.');
    setSaving(true);
    try {
      const payload = {
        ...form,
        custom_greetings: greetings.filter(g => g && g.trim())
      };
      if (contact?.id) {
        await api(`/api/customers/${contact.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/customers', { method: 'POST', body: JSON.stringify(payload) });
      }
      onSave();
    } catch (err) { alert('Failed to save: ' + err.message); }
    finally { setSaving(false); }
  };

  const field = (label, key, type = 'text', placeholder = '') =>
    React.createElement('div', { className: 'mb-4' },
      React.createElement('label', { className: 'block text-sm font-medium text-gray-700 mb-1' }, label),
      React.createElement('input', {
        type, placeholder, value: form[key],
        onChange: e => setForm(f => ({ ...f, [key]: e.target.value })),
        className: 'w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-golf-500 outline-none'
      })
    );

  const addGreeting = () => setGreetings(g => [...g, '']);
  const removeGreeting = (idx) => setGreetings(g => g.filter((_, i) => i !== idx));
  const updateGreeting = (idx, val) => setGreetings(g => g.map((v, i) => i === idx ? val : v));

  return React.createElement('div', { className: 'fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50', onMouseDown: e => { if (e.target === e.currentTarget) onClose(); } },
    React.createElement('div', { className: 'bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto' },
      React.createElement('div', { className: 'flex items-center justify-between mb-6' },
        React.createElement('h2', { className: 'text-lg font-bold text-gray-800' }, contact?.id ? 'Edit Contact' : 'Add New Contact'),
        React.createElement('button', { onClick: onClose, className: 'text-gray-400 hover:text-gray-600 text-xl' }, '✕')
      ),
      field('Full Name', 'name', 'text', 'e.g., Jane Smith'),
      field('Phone Number', 'phone', 'tel', 'e.g., (416) 555-1234'),
      field('Email', 'email', 'email', 'e.g., jane@email.com'),
      React.createElement('div', { className: 'mb-4' },
        React.createElement('label', { className: 'block text-sm font-medium text-gray-700 mb-1' }, 'Notes'),
        React.createElement('textarea', {
          value: form.notes, rows: 2, placeholder: 'Any notes about this customer...',
          onChange: e => setForm(f => ({ ...f, notes: e.target.value })),
          className: 'w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-golf-500 outline-none resize-none'
        })
      ),

      // Customer Knowledge for AI
      React.createElement('div', { className: 'mb-4' },
        React.createElement('label', { className: 'block text-sm font-medium text-gray-700 mb-1' }, 'Customer Knowledge (for AI)'),
        React.createElement('textarea', {
          value: form.customer_knowledge, rows: 3,
          placeholder: 'e.g., "Prefers morning tee times. Member since 2020. Usually plays with his son. Likes to walk, no cart."',
          onChange: e => setForm(f => ({ ...f, customer_knowledge: e.target.value })),
          className: 'w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-golf-500 outline-none resize-none'
        }),
        React.createElement('p', { className: 'text-xs text-gray-400 mt-1' }, 'The AI will know this about the caller and use it naturally in conversation.')
      ),

      // Multiple Custom Greetings
      React.createElement('div', { className: 'mb-4' },
        React.createElement('div', { className: 'flex items-center justify-between mb-1' },
          React.createElement('label', { className: 'block text-sm font-medium text-gray-700' }, 'Custom Greetings'),
          React.createElement('button', {
            onClick: addGreeting, type: 'button',
            className: 'text-xs px-2 py-1 bg-golf-50 hover:bg-golf-100 text-golf-700 rounded border border-golf-200'
          }, '+ Add Greeting')
        ),
        React.createElement('p', { className: 'text-xs text-gray-400 mb-2' }, 'Add multiple greetings — the AI will randomly pick one each time they call. Use {name} for their name.'),
        greetings.map((g, idx) =>
          React.createElement('div', { key: idx, className: 'flex gap-2 mb-2' },
            React.createElement('input', {
              type: 'text', value: g,
              placeholder: idx === 0 ? 'e.g., "Hey {name}! How are you today?"' : 'e.g., "{name}! Good to hear from you!"',
              onChange: e => updateGreeting(idx, e.target.value),
              className: 'flex-1 border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-golf-500 outline-none'
            }),
            greetings.length > 1 && React.createElement('button', {
              onClick: () => removeGreeting(idx), type: 'button',
              className: 'text-red-400 hover:text-red-600 text-lg px-1'
            }, '✕')
          )
        )
      ),

      React.createElement('div', { className: 'flex gap-3 justify-end' },
        React.createElement('button', { onClick: onClose, className: 'px-4 py-2 text-sm text-gray-600 hover:text-gray-800' }, 'Cancel'),
        React.createElement('button', {
          onClick: handleSave, disabled: saving,
          className: 'px-5 py-2 bg-golf-600 hover:bg-golf-700 text-white text-sm font-medium rounded-lg disabled:opacity-50'
        }, saving ? 'Saving...' : contact?.id ? 'Save Changes' : 'Add Contact')
      )
    )
  );
}

// ============================================
// CUSTOMER DETAIL PANEL (call history + bookings)
// ============================================
function CustomerDetailPanel({ customerId, onClose, onEdit }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('calls');
  const [expandedCall, setExpandedCall] = useState(null); // call ID to show transcript

  useEffect(() => {
    if (!customerId) return;
    setLoading(true);
    api(`/api/customers/${customerId}`)
      .then(d => setData(d))
      .catch(err => console.error('Failed to load customer:', err))
      .finally(() => setLoading(false));
  }, [customerId]);

  if (!customerId) return null;

  const formatDate = (d) => {
    if (!d) return '--';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const formatTime = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  const formatDuration = (s) => {
    if (!s) return '--';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const c = data?.customer;
  const calls = data?.calls || [];
  const bookings = data?.bookings || [];

  return React.createElement('div', { className: 'fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50', onMouseDown: e => { if (e.target === e.currentTarget) onClose(); } },
    React.createElement('div', {
      className: 'bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col'
    },
      // Header
      loading ? React.createElement('div', { className: 'p-8 text-center text-gray-400' }, 'Loading...') :
      React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'p-6 border-b' },
          React.createElement('div', { className: 'flex items-center justify-between' },
            React.createElement('div', { className: 'flex items-center gap-4' },
              React.createElement('div', { className: 'w-14 h-14 rounded-full bg-golf-600 flex items-center justify-center text-white font-bold text-lg' },
                c?.name ? c.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '?'
              ),
              React.createElement('div', null,
                React.createElement('h2', { className: 'text-xl font-bold text-gray-800' }, c?.name || 'Unknown'),
                React.createElement('div', { className: 'flex gap-3 mt-1' },
                  c?.phone && React.createElement('span', { className: 'text-sm text-gray-500' }, c.phone),
                  c?.email && React.createElement('span', { className: 'text-sm text-gray-500' }, c.email)
                )
              )
            ),
            React.createElement('div', { className: 'flex items-center gap-2' },
              React.createElement('button', {
                onClick: () => onEdit(c),
                className: 'text-xs px-3 py-1.5 border border-gray-200 hover:border-golf-500 hover:text-golf-600 text-gray-500 rounded-lg'
              }, 'Edit'),
              React.createElement('button', { onClick: onClose, className: 'text-gray-400 hover:text-gray-600 text-xl ml-2' }, '✕')
            )
          ),
          // Stats row
          React.createElement('div', { className: 'flex gap-6 mt-4' },
            React.createElement('div', null,
              React.createElement('div', { className: 'text-xs text-gray-400' }, 'Total Calls'),
              React.createElement('div', { className: 'text-lg font-bold text-gray-700' }, c?.call_count || 0)
            ),
            React.createElement('div', null,
              React.createElement('div', { className: 'text-xs text-gray-400' }, 'First Call'),
              React.createElement('div', { className: 'text-sm font-medium text-gray-600' }, formatDate(c?.first_call_at))
            ),
            React.createElement('div', null,
              React.createElement('div', { className: 'text-xs text-gray-400' }, 'Last Call'),
              React.createElement('div', { className: 'text-sm font-medium text-gray-600' }, formatDate(c?.last_call_at))
            ),
            (c?.custom_greetings?.length > 0 || c?.custom_greeting) && React.createElement('div', null,
              React.createElement('div', { className: 'text-xs text-gray-400' }, 'Greetings'),
              React.createElement('div', { className: 'text-sm font-medium text-golf-600' },
                (c.custom_greetings?.filter(g => g && g.trim()).length || (c.custom_greeting ? 1 : 0)) + ' custom'
              )
            ),
            c?.customer_knowledge && React.createElement('div', { className: 'flex-1' },
              React.createElement('div', { className: 'text-xs text-gray-400' }, 'AI Knowledge'),
              React.createElement('div', { className: 'text-xs text-gray-500 italic truncate' }, c.customer_knowledge)
            )
          )
        ),

        // Tabs
        React.createElement('div', { className: 'flex border-b px-6' },
          React.createElement('button', {
            onClick: () => setTab('calls'),
            className: `px-4 py-2.5 text-sm font-medium border-b-2 ${tab === 'calls' ? 'border-golf-600 text-golf-700' : 'border-transparent text-gray-400 hover:text-gray-600'}`
          }, `Calls (${calls.length})`),
          React.createElement('button', {
            onClick: () => setTab('bookings'),
            className: `px-4 py-2.5 text-sm font-medium border-b-2 ${tab === 'bookings' ? 'border-golf-600 text-golf-700' : 'border-transparent text-gray-400 hover:text-gray-600'}`
          }, `Bookings (${bookings.length})`)
        ),

        // Content
        React.createElement('div', { className: 'flex-1 overflow-y-auto p-6' },
          tab === 'calls' ? (
            calls.length === 0
              ? React.createElement('p', { className: 'text-gray-400 text-sm text-center py-8' }, 'No call history yet.')
              : calls.map(call =>
                  React.createElement('div', { key: call.id, className: 'border rounded-lg mb-3 hover:bg-gray-50' },
                    React.createElement('div', {
                      className: 'p-3 cursor-pointer',
                      onClick: () => setExpandedCall(expandedCall === call.id ? null : call.id)
                    },
                      React.createElement('div', { className: 'flex items-center justify-between mb-1' },
                        React.createElement('div', { className: 'flex items-center gap-2' },
                          React.createElement('span', { className: 'text-sm font-medium text-gray-700' },
                            formatDate(call.started_at) + ' at ' + formatTime(call.started_at)
                          ),
                          call.transcript && React.createElement('span', {
                            className: 'text-xs text-golf-500'
                          }, expandedCall === call.id ? '▼ transcript' : '▶ transcript')
                        ),
                        React.createElement('span', { className: 'text-xs text-gray-400' },
                          formatDuration(call.duration_seconds)
                        )
                      ),
                      call.summary && React.createElement('p', { className: 'text-xs text-gray-500 mt-1' }, call.summary),
                      call.actions_taken && React.createElement('div', { className: 'mt-1' },
                        React.createElement('span', { className: 'text-xs text-golf-600' }, 'Actions: ' + (
                          Array.isArray(call.actions_taken) ? call.actions_taken.join(', ') : String(call.actions_taken)
                        ))
                      )
                    ),
                    // Expandable transcript
                    expandedCall === call.id && call.transcript && React.createElement('div', {
                      className: 'border-t bg-gray-50 px-3 py-3 rounded-b-lg'
                    },
                      React.createElement('div', { className: 'text-xs font-medium text-gray-500 mb-2' }, 'Call Transcript'),
                      React.createElement('div', { className: 'space-y-1.5 max-h-64 overflow-y-auto text-xs' },
                        call.transcript.split('\n').filter(line => line.trim()).map((line, i) => {
                          const isCaller = line.toLowerCase().startsWith('caller:');
                          const isAssistant = line.toLowerCase().startsWith('assistant:');
                          const label = isCaller ? 'Caller' : isAssistant ? 'AI' : null;
                          const text = label ? line.substring(line.indexOf(':') + 1).trim() : line;
                          return React.createElement('div', {
                            key: i,
                            className: `flex gap-2 ${isCaller ? '' : 'flex-row-reverse'}`
                          },
                            React.createElement('div', {
                              className: `max-w-[85%] px-3 py-1.5 rounded-lg ${
                                isCaller
                                  ? 'bg-white border text-gray-700'
                                  : isAssistant
                                    ? 'bg-golf-50 border border-golf-200 text-golf-800'
                                    : 'bg-gray-100 text-gray-600'
                              }`
                            },
                              label && React.createElement('span', {
                                className: `font-semibold ${isCaller ? 'text-gray-500' : 'text-golf-600'}`
                              }, label + ': '),
                              text
                            )
                          );
                        })
                      )
                    ),
                    // No transcript available
                    expandedCall === call.id && !call.transcript && React.createElement('div', {
                      className: 'border-t bg-gray-50 px-3 py-3 rounded-b-lg'
                    },
                      React.createElement('p', { className: 'text-xs text-gray-400 italic text-center' }, 'No transcript available for this call.')
                    )
                  )
                )
          ) : (
            bookings.length === 0
              ? React.createElement('p', { className: 'text-gray-400 text-sm text-center py-8' }, 'No bookings yet.')
              : bookings.map(b =>
                  React.createElement('div', { key: b.id, className: 'border rounded-lg p-3 mb-3 hover:bg-gray-50' },
                    React.createElement('div', { className: 'flex items-center justify-between' },
                      React.createElement('div', null,
                        React.createElement('span', { className: 'text-sm font-medium text-gray-700' },
                          formatDate(b.requested_date)
                        ),
                        b.requested_time && React.createElement('span', { className: 'text-sm text-gray-500 ml-2' }, b.requested_time),
                        React.createElement('span', { className: 'text-xs text-gray-400 ml-2' }, `${b.party_size} player${b.party_size !== 1 ? 's' : ''}`)
                      ),
                      React.createElement('span', {
                        className: `text-xs px-2 py-0.5 rounded-full font-medium ${
                          b.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                          b.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                          b.status === 'cancelled' ? 'bg-red-100 text-red-700' :
                          'bg-gray-100 text-gray-600'
                        }`
                      }, b.status)
                    ),
                    b.special_requests && React.createElement('p', { className: 'text-xs text-gray-500 mt-1' }, b.special_requests)
                  )
                )
          )
        )
      )
    )
  );
}

function CustomersPage() {
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState(null); // null | 'add' | {contact obj for edit}
  const [detailId, setDetailId] = useState(null); // customer ID to show detail panel

  const loadCustomers = async (q = '') => {
    try {
      const d = await api(`/api/customers?search=${encodeURIComponent(q)}`);
      setCustomers(d.customers || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => {
    const t = setTimeout(() => loadCustomers(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const handleSaved = () => { setModal(null); loadCustomers(search); };
  const handleRefresh = () => { setRefreshing(true); loadCustomers(search); };

  const initials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  };
  const avatarColor = (name) => {
    const colors = ['bg-golf-600','bg-blue-500','bg-purple-500','bg-orange-500','bg-pink-500','bg-teal-500'];
    const idx = name ? name.charCodeAt(0) % colors.length : 0;
    return colors[idx];
  };

  const unnamed = customers.filter(c => !c.name);
  const named   = customers.filter(c => c.name);

  return React.createElement('div', null,
    // Header
    React.createElement('div', { className: 'flex items-center justify-between mb-6' },
      React.createElement('div', { className: 'flex items-center gap-3' },
        React.createElement('h1', { className: 'text-2xl font-bold text-gray-800' }, 'Contacts'),
        React.createElement('button', {
          onClick: handleRefresh, disabled: refreshing,
          className: 'text-sm px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-600 rounded-lg disabled:opacity-50'
        }, refreshing ? '⟳ Refreshing...' : '⟳ Refresh')
      ),
      React.createElement('button', {
        onClick: () => setModal('add'),
        className: 'flex items-center gap-2 px-4 py-2 bg-golf-600 hover:bg-golf-700 text-white text-sm font-medium rounded-lg transition-colors'
      }, '+ Add Contact')
    ),

    // Search
    React.createElement('input', {
      type: 'text', placeholder: '🔍  Search by name or phone...',
      value: search, onChange: e => setSearch(e.target.value),
      className: 'w-full max-w-md px-4 py-2 border border-gray-300 rounded-lg mb-6 focus:ring-2 focus:ring-golf-500 outline-none text-sm'
    }),

    // Unknown callers banner
    unnamed.length > 0 && !search && React.createElement('div', { className: 'bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6' },
      React.createElement('div', { className: 'flex items-center gap-2 mb-2' },
        React.createElement('span', { className: 'text-amber-600 font-semibold text-sm' }, `⚠️  ${unnamed.length} caller${unnamed.length > 1 ? 's' : ''} without a name`),
        React.createElement('span', { className: 'text-amber-500 text-xs' }, '— click Edit to add their name')
      ),
      unnamed.map(c => React.createElement('div', { key: c.id, className: 'flex items-center justify-between bg-white rounded-lg px-3 py-2 mb-1.5 border border-amber-100' },
        React.createElement('div', null,
          React.createElement('span', { className: 'text-sm font-mono text-gray-700' }, c.phone || 'No phone'),
          React.createElement('span', { className: 'text-xs text-gray-400 ml-2' }, `${c.call_count} call${c.call_count !== 1 ? 's' : ''}`)
        ),
        React.createElement('button', {
          onClick: () => setModal(c),
          className: 'text-xs px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg'
        }, 'Edit')
      ))
    ),

    // Contact list
    loading
      ? React.createElement('p', { className: 'text-gray-400 text-center py-12' }, 'Loading...')
      : named.length === 0 && !unnamed.length
        ? React.createElement('div', { className: 'text-center py-16' },
            React.createElement('div', { className: 'text-5xl mb-3' }, '👥'),
            React.createElement('p', { className: 'text-gray-400' }, 'No contacts yet. They\'ll appear automatically when people call.')
          )
        : React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border overflow-hidden' },
            named.map((c, i) =>
              React.createElement('div', {
                key: c.id,
                className: `flex items-center gap-4 px-4 py-3 hover:bg-gray-50 cursor-pointer ${i < named.length - 1 ? 'border-b' : ''}`,
                onClick: () => setDetailId(c.id)
              },
                // Avatar
                React.createElement('div', { className: `w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 ${avatarColor(c.name)}` },
                  initials(c.name)
                ),
                // Info
                React.createElement('div', { className: 'flex-1 min-w-0' },
                  React.createElement('div', { className: 'font-semibold text-gray-800 text-sm' }, c.name),
                  React.createElement('div', { className: 'flex gap-3 mt-0.5' },
                    c.phone && React.createElement('span', { className: 'text-xs text-gray-500' }, '📞 ' + c.phone),
                    c.email && React.createElement('span', { className: 'text-xs text-gray-500' }, '✉️ ' + c.email)
                  )
                ),
                // Stats
                React.createElement('div', { className: 'text-right flex-shrink-0 hidden sm:block' },
                  React.createElement('div', { className: 'text-xs font-medium text-gray-600' }, `${c.call_count} call${c.call_count !== 1 ? 's' : ''}`),
                  React.createElement('div', { className: 'text-xs text-gray-400' },
                    c.last_call_at ? new Date(c.last_call_at).toLocaleDateString() : '--'
                  )
                ),
                // Edit button
                React.createElement('button', {
                  onClick: (e) => { e.stopPropagation(); setModal(c); },
                  className: 'text-xs px-3 py-1.5 border border-gray-200 hover:border-golf-500 hover:text-golf-600 text-gray-500 rounded-lg transition-colors ml-2'
                }, 'Edit')
              )
            )
          ),

    // Modal
    modal && React.createElement(ContactModal, {
      contact: modal === 'add' ? null : modal,
      onClose: () => setModal(null),
      onSave: handleSaved
    }),

    // Customer detail panel
    detailId && React.createElement(CustomerDetailPanel, {
      customerId: detailId,
      onClose: () => setDetailId(null),
      onEdit: (c) => { setDetailId(null); setModal(c); }
    })
  );
}

// ============================================
// CALL LOGS PAGE
// ============================================
function CallLogsPage() {
  const [calls, setCalls] = useState([]);
  const [selectedCall, setSelectedCall] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/api/calls').then(d => setCalls(d.calls || [])).catch(console.error).finally(() => setLoading(false));
  }, []);

  const viewTranscript = async (id) => {
    const call = await api(`/api/calls/${id}`);
    setSelectedCall(call);
  };

  return React.createElement('div', null,
    React.createElement('h1', { className: 'text-2xl font-bold text-gray-800 mb-6' }, 'Call Logs'),

    selectedCall && React.createElement('div', { className: 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4' },
      React.createElement('div', { className: 'bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6' },
        React.createElement('div', { className: 'flex justify-between items-center mb-4' },
          React.createElement('h3', { className: 'text-lg font-semibold' }, `Call — ${selectedCall.customer_name || selectedCall.caller_phone}`),
          React.createElement('button', { onClick: () => setSelectedCall(null), className: 'text-gray-400 hover:text-gray-600 text-2xl' }, '\u00d7')
        ),
        React.createElement('div', { className: 'text-sm text-gray-500 mb-4' },
          `${new Date(selectedCall.started_at).toLocaleString()} \u2022 ${selectedCall.duration_seconds || 0}s \u2022 ${selectedCall.status}`
        ),
        selectedCall.summary && React.createElement('div', { className: 'bg-blue-50 rounded-lg p-3 mb-4 text-sm' }, selectedCall.summary),
        React.createElement('div', { className: 'bg-gray-50 rounded-lg p-4' },
          React.createElement('h4', { className: 'font-medium mb-2 text-sm text-gray-500' }, 'Transcript'),
          React.createElement('pre', { className: 'text-sm whitespace-pre-wrap font-mono' }, selectedCall.transcript || 'No transcript available')
        )
      )
    ),

    React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border' },
      loading
        ? React.createElement('p', { className: 'p-8 text-gray-400 text-center' }, 'Loading...')
        : calls.length === 0
          ? React.createElement('p', { className: 'p-8 text-gray-400 text-center' }, 'No calls recorded yet')
          : React.createElement('div', { className: 'divide-y' },
              calls.map(call =>
                React.createElement('div', {
                  key: call.id,
                  onClick: () => viewTranscript(call.id),
                  className: 'p-4 hover:bg-gray-50 cursor-pointer flex items-center justify-between'
                },
                  React.createElement('div', null,
                    React.createElement('span', { className: 'font-medium' }, call.customer_name || call.caller_phone || 'Unknown'),
                    React.createElement('div', { className: 'text-sm text-gray-500' }, call.summary || 'No summary')
                  ),
                  React.createElement('div', { className: 'text-right text-sm text-gray-400' },
                    React.createElement('div', null, new Date(call.started_at).toLocaleString()),
                    React.createElement('div', null,
                      call.duration_seconds ? `${Math.floor(call.duration_seconds / 60)}:${String(call.duration_seconds % 60).padStart(2, '0')}` : '--'
                    )
                  )
                )
              )
            )
    )
  );
}

// ============================================
// DAILY INSTRUCTIONS TAB COMPONENT
// ============================================
function DailyInstructionsTab({ settings, saveSetting, saving }) {
  // Build date keys for today + 3 days ahead
  const toDateKey = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toLocaleDateString('en-CA'); // YYYY-MM-DD
  };
  const toDisplayDate = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    if (offsetDays === 0) return 'Today';
    if (offsetDays === 1) return 'Tomorrow';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  };

  const days = [0, 1, 2, 3].map(i => ({ offset: i, key: toDateKey(i), label: toDisplayDate(i) }));

  // Local state: one entry per day key
  const stored = settings['daily_instructions']?.value || {};
  const [local, setLocal] = useState(() =>
    Object.fromEntries(days.map(d => [d.key, { active: !!stored[d.key]?.active, message: stored[d.key]?.message || '' }]))
  );
  const [savedKey, setSavedKey] = useState('');

  useEffect(() => {
    const s = settings['daily_instructions']?.value || {};
    setLocal(Object.fromEntries(days.map(d => [d.key, { active: !!s[d.key]?.active, message: s[d.key]?.message || '' }])));
  }, [settings]);

  const updateLocal = (key, field, value) => setLocal(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));

  const saveDay = async (dateKey) => {
    const updated = { ...stored };
    updated[dateKey] = { ...local[dateKey], updated_at: new Date().toISOString() };
    await saveSetting('daily_instructions', updated);
    setSavedKey(dateKey);
    setTimeout(() => setSavedKey(''), 2000);
  };

  const clearDay = async (dateKey) => {
    const updated = { ...stored };
    updated[dateKey] = { active: false, message: '', updated_at: new Date().toISOString() };
    await saveSetting('daily_instructions', updated);
    setLocal(prev => ({ ...prev, [dateKey]: { active: false, message: '' } }));
  };

  // Built-in starter chips — common scenarios most courses hit. Always
  // visible; cannot be removed. Tenants who want their own phrasings add
  // them via the "Add your own" input below — those chips ARE removable.
  const EXAMPLES = [
    'Cart path only today due to wet conditions.',
    'Back 9 closed for aeration — front 9 only.',
    'Course running ~30 min behind — expect some delays.',
    'Power carts unavailable — pull carts only.',
    'Pro shop closed — bookings by phone only.',
    'Dress code strictly enforced — collared shirts required.',
    'Beverage cart not running today.',
    'Driving range closed for maintenance.',
  ];

  // Custom chips — saved per-tenant in settings.daily_instruction_quickfills
  // as an array of strings. Loaded once from the same `settings` blob the
  // rest of this component already reads, so no extra API call needed.
  const customChipsRaw = settings['daily_instruction_quickfills']?.value;
  const initialCustom = Array.isArray(customChipsRaw) ? customChipsRaw : [];
  const [customChips, setCustomChips] = useState(initialCustom);
  const [newChip, setNewChip] = useState('');
  const [chipSaving, setChipSaving] = useState(false);

  // Re-sync from settings when the parent reloads (e.g. after another save).
  useEffect(() => {
    const v = settings['daily_instruction_quickfills']?.value;
    setCustomChips(Array.isArray(v) ? v : []);
  }, [settings]);

  const persistCustomChips = async (next) => {
    setChipSaving(true);
    try {
      await saveSetting('daily_instruction_quickfills', next);
      setCustomChips(next);
    } catch (_) {
      // saveSetting handles its own error UI
    } finally {
      setChipSaving(false);
    }
  };

  const addCustomChip = async () => {
    const t = newChip.trim();
    if (!t) return;
    if (customChips.includes(t) || EXAMPLES.includes(t)) {
      setNewChip(''); // already there, just clear
      return;
    }
    await persistCustomChips([...customChips, t]);
    setNewChip('');
  };

  const removeCustomChip = async (chip) => {
    await persistCustomChips(customChips.filter(c => c !== chip));
  };

  return React.createElement('div', null,
    // Header
    React.createElement('div', { className: 'mb-6' },
      React.createElement('h2', { className: 'text-xl font-bold text-gray-800 mb-1' }, '📋 Daily Instructions'),
      React.createElement('p', { className: 'text-sm text-gray-500' },
        'Set special instructions per day. The AI will proactively tell every caller — and can answer questions about upcoming days too.'
      )
    ),

    // Quick examples strip — built-ins + custom user-saved chips.
    React.createElement('div', { className: 'mb-6 p-4 bg-gray-50 rounded-xl border' },
      React.createElement('p', { className: 'text-xs font-medium text-gray-500 mb-2' }, '⚡ Quick fill — click to copy to today below:'),
      React.createElement('div', { className: 'flex flex-wrap gap-2 mb-3' },
        // Built-in chips
        EXAMPLES.map(ex => React.createElement('button', {
          key: 'builtin:' + ex,
          onClick: () => {
            const todayKey = toDateKey(0);
            updateLocal(todayKey, 'message', ex);
          },
          className: 'text-xs px-2.5 py-1 bg-white hover:bg-golf-50 hover:text-golf-700 border border-gray-200 rounded-lg transition-colors text-gray-600'
        }, ex)),
        // Custom user chips — same look, but with a small × on hover so the
        // operator can remove the ones they don't want anymore. Click on the
        // text still copies; click on the × removes.
        customChips.map(chip => React.createElement('span', {
          key: 'custom:' + chip,
          className: 'inline-flex items-center text-xs bg-white border border-amber-200 rounded-lg overflow-hidden'
        },
          React.createElement('button', {
            onClick: () => {
              const todayKey = toDateKey(0);
              updateLocal(todayKey, 'message', chip);
            },
            className: 'px-2.5 py-1 hover:bg-amber-50 hover:text-amber-800 transition-colors text-gray-700'
          }, chip),
          React.createElement('button', {
            onClick: () => removeCustomChip(chip),
            disabled: chipSaving,
            title: 'Remove this custom chip',
            className: 'px-1.5 py-1 text-gray-400 hover:text-red-600 hover:bg-red-50 border-l border-amber-100 disabled:opacity-50'
          }, '×')
        ))
      ),
      // Add-your-own input. Save on Enter or button click. Pressing the
      // input while focused doesn't submit the parent day card — the input
      // is its own scope.
      React.createElement('div', { className: 'flex gap-2 items-center pt-2 border-t border-gray-200' },
        React.createElement('span', { className: 'text-xs font-medium text-gray-500 shrink-0' }, '+ Your own:'),
        React.createElement('input', {
          type: 'text',
          placeholder: 'e.g. Greens just aerated — putting may be slow',
          value: newChip,
          onChange: e => setNewChip(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); addCustomChip(); } },
          maxLength: 200,
          className: 'flex-1 text-xs px-2.5 py-1 bg-white border border-gray-200 rounded-lg focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none'
        }),
        React.createElement('button', {
          onClick: addCustomChip,
          disabled: chipSaving || !newChip.trim(),
          className: 'text-xs px-3 py-1 rounded-lg font-medium transition-colors bg-golf-600 hover:bg-golf-700 text-white disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed'
        }, chipSaving ? 'Saving…' : 'Add chip')
      )
    ),

    // Day cards
    React.createElement('div', { className: 'flex flex-col gap-4' },
      days.map(({ key, label, offset }) => {
        const entry = local[key] || { active: false, message: '' };
        const isToday = offset === 0;
        const hasContent = entry.message.trim().length > 0;

        return React.createElement('div', {
          key,
          className: `rounded-xl border-2 p-5 transition-colors ${entry.active && hasContent ? 'border-amber-400 bg-amber-50' : isToday ? 'border-golf-200 bg-white' : 'border-gray-100 bg-white'}`
        },
          // Day header row
          React.createElement('div', { className: 'flex items-center justify-between mb-3' },
            React.createElement('div', { className: 'flex items-center gap-3' },
              React.createElement('div', { className: `px-3 py-1 rounded-full text-xs font-bold ${isToday ? 'bg-golf-600 text-white' : 'bg-gray-100 text-gray-600'}` }, label),
              React.createElement('span', { className: 'text-xs text-gray-400' }, key),
              entry.active && hasContent && React.createElement('span', { className: 'text-xs px-2 py-0.5 bg-amber-400 text-white rounded-full font-semibold' }, '📢 LIVE')
            ),
            // Toggle
            React.createElement('div', {
              onClick: () => updateLocal(key, 'active', !entry.active),
              className: `relative w-11 h-6 rounded-full cursor-pointer transition-colors flex-shrink-0 ${entry.active ? 'bg-green-500' : 'bg-gray-200'}`
            },
              React.createElement('div', {
                className: `absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${entry.active ? 'translate-x-6' : 'translate-x-1'}`
              })
            )
          ),

          // Textarea
          React.createElement('textarea', {
            value: entry.message,
            onChange: e => updateLocal(key, 'message', e.target.value),
            rows: 2,
            placeholder: isToday
              ? 'e.g. Cart path only today due to wet conditions.'
              : `Instructions for ${label.toLowerCase()}... (e.g. Back 9 closed for aeration.)`,
            className: 'w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none resize-none mb-3 bg-white'
          }),

          // Footer row
          React.createElement('div', { className: 'flex items-center justify-between' },
            React.createElement('div', { className: 'flex items-center gap-2' },
              React.createElement('button', {
                onClick: () => saveDay(key),
                disabled: saving === 'daily_instructions',
                className: 'px-4 py-1.5 bg-golf-600 hover:bg-golf-700 text-white rounded-lg text-xs font-semibold transition-colors disabled:opacity-50'
              }, saving === 'daily_instructions' ? 'Saving...' : 'Save'),
              savedKey === key && React.createElement('span', { className: 'text-green-600 text-xs font-medium' }, '✓ Saved!')
            ),
            hasContent && React.createElement('button', {
              onClick: () => clearDay(key),
              className: 'text-xs text-red-400 hover:text-red-600 transition-colors'
            }, 'Clear')
          )
        );
      })
    )
  );
}

// ============================================
// PHONE NUMBERS MANAGER (Phase 5)
// ============================================
//
// Reusable panel for listing + CRUD on business_phone_numbers. Powers both:
//   - The tenant Settings → Phones tab (endpointBase='/api/phone-numbers')
//   - The Super Admin dashboard's per-business phone manager
//     (endpointBase='/api/super/businesses/:id/phone-numbers').
//
// The parent is responsible for passing the right base URL. Everything else
// — E.164 validation, primary enforcement, status toggles — is encapsulated
// here and must match the backend's rules so the UX never gets wedged.
function PhoneNumbersManager({ endpointBase, canEdit = true, title = 'Phone Numbers' }) {
  const [phones, setPhones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newIsPrimary, setNewIsPrimary] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api(endpointBase);
      setPhones(Array.isArray(data.phone_numbers) ? data.phone_numbers : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [endpointBase]);

  const handleAdd = async () => {
    const phone = newPhone.trim();
    if (!isValidE164(phone)) {
      alert('Phone must be in E.164 format, e.g. +19053334444');
      return;
    }
    setBusy('add');
    try {
      await api(endpointBase, {
        method: 'POST',
        body: JSON.stringify({
          phone_number: phone,
          label: newLabel.trim() || undefined,
          is_primary: newIsPrimary
        })
      });
      setNewPhone('');
      setNewLabel('');
      setNewIsPrimary(false);
      await load();
    } catch (err) {
      alert('Failed to add phone: ' + err.message);
    } finally {
      setBusy('');
    }
  };

  // Build a human-readable label for a phone row, used in confirm dialogs so
  // the operator sees exactly which number is about to change.
  const describePhone = (p) =>
    p.label ? `${p.phone_number} (${p.label})` : p.phone_number;

  const patchPhone = async (phoneId, patch, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy('p' + phoneId);
    try {
      await api(`${endpointBase}/${phoneId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      await load();
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setBusy('');
    }
  };

  const deletePhone = async (phone) => {
    const label = describePhone(phone);
    const primaryWarn = phone.is_primary
      ? '\n\nThis is the PRIMARY number — deleting it will leave outbound SMS without a configured From address until another number is promoted.'
      : '';
    const msg =
      `Permanently delete ${label}?\n\n` +
      `Inbound calls to this number will stop resolving to this business.${primaryWarn}\n\n` +
      `This cannot be undone. Prefer "Disable" if you just want to pause it.`;
    if (!window.confirm(msg)) return;
    setBusy('d' + phone.id);
    try {
      await api(`${endpointBase}/${phone.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setBusy('');
    }
  };

  if (loading) return React.createElement('div', { className: 'p-4 text-gray-500 text-sm' }, 'Loading phone numbers\u2026');

  return React.createElement('div', null,
    React.createElement('div', { className: 'mb-4' },
      React.createElement('h3', { className: 'font-semibold text-lg text-gray-800' }, title),
      React.createElement('p', { className: 'text-sm text-gray-500 mt-1' },
        'Numbers listed here route inbound Twilio calls to this business. ',
        React.createElement('strong', null, 'Primary'),
        ' is the From-address for outbound SMS. Inactive numbers no longer route calls.'
      )
    ),

    error && React.createElement('div', { className: 'bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-3 py-2 mb-3' }, error),

    // Existing numbers
    phones.length === 0
      ? React.createElement('div', { className: 'text-sm text-gray-400 italic mb-4' }, 'No phone numbers configured yet.')
      : React.createElement('div', { className: 'flex flex-col gap-2 mb-6' },
          phones.map(p => {
            const isActive = p.status === 'active';
            return React.createElement('div', {
              key: p.id,
              className: `flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${p.is_primary ? 'border-golf-300 bg-golf-50' : isActive ? 'bg-white' : 'bg-gray-50 opacity-75'}`
            },
              React.createElement('div', { className: 'flex-1 min-w-0' },
                React.createElement('div', { className: 'flex items-center gap-2 flex-wrap' },
                  React.createElement('span', { className: 'font-mono font-medium text-gray-900' }, p.phone_number),
                  p.is_primary && React.createElement('span', { className: 'text-xs px-2 py-0.5 rounded-full bg-golf-600 text-white font-semibold' }, 'PRIMARY'),
                  !isActive && React.createElement('span', { className: 'text-xs px-2 py-0.5 rounded-full bg-gray-300 text-gray-700 font-semibold' }, 'INACTIVE')
                ),
                React.createElement('div', { className: 'text-xs text-gray-500 mt-0.5' }, p.label || '\u2014')
              ),
              canEdit && React.createElement('div', { className: 'flex items-center gap-2 flex-wrap justify-end' },
                !p.is_primary && isActive && React.createElement('button', {
                  onClick: () => patchPhone(p.id, { is_primary: true },
                    `Make ${describePhone(p)} the primary number?\n\n` +
                    `The current primary will be demoted, and outbound SMS will start using this number as the From address.`
                  ),
                  disabled: busy === 'p' + p.id,
                  className: 'text-xs px-2.5 py-1 rounded-md border border-golf-300 text-golf-700 hover:bg-golf-50'
                }, 'Make primary'),
                React.createElement('button', {
                  onClick: () => patchPhone(p.id, { status: isActive ? 'inactive' : 'active' },
                    isActive
                      ? `Disable ${describePhone(p)}?\n\n` +
                        `Inbound calls to this number will stop routing to this business immediately. ` +
                        `The row is preserved — you can re-enable it later.`
                      : `Re-enable ${describePhone(p)}?\n\n` +
                        `Inbound calls to this number will resume routing to this business.`
                  ),
                  disabled: busy === 'p' + p.id || (p.is_primary && isActive),
                  title: p.is_primary && isActive ? 'Demote this from primary first.' : '',
                  className: `text-xs px-2.5 py-1 rounded-md border ${isActive ? 'border-amber-300 text-amber-700 hover:bg-amber-50' : 'border-green-300 text-green-700 hover:bg-green-50'} disabled:opacity-40 disabled:cursor-not-allowed`
                }, isActive ? 'Disable' : 'Enable'),
                React.createElement('button', {
                  onClick: () => deletePhone(p),
                  disabled: busy === 'd' + p.id,
                  className: 'text-xs px-2.5 py-1 rounded-md border border-red-200 text-red-600 hover:bg-red-50'
                }, 'Delete')
              )
            );
          })
        ),

    canEdit && React.createElement('div', { className: 'border-t pt-4' },
      React.createElement('h4', { className: 'font-semibold mb-2 text-gray-800' }, 'Add a phone number'),
      React.createElement('div', { className: 'flex flex-col md:flex-row md:items-center gap-2' },
        React.createElement('input', {
          type: 'tel',
          value: newPhone,
          onChange: e => setNewPhone(e.target.value),
          placeholder: '+19053334444',
          className: 'flex-1 border rounded-lg px-3 py-2 text-sm font-mono'
        }),
        React.createElement('input', {
          type: 'text',
          value: newLabel,
          onChange: e => setNewLabel(e.target.value),
          placeholder: 'Label (e.g. Main Line)',
          maxLength: 50,
          className: 'flex-1 border rounded-lg px-3 py-2 text-sm'
        }),
        React.createElement('label', { className: 'flex items-center gap-2 text-sm text-gray-600 whitespace-nowrap' },
          React.createElement('input', {
            type: 'checkbox',
            checked: newIsPrimary,
            onChange: e => setNewIsPrimary(e.target.checked)
          }),
          'Set as primary'
        ),
        React.createElement('button', {
          onClick: handleAdd,
          disabled: busy === 'add' || !newPhone.trim(),
          className: 'bg-golf-600 hover:bg-golf-700 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50'
        }, busy === 'add' ? 'Adding\u2026' : 'Add number')
      ),
      React.createElement('p', { className: 'text-xs text-gray-400 mt-2' },
        'Format: E.164 with leading + and country code, e.g. +19053334444.'
      )
    )
  );
}

// ============================================
// SETTINGS PAGE
// ============================================
function SettingsPage() {
  const [settings, setSettings] = useState({});
  const [greetings, setGreetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [newGreeting, setNewGreeting] = useState('');
  const [newGreetingKnown, setNewGreetingKnown] = useState(false);
  const [activeTab, setActiveTab] = useState('general');

  useEffect(() => {
    Promise.all([
      api('/api/settings'),
      api('/api/greetings')
    ]).then(([s, g]) => { setSettings(s); setGreetings(g); })
    .catch(console.error).finally(() => setLoading(false));
  }, []);

  const saveSetting = async (key, value) => {
    setSaving(key);
    try {
      await api(`/api/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
      setSettings(prev => ({ ...prev, [key]: { ...prev[key], value } }));
    } catch (err) { alert('Failed to save: ' + err.message); }
    finally { setSaving(''); }
  };

  const addGreeting = async () => {
    if (!newGreeting.trim()) return;
    try {
      const g = await api('/api/greetings', { method: 'POST', body: JSON.stringify({ message: newGreeting, for_known_caller: newGreetingKnown }) });
      setGreetings(prev => [...prev, g]);
      setNewGreeting('');
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const deleteGreeting = async (id) => {
    try {
      await api(`/api/greetings/${id}`, { method: 'DELETE' });
      setGreetings(prev => prev.filter(g => g.id !== id));
    } catch (err) { alert('Failed: ' + err.message); }
  };

  if (loading) return React.createElement('div', { className: 'p-8 text-gray-500' }, 'Loading settings...');

  const tabs = [
    { id: 'daily', label: '📋 Daily' },
    { id: 'general', label: 'General' },
    { id: 'phones', label: '📞 Phones' },
    { id: 'team', label: '👥 Team' },
    { id: 'topics', label: '\uD83C\uDFF7\uFE0F Custom Topics' },
    { id: 'users', label: '\uD83D\uDD11 Users' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'hours', label: 'Hours' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'greetings', label: 'Greetings' },
    { id: 'prompt', label: 'Prompt' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'ai', label: 'AI Behavior' },
    { id: 'test', label: 'Test Mode' }
  ];

  const val = (key) => settings[key]?.value;

  return React.createElement('div', null,
    React.createElement('h1', { className: 'text-2xl font-bold text-gray-800 mb-6' }, 'Settings'),

    // Tabs
    React.createElement('div', { className: 'flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 overflow-x-auto' },
      tabs.map(t =>
        React.createElement('button', {
          key: t.id, onClick: () => setActiveTab(t.id),
          className: `px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${activeTab === t.id ? 'bg-white shadow text-golf-700' : 'text-gray-500 hover:text-gray-700'}`
        }, t.label)
      )
    ),

    React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border p-6' },

      // DAILY INSTRUCTIONS TAB
      activeTab === 'daily' && React.createElement(DailyInstructionsTab, { settings, saveSetting, saving }),

      // GENERAL TAB
      activeTab === 'general' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-6' }, 'Configure basic course information. This is pulled automatically by the AI during calls.'),

        React.createElement('h3', { className: 'font-semibold text-lg mb-4 text-gray-800' }, 'Course Information'),
        (() => {
          const courseInfo = val('course_info') || {};
          const updateField = (field, value) => {
            const updated = { ...courseInfo, [field]: value };
            saveSetting('course_info', updated);
          };
          return React.createElement('div', null,
            React.createElement(SettingField, { label: 'Course Name', value: courseInfo.name || '', onSave: v => updateField('name', v), saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Address', value: courseInfo.address || '', onSave: v => updateField('address', v), saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Local Phone', description: 'E.g., (905) 555-1234', value: courseInfo.phone_local || '', onSave: v => updateField('phone_local', v), saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Toll-Free Phone', value: courseInfo.phone_tollfree || '', onSave: v => updateField('phone_tollfree', v), saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Email', value: courseInfo.email || '', onSave: v => updateField('email', v), saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Website', value: courseInfo.website || '', onSave: v => updateField('website', v), saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Holes', type: 'number', value: String(courseInfo.holes || 18), onSave: v => updateField('holes', parseInt(v)), saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Yards', type: 'number', value: String(courseInfo.yards || ''), onSave: v => updateField('yards', v), saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Acres', type: 'number', value: String(courseInfo.acres || ''), onSave: v => updateField('acres', parseInt(v)), saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Style', description: 'E.g., British Links, Parkland, Championship', value: courseInfo.style || '', onSave: v => updateField('style', v), saving: saving === 'course_info' }),
            React.createElement(SettingTextarea, { label: 'Course Description', description: 'What makes your course special. The AI will naturally reference this when describing the course.',
              value: courseInfo.description || '', rows: 3,
              onSave: v => updateField('description', v), saving: saving === 'course_info' }),
            React.createElement(SettingTextarea, { label: 'Signature Holes', description: 'Notable holes and what makes them special. Format each on a new line: "Hole 7: Beautiful island green with water hazard"',
              value: courseInfo.signature_holes ? courseInfo.signature_holes.map(h => `Hole ${h.hole}: ${h.description}`).join('\\n') : '', rows: 4,
              onSave: v => { const holes = v.split('\\n').filter(l => l.trim()).map(line => { const [hole, desc] = line.split(': '); return { hole: parseInt(hole.replace('Hole ', '')), description: desc || '' }; }); updateField('signature_holes', holes); }, saving: saving === 'course_info' }),
            React.createElement(SettingField, { label: 'Directions', description: 'How to get to the course',
              value: courseInfo.directions || '', onSave: v => updateField('directions', v), saving: saving === 'course_info' })
          );
        })(),

        React.createElement('div', { className: 'border-t my-6 pt-6' }),
        React.createElement('h3', { className: 'font-semibold text-lg mb-4 text-gray-800' }, 'Operations'),
        React.createElement(SettingField, { label: 'Staff Transfer Phone Number', description: 'Phone number to transfer calls to when a human is needed',
          value: typeof val('transfer_number') === 'string' ? val('transfer_number') : JSON.stringify(val('transfer_number')),
          onSave: v => saveSetting('transfer_number', v), saving: saving === 'transfer_number' }),
        React.createElement(SettingField, { label: 'Max Booking Size', description: 'Maximum number of players per booking request',
          value: String(val('policies')?.max_booking_size || 8), type: 'number',
          onSave: v => { const p = { ...val('policies'), max_booking_size: parseInt(v) }; saveSetting('policies', p); }, saving: saving === 'policies' }),
        React.createElement(SettingTextarea, { label: 'Course Announcements (JSON)', description: 'Active announcements. Format: [{"message": "...", "active": true}]',
          value: JSON.stringify(val('announcements') || [], null, 2),
          onSave: v => { try { saveSetting('announcements', JSON.parse(v)); } catch(e) { alert('Invalid JSON'); } }, saving: saving === 'announcements' })
      ),

      // PHONES TAB
      activeTab === 'phones' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Inbound Twilio DIDs that route to this business. Disable a number to take it offline without losing history.'
        ),
        React.createElement(PhoneNumbersManager, {
          endpointBase: '/api/phone-numbers',
          title: 'This Business\u2019s Phone Numbers'
        })
      ),

      // TEAM TAB \u2014 directory of named people the AI can leave a message for.
      activeTab === 'team' && React.createElement(TeamDirectoryManager, null),

      // CUSTOM TOPICS TAB \u2014 operator-defined scenarios (lost & found,
      // catering, etc). The AI matches caller questions and routes to
      // take_topic_message which lands a row on the Messages page +
      // texts the topic\u2019s notify_sms.
      activeTab === 'topics' && React.createElement(CustomTopicsManager, null),

      // USERS — login accounts for this tenant. Same component
      // as the super-admin Edit Tenant modal; with no businessId
      // prop it defaults to the self-service /api/users endpoints.
      activeTab === 'users' && React.createElement(TenantUsersPanel, null),

      // PROMPT TAB
      activeTab === 'prompt' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Free-form system prompt additions. The AI receives these as extra instructions on top of the vertical template. Keep it short and specific — long blocks drown out the rest of the prompt.'
        ),
        React.createElement(SettingTextarea, {
          label: 'Custom Prompt Additions',
          description: 'Additional guidance layered onto the base system prompt. Example: "Always mention our loyalty program if the caller asks about pricing."',
          value: val('custom_prompt') || '',
          rows: 14,
          onSave: v => saveSetting('custom_prompt', v),
          saving: saving === 'custom_prompt'
        }),
        React.createElement(SettingField, {
          label: 'AI Name',
          description: 'The name the AI uses when introducing itself. Defaults to \u201cAI Assistant\u201d.',
          value: val('ai_personality')?.name || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), name: v }),
          saving: saving === 'ai_personality'
        }),
        React.createElement(SettingField, {
          label: 'Language Handling',
          description: 'How the AI decides which language to respond in.',
          value: val('ai_personality')?.language || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), language: v }),
          saving: saving === 'ai_personality'
        })
      ),

      // KNOWLEDGE TAB
      activeTab === 'knowledge' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-6' }, 'Add general knowledge about your golf course that the AI assistant can reference during calls. This can include tips, local info, course conditions, food & drink options, dress code, or anything else callers might ask about.'),
        React.createElement(SettingTextarea, { label: 'General Course Knowledge', description: 'Write anything you want the AI to know. Use plain language — one topic per line or paragraph works great. Example: "We have a fully stocked pro shop with club rentals available. The clubhouse restaurant serves lunch from 11am-3pm."',
          value: val('general_knowledge') || '', rows: 12,
          onSave: v => saveSetting('general_knowledge', v), saving: saving === 'general_knowledge' }),
        React.createElement(SettingTextarea, { label: 'Frequently Asked Questions', description: 'Add common questions and answers. Format each as "Q: ... A: ..." on separate lines. The AI will use these to answer callers accurately.',
          value: val('faq') || '', rows: 10,
          onSave: v => saveSetting('faq', v), saving: saving === 'faq' }),
        React.createElement(SettingTextarea, { label: 'Seasonal / Temporary Notes', description: 'Info that changes often — course conditions, temporary closures, special events coming up, etc. Update this anytime.',
          value: val('seasonal_notes') || '', rows: 6,
          onSave: v => saveSetting('seasonal_notes', v), saving: saving === 'seasonal_notes' })
      ),

      // HOURS TAB
      activeTab === 'hours' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' }, 'Set business hours for each day. The AI uses these to determine if the course is open and to tell callers your hours.'),
        ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day => {
          const h = val('business_hours')?.[day] || { open: '07:00', close: '19:00' };
          return React.createElement('div', { key: day, className: 'flex items-center gap-4 mb-3' },
            React.createElement('span', { className: 'w-24 font-medium capitalize' }, day),
            React.createElement('input', { type: 'time', value: h.open, className: 'border rounded px-2 py-1',
              onChange: e => {
                const updated = { ...val('business_hours'), [day]: { ...h, open: e.target.value } };
                saveSetting('business_hours', updated);
              }
            }),
            React.createElement('span', { className: 'text-gray-400' }, 'to'),
            React.createElement('input', { type: 'time', value: h.close, className: 'border rounded px-2 py-1',
              onChange: e => {
                const updated = { ...val('business_hours'), [day]: { ...h, close: e.target.value } };
                saveSetting('business_hours', updated);
              }
            })
          );
        })
      ),

      // PRICING TAB
      activeTab === 'pricing' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' }, 'Update green fees and cart pricing. Changes take effect on the next call.'),
        React.createElement(SettingTextarea, {
          label: 'Pricing Configuration (JSON)', description: 'Full pricing structure. Edit values carefully.',
          value: JSON.stringify(val('pricing') || {}, null, 2), rows: 20,
          onSave: v => { try { saveSetting('pricing', JSON.parse(v)); } catch(e) { alert('Invalid JSON'); } }, saving: saving === 'pricing'
        })
      ),

      // GREETINGS TAB
      activeTab === 'greetings' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' }, 'The AI picks a random greeting each time. Use {name} as a placeholder for returning callers.'),

        React.createElement('h3', { className: 'font-semibold mb-2' }, 'New Caller Greetings'),
        greetings.filter(g => !g.for_known_caller).map(g =>
          React.createElement('div', { key: g.id, className: 'flex items-center gap-2 mb-2 bg-gray-50 rounded-lg p-3' },
            React.createElement('span', { className: 'flex-1 text-sm' }, g.message),
            React.createElement('button', { onClick: () => deleteGreeting(g.id), className: 'text-red-400 hover:text-red-600 text-sm' }, 'Remove')
          )
        ),

        React.createElement('h3', { className: 'font-semibold mb-2 mt-4' }, 'Returning Caller Greetings'),
        greetings.filter(g => g.for_known_caller).map(g =>
          React.createElement('div', { key: g.id, className: 'flex items-center gap-2 mb-2 bg-green-50 rounded-lg p-3' },
            React.createElement('span', { className: 'flex-1 text-sm' }, g.message),
            React.createElement('button', { onClick: () => deleteGreeting(g.id), className: 'text-red-400 hover:text-red-600 text-sm' }, 'Remove')
          )
        ),

        React.createElement('div', { className: 'mt-4 border-t pt-4' },
          React.createElement('h3', { className: 'font-semibold mb-2' }, 'Add New Greeting'),
          React.createElement('input', {
            type: 'text', value: newGreeting, onChange: e => setNewGreeting(e.target.value),
            placeholder: 'e.g., Hey there! Thanks for calling. How can I help you today?',
            className: 'w-full border rounded-lg px-3 py-2 mb-2 text-sm'
          }),
          React.createElement('div', { className: 'flex items-center gap-4' },
            React.createElement('label', { className: 'flex items-center gap-2 text-sm' },
              React.createElement('input', { type: 'checkbox', checked: newGreetingKnown, onChange: e => setNewGreetingKnown(e.target.checked) }),
              'For returning callers (use {name} placeholder)'
            ),
            React.createElement('button', { onClick: addGreeting, className: 'bg-golf-600 hover:bg-golf-700 text-white px-4 py-2 rounded-lg text-sm' }, 'Add Greeting')
          )
        )
      ),

      // NOTIFICATIONS TAB
      activeTab === 'notifications' && React.createElement('div', null,
        React.createElement(SettingField, { label: 'Notification Email', description: 'Email address for booking alerts',
          value: val('notifications')?.email_to || '',
          onSave: v => saveSetting('notifications', { ...val('notifications'), email_to: v }), saving: saving === 'notifications' }),
        React.createElement(SettingField, { label: 'Notification SMS Phone', description: 'Phone number for SMS booking alerts',
          value: val('notifications')?.sms_to || '',
          onSave: v => saveSetting('notifications', { ...val('notifications'), sms_to: v }), saving: saving === 'notifications' }),
        React.createElement('div', { className: 'flex flex-col gap-3 mt-4' },
          React.createElement('div', { className: 'flex gap-6' },
            React.createElement('label', { className: 'flex items-center gap-2' },
              React.createElement('input', { type: 'checkbox', checked: val('notifications')?.email_enabled ?? true,
                onChange: e => saveSetting('notifications', { ...val('notifications'), email_enabled: e.target.checked })
              }), 'Email notifications to staff'
            ),
            React.createElement('label', { className: 'flex items-center gap-2' },
              React.createElement('input', { type: 'checkbox', checked: val('notifications')?.sms_enabled ?? true,
                onChange: e => saveSetting('notifications', { ...val('notifications'), sms_enabled: e.target.checked })
              }), 'SMS notifications to staff'
            )
          ),
          React.createElement('div', { className: 'border-t pt-3 mt-2' },
            React.createElement('label', { className: 'flex items-center gap-2 font-medium' },
              React.createElement('input', { type: 'checkbox', checked: val('notifications')?.customer_sms_enabled ?? false,
                onChange: e => saveSetting('notifications', { ...val('notifications'), customer_sms_enabled: e.target.checked })
              }), '📱 Send booking confirmation SMS to customers'
            ),
            React.createElement('p', { className: 'text-xs text-gray-500 mt-1 ml-6' },
              'Text callers when their tee time is booked, confirmed, or cancelled. Customers are told to call back at 905 655 6300 if plans change. ~$0.01 per booking.'
            )
          ),
          React.createElement('div', { className: 'border-t pt-3 mt-2' },
            React.createElement('label', { className: 'flex items-center gap-2 font-medium' },
              React.createElement('input', { type: 'checkbox', checked: val('notifications')?.reminder_sms_enabled ?? false,
                onChange: e => saveSetting('notifications', { ...val('notifications'), reminder_sms_enabled: e.target.checked })
              }), '\u23F0 Send day-before reminder texts'
            ),
            React.createElement('p', { className: 'text-xs text-gray-500 mt-1 ml-6' },
              'Automatically text customers at 6 PM the evening before their tee time with a friendly reminder. Helps reduce no-shows.'
            )
          )
        )
      ),

      // AI BEHAVIOR TAB
      activeTab === 'ai' && React.createElement('div', null,
        React.createElement(SettingTextarea, { label: 'AI Personality & Style', description: 'Instructions for how the AI should behave on calls',
          value: val('ai_personality')?.style || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), style: v }), saving: saving === 'ai_personality' }),
        React.createElement(SettingTextarea, { label: 'Weather Behavior', description: 'How the AI handles weather questions',
          value: val('ai_personality')?.weather_behavior || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), weather_behavior: v }), saving: saving === 'ai_personality' }),
        React.createElement(SettingField, { label: 'After-Hours Message', description: 'What the AI says when callers ask for a human after hours',
          value: val('ai_personality')?.after_hours_message || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), after_hours_message: v }), saving: saving === 'ai_personality' }),

        // Credit Card Requirement
        React.createElement('div', { className: 'border-t pt-4 mt-4' },
          React.createElement('label', { className: 'flex items-center gap-2 font-medium' },
            React.createElement('input', { type: 'checkbox', checked: val('booking_settings')?.require_credit_card ?? false,
              onChange: e => saveSetting('booking_settings', { ...val('booking_settings'), require_credit_card: e.target.checked })
            }), '\uD83D\uDCB3 Require credit card for bookings'
          ),
          React.createElement('p', { className: 'text-xs text-gray-500 mt-1 ml-6' },
            'When enabled, the AI will ask callers for a credit card number to hold their tee time. Only the last 4 digits are stored — the full number is never saved.'
          )
        ),

        // Landline Detection Info
        React.createElement('div', { className: 'border-t pt-4 mt-4' },
          React.createElement('div', { className: 'flex items-center gap-2 font-medium text-gray-700' },
            '\uD83D\uDCDE Landline Detection'
          ),
          React.createElement('p', { className: 'text-xs text-gray-500 mt-1' },
            'The system automatically detects when callers are calling from a home/landline phone. For landline callers, the AI will ask for a cell number to send text confirmations. If no cell number is provided, staff will need to call back to confirm. This uses Twilio Lookup (~$0.03/call, cached per customer).'
          )
        )
      ),

      // TEST MODE TAB
      activeTab === 'test' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' }, 'When test mode is enabled, only calls from the test phone number will be answered by the AI. All other callers hear a temporary message.'),
        React.createElement('div', { className: 'mb-4' },
          React.createElement('label', { className: 'flex items-center gap-2 mb-4' },
            React.createElement('input', { type: 'checkbox', checked: val('test_mode')?.enabled ?? false,
              onChange: e => saveSetting('test_mode', { ...val('test_mode'), enabled: e.target.checked })
            }),
            React.createElement('span', { className: 'font-medium' }, 'Enable Test Mode')
          ),
          React.createElement(SettingField, { label: 'Test Phone Number', description: 'Only this number will reach the AI when test mode is on',
            value: val('test_mode')?.test_phone || '',
            onSave: v => saveSetting('test_mode', { ...val('test_mode'), test_phone: v }), saving: saving === 'test_mode' })
        )
      )
    )
  );
}

// ============================================
// TEE SHEET PAGE
// ============================================
function TeeSheetPage() {
  const today = new Date();
  const toLocalDateStr = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const [selectedDate, setSelectedDate] = useState(toLocalDateStr(today));
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [interval, setInterval2] = useState(10); // minutes between tee times
  const [startHour, setStartHour] = useState(6);  // sheet start hour
  const [startMin, setStartMin] = useState(0);    // sheet start minute (0-59)
  const [endHour, setEndHour] = useState(19);      // sheet end hour
  const [endMin, setEndMin] = useState(0);         // sheet end minute (0-59)
  const [modal, setModal] = useState(null); // { mode: 'add'|'edit', slot, booking }
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // ─── Tee-sheet grid config persistence ─────────────────────────────────
  // Per-tenant settings.tee_sheet_config = { start_hour, start_min,
  // end_hour, end_min, interval_min }. Loaded once on mount; stays in
  // local state while the operator tweaks; persists when they hit the
  // new "Save grid" button. Only affects the LOCAL grid display — does
  // NOT touch Tee-On data, which is read-only and lives elsewhere.
  // We track the last-saved snapshot so the Save button only enables
  // when there's a real change (so the operator doesn't double-click
  // and resave the same config).
  const [savedConfig, setSavedConfig] = useState(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSaveMsg, setConfigSaveMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    api('/api/settings').then(all => {
      if (cancelled) return;
      const cfg = all?.tee_sheet_config?.value;
      if (cfg && typeof cfg === 'object') {
        if (Number.isInteger(cfg.start_hour) && cfg.start_hour >= 4 && cfg.start_hour <= 22) setStartHour(cfg.start_hour);
        if (Number.isInteger(cfg.start_min)  && cfg.start_min >= 0 && cfg.start_min <= 59) setStartMin(cfg.start_min);
        if (Number.isInteger(cfg.end_hour)   && cfg.end_hour >= 5 && cfg.end_hour <= 23) setEndHour(cfg.end_hour);
        if (Number.isInteger(cfg.end_min)    && cfg.end_min >= 0 && cfg.end_min <= 59) setEndMin(cfg.end_min);
        if (Number.isInteger(cfg.interval_min) && cfg.interval_min >= 5 && cfg.interval_min <= 60) setInterval2(cfg.interval_min);
        setSavedConfig({ start_hour: cfg.start_hour, start_min: cfg.start_min, end_hour: cfg.end_hour, end_min: cfg.end_min, interval_min: cfg.interval_min });
      } else {
        // No saved config yet — record the defaults as the baseline so
        // the Save button activates as soon as the operator changes anything.
        setSavedConfig({ start_hour: 6, start_min: 0, end_hour: 19, end_min: 0, interval_min: 10 });
      }
    }).catch(() => {
      setSavedConfig({ start_hour: 6, start_min: 0, end_hour: 19, end_min: 0, interval_min: 10 });
    });
    return () => { cancelled = true; };
  }, []);

  const currentConfig = { start_hour: startHour, start_min: startMin, end_hour: endHour, end_min: endMin, interval_min: interval };
  const configDirty = savedConfig
    ? (savedConfig.start_hour !== startHour || savedConfig.start_min !== startMin ||
       savedConfig.end_hour   !== endHour   || savedConfig.end_min   !== endMin   ||
       savedConfig.interval_min !== interval)
    : false;

  const saveTeeSheetConfig = async () => {
    setSavingConfig(true);
    setConfigSaveMsg('');
    try {
      await api('/api/settings/tee_sheet_config', {
        method: 'PUT',
        body: JSON.stringify({
          value: currentConfig,
          description: 'Local tee-sheet grid display: start, end, interval. Read-only with respect to Tee-On.'
        })
      });
      setSavedConfig({ ...currentConfig });
      setConfigSaveMsg('Saved');
      setTimeout(() => setConfigSaveMsg(''), 1500);
    } catch (err) {
      setConfigSaveMsg('Failed: ' + (err.message || 'unknown'));
    } finally {
      setSavingConfig(false);
    }
  };

  const loadBookings = () => {
    setLoading(true);
    api('/api/bookings?limit=200')
      .then((all) => { setBookings(all.bookings || []); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadBookings();
    // Live refresh — refetch the tee sheet whenever the server pushes a
    // booking event so a brand-new booking shows up without a reload.
    const onLive = () => loadBookings();
    window.addEventListener('cmdcenter:refresh', onLive);
    return () => window.removeEventListener('cmdcenter:refresh', onLive);
  }, [selectedDate]);

  // Generate time slots from startHour:startMin to endHour:endMin by selected interval
  const slots = [];
  const startTotalMin = startHour * 60 + startMin;
  const endTotalMin = endHour * 60 + endMin;
  for (let totalMin = startTotalMin; totalMin <= endTotalMin; totalMin += interval) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }

  // Hour-mark: true for the FIRST slot whose hour is >= to a new integer hour
  // Works correctly for any interval (7, 8, 9, 10, 12 min, etc.)
  const hourMarkSet = new Set();
  let lastHour = -1;
  slots.forEach(slot => {
    const h = parseInt(slot.split(':')[0]);
    if (h !== lastHour) { hourMarkSet.add(slot); lastHour = h; }
  });

  // Match bookings to closest slot for this day
  const bookingsBySlot = {};
  bookings.forEach(b => {
    const bDate = b.requested_date ? b.requested_date.split('T')[0] : '';
    if (bDate !== selectedDate) return;
    const time = b.requested_time ? b.requested_time.substring(0, 5) : null;
    if (!time) return;
    // Find closest slot
    const [bh, bm] = time.split(':').map(Number);
    const bTotalMin = bh * 60 + bm;
    let closest = slots[0];
    let minDiff = Infinity;
    slots.forEach(s => {
      const [sh, sm] = s.split(':').map(Number);
      const diff = Math.abs(bTotalMin - (sh * 60 + sm));
      if (diff < minDiff) { minDiff = diff; closest = s; }
    });
    if (!bookingsBySlot[closest]) bookingsBySlot[closest] = [];
    bookingsBySlot[closest].push(b);
  });

  const prevDay = () => {
    const d = new Date(selectedDate + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    setSelectedDate(toLocalDateStr(d));
  };
  const nextDay = () => {
    const d = new Date(selectedDate + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    setSelectedDate(toLocalDateStr(d));
  };

  const displayDate = (() => {
    const d = new Date(selectedDate + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  })();

  const statusStyle = {
    pending:   { bg: 'bg-yellow-50 border-yellow-400',  text: 'text-yellow-800', badge: 'bg-yellow-400', label: 'Pending' },
    confirmed: { bg: 'bg-green-50 border-green-400',    text: 'text-green-800',  badge: 'bg-green-500',  label: 'Confirmed' },
    cancelled: { bg: 'bg-red-50 border-red-300',        text: 'text-red-700',    badge: 'bg-red-400',    label: 'Cancelled' },
    rejected:  { bg: 'bg-gray-100 border-gray-300',     text: 'text-gray-500',   badge: 'bg-gray-400',   label: 'Rejected' },
  };

  const formatSlotLabel = (slot) => {
    const [h, m] = slot.split(':');
    const hour = parseInt(h);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${m} ${ampm}`;
  };

  const isHourMark = (slot) => hourMarkSet.has(slot);

  const totalBooked = Object.values(bookingsBySlot).flat().filter(b => b.status !== 'cancelled' && b.status !== 'rejected').length;

  // Open add modal for a slot
  const openAdd = (slot) => {
    setForm({ customer_name: '', customer_phone: '', party_size: '4', num_carts: '2', special_requests: '', requested_time: slot, requested_date: selectedDate, status: 'confirmed' });
    setModal({ mode: 'add', slot });
    setSaveMsg('');
  };

  // Open edit modal for a booking
  const openEdit = (b) => {
    setForm({
      customer_name: b.customer_name || '',
      customer_phone: b.customer_phone || '',
      customer_email: b.customer_email || '',
      party_size: String(b.party_size || 4),
      num_carts: String(b.num_carts || 0),
      special_requests: b.special_requests || '',
      staff_notes: b.staff_notes || '',
      requested_date: b.requested_date ? b.requested_date.split('T')[0] : selectedDate,
      requested_time: b.requested_time ? b.requested_time.substring(0, 5) : '',
      status: b.status || 'pending'
    });
    setModal({ mode: 'edit', booking: b });
    setSaveMsg('');
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      if (modal.mode === 'add') {
        await api('/api/bookings', {
          method: 'POST',
          body: JSON.stringify({ ...form, party_size: parseInt(form.party_size), num_carts: parseInt(form.num_carts) || 0 })
        });
        setSaveMsg('Booking created!');
      } else {
        // Update details
        await api(`/api/bookings/${modal.booking.id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...form, party_size: parseInt(form.party_size), num_carts: parseInt(form.num_carts) || 0 })
        });
        // Update status separately if changed
        if (form.status !== modal.booking.status) {
          await api(`/api/bookings/${modal.booking.id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status: form.status, staff_notes: form.staff_notes })
          });
        }
        setSaveMsg('Saved!');
      }
      loadBookings();
      setTimeout(() => setModal(null), 800);
    } catch (e) {
      setSaveMsg('Error saving. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (bookingId, newStatus) => {
    try {
      await api(`/api/bookings/${bookingId}/status`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
      loadBookings();
    } catch (e) { console.error(e); }
  };

  const fv = (key) => ({ value: form[key] || '', onChange: e => setForm(f => ({ ...f, [key]: e.target.value })) });
  const inputCls = 'border rounded-lg px-3 py-2 text-sm w-full focus:ring-2 focus:ring-golf-500 outline-none';
  const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

  return React.createElement('div', null,
    // Header
    React.createElement('div', { className: 'flex items-center justify-between mb-4 flex-wrap gap-3' },
      React.createElement('h1', { className: 'text-2xl font-bold text-gray-800' }, '⛳ Tee Sheet'),
      React.createElement('div', { className: 'flex items-center gap-2 flex-wrap' },
        // Start time selector (hour + minute)
        React.createElement('div', { className: 'flex items-center gap-1 bg-white border rounded-xl px-2 py-2 shadow-sm' },
          React.createElement('span', { className: 'text-xs text-gray-500 font-medium' }, 'Start:'),
          React.createElement('select', {
            value: startHour,
            onChange: e => { const v = parseInt(e.target.value); if (v < endHour || (v === endHour && startMin <= endMin)) setStartHour(v); },
            className: 'text-sm font-semibold text-golf-700 bg-transparent outline-none cursor-pointer'
          },
            Array.from({length: 18}, (_, i) => i + 4).map(h => {
              const label = h < 12 ? `${h}` : h === 12 ? '12' : `${h-12}`;
              return React.createElement('option', { key: h, value: h }, label);
            })
          ),
          React.createElement('span', { className: 'text-gray-400' }, ':'),
          React.createElement('select', {
            value: startMin,
            onChange: e => { const v = parseInt(e.target.value); if (startHour < endHour || (startHour === endHour && v <= endMin)) setStartMin(v); },
            className: 'text-sm font-semibold text-golf-700 bg-transparent outline-none cursor-pointer w-12'
          },
            Array.from({length: 60}, (_, i) => i).map(m =>
              React.createElement('option', { key: m, value: m }, String(m).padStart(2, '0'))
            )
          ),
          React.createElement('span', { className: 'text-xs text-gray-400' }, startHour < 12 ? 'AM' : startHour === 12 ? 'PM' : 'PM')
        ),
        // End time selector (hour + minute)
        React.createElement('div', { className: 'flex items-center gap-1 bg-white border rounded-xl px-2 py-2 shadow-sm' },
          React.createElement('span', { className: 'text-xs text-gray-500 font-medium' }, 'End:'),
          React.createElement('select', {
            value: endHour,
            onChange: e => { const v = parseInt(e.target.value); if (v > startHour || (v === startHour && endMin >= startMin)) setEndHour(v); },
            className: 'text-sm font-semibold text-golf-700 bg-transparent outline-none cursor-pointer'
          },
            Array.from({length: 18}, (_, i) => i + 5).map(h => {
              const label = h < 12 ? `${h}` : h === 12 ? '12' : `${h-12}`;
              return React.createElement('option', { key: h, value: h }, label);
            })
          ),
          React.createElement('span', { className: 'text-gray-400' }, ':'),
          React.createElement('select', {
            value: endMin,
            onChange: e => { const v = parseInt(e.target.value); if (endHour > startHour || (endHour === startHour && v >= startMin)) setEndMin(v); },
            className: 'text-sm font-semibold text-golf-700 bg-transparent outline-none cursor-pointer w-12'
          },
            Array.from({length: 60}, (_, i) => i).map(m =>
              React.createElement('option', { key: m, value: m }, String(m).padStart(2, '0'))
            )
          ),
          React.createElement('span', { className: 'text-xs text-gray-400' }, endHour < 12 ? 'AM' : endHour === 12 ? 'PM' : 'PM')
        ),
        // Interval selector
        React.createElement('div', { className: 'flex items-center gap-1.5 bg-white border rounded-xl px-3 py-2 shadow-sm' },
          React.createElement('span', { className: 'text-xs text-gray-500 font-medium' }, 'Interval:'),
          React.createElement('select', {
            value: interval,
            onChange: e => setInterval2(parseInt(e.target.value)),
            className: 'text-sm font-semibold text-golf-700 bg-transparent outline-none cursor-pointer'
          },
            [7, 8, 9, 10, 12, 15, 20, 30].map(n =>
              React.createElement('option', { key: n, value: n }, `${n} min`)
            )
          )
        ),
        React.createElement('button', {
          onClick: () => setSelectedDate(toLocalDateStr(today)),
          className: 'text-sm px-3 py-2 bg-golf-600 hover:bg-golf-700 text-white rounded-xl transition-colors shadow-sm'
        }, 'Today'),
        // Save grid — persists Start / End / Interval to settings.tee_sheet_config
        // so the same layout reappears every time anyone opens the Tee Sheet.
        // Disabled until the operator changes something (avoids redundant saves)
        // or while a save is in flight. NEVER touches Tee-On data — only the
        // local grid display config.
        React.createElement('button', {
          onClick: saveTeeSheetConfig,
          disabled: !configDirty || savingConfig,
          title: configDirty
            ? 'Save Start / End / Interval so this grid layout shows every day'
            : 'No changes to save — already matches the saved grid',
          className: `text-sm px-3 py-2 rounded-xl transition-colors shadow-sm font-medium ${
            configDirty
              ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`
        }, savingConfig ? 'Saving…' : configSaveMsg || (configDirty ? '💾 Save grid' : '✓ Saved'))
      )
    ),

    // Date navigator
    React.createElement('div', { className: 'flex items-center gap-4 mb-4 bg-white rounded-xl shadow-sm border p-4' },
      React.createElement('button', { onClick: prevDay, className: 'text-xl font-bold text-gray-400 hover:text-gray-800 px-2' }, '‹'),
      React.createElement('div', { className: 'flex-1 text-center' },
        React.createElement('div', { className: 'font-semibold text-lg text-gray-800' }, displayDate),
        React.createElement('div', { className: 'text-sm text-gray-400 mt-0.5' },
          loading ? 'Loading...' : `${totalBooked} booking${totalBooked !== 1 ? 's' : ''} · click any slot to edit`
        )
      ),
      React.createElement('button', { onClick: nextDay, className: 'text-xl font-bold text-gray-400 hover:text-gray-800 px-2' }, '›'),
      React.createElement('input', {
        type: 'date', value: selectedDate,
        onChange: e => setSelectedDate(e.target.value),
        className: 'ml-4 border rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-golf-500 outline-none'
      })
    ),

    // Legend
    React.createElement('div', { className: 'flex gap-4 mb-3 text-xs' },
      React.createElement('span', { className: 'flex items-center gap-1.5' },
        React.createElement('span', { className: 'w-2.5 h-2.5 rounded-full bg-green-500 inline-block' }), 'Confirmed'),
      React.createElement('span', { className: 'flex items-center gap-1.5' },
        React.createElement('span', { className: 'w-2.5 h-2.5 rounded-full bg-yellow-400 inline-block' }), 'Pending'),
      React.createElement('span', { className: 'flex items-center gap-1.5' },
        React.createElement('span', { className: 'w-2.5 h-2.5 rounded-full bg-gray-200 inline-block' }), 'Available — click to add')
    ),

    // Tee sheet grid
    React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border overflow-hidden' },
      slots.map((slot) => {
        const slotBookings = (bookingsBySlot[slot] || []).filter(b => b.status !== 'cancelled' && b.status !== 'rejected');
        const hasBooking = slotBookings.length > 0;
        const hourMark = isHourMark(slot);

        return React.createElement('div', {
          key: slot,
          className: `flex items-stretch border-b last:border-b-0 ${hourMark ? 'border-gray-200' : 'border-gray-100'}`
        },
          // Time label
          React.createElement('div', {
            className: `w-20 flex-shrink-0 flex items-center justify-end px-3 border-r ${hourMark ? 'border-gray-200 bg-gray-50' : 'border-gray-100 bg-white'}`
          },
            React.createElement('span', { className: `text-xs ${hourMark ? 'font-semibold text-gray-700' : 'text-gray-400'}` },
              hourMark ? formatSlotLabel(slot) : `  :${slot.split(':')[1]}`
            )
          ),
          // Slot content — click to add booking on empty, click booking chip to edit
          React.createElement('div', {
            className: `flex-1 min-h-[34px] flex items-center px-2 py-0.5 gap-2 ${!hasBooking ? 'cursor-pointer hover:bg-golf-50 group' : ''}`,
            onClick: !hasBooking ? () => openAdd(slot) : undefined
          },
            hasBooking
              ? slotBookings.map((b, bi) => {
                  const s = statusStyle[b.status] || statusStyle.pending;
                  return React.createElement('div', {
                    key: bi,
                    onClick: () => openEdit(b),
                    className: `flex items-center gap-2 px-3 py-1 rounded-lg border ${s.bg} cursor-pointer hover:shadow-md transition-shadow flex-1 max-w-lg`
                  },
                    React.createElement('span', { className: `w-2 h-2 rounded-full flex-shrink-0 ${s.badge}` }),
                    React.createElement('span', { className: `font-semibold text-sm ${s.text}` }, b.customer_name || 'Unknown'),
                    React.createElement('span', { className: `text-xs ${s.text} opacity-70 ml-1` },
                      `${b.party_size || '?'} players${b.num_carts ? ` · ${b.num_carts} cart${b.num_carts !== 1 ? 's' : ''}` : ''}`
                    ),
                    b.customer_phone && React.createElement('span', { className: `text-xs ${s.text} opacity-50 ml-auto` }, b.customer_phone),
                    // Quick confirm/cancel buttons
                    b.status === 'pending' && React.createElement('div', { className: 'flex gap-1 ml-2', onClick: e => e.stopPropagation() },
                      React.createElement('button', {
                        onClick: () => handleStatusChange(b.id, 'confirmed'),
                        className: 'text-xs px-2 py-0.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors'
                      }, '✓'),
                      React.createElement('button', {
                        onClick: () => handleStatusChange(b.id, 'cancelled'),
                        className: 'text-xs px-2 py-0.5 bg-red-400 text-white rounded hover:bg-red-500 transition-colors'
                      }, '✕')
                    )
                  );
                })
              : React.createElement('span', { className: 'text-xs text-gray-200 group-hover:text-golf-400 transition-colors' },
                  hourMark ? '+ add booking' : ''
                )
          )
        );
      })
    ),

    // MODAL — Add or Edit booking
    modal && React.createElement('div', {
      className: 'fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4',
      onClick: e => { if (e.target === e.currentTarget) setModal(null); }
    },
      React.createElement('div', { className: 'bg-white rounded-2xl shadow-xl w-full max-w-md p-6' },
        // Modal header
        React.createElement('div', { className: 'flex items-center justify-between mb-5' },
          React.createElement('h2', { className: 'font-bold text-lg text-gray-800' },
            modal.mode === 'add'
              ? `Add Booking — ${formatSlotLabel(modal.slot)}`
              : `Edit Booking — ${formatSlotLabel(form.requested_time || '')}`
          ),
          React.createElement('button', { onClick: () => setModal(null), className: 'text-gray-400 hover:text-gray-600 text-xl font-bold' }, '×')
        ),

        // Form fields
        React.createElement('div', { className: 'grid grid-cols-2 gap-3 mb-4' },
          // Name
          React.createElement('div', { className: 'col-span-2' },
            React.createElement('label', { className: labelCls }, 'Customer Name *'),
            React.createElement('input', { ...fv('customer_name'), className: inputCls, placeholder: 'Full name' })
          ),
          // Phone
          React.createElement('div', null,
            React.createElement('label', { className: labelCls }, 'Phone'),
            React.createElement('input', { ...fv('customer_phone'), className: inputCls, placeholder: '(416) 555-0000' })
          ),
          // Email
          React.createElement('div', null,
            React.createElement('label', { className: labelCls }, 'Email'),
            React.createElement('input', { ...fv('customer_email'), className: inputCls, placeholder: 'optional' })
          ),
          // Date
          React.createElement('div', null,
            React.createElement('label', { className: labelCls }, 'Date'),
            React.createElement('input', { type: 'date', ...fv('requested_date'), className: inputCls })
          ),
          // Time
          React.createElement('div', null,
            React.createElement('label', { className: labelCls }, 'Time'),
            React.createElement('select', { ...fv('requested_time'), className: inputCls },
              slots.filter(s => isHourMark(s) || true).map(s =>
                React.createElement('option', { key: s, value: s }, formatSlotLabel(s))
              )
            )
          ),
          // Party size
          React.createElement('div', null,
            React.createElement('label', { className: labelCls }, 'Players'),
            React.createElement('select', { ...fv('party_size'), className: inputCls },
              [1,2,3,4,5,6,7,8].map(n => React.createElement('option', { key: n, value: n }, `${n} player${n !== 1 ? 's' : ''}`))
            )
          ),
          // Carts
          React.createElement('div', null,
            React.createElement('label', { className: labelCls }, 'Carts'),
            React.createElement('select', { ...fv('num_carts'), className: inputCls },
              [0,1,2,3,4].map(n => React.createElement('option', { key: n, value: n }, n === 0 ? 'No carts' : `${n} cart${n !== 1 ? 's' : ''}`))
            )
          ),
          // Status (edit only)
          modal.mode === 'edit' && React.createElement('div', { className: 'col-span-2' },
            React.createElement('label', { className: labelCls }, 'Status'),
            React.createElement('select', { ...fv('status'), className: inputCls },
              ['pending', 'confirmed', 'cancelled', 'rejected'].map(s =>
                React.createElement('option', { key: s, value: s }, s.charAt(0).toUpperCase() + s.slice(1))
              )
            )
          ),
          // Special requests
          React.createElement('div', { className: 'col-span-2' },
            React.createElement('label', { className: labelCls }, 'Special Requests'),
            React.createElement('textarea', { ...fv('special_requests'), className: inputCls, rows: 2, placeholder: 'e.g. cart with umbrella, accessibility needs...' })
          ),
          // Staff notes (edit only)
          modal.mode === 'edit' && React.createElement('div', { className: 'col-span-2' },
            React.createElement('label', { className: labelCls }, 'Staff Notes'),
            React.createElement('textarea', { ...fv('staff_notes'), className: inputCls, rows: 2, placeholder: 'Internal notes (not shared with customer)' })
          )
        ),

        // Save button + message
        saveMsg && React.createElement('p', { className: `text-sm mb-3 ${saveMsg.includes('Error') ? 'text-red-600' : 'text-green-600'}` }, saveMsg),
        React.createElement('div', { className: 'flex gap-2' },
          React.createElement('button', {
            onClick: handleSave,
            disabled: saving || !form.customer_name,
            className: `flex-1 py-2.5 rounded-xl font-semibold text-sm transition-colors ${saving || !form.customer_name ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-golf-600 hover:bg-golf-700 text-white'}`
          }, saving ? 'Saving...' : modal.mode === 'add' ? 'Add Booking' : 'Save Changes'),
          React.createElement('button', { onClick: () => setModal(null), className: 'px-5 py-2.5 rounded-xl font-semibold text-sm bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors' }, 'Cancel')
        )
      )
    )
  );
}

// ============================================
// TEAM DIRECTORY MANAGER
// ============================================
//
// Per-tenant directory of named people the AI can leave a message for.
// Mounts inside the "Team" tab of every Settings page (golf, personal,
// restaurant). Backed by the /api/team CRUD routes; SMS dispatch happens
// server-side via the take_message_for_team_member tool, this UI only
// manages the directory + offers a per-row "test SMS" button so the
// operator can verify the phone number works before relying on it on a
// real call.
function TeamDirectoryManager() {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(null);
  // Draft includes the new fields: per-channel toggles + default-recipient.
  // sms_phone is now optional — an email-only contact is allowed as long as
  // email is provided. The DB enforces this with a CHECK constraint.
  const [draft, setDraft] = useState({
    name: '', role: '', sms_phone: '', email: '', aliases: '',
    sms_enabled: true, email_enabled: true, is_default_recipient: false
  });
  const [adding, setAdding] = useState(false);

  const reload = () => {
    setLoading(true);
    api('/api/team')
      .then(rows => setMembers(Array.isArray(rows) ? rows : []))
      .catch(err => setError(err.message || 'Failed to load team'))
      .finally(() => setLoading(false));
  };
  useEffect(reload, []);

  const addMember = async () => {
    if (!draft.name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!draft.sms_phone.trim() && !draft.email.trim()) {
      setError('Provide at least a phone number or an email — every teammate needs one channel.');
      return;
    }
    setAdding(true);
    setError('');
    try {
      const aliases = draft.aliases
        ? draft.aliases.split(',').map(s => s.trim()).filter(Boolean)
        : [];
      const created = await api('/api/team', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name.trim(),
          role: draft.role.trim() || null,
          sms_phone: draft.sms_phone.trim() || null,
          email: draft.email.trim() || null,
          sms_enabled: !!draft.sms_enabled,
          email_enabled: !!draft.email_enabled,
          is_default_recipient: !!draft.is_default_recipient,
          aliases
        })
      });
      setMembers(prev => {
        // If we just set a new default, clear the flag on any other row in
        // local state so the UI doesn't briefly show two defaults before
        // the next reload.
        const next = created.is_default_recipient
          ? prev.map(m => ({ ...m, is_default_recipient: false }))
          : [...prev];
        return [...next, created];
      });
      setDraft({
        name: '', role: '', sms_phone: '', email: '', aliases: '',
        sms_enabled: true, email_enabled: true, is_default_recipient: false
      });
    } catch (err) {
      setError(err.message || 'Failed to add team member');
    } finally {
      setAdding(false);
    }
  };

  const updateField = async (id, patch) => {
    try {
      const updated = await api(`/api/team/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      // If we just promoted this row to default, clear the flag on every
      // other row in local state so we don't briefly render two defaults.
      setMembers(prev => prev.map(m => {
        if (m.id === id) return updated;
        if (updated?.is_default_recipient) return { ...m, is_default_recipient: false };
        return m;
      }));
    } catch (err) {
      alert(err.message || 'Failed to update team member');
    }
  };

  const removeMember = async (id, name) => {
    if (!window.confirm(`Remove ${name} from the directory? They’ll no longer receive routed messages.`)) return;
    try {
      await api(`/api/team/${id}`, { method: 'DELETE' });
      setMembers(prev => prev.filter(m => m.id !== id));
    } catch (err) {
      alert(err.message || 'Failed to remove team member');
    }
  };

  const testSms = async (id, name) => {
    setTesting(id);
    try {
      const result = await api(`/api/team/${id}/test-sms`, { method: 'POST', body: JSON.stringify({}) });
      if (result.delivered) {
        alert(`Test SMS sent to ${name}. Check their phone.`);
      } else {
        alert(`Test SMS attempted for ${name} but Twilio reported it didn't deliver. Check the phone number.`);
      }
    } catch (err) {
      alert(`Test failed: ${err.message || 'unknown error'}`);
    } finally {
      setTesting(null);
    }
  };

  if (loading) return React.createElement('div', { className: 'text-sm text-gray-500' }, 'Loading team directory…');

  return React.createElement('div', null,
    React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
      'When a caller wants to leave a message for one of these people, the AI texts them the transcript. Add by name (first or full — the AI matches case-insensitively).'
    ),
    error && React.createElement('div', { className: 'mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2' }, error),

    members.length === 0
      ? React.createElement('p', { className: 'text-sm text-gray-400 italic mb-4' }, 'No team members yet. Add the first one below.')
      : React.createElement('div', { className: 'space-y-2 mb-6' },
          members.map(m =>
            React.createElement('div', {
              key: m.id,
              className: `border rounded-lg p-3 ${m.is_active ? 'bg-white' : 'bg-gray-50 opacity-70'}`
            },
              React.createElement('div', { className: 'flex items-start justify-between gap-3' },
                React.createElement('div', { className: 'flex-1 min-w-0' },
                  React.createElement('div', { className: 'flex items-center gap-2 flex-wrap' },
                    React.createElement('span', { className: 'font-semibold text-gray-800' }, m.name),
                    m.role && React.createElement('span', { className: 'text-xs text-gray-500' }, '• ' + m.role),
                    m.is_default_recipient && React.createElement('span', {
                      className: 'text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-semibold',
                      title: 'When the AI can’t match a caller’s spoken name, the message routes here.'
                    }, 'Default inbox'),
                    !m.is_active && React.createElement('span', { className: 'text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded' }, 'inactive')
                  ),
                  React.createElement('div', { className: 'text-xs text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-1' },
                    m.sms_phone && React.createElement('span', {
                      className: m.sms_enabled ? '' : 'opacity-50 line-through',
                      title: m.sms_enabled ? 'SMS enabled' : 'SMS disabled — texts will not be sent'
                    }, '📞 ' + m.sms_phone),
                    m.email && React.createElement('span', {
                      className: m.email_enabled ? '' : 'opacity-50 line-through',
                      title: m.email_enabled ? 'Email enabled' : 'Email disabled — emails will not be sent'
                    }, '✉️ ' + m.email)
                  ),
                  Array.isArray(m.aliases) && m.aliases.length > 0 && React.createElement('div', { className: 'text-xs text-gray-400 mt-1' },
                    'Also called: ' + m.aliases.join(', ')
                  )
                ),
                React.createElement('div', { className: 'flex flex-col gap-1 shrink-0' },
                  m.sms_phone && React.createElement('button', {
                    onClick: () => testSms(m.id, m.name),
                    disabled: !m.is_active || !m.sms_enabled || testing === m.id,
                    className: 'text-xs px-2 py-1 rounded bg-golf-50 text-golf-700 hover:bg-golf-100 disabled:opacity-50'
                  }, testing === m.id ? 'Sending…' : 'Test SMS'),
                  !m.is_default_recipient && m.is_active && React.createElement('button', {
                    onClick: () => updateField(m.id, { is_default_recipient: true }),
                    className: 'text-xs px-2 py-1 rounded bg-amber-50 text-amber-700 hover:bg-amber-100',
                    title: 'Make this the inbox-fallback when the AI can’t match a name'
                  }, 'Set default'),
                  m.is_default_recipient && React.createElement('button', {
                    onClick: () => updateField(m.id, { is_default_recipient: false }),
                    className: 'text-xs px-2 py-1 rounded bg-amber-100 text-amber-800 hover:bg-amber-200',
                    title: 'Remove default-recipient status from this teammate'
                  }, 'Unset default'),
                  React.createElement('button', {
                    onClick: () => updateField(m.id, { is_active: !m.is_active }),
                    className: 'text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }, m.is_active ? 'Disable' : 'Enable'),
                  React.createElement('button', {
                    onClick: () => removeMember(m.id, m.name),
                    className: 'text-xs px-2 py-1 rounded bg-red-50 text-red-700 hover:bg-red-100'
                  }, 'Remove')
                )
              )
            )
          )
        ),

    React.createElement('div', { className: 'border-t pt-4' },
      React.createElement('h3', { className: 'font-semibold text-sm mb-3' }, 'Add a team member'),
      React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3 mb-3' },
        React.createElement('input', {
          type: 'text', placeholder: 'Name (e.g. John Smith)',
          value: draft.name, onChange: e => setDraft({ ...draft, name: e.target.value }),
          className: 'border rounded-lg px-3 py-2 text-sm'
        }),
        React.createElement('input', {
          type: 'text', placeholder: 'Role / title (optional, e.g. Manager)',
          value: draft.role, onChange: e => setDraft({ ...draft, role: e.target.value }),
          className: 'border rounded-lg px-3 py-2 text-sm'
        }),
        React.createElement('input', {
          type: 'tel', placeholder: 'SMS phone (E.164 — +14165551234) — optional if email set',
          value: draft.sms_phone, onChange: e => setDraft({ ...draft, sms_phone: e.target.value }),
          className: 'border rounded-lg px-3 py-2 text-sm'
        }),
        React.createElement('input', {
          type: 'email', placeholder: 'Email (optional if phone set)',
          value: draft.email, onChange: e => setDraft({ ...draft, email: e.target.value }),
          className: 'border rounded-lg px-3 py-2 text-sm'
        }),
        React.createElement('input', {
          type: 'text', placeholder: 'Aliases (comma-separated, optional)',
          value: draft.aliases, onChange: e => setDraft({ ...draft, aliases: e.target.value }),
          className: 'border rounded-lg px-3 py-2 text-sm md:col-span-2'
        })
      ),
      // Per-channel preferences + default-recipient toggle. Drafted as
      // checkboxes so the operator can opt this teammate out of one
      // channel even when both columns are populated (e.g. accounting
      // gets emails but no texts).
      React.createElement('div', { className: 'flex flex-wrap gap-x-5 gap-y-2 text-sm mb-3 px-1' },
        React.createElement('label', { className: 'inline-flex items-center gap-2' },
          React.createElement('input', {
            type: 'checkbox', checked: !!draft.sms_enabled,
            onChange: e => setDraft({ ...draft, sms_enabled: e.target.checked })
          }),
          React.createElement('span', null, 'Send SMS')
        ),
        React.createElement('label', { className: 'inline-flex items-center gap-2' },
          React.createElement('input', {
            type: 'checkbox', checked: !!draft.email_enabled,
            onChange: e => setDraft({ ...draft, email_enabled: e.target.checked })
          }),
          React.createElement('span', null, 'Send email')
        ),
        React.createElement('label', {
          className: 'inline-flex items-center gap-2',
          title: 'When the AI can’t match a caller’s spoken name, route the message here.'
        },
          React.createElement('input', {
            type: 'checkbox', checked: !!draft.is_default_recipient,
            onChange: e => setDraft({ ...draft, is_default_recipient: e.target.checked })
          }),
          React.createElement('span', { className: 'text-amber-800' }, 'Make this the default inbox')
        )
      ),
      React.createElement('button', {
        onClick: addMember, disabled: adding,
        className: 'bg-golf-600 hover:bg-golf-700 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50'
      }, adding ? 'Adding…' : 'Add team member')
    )
  );
}

// ============================================
// CustomTopicsManager — operator-defined scenarios the AI should
// recognize and route. Each topic stores: name (e.g. "Lost & Found"),
// trigger_hint (when to fire — free text), ai_instructions (what to
// do during the call), notify_sms / notify_email (where to send the
// message). When the AI matches a topic mid-call, take_topic_message
// fires and the message lands on the Messages page + an SMS goes out.
// Stored in settings.custom_topics as a JSON array.
// ============================================
function CustomTopicsManager() {
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({
    name: '', trigger_hint: '', ai_instructions: '',
    notify_sms: '', notify_email: '', enabled: true
  });
  const [adding, setAdding] = useState(false);

  // Load the existing array. settings.custom_topics may be:
  //   - undefined (never saved) → []
  //   - { value: [...] } from the settings API wrapper
  //   - { value: { topics: [...] } } if someone wrapped it
  // Be defensive about all three.
  const reload = () => {
    setLoading(true);
    // The GET endpoint returns the full settings map keyed by setting
    // name. Pick out custom_topics; fall back to [] if it doesn't exist.
    api('/api/settings')
      .then(all => {
        const v = all?.custom_topics?.value;
        const arr = Array.isArray(v) ? v
          : Array.isArray(v?.topics) ? v.topics
          : [];
        setTopics(arr);
      })
      .catch(err => {
        setError(err.message || 'Failed to load custom topics');
      })
      .finally(() => setLoading(false));
  };
  useEffect(reload, []);

  const persist = async (next) => {
    setSaving(true); setError('');
    try {
      await api('/api/settings/custom_topics', {
        method: 'PUT',
        body: JSON.stringify({ value: next, description: 'Operator-defined topics the AI matches and routes' })
      });
      setTopics(next);
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addTopic = async () => {
    if (!draft.name.trim()) { setError('Name is required.'); return; }
    if (!draft.trigger_hint.trim()) { setError('Trigger hint is required so the AI knows when to use this topic.'); return; }
    if (!draft.notify_sms.trim() && !draft.notify_email.trim()) {
      setError('Add a phone number, an email, or both — otherwise the message has nowhere to go.');
      return;
    }
    setAdding(true); setError('');
    const next = [...topics, {
      name: draft.name.trim(),
      trigger_hint: draft.trigger_hint.trim(),
      ai_instructions: draft.ai_instructions.trim() || `Politely take a brief message capturing what the caller needs and a callback number, then call take_topic_message.`,
      notify_sms: draft.notify_sms.trim() || null,
      notify_email: draft.notify_email.trim() || null,
      enabled: !!draft.enabled
    }];
    await persist(next);
    setDraft({ name: '', trigger_hint: '', ai_instructions: '', notify_sms: '', notify_email: '', enabled: true });
    setAdding(false);
  };

  const updateTopic = async (idx, patch) => {
    const next = topics.map((t, i) => i === idx ? { ...t, ...patch } : t);
    await persist(next);
  };

  const removeTopic = async (idx, name) => {
    if (!window.confirm(`Remove the "${name}" topic? The AI will no longer recognize callers asking about this.`)) return;
    await persist(topics.filter((_, i) => i !== idx));
  };

  if (loading) return React.createElement('div', { className: 'text-sm text-gray-500' }, 'Loading custom topics…');

  return React.createElement('div', null,
    React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
      'Define scenarios the AI should recognize. When a caller’s question matches a topic’s trigger, the AI follows the instructions, takes a message, and routes it to the contact below — both as an SMS and as a row on the Messages page.'
    ),
    error && React.createElement('div', { className: 'mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2' }, error),

    topics.length === 0
      ? React.createElement('p', { className: 'text-sm text-gray-400 italic mb-4' }, 'No custom topics yet. Add one below — for example, "Lost & Found" or "Catering Inquiries".')
      : React.createElement('div', { className: 'space-y-3 mb-6' },
          topics.map((t, idx) =>
            React.createElement('div', {
              key: idx,
              className: `border rounded-lg p-4 ${t.enabled === false ? 'bg-gray-50 opacity-70' : 'bg-white'}`
            },
              React.createElement('div', { className: 'flex items-start justify-between gap-3 mb-2' },
                React.createElement('div', null,
                  React.createElement('div', { className: 'flex items-center gap-2 flex-wrap' },
                    React.createElement('span', { className: 'font-semibold text-gray-800 text-base' }, t.name),
                    t.enabled === false && React.createElement('span', { className: 'text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded' }, 'disabled')
                  )
                ),
                React.createElement('div', { className: 'flex flex-col gap-1 shrink-0' },
                  React.createElement('button', {
                    onClick: () => updateTopic(idx, { enabled: !t.enabled }),
                    disabled: saving,
                    className: 'text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50'
                  }, t.enabled === false ? 'Enable' : 'Disable'),
                  React.createElement('button', {
                    onClick: () => removeTopic(idx, t.name),
                    disabled: saving,
                    className: 'text-xs px-2 py-1 rounded bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50'
                  }, 'Remove')
                )
              ),
              React.createElement('div', { className: 'text-sm text-gray-600 mb-1' },
                React.createElement('span', { className: 'font-medium' }, 'When caller asks: '),
                t.trigger_hint || React.createElement('em', { className: 'text-gray-400' }, 'no trigger set')
              ),
              t.ai_instructions && React.createElement('div', { className: 'text-sm text-gray-600 mb-1' },
                React.createElement('span', { className: 'font-medium' }, 'AI does: '),
                t.ai_instructions
              ),
              React.createElement('div', { className: 'text-xs text-gray-500 mt-2 flex flex-wrap gap-x-3' },
                t.notify_sms && React.createElement('span', null, '📱 ' + t.notify_sms),
                t.notify_email && React.createElement('span', null, '✉️ ' + t.notify_email)
              )
            )
          )
        ),

    React.createElement('div', { className: 'border-t pt-4' },
      React.createElement('h3', { className: 'font-semibold text-sm mb-3' }, 'Add a custom topic'),
      React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3 mb-3' },
        React.createElement('input', {
          type: 'text', placeholder: 'Topic name (e.g. Lost & Found)',
          value: draft.name, onChange: e => setDraft({ ...draft, name: e.target.value }),
          className: 'border rounded-lg px-3 py-2 text-sm'
        }),
        React.createElement('input', {
          type: 'tel', placeholder: 'SMS phone (E.164 — +14165551234) — optional if email set',
          value: draft.notify_sms, onChange: e => setDraft({ ...draft, notify_sms: e.target.value }),
          className: 'border rounded-lg px-3 py-2 text-sm'
        }),
        React.createElement('input', {
          type: 'text', placeholder: 'When does the AI use this? e.g. caller mentions losing a club, glove, or item',
          value: draft.trigger_hint, onChange: e => setDraft({ ...draft, trigger_hint: e.target.value }),
          className: 'border rounded-lg px-3 py-2 text-sm md:col-span-2'
        }),
        React.createElement('textarea', {
          placeholder: 'AI instructions (optional). e.g. "Ask what was lost, when, and where on the course. Get name + callback number. Tell them we\'ll text if it turns up."',
          value: draft.ai_instructions, onChange: e => setDraft({ ...draft, ai_instructions: e.target.value }),
          rows: 3,
          className: 'border rounded-lg px-3 py-2 text-sm md:col-span-2'
        }),
        React.createElement('input', {
          type: 'email', placeholder: 'Email (optional if phone set)',
          value: draft.notify_email, onChange: e => setDraft({ ...draft, notify_email: e.target.value }),
          className: 'border rounded-lg px-3 py-2 text-sm md:col-span-2'
        })
      ),
      React.createElement('button', {
        onClick: addTopic, disabled: adding || saving,
        className: 'bg-golf-600 hover:bg-golf-700 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50'
      }, adding ? 'Adding…' : 'Add custom topic')
    )
  );
}

// ============================================
// MessagesPage  —  history of every message the AI took on behalf of a
// teammate, with delivery status and a mark-as-read button. Drives the
// "Messages" tab in the Command Center for tenants on the Business
// (or Personal Assistant) template. Reads from /api/messages.
// ============================================
function MessagesPage() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | 'unread' | 'failed'

  const reload = () => {
    setLoading(true);
    api('/api/messages?limit=200')
      .then(rows => setMessages(Array.isArray(rows) ? rows : []))
      .catch(err => setError(err.message || 'Failed to load messages'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { reload(); }, []);

  // Subscribe to live SSE updates so newly-taken messages appear
  // without a manual refresh. Reuses the existing /api/events stream.
  useEffect(() => {
    let es = null;
    try {
      const token = localStorage.getItem('gc_token') || '';
      const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
      es = new EventSource(url);
      const onAnything = () => reload();
      es.addEventListener('team_message.created', onAnything);
      es.addEventListener('team_message.updated', onAnything);
    } catch (_) { /* SSE disabled — we'll just rely on manual reload */ }
    return () => { try { es && es.close(); } catch (_) {} };
  }, []);

  const markRead = async (id) => {
    try {
      const updated = await api(`/api/messages/${id}/read`, { method: 'PATCH' });
      setMessages(prev => prev.map(m => m.id === id ? updated : m));
    } catch (err) {
      alert(err.message || 'Failed to mark read');
    }
  };

  const filtered = messages.filter(m => {
    if (filter === 'unread') return m.status !== 'read';
    if (filter === 'failed') return m.status === 'failed' || m.status === 'partial';
    return true;
  });

  const statusBadge = (status) => {
    const styles = {
      sent:           'bg-emerald-100 text-emerald-800',
      partial:        'bg-amber-100 text-amber-800',
      failed:         'bg-red-100 text-red-800',
      pending:        'bg-blue-100 text-blue-800',
      read:           'bg-gray-100 text-gray-600',
      dashboard_only: 'bg-gray-100 text-gray-600'
    };
    const label = {
      sent: 'Delivered',
      partial: 'Partial',
      failed: 'Failed',
      pending: 'Sending…',
      read: 'Read',
      dashboard_only: 'Dashboard only'
    }[status] || status;
    return React.createElement('span', {
      className: `text-xs px-2 py-0.5 rounded font-semibold ${styles[status] || 'bg-gray-100 text-gray-600'}`
    }, label);
  };

  return React.createElement('div', null,
    React.createElement('div', { className: 'flex items-center justify-between mb-4 flex-wrap gap-2' },
      React.createElement('div', null,
        React.createElement('h2', { className: 'text-2xl font-bold text-gray-800' }, 'Messages'),
        React.createElement('p', { className: 'text-sm text-gray-500' },
          'Every message the AI has taken for a teammate. SMS / email delivery status is tracked per row.'
        )
      ),
      React.createElement('div', { className: 'flex items-center gap-2 text-sm' },
        ['all', 'unread', 'failed'].map(f =>
          React.createElement('button', {
            key: f,
            onClick: () => setFilter(f),
            className: `px-3 py-1.5 rounded-lg ${filter === f ? 'bg-golf-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`
          }, f === 'all' ? 'All' : f === 'unread' ? 'Unread' : 'Failed / Partial')
        ),
        React.createElement('button', {
          onClick: reload,
          className: 'px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200'
        }, 'Refresh')
      )
    ),
    error && React.createElement('div', { className: 'mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2' }, error),
    loading && React.createElement('div', { className: 'text-sm text-gray-500' }, 'Loading messages…'),
    !loading && filtered.length === 0 && React.createElement('div', { className: 'text-sm text-gray-400 italic py-8 text-center' },
      filter === 'all' ? 'No messages yet — the AI will populate this list as callers leave messages.' : `No ${filter} messages.`
    ),
    !loading && filtered.length > 0 && React.createElement('div', { className: 'space-y-3' },
      filtered.map(m => React.createElement('div', {
        key: m.id,
        className: `border rounded-lg p-4 ${m.status === 'failed' || m.status === 'partial' ? 'border-red-200 bg-red-50/40' : m.status === 'read' ? 'bg-gray-50' : 'bg-white'}`
      },
        React.createElement('div', { className: 'flex items-start justify-between gap-3 flex-wrap' },
          React.createElement('div', { className: 'flex-1 min-w-0' },
            React.createElement('div', { className: 'flex items-center gap-2 flex-wrap mb-1' },
              React.createElement('span', { className: 'text-xs text-gray-500' },
                new Date(m.created_at).toLocaleString()
              ),
              React.createElement('span', { className: 'text-sm' },
                'For: ',
                React.createElement('strong', null, m.recipient_name)
              ),
              m.routed_to_default && React.createElement('span', {
                className: 'text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded',
                title: 'The caller didn’t name a specific person, so this routed to the default inbox.'
              }, 'Default routing'),
              statusBadge(m.status)
            ),
            React.createElement('div', { className: 'text-sm text-gray-700 mb-2' },
              'From: ',
              React.createElement('strong', null, m.caller_name || 'Unknown caller'),
              m.caller_phone && React.createElement('a', {
                href: `tel:${m.caller_phone}`,
                className: 'ml-2 text-blue-600 hover:underline'
              }, m.caller_phone)
            ),
            React.createElement('div', { className: 'text-sm text-gray-800 whitespace-pre-wrap bg-white border rounded px-3 py-2' }, m.body)
          ),
          m.status !== 'read' && React.createElement('button', {
            onClick: () => markRead(m.id),
            className: 'text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 shrink-0'
          }, 'Mark read')
        ),
        // When a delivery_detail blob has an error reason, surface it so
        // ops can debug a failed SMS without going to Twilio logs.
        (m.status === 'failed' || m.status === 'partial') && m.delivery_detail && (
          (m.delivery_detail.sms?.error || m.delivery_detail.email?.error)
            ? React.createElement('div', { className: 'mt-2 text-xs text-red-700 bg-red-100 border border-red-200 rounded px-2 py-1' },
                m.delivery_detail.sms?.error && React.createElement('div', null, 'SMS: ' + m.delivery_detail.sms.error),
                m.delivery_detail.email?.error && React.createElement('div', null, 'Email: ' + m.delivery_detail.email.error)
              )
            : null
        )
      ))
    )
  );
}

// Reusable setting field component
function SettingField({ label, description, value, onSave, saving, type = 'text' }) {
  const [localValue, setLocalValue] = useState(value);
  const changed = localValue !== value;

  useEffect(() => { setLocalValue(value); }, [value]);

  return React.createElement('div', { className: 'mb-6' },
    React.createElement('label', { className: 'block font-medium text-sm text-gray-700 mb-1' }, label),
    description && React.createElement('p', { className: 'text-xs text-gray-400 mb-2' }, description),
    React.createElement('div', { className: 'flex gap-2' },
      React.createElement('input', {
        type, value: localValue, onChange: e => setLocalValue(e.target.value),
        className: 'flex-1 border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none'
      }),
      React.createElement('button', {
        onClick: () => onSave(localValue), disabled: !changed || saving,
        className: `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${changed ? 'bg-golf-600 hover:bg-golf-700 text-white' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`
      }, saving ? 'Saving...' : 'Save')
    )
  );
}

// Reusable textarea setting component
function SettingTextarea({ label, description, value, onSave, saving, rows = 6 }) {
  const [localValue, setLocalValue] = useState(value);
  const changed = localValue !== value;

  useEffect(() => { setLocalValue(value); }, [value]);

  return React.createElement('div', { className: 'mb-6' },
    React.createElement('label', { className: 'block font-medium text-sm text-gray-700 mb-1' }, label),
    description && React.createElement('p', { className: 'text-xs text-gray-400 mb-2' }, description),
    React.createElement('textarea', {
      value: localValue, onChange: e => setLocalValue(e.target.value), rows,
      className: 'w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none'
    }),
    React.createElement('button', {
      onClick: () => onSave(localValue), disabled: !changed || saving,
      className: `mt-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${changed ? 'bg-golf-600 hover:bg-golf-700 text-white' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`
    }, saving ? 'Saving...' : 'Save Changes')
  );
}

// ============================================
// ACCEPT INVITE PAGE (public)
// ============================================
// Reached via /accept-invite?token=... — the super admin or business
// admin who sent the invite hands this URL to the invitee. The page
// validates the token against /auth/invite/:token, collects a password
// (and optional name), then POSTs to /auth/accept-invite and drops the
// user straight into the Command Center.
function AcceptInvitePage() {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const token = new URLSearchParams(window.location.search).get('token') || '';

  useEffect(() => {
    if (!token) {
      setError('Missing invite token.');
      setLoading(false);
      return;
    }
    api(`/auth/invite/${encodeURIComponent(token)}`)
      .then(setInvite)
      .catch(err => setError(err.message || 'Invite not found or expired.'))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      const data = await api('/auth/accept-invite', {
        method: 'POST',
        body: JSON.stringify({ token, password, name: name || null })
      });
      localStorage.setItem('gc_token', data.token);
      setSession({
        role: data.role,
        business_id: data.business_id,
        username: data.username,
        name: data.name
      });
      if (data.role === 'super_admin') setSelectedBusinessId(null);
      else setSelectedBusinessId(data.business_id);
      // Drop the query string and reload — takes us into the main app.
      window.location.href = '/';
    } catch (err) {
      setError(err.message || 'Failed to accept invite.');
    } finally {
      setSubmitting(false);
    }
  };

  const labelCls = 'block text-sm font-medium text-gray-700 mb-1';
  const inputCls = 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none';

  return React.createElement('div', { className: 'min-h-screen flex items-center justify-center bg-gradient-to-br from-golf-800 to-golf-900 p-4' },
    React.createElement('div', { className: 'bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md' },
      React.createElement('h1', { className: 'text-2xl font-bold text-gray-800 mb-2' }, 'Accept Invite'),
      loading && React.createElement('p', { className: 'text-gray-500' }, 'Validating invite\u2026'),
      !loading && error && React.createElement('div', { className: 'bg-red-50 text-red-600 p-3 rounded-lg text-sm' }, error),
      !loading && invite && React.createElement('form', { onSubmit: handleSubmit },
        React.createElement('p', { className: 'text-gray-600 mb-4 text-sm' },
          `You've been invited to join `,
          React.createElement('strong', null, invite.business_name || 'the platform'),
          ` as `,
          React.createElement('strong', null, invite.role.replace('_', ' ')),
          `. Set a password to activate `,
          React.createElement('span', { className: 'font-mono' }, invite.email),
          '.'
        ),
        error && React.createElement('div', { className: 'bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm' }, error),
        React.createElement('div', { className: 'mb-4' },
          React.createElement('label', { className: labelCls }, 'Your name'),
          React.createElement('input', { className: inputCls, type: 'text', value: name, onChange: e => setName(e.target.value), placeholder: 'Jane Doe' })
        ),
        React.createElement('div', { className: 'mb-4' },
          React.createElement('label', { className: labelCls }, 'Password'),
          React.createElement('input', { className: inputCls, type: 'password', value: password, onChange: e => setPassword(e.target.value), minLength: 8, required: true })
        ),
        React.createElement('div', { className: 'mb-6' },
          React.createElement('label', { className: labelCls }, 'Confirm password'),
          React.createElement('input', { className: inputCls, type: 'password', value: confirm, onChange: e => setConfirm(e.target.value), minLength: 8, required: true })
        ),
        React.createElement('button', {
          type: 'submit',
          disabled: submitting,
          className: 'w-full bg-golf-600 hover:bg-golf-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50'
        }, submitting ? 'Activating\u2026' : 'Activate account')
      )
    )
  );
}

// ============================================
// BUSINESS SWITCHER (super admin only)
// ============================================
// Appears in the top bar when a super admin is signed in. Selecting a
// business pins an X-Business-Id header on every subsequent /api/* call,
// so super admins can "act as" a tenant for support / debugging without
// logging out.
function BusinessSwitcher({ businesses, selectedId, onSelect }) {
  // Sort alphabetically so the dropdown is easy to scan even with dozens of
  // tenants. Platform (no-tenant) always sits at the top.
  const sorted = [...businesses].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''))
  );
  const options = [{ id: 'platform', label: 'Platform (no tenant)' }]
    .concat(sorted.map(b => {
      const suffix = b.status && b.status !== 'active' ? ` \u2022 ${b.status}` : '';
      return { id: b.id, label: `${b.name}${suffix}` };
    }));
  const currentValue = selectedId || 'platform';
  return React.createElement('select', {
    value: currentValue,
    onChange: e => {
      const v = e.target.value;
      onSelect(v === 'platform' ? null : parseInt(v, 10));
    },
    className: 'px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none max-w-[18rem]',
    title: 'Switch which tenant you are acting as'
  },
    options.map(o =>
      React.createElement('option', { key: o.id, value: o.id }, o.label)
    )
  );
}

// Two-letter avatar tile for a business, derived from the name. Purely
// visual — we don't rely on the characters anywhere meaningful.
function BusinessInitials({ name, size = 'md', color }) {
  const letters = String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('') || '?';
  const sizeCls = size === 'lg'
    ? 'w-12 h-12 text-base'
    : size === 'sm'
      ? 'w-7 h-7 text-xs'
      : 'w-10 h-10 text-sm';
  const bg = color || 'linear-gradient(135deg,#2E7D32,#1B5E20)';
  return React.createElement('div', {
    className: `${sizeCls} rounded-lg flex items-center justify-center text-white font-bold shrink-0`,
    style: { background: bg }
  }, letters);
}

// Visual status pill reused by the dashboard and the acting-as ribbon.
function StatusPill({ status }) {
  const tone = status === 'active' ? 'bg-green-100 text-green-700'
    : status === 'trial' ? 'bg-blue-100 text-blue-700'
    : status === 'suspended' ? 'bg-red-100 text-red-700'
    : status === 'cancelled' ? 'bg-gray-200 text-gray-600'
    : 'bg-gray-100 text-gray-600';
  return React.createElement('span', {
    className: `inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${tone}`
  }, status || 'unknown');
}

// A single metric chip ("Calls 30d · 42"). Compact enough to live inside a
// card grid without taking over the composition.
function MetricChip({ label, value, tone = 'default' }) {
  const toneCls = tone === 'green' ? 'bg-green-50 text-green-700'
    : tone === 'blue' ? 'bg-blue-50 text-blue-700'
    : tone === 'amber' ? 'bg-amber-50 text-amber-700'
    : 'bg-gray-50 text-gray-700';
  return React.createElement('div', { className: `${toneCls} rounded-lg px-3 py-2` },
    React.createElement('div', { className: 'text-[10px] uppercase tracking-wider opacity-70 font-semibold' }, label),
    React.createElement('div', { className: 'text-base font-bold mt-0.5' }, value)
  );
}

// Card rendered in the super-admin grid. Same information density as the
// old table row, but scannable at a glance and prettier for a platform
// operator flipping between tenants all day.
function BusinessCard({ business, onActAs, onManagePhones, onManageVoice, onEdit, onDelete }) {
  const isDeleted = !!business.deleted_at;
  // Delete protection is anchored to the original Valleymede tenant (id=1),
  // NOT the mutable `plan='legacy'` flag. Earlier code used the plan check,
  // but `legacy` is also a selectable value in the Edit-tenant plan dropdown,
  // so any tenant that happened to be saved with plan=legacy became
  // un-deletable. The real invariant we care about is "this is the original
  // pre-SaaS tenant" — that's always id=1.
  const isLegacy = business.id === 1;
  return React.createElement('div', {
    className: `bg-white rounded-xl shadow-sm border hover:shadow-md transition-shadow overflow-hidden flex flex-col ${isDeleted ? 'opacity-60' : ''}`
  },
    React.createElement('div', { className: 'p-5 flex items-start gap-3 border-b bg-gradient-to-br from-gray-50 to-white' },
      React.createElement(BusinessInitials, {
        name: business.name,
        size: 'lg',
        color: business.primary_color
          ? `linear-gradient(135deg, ${business.primary_color}, ${business.primary_color}CC)`
          : undefined
      }),
      React.createElement('div', { className: 'flex-1 min-w-0' },
        React.createElement('div', { className: 'flex items-center gap-2 flex-wrap' },
          React.createElement('h3', { className: 'text-base font-bold text-gray-800 truncate' }, business.name),
          isDeleted
            ? React.createElement('span', {
                className: 'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700 uppercase tracking-wide'
              }, 'Deleted')
            : React.createElement(StatusPill, { status: business.status })
        ),
        React.createElement('p', { className: 'text-xs text-gray-500 font-mono mt-1 truncate' }, business.slug),
        React.createElement('p', { className: 'text-xs text-gray-500 mt-1 truncate' },
          business.twilio_phone_number || React.createElement('span', { className: 'italic text-amber-600' }, 'no phone number yet')
        )
      )
    ),
    React.createElement('div', { className: 'p-4 grid grid-cols-3 gap-2' },
      React.createElement(MetricChip, { label: 'Users', value: business.active_user_count ?? 0 }),
      React.createElement(MetricChip, { label: 'Calls 30d', value: business.calls_last_30d ?? 0, tone: 'blue' }),
      React.createElement(MetricChip, { label: 'Bookings 30d', value: business.bookings_last_30d ?? 0, tone: 'green' })
    ),
    React.createElement('div', { className: 'px-4 py-3 bg-gray-50 border-t flex items-center justify-between text-xs gap-3 flex-wrap' },
      React.createElement('span', { className: 'text-gray-500 truncate min-w-0' },
        business.plan ? `Plan: ${business.plan}` : 'Plan: \u2014',
        business.setup_complete ? '' : ' \u2022 setup pending'
      ),
      // Action row. Wraps to a second line on narrow card widths so Delete
      // and Act-as never get pushed off the card. Legacy tenants (Valleymede
      // safety lock) still render Delete, but disabled + tooltipped so the
      // operator can see the button exists and understand why it's greyed —
      // previously we hid it entirely, which made it look like Delete was
      // missing from the UI.
      React.createElement('div', { className: 'flex items-center gap-3 flex-shrink-0 flex-wrap justify-end' },
        !isDeleted && typeof onEdit === 'function' && React.createElement('button', {
          onClick: () => onEdit(business),
          className: 'text-gray-600 hover:text-gray-900 font-semibold'
        }, '\u270f\ufe0f Edit'),
        !isDeleted && typeof onManagePhones === 'function' && React.createElement('button', {
          onClick: () => onManagePhones(business),
          className: 'text-gray-600 hover:text-gray-900 font-semibold'
        }, '\ud83d\udcde Phones'),
        !isDeleted && typeof onManageVoice === 'function' && React.createElement('button', {
          onClick: () => onManageVoice(business),
          className: 'text-gray-600 hover:text-gray-900 font-semibold',
          title: 'Override the xAI voice for this tenant'
        }, '\ud83c\udf99\ufe0f Voice'),
        !isDeleted && typeof onDelete === 'function' && React.createElement('button', {
          onClick: () => { if (!isLegacy) onDelete(business); },
          disabled: isLegacy,
          className: isLegacy
            ? 'text-gray-400 cursor-not-allowed font-semibold'
            : 'text-red-600 hover:text-red-800 font-semibold',
          title: isLegacy
            ? 'Protected — this is the original tenant (id=1) and cannot be deleted.'
            : 'Soft-delete this tenant'
        }, '\ud83d\uddd1 Delete'),
        !isDeleted && React.createElement('button', {
          onClick: () => onActAs(business.id),
          className: 'text-golf-700 hover:text-golf-900 font-semibold'
        }, 'Act as \u2192')
      )
    )
  );
}

// ============================================
// EDIT TENANT MODAL (super admin)
// ============================================
// Loads the full tenant via GET /api/super/businesses/:id, shows a form
// pre-populated with every editable field, and submits the diff via PATCH.
// Template is intentionally read-only (see PATCH comment in server/routes/
// super-admin.js) — switching vertical post-creation would overwrite
// per-tenant customisation, so the path is "delete + create new" instead.
// ============================================
// TENANT USERS PANEL — list + reset password + activate/deactivate
// ============================================
//
// Mounts inside the Edit Tenant modal. Shows every business_users row
// for the tenant, with three super-admin actions per user:
//   • Reset password — generates or accepts a new password and shows
//     it ONCE in a copy-to-clipboard panel. We never display existing
//     passwords because they're bcrypt-hashed and unrecoverable.
//   • Toggle is_active — soft-disable a user account.
//   • (Read-only) email / role / last login.
//
// IMPORTANT: a "view password" affordance is intentionally NOT
// implemented. If a tenant forgets their password, super-admin resets
// it and shares the new one out-of-band. That's the same flow every
// reputable platform uses (banks, GitHub, Twilio, etc.) and is a hard
// requirement of password hashing.
// ============================================
// CREDITS PANEL — read balance + grant credits (Phase 7b)
// ============================================
//
// Mounted inside the Edit Tenant modal. Shows the tenant's plan,
// remaining seconds (formatted as minutes), trial expiry if any, and
// gives the super-admin a one-click way to grant more time. Closes the
// pre-launch gap flagged by the audit reviewer: without this, any
// non-legacy tenant whose 14-day / 1-hour trial expired had no recovery
// path other than direct SQL.
//
// Legacy-plan tenants (Valleymede id=1) bypass the credit gate entirely
// in canAcceptCall, so granting them seconds is a no-op. The server
// returns 409 in that case and we surface it as a helpful banner instead
// of an error.
function CreditsPanel({ businessId }) {
  const [snap, setSnap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [note, setNote] = useState('');
  const [isFree, setIsFree] = useState(true);
  const [granting, setGranting] = useState(false);
  const [lastGrant, setLastGrant] = useState(null);

  const reload = () => {
    setLoading(true);
    api(`/api/super/businesses/${businessId}/credits`)
      .then(d => setSnap(d))
      .catch(err => setError(err.message || 'Failed to load credits'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (businessId) reload(); }, [businessId]);

  const grant = async () => {
    const n = parseInt(minutes, 10);
    if (!Number.isFinite(n) || n === 0) {
      setError('Enter a non-zero number of minutes (negative deducts).');
      return;
    }
    setGranting(true);
    setError('');
    setLastGrant(null);
    try {
      const result = await api(`/api/super/businesses/${businessId}/credits`, {
        method: 'POST',
        body: JSON.stringify({ minutes: n, note: note.trim() || null, is_free: isFree })
      });
      setLastGrant(result);
      setNote('');
      reload();
    } catch (err) {
      setError(err.message || 'Grant failed');
    } finally {
      setGranting(false);
    }
  };

  if (loading) return React.createElement('p', { className: 'text-sm text-gray-500' }, 'Loading credits…');

  // Legacy tenants don't go through the credit gate, so the controls
  // are useless. Show a clear note instead of a broken form.
  if (snap?.plan === 'legacy') {
    return React.createElement('div', { className: 'text-sm text-gray-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2' },
      React.createElement('strong', null, 'Plan: legacy. '),
      'This tenant bypasses the credit gate (every call is allowed regardless of balance). Granting credits has no effect.'
    );
  }

  const minutesRemaining = snap?.minutes_remaining ?? 0;
  const trialActive = !!snap?.trial_active;
  const trialExpiry = snap?.trial_expires_at ? new Date(snap.trial_expires_at) : null;

  return React.createElement('div', null,
    error && React.createElement('div', {
      className: 'mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2'
    }, error),

    // Current state row
    React.createElement('div', { className: 'flex items-baseline gap-4 mb-3 text-sm' },
      React.createElement('span', null,
        React.createElement('span', { className: 'text-gray-500' }, 'Plan: '),
        React.createElement('span', { className: 'font-semibold' }, snap?.plan || '—')
      ),
      React.createElement('span', null,
        React.createElement('span', { className: 'text-gray-500' }, 'Balance: '),
        React.createElement('span', { className: `font-semibold ${minutesRemaining > 0 ? 'text-green-700' : 'text-red-700'}` },
          `${minutesRemaining} min${minutesRemaining === 1 ? '' : 's'}`)
      ),
      trialActive && trialExpiry && React.createElement('span', { className: 'text-xs text-gray-500' },
        `Trial expires ${trialExpiry.toLocaleString()}`
      )
    ),

    // Grant form — minutes + note + free/paid toggle. Negative minutes
    // deducts (rare; the server caps single grants at 24h to prevent
    // typos like 60000 instead of 60).
    React.createElement('div', { className: 'border-t pt-3 space-y-2' },
      React.createElement('div', { className: 'grid grid-cols-2 gap-2' },
        React.createElement('div', null,
          React.createElement('label', { className: 'text-xs text-gray-600 block mb-1' }, 'Minutes to grant'),
          React.createElement('input', {
            type: 'number',
            value: minutes,
            onChange: e => setMinutes(e.target.value),
            placeholder: '60',
            className: 'w-full text-sm border rounded-lg px-3 py-2'
          })
        ),
        React.createElement('div', null,
          React.createElement('label', { className: 'text-xs text-gray-600 block mb-1' }, 'Type'),
          React.createElement('select', {
            value: isFree ? 'free' : 'paid',
            onChange: e => setIsFree(e.target.value === 'free'),
            className: 'w-full text-sm border rounded-lg px-3 py-2 bg-white'
          },
            React.createElement('option', { value: 'free' }, 'Free / comp'),
            React.createElement('option', { value: 'paid' }, 'Paid (recorded externally)')
          )
        )
      ),
      React.createElement('input', {
        type: 'text',
        value: note,
        onChange: e => setNote(e.target.value),
        placeholder: 'Note (optional, e.g. "comp for May tournament")',
        className: 'w-full text-sm border rounded-lg px-3 py-2'
      }),
      React.createElement('div', { className: 'flex items-center gap-2' },
        React.createElement('button', {
          onClick: grant,
          disabled: granting,
          className: 'text-sm px-3 py-1.5 rounded-lg bg-golf-600 hover:bg-golf-700 text-white disabled:opacity-50'
        }, granting ? 'Granting…' : 'Grant credits'),
        React.createElement('span', { className: 'text-[11px] text-gray-500' },
          'Negative minutes deducts. Single grant capped at 1440 min (24h).'
        )
      )
    ),

    lastGrant && React.createElement('div', {
      className: 'mt-3 text-xs text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2'
    },
      `✓ Granted ${lastGrant.delta_minutes >= 0 ? '+' : ''}${lastGrant.delta_minutes} min · `,
      `New balance: ${lastGrant.balance_after_minutes} min · `,
      `Ledger #${lastGrant.ledger_id}`
    )
  );
}

function TenantUsersPanel({ businessId, endpointBase: endpointBaseProp }) {
  // Two callers, one component:
  //   - Super Admin → Edit Tenant modal: passes businessId, hits
  //     /api/super/businesses/:id/users/* (cross-tenant management).
  //   - In-tenant Settings → Users tab: passes neither, defaults to
  //     /api/users/* (self-service for the signed-in tenant).
  // Whichever is set wins; the rest of the component is identical.
  const endpointBase = endpointBaseProp
    || (businessId ? `/api/super/businesses/${businessId}/users` : '/api/users');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resetTarget, setResetTarget] = useState(null);   // user being reset
  const [resetMode, setResetMode] = useState('generate'); // 'generate' | 'manual'
  const [manualPwd, setManualPwd] = useState('');
  const [resetting, setResetting] = useState(false);
  const [revealed, setRevealed] = useState(null);         // { userId, email, password, signinUrl }
  // SMS-dispatch state for the reveal modal. `smsTo` is a phone number
  // the operator types; `smsStatus` is the send result we surface inline.
  const [smsTo, setSmsTo] = useState('');
  const [smsSending, setSmsSending] = useState(false);
  const [smsStatus, setSmsStatus] = useState(null); // { ok: bool, message: string }
  // Add-user form state. `addOpen` toggles the inline form; we keep it
  // collapsed by default so the panel stays compact for tenants that
  // don't need to add anyone.
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({
    email: '', name: '', role: 'business_admin', mode: 'generate', password: ''
  });
  const [adding, setAdding] = useState(false);

  const reload = () => {
    setLoading(true);
    api(`${endpointBase}`)
      .then(d => setUsers(d?.users || []))
      .catch(err => setError(err.message || 'Failed to load users'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (businessId) reload(); }, [businessId]);

  const beginReset = (user) => {
    setResetTarget(user);
    setResetMode('generate');
    setManualPwd('');
    setRevealed(null);
  };

  const submitReset = async () => {
    if (!resetTarget) return;
    setResetting(true);
    setError('');
    try {
      const body = resetMode === 'generate'
        ? { generate: true }
        : { password: manualPwd };
      const result = await api(
        `${endpointBase}/${resetTarget.id}/reset-password`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      setRevealed({
        userId: resetTarget.id,
        email: result?.user?.email || resetTarget.email,
        password: result?.password || '',
        // Reset doesn't return a signin_url today (it's only on create);
        // we synthesize one here so the reveal modal stays consistent
        // and the operator gets the same paste-and-share UX.
        signinUrl: typeof window !== 'undefined' && resetTarget?.email
          ? `${window.location.origin}/?email=${encodeURIComponent(resetTarget.email)}`
          : ''
      });
      setSmsTo('');
      setSmsStatus(null);
      setResetTarget(null);
      setManualPwd('');
    } catch (err) {
      setError(err.message || 'Reset failed');
    } finally {
      setResetting(false);
    }
  };

  const cancelReset = () => {
    setResetTarget(null);
    setManualPwd('');
  };

  const dismissRevealed = () => {
    setRevealed(null);
    setSmsTo('');
    setSmsStatus(null);
  };

  const sendSmsCredentials = async () => {
    if (!revealed?.userId || !smsTo.trim()) return;
    setSmsSending(true);
    setSmsStatus(null);
    try {
      const result = await api(
        `${endpointBase}/${revealed.userId}/send-credentials-sms`,
        {
          method: 'POST',
          body: JSON.stringify({
            to: smsTo.trim(),
            password: revealed.password,
            signin_url: revealed.signinUrl || null
          })
        }
      );
      setSmsStatus({
        ok: true,
        message: `Sent to ${result?.to || smsTo.trim()}${result?.from ? ` from ${result.from}` : ''}.`
      });
    } catch (err) {
      setSmsStatus({ ok: false, message: err.message || 'SMS dispatch failed' });
    } finally {
      setSmsSending(false);
    }
  };

  const copyPassword = async () => {
    if (!revealed?.password) return;
    try { await navigator.clipboard?.writeText(revealed.password); } catch (_) {}
  };

  const copySignin = async () => {
    if (!revealed?.signinUrl) return;
    try { await navigator.clipboard?.writeText(revealed.signinUrl); } catch (_) {}
  };

  const copyShareBundle = async () => {
    if (!revealed) return;
    const lines = [];
    if (revealed.signinUrl) lines.push(`Sign in: ${revealed.signinUrl}`);
    if (revealed.email)     lines.push(`Email: ${revealed.email}`);
    if (revealed.password)  lines.push(`Temporary password: ${revealed.password}`);
    try { await navigator.clipboard?.writeText(lines.join('\n')); } catch (_) {}
  };

  const toggleActive = async (user) => {
    try {
      await api(`${endpointBase}/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !user.is_active })
      });
      reload();
    } catch (err) {
      alert(err.message || 'Failed to update user');
    }
  };

  const removeUser = async (user) => {
    const confirmed = window.confirm(
      `Permanently remove ${user.email} from this tenant?\n\n` +
      `This deletes their account row entirely. They will lose access immediately and their email will be free for re-add. This cannot be undone — only the audit log will retain the record.`
    );
    if (!confirmed) return;
    try {
      await api(`${endpointBase}/${user.id}`, {
        method: 'DELETE'
      });
      reload();
    } catch (err) {
      alert(err.message || 'Failed to remove user');
    }
  };

  const submitAdd = async () => {
    setAdding(true);
    setError('');
    try {
      const body = {
        email: addForm.email.trim().toLowerCase(),
        name: addForm.name.trim() || undefined,
        role: addForm.role
      };
      if (addForm.mode === 'manual') {
        body.password = addForm.password;
      } else {
        body.generate = true;
      }
      const result = await api(`${endpointBase}`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      // Show the one-time password reveal modal — same UX as reset.
      setRevealed({
        userId: result?.user?.id || null,
        email: result?.user?.email || addForm.email,
        password: result?.password || '',
        signinUrl: result?.signin_url || ''
      });
      setSmsTo('');
      setSmsStatus(null);
      setAddOpen(false);
      setAddForm({ email: '', name: '', role: 'business_admin', mode: 'generate', password: '' });
      reload();
    } catch (err) {
      setError(err.message || 'Failed to create user');
    } finally {
      setAdding(false);
    }
  };

  return React.createElement('div', null,
    error && React.createElement('div', {
      className: 'mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2'
    }, error),

    loading
      ? React.createElement('p', { className: 'text-sm text-gray-500' }, 'Loading users…')
      : users.length === 0
        ? React.createElement('p', { className: 'text-sm text-gray-500 italic' }, 'No users on this tenant yet.')
        : React.createElement('div', { className: 'space-y-2' },
            users.map(u =>
              React.createElement('div', {
                key: u.id,
                className: `border rounded-lg p-3 ${u.is_active ? 'bg-white' : 'bg-gray-50 opacity-75'}`
              },
                React.createElement('div', { className: 'flex items-start justify-between gap-3' },
                  React.createElement('div', { className: 'flex-1 min-w-0' },
                    React.createElement('div', { className: 'flex items-center gap-2 flex-wrap' },
                      React.createElement('span', { className: 'font-semibold text-sm text-gray-800 truncate' }, u.email),
                      React.createElement('span', {
                        className: 'text-[10px] uppercase tracking-wide bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded'
                      }, u.role || 'staff'),
                      !u.is_active && React.createElement('span', {
                        className: 'text-[10px] uppercase tracking-wide bg-red-100 text-red-700 px-1.5 py-0.5 rounded'
                      }, 'inactive')
                    ),
                    u.name && React.createElement('div', { className: 'text-xs text-gray-500 mt-0.5' }, u.name),
                    React.createElement('div', { className: 'text-[11px] text-gray-400 mt-0.5' },
                      u.last_login_at
                        ? `Last sign-in: ${new Date(u.last_login_at).toLocaleString()}`
                        : 'Never signed in'
                    )
                  ),
                  React.createElement('div', { className: 'flex flex-col gap-1 shrink-0' },
                    React.createElement('button', {
                      onClick: () => beginReset(u),
                      className: 'text-xs px-2 py-1 rounded bg-golf-50 text-golf-700 hover:bg-golf-100 whitespace-nowrap'
                    }, 'Reset password'),
                    React.createElement('button', {
                      onClick: () => toggleActive(u),
                      className: 'text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }, u.is_active ? 'Disable' : 'Enable'),
                    React.createElement('button', {
                      onClick: () => removeUser(u),
                      className: 'text-xs px-2 py-1 rounded bg-red-50 text-red-700 hover:bg-red-100'
                    }, 'Remove')
                  )
                )
              )
            )
          ),

    React.createElement('p', { className: 'text-[11px] text-gray-500 mt-3' },
      'Existing passwords are stored hashed and cannot be retrieved. Use Reset password to set a new one and share it with the tenant out-of-band.'
    ),

    // Add-user form: collapsed by default, expands inline on click.
    React.createElement('div', { className: 'mt-4 border-t pt-3' },
      !addOpen
        ? React.createElement('button', {
            onClick: () => setAddOpen(true),
            className: 'text-sm px-3 py-1.5 rounded-lg bg-golf-50 text-golf-700 hover:bg-golf-100 font-medium'
          }, '+ Add user')
        : React.createElement('div', { className: 'space-y-3' },
            React.createElement('h4', { className: 'font-semibold text-sm' }, 'Add a new user'),
            React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-2' },
              React.createElement('input', {
                type: 'email', placeholder: 'Email',
                value: addForm.email,
                onChange: e => setAddForm(f => ({ ...f, email: e.target.value })),
                className: 'border rounded-lg px-3 py-2 text-sm'
              }),
              React.createElement('input', {
                type: 'text', placeholder: 'Name (optional)',
                value: addForm.name,
                onChange: e => setAddForm(f => ({ ...f, name: e.target.value })),
                className: 'border rounded-lg px-3 py-2 text-sm'
              }),
              React.createElement('select', {
                value: addForm.role,
                onChange: e => setAddForm(f => ({ ...f, role: e.target.value })),
                className: 'border rounded-lg px-3 py-2 text-sm bg-white'
              },
                React.createElement('option', { value: 'business_admin' }, 'Business Admin'),
                React.createElement('option', { value: 'staff' }, 'Staff')
              ),
              React.createElement('select', {
                value: addForm.mode,
                onChange: e => setAddForm(f => ({ ...f, mode: e.target.value })),
                className: 'border rounded-lg px-3 py-2 text-sm bg-white'
              },
                React.createElement('option', { value: 'generate' }, 'Auto-generate password'),
                React.createElement('option', { value: 'manual' }, 'Set a specific password')
              )
            ),
            addForm.mode === 'manual' && React.createElement('input', {
              type: 'text', placeholder: 'Password (min 8 chars, no spaces)',
              value: addForm.password,
              onChange: e => setAddForm(f => ({ ...f, password: e.target.value })),
              className: 'w-full border rounded-lg px-3 py-2 text-sm'
            }),
            React.createElement('div', { className: 'flex gap-2' },
              React.createElement('button', {
                onClick: submitAdd,
                disabled: adding || !addForm.email.trim() || (addForm.mode === 'manual' && addForm.password.length < 8),
                className: 'text-sm px-3 py-1.5 rounded-lg bg-golf-600 hover:bg-golf-700 text-white disabled:opacity-50'
              }, adding ? 'Creating…' : 'Create user'),
              React.createElement('button', {
                onClick: () => { setAddOpen(false); setError(''); setAddForm({ email: '', name: '', role: 'business_admin', mode: 'generate', password: '' }); },
                disabled: adding,
                className: 'text-sm px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700'
              }, 'Cancel')
            )
          )
    ),

    // Reset confirmation modal
    resetTarget && React.createElement('div', {
      className: 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4',
      onClick: cancelReset
    },
      React.createElement('div', {
        className: 'bg-white rounded-2xl shadow-xl max-w-md w-full p-6',
        onClick: e => e.stopPropagation()
      },
        React.createElement('h3', { className: 'text-base font-bold text-gray-800 mb-1' }, 'Reset password'),
        React.createElement('p', { className: 'text-sm text-gray-600 mb-4' },
          `For ${resetTarget.email}. The current password will be invalidated immediately.`
        ),
        React.createElement('div', { className: 'space-y-2 mb-4' },
          React.createElement('label', { className: 'flex items-start gap-2 text-sm' },
            React.createElement('input', {
              type: 'radio', name: 'resetMode', checked: resetMode === 'generate',
              onChange: () => setResetMode('generate'),
              className: 'mt-0.5'
            }),
            React.createElement('span', null,
              React.createElement('span', { className: 'font-medium' }, 'Generate a secure password'),
              React.createElement('span', { className: 'text-xs text-gray-500 block' },
                '14 characters, no ambiguous letters. Recommended.'
              )
            )
          ),
          React.createElement('label', { className: 'flex items-start gap-2 text-sm' },
            React.createElement('input', {
              type: 'radio', name: 'resetMode', checked: resetMode === 'manual',
              onChange: () => setResetMode('manual'),
              className: 'mt-0.5'
            }),
            React.createElement('span', null,
              React.createElement('span', { className: 'font-medium' }, 'Set a specific password'),
              React.createElement('span', { className: 'text-xs text-gray-500 block' },
                'Min 8 characters, no whitespace.'
              )
            )
          ),
          resetMode === 'manual' && React.createElement('input', {
            type: 'text',
            value: manualPwd,
            onChange: e => setManualPwd(e.target.value),
            placeholder: 'New password',
            className: 'w-full text-sm border rounded-lg px-3 py-2 ml-6'
          })
        ),
        React.createElement('div', { className: 'flex justify-end gap-2' },
          React.createElement('button', {
            onClick: cancelReset, disabled: resetting,
            className: 'text-sm px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700'
          }, 'Cancel'),
          React.createElement('button', {
            onClick: submitReset, disabled: resetting || (resetMode === 'manual' && !manualPwd),
            className: 'text-sm px-3 py-1.5 rounded-lg bg-golf-600 hover:bg-golf-700 text-white disabled:opacity-50'
          }, resetting ? 'Resetting…' : 'Reset password')
        )
      )
    ),

    // One-time password + sign-in link reveal modal
    revealed && React.createElement('div', {
      className: 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4',
      onClick: dismissRevealed
    },
      React.createElement('div', {
        className: 'bg-white rounded-2xl shadow-xl max-w-lg w-full p-6',
        onClick: e => e.stopPropagation()
      },
        React.createElement('h3', { className: 'text-base font-bold text-gray-800 mb-1' },
          '🔑 New credentials — copy them now'
        ),
        React.createElement('p', { className: 'text-sm text-gray-600 mb-4' },
          `For ${revealed.email}. This password is only shown once — once you close this dialog we cannot retrieve it. Share these with the user out-of-band (text, secure email, password manager, etc.).`
        ),

        revealed.signinUrl && React.createElement('div', { className: 'mb-3' },
          React.createElement('div', { className: 'flex items-center justify-between mb-1' },
            React.createElement('span', { className: 'text-xs font-semibold text-gray-500 uppercase tracking-wide' }, 'Sign-in link'),
            React.createElement('button', {
              onClick: copySignin,
              className: 'text-xs text-golf-700 hover:text-golf-800'
            }, 'Copy link')
          ),
          React.createElement('div', {
            className: 'font-mono text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-all select-all'
          }, revealed.signinUrl),
          React.createElement('p', { className: 'text-[11px] text-gray-500 mt-1' },
            'Opens the Command Center login with the email pre-filled.'
          )
        ),

        React.createElement('div', { className: 'mb-4' },
          React.createElement('div', { className: 'flex items-center justify-between mb-1' },
            React.createElement('span', { className: 'text-xs font-semibold text-gray-500 uppercase tracking-wide' }, 'Temporary password'),
            React.createElement('button', {
              onClick: copyPassword,
              className: 'text-xs text-golf-700 hover:text-golf-800'
            }, 'Copy password')
          ),
          React.createElement('div', {
            className: 'font-mono text-base bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-all select-all'
          }, revealed.password)
        ),

        // SMS dispatch — only available when we know which user to log
        // against (i.e. created/reset within this same session). The
        // server sends FROM the tenant's primary Twilio number, so the
        // recipient sees a recognizable caller ID.
        revealed.userId && React.createElement('div', { className: 'mb-4 border-t pt-3' },
          React.createElement('div', { className: 'text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2' },
            'Text it to the user'
          ),
          React.createElement('div', { className: 'flex gap-2' },
            React.createElement('input', {
              type: 'tel',
              placeholder: '+14165551234',
              value: smsTo,
              onChange: e => setSmsTo(e.target.value),
              disabled: smsSending,
              className: 'flex-1 text-sm border rounded-lg px-3 py-2 disabled:bg-gray-50'
            }),
            React.createElement('button', {
              onClick: sendSmsCredentials,
              disabled: smsSending || !smsTo.trim(),
              className: 'text-sm px-3 py-2 rounded-lg bg-golf-600 hover:bg-golf-700 text-white disabled:opacity-50 whitespace-nowrap'
            }, smsSending ? 'Sending…' : '📱 Send SMS')
          ),
          smsStatus && React.createElement('p', {
            className: `mt-2 text-xs ${smsStatus.ok ? 'text-green-700' : 'text-red-700'}`
          }, smsStatus.ok ? `✓ ${smsStatus.message}` : `✗ ${smsStatus.message}`),
          React.createElement('p', { className: 'text-[11px] text-gray-500 mt-1' },
            'Sent from this tenant’s primary Twilio number. The message includes the sign-in link, email, and temporary password.'
          )
        ),

        React.createElement('div', { className: 'flex justify-between items-center gap-2' },
          React.createElement('button', {
            onClick: copyShareBundle,
            className: 'text-sm px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700'
          }, '📋 Copy link + email + password'),
          React.createElement('button', {
            onClick: dismissRevealed,
            className: 'text-sm px-3 py-1.5 rounded-lg bg-golf-600 hover:bg-golf-700 text-white'
          }, 'I saved it')
        )
      )
    )
  );
}

function EditTenantModal({ business, onClose, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [ownerProfile, setOwnerProfile] = useState(null);
  const [originalOwnerProfile, setOriginalOwnerProfile] = useState(null);
  // Original template_key — used to decide whether to show the
  // "switching template" warning banner and to label the previous value.
  const [originalTemplateKey, setOriginalTemplateKey] = useState(null);
  // Snapshot of form values at load time. Save() compares against this so
  // we only PATCH columns the operator actually changed — sending the
  // whole form back would re-write `slug` / `twilio_phone_number` to
  // their existing values, which trips a 23505 if any soft-deleted
  // tenant happens to be hoarding the same identifier.
  const [originalForm, setOriginalForm] = useState(null);
  // Catalog of available templates for the dropdown. Loaded from
  // /api/super/templates so the same registry powers wizard + edit.
  const [templates, setTemplates] = useState([]);
  // Voice tier — separate state so we can detect "did the operator
  // change it?" cheaply and only push a settings patch when they did.
  const [voiceConfig, setVoiceConfig] = useState({ tier: 'standard' });
  const [originalVoiceConfig, setOriginalVoiceConfig] = useState({ tier: 'standard' });
  // Catalog of voice tiers (loaded from /api/super/voice-tiers — same
  // source the wizard uses). Falls back to a minimal hardcoded list if
  // the catalog endpoint is offline so the dropdown still works.
  const [voiceTiers, setVoiceTiers] = useState([]);

  useEffect(() => {
    if (!business) return;
    setLoading(true);
    Promise.all([
      api(`/api/super/businesses/${business.id}`),
      api('/api/super/templates').catch(() => ({ templates: [] })),
      api('/api/super/voice-tiers').catch(() => ({ tiers: [] }))
    ])
      .then(([resp, tpl, vt]) => {
        const b = resp.business;
        const initialForm = {
          name: b.name || '',
          slug: b.slug || '',
          twilio_phone_number: b.twilio_phone_number || '',
          transfer_number: b.transfer_number || '',
          timezone: b.timezone || '',
          contact_email: b.contact_email || '',
          contact_phone: b.contact_phone || '',
          status: b.status || 'active',
          is_active: b.is_active !== false,
          plan: b.plan || 'free',
          primary_color: b.primary_color || '',
          logo_url: b.logo_url || '',
          internal_notes: b.internal_notes || '',
          billing_notes: b.billing_notes || '',
          template_key: b.template_key || ''
        };
        setForm(initialForm);
        setOriginalForm(initialForm);
        setOriginalTemplateKey(b.template_key || null);
        setTemplates(Array.isArray(tpl?.templates) ? tpl.templates : []);
        setVoiceTiers(Array.isArray(vt?.tiers) ? vt.tiers : []);
        // Only surface owner_profile if the tenant has a settings row for
        // it. The PA wizard seeds assistant_name into this object; we
        // expose just that field (plus any raw JSON for power users).
        const op = resp.settings?.owner_profile || null;
        setOwnerProfile(op);
        setOriginalOwnerProfile(op ? JSON.parse(JSON.stringify(op)) : null);
        // Read the existing voice_config (tier + optional voice override).
        // Default to `standard` for tenants that haven't been onboarded
        // through the new wizard yet — that matches what grok-voice falls
        // back to anyway.
        const vc = resp.settings?.voice_config || { tier: 'standard' };
        const normalized = {
          tier: typeof vc.tier === 'string' && vc.tier ? vc.tier : 'standard',
          voice: typeof vc.voice === 'string' && vc.voice ? vc.voice : ''
        };
        setVoiceConfig(normalized);
        setOriginalVoiceConfig(JSON.parse(JSON.stringify(normalized)));
      })
      .catch(err => setError(err.message || 'Failed to load tenant'))
      .finally(() => setLoading(false));
  }, [business]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      // Only PATCH columns the operator actually changed. Sending the
      // whole form back would re-UPDATE every column to its existing
      // value — and any column with a UNIQUE index (slug,
      // twilio_phone_number) trips a 23505 if a soft-deleted tenant
      // somewhere is hoarding the same value. The PATCH endpoint
      // accepts partial bodies, so this just works.
      const payload = {};
      if (originalForm) {
        for (const k of Object.keys(form)) {
          if (form[k] !== originalForm[k]) payload[k] = form[k];
        }
      } else {
        // First-load fallback (shouldn't fire — useEffect sets
        // originalForm at the same time as form — but defend anyway).
        Object.assign(payload, form);
      }
      // Only include settings.* keys that actually changed — avoids
      // bumping updated_at on settings rows the operator didn't touch,
      // which keeps the audit log tidy.
      const settingsPatch = {};
      if (ownerProfile && JSON.stringify(ownerProfile) !== JSON.stringify(originalOwnerProfile)) {
        settingsPatch.owner_profile = ownerProfile;
      }
      if (JSON.stringify(voiceConfig) !== JSON.stringify(originalVoiceConfig)) {
        // Strip the empty-string voice override so we don't write
        // `voice: ""` into the JSONB — the resolver would treat that the
        // same as null, but cleaner not to persist it.
        const next = { tier: voiceConfig.tier };
        if (voiceConfig.voice && voiceConfig.voice.trim()) next.voice = voiceConfig.voice.trim();
        settingsPatch.voice_config = next;
      }
      if (Object.keys(settingsPatch).length > 0) {
        payload.settings = settingsPatch;
      }
      // Nothing changed at all? Just close the modal.
      if (Object.keys(payload).length === 0) {
        onClose();
        return;
      }
      const resp = await api(`/api/super/businesses/${business.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      if (typeof onSaved === 'function') onSaved(resp.business);
      onClose();
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!business) return null;

  return React.createElement('div', {
    className: 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4',
    onClick: onClose
  },
    React.createElement('div', {
      className: 'bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] overflow-hidden flex flex-col',
      onClick: e => e.stopPropagation()
    },
      React.createElement('div', { className: 'px-6 py-4 border-b flex items-center justify-between bg-gray-50' },
        React.createElement('div', null,
          React.createElement('h2', { className: 'text-lg font-bold text-gray-800' }, '\u270f\ufe0f Edit tenant'),
          React.createElement('p', { className: 'text-xs text-gray-500 mt-0.5' },
            `${business.name} (${business.slug}) \u2022 template: ${business.template_key || '\u2014'}`
          )
        ),
        React.createElement('button', {
          onClick: onClose,
          className: 'text-gray-400 hover:text-gray-600 text-2xl leading-none'
        }, '\u00d7')
      ),

      loading
        ? React.createElement('div', { className: 'p-10 text-center text-gray-500 text-sm' }, 'Loading\u2026')
        : !form
          ? React.createElement('div', { className: 'p-10 text-center text-red-600 text-sm' }, error || 'Unable to load tenant')
          : React.createElement('div', { className: 'p-6 overflow-y-auto space-y-5' },
            error && React.createElement('div', {
              className: 'bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2'
            }, error),

            // ---------- Basics ----------
            React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Basics'),
              React.createElement('div', { className: 'grid grid-cols-2 gap-3' },
                textField('Name', form.name, v => set('name', v)),
                textField('Slug', form.slug, v => set('slug', v), 'lowercase-hyphens'),
                textField('Contact email', form.contact_email, v => set('contact_email', v)),
                textField('Contact phone', form.contact_phone, v => set('contact_phone', v)),
                textField('Timezone', form.timezone, v => set('timezone', v), 'America/Toronto'),
                // `legacy` is deliberately omitted from this list. It's a
                // grandfather flag for the original pre-SaaS tenant (id=1),
                // not a plan an operator should pick from the UI — setting
                // it on other tenants previously forced the golf sidebar +
                // pages to render for them and locked the Delete button.
                selectField('Plan', form.plan, v => set('plan', v), [
                  ['free', 'free'], ['starter', 'starter'], ['growth', 'growth'],
                  ['pro', 'pro'], ['trial', 'trial']
                ])
              )
            ),

            // ---------- Template (vertical) ----------
            // Switching template_key changes the sidebar shape + page router
            // (see sidebarItemsFor / tenantPagesFor) so the tenant sees the
            // right vertical's UI. We do NOT re-apply the new template's
            // settings defaults — that would risk clobbering customisations
            // the tenant has already made. The dropdown is disabled for
            // Valleymede (id=1) because the legacy plan-lock would force
            // golf anyway and the mismatch only confuses forensics.
            React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Template'),
              business.id === 1
                ? React.createElement('p', { className: 'text-xs text-gray-500' },
                    'Valleymede (id=1) is locked to the golf_course template by the legacy safety lock.'
                  )
                : React.createElement('div', null,
                    React.createElement('label', { className: 'text-xs text-gray-600 block mb-1' }, 'Vertical / template'),
                    React.createElement('select', {
                      value: form.template_key || '',
                      onChange: e => set('template_key', e.target.value),
                      className: 'w-full text-sm border rounded-lg px-3 py-2 bg-white'
                    },
                      React.createElement('option', { value: '' }, '\u2014 unset \u2014'),
                      (templates.length > 0
                        ? templates
                        : [
                            { key: 'golf_course', label: 'Golf Course' },
                            { key: 'driving_range', label: 'Driving Range' },
                            { key: 'restaurant', label: 'Restaurant' },
                            { key: 'personal_assistant', label: 'Personal Assistant' },
                            { key: 'business', label: 'Business' },
                            { key: 'other', label: 'Other / Generic' }
                          ]
                      ).map(t =>
                        React.createElement('option', { key: t.key, value: t.key }, `${t.icon_emoji ? t.icon_emoji + ' ' : ''}${t.label} (${t.key})`)
                      )
                    ),
                    form.template_key && form.template_key !== originalTemplateKey && React.createElement('p', {
                      className: 'mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2'
                    },
                      `Switching from "${originalTemplateKey || 'unset'}" to "${form.template_key}" changes which sidebar + pages this tenant sees. Existing settings (greetings, hours, prompt, etc.) are NOT reset — only the UI shape changes. The tenant must sign out and sign back in for the new shape to take effect.`
                    )
                  )
            ),

            // ---------- Voice tier ----------
            // Per-tenant voice_config override. Writes settings.voice_config
            // via the existing PATCH /api/super/businesses/:id settings
            // pathway. Premium tier resolves to the grok-think-fast-1.0
            // model + Rock voice in voice-tiers.js — that's the "best
            // voice" tenants typically ask for. Default voice for each
            // tier is fine for 99% of tenants; the optional override is
            // there for the rare case where a tenant wants a specific
            // named voice (e.g. a forthcoming xAI release that ships
            // before we update the catalog).
            React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Voice'),
              React.createElement('div', { className: 'grid grid-cols-2 gap-3' },
                React.createElement('div', null,
                  React.createElement('label', { className: 'text-xs text-gray-600 block mb-1' }, 'Voice tier'),
                  React.createElement('select', {
                    value: voiceConfig.tier || 'standard',
                    onChange: e => setVoiceConfig(vc => ({ ...vc, tier: e.target.value })),
                    className: 'w-full text-sm border rounded-lg px-3 py-2 bg-white'
                  },
                    (voiceTiers.length > 0
                      ? voiceTiers
                      : [
                          { key: 'economy',  label: 'Economy',  tagline: 'Lowest cost' },
                          { key: 'standard', label: 'Standard', tagline: 'Balanced' },
                          { key: 'premium',  label: 'Premium',  tagline: 'Grok Think Fast 1.0 + Rock voice' }
                        ]
                    ).map(t =>
                      React.createElement('option', { key: t.key, value: t.key },
                        `${t.label}${t.tagline ? ' — ' + t.tagline : ''}`
                      )
                    )
                  )
                ),
                React.createElement('div', null,
                  React.createElement('label', { className: 'text-xs text-gray-600 block mb-1' }, 'Voice override (optional)'),
                  React.createElement('input', {
                    type: 'text',
                    value: voiceConfig.voice || '',
                    onChange: e => setVoiceConfig(vc => ({ ...vc, voice: e.target.value })),
                    placeholder: 'e.g. rock',
                    className: 'w-full text-sm border rounded-lg px-3 py-2 bg-white'
                  })
                )
              ),
              React.createElement('p', { className: 'text-[11px] text-gray-500 mt-2' },
                voiceConfig.tier === 'premium'
                  ? 'Premium uses the Grok Think Fast 1.0 model with the Rock voice — xAI’s newest, most expressive voice.'
                  : 'Voice override pins a specific named voice (e.g. "rock"). Leave blank to use the tier’s default voice.'
              ),
              voiceConfig.tier !== originalVoiceConfig.tier && React.createElement('p', {
                className: 'mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2'
              },
                `Voice tier change from "${originalVoiceConfig.tier}" to "${voiceConfig.tier}" takes effect on the next inbound call — no restart needed.`
              )
            ),

            // ---------- Telephony ----------
            React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Telephony'),
              React.createElement('div', { className: 'grid grid-cols-2 gap-3' },
                textField('Primary Twilio number', form.twilio_phone_number, v => set('twilio_phone_number', v), '+1\u2026'),
                textField('Transfer number', form.transfer_number, v => set('transfer_number', v), '+1\u2026')
              ),
              React.createElement('p', { className: 'text-[11px] text-gray-500 mt-2' },
                'Additional DIDs are managed via the \ud83d\udcde Phones button on the tenant card.'
              )
            ),

            // ---------- Branding ----------
            React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Branding'),
              React.createElement('div', { className: 'grid grid-cols-2 gap-3' },
                textField('Primary color', form.primary_color, v => set('primary_color', v), '#2E7D32'),
                textField('Logo URL', form.logo_url, v => set('logo_url', v), 'https://\u2026')
              )
            ),

            // ---------- Status ----------
            React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Status'),
              React.createElement('div', { className: 'grid grid-cols-2 gap-3' },
                selectField('Status', form.status, v => set('status', v), [
                  ['active', 'active'], ['trial', 'trial'], ['paused', 'paused'], ['setup', 'setup']
                ]),
                React.createElement('label', { className: 'flex items-center gap-2 text-sm mt-5' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: !!form.is_active,
                    onChange: e => set('is_active', e.target.checked),
                    className: 'rounded'
                  }),
                  React.createElement('span', null, 'Is active (inbound calls accepted)')
                )
              )
            ),

            // ---------- Credits (super-admin grant) ----------
            React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Credits'),
              React.createElement(CreditsPanel, { businessId: business.id })
            ),

            // ---------- Users + password reset ----------
            React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Users'),
              React.createElement(TenantUsersPanel, { businessId: business.id })
            ),

            // ---------- Personal Assistant (only if applicable) ----------
            business.template_key === 'personal_assistant' && ownerProfile && React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Personal assistant'),
              textField(
                'Assistant name',
                ownerProfile.assistant_name || '',
                v => setOwnerProfile(op => ({ ...op, assistant_name: v })),
                'e.g. Alex'
              ),
              React.createElement('p', { className: 'text-[11px] text-gray-500 mt-2' },
                'This is the name the AI will introduce itself as on calls. Other owner profile fields are edited from the tenant\u2019s My Info page.'
              )
            ),

            // ---------- Notes ----------
            React.createElement('section', null,
              React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wide text-gray-500 mb-2' }, 'Internal notes'),
              React.createElement('div', { className: 'grid grid-cols-1 gap-3' },
                textareaField('Internal notes (ops-only)', form.internal_notes, v => set('internal_notes', v)),
                textareaField('Billing notes (ops-only)', form.billing_notes, v => set('billing_notes', v))
              )
            )
          ),

      React.createElement('div', { className: 'px-6 py-3 border-t bg-gray-50 flex justify-end gap-2' },
        React.createElement('button', {
          onClick: onClose,
          className: 'bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-2 rounded-lg text-sm font-semibold',
          disabled: saving
        }, 'Cancel'),
        React.createElement('button', {
          onClick: save,
          className: 'bg-golf-600 hover:bg-golf-700 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-60',
          disabled: saving || loading || !form
        }, saving ? 'Saving\u2026' : 'Save changes')
      )
    )
  );
}

// Tiny form-field helpers — co-located with the edit modal because that's
// the only caller today. If another screen needs them, promote to a shared
// util.
function textField(label, value, onChange, placeholder) {
  return React.createElement('label', { className: 'block' },
    React.createElement('span', { className: 'block text-xs font-semibold text-gray-700 mb-1' }, label),
    React.createElement('input', {
      type: 'text',
      value: value ?? '',
      placeholder: placeholder || '',
      onChange: e => onChange(e.target.value),
      className: 'w-full border rounded-lg px-3 py-2 text-sm'
    })
  );
}
function textareaField(label, value, onChange) {
  return React.createElement('label', { className: 'block' },
    React.createElement('span', { className: 'block text-xs font-semibold text-gray-700 mb-1' }, label),
    React.createElement('textarea', {
      value: value ?? '',
      onChange: e => onChange(e.target.value),
      rows: 3,
      className: 'w-full border rounded-lg px-3 py-2 text-sm'
    })
  );
}
function selectField(label, value, onChange, options) {
  return React.createElement('label', { className: 'block' },
    React.createElement('span', { className: 'block text-xs font-semibold text-gray-700 mb-1' }, label),
    React.createElement('select', {
      value: value ?? '',
      onChange: e => onChange(e.target.value),
      className: 'w-full border rounded-lg px-3 py-2 text-sm bg-white'
    },
      options.map(([val, lbl]) => React.createElement('option', { key: val, value: val }, lbl))
    )
  );
}

// ============================================
// DELETE TENANT MODAL (super admin)
// ============================================
// Soft delete with slug-typing confirmation. The server also requires
// the slug as a query param — this mirror prevents an accidental submit.
function DeleteTenantModal({ business, onClose, onDeleted }) {
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  if (!business) return null;

  const matches = typed.trim() === business.slug;

  const confirmDelete = async () => {
    if (!matches) return;
    setWorking(true);
    setError('');
    try {
      await api(`/api/super/businesses/${business.id}?confirm=${encodeURIComponent(business.slug)}`, {
        method: 'DELETE'
      });
      if (typeof onDeleted === 'function') onDeleted(business);
      onClose();
    } catch (err) {
      setError(err.message || 'Delete failed');
    } finally {
      setWorking(false);
    }
  };

  return React.createElement('div', {
    className: 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4',
    onClick: onClose
  },
    React.createElement('div', {
      className: 'bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden',
      onClick: e => e.stopPropagation()
    },
      React.createElement('div', { className: 'px-6 py-4 border-b flex items-center justify-between bg-red-50' },
        React.createElement('h2', { className: 'text-lg font-bold text-red-800' }, '\ud83d\uddd1 Delete tenant?'),
        React.createElement('button', {
          onClick: onClose,
          className: 'text-gray-400 hover:text-gray-600 text-2xl leading-none'
        }, '\u00d7')
      ),
      React.createElement('div', { className: 'p-6 space-y-4' },
        React.createElement('div', { className: 'text-sm text-gray-700' },
          React.createElement('p', { className: 'mb-2' },
            'You\u2019re about to soft-delete ',
            React.createElement('strong', null, business.name),
            '.'
          ),
          React.createElement('ul', { className: 'list-disc ml-5 text-xs text-gray-600 space-y-1' },
            React.createElement('li', null, 'Inbound calls to this tenant\u2019s DIDs will stop routing.'),
            React.createElement('li', null, 'All data is preserved — call logs, credits, settings. It can be restored.'),
            React.createElement('li', null, 'Any logged-in users will be kicked out of the tenant on next request.')
          )
        ),
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-xs font-semibold text-gray-700 mb-1' },
            'Type the slug ',
            React.createElement('code', { className: 'font-mono bg-gray-100 px-1 rounded' }, business.slug),
            ' to confirm:'
          ),
          React.createElement('input', {
            type: 'text',
            value: typed,
            onChange: e => setTyped(e.target.value),
            autoFocus: true,
            placeholder: business.slug,
            className: `w-full border rounded-lg px-3 py-2 text-sm font-mono ${matches ? 'border-red-500 focus:ring-red-500' : ''}`
          })
        ),
        error && React.createElement('div', {
          className: 'bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg px-3 py-2'
        }, error)
      ),
      React.createElement('div', { className: 'px-6 py-3 border-t bg-gray-50 flex justify-end gap-2' },
        React.createElement('button', {
          onClick: onClose,
          className: 'bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-2 rounded-lg text-sm font-semibold',
          disabled: working
        }, 'Cancel'),
        React.createElement('button', {
          onClick: confirmDelete,
          disabled: !matches || working,
          className: 'bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40'
        }, working ? 'Deleting\u2026' : 'Delete tenant')
      )
    )
  );
}

// Lightweight modal that wraps PhoneNumbersManager for Super Admin use. The
// modal is reused from the dashboard when the operator clicks "Phones" on a
// business card — keeps the card compact while still giving ops full CRUD
// without switching context.
function PhoneNumbersModal({ business, onClose, onSaved }) {
  if (!business) return null;
  return React.createElement('div', {
    className: 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4',
    onClick: onClose
  },
    React.createElement('div', {
      className: 'bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col',
      onClick: e => e.stopPropagation()
    },
      React.createElement('div', { className: 'px-6 py-4 border-b flex items-center justify-between bg-gray-50' },
        React.createElement('div', null,
          React.createElement('h2', { className: 'text-lg font-bold text-gray-800' }, '\ud83d\udcde Phone Numbers'),
          React.createElement('p', { className: 'text-xs text-gray-500 mt-0.5' }, `${business.name} (${business.slug})`)
        ),
        React.createElement('button', {
          onClick: () => { if (typeof onSaved === 'function') onSaved(); onClose(); },
          className: 'text-gray-400 hover:text-gray-600 text-2xl leading-none'
        }, '\u00d7')
      ),
      React.createElement('div', { className: 'p-6 overflow-y-auto' },
        React.createElement(PhoneNumbersManager, {
          endpointBase: `/api/super/businesses/${business.id}/phone-numbers`,
          title: 'Routing configuration'
        })
      ),
      React.createElement('div', { className: 'px-6 py-3 border-t bg-gray-50 flex justify-end' },
        React.createElement('button', {
          onClick: () => { if (typeof onSaved === 'function') onSaved(); onClose(); },
          className: 'bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-2 rounded-lg text-sm font-semibold'
        }, 'Done')
      )
    )
  );
}

// ============================================
// VOICE OVERRIDE MODAL (super admin)
// ============================================
// Lets a super admin pin a specific xAI voice name (e.g. "eve", "rock") for
// a tenant, independent of the wizard's tier selection. The field is
// free-form with a datalist of known voices so a newly-released xAI voice
// can be used without a code deploy.
//
// Writes merge into settings.voice_config on the server (POST/PATCH
// preserves any existing tier key), so a tenant created on tier="standard"
// with an explicit voice="rock" stays on tier="standard" for entitlement
// purposes but answers calls in the Rock voice.
function VoiceModal({ business, onClose, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null); // { raw, resolved, known_voices }
  const [draftVoice, setDraftVoice] = useState('');

  useEffect(() => {
    if (!business) return;
    setLoading(true);
    setError('');
    api(`/api/super/businesses/${business.id}/voice`)
      .then(resp => {
        setData(resp);
        setDraftVoice(resp?.raw?.voice || '');
        setLoading(false);
      })
      .catch(err => {
        setError(err?.message || 'Failed to load voice config');
        setLoading(false);
      });
  }, [business]);

  const handleSave = useCallback(async (clear) => {
    setSaving(true);
    setError('');
    try {
      const body = clear
        ? { voice: null }
        : { voice: (draftVoice || '').trim() };
      const resp = await api(`/api/super/businesses/${business.id}/voice`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      setData(d => ({ ...(d || {}), raw: resp.raw, resolved: resp.resolved }));
      setDraftVoice(resp?.raw?.voice || '');
      if (typeof onSaved === 'function') onSaved();
    } catch (err) {
      setError(err?.message || 'Failed to save voice');
    } finally {
      setSaving(false);
    }
  }, [business, draftVoice, onSaved]);

  if (!business) return null;

  return React.createElement('div', {
    className: 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4',
    onClick: onClose
  },
    React.createElement('div', {
      className: 'bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col',
      onClick: e => e.stopPropagation()
    },
      React.createElement('div', { className: 'px-6 py-4 border-b flex items-center justify-between bg-gray-50' },
        React.createElement('div', null,
          React.createElement('h2', { className: 'text-lg font-bold text-gray-800' }, '\ud83c\udf99\ufe0f Voice Override'),
          React.createElement('p', { className: 'text-xs text-gray-500 mt-0.5' }, `${business.name} (${business.slug})`)
        ),
        React.createElement('button', {
          onClick: onClose,
          className: 'text-gray-400 hover:text-gray-600 text-2xl leading-none'
        }, '\u00d7')
      ),
      React.createElement('div', { className: 'p-6 overflow-y-auto space-y-4' },
        loading
          ? React.createElement('p', { className: 'text-sm text-gray-500' }, 'Loading\u2026')
          : React.createElement(React.Fragment, null,
              // Currently-active voice at the top, read-only.
              React.createElement('div', { className: 'bg-gray-50 rounded-lg p-3 text-sm' },
                React.createElement('div', { className: 'text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1' }, 'Currently using'),
                React.createElement('div', { className: 'font-mono text-gray-800' }, data?.resolved?.voice || '\u2014'),
                React.createElement('div', { className: 'text-xs text-gray-500 mt-1' },
                  'Tier: ', React.createElement('span', { className: 'font-mono' }, data?.resolved?.tier || 'legacy'),
                  ' \u00b7 Speed: ', React.createElement('span', { className: 'font-mono' }, String(data?.resolved?.speed ?? '-'))
                )
              ),
              // The override input itself. Datalist suggests known voices
              // but any string xAI accepts will work.
              React.createElement('div', null,
                React.createElement('label', { className: 'block text-sm font-semibold text-gray-700 mb-1' }, 'Override voice name'),
                React.createElement('input', {
                  type: 'text',
                  list: 'voice-modal-known-voices',
                  value: draftVoice,
                  onChange: e => setDraftVoice(e.target.value),
                  placeholder: 'e.g. eve, rock',
                  className: 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-golf-500',
                  maxLength: 64,
                  disabled: saving
                }),
                React.createElement('datalist', { id: 'voice-modal-known-voices' },
                  (data?.known_voices || []).map(v =>
                    React.createElement('option', { key: v.name, value: v.name }, v.label)
                  )
                ),
                React.createElement('p', { className: 'text-xs text-gray-500 mt-1' },
                  'Leave the value untouched and press Clear override to fall back to the tier default.'
                )
              ),
              error && React.createElement('div', { className: 'text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2' }, error)
            )
      ),
      React.createElement('div', { className: 'px-6 py-3 border-t bg-gray-50 flex items-center justify-between gap-2' },
        React.createElement('button', {
          onClick: () => handleSave(true),
          disabled: saving || loading || !data?.raw?.voice,
          className: 'text-sm font-semibold text-gray-600 hover:text-gray-900 disabled:text-gray-300'
        }, 'Clear override'),
        React.createElement('div', { className: 'flex gap-2' },
          React.createElement('button', {
            onClick: onClose,
            className: 'bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-2 rounded-lg text-sm font-semibold'
          }, 'Cancel'),
          React.createElement('button', {
            onClick: () => handleSave(false),
            disabled: saving || loading || !(draftVoice || '').trim(),
            className: 'bg-golf-700 hover:bg-golf-800 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50'
          }, saving ? 'Saving\u2026' : 'Save')
        )
      )
    )
  );
}

// ============================================
// SUPER ADMIN DASHBOARD
// ============================================
// Cross-tenant overview for platform operators. Renders the business grid
// with quick-scan cards, global totals, live search, and launches the
// OnboardingWizard.
function SuperAdminDashboard({ onSwitchInto, onBusinessCreated }) {
  const [businesses, setBusinesses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // `wizardMode` is null when the wizard is closed, 'business' for the
  // standard tenant onboarding flow, and 'personal' for the "New Personal
  // Account" shortcut (pre-selects template_key='personal_assistant' and
  // swaps copy/defaults so the form reads like a personal-account flow).
  const [wizardMode, setWizardMode] = useState(null);
  const [lastCreated, setLastCreated] = useState(null);
  const [search, setSearch] = useState('');
  const [phoneModalBiz, setPhoneModalBiz] = useState(null);
  const [voiceModalBiz, setVoiceModalBiz] = useState(null);
  const [editBiz, setEditBiz] = useState(null);
  const [deleteBiz, setDeleteBiz] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [auditEvents, setAuditEvents] = useState([]);
  const [showAudit, setShowAudit] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([
      api('/api/super/businesses'),
      // Analytics and audit feed are nice-to-haves — if either
      // endpoint fails (older backend, DB blip) the dashboard still
      // renders the core business list.
      api('/api/super/analytics').catch(() => null),
      api('/api/super/audit-log?limit=10').catch(() => ({ events: [] }))
    ])
      .then(([bizResp, analyticsResp, auditResp]) => {
        setBusinesses(bizResp.businesses || []);
        setAnalytics(analyticsResp || null);
        setAuditEvents(auditResp?.events || []);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreated = (resp) => {
    refresh();
    setLastCreated(resp || null);
    setWizardMode(null);
    // Let the parent App() refresh its top-level businesses list so the
    // TopBar's BusinessSwitcher picks up the new tenant without a reload.
    if (typeof onBusinessCreated === 'function') onBusinessCreated(resp);
  };

  // Cheap local filter over the already-loaded list.
  const q = search.trim().toLowerCase();
  const filtered = q
    ? businesses.filter(b =>
        [b.name, b.slug, b.twilio_phone_number, b.contact_email]
          .some(v => String(v || '').toLowerCase().includes(q))
      )
    : businesses;

  const totals = businesses.reduce((acc, b) => ({
    tenants: acc.tenants + 1,
    active: acc.active + (b.status === 'active' ? 1 : 0),
    trial: acc.trial + (b.status === 'trial' ? 1 : 0),
    calls: acc.calls + (b.calls_last_30d || 0),
    bookings: acc.bookings + (b.bookings_last_30d || 0)
  }), { tenants: 0, active: 0, trial: 0, calls: 0, bookings: 0 });

  return React.createElement('div', { className: 'max-w-7xl mx-auto' },
    // ---------- Header row ----------
    React.createElement('div', { className: 'flex items-center justify-between mb-6 flex-wrap gap-3' },
      React.createElement('div', null,
        React.createElement('div', { className: 'flex items-center gap-2 mb-1' },
          React.createElement('span', { className: 'text-xs uppercase tracking-wider font-semibold text-purple-600 bg-purple-50 px-2 py-0.5 rounded' }, 'Super Admin'),
          React.createElement('span', { className: 'text-xs text-gray-400' }, 'Control Centre')
        ),
        React.createElement('h1', { className: 'text-2xl font-bold text-gray-800' }, 'Businesses'),
        React.createElement('p', { className: 'text-sm text-gray-500 mt-1' }, 'Every tenant running on the platform, at a glance.')
      ),
      // Two onboarding entry points, side by side. The primary "New
      // Business" CTA stays the headline action; "New Personal Account"
      // sits next to it so a PA tenant is one click away instead of
      // buried inside the same wizard's template grid.
      React.createElement('div', { className: 'flex items-center gap-2' },
        React.createElement('button', {
          onClick: () => setWizardMode('personal'),
          className: 'bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 px-4 py-2.5 rounded-lg text-sm font-semibold shadow-sm flex items-center gap-2',
          title: 'Create a Personal Assistant account'
        },
          React.createElement('span', { className: 'text-lg leading-none' }, '\ud83d\udc64'),
          React.createElement('span', null, 'New Personal Account')
        ),
        React.createElement('button', {
          onClick: () => setWizardMode('business'),
          className: 'bg-golf-600 hover:bg-golf-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold shadow-sm flex items-center gap-2'
        },
          React.createElement('span', { className: 'text-lg leading-none' }, '+'),
          React.createElement('span', null, 'New Business')
        )
      )
    ),

    // ---------- Global totals ----------
    // Prefer the authoritative `/api/super/analytics` numbers (they
    // include active-now calls + minutes + open invites). If the
    // analytics call failed, fall back to summing the per-business
    // counts we already have in hand.
    React.createElement('div', { className: 'grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-3' },
      React.createElement(MetricChip, {
        label: 'Tenants',
        value: analytics?.businesses?.total ?? totals.tenants
      }),
      React.createElement(MetricChip, {
        label: 'Active',
        value: analytics?.businesses?.active ?? totals.active,
        tone: 'green'
      }),
      React.createElement(MetricChip, {
        label: 'In Trial',
        value: analytics?.businesses?.trial ?? totals.trial,
        tone: 'blue'
      }),
      React.createElement(MetricChip, {
        label: 'Calls Today',
        value: analytics?.calls?.today ?? 0,
        tone: 'blue'
      }),
      React.createElement(MetricChip, {
        label: 'Active Now',
        value: analytics?.calls?.active_now ?? 0,
        tone: (analytics?.calls?.active_now || 0) > 0 ? 'green' : 'neutral'
      }),
      React.createElement(MetricChip, {
        label: 'Minutes 30d',
        value: analytics?.calls?.minutes_last_30d ?? Math.round((totals.calls || 0) * 2),
        tone: 'blue'
      }),
      React.createElement(MetricChip, {
        label: 'Open Invites',
        value: analytics?.invites?.open ?? 0,
        tone: (analytics?.invites?.open || 0) > 0 ? 'amber' : 'neutral'
      })
    ),
    // Secondary row — bookings + user counts. Cheap to render, helpful
    // at a glance, and gated on analytics being present so we don't
    // draw an empty ghost strip if the endpoint failed.
    analytics && React.createElement('div', { className: 'grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 mb-6' },
      React.createElement(MetricChip, {
        label: 'Bookings Today',
        value: analytics.bookings?.today ?? 0,
        tone: 'green'
      }),
      React.createElement(MetricChip, {
        label: 'Bookings 30d',
        value: analytics.bookings?.last_30d ?? totals.bookings,
        tone: 'green'
      }),
      React.createElement(MetricChip, {
        label: 'Pending Bookings',
        value: analytics.bookings?.pending ?? 0,
        tone: (analytics.bookings?.pending || 0) > 0 ? 'amber' : 'neutral'
      }),
      React.createElement(MetricChip, {
        label: 'Business Users',
        value: (analytics.users?.business_admins ?? 0) + (analytics.users?.staff ?? 0)
      }),
      React.createElement(MetricChip, {
        label: 'Phones Active',
        value: analytics.phones?.active ?? 0
      })
    ),

    // ---------- Recent activity (audit log) ----------
    // Collapsible so it doesn't dominate the dashboard, but visible on
    // toggle so platform operators can spot a mis-click or a cross-tenant
    // impersonation at a glance without leaving the dashboard.
    React.createElement('div', { className: 'bg-white border rounded-xl mb-5 overflow-hidden' },
      React.createElement('button', {
        onClick: () => setShowAudit(s => !s),
        className: 'w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50'
      },
        React.createElement('div', null,
          React.createElement('div', { className: 'text-xs uppercase tracking-wider font-semibold text-gray-500' }, 'Recent Activity'),
          React.createElement('div', { className: 'text-sm text-gray-700' },
            auditEvents.length === 0
              ? 'No recent activity'
              : `Last ${auditEvents.length} platform-wide event${auditEvents.length === 1 ? '' : 's'}`
          )
        ),
        React.createElement('span', { className: 'text-gray-400 text-xs' }, showAudit ? '\u25B2 Hide' : '\u25BC Show')
      ),
      showAudit && React.createElement('div', { className: 'border-t divide-y' },
        auditEvents.length === 0
          ? React.createElement('div', { className: 'px-4 py-6 text-sm text-gray-500 text-center' },
              'Audit log is empty. Actions you take across tenants will show up here.'
            )
          : auditEvents.map(ev =>
              React.createElement('div', { key: ev.id, className: 'px-4 py-2 flex items-center gap-3 text-sm' },
                React.createElement('span', {
                  className: 'text-xs font-mono bg-gray-100 text-gray-700 px-2 py-0.5 rounded whitespace-nowrap'
                }, ev.action),
                React.createElement('span', { className: 'text-gray-600 flex-1 truncate' },
                  [
                    ev.actor_email || ev.user_type || 'system',
                    ev.target_type ? `${ev.target_type}:${ev.target_id || '-'}` : null,
                    ev.business_id !== null && ev.business_id !== undefined ? `biz:${ev.business_id}` : null
                  ].filter(Boolean).join(' \u2192 ')
                ),
                React.createElement('span', { className: 'text-xs text-gray-400 whitespace-nowrap' },
                  new Date(ev.created_at).toLocaleString()
                )
              )
            )
      )
    ),

    error && React.createElement('div', { className: 'bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm' }, error),

    // ---------- Last-created ribbon ----------
    lastCreated && React.createElement('div', { className: 'bg-green-50 border border-green-200 rounded-xl p-4 mb-5 text-sm' },
      React.createElement('div', { className: 'flex items-start justify-between gap-4' },
        React.createElement('div', { className: 'flex-1 min-w-0' },
          React.createElement('p', { className: 'font-semibold text-green-800 mb-1' },
            `\u2728 ${lastCreated.business?.name || 'New business'} is live.`
          ),
          lastCreated.invite && React.createElement('div', null,
            React.createElement('p', { className: 'text-green-700 mb-2' }, `Share this magic link with ${lastCreated.invite.email}:`),
            React.createElement('code', { className: 'block bg-white border border-green-200 rounded p-2 text-xs break-all' }, lastCreated.invite.invite_url),
            React.createElement('button', {
              onClick: () => { try { navigator.clipboard.writeText(lastCreated.invite.invite_url); } catch (_) {} },
              className: 'text-green-700 text-xs mt-2 font-semibold underline'
            }, 'Copy link')
          ),
          !lastCreated.invite && React.createElement('p', { className: 'text-green-700' }, 'No admin invite was generated. You can send one from the business card.')
        ),
        React.createElement('button', { onClick: () => setLastCreated(null), className: 'text-green-700 text-sm' }, '\u00d7')
      )
    ),

    // ---------- Search ----------
    !loading && businesses.length > 0 && React.createElement('div', { className: 'mb-4' },
      React.createElement('input', {
        type: 'text',
        value: search,
        onChange: e => setSearch(e.target.value),
        placeholder: 'Search tenants by name, slug, phone, or email\u2026',
        className: 'w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none'
      })
    ),

    loading && React.createElement('p', { className: 'text-gray-500' }, 'Loading businesses\u2026'),

    // ---------- Empty state ----------
    !loading && businesses.length === 0 && React.createElement('div', {
      className: 'bg-white border border-dashed rounded-xl p-12 text-center'
    },
      React.createElement('div', { className: 'text-5xl mb-3' }, '\ud83c\udfcc\ufe0f'),
      React.createElement('h3', { className: 'text-lg font-bold text-gray-800 mb-1' }, 'No businesses yet'),
      React.createElement('p', { className: 'text-sm text-gray-500 mb-5' }, 'Spin up your first tenant and the AI receptionist is live in under 5 minutes.'),
      React.createElement('div', { className: 'flex items-center justify-center gap-2' },
        React.createElement('button', {
          onClick: () => setWizardMode('personal'),
          className: 'bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 px-4 py-2.5 rounded-lg text-sm font-semibold'
        }, '\ud83d\udc64 New personal account'),
        React.createElement('button', {
          onClick: () => setWizardMode('business'),
          className: 'bg-golf-600 hover:bg-golf-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold'
        }, 'Create first business')
      )
    ),

    // ---------- Card grid ----------
    !loading && businesses.length > 0 && React.createElement('div', null,
      filtered.length === 0 && React.createElement('p', { className: 'text-sm text-gray-400 py-4' },
        `No tenants match "${search}".`
      ),
      React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' },
        filtered.map(b =>
          React.createElement(BusinessCard, {
            key: b.id,
            business: b,
            onActAs: onSwitchInto,
            onManagePhones: setPhoneModalBiz,
            onManageVoice: setVoiceModalBiz,
            onEdit: setEditBiz,
            onDelete: setDeleteBiz
          })
        )
      )
    ),

    wizardMode && React.createElement(OnboardingWizard, {
      // Keyed on mode so switching entry points fully remounts the wizard —
      // no stale template_key / color from the previous flow can bleed in.
      key: wizardMode,
      mode: wizardMode,
      initialTemplateKey: wizardMode === 'personal' ? 'personal_assistant' : null,
      onCancel: () => setWizardMode(null),
      onCreated: handleCreated,
      // Thread through so the Success step can switch directly into the
      // new tenant instead of bouncing through the dashboard first.
      onActAs: onSwitchInto
    }),

    phoneModalBiz && React.createElement(PhoneNumbersModal, {
      business: phoneModalBiz,
      // After editing a tenant's phones, refresh the grid so updated
      // primary / denormalized twilio_phone_number values show up on the
      // card without a page reload.
      onSaved: refresh,
      onClose: () => setPhoneModalBiz(null)
    }),

    voiceModalBiz && React.createElement(VoiceModal, {
      business: voiceModalBiz,
      onSaved: refresh,
      onClose: () => setVoiceModalBiz(null)
    }),

    editBiz && React.createElement(EditTenantModal, {
      business: editBiz,
      onClose: () => setEditBiz(null),
      onSaved: () => { refresh(); }
    }),

    deleteBiz && React.createElement(DeleteTenantModal, {
      business: deleteBiz,
      onClose: () => setDeleteBiz(null),
      onDeleted: () => { refresh(); }
    })
  );
}

// ============================================
// ONBOARDING WIZARD (super admin only)
// ============================================
// Six-step guided flow for spinning up a new tenant. Everything happens in
// memory until the final "Create business" click — the server only sees one
// POST /api/super/businesses call with the full payload.
//
// Steps (in order):
//   0. Basics        — name, slug, contact email, primary color, logo URL
//   1. Phone numbers — primary Twilio DID + any additional lines
//   2. Template      — vertical (Golf / Driving Range / Restaurant / Other)
//   3. Review        — previews what the template applies
//   4. Invite        — optional: send magic-link to first business admin
//   5. Success       — confirmation screen with the invite URL
// ---------- validation helpers (module-level so tests/inspection are trivial) ----------

// Loose E.164: leading +, 8-15 digits total. Rejects common pasted noise like
// parentheses, dashes, and spaces so operators don't ship a malformed DID
// into Twilio.
const E164_RE = /^\+[1-9]\d{7,14}$/;
function isValidE164(v) {
  const s = String(v || '').trim();
  return s !== '' && E164_RE.test(s);
}
function isValidEmail(v) {
  const s = String(v || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function slugifyClient(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// `mode` controls a thin layer of copy + defaults that makes the wizard
// feel right whether the operator is spinning up a business tenant or a
// personal-assistant account. Everything else — validation, server payload,
// template picker, invite flow — is identical. `initialTemplateKey` lets
// the caller pre-select a template so the "New Personal Account" shortcut
// doesn't force the operator to click through the template grid again.
function OnboardingWizard({ onCancel, onCreated, onActAs, mode = 'business', initialTemplateKey = null }) {
  const isPersonal = mode === 'personal';
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  // Voice tier catalog — loaded alongside templates. The picker rendered in
  // the Template step reads from `voiceTiers` and greys out anything that
  // isn't in `voicePlanAccess[form.plan]`.
  const [voiceTiers, setVoiceTiers] = useState([]);
  const [voicePlanAccess, setVoicePlanAccess] = useState({});
  const [result, setResult] = useState(null);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    contact_email: '',
    contact_phone: '',
    primary_color: isPersonal ? '#4F46E5' : '#2E7D32',
    logo_url: '',
    timezone: 'America/Toronto',
    plan: 'starter',
    twilio_phone_number: '',
    transfer_number: '',
    phone_numbers: [],              // [{ phone_number, label }]
    template_key: initialTemplateKey || 'golf_course',
    admin_email: '',
    admin_name: '',
    // Personal Assistant-only: the voice-facing name of the assistant.
    // Harmless empty string for other templates — the backend ignores
    // assistant_name unless template_key === 'personal_assistant'.
    assistant_name: '',
    // Per-tenant voice tier. Defaults to 'standard' — the wizard offers
    // Economy/Standard/Premium cards on the Template step. Plan-gated:
    // `free`/`starter` only unlock economy+standard; `pro`/`trial` unlock
    // premium as well. The server validates on POST, so a stale UI state
    // can't slip through.
    voice_tier: 'standard'
  });

  // Live slug-availability state, driven by /api/super/slug-check.
  //   status: 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'error'
  const [slugCheck, setSlugCheck] = useState({ status: 'idle', value: '' });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // Auto-slugify while the slug field is untouched.
  const [slugTouched, setSlugTouched] = useState(false);
  useEffect(() => {
    if (slugTouched) return;
    setForm(f => ({ ...f, slug: slugifyClient(f.name) }));
  }, [form.name, slugTouched]);

  // Debounced slug uniqueness check. Runs whenever the slug changes.
  // We don't block UI — the wizard still lets the operator proceed if the
  // check fails, but the Next button disables on "taken" / "invalid".
  useEffect(() => {
    const slug = form.slug.trim();
    if (!slug) { setSlugCheck({ status: 'idle', value: '' }); return; }
    // Client-side quick-fail before a network round trip.
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setSlugCheck({ status: 'invalid', value: slug, reason: 'Slugs can only use lowercase letters, numbers, and dashes.' });
      return;
    }
    let cancelled = false;
    setSlugCheck({ status: 'checking', value: slug });
    const handle = setTimeout(() => {
      api('/api/super/slug-check?slug=' + encodeURIComponent(slug))
        .then(d => {
          if (cancelled) return;
          if (d.available) {
            setSlugCheck({ status: 'available', value: slug, normalized: d.normalized });
          } else {
            setSlugCheck({
              status: 'taken', value: slug, normalized: d.normalized,
              existing_name: d.existing_name, existing_id: d.existing_id
            });
          }
        })
        .catch(err => {
          if (cancelled) return;
          setSlugCheck({ status: 'error', value: slug, reason: err.message || 'Slug check failed' });
        });
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [form.slug]);

  // Load templates on mount. Fall back to a hardcoded minimal list if the
  // API is unreachable so the wizard still works.
  //
  // If the caller pre-selected a template (e.g. the "New Personal Account"
  // shortcut hands us 'personal_assistant'), we honour that and skip the
  // server-supplied default — otherwise we'd silently flip the wizard back
  // to golf_course on mount and the shortcut would feel broken.
  useEffect(() => {
    api('/api/super/templates')
      .then(d => {
        setTemplates(d.templates || []);
        if (!initialTemplateKey && d.default_template_key) set('template_key', d.default_template_key);
      })
      .catch(() => {
        setTemplates([
          { key: 'golf_course', label: 'Golf Course', tagline: 'Tee times, pricing, league play.', icon_emoji: '\u26f3\ufe0f' },
          { key: 'driving_range', label: 'Driving Range', tagline: 'Bay reservations, bucket pricing.', icon_emoji: '\ud83c\udfaf' },
          { key: 'restaurant', label: 'Restaurant', tagline: 'Reservations, hours, menu Q&A.', icon_emoji: '\ud83c\udf7d\ufe0f' },
          { key: 'personal_assistant', label: 'Personal Assistant', tagline: 'A friendly assistant who knows you and handles your calls.', icon_emoji: '\ud83d\udc64' },
          { key: 'other', label: 'Other / Generic', tagline: 'Safe, unopinionated starting point.', icon_emoji: '\u2728' }
        ]);
      })
      .finally(() => setLoadingTemplates(false));
    // Fetch voice tier catalog. If the endpoint is unreachable (older server,
    // offline preview) we still render the picker with a minimal hardcoded
    // list so the wizard never hard-fails — the server-side validator is
    // always the source of truth.
    api('/api/super/voice-tiers')
      .then(d => {
        setVoiceTiers(Array.isArray(d.tiers) ? d.tiers : []);
        setVoicePlanAccess(d.plan_access || {});
      })
      .catch(() => {
        setVoiceTiers([
          { key: 'standard', label: 'Standard', tagline: 'Balanced quality and cost.', description: 'Natural-sounding voice, fast responses, predictable cost.', cost_tier: 2, placeholder: false },
          { key: 'premium', label: 'Premium', tagline: 'xAI\u2019s newest voice — richer, more expressive.', description: 'Grok Think Fast 1.0 with the new Rock voice.', cost_tier: 3, placeholder: false }
        ]);
        setVoicePlanAccess({
          free: ['standard'], starter: ['standard'],
          pro: ['standard', 'premium'], trial: ['standard', 'premium'],
          legacy: ['standard', 'premium']
        });
      });
  }, []);

  // Note: we used to auto-downgrade voice_tier when the plan changed so the
  // review screen never showed a forbidden combo. With plan-tier gating
  // dropped for super-admin (the wizard is super-admin-only and the server
  // handler no longer enforces the combo for this endpoint), any tier is a
  // valid choice regardless of plan, so the auto-downgrade was removed.

  const labelCls = 'block text-xs font-semibold text-gray-600 mb-1';
  const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none';

  const steps = isPersonal
    ? [
        { title: 'Account basics',   sub: 'Name, contact, look & feel' },
        { title: 'Phone number',     sub: 'Where your assistant answers calls' },
        { title: 'Confirm template', sub: 'Personal Assistant is pre-selected' },
        { title: 'Voice tier',       sub: 'Pick the Grok voice the tenant pays per minute' },
        { title: 'Review & confirm', sub: 'What we\u2019re about to apply' },
        { title: 'Account owner',    sub: 'Invite yourself (or the owner)' },
        { title: 'All set',          sub: 'Share the magic link' }
      ]
    : [
        { title: 'Business basics',  sub: 'Name, contact, branding' },
        { title: 'Phone numbers',    sub: 'Route inbound calls + SMS' },
        { title: 'Choose template',  sub: 'Pick a vertical to seed defaults' },
        { title: 'Voice tier',       sub: 'Pick the Grok voice the tenant pays per minute' },
        { title: 'Review & confirm', sub: 'What we\u2019re about to apply' },
        { title: 'First admin',      sub: 'Invite the business owner' },
        { title: 'All set',          sub: 'Share the magic link' }
      ];

  // Per-step gating — disables "Next" until required fields exist and
  // free-form inputs pass format checks. These MUST match the server-side
  // checks (E.164, email, slug shape) so a green UI never produces a 400.
  const extraPhoneErrors = (form.phone_numbers || [])
    .map(p => p.phone_number && !isValidE164(p.phone_number));
  const canAdvance = () => {
    if (step === 0) {
      if (!form.name.trim()) return false;
      if (!form.slug.trim()) return false;
      if (slugCheck.status === 'taken' || slugCheck.status === 'invalid') return false;
      if (form.contact_email && !isValidEmail(form.contact_email)) return false;
      return true;
    }
    if (step === 1) {
      if (form.twilio_phone_number && !isValidE164(form.twilio_phone_number)) return false;
      if (form.transfer_number && !isValidE164(form.transfer_number)) return false;
      if (extraPhoneErrors.some(Boolean)) return false;
      return true;
    }
    if (step === 2) return !!form.template_key;
    // Step 3 (voice tier): always advanceable — the form starts with a valid
    // default ('standard') and the plan-vs-tier useEffect keeps that in sync,
    // so there's no invalid state a super-admin could wedge themselves into.
    if (step === 3) return !!form.voice_tier;
    if (step === 4) return true;                     // review
    if (step === 5) {
      if (!form.admin_email) return true;           // optional — "skip invite"
      return isValidEmail(form.admin_email);
    }
    return true;
  };

  const chosenTemplate = templates.find(t => t.key === form.template_key) || null;

  const handleCreate = async () => {
    setSaving(true);
    setError('');
    try {
      const extra = (form.phone_numbers || [])
        .map(p => ({ phone_number: String(p.phone_number || '').trim(), label: String(p.label || '').trim() }))
        .filter(p => p.phone_number);
      const resp = await api('/api/super/businesses', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          slug: form.slug.trim(),
          timezone: form.timezone.trim() || 'America/Toronto',
          plan: form.plan,
          contact_email: form.contact_email.trim() || null,
          contact_phone: form.contact_phone.trim() || null,
          primary_color: form.primary_color || null,
          logo_url: form.logo_url.trim() || null,
          twilio_phone_number: form.twilio_phone_number.trim() || null,
          transfer_number: form.transfer_number.trim() || null,
          phone_numbers: extra,
          template_key: form.template_key,
          admin_email: form.admin_email.trim() || null,
          // Only meaningful when template_key === 'personal_assistant'; the
          // backend defensively ignores it otherwise. Empty string is fine —
          // the server treats blanks as "use template default".
          assistant_name: (form.assistant_name || '').trim(),
          // Voice tier — validated server-side against the plan. The useEffect
          // above keeps this in sync with the selected plan so a premium tier
          // never goes out on a plan that doesn't allow it.
          voice_tier: form.voice_tier || 'standard'
        })
      });
      setResult(resp);
      // Success step: 7-step flow → index 6 ('All set'). Keep in sync with
      // `steps` / `stepBodies`; off-by-one here means the success card never
      // renders and the wizard looks frozen after a successful POST.
      setStep(6);
    } catch (err) {
      setError(err.message || 'Failed to create business');
      // When the server tells us which step to fix (slug collision → step 1,
      // phone-number collision → step 2), jump there automatically so the
      // operator isn't stuck clicking Back 4 times from the invite step.
      const jumpTo = err?.body?.step;
      if (Number.isInteger(jumpTo) && jumpTo >= 0 && jumpTo < 5) {
        setStep(jumpTo);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleFinish = () => {
    if (result) onCreated(result);
    else onCancel();
  };

  const addExtraPhone = () => setForm(f => ({
    ...f,
    phone_numbers: [...(f.phone_numbers || []), { phone_number: '', label: 'Additional Line' }]
  }));
  const updateExtraPhone = (i, k, v) => setForm(f => {
    const next = [...(f.phone_numbers || [])];
    next[i] = { ...next[i], [k]: v };
    return { ...f, phone_numbers: next };
  });
  const removeExtraPhone = (i) => setForm(f => {
    const next = [...(f.phone_numbers || [])];
    next.splice(i, 1);
    return { ...f, phone_numbers: next };
  });

  // ---------------- Step renderers ----------------

  const renderBasics = () => React.createElement('div', { className: 'space-y-4' },
    React.createElement('div', null,
      React.createElement('label', { className: labelCls },
        isPersonal ? 'Account name *' : 'Business name *'
      ),
      React.createElement('input', {
        className: inputCls, type: 'text', value: form.name,
        onChange: e => set('name', e.target.value),
        placeholder: isPersonal ? 'e.g. Alex\u2019s Assistant' : 'e.g. Cedar Ridge Golf Club',
        autoFocus: true
      })
    ),
    React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Slug (URL identifier) *'),
        React.createElement('input', {
          className: `${inputCls} font-mono ${
            slugCheck.status === 'taken' || slugCheck.status === 'invalid'
              ? 'border-red-400 focus:ring-red-300'
              : slugCheck.status === 'available'
                ? 'border-green-400 focus:ring-green-300'
                : ''
          }`,
          type: 'text', value: form.slug,
          onChange: e => { setSlugTouched(true); set('slug', e.target.value); },
          placeholder: 'cedar-ridge'
        }),
        // Live slug feedback — this check is just for operator UX; the server's
        // UNIQUE(slug) constraint is the authoritative gate at submit time.
        React.createElement('p', {
          className: `text-[11px] mt-1 ${
            slugCheck.status === 'taken' || slugCheck.status === 'invalid' || slugCheck.status === 'error'
              ? 'text-red-600'
              : slugCheck.status === 'available'
                ? 'text-green-600'
                : 'text-gray-400'
          }`
        },
          slugCheck.status === 'checking'
            ? 'Checking availability\u2026'
            : slugCheck.status === 'available'
              ? `\u2713 "${slugCheck.normalized || form.slug}" is available`
              : slugCheck.status === 'taken'
                ? `Taken by ${slugCheck.existing_name || 'another tenant'} (#${slugCheck.existing_id || '?'})`
                : slugCheck.status === 'invalid'
                  ? (slugCheck.reason || 'Slug must contain letters/numbers.')
                  : slugCheck.status === 'error'
                    ? (slugCheck.reason || 'Could not check slug availability.')
                    : slugTouched
                      ? 'Custom slug'
                      : 'Auto-generated from name \u2014 edit to customise'
        )
      ),
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Timezone'),
        React.createElement('input', {
          className: inputCls, type: 'text', value: form.timezone,
          onChange: e => set('timezone', e.target.value),
          placeholder: 'America/Toronto'
        })
      )
    ),
    React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Contact email'),
        React.createElement('input', {
          className: inputCls, type: 'email', value: form.contact_email,
          onChange: e => set('contact_email', e.target.value),
          placeholder: 'ops@business.com'
        })
      ),
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Contact phone'),
        React.createElement('input', {
          className: inputCls, type: 'text', value: form.contact_phone,
          onChange: e => set('contact_phone', e.target.value),
          placeholder: '+1 555 123 4567'
        })
      )
    ),
    React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Primary brand color'),
        React.createElement('div', { className: 'flex items-center gap-2' },
          React.createElement('input', {
            type: 'color',
            value: form.primary_color || '#2E7D32',
            onChange: e => set('primary_color', e.target.value),
            className: 'w-12 h-10 rounded border border-gray-300 cursor-pointer'
          }),
          React.createElement('input', {
            className: `${inputCls} font-mono`, type: 'text',
            value: form.primary_color,
            onChange: e => set('primary_color', e.target.value)
          })
        )
      ),
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Logo URL (optional)'),
        React.createElement('input', {
          className: inputCls, type: 'url', value: form.logo_url,
          onChange: e => set('logo_url', e.target.value),
          placeholder: 'https://cdn.example.com/logo.png'
        })
      )
    ),
    // Live preview card
    React.createElement('div', { className: 'bg-gray-50 border rounded-xl p-4 flex items-center gap-3 mt-2' },
      React.createElement(BusinessInitials, {
        name: form.name || '?',
        size: 'lg',
        color: form.primary_color
          ? `linear-gradient(135deg, ${form.primary_color}, ${form.primary_color}CC)`
          : undefined
      }),
      React.createElement('div', null,
        React.createElement('div', { className: 'font-semibold text-gray-800' }, form.name || 'Your business name'),
        React.createElement('div', { className: 'text-xs text-gray-500 font-mono' }, form.slug || 'slug-appears-here'),
        React.createElement('div', { className: 'text-xs text-gray-400 mt-1' }, form.timezone)
      )
    )
  );

  const renderPhones = () => React.createElement('div', { className: 'space-y-4' },
    React.createElement('div', { className: 'bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800' },
      'The primary Twilio number is how inbound calls find this tenant. Additional lines can be a second DID, an SMS-only number, or a ported phone you still need to migrate.'
    ),
    React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Primary Twilio number (E.164)'),
        React.createElement('input', {
          className: `${inputCls} font-mono ${
            form.twilio_phone_number && !isValidE164(form.twilio_phone_number) ? 'border-red-400 focus:ring-red-300' : ''
          }`,
          type: 'text',
          value: form.twilio_phone_number,
          onChange: e => set('twilio_phone_number', e.target.value),
          placeholder: '+15551234567'
        }),
        form.twilio_phone_number && !isValidE164(form.twilio_phone_number) &&
          React.createElement('p', { className: 'text-[11px] text-red-600 mt-1' }, 'Use E.164 format: + followed by 8\u201315 digits (e.g. +15551234567)')
      ),
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Transfer-to number'),
        React.createElement('input', {
          className: `${inputCls} font-mono ${
            form.transfer_number && !isValidE164(form.transfer_number) ? 'border-red-400 focus:ring-red-300' : ''
          }`,
          type: 'text',
          value: form.transfer_number,
          onChange: e => set('transfer_number', e.target.value),
          placeholder: '+15559876543'
        }),
        form.transfer_number && !isValidE164(form.transfer_number)
          ? React.createElement('p', { className: 'text-[11px] text-red-600 mt-1' }, 'Use E.164 format (+ then 8\u201315 digits).')
          : React.createElement('p', { className: 'text-[11px] text-gray-400 mt-1' }, 'Used when the AI transfers a live call to a human.')
      )
    ),
    React.createElement('div', null,
      React.createElement('div', { className: 'flex items-center justify-between mb-2' },
        React.createElement('span', { className: labelCls + ' mb-0' }, 'Additional lines (optional)'),
        React.createElement('button', {
          type: 'button',
          onClick: addExtraPhone,
          className: 'text-xs text-golf-700 hover:text-golf-900 font-semibold'
        }, '+ Add line')
      ),
      (form.phone_numbers || []).length === 0 &&
        React.createElement('p', { className: 'text-xs text-gray-400' }, 'No extra lines. One primary number is fine to start.'),
      (form.phone_numbers || []).map((p, i) => {
        const invalid = p.phone_number && !isValidE164(p.phone_number);
        return React.createElement('div', { key: i, className: 'mb-2' },
          React.createElement('div', { className: 'grid grid-cols-12 gap-2 items-center' },
            React.createElement('input', {
              className: `${inputCls} col-span-6 font-mono ${invalid ? 'border-red-400 focus:ring-red-300' : ''}`,
              type: 'text',
              value: p.phone_number,
              onChange: e => updateExtraPhone(i, 'phone_number', e.target.value),
              placeholder: '+1...'
            }),
            React.createElement('input', {
              className: `${inputCls} col-span-5`, type: 'text',
              value: p.label,
              onChange: e => updateExtraPhone(i, 'label', e.target.value),
              placeholder: 'Label (e.g. SMS line)'
            }),
            React.createElement('button', {
              type: 'button',
              onClick: () => removeExtraPhone(i),
              className: 'col-span-1 text-red-500 hover:text-red-700 text-xs'
            }, 'Remove')
          ),
          invalid && React.createElement('p', { className: 'text-[11px] text-red-600 mt-1' },
            'Use E.164 format (+ then 8\u201315 digits).'
          )
        );
      })
    )
  );

  const renderTemplate = () => React.createElement('div', null,
    loadingTemplates
      ? React.createElement('p', { className: 'text-sm text-gray-500' }, 'Loading templates\u2026')
      : React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' },
        templates.map(t => {
          const selected = form.template_key === t.key;
          return React.createElement('button', {
            key: t.key,
            type: 'button',
            onClick: () => set('template_key', t.key),
            className: `text-left rounded-xl border-2 p-4 transition-colors ${
              selected
                ? 'border-golf-600 bg-golf-50 ring-2 ring-golf-200'
                : 'border-gray-200 hover:border-golf-400 bg-white'
            }`
          },
            React.createElement('div', { className: 'flex items-start gap-3' },
              // Prominent vertical icon — falls back to a neutral glyph if the
              // template catalog pre-dates the polish pass that introduced it.
              React.createElement('span', {
                className: 'text-3xl leading-none flex-shrink-0',
                'aria-hidden': 'true'
              }, t.icon_emoji || '\u2728'),
              React.createElement('div', { className: 'flex-1 min-w-0' },
                React.createElement('div', { className: 'flex items-start justify-between gap-2 mb-1' },
                  React.createElement('h4', { className: 'font-bold text-gray-800' }, t.label),
                  selected && React.createElement('span', { className: 'text-[11px] font-bold text-golf-700 bg-golf-100 px-1.5 py-0.5 rounded' }, 'Selected')
                ),
                React.createElement('p', { className: 'text-xs font-medium text-gray-700 mb-1' }, t.tagline),
                t.description && React.createElement('p', { className: 'text-[11px] text-gray-500 mb-2 leading-snug' }, t.description),
                Array.isArray(t.features) && t.features.length > 0 &&
                  React.createElement('ul', { className: 'text-[11px] text-gray-500 space-y-0.5 mt-1' },
                    t.features.map((f, i) =>
                      React.createElement('li', { key: i }, `\u2022 ${f}`)
                    )
                  )
              )
            )
          );
        })
      ),
    // Per-template customization fields. Rendered only when the relevant
    // template is selected so golf_course onboarding is unchanged. Today
    // personal_assistant is the only vertical with a wizard field; as new
    // verticals grow their own knobs, add more conditional blocks here.
    form.template_key === 'personal_assistant' && React.createElement('div', {
      className: 'mt-4 rounded-xl border border-golf-200 bg-golf-50/60 p-4'
    },
      React.createElement('label', {
        className: 'block text-xs font-semibold text-gray-700 mb-1',
        htmlFor: 'wizard-assistant-name'
      }, 'Assistant name '),
      React.createElement('p', { className: 'text-[11px] text-gray-600 mb-2 leading-snug' },
        'What should the AI call itself on the phone? Leave blank to use the default '
        + '("Your Assistant"). You can change this any time from the My Info page.'),
      React.createElement('input', {
        id: 'wizard-assistant-name',
        type: 'text',
        maxLength: 40,
        className: 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-golf-500 focus:ring-1 focus:ring-golf-400',
        placeholder: 'e.g. Sam, Alex, Robin\u2026',
        value: form.assistant_name || '',
        onChange: (e) => set('assistant_name', e.target.value)
      })
    )
  );

  // ─── Voice tier step ───────────────────────────────────────────────────────
  //
  // Dedicated step (was previously crammed at the bottom of renderTemplate,
  // which meant operators who clicked Next without scrolling never saw it and
  // silently shipped every tenant on the default Standard tier).
  //
  // Plan gating was dropped for super-admin contexts: the entire wizard is
  // behind `requireSuperAdmin`, so the operator deliberately choosing a
  // premium tier for a starter-plan tenant is a legitimate action, not a
  // permission escalation. We still render a subtle "self-serve requires
  // plan X" hint per tier so the operator knows what plan a customer would
  // need to pick this themselves when self-serve ships. The plan-tier map
  // is still authoritative server-side for any future non-super-admin
  // route that lets a customer change their own tier.
  const renderVoice = () => React.createElement('div', { className: 'space-y-4' },
    React.createElement('p', { className: 'text-xs text-gray-500' },
      'Pick the Grok voice the tenant pays for per minute of conversation. You can change this later from the super-admin panel.'),
    voiceTiers.length === 0
      ? React.createElement('p', { className: 'text-sm text-gray-500' }, 'Loading voice tiers\u2026')
      : React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-3 gap-3' },
          voiceTiers.map(tier => {
            const selected = form.voice_tier === tier.key;
            const costDots = '$'.repeat(tier.cost_tier || 1);
            // Compute plan-reach purely for the informational badge — the
            // button itself is never disabled for super-admin.
            const plansThatInclude = Object.entries(voicePlanAccess || {})
              .filter(([, tiers]) => Array.isArray(tiers) && tiers.includes(tier.key))
              .map(([p]) => p)
              .filter(p => p !== 'legacy'); // legacy = Valleymede-only, not meaningful to operators
            return React.createElement('button', {
              key: tier.key,
              type: 'button',
              onClick: () => set('voice_tier', tier.key),
              className: `text-left rounded-xl border-2 p-3 transition-colors ${
                selected
                  ? 'border-golf-600 bg-golf-50 ring-2 ring-golf-200'
                  : 'border-gray-200 hover:border-golf-400 bg-white'
              }`
            },
              React.createElement('div', { className: 'flex items-start justify-between gap-2 mb-1' },
                React.createElement('h5', { className: 'font-bold text-gray-800' }, tier.label),
                React.createElement('span', {
                  className: `text-[11px] font-bold ${selected ? 'text-golf-700' : 'text-gray-500'}`
                }, costDots)
              ),
              React.createElement('p', { className: 'text-[11px] font-medium text-gray-700 mb-1' }, tier.tagline),
              tier.description && React.createElement('p', { className: 'text-[11px] text-gray-500 leading-snug' }, tier.description),
              plansThatInclude.length > 0 && React.createElement('p', {
                className: 'text-[11px] text-gray-400 italic mt-2'
              }, `Self-serve: requires ${plansThatInclude.join(' / ')} plan`),
              selected && React.createElement('span', {
                className: 'inline-block text-[11px] font-bold text-golf-700 bg-golf-100 px-1.5 py-0.5 rounded mt-1'
              }, 'Selected')
            );
          })
        ),
    React.createElement('p', { className: 'text-[11px] text-gray-400 italic' },
      'As super-admin you can pick any tier regardless of plan. The per-plan labels are informational — they\u2019ll gate customer-facing self-serve when that ships.')
  );

  const renderReview = () => React.createElement('div', { className: 'space-y-4 text-sm' },
    React.createElement('div', { className: 'bg-gray-50 border rounded-xl p-4' },
      React.createElement('h4', { className: 'font-semibold text-gray-800 mb-2' }, 'Business'),
      React.createElement('dl', { className: 'grid grid-cols-2 gap-y-1 text-xs' },
        React.createElement('dt', { className: 'text-gray-500' }, 'Name'),
        React.createElement('dd', { className: 'text-gray-800 font-medium' }, form.name || '\u2014'),
        React.createElement('dt', { className: 'text-gray-500' }, 'Slug'),
        React.createElement('dd', { className: 'text-gray-800 font-mono' }, form.slug || '\u2014'),
        React.createElement('dt', { className: 'text-gray-500' }, 'Timezone'),
        React.createElement('dd', { className: 'text-gray-800' }, form.timezone || '\u2014'),
        React.createElement('dt', { className: 'text-gray-500' }, 'Plan'),
        React.createElement('dd', { className: 'text-gray-800' }, form.plan),
        React.createElement('dt', { className: 'text-gray-500' }, 'Contact'),
        React.createElement('dd', { className: 'text-gray-800' }, form.contact_email || '\u2014'),
        React.createElement('dt', { className: 'text-gray-500' }, 'Primary color'),
        React.createElement('dd', { className: 'text-gray-800 flex items-center gap-2' },
          React.createElement('span', {
            className: 'inline-block w-4 h-4 rounded border',
            style: { background: form.primary_color }
          }),
          React.createElement('span', { className: 'font-mono text-xs' }, form.primary_color)
        )
      )
    ),
    React.createElement('div', { className: 'bg-gray-50 border rounded-xl p-4' },
      React.createElement('h4', { className: 'font-semibold text-gray-800 mb-2' }, 'Phone numbers'),
      form.twilio_phone_number
        ? React.createElement('p', { className: 'text-xs font-mono text-gray-800' }, `${form.twilio_phone_number} \u2014 Main Line`)
        : React.createElement('p', { className: 'text-xs text-amber-700' }, 'No primary number set \u2014 inbound calls won\u2019t resolve until you add one.'),
      form.transfer_number &&
        React.createElement('p', { className: 'text-xs text-gray-600 mt-1' }, `Transfers to ${form.transfer_number}`),
      (form.phone_numbers || []).filter(p => p.phone_number).length > 0 &&
        React.createElement('ul', { className: 'mt-2 space-y-0.5 text-xs font-mono text-gray-700' },
          form.phone_numbers.filter(p => p.phone_number).map((p, i) =>
            React.createElement('li', { key: i }, `${p.phone_number} \u2014 ${p.label}`)
          )
        )
    ),
    React.createElement('div', { className: 'bg-gray-50 border rounded-xl p-4' },
      React.createElement('h4', { className: 'font-semibold text-gray-800 mb-2' }, 'Template'),
      chosenTemplate
        ? React.createElement('div', null,
            React.createElement('p', { className: 'text-sm font-medium text-gray-800' }, chosenTemplate.label),
            React.createElement('p', { className: 'text-xs text-gray-500' }, chosenTemplate.tagline),
            Array.isArray(chosenTemplate.settings_keys) && chosenTemplate.settings_keys.length > 0 &&
              React.createElement('p', { className: 'text-[11px] text-gray-400 mt-2' },
                `Seeds ${chosenTemplate.settings_keys.length} settings keys + ${chosenTemplate.greeting_count || 0} greetings.`
              )
          )
        : React.createElement('p', { className: 'text-xs text-gray-500' }, 'None selected.')
    ),
    React.createElement('div', { className: 'bg-gray-50 border rounded-xl p-4' },
      React.createElement('h4', { className: 'font-semibold text-gray-800 mb-2' }, 'Voice tier'),
      React.createElement('p', { className: 'text-sm text-gray-800 capitalize' },
        (voiceTiers.find(t => t.key === form.voice_tier)?.label) || form.voice_tier || 'Standard'
      ),
      React.createElement('p', { className: 'text-xs text-gray-500' },
        voiceTiers.find(t => t.key === form.voice_tier)?.tagline || ''
      )
    )
  );

  const renderInvite = () => React.createElement('div', { className: 'space-y-4' },
    React.createElement('div', { className: 'bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800' },
      'Enter the email of the person who\u2019ll own this tenant. We\u2019ll mint a magic-link invite and show you the URL on the next step \u2014 share it however you like (email, Slack, carrier pigeon). Skip this if you want to invite them later.'
    ),
    React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Admin email'),
        React.createElement('input', {
          className: inputCls, type: 'email',
          value: form.admin_email,
          onChange: e => set('admin_email', e.target.value),
          placeholder: 'owner@business.com'
        })
      ),
      React.createElement('div', null,
        React.createElement('label', { className: labelCls }, 'Admin name (optional)'),
        React.createElement('input', {
          className: inputCls, type: 'text',
          value: form.admin_name,
          onChange: e => set('admin_name', e.target.value),
          placeholder: 'Jamie Rivera'
        })
      )
    )
  );

  const renderSuccess = () => React.createElement('div', { className: 'text-center py-4' },
    React.createElement('div', { className: 'text-5xl mb-3' }, '\ud83c\udf89'),
    React.createElement('h3', { className: 'text-xl font-bold text-gray-800 mb-1' },
      `${result?.business?.name || 'Business'} is live`
    ),
    React.createElement('p', { className: 'text-sm text-gray-500 mb-5' },
      result?.template
        ? `Seeded ${result.template.settings_applied} settings + ${result.template.greetings_applied} greetings from the ${result.template.template_key} template.`
        : 'Tenant created.'
    ),
    result?.voice?.tier && React.createElement('p', { className: 'text-xs text-gray-500 mb-4 -mt-3 capitalize' },
      `Voice tier: ${result.voice.tier}`
    ),
    result?.invite && React.createElement('div', { className: 'bg-green-50 border border-green-200 rounded-xl p-4 text-left mb-4' },
      React.createElement('p', { className: 'text-sm font-semibold text-green-800 mb-2' },
        `Magic link for ${result.invite.email}:`
      ),
      React.createElement('code', { className: 'block bg-white border border-green-200 rounded p-2 text-xs break-all' },
        result.invite.invite_url
      ),
      React.createElement('button', {
        onClick: () => { try { navigator.clipboard.writeText(result.invite.invite_url); } catch (_) {} },
        className: 'text-green-700 text-xs mt-2 font-semibold underline'
      }, 'Copy link')
    ),
    Array.isArray(result?.phone_numbers) && result.phone_numbers.length > 0 &&
      React.createElement('div', { className: 'bg-gray-50 border rounded-xl p-4 text-left mb-4' },
        React.createElement('p', { className: 'text-xs font-semibold text-gray-700 mb-2' }, 'Phone numbers registered'),
        React.createElement('ul', { className: 'text-xs font-mono text-gray-800 space-y-0.5' },
          result.phone_numbers.map(p =>
            React.createElement('li', { key: p.id },
              `${p.phone_number} \u2014 ${p.label || 'Line'}${p.is_primary ? ' (primary)' : ''}`
            )
          )
        )
      ),
    // When the operator skipped the invite, surface a friendly reminder so the
    // tenant doesn't silently end up without an owner account.
    !result?.invite && React.createElement('p', { className: 'text-xs text-gray-500 mt-1' },
      'No admin invite was created. You can send one later from the business card.'
    )
  );

  const stepBodies = [
    renderBasics,
    renderPhones,
    renderTemplate,
    renderVoice,
    renderReview,
    renderInvite,
    renderSuccess
  ];

  return React.createElement('div', { className: 'fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50' },
    React.createElement('div', { className: 'bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden' },
      // ---------- Header / progress ----------
      React.createElement('div', { className: 'px-6 py-5 border-b bg-gradient-to-br from-golf-50 to-white' },
        React.createElement('div', { className: 'flex items-center justify-between mb-4' },
          React.createElement('div', null,
            React.createElement('h2', { className: 'text-lg font-bold text-gray-800' }, steps[step].title),
            React.createElement('p', { className: 'text-xs text-gray-500' }, steps[step].sub)
          ),
          React.createElement('button', {
            onClick: onCancel,
            className: 'text-gray-400 hover:text-gray-600 text-xl leading-none',
            'aria-label': 'Close'
          }, '\u00d7')
        ),
        React.createElement('div', { className: 'flex items-center gap-1' },
          steps.map((_, i) =>
            React.createElement('div', {
              key: i,
              className: `flex-1 h-1.5 rounded-full ${
                i < step ? 'bg-golf-600' : i === step ? 'bg-golf-400' : 'bg-gray-200'
              }`
            })
          )
        ),
        React.createElement('p', { className: 'text-[11px] text-gray-400 mt-2' }, `Step ${Math.min(step + 1, steps.length)} of ${steps.length}`)
      ),

      // ---------- Body ----------
      React.createElement('div', { className: 'flex-1 overflow-auto px-6 py-5' },
        error && React.createElement('div', { className: 'bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm' }, error),
        stepBodies[step]()
      ),

      // ---------- Footer / navigation ----------
      //
      // Step index map (7-step flow):
      //   0 basics · 1 phones · 2 template · 3 voice · 4 review · 5 invite · 6 success
      //
      // Anything that used to key on "3 = review" / "4 = invite" / "5 = success"
      // was shifted by one after voice tier was promoted to its own step. If
      // you add or remove a step, update every comparison below in lockstep.
      React.createElement('div', { className: 'px-6 py-4 border-t bg-gray-50 flex items-center justify-between' },
        step < 6
          ? React.createElement('button', {
              type: 'button',
              onClick: () => step === 0 ? onCancel() : setStep(step - 1),
              className: 'px-4 py-2 rounded-lg bg-white border border-gray-300 hover:bg-gray-100 text-sm font-medium text-gray-700'
            }, step === 0 ? 'Cancel' : 'Back')
          : React.createElement('span', null),
        step < 4 && React.createElement('button', {
          type: 'button',
          disabled: !canAdvance(),
          onClick: () => setStep(step + 1),
          className: 'px-5 py-2 rounded-lg bg-golf-600 hover:bg-golf-700 text-white text-sm font-semibold disabled:opacity-40'
        }, 'Next \u2192'),
        step === 4 && React.createElement('button', {
          type: 'button',
          onClick: () => setStep(5),
          className: 'px-5 py-2 rounded-lg bg-golf-600 hover:bg-golf-700 text-white text-sm font-semibold'
        }, 'Looks good \u2192'),
        // Step 5 footer: the operator either fills an admin_email and creates
        // with an invite, or explicitly skips the invite (with a clear hint).
        step === 5 && React.createElement('div', { className: 'flex items-center gap-2' },
          !form.admin_email.trim() && React.createElement('span', { className: 'text-[11px] text-gray-500' },
            isPersonal
              ? 'You can invite the account owner later from the card.'
              : 'You can invite an admin later from the business card.'
          ),
          React.createElement('button', {
            type: 'button',
            disabled: saving || !canAdvance(),
            onClick: handleCreate,
            className: 'px-5 py-2 rounded-lg bg-golf-600 hover:bg-golf-700 text-white text-sm font-semibold disabled:opacity-50'
          }, saving
            ? (isPersonal ? 'Creating account\u2026' : 'Creating business\u2026')
            : (form.admin_email.trim()
                ? (isPersonal ? 'Create account + send invite' : 'Create business + send invite')
                : (isPersonal ? 'Skip invite & create account' : 'Skip invite & create business'))
          )
        ),
        // Step 6 footer (success): offer to switch into the new tenant or
        // return to the super-admin dashboard. The Act-as button is only
        // visible if the wizard was handed an onActAs handler (wired in
        // SuperAdminDashboard).
        step === 6 && React.createElement('div', { className: 'flex items-center gap-2' },
          typeof onActAs === 'function' && result?.business?.id && React.createElement('button', {
            type: 'button',
            // Pass the fresh business object as a hint. Parent handleSelectBusiness
            // merges it into the businesses[] cache synchronously so the first
            // render after act-as knows template_key — otherwise a new
            // personal_assistant / restaurant tenant renders the golf fallback
            // for a frame while /api/super/businesses round-trips.
            onClick: () => onActAs(result.business.id, result.business),
            className: 'px-4 py-2 rounded-lg bg-white border border-golf-300 hover:bg-golf-50 text-sm font-semibold text-golf-700'
          }, `Act as ${result.business.name || 'this business'}`),
          React.createElement('button', {
            type: 'button',
            onClick: handleFinish,
            className: 'px-5 py-2 rounded-lg bg-golf-600 hover:bg-golf-700 text-white text-sm font-semibold'
          }, 'Back to dashboard')
        )
      )
    )
  );
}

// ============================================
// TOAST NOTIFICATIONS (live booking events)
// ============================================
//
// Listens for `cmdcenter:refresh` window events (re-broadcast by the App
// from the SSE stream — see App() useEffect) and shows a small slide-in
// toast for booking.created / modification.created events. Every other
// event type is ignored — booking.updated etc. is what STAFF cause when
// they confirm/reject, no point showing a toast for those.
//
// Sound: short Web Audio chime (no asset file needed). Can be muted via
// the bell icon, persisted in localStorage so the choice survives reloads.
//
// Optional desktop notifications: if the user has granted Notification
// permission (one-click prompt rendered next to the bell when permission
// is "default"), we ALSO fire a native OS notification, useful when staff
// are tabbed away.
//
// Click a toast to dismiss it. Clicking the body navigates to the
// bookings list (passed in as `onNavigate` from App).
function playBookingChime() {
  if (typeof window === 'undefined') return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.18);
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.start();
    o.stop(ctx.currentTime + 0.5);
  } catch (_) { /* no-op — silence beats a crash */ }
}

function formatBookingWhen(dateStr, timeStr) {
  // Postgres returns DATE as "YYYY-MM-DD" and TIME as "HH:MM:SS".
  // We render a compact "Sat, May 4 — 8:08 AM"-ish string.
  if (!dateStr) return '';
  let d;
  try {
    // Treat YYYY-MM-DD as local date (avoid UTC shift).
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    else d = new Date(dateStr);
  } catch (_) { return String(dateStr); }
  if (isNaN(d?.getTime())) return String(dateStr);
  const datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  let timePart = '';
  if (timeStr) {
    const t = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
    if (t) {
      let h = parseInt(t[1]);
      const mins = t[2];
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      timePart = ` — ${h}:${mins} ${ampm}`;
    }
  }
  return datePart + timePart;
}

function Toaster({ onNavigate }) {
  const [toasts, setToasts] = useState([]);
  const [muted, setMuted] = useState(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('cc_toaster_muted') === '1';
  });
  const [notifPerm, setNotifPerm] = useState(() => {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  });

  const dismiss = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  useEffect(() => {
    const onLive = (e) => {
      const detail = e?.detail || {};
      const type = detail.type;
      const data = detail.data || {};
      if (type !== 'booking.created' && type !== 'modification.created') return;

      let title, body;
      if (type === 'booking.created') {
        const who = data.customer_name || 'A caller';
        const players = parseInt(data.party_size) || 1;
        const playerWord = players === 1 ? 'player' : 'players';
        const when = formatBookingWhen(data.requested_date, data.requested_time);
        title = '🔔 New booking';
        body = when ? `${who} — ${players} ${playerWord} • ${when}` : `${who} — ${players} ${playerWord}`;
      } else {
        const who = data.customer_name || 'A caller';
        const verb = data.request_type === 'cancel' ? 'cancellation' : 'change request';
        title = '✏️ New ' + verb;
        body = who;
      }

      const id = Date.now() + Math.random();
      setToasts(prev => [...prev.slice(-4), { id, title, body }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, 9000);

      if (!muted) playBookingChime();

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const n = new Notification(title, { body, tag: `cc-${type}-${id}` });
          n.onclick = () => {
            window.focus();
            if (typeof onNavigate === 'function') onNavigate();
            n.close();
          };
        } catch (_) { /* some browsers throw on notif from non-secure context */ }
      }
    };
    window.addEventListener('cmdcenter:refresh', onLive);
    return () => window.removeEventListener('cmdcenter:refresh', onLive);
  }, [muted, onNavigate]);

  const toggleMute = () => {
    setMuted(m => {
      const next = !m;
      try { localStorage.setItem('cc_toaster_muted', next ? '1' : '0'); } catch (_) {}
      return next;
    });
  };

  const enableNotifs = async () => {
    if (typeof Notification === 'undefined') return;
    try {
      const result = await Notification.requestPermission();
      setNotifPerm(result);
    } catch (_) { /* user dismissed */ }
  };

  // Floating control cluster (mute toggle + notification opt-in) lives in
  // the same fixed corner so it doesn't interfere with page layout.
  const controls = React.createElement('div', {
    className: 'fixed top-4 right-4 z-40 flex items-center gap-2'
  },
    notifPerm === 'default' && React.createElement('button', {
      onClick: enableNotifs,
      title: 'Enable desktop notifications',
      className: 'bg-white border border-gray-200 hover:border-golf-400 text-xs px-3 py-1.5 rounded-full shadow-sm text-gray-700'
    }, '🔔 Enable desktop alerts'),
    React.createElement('button', {
      onClick: toggleMute,
      title: muted ? 'Sounds off — click to enable' : 'Sounds on — click to mute',
      className: `bg-white border border-gray-200 hover:border-golf-400 text-base w-9 h-9 rounded-full shadow-sm ${muted ? 'opacity-60' : ''}`
    }, muted ? '🔕' : '🔔')
  );

  const stack = React.createElement('div', {
    className: 'fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm'
  },
    toasts.map(t =>
      React.createElement('div', {
        key: t.id,
        onClick: () => {
          if (typeof onNavigate === 'function') onNavigate();
          dismiss(t.id);
        },
        className: 'bg-white border-l-4 border-golf-500 shadow-lg rounded-lg pl-4 pr-3 py-3 cursor-pointer hover:shadow-xl transition-shadow'
      },
        React.createElement('div', { className: 'flex items-start gap-3' },
          React.createElement('div', { className: 'flex-1 min-w-0' },
            React.createElement('div', { className: 'font-semibold text-sm text-gray-800' }, t.title),
            React.createElement('div', { className: 'text-sm text-gray-600 mt-0.5' }, t.body)
          ),
          React.createElement('button', {
            onClick: (e) => { e.stopPropagation(); dismiss(t.id); },
            className: 'text-gray-300 hover:text-gray-500 text-lg leading-none -mt-1'
          }, '×')
        )
      )
    )
  );

  return React.createElement(React.Fragment, null, controls, stack);
}

// ============================================
// TOP BAR (shown above all authenticated views)
// ============================================
function TopBar({ session, businesses, selectedBusinessId, onSelectBusiness, onLogout }) {
  const isSuper = session?.role === 'super_admin';
  const selectedName = selectedBusinessId
    ? (businesses.find(b => b.id === selectedBusinessId)?.name || `Business #${selectedBusinessId}`)
    : null;

  return React.createElement('header', { className: 'bg-white border-b px-6 py-3 flex items-center justify-between' },
    React.createElement('div', { className: 'flex items-center gap-3' },
      isSuper && React.createElement('span', { className: 'text-xs uppercase tracking-wider font-semibold text-purple-600 bg-purple-50 px-2 py-0.5 rounded' }, 'SUPER ADMIN'),
      !isSuper && React.createElement('span', { className: 'text-xs uppercase tracking-wider font-semibold text-gray-500' }, session?.role?.replace('_', ' ') || ''),
      isSuper && selectedName && React.createElement('span', { className: 'text-sm text-gray-400' }, '\u2192'),
      isSuper && selectedName && React.createElement('span', { className: 'text-sm font-medium text-gray-700' }, `Acting as ${selectedName}`)
    ),
    React.createElement('div', { className: 'flex items-center gap-3' },
      isSuper && React.createElement(BusinessSwitcher, {
        businesses,
        selectedId: selectedBusinessId,
        onSelect: onSelectBusiness
      }),
      React.createElement('span', { className: 'text-sm text-gray-500' }, session?.username || ''),
      React.createElement('button', {
        onClick: onLogout,
        className: 'text-sm text-gray-500 hover:text-gray-800'
      }, 'Sign out')
    )
  );
}

// ============================================
// PERSONAL ASSISTANT PAGES
// ============================================
// Lightweight pages for the personal_assistant template. They intentionally
// reuse the existing CallLogsPage + SettingsPage so the feature set matches
// what tenants already trust; only the Owner Profile surface is net-new.

// The "Personal Assistant" landing page — a clean, friendly overview for the
// solo operator. Shows who the assistant is (assistant name + owner name)
// and recent call activity. Avoids the golf-centric dashboard chrome.
function PersonalAssistantPage() {
  const [owner, setOwner] = useState(null);
  const [personality, setPersonality] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // /api/settings returns the whole { key: { value, description } } map.
    // Pull the two keys we care about out of it so we only make one request.
    Promise.all([
      api('/api/settings').catch(() => ({})),
      api('/api/calls?limit=5').catch(() => ({ calls: [] }))
    ]).then(([settings, calls]) => {
      setOwner((settings && settings.owner_profile && settings.owner_profile.value) || {});
      setPersonality((settings && settings.ai_personality && settings.ai_personality.value) || {});
      setRecent((calls && calls.calls) || []);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return React.createElement('div', { className: 'text-gray-500' }, 'Loading\u2026');
  }

  const assistantName = (personality && personality.name) || 'Your assistant';
  const ownerName = (owner && owner.owner_name) || 'you';

  return React.createElement('div', { className: 'max-w-4xl mx-auto space-y-6' },
    React.createElement('div', { className: 'bg-white rounded-2xl shadow p-6 border border-gray-100' },
      React.createElement('div', { className: 'flex items-center gap-4' },
        React.createElement('div', { className: 'w-14 h-14 rounded-full bg-golf-100 flex items-center justify-center text-2xl' }, '\ud83d\udc64'),
        React.createElement('div', null,
          React.createElement('div', { className: 'text-sm text-gray-500' }, 'Meet your assistant'),
          React.createElement('div', { className: 'text-xl font-bold text-gray-900' }, assistantName),
          React.createElement('div', { className: 'text-sm text-gray-600' }, `Handling calls for ${ownerName}`)
        )
      ),
      React.createElement('p', { className: 'mt-4 text-sm text-gray-600' },
        'After every call, you get a concise SMS recap. Update your info and call-handling rules in My Info or Settings.'
      )
    ),
    React.createElement('div', { className: 'bg-white rounded-2xl shadow p-6 border border-gray-100' },
      React.createElement('h3', { className: 'text-lg font-semibold text-gray-900 mb-4' }, 'Recent calls'),
      recent.length === 0
        ? React.createElement('div', { className: 'text-sm text-gray-500' }, 'No calls yet. Your assistant will answer as soon as someone rings.')
        : React.createElement('ul', { className: 'divide-y divide-gray-100' },
            recent.slice(0, 5).map((c) =>
              React.createElement('li', { key: c.id, className: 'py-3' },
                React.createElement('div', { className: 'text-sm font-medium text-gray-900' },
                  c.customer_name || c.caller_phone || 'Unknown caller'
                ),
                React.createElement('div', { className: 'text-xs text-gray-500 truncate' },
                  c.summary || 'No summary'
                )
              )
            )
          )
    )
  );
}

// "My Info" — the owner fills in everything the assistant needs to speak on
// their behalf: their name, business, family, preferences, schedule. All of
// it feeds buildPersonalAssistantPrompt() on the server. No business logic
// here beyond load/save; each field maps 1:1 to owner_profile.
function MyInfoPage() {
  const [profile, setProfile] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/api/settings').then((all) => {
      const p = all && all.owner_profile && all.owner_profile.value;
      const s = all && all.schedule_preferences && all.schedule_preferences.value;
      setProfile(p || {
        assistant_name: '',
        owner_name: '', business_name: '', business_description: '',
        pronouns: '', family: [], preferences: '', notable_details: ''
      });
      setSchedule(s || {
        typical_hours: 'Weekdays 9\u20135', busy_days: [], do_not_disturb: '', appointment_buffer_min: 15
      });
    }).catch(() => {
      setProfile({
        assistant_name: '',
        owner_name: '', business_name: '', business_description: '',
        pronouns: '', family: [], preferences: '', notable_details: ''
      });
      setSchedule({ typical_hours: 'Weekdays 9\u20135', busy_days: [], do_not_disturb: '', appointment_buffer_min: 15 });
    });
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus('');
    try {
      await api('/api/settings/owner_profile', {
        method: 'PUT',
        body: JSON.stringify({ value: profile })
      });
      await api('/api/settings/schedule_preferences', {
        method: 'PUT',
        body: JSON.stringify({ value: schedule })
      });
      setStatus('Saved');
    } catch (err) {
      setStatus('Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!profile || !schedule) {
    return React.createElement('div', { className: 'text-gray-500' }, 'Loading\u2026');
  }

  const label = 'block text-xs font-semibold text-gray-600 mb-1';
  const input = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none';

  const field = (key, text, opts = {}) =>
    React.createElement('div', null,
      React.createElement('label', { className: label }, text),
      opts.multiline
        ? React.createElement('textarea', {
            className: input, rows: opts.rows || 3,
            value: profile[key] || '',
            onChange: (e) => setProfile({ ...profile, [key]: e.target.value })
          })
        : React.createElement('input', {
            className: input,
            value: profile[key] || '',
            onChange: (e) => setProfile({ ...profile, [key]: e.target.value })
          })
    );

  return React.createElement('div', { className: 'max-w-3xl mx-auto space-y-6' },
    React.createElement('div', { className: 'bg-white rounded-2xl shadow p-6 border border-gray-100' },
      React.createElement('h2', { className: 'text-xl font-bold text-gray-900 mb-1' }, 'My Info'),
      React.createElement('p', { className: 'text-sm text-gray-600 mb-6' },
        'Your assistant uses this information to speak on your behalf and answer basic questions. Nothing here is shared outside your calls.'
      ),
      // Assistant name gets its own callout — it controls how the AI
      // introduces itself on the phone ("Hi, I'm Sam, taking calls for
      // Nelson"), and is the single field owners touch most often. Sits
      // above the rest of the profile so it's the first thing they see.
      React.createElement('div', { className: 'mb-5 rounded-xl border border-golf-200 bg-golf-50/60 p-4' },
        React.createElement('label', {
          className: 'block text-xs font-semibold text-gray-700 mb-1',
          htmlFor: 'my-info-assistant-name'
        }, 'Assistant name'),
        React.createElement('p', { className: 'text-[11px] text-gray-600 mb-2 leading-snug' },
          'The name your AI assistant uses when it answers the phone. Leave blank to use the default ("Your Assistant").'
        ),
        React.createElement('input', {
          id: 'my-info-assistant-name',
          className: input,
          maxLength: 40,
          placeholder: 'e.g. Sam, Alex, Robin\u2026',
          value: profile.assistant_name || '',
          onChange: (e) => setProfile({ ...profile, assistant_name: e.target.value })
        })
      ),
      React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4' },
        field('owner_name', 'Your name'),
        field('pronouns', 'Pronouns (optional)'),
        field('business_name', 'Business / role'),
        field('business_description', 'What you do', { multiline: true, rows: 2 })
      ),
      React.createElement('div', { className: 'mt-4 grid grid-cols-1 gap-4' },
        field('preferences', 'Preferences (how you like calls handled)', { multiline: true, rows: 3 }),
        field('notable_details', 'Anything else the assistant should know', { multiline: true, rows: 3 })
      )
    ),
    React.createElement('div', { className: 'bg-white rounded-2xl shadow p-6 border border-gray-100' },
      React.createElement('h3', { className: 'text-lg font-semibold text-gray-900 mb-4' }, 'Schedule preferences'),
      React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4' },
        React.createElement('div', null,
          React.createElement('label', { className: label }, 'Typical hours'),
          React.createElement('input', {
            className: input, value: schedule.typical_hours || '',
            onChange: (e) => setSchedule({ ...schedule, typical_hours: e.target.value })
          })
        ),
        React.createElement('div', null,
          React.createElement('label', { className: label }, 'Do-not-disturb window'),
          React.createElement('input', {
            className: input, value: schedule.do_not_disturb || '',
            onChange: (e) => setSchedule({ ...schedule, do_not_disturb: e.target.value })
          })
        )
      )
    ),
    React.createElement('div', { className: 'flex items-center gap-3' },
      React.createElement('button', {
        onClick: save, disabled: saving,
        className: 'bg-golf-600 hover:bg-golf-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50'
      }, saving ? 'Saving\u2026' : 'Save changes'),
      status && React.createElement('span', { className: 'text-sm text-gray-500' }, status)
    )
  );
}

// Personal-assistant Settings page.
//
// Mirrors the shape of SettingsPage but drops every golf-course-shaped tab
// (Daily, Course Info, Knowledge, Pricing, Hours) — personal tenants handle
// name/hours/bio through MyInfoPage. What remains is universally applicable
// to a solo-operator voice assistant: the phone numbers that ring, how the
// AI greets callers, where call recaps go, AI personality, prompt tweaks,
// and test mode. Shares the same settings KV store + PhoneNumbersManager
// component as SettingsPage — only the UI surface is template-specific.
function PersonalSettingsPage() {
  const [settings, setSettings] = useState({});
  const [greetings, setGreetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [newGreeting, setNewGreeting] = useState('');
  const [newGreetingKnown, setNewGreetingKnown] = useState(false);
  const [activeTab, setActiveTab] = useState('phones');

  useEffect(() => {
    Promise.all([
      api('/api/settings').catch(() => ({})),
      api('/api/greetings').catch(() => [])
    ]).then(([s, g]) => { setSettings(s || {}); setGreetings(Array.isArray(g) ? g : []); })
      .catch(console.error).finally(() => setLoading(false));
  }, []);

  const saveSetting = async (key, value) => {
    setSaving(key);
    try {
      await api(`/api/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
      setSettings(prev => ({ ...prev, [key]: { ...prev[key], value } }));
    } catch (err) { alert('Failed to save: ' + err.message); }
    finally { setSaving(''); }
  };

  const addGreeting = async () => {
    if (!newGreeting.trim()) return;
    try {
      const g = await api('/api/greetings', { method: 'POST', body: JSON.stringify({ message: newGreeting, for_known_caller: newGreetingKnown }) });
      setGreetings(prev => [...prev, g]);
      setNewGreeting('');
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const deleteGreeting = async (id) => {
    try {
      await api(`/api/greetings/${id}`, { method: 'DELETE' });
      setGreetings(prev => prev.filter(g => g.id !== id));
    } catch (err) { alert('Failed: ' + err.message); }
  };

  if (loading) return React.createElement('div', { className: 'p-8 text-gray-500' }, 'Loading settings\u2026');

  const tabs = [
    { id: 'phones',        label: '\uD83D\uDCDE Phones' },
    { id: 'team',          label: '\uD83D\uDC65 Team' },
    { id: 'users',         label: '\uD83D\uDD11 Users' },
    { id: 'greetings',     label: 'Greetings' },
    { id: 'prompt',        label: 'Prompt' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'ai',            label: 'AI Behavior' },
    { id: 'test',          label: 'Test Mode' }
  ];

  const val = (key) => settings[key]?.value;

  return React.createElement('div', null,
    React.createElement('h1', { className: 'text-2xl font-bold text-gray-800 mb-2' }, 'Settings'),
    React.createElement('p', { className: 'text-sm text-gray-500 mb-6' },
      'Control how your personal assistant handles calls. For personal details your assistant needs to know about you (name, schedule, preferences), use My Info.'
    ),

    React.createElement('div', { className: 'flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 overflow-x-auto' },
      tabs.map(t =>
        React.createElement('button', {
          key: t.id, onClick: () => setActiveTab(t.id),
          className: `px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${activeTab === t.id ? 'bg-white shadow text-golf-700' : 'text-gray-500 hover:text-gray-700'}`
        }, t.label)
      )
    ),

    React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border p-6' },

      // PHONES
      activeTab === 'phones' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'The phone numbers your assistant answers. Disable a number to stop taking calls on it without losing history.'
        ),
        React.createElement(PhoneNumbersManager, {
          endpointBase: '/api/phone-numbers',
          title: 'Your Phone Numbers'
        })
      ),

      // TEAM
      activeTab === 'team' && React.createElement(TeamDirectoryManager, null),

      // USERS — login accounts for this tenant. Same component
      // as the super-admin Edit Tenant modal; with no businessId
      // prop it defaults to the self-service /api/users endpoints.
      activeTab === 'users' && React.createElement(TenantUsersPanel, null),

      // GREETINGS
      activeTab === 'greetings' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Your assistant picks a random greeting each time. Use {name} as a placeholder so returning callers hear their own name.'
        ),

        React.createElement('h3', { className: 'font-semibold mb-2' }, 'New caller greetings'),
        greetings.filter(g => !g.for_known_caller).length === 0
          ? React.createElement('p', { className: 'text-sm text-gray-400 mb-3' }, 'No new-caller greetings yet.')
          : greetings.filter(g => !g.for_known_caller).map(g =>
              React.createElement('div', { key: g.id, className: 'flex items-center gap-2 mb-2 bg-gray-50 rounded-lg p-3' },
                React.createElement('span', { className: 'flex-1 text-sm' }, g.message),
                React.createElement('button', { onClick: () => deleteGreeting(g.id), className: 'text-red-400 hover:text-red-600 text-sm' }, 'Remove')
              )
            ),

        React.createElement('h3', { className: 'font-semibold mb-2 mt-4' }, 'Returning caller greetings'),
        greetings.filter(g => g.for_known_caller).length === 0
          ? React.createElement('p', { className: 'text-sm text-gray-400 mb-3' }, 'No returning-caller greetings yet.')
          : greetings.filter(g => g.for_known_caller).map(g =>
              React.createElement('div', { key: g.id, className: 'flex items-center gap-2 mb-2 bg-green-50 rounded-lg p-3' },
                React.createElement('span', { className: 'flex-1 text-sm' }, g.message),
                React.createElement('button', { onClick: () => deleteGreeting(g.id), className: 'text-red-400 hover:text-red-600 text-sm' }, 'Remove')
              )
            ),

        React.createElement('div', { className: 'mt-4 border-t pt-4' },
          React.createElement('h3', { className: 'font-semibold mb-2' }, 'Add a greeting'),
          React.createElement('input', {
            type: 'text', value: newGreeting, onChange: e => setNewGreeting(e.target.value),
            placeholder: 'e.g., Hi there! Thanks for calling. How can I help?',
            className: 'w-full border rounded-lg px-3 py-2 mb-2 text-sm'
          }),
          React.createElement('div', { className: 'flex items-center gap-4' },
            React.createElement('label', { className: 'flex items-center gap-2 text-sm' },
              React.createElement('input', { type: 'checkbox', checked: newGreetingKnown, onChange: e => setNewGreetingKnown(e.target.checked) }),
              'For returning callers (use {name} placeholder)'
            ),
            React.createElement('button', { onClick: addGreeting, className: 'bg-golf-600 hover:bg-golf-700 text-white px-4 py-2 rounded-lg text-sm' }, 'Add greeting')
          )
        )
      ),

      // PROMPT
      activeTab === 'prompt' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Fine-tune how your assistant behaves. These instructions are layered on top of the built-in personal assistant prompt.'
        ),
        React.createElement(SettingField, {
          label: 'Assistant name',
          description: 'The name your assistant uses when answering ("Hi, I\u2019m Sam\u2026"). You can also set this on the My Info page.',
          value: val('ai_personality')?.name || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), name: v }),
          saving: saving === 'ai_personality'
        }),
        React.createElement(SettingField, {
          label: 'Language handling',
          description: 'How the assistant decides which language to respond in. E.g., "Match the caller\u2019s language; default to English."',
          value: val('ai_personality')?.language || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), language: v }),
          saving: saving === 'ai_personality'
        }),
        React.createElement(SettingTextarea, {
          label: 'Custom prompt additions',
          description: 'Extra instructions layered on the base personal assistant prompt. Keep it short and specific \u2014 e.g., "Always take a message if it\u2019s about my kids\u2019 school."',
          value: val('custom_prompt') || '',
          rows: 10,
          onSave: v => saveSetting('custom_prompt', v),
          saving: saving === 'custom_prompt'
        })
      ),

      // NOTIFICATIONS
      activeTab === 'notifications' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Where to send call recaps. You get a concise summary after each call so you never miss anything.'
        ),
        React.createElement(SettingField, {
          label: 'Recap email',
          description: 'Email address for call recaps.',
          value: val('notifications')?.email_to || '',
          onSave: v => saveSetting('notifications', { ...val('notifications'), email_to: v }),
          saving: saving === 'notifications'
        }),
        React.createElement(SettingField, {
          label: 'Recap SMS number',
          description: 'Phone number for SMS recaps.',
          value: val('notifications')?.sms_to || '',
          onSave: v => saveSetting('notifications', { ...val('notifications'), sms_to: v }),
          saving: saving === 'notifications'
        }),
        React.createElement('div', { className: 'flex gap-6 mt-4' },
          React.createElement('label', { className: 'flex items-center gap-2' },
            React.createElement('input', {
              type: 'checkbox', checked: val('notifications')?.email_enabled ?? true,
              onChange: e => saveSetting('notifications', { ...val('notifications'), email_enabled: e.target.checked })
            }),
            'Email recaps'
          ),
          React.createElement('label', { className: 'flex items-center gap-2' },
            React.createElement('input', {
              type: 'checkbox', checked: val('notifications')?.sms_enabled ?? true,
              onChange: e => saveSetting('notifications', { ...val('notifications'), sms_enabled: e.target.checked })
            }),
            'SMS recaps'
          )
        )
      ),

      // AI BEHAVIOR
      activeTab === 'ai' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'How the assistant speaks and handles edge cases.'
        ),
        React.createElement(SettingTextarea, {
          label: 'Personality & style',
          description: 'How the assistant should sound on calls. E.g., "Warm, brief, professional. Never over-apologize."',
          value: val('ai_personality')?.style || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), style: v }),
          saving: saving === 'ai_personality'
        }),
        React.createElement(SettingField, {
          label: 'After-hours message',
          description: 'What the assistant says if someone calls outside your typical hours and asks to reach you directly.',
          value: val('ai_personality')?.after_hours_message || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), after_hours_message: v }),
          saving: saving === 'ai_personality'
        }),
        React.createElement(SettingField, {
          label: 'Transfer number (optional)',
          description: 'If you want the assistant to transfer urgent calls to a human, put that number here.',
          value: typeof val('transfer_number') === 'string' ? val('transfer_number') : '',
          onSave: v => saveSetting('transfer_number', v),
          saving: saving === 'transfer_number'
        })
      ),

      // TEST MODE
      activeTab === 'test' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'While test mode is on, only the test number reaches your assistant. Every other caller hears a short temporary message.'
        ),
        React.createElement('label', { className: 'flex items-center gap-2 mb-4' },
          React.createElement('input', {
            type: 'checkbox', checked: val('test_mode')?.enabled ?? false,
            onChange: e => saveSetting('test_mode', { ...val('test_mode'), enabled: e.target.checked })
          }),
          React.createElement('span', { className: 'font-medium' }, 'Enable test mode')
        ),
        React.createElement(SettingField, {
          label: 'Test phone number',
          description: 'Only this number reaches the assistant while test mode is on.',
          value: val('test_mode')?.test_phone || '',
          onSave: v => saveSetting('test_mode', { ...val('test_mode'), test_phone: v }),
          saving: saving === 'test_mode'
        })
      )
    )
  );
}

// Restaurant Settings page.
//
// Mirrors the layout of SettingsPage but replaces every golf-specific tab
// (Daily ops, Course Info, Knowledge, Pricing) with restaurant-shaped
// content (Restaurant Info, Hours, Menu, Reservations). Greetings, Prompt,
// Notifications, AI Behavior, and Test Mode are universally applicable
// and reused unchanged. Shares the same /api/settings KV store +
// PhoneNumbersManager + greetings endpoints as the golf SettingsPage —
// only the UI surface is template-specific. Stored under settings keys:
//   restaurant_info        — name, cuisine, address, capacity, etc.
//   business_hours         — same shape golf already uses (per-day open/close)
//   menu                   — string (URL or short text)
//   reservation_policy     — { max_party_size, advance_days, requires_deposit, deposit_amount, cancellation_policy }
function RestaurantSettingsPage() {
  const [settings, setSettings] = useState({});
  const [greetings, setGreetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [newGreeting, setNewGreeting] = useState('');
  const [newGreetingKnown, setNewGreetingKnown] = useState(false);
  const [activeTab, setActiveTab] = useState('info');

  useEffect(() => {
    Promise.all([
      api('/api/settings').catch(() => ({})),
      api('/api/greetings').catch(() => [])
    ]).then(([s, g]) => { setSettings(s || {}); setGreetings(Array.isArray(g) ? g : []); })
      .catch(console.error).finally(() => setLoading(false));
  }, []);

  const saveSetting = async (key, value) => {
    setSaving(key);
    try {
      await api(`/api/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
      setSettings(prev => ({ ...prev, [key]: { ...prev[key], value } }));
    } catch (err) { alert('Failed to save: ' + err.message); }
    finally { setSaving(''); }
  };

  const addGreeting = async () => {
    if (!newGreeting.trim()) return;
    try {
      const g = await api('/api/greetings', { method: 'POST', body: JSON.stringify({ message: newGreeting, for_known_caller: newGreetingKnown }) });
      setGreetings(prev => [...prev, g]);
      setNewGreeting('');
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const deleteGreeting = async (id) => {
    try {
      await api(`/api/greetings/${id}`, { method: 'DELETE' });
      setGreetings(prev => prev.filter(g => g.id !== id));
    } catch (err) { alert('Failed: ' + err.message); }
  };

  if (loading) return React.createElement('div', { className: 'p-8 text-gray-500' }, 'Loading settings\u2026');

  const tabs = [
    { id: 'info',          label: '\uD83C\uDF7D\uFE0F Restaurant Info' },
    { id: 'hours',         label: '\uD83D\uDD52 Hours' },
    { id: 'menu',          label: '\uD83D\uDCCB Menu' },
    { id: 'reservations',  label: '\uD83D\uDCC5 Reservations' },
    { id: 'phones',        label: '\uD83D\uDCDE Phones' },
    { id: 'team',          label: '\uD83D\uDC65 Team' },
    { id: 'users',         label: '\uD83D\uDD11 Users' },
    { id: 'greetings',     label: 'Greetings' },
    { id: 'prompt',        label: 'Prompt' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'ai',            label: 'AI Behavior' },
    { id: 'test',          label: 'Test Mode' }
  ];

  const val = (key) => settings[key]?.value;

  return React.createElement('div', null,
    React.createElement('h1', { className: 'text-2xl font-bold text-gray-800 mb-2' }, 'Settings'),
    React.createElement('p', { className: 'text-sm text-gray-500 mb-6' },
      'Configure how your AI host answers calls, takes reservations, and answers menu / hours questions.'
    ),

    React.createElement('div', { className: 'flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 overflow-x-auto' },
      tabs.map(t =>
        React.createElement('button', {
          key: t.id, onClick: () => setActiveTab(t.id),
          className: `px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${activeTab === t.id ? 'bg-white shadow text-golf-700' : 'text-gray-500 hover:text-gray-700'}`
        }, t.label)
      )
    ),

    React.createElement('div', { className: 'bg-white rounded-xl shadow-sm border p-6' },

      // RESTAURANT INFO
      activeTab === 'info' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Basic restaurant information. The AI uses these on every call so callers always hear consistent details.'
        ),
        (() => {
          const info = val('restaurant_info') || {};
          const update = (field, value) => saveSetting('restaurant_info', { ...info, [field]: value });
          return React.createElement('div', null,
            React.createElement(SettingField, { label: 'Restaurant Name', value: info.name || '', onSave: v => update('name', v), saving: saving === 'restaurant_info' }),
            React.createElement(SettingField, { label: 'Cuisine', description: 'E.g., Italian, Japanese, Modern Canadian, Steakhouse', value: info.cuisine || '', onSave: v => update('cuisine', v), saving: saving === 'restaurant_info' }),
            React.createElement(SettingField, { label: 'Address', value: info.address || '', onSave: v => update('address', v), saving: saving === 'restaurant_info' }),
            React.createElement(SettingField, { label: 'Phone', description: 'E.g., (905) 555-1234', value: info.phone || '', onSave: v => update('phone', v), saving: saving === 'restaurant_info' }),
            React.createElement(SettingField, { label: 'Email', value: info.email || '', onSave: v => update('email', v), saving: saving === 'restaurant_info' }),
            React.createElement(SettingField, { label: 'Website', value: info.website || '', onSave: v => update('website', v), saving: saving === 'restaurant_info' }),
            React.createElement(SettingField, { label: 'Capacity', type: 'number', description: 'Total seats. Helps the AI judge whether large parties can be accommodated.', value: String(info.capacity || ''), onSave: v => update('capacity', parseInt(v) || null), saving: saving === 'restaurant_info' }),
            React.createElement(SettingField, { label: 'Dress Code', description: 'E.g., Smart casual, Business casual, Formal', value: info.dress_code || '', onSave: v => update('dress_code', v), saving: saving === 'restaurant_info' }),
            React.createElement(SettingField, { label: 'Parking', description: 'E.g., Valet available, Street parking, Lot beside building', value: info.parking || '', onSave: v => update('parking', v), saving: saving === 'restaurant_info' }),
            React.createElement(SettingTextarea, { label: 'Description', description: 'A short pitch the AI can use when callers ask "what kind of place is it?"', rows: 3, value: info.description || '', onSave: v => update('description', v), saving: saving === 'restaurant_info' })
          );
        })()
      ),

      // HOURS — reuses the shared business_hours setting golf already uses.
      // No template-specific naming — the AI prompt already reads
      // business_hours generically.
      activeTab === 'hours' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' }, 'Set hours for each day. The AI uses these to tell callers when you\u2019re open and to refuse reservations outside service.'),
        ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day => {
          const h = val('business_hours')?.[day] || { open: '17:00', close: '22:00' };
          return React.createElement('div', { key: day, className: 'flex items-center gap-4 mb-3' },
            React.createElement('span', { className: 'w-24 font-medium capitalize' }, day),
            React.createElement('input', { type: 'time', value: h.open, className: 'border rounded px-2 py-1',
              onChange: e => {
                const updated = { ...val('business_hours'), [day]: { ...h, open: e.target.value } };
                saveSetting('business_hours', updated);
              }
            }),
            React.createElement('span', { className: 'text-gray-400' }, 'to'),
            React.createElement('input', { type: 'time', value: h.close, className: 'border rounded px-2 py-1',
              onChange: e => {
                const updated = { ...val('business_hours'), [day]: { ...h, close: e.target.value } };
                saveSetting('business_hours', updated);
              }
            })
          );
        })
      ),

      // MENU
      activeTab === 'menu' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Where the AI gets menu information when callers ask about dishes, prices, or dietary options. Either link to your online menu or paste a short summary.'
        ),
        React.createElement(SettingField, {
          label: 'Menu URL',
          description: 'Link to a publicly viewable menu (PDF, restaurant website, etc.). The AI will mention this if asked for the full menu.',
          value: val('menu')?.url || '',
          onSave: v => saveSetting('menu', { ...val('menu'), url: v }),
          saving: saving === 'menu'
        }),
        React.createElement(SettingTextarea, {
          label: 'Highlights',
          description: 'A short summary of signature dishes, dietary options, and price range. Keep it under ~10 lines.',
          rows: 8,
          value: val('menu')?.highlights || '',
          onSave: v => saveSetting('menu', { ...val('menu'), highlights: v }),
          saving: saving === 'menu'
        })
      ),

      // RESERVATIONS
      activeTab === 'reservations' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Rules the AI follows when callers want to book a table.'
        ),
        (() => {
          const policy = val('reservation_policy') || {};
          const update = (field, value) => saveSetting('reservation_policy', { ...policy, [field]: value });
          return React.createElement('div', null,
            React.createElement(SettingField, {
              label: 'Maximum party size for AI booking',
              type: 'number',
              description: 'Parties larger than this get transferred to a human (or an offer to call back).',
              value: String(policy.max_party_size || 8),
              onSave: v => update('max_party_size', parseInt(v) || 8),
              saving: saving === 'reservation_policy'
            }),
            React.createElement(SettingField, {
              label: 'Advance booking window (days)',
              type: 'number',
              description: 'How far ahead callers can book. E.g., 30 = up to a month out.',
              value: String(policy.advance_days || 30),
              onSave: v => update('advance_days', parseInt(v) || 30),
              saving: saving === 'reservation_policy'
            }),
            React.createElement('label', { className: 'flex items-center gap-2 my-3' },
              React.createElement('input', {
                type: 'checkbox',
                checked: !!policy.requires_deposit,
                onChange: e => update('requires_deposit', e.target.checked)
              }),
              React.createElement('span', { className: 'text-sm font-medium' }, 'Require deposit for large parties')
            ),
            policy.requires_deposit && React.createElement(SettingField, {
              label: 'Deposit amount per seat',
              type: 'number',
              description: 'In your local currency. The AI mentions this when quoting policy.',
              value: String(policy.deposit_amount || ''),
              onSave: v => update('deposit_amount', parseFloat(v) || 0),
              saving: saving === 'reservation_policy'
            }),
            React.createElement(SettingTextarea, {
              label: 'Cancellation policy',
              description: 'E.g., "Cancel up to 24h before with no fee. Same-day no-shows charged $25/seat."',
              rows: 3,
              value: policy.cancellation_policy || '',
              onSave: v => update('cancellation_policy', v),
              saving: saving === 'reservation_policy'
            })
          );
        })()
      ),

      // PHONES — reused from PersonalSettingsPage / SettingsPage.
      activeTab === 'phones' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'The phone numbers your AI host answers. Disable a number to stop taking calls on it without losing history.'
        ),
        React.createElement(PhoneNumbersManager, {
          endpointBase: '/api/phone-numbers',
          title: 'Restaurant Phone Numbers'
        })
      ),

      // TEAM
      activeTab === 'team' && React.createElement(TeamDirectoryManager, null),

      // USERS — login accounts for this tenant. Same component
      // as the super-admin Edit Tenant modal; with no businessId
      // prop it defaults to the self-service /api/users endpoints.
      activeTab === 'users' && React.createElement(TenantUsersPanel, null),

      // GREETINGS — same KV store as golf / personal so behaviour is identical.
      activeTab === 'greetings' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'The AI picks a random greeting each time. Use {name} as a placeholder so returning callers hear their own name.'
        ),

        React.createElement('h3', { className: 'font-semibold mb-2' }, 'New caller greetings'),
        greetings.filter(g => !g.for_known_caller).length === 0
          ? React.createElement('p', { className: 'text-sm text-gray-400 mb-3' }, 'No new-caller greetings yet.')
          : greetings.filter(g => !g.for_known_caller).map(g =>
              React.createElement('div', { key: g.id, className: 'flex items-center gap-2 mb-2 bg-gray-50 rounded-lg p-3' },
                React.createElement('span', { className: 'flex-1 text-sm' }, g.message),
                React.createElement('button', { onClick: () => deleteGreeting(g.id), className: 'text-red-400 hover:text-red-600 text-sm' }, 'Remove')
              )
            ),

        React.createElement('h3', { className: 'font-semibold mb-2 mt-4' }, 'Returning caller greetings'),
        greetings.filter(g => g.for_known_caller).length === 0
          ? React.createElement('p', { className: 'text-sm text-gray-400 mb-3' }, 'No returning-caller greetings yet.')
          : greetings.filter(g => g.for_known_caller).map(g =>
              React.createElement('div', { key: g.id, className: 'flex items-center gap-2 mb-2 bg-green-50 rounded-lg p-3' },
                React.createElement('span', { className: 'flex-1 text-sm' }, g.message),
                React.createElement('button', { onClick: () => deleteGreeting(g.id), className: 'text-red-400 hover:text-red-600 text-sm' }, 'Remove')
              )
            ),

        React.createElement('div', { className: 'mt-4 border-t pt-4' },
          React.createElement('h3', { className: 'font-semibold mb-2' }, 'Add a greeting'),
          React.createElement('input', {
            type: 'text', value: newGreeting, onChange: e => setNewGreeting(e.target.value),
            placeholder: 'e.g., Thanks for calling {restaurant}, how can I help?',
            className: 'w-full border rounded-lg px-3 py-2 mb-2 text-sm'
          }),
          React.createElement('div', { className: 'flex items-center gap-4' },
            React.createElement('label', { className: 'flex items-center gap-2 text-sm' },
              React.createElement('input', { type: 'checkbox', checked: newGreetingKnown, onChange: e => setNewGreetingKnown(e.target.checked) }),
              'For returning callers (use {name} placeholder)'
            ),
            React.createElement('button', { onClick: addGreeting, className: 'bg-golf-600 hover:bg-golf-700 text-white px-4 py-2 rounded-lg text-sm' }, 'Add greeting')
          )
        )
      ),

      // PROMPT — restaurant-specific defaults; same custom_prompt key as
      // golf/personal so the prompt dispatcher reads it identically.
      activeTab === 'prompt' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Fine-tune how the AI host behaves. These instructions are layered on top of the built-in restaurant prompt.'
        ),
        React.createElement(SettingField, {
          label: 'Host name',
          description: 'The name the AI uses when answering ("Hi, I\u2019m Sam at Bella Notte\u2026").',
          value: val('ai_personality')?.name || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), name: v }),
          saving: saving === 'ai_personality'
        }),
        React.createElement(SettingField, {
          label: 'Language handling',
          description: 'How the AI decides which language to respond in. E.g., "Match the caller\u2019s language; default to English."',
          value: val('ai_personality')?.language || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), language: v }),
          saving: saving === 'ai_personality'
        }),
        React.createElement(SettingTextarea, {
          label: 'Custom prompt additions',
          description: 'Extra instructions for the AI. Keep it short and specific \u2014 e.g., "Always mention happy hour 4-6pm Mon\u2013Thu" or "Tasting menu requires booking 48h ahead."',
          value: val('custom_prompt') || '',
          rows: 10,
          onSave: v => saveSetting('custom_prompt', v),
          saving: saving === 'custom_prompt'
        })
      ),

      // NOTIFICATIONS
      activeTab === 'notifications' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'Where to send call recaps and reservation alerts.'
        ),
        React.createElement(SettingField, {
          label: 'Recap email',
          description: 'Email address for call recaps and reservation confirmations.',
          value: val('notifications')?.email_to || '',
          onSave: v => saveSetting('notifications', { ...val('notifications'), email_to: v }),
          saving: saving === 'notifications'
        }),
        React.createElement(SettingField, {
          label: 'Recap SMS number',
          description: 'Phone number for SMS recaps. Useful for the host stand.',
          value: val('notifications')?.sms_to || '',
          onSave: v => saveSetting('notifications', { ...val('notifications'), sms_to: v }),
          saving: saving === 'notifications'
        }),
        React.createElement('div', { className: 'flex gap-6 mt-4' },
          React.createElement('label', { className: 'flex items-center gap-2' },
            React.createElement('input', {
              type: 'checkbox', checked: val('notifications')?.email_enabled ?? true,
              onChange: e => saveSetting('notifications', { ...val('notifications'), email_enabled: e.target.checked })
            }),
            'Email recaps'
          ),
          React.createElement('label', { className: 'flex items-center gap-2' },
            React.createElement('input', {
              type: 'checkbox', checked: val('notifications')?.sms_enabled ?? true,
              onChange: e => saveSetting('notifications', { ...val('notifications'), sms_enabled: e.target.checked })
            }),
            'SMS recaps'
          )
        )
      ),

      // AI BEHAVIOR
      activeTab === 'ai' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'How the AI host speaks and handles edge cases.'
        ),
        React.createElement(SettingTextarea, {
          label: 'Personality & style',
          description: 'How the host should sound on calls. E.g., "Warm, brief, professional. Never push specials. Friendly but efficient."',
          value: val('ai_personality')?.style || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), style: v }),
          saving: saving === 'ai_personality'
        }),
        React.createElement(SettingField, {
          label: 'After-hours message',
          description: 'What the AI says if someone calls outside service hours.',
          value: val('ai_personality')?.after_hours_message || '',
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), after_hours_message: v }),
          saving: saving === 'ai_personality'
        }),
        React.createElement(SettingField, {
          label: 'Transfer number (optional)',
          description: 'If the AI should transfer urgent calls (e.g. large parties, complaints) to a human, put that number here.',
          value: typeof val('transfer_number') === 'string' ? val('transfer_number') : '',
          onSave: v => saveSetting('transfer_number', v),
          saving: saving === 'transfer_number'
        })
      ),

      // TEST MODE
      activeTab === 'test' && React.createElement('div', null,
        React.createElement('p', { className: 'text-sm text-gray-500 mb-4' },
          'While test mode is on, only the test number reaches the AI host. Every other caller hears a short temporary message.'
        ),
        React.createElement('label', { className: 'flex items-center gap-2 mb-4' },
          React.createElement('input', {
            type: 'checkbox', checked: val('test_mode')?.enabled ?? false,
            onChange: e => saveSetting('test_mode', { ...val('test_mode'), enabled: e.target.checked })
          }),
          React.createElement('span', { className: 'font-medium' }, 'Enable test mode')
        ),
        React.createElement(SettingField, {
          label: 'Test phone number',
          description: 'Only this number reaches the AI host while test mode is on.',
          value: val('test_mode')?.test_phone || '',
          onSave: v => saveSetting('test_mode', { ...val('test_mode'), test_phone: v }),
          saving: saving === 'test_mode'
        })
      )
    )
  );
}

// Shared golf page map — used by the plan='legacy' safety lock and by
// the regular golf_course / driving_range path so dispatch stays in
// lockstep with the sidebar.
const GOLF_PAGES = {
  dashboard: DashboardPage,
  teesheet:  TeeSheetPage,
  bookings:  BookingsPage,
  customers: CustomersPage,
  calls:     CallLogsPage,
  settings:  SettingsPage
};

// Page router per template. Always falls back to the existing golf maps so
// unknown keys keep working — we never want a wiring bug here to black-hole
// Valleymede's UI. `plan='legacy'` short-circuits to the golf map so
// Valleymede keeps Tee Sheet + Bookings even if template_key drifts.
function tenantPagesFor(templateKey, plan) {
  if (plan === 'legacy') return GOLF_PAGES;

  if (templateKey === 'personal_assistant') {
    return {
      dashboard: PersonalAssistantPage,
      messages:  MessagesPage,
      calls:     CallLogsPage,
      my_info:   MyInfoPage,
      settings:  PersonalSettingsPage
    };
  }
  // Business switchboard template — purpose-built for team message-taking.
  // Reuses the generic DashboardPage for the call-summary tile and CallLogsPage
  // for the call history. Settings reuses the personal-assistant Settings page
  // because both templates share the same setting keys (no booking_settings,
  // pricing, etc). The Messages tab is the heart — it shows every message the
  // AI has taken, with delivery status per row.
  if (templateKey === 'business') {
    return {
      dashboard: DashboardPage,
      messages:  MessagesPage,
      calls:     CallLogsPage,
      settings:  PersonalSettingsPage
    };
  }
  // Restaurant — uses the shared dashboard / customers / call-logs pages
  // until a dedicated restaurant dashboard ships, but gets a vertical-
  // specific Settings page (Restaurant Info / Hours / Menu / Reservations
  // instead of golf's Course Info / Pricing). Reservations is wired to the
  // existing BookingsPage because the underlying `bookings` table is shared.
  if (templateKey === 'restaurant') {
    return {
      dashboard:    DashboardPage,
      reservations: BookingsPage,
      customers:    CustomersPage,
      calls:        CallLogsPage,
      settings:     RestaurantSettingsPage
    };
  }
  // Golf (also the implicit default) — keep Valleymede's shape exactly.
  if (templateKey === 'golf_course' || templateKey === 'driving_range' || !templateKey) {
    return GOLF_PAGES;
  }
  // Minimal "other" baseline until Phase 7 adds dedicated verticals.
  return {
    dashboard: DashboardPage,
    calls:     CallLogsPage,
    customers: CustomersPage,
    settings:  SettingsPage
  };
}

// ============================================
// MAIN APP
// ============================================
function App() {
  // If the URL path is /accept-invite, short-circuit to the public page
  // BEFORE we look at auth state — the invitee has no session yet.
  if (typeof window !== 'undefined' && window.location.pathname === '/accept-invite') {
    return React.createElement(AcceptInvitePage);
  }

  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [session, setSessionState] = useState(() => getSession());
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [selectedBusinessId, setSelectedBusinessIdState] = useState(() => getSelectedBusinessId());
  const [businesses, setBusinesses] = useState([]);

  // ─── Brand color theming ──────────────────────────────────────────────
  // Reflect each tenant's wizard-picked primary_color across the UI.
  // - Tenant users: always use their own tenant's color (session blob).
  // - Super admins: use the color of the business they're acting-as
  //   (looked up from the loaded business list); null when no act-as.
  // - Unset color (Valleymede, generic-template tenants): null →
  //   applyBrand() removes the override so the original golf palette wins.
  //
  // Race note: super-admin's businesses[] is empty until /api/super/
  // businesses resolves on first paint. If we called applyBrand
  // unconditionally we'd briefly apply null (default green) then flip
  // to the brand color — a visible flash. So skip the call when
  // selectedBusinessId is set but the list hasn't loaded yet.
  useEffect(() => {
    let color = null;
    let skip = false;
    if (session?.role === 'super_admin') {
      if (selectedBusinessId) {
        if (businesses.length === 0) {
          // Still loading — don't flash. The next render (after the list
          // arrives) will set the real color.
          skip = true;
        } else {
          const biz = businesses.find(b => b.id === selectedBusinessId);
          color = biz?.primary_color || null;
        }
      }
    } else if (session) {
      color = session.primary_color || null;
    }
    if (!skip) applyBrand(color);
  }, [session, selectedBusinessId, businesses]);

  // On mount, rehydrate the session from /auth/verify if we have a token
  // but no saved session blob (e.g. upgrading from a pre-Phase-3 login).
  useEffect(() => {
    if (authenticated && !session) {
      api('/auth/verify')
        .then(d => {
          const s = {
            role: d.user.role,
            business_id: d.user.business_id,
            // /auth/verify now echoes the tenant's template_key + plan +
            // name so the sidebar and page router can branch without a
            // second network round-trip on first render. `plan` is the
            // Valleymede-safety lock: legacy tenants always get the full
            // golf sidebar regardless of template_key drift (see
            // sidebarItemsFor / tenantPagesFor).
            business_name: d.user.business_name || null,
            template_key: d.user.template_key || null,
            plan: d.user.plan || null,
            primary_color: d.user.primary_color || null,
            username: d.user.username
          };
          setSession(s);
          setSessionState(s);
          if (s.role !== 'super_admin') {
            setSelectedBusinessId(s.business_id);
            setSelectedBusinessIdState(s.business_id);
          }
        })
        .catch(() => {
          clearAuth();
          setAuthenticated(false);
        });
    }
  }, [authenticated, session]);

  // Super admins load the full business list so the switcher works.
  const refreshBusinessList = useCallback(() => {
    if (!authenticated || session?.role !== 'super_admin') return Promise.resolve([]);
    return api('/api/super/businesses')
      .then(d => {
        const list = d.businesses || [];
        setBusinesses(list);
        return list;
      })
      .catch(() => {
        setBusinesses([]);
        return [];
      });
  }, [authenticated, session?.role]);

  useEffect(() => {
    refreshBusinessList();
  }, [refreshBusinessList]);

  // ─── Live updates via Server-Sent Events ──────────────────────────────
  // One persistent connection to /api/events per signed-in tab. The
  // server pushes booking/modification events as they happen; we
  // re-broadcast them as a window event so individual pages can refetch
  // their data without a page reload. Tab visibility is irrelevant —
  // EventSource keeps the stream alive in the background and
  // auto-reconnects on drop. Auth is via ?token= because EventSource
  // can't set custom headers in browsers (requireAuth accepts both).
  // Super-admins viewing their own dashboard (no selected tenant) skip
  // the connection — there's no per-tenant stream to attach to.
  useEffect(() => {
    if (!authenticated || !session) return undefined;
    if (session.role === 'super_admin' && !selectedBusinessId) return undefined;
    const token = getToken();
    if (!token) return undefined;

    // EventSource doesn't support custom headers, so we attach the JWT
    // to the URL. Header takes precedence in requireAuth, so a future
    // header-aware EventSource polyfill would also work.
    const headers = {};
    if (selectedBusinessId) headers['X-Business-Id'] = String(selectedBusinessId);
    const url = `/api/events?token=${encodeURIComponent(token)}` +
      (selectedBusinessId ? `&business_id=${encodeURIComponent(selectedBusinessId)}` : '');
    const es = new EventSource(url);

    const dispatch = (eventName, raw) => {
      let data = null;
      try { data = JSON.parse(raw); } catch (_) { data = null; }
      window.dispatchEvent(new CustomEvent('cmdcenter:refresh', {
        detail: { type: eventName, data }
      }));
    };
    es.addEventListener('booking.created',      e => dispatch('booking.created', e.data));
    es.addEventListener('booking.updated',      e => dispatch('booking.updated', e.data));
    es.addEventListener('modification.created', e => dispatch('modification.created', e.data));
    es.addEventListener('modification.updated', e => dispatch('modification.updated', e.data));
    es.addEventListener('ready',                e => dispatch('ready', e.data));

    es.onerror = (err) => {
      // EventSource auto-reconnects; just log so we don't lose visibility.
      console.warn('[live] SSE connection error — browser will retry.', err);
    };
    return () => es.close();
  }, [authenticated, session, selectedBusinessId]);

  const handleLogin = (data) => {
    setSessionState({
      role: data.role,
      business_id: data.business_id,
      business_name: data.business_name || null,
      template_key: data.template_key || null,
      // `plan` drives the legacy-tenant safety lock in sidebarItemsFor /
      // tenantPagesFor — Valleymede (plan='legacy') always keeps the full
      // golf sidebar even if template_key drifts.
      plan: data.plan || null,
      // primary_color drives the brand color CSS variable applied at
      // <html>. Null means "use the golf-green default" — same as
      // Valleymede's experience.
      primary_color: data.primary_color || null,
      username: data.username,
      name: data.name
    });
    setSelectedBusinessIdState(data.role === 'super_admin' ? null : data.business_id);
    setAuthenticated(true);
  };

  const handleLogout = () => {
    clearAuth();
    setSessionState(null);
    setSelectedBusinessIdState(null);
    setAuthenticated(false);
  };

  // `businessHint` (optional) — the freshly-created business object handed
  // back from the onboarding wizard. Without it, a super-admin clicking
  // "Act as" on a brand-new tenant would hit a cache miss (the background
  // refreshBusinessList() hasn't completed yet), `actingBusiness` would
  // resolve to {}, effectiveTemplateKey would fall through to null, and
  // the UI would render the null-fallback golf dashboard instead of the
  // personal_assistant / restaurant / etc. pages the tenant should see.
  // Merging the hint into the cache *before* setSelectedBusinessId closes
  // that race so the first render already knows template_key + plan.
  const handleSelectBusiness = (id, businessHint = null) => {
    if (businessHint && businessHint.id === id) {
      setBusinesses(prev =>
        prev.some(b => b.id === id) ? prev : [...prev, businessHint]
      );
    }
    setSelectedBusinessId(id);
    setSelectedBusinessIdState(id);
    setCurrentPage(id ? 'dashboard' : 'super');
  };

  if (!authenticated) {
    return React.createElement(LoginPage, { onLogin: handleLogin });
  }
  // Waiting for verify on a bare token
  if (!session) {
    return React.createElement('div', { className: 'min-h-screen flex items-center justify-center text-gray-500' }, 'Loading\u2026');
  }

  const isSuper = session.role === 'super_admin';

  // Template + plan resolution — tenant users get it from their JWT-issued
  // session blob (populated by /auth/verify + /auth/login). Super-admins
  // acting-as another business pick it up from the cached business list,
  // because their JWT's template_key belongs to *their own* row (if any),
  // not the tenant they're impersonating. `plan` is the safety lock for
  // legacy (Valleymede) — sidebarItemsFor / tenantPagesFor force the full
  // golf shape whenever plan='legacy', regardless of template_key drift.
  const actingBusiness = isSuper
    ? (businesses.find(b => b.id === selectedBusinessId) || {})
    : {};
  const effectiveTemplateKey = isSuper
    ? actingBusiness.template_key || null
    : session.template_key || null;
  const effectivePlan = isSuper
    ? actingBusiness.plan || null
    : session.plan || null;

  const tenantPages = tenantPagesFor(effectiveTemplateKey, effectivePlan);

  // Super admin with no selected business → platform dashboard only.
  if (isSuper && !selectedBusinessId) {
    return React.createElement('div', { className: 'flex flex-col min-h-screen bg-gray-50' },
      React.createElement(TopBar, {
        session, businesses,
        selectedBusinessId,
        onSelectBusiness: handleSelectBusiness,
        onLogout: handleLogout
      }),
      React.createElement('main', { className: 'flex-1 p-8 overflow-auto' },
        React.createElement(SuperAdminDashboard, {
          onSwitchInto: handleSelectBusiness,
          // When the wizard finishes, pull the fresh business list so the
          // TopBar's BusinessSwitcher includes the new tenant immediately.
          onBusinessCreated: () => refreshBusinessList()
        })
      )
    );
  }

  // Tenant user OR super admin acting as a tenant → regular sidebar + page.
  const PageComponent = tenantPages[currentPage] || DashboardPage;
  // Pick the right "where to take the operator when a toast is clicked"
  // target — bookings for golf/restaurant verticals, calls for the
  // personal_assistant template (which doesn't have a bookings page).
  const toastNavTarget =
    effectiveTemplateKey === 'personal_assistant' ? 'calls'
    : (effectiveTemplateKey === 'restaurant' ? 'reservations' : 'bookings');
  return React.createElement('div', { className: 'flex flex-col min-h-screen' },
    React.createElement(TopBar, {
      session, businesses,
      selectedBusinessId,
      onSelectBusiness: handleSelectBusiness,
      onLogout: handleLogout
    }),
    React.createElement('div', { className: 'flex flex-1' },
      React.createElement(Sidebar, {
        currentPage,
        onNavigate: setCurrentPage,
        onLogout: handleLogout,
        // Show the active tenant's display name in the sidebar header so
        // a super-admin "acting-as" another business always sees whose
        // data they're looking at. Falls back to generic text when the
        // lookup hasn't resolved yet (first render after act-as).
        tenantName: (businesses.find(b => b.id === selectedBusinessId) || {}).name
          || session.business_name,
        templateKey: effectiveTemplateKey,
        plan: effectivePlan
      }),
      React.createElement('main', { className: 'flex-1 p-8 overflow-auto bg-gray-50' },
        React.createElement(PageComponent)
      )
    ),
    // Live toast notifications + sound/desktop-alert controls. Mounted
    // here (not inside <main>) so the toasts are positioned relative to
    // the viewport and stay visible regardless of which page is active.
    React.createElement(Toaster, { onNavigate: () => setCurrentPage(toastNavTarget) })
  );
}

// Mount the app
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(App));
