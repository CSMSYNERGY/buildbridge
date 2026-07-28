import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

const AuthContext = createContext(null);

// Running inside an iframe (i.e. embedded in the GHL app shell)?
const isEmbedded = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin access throws → definitely framed
  }
})();

const TOKEN_KEY = 'bb_session_token';

// sessionStorage access throws (SecurityError) in the embedded GHL iframe when
// third-party storage is blocked — guard the read so it never crashes render.
function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Ask the GHL parent frame for the encrypted SSO user data.
 * GHL answers a { message: 'REQUEST_USER_DATA' } post with
 * { message: 'REQUEST_USER_DATA_RESPONSE', payload: '<encrypted>' }.
 */
function requestGhlSsoPayload(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener('message', onMessage);
      fn(arg);
    };

    const timer = setTimeout(
      () => done(reject, new Error('No SSO response from the GHL parent frame')),
      timeoutMs,
    );

    function onMessage(event) {
      // Only trust the parent frame we actually messaged — defeats a sibling/
      // co-frame injecting a forged SSO payload.
      if (event.source !== window.parent) return;
      const data = event.data;
      if (data && data.message === 'REQUEST_USER_DATA_RESPONSE' && data.payload) {
        done(resolve, data.payload);
      }
    }

    window.addEventListener('message', onMessage);
    const ask = () => { try { window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*'); } catch { /* parent gone */ } };
    ask();
    // Re-ask until answered. A single post is lost if the GHL shell's listener is not
    // attached yet when this iframe boots — a plain race, and it matters more now that
    // the embedded path depends on this handshake for EVERY load rather than only when
    // no session was cached.
    const poll = setInterval(ask, 400);
  });
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const tokenRef = useRef(readToken());

  // Centralised fetch that always sends cookies and, when we hold a session token
  // (embedded flow — third-party cookies may be blocked in the iframe), a Bearer header.
  const fetchWithAuth = useCallback(async (url, options = {}) => {
    return fetch(url, {
      ...options,
      credentials: 'include',
      // Never serve API data from the browser cache: a stale cached body (e.g. an
      // error-era {config:null}) would otherwise be replayed indefinitely.
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
        ...options.headers,
      },
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchMe() {
      const res = await fetchWithAuth('/api/me');
      if (!res.ok) return null;
      const data = await res.json();
      return data?.user ?? null;
    }

    async function ssoExchange(key) {
      const res = await fetchWithAuth('/api/sso/decrypt', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      if (!res.ok) throw new Error(`SSO exchange failed (${res.status})`);
      const data = await res.json();
      if (data?.token) {
        tokenRef.current = data.token;
        try { sessionStorage.setItem(TOKEN_KEY, data.token); } catch { /* storage may be blocked */ }
      }
      return data?.user ?? null;
    }

    function clearStoredToken() {
      if (!tokenRef.current) return;
      tokenRef.current = null;
      try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    }

    async function establishSession() {
      // ── Embedded in GHL: re-derive the session on EVERY load ──────────────────
      // GHL's SSO payload is the only authority on which sub-account is currently
      // open, and it is ENCRYPTED — the active locationId cannot be read client-side,
      // so we cannot compare it against a cached session. The session must therefore
      // be re-exchanged every time and the server decides which location it is for.
      //
      // This block used to come LAST, after an existing cookie/stored token was
      // trusted. Switching sub-account reloads this iframe on the same origin, so
      // that session survived and /api/me kept returning the PREVIOUS locationId —
      // which is why opening BuildBridge inside Rockwood still showed CSM Synergy's
      // QuickBooks connection (observed 2026-07-28). It was not only a display bug:
      // the QBO connection and the field/item mappings are all keyed on locationId,
      // so connecting or saving a mapping in that state wrote to the wrong tenant.
      if (isEmbedded) {
        // Drop the stored token up front — it belongs to whichever sub-account was
        // open last, and must never shadow this load.
        clearStoredToken();
        const embeddedKey = new URLSearchParams(window.location.search).get('key');
        try {
          // A URL key (GHL custom-page flow) is already this load's payload; otherwise
          // ask the parent frame for a fresh one.
          const payload = embeddedKey || await requestGhlSsoPayload();
          const me = await ssoExchange(payload);
          if (me) return me;
        } catch (err) {
          console.warn('[auth] embedded SSO failed:', err?.message);
        }
        // Deliberately NOT falling back to a cached session: showing the sign-in card
        // is safer than silently showing the previous sub-account's data.
        return null;
      }

      // ── Standalone ───────────────────────────────────────────────────────────
      // 1. Existing session (cookie or stored token). Safe here: outside the GHL
      //    shell there is no sub-account to switch underneath us.
      let me = await fetchMe().catch(() => null);
      if (me) return me;

      // Stored token is stale — drop it so it can't shadow a fresh login.
      clearStoredToken();

      // 2. SSO key delivered in the URL.
      const urlKey = new URLSearchParams(window.location.search).get('key');
      if (urlKey) {
        me = await ssoExchange(urlKey).catch(() => null);
        if (me) return me;
      }

      // 3. No session → straight to the GHL OAuth login.
      window.location.href = '/auth';
      return null;
    }

    establishSession()
      .then((me) => { if (!cancelled) setUser(me); })
      .catch(() => { if (!cancelled) setUser(null); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [fetchWithAuth]);

  const logout = useCallback(async () => {
    await fetchWithAuth('/api/logout', { method: 'POST' }).catch(() => {});
    tokenRef.current = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    setUser(null);
    if (!isEmbedded) window.location.href = '/auth';
  }, [fetchWithAuth]);

  return (
    <AuthContext.Provider value={{ user, loading, logout, fetchWithAuth, embedded: isEmbedded }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
