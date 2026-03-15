import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Centralised fetch that always sends cookies
  const fetchWithAuth = useCallback(async (url, options = {}) => {
    return fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  }, []);

  useEffect(() => {
    fetchWithAuth('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setUser(data?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [fetchWithAuth]);

  const logout = useCallback(async () => {
    await fetchWithAuth('/api/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    window.location.href = '/auth';
  }, [fetchWithAuth]);

  return (
    <AuthContext.Provider value={{ user, loading, logout, fetchWithAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
