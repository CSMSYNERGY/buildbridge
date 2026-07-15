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

/**
 * Ask the GHL parent frame for the encrypted SSO user data.
 * GHL answers a { message: 'REQUEST_USER_DATA' } post with
 * { message: 'REQUEST_USER_DATA_RESPONSE', payload: '<encrypted>' }.
 */
function requestGhlSsoPayload(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('No SSO response from the GHL parent frame'));
    }, timeoutMs);

    function onMessage(event) {
      const data = event.data;
      if (data && data.message === 'REQUEST_USER_DATA_RESPONSE' && data.payload) {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(data.payload);
      }
    }

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*');
  });
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const tokenRef = useRef(sessionStorage.getItem(TOKEN_KEY));

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

    async function establishSession() {
      // 1. Existing session (cookie or stored token).
      let me = await fetchMe().catch(() => null);
      if (me) return me;

      // Stored token is stale — drop it so it can't shadow a fresh login.
      if (tokenRef.current) {
        tokenRef.current = null;
        try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
      }

      // 2. SSO key delivered in the URL (GHL custom-page URL flow).
      const urlKey = new URLSearchParams(window.location.search).get('key');
      if (urlKey) {
        me = await ssoExchange(urlKey).catch(() => null);
        if (me) return me;
      }

      // 3. Embedded in GHL → postMessage SSO handshake with the parent frame.
      if (isEmbedded) {
        try {
          const payload = await requestGhlSsoPayload();
          me = await ssoExchange(payload);
          if (me) return me;
        } catch (err) {
          console.warn('[auth] embedded SSO failed:', err?.message);
        }
        return null; // stay logged-out inside the iframe; layout shows the sign-in card
      }

      // 4. Standalone with no session → straight to the GHL OAuth login.
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
