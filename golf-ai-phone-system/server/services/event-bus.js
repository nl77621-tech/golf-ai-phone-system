/**
 * In-process tenant-scoped event bus.
 *
 * Booking-related events (created, updated, cancelled) are published here
 * by the service layer (booking-manager.js, modification flows, etc.) and
 * delivered to every connected SSE client owned by the same tenant. Used
 * by the Command Center to update dashboards / tee sheets / bookings
 * lists in real time without polling or page reloads.
 *
 * Key design points:
 *   - Subscriptions are scoped by businessId. A subscriber for tenant 1
 *     never receives events for tenant 2 — same isolation rule as every
 *     other service in this folder.
 *   - The bus is in-process. With a single Railway replica that's fine;
 *     when we scale to multiple replicas, swap this implementation for
 *     Redis pub/sub or Postgres LISTEN/NOTIFY without changing callers.
 *   - Publishers never throw on no subscribers — common case is "AI
 *     books a tee time and nobody has the dashboard open right now".
 */
const { requireBusinessId } = require('../context/tenant-context');

// businessId → Set<handler>. Created lazily on first subscribe.
const subscribers = new Map();

/**
 * Subscribe to events for one tenant. Returns an unsubscribe function;
 * call it on connection close so we don't leak handlers.
 *
 * @param {number} businessId
 * @param {(event: {type: string, businessId: number, ts: number, payload: object}) => void} handler
 * @returns {() => void}
 */
function subscribe(businessId, handler) {
  requireBusinessId(businessId, 'event-bus.subscribe');
  if (typeof handler !== 'function') throw new Error('handler must be a function');
  if (!subscribers.has(businessId)) subscribers.set(businessId, new Set());
  subscribers.get(businessId).add(handler);
  return () => {
    const set = subscribers.get(businessId);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) subscribers.delete(businessId);
  };
}

/**
 * Publish an event to every subscriber for one tenant. Async-safe:
 * handlers are called synchronously inside a try/catch so one slow or
 * broken subscriber can't take down the publisher.
 *
 * @param {number} businessId
 * @param {string} type — dotted event name (e.g. 'booking.created')
 * @param {object} payload — JSON-serialisable; small (a few fields)
 */
function publish(businessId, type, payload = {}) {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    // Don't throw on a bad publisher — just log. The original write
    // (booking insert, etc.) already succeeded; we should not propagate
    // a broadcast failure back up the call stack.
    console.warn(`[event-bus] publish skipped — invalid businessId=${businessId} type=${type}`);
    return;
  }
  const set = subscribers.get(businessId);
  if (!set || set.size === 0) return;
  const event = { type, businessId, ts: Date.now(), payload };
  for (const handler of set) {
    try {
      handler(event);
    } catch (err) {
      console.error(`[event-bus] subscriber threw for ${type}:`, err.message);
    }
  }
}

/**
 * Diagnostic — used by tests and the optional /api/events/_debug route.
 */
function _stats() {
  let total = 0;
  for (const set of subscribers.values()) total += set.size;
  return { tenants: subscribers.size, total_subscribers: total };
}

module.exports = { subscribe, publish, _stats };
