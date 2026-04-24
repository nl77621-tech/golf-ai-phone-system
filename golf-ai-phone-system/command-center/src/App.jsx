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
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ============================================
// LOGIN PAGE
// ============================================
function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
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

function sidebarItemsFor(templateKey) {
  if (templateKey === 'personal_assistant') {
    return [
      { id: 'dashboard', label: 'Personal Assistant', icon: '\ud83d\udc64' },
      { id: 'calls',     label: 'Call History',       icon: '\ud83d\udcde' },
      { id: 'my_info',   label: 'My Info',            icon: '\ud83d\udccb' },
      { id: 'settings',  label: 'Settings',           icon: '\u2699\ufe0f' }
    ];
  }
  // Golf-style (driving_range reuses this shape for now) — keep the exact
  // menu Valleymede has been running on.
  if (templateKey === 'golf_course' || templateKey === 'driving_range' || !templateKey) {
    return [
      { id: 'dashboard', label: 'Dashboard', icon: '\ud83d\udcca' },
      { id: 'teesheet',  label: 'Tee Sheet', icon: '\u26f3' },
      { id: 'bookings',  label: 'Bookings',  icon: '\ud83d\udcc5' },
      { id: 'customers', label: 'Customers', icon: '\ud83d\udc65' },
      { id: 'calls',     label: 'Call Logs', icon: '\ud83d\udcde' },
      { id: 'settings',  label: 'Settings',  icon: '\u2699\ufe0f' }
    ];
  }
  // Neutral baseline for "other" / "restaurant" until Phase 7. No
  // golf-specific pages are exposed, but the essentials (calls, settings)
  // are always available.
  return [
    { id: 'dashboard', label: 'Dashboard', icon: '\ud83d\udcca' },
    { id: 'calls',     label: 'Call Logs', icon: '\ud83d\udcde' },
    { id: 'customers', label: 'Customers', icon: '\ud83d\udc65' },
    { id: 'settings',  label: 'Settings',  icon: '\u2699\ufe0f' }
  ];
}

