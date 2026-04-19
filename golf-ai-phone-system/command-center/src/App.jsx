import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// ============================================
// API Helper
// ============================================
const API_BASE = '';

function getToken() {
  return localStorage.getItem('gc_token');
}

async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  if (res.status === 401) {
    localStorage.removeItem('gc_token');
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
        React.createElement('h1', { className: 'text-2xl font-bold text-gray-800' }, 'Valleymede Columbus'),
        React.createElement('p', { className: 'text-gray-500 mt-1' }, 'Command Center')
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
function Sidebar({ currentPage, onNavigate, onLogout }) {
  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '\ud83d\udcca' },
    { id: 'teesheet', label: 'Tee Sheet', icon: '\u26f3' },
    { id: 'bookings', label: 'Bookings', icon: '\ud83d\udcc5' },
    { id: 'customers', label: 'Customers', icon: '\ud83d\udc65' },
    { id: 'calls', label: 'Call Logs', icon: '\ud83d\udcde' },
    { id: 'settings', label: 'Settings', icon: '\u2699\ufe0f' }
  ];

  return React.createElement('aside', { className: 'w-64 bg-golf-800 text-white min-h-screen flex flex-col' },
    React.createElement('div', { className: 'p-6 border-b border-golf-700' },
      React.createElement('div', { className: 'text-2xl mb-1' }, '\u26f3'),
      React.createElement('h2', { className: 'font-bold text-lg' }, 'Valleymede'),
      React.createElement('p', { className: 'text-golf-200 text-sm' }, 'Command Center')
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/api/dashboard').then(setData).catch(console.error).finally(() => setLoading(false));
    const interval = setInterval(() => {
      api('/api/dashboard').then(setData).catch(console.error);
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
  const [filter, setFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [replyOpenId, setReplyOpenId] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [b, m] = await Promise.all([
        api(`/api/bookings?status=${filter}`),
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
      ['pending', 'confirmed', 'rejected', 'cancelled'].map(s =>
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
          ? React.createElement('p', { className: 'p-8 text-gray-400 text-center' }, `No ${filter} bookings`)
          : React.createElement('div', { className: 'divide-y' },
              bookings.map(b =>
                React.createElement('div', { key: b.id, className: 'border-b last:border-0' },
                  // Main booking row
                  React.createElement('div', { className: 'p-4 flex items-center justify-between hover:bg-gray-50' },
                    React.createElement('div', { className: 'flex-1' },
                      React.createElement('div', { className: 'flex items-center gap-3' },
                        React.createElement('span', { className: 'font-semibold' }, b.customer_name || 'Unknown'),
                        React.createElement('span', { className: `px-2 py-0.5 rounded-full text-xs ${statusColors[b.status] || ''}` }, b.status)
                      ),
                      React.createElement('div', { className: 'text-sm text-gray-600 font-medium mt-1' },
                        formatBookingDateTime(b.requested_date, b.requested_time)
                      ),
                      React.createElement('div', { className: 'text-sm text-gray-500 mt-1' },
                        `${b.party_size} player${b.party_size > 1 ? 's' : ''} \u2022 ${b.num_carts || 0} cart${b.num_carts !== 1 ? 's' : ''}`
                      ),
                      React.createElement('div', { className: 'text-sm text-gray-400' },
                        `${b.customer_phone || ''} ${b.customer_email ? '\u2022 ' + b.customer_email : ''}`
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
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'hours', label: 'Hours' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'greetings', label: 'Greetings' },
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
            placeholder: 'e.g., Hey there! Thanks for calling Valleymede Columbus...',
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
          onSave: v => saveSetting('ai_personality', { ...val('ai_personality'), after_hours_message: v }), saving: saving === 'ai_personality' })
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
// MAIN APP
// ============================================
function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [currentPage, setCurrentPage] = useState('dashboard');

  const handleLogout = () => {
    localStorage.removeItem('gc_token');
    setAuthenticated(false);
  };

  if (!authenticated) {
    return React.createElement(LoginPage, { onLogin: () => setAuthenticated(true) });
  }

  const pages = {
    dashboard: DashboardPage,
    teesheet: TeeSheetPage,
    bookings: BookingsPage,
    customers: CustomersPage,
    calls: CallLogsPage,
    settings: SettingsPage
  };

  const PageComponent = pages[currentPage] || DashboardPage;

  return React.createElement('div', { className: 'flex min-h-screen' },
    React.createElement(Sidebar, { currentPage, onNavigate: setCurrentPage, onLogout: handleLogout }),
    React.createElement('main', { className: 'flex-1 p-8 overflow-auto' },
      React.createElement(PageComponent)
    )
  );
}

// Mount the app
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(App));
