// Browser-side error reporting → POST /api/client-errors → error_events table.
//
// Captures what the customer actually experiences (a crashed React tree, a failed
// fetch, an unhandled rejection) which never appears in server logs at all.
//
// Deliberately dependency-free and defensive: reporting must never itself throw,
// and a reporting failure must never surface to the user.

const ENDPOINT = '/api/client-errors';

// Client-side throttle so a render loop can't hammer the endpoint. The server
// dedupes too (fingerprint), but stopping the traffic here is cheaper.
const MAX_PER_SESSION = 20;
const MIN_INTERVAL_MS = 2000;
let sent = 0;
let lastSentAt = 0;
const seen = new Set(); // signature → already reported this session

export function reportClientError(info) {
  try {
    const message = String(info?.message ?? '').slice(0, 1000);
    if (!message) return;

    const signature = `${info?.kind ?? ''}|${message}`;
    if (seen.has(signature)) return;

    const now = Date.now();
    if (sent >= MAX_PER_SESSION || now - lastSentAt < MIN_INTERVAL_MS) return;
    sent += 1;
    lastSentAt = now;
    seen.add(signature);

    const body = JSON.stringify({
      message,
      kind: info?.kind ?? 'client_error',
      severity: info?.severity ?? 'error',
      stack: info?.stack ? String(info.stack).slice(0, 4000) : undefined,
      path: `${window.location.pathname}${window.location.search ? '?…' : ''}`,
      context: info?.context,
    });

    // keepalive so a report fired during unload still goes out. No await: the
    // caller (an error boundary or a global handler) must not block on this.
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      keepalive: true,
      body,
    }).catch(() => {});
  } catch {
    // Never let reporting break the app.
  }
}

/** Install global handlers. Idempotent — safe under React StrictMode double-mount. */
let installed = false;
export function installGlobalErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    // Resource load failures (img/script) surface here with no `error` object;
    // they are not app crashes, so skip them.
    if (!event?.error && !event?.message) return;
    reportClientError({
      kind: 'window_error',
      message: event.message || event.error?.message || 'Unknown window error',
      stack: event.error?.stack,
      context: { source: event.filename, line: event.lineno, col: event.colno },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    reportClientError({
      kind: 'unhandled_rejection',
      message: reason?.message ?? String(reason ?? 'Unhandled promise rejection'),
      stack: reason?.stack,
    });
  });
}