function Sidebar({ currentPage, onNavigate, onLogout, tenantName, templateKey }) {
  const menuItems = sidebarItemsFor(templateKey);

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
    Promise.all([
      api('/api/dashboard'),
      api('/api/analytics').catch(() => null)
    ]).then(([d, a]) => { setData(d); setAnalytics(a); })
      .catch(console.error)
      .finally(() => setLoading(false));
    const interval = setInterval(() => {
      api('/api/dashboard').then(setData).catch(console.error);
      api('/api/analytics').then(setAnalytics).catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
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

  useEffect(() => { loadData(); }, [loadData]);

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
                      React.createElement('div', { className: 'flex items-center gap-3' },
                        React.createElement('span', { className: 'font-semibold' }, b.customer_name || 'Unknown'),
                        React.createElement('span', { className: `px-2 py-0.5 rounded-full text-xs ${statusColors[b.status] || ''}` }, b.status),
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

  return React.createElement('div', null,
    // Header
    React.createElement('div', { className: 'mb-6' },
      React.createElement('h2', { className: 'text-xl font-bold text-gray-800 mb-1' }, '📋 Daily Instructions'),
      React.createElement('p', { className: 'text-sm text-gray-500' },
        'Set special instructions per day. The AI will proactively tell every caller — and can answer questions about upcoming days too.'
      )
    ),

    // Quick examples strip
    React.createElement('div', { className: 'mb-6 p-4 bg-gray-50 rounded-xl border' },
      React.createElement('p', { className: 'text-xs font-medium text-gray-500 mb-2' }, '⚡ Quick fill — click to copy to any day below:'),
      React.createElement('div', { className: 'flex flex-wrap gap-2' },
        EXAMPLES.map(ex => React.createElement('button', {
          key: ex,
          onClick: () => {
            const todayKey = toDateKey(0);
            updateLocal(todayKey, 'message', ex);
          },
          className: 'text-xs px-2.5 py-1 bg-white hover:bg-golf-50 hover:text-golf-700 border border-gray-200 rounded-lg transition-colors text-gray-600'
        }, ex))
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

  const loadBookings = () => {
    setLoading(true);
    api('/api/bookings?limit=200')
      .then((all) => { setBookings(all.bookings || []); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadBookings(); }, [selectedDate]);

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
        }, 'Today')
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
function BusinessCard({ business, onActAs, onManagePhones }) {
  return React.createElement('div', {
    className: 'bg-white rounded-xl shadow-sm border hover:shadow-md transition-shadow overflow-hidden flex flex-col'
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
          React.createElement(StatusPill, { status: business.status })
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
    React.createElement('div', { className: 'px-4 py-3 bg-gray-50 border-t flex items-center justify-between text-xs gap-3' },
      React.createElement('span', { className: 'text-gray-500 truncate' },
        business.plan ? `Plan: ${business.plan}` : 'Plan: —',
        business.setup_complete ? '' : ' \u2022 setup pending'
      ),
      React.createElement('div', { className: 'flex items-center gap-3 flex-shrink-0' },
        typeof onManagePhones === 'function' && React.createElement('button', {
          onClick: () => onManagePhones(business),
          className: 'text-gray-600 hover:text-gray-900 font-semibold'
        }, '\ud83d\udcde Phones'),
        React.createElement('button', {
          onClick: () => onActAs(business.id),
          className: 'text-golf-700 hover:text-golf-900 font-semibold'
        }, 'Act as \u2192')
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
// SUPER ADMIN DASHBOARD
// ============================================
// Cross-tenant overview for platform operators. Renders the business grid
// with quick-scan cards, global totals, live search, and launches the
// OnboardingWizard.
function SuperAdminDashboard({ onSwitchInto, onBusinessCreated }) {
  const [businesses, setBusinesses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showWizard, setShowWizard] = useState(false);
  const [lastCreated, setLastCreated] = useState(null);
  const [search, setSearch] = useState('');
  const [phoneModalBiz, setPhoneModalBiz] = useState(null);
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
    setShowWizard(false);
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
      React.createElement('button', {
        onClick: () => setShowWizard(true),
        className: 'bg-golf-600 hover:bg-golf-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold shadow-sm flex items-center gap-2'
      },
        React.createElement('span', { className: 'text-lg leading-none' }, '+'),
        React.createElement('span', null, 'New Business')
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
      React.createElement('button', {
        onClick: () => setShowWizard(true),
        className: 'bg-golf-600 hover:bg-golf-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold'
      }, 'Create first business')
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
            onManagePhones: setPhoneModalBiz
          })
        )
      )
    ),

    showWizard && React.createElement(OnboardingWizard, {
      onCancel: () => setShowWizard(false),
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

function OnboardingWizard({ onCancel, onCreated, onActAs }) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [result, setResult] = useState(null);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    contact_email: '',
    contact_phone: '',
    primary_color: '#2E7D32',
    logo_url: '',
    timezone: 'America/Toronto',
    plan: 'starter',
    twilio_phone_number: '',
    transfer_number: '',
    phone_numbers: [],              // [{ phone_number, label }]
    template_key: 'golf_course',
    admin_email: '',
    admin_name: '',
    // Personal Assistant-only: the voice-facing name of the assistant.
    // Harmless empty string for other templates — the backend ignores
    // assistant_name unless template_key === 'personal_assistant'.
    assistant_name: ''
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
  useEffect(() => {
    api('/api/super/templates')
      .then(d => {
        setTemplates(d.templates || []);
        if (d.default_template_key) set('template_key', d.default_template_key);
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
  }, []);

  const labelCls = 'block text-xs font-semibold text-gray-600 mb-1';
  const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-golf-500 focus:border-transparent outline-none';

  const steps = [
    { title: 'Business basics', sub: 'Name, contact, branding' },
    { title: 'Phone numbers',   sub: 'Route inbound calls + SMS' },
    { title: 'Choose template', sub: 'Pick a vertical to seed defaults' },
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
    if (step === 3) return true;
    if (step === 4) {
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
          assistant_name: (form.assistant_name || '').trim()
        })
      });
      setResult(resp);
      setStep(5);
    } catch (err) {
      setError(err.message || 'Failed to create business');
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
      React.createElement('label', { className: labelCls }, 'Business name *'),
      React.createElement('input', {
        className: inputCls, type: 'text', value: form.name,
        onChange: e => set('name', e.target.value),
        placeholder: 'e.g. Cedar Ridge Golf Club', autoFocus: true
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
      React.createElement('div', { className: 'px-6 py-4 border-t bg-gray-50 flex items-center justify-between' },
        step < 5
          ? React.createElement('button', {
              type: 'button',
              onClick: () => step === 0 ? onCancel() : setStep(step - 1),
              className: 'px-4 py-2 rounded-lg bg-white border border-gray-300 hover:bg-gray-100 text-sm font-medium text-gray-700'
            }, step === 0 ? 'Cancel' : 'Back')
          : React.createElement('span', null),
        step < 3 && React.createElement('button', {
          type: 'button',
          disabled: !canAdvance(),
          onClick: () => setStep(step + 1),
          className: 'px-5 py-2 rounded-lg bg-golf-600 hover:bg-golf-700 text-white text-sm font-semibold disabled:opacity-40'
        }, 'Next \u2192'),
        step === 3 && React.createElement('button', {
          type: 'button',
          onClick: () => setStep(4),
          className: 'px-5 py-2 rounded-lg bg-golf-600 hover:bg-golf-700 text-white text-sm font-semibold'
        }, 'Looks good \u2192'),
        // Step 4 footer: the operator either fills an admin_email and creates
        // with an invite, or explicitly skips the invite (with a clear hint).
        step === 4 && React.createElement('div', { className: 'flex items-center gap-2' },
          !form.admin_email.trim() && React.createElement('span', { className: 'text-[11px] text-gray-500' },
            'You can invite an admin later from the business card.'
          ),
          React.createElement('button', {
            type: 'button',
            disabled: saving || !canAdvance(),
            onClick: handleCreate,
            className: 'px-5 py-2 rounded-lg bg-golf-600 hover:bg-golf-700 text-white text-sm font-semibold disabled:opacity-50'
          }, saving
            ? 'Creating business\u2026'
            : (form.admin_email.trim()
                ? 'Create business + send invite'
                : 'Skip invite & create business')
          )
        ),
        // Step 5 footer: offer to switch into the new tenant or return to
        // the super-admin dashboard. The Act-as button is only visible if the
        // wizard was handed an onActAs handler (wired in SuperAdminDashboard).
        step === 5 && React.createElement('div', { className: 'flex items-center gap-2' },
          typeof onActAs === 'function' && result?.business?.id && React.createElement('button', {
            type: 'button',
            onClick: () => onActAs(result.business.id),
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

// Page router per template. Always falls back to the existing golf maps so
// unknown keys keep working — we never want a wiring bug here to black-hole
// Valleymede's UI.
function tenantPagesFor(templateKey) {
  if (templateKey === 'personal_assistant') {
    return {
      dashboard: PersonalAssistantPage,
      calls:     CallLogsPage,
      my_info:   MyInfoPage,
      settings:  SettingsPage
    };
  }
  // Golf (also the implicit default) — keep Valleymede's shape exactly.
  if (templateKey === 'golf_course' || templateKey === 'driving_range' || !templateKey) {
    return {
      dashboard: DashboardPage,
      teesheet:  TeeSheetPage,
      bookings:  BookingsPage,
      customers: CustomersPage,
      calls:     CallLogsPage,
      settings:  SettingsPage
    };
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

  // On mount, rehydrate the session from /auth/verify if we have a token
  // but no saved session blob (e.g. upgrading from a pre-Phase-3 login).
  useEffect(() => {
    if (authenticated && !session) {
      api('/auth/verify')
        .then(d => {
          const s = {
            role: d.user.role,
            business_id: d.user.business_id,
            // /auth/verify now echoes the tenant's template_key + name so
            // the sidebar and page router can branch without a second
            // network round-trip on first render.
            business_name: d.user.business_name || null,
            template_key: d.user.template_key || null,
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

  const handleLogin = (data) => {
    setSessionState({
      role: data.role,
      business_id: data.business_id,
      business_name: data.business_name || null,
      template_key: data.template_key || null,
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

  const handleSelectBusiness = (id) => {
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

  // Template resolution — tenant users get it from their JWT-issued session
  // blob (populated by /auth/verify + /auth/login). Super-admins acting-as
  // another business pick it up from the cached business list, because their
  // JWT's template_key belongs to *their own* row (if any), not the tenant
  // they're impersonating.
  const effectiveTemplateKey = isSuper
    ? (businesses.find(b => b.id === selectedBusinessId) || {}).template_key || null
    : session.template_key || null;

  const tenantPages = tenantPagesFor(effectiveTemplateKey);

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
        templateKey: effectiveTemplateKey
      }),
      React.createElement('main', { className: 'flex-1 p-8 overflow-auto bg-gray-50' },
        React.createElement(PageComponent)
      )
    )
  );
}

// Mount the app
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(App));
