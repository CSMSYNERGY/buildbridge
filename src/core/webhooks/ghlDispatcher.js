// Registry of inbound GHL event handlers. The base platform ships the route
// and dispatch plumbing; integration modules (e.g. the QuickBooks client
// models) register handlers for the event types they care about.

const registry = new Map(); // eventType → handler[]

/**
 * Register a handler for a GHL event type (e.g. 'opportunity.stage_change').
 * Handler signature: async ({ locationId, payload }) => void
 */
export function registerGhlHandler(eventType, handler) {
  if (!registry.has(eventType)) registry.set(eventType, []);
  registry.get(eventType).push(handler);
}

/**
 * Dispatch a GHL event to all registered handlers for its type.
 * Returns the number of handlers invoked. Handler errors propagate so the
 * caller can mark the event failed (and the admin replay endpoint can retry).
 */
export async function dispatchGhlEvent(eventType, { locationId, payload }) {
  const handlers = registry.get(eventType) ?? [];
  for (const handler of handlers) {
    await handler({ locationId, payload });
  }
  return handlers.length;
}

/** List registered event types (used for logging/diagnostics). */
export function registeredEventTypes() {
  return [...registry.keys()];
}
