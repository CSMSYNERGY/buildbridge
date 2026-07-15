// Registry of inbound IdeaRoom event handlers. Mirrors ghlDispatcher.js so the
// QuickBooks (GHL) path stays untouched. The webhook route + controller ship the
// plumbing; integration modules (src/integrations/idearoom.js) register handlers
// for the event types they care about ('created', 'updated', …).

const registry = new Map(); // eventType → handler[]

/**
 * Register a handler for an IdeaRoom event type (e.g. 'created').
 * Handler signature: async ({ locationId, payload }) => void
 */
export function registerIdearoomHandler(eventType, handler) {
  if (!registry.has(eventType)) registry.set(eventType, []);
  registry.get(eventType).push(handler);
}

/**
 * Dispatch an IdeaRoom event to all registered handlers for its type.
 * Returns the number of handlers invoked. Handler errors propagate so the
 * caller can mark the event failed (and the admin replay endpoint can retry).
 */
export async function dispatchIdearoomEvent(eventType, { locationId, payload }) {
  const handlers = registry.get(eventType) ?? [];
  for (const handler of handlers) {
    await handler({ locationId, payload });
  }
  return handlers.length;
}

/** List registered event types (used for logging/diagnostics). */
export function registeredIdearoomEventTypes() {
  return [...registry.keys()];
}
