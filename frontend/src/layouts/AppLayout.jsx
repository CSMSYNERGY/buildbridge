import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { Hammer, LogOut } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { Button } from '../components/ui/button.jsx';
import useParentClipCompensation from '../hooks/useParentClipCompensation.js';

const NAV_ITEMS = [
  { to: '/buildbridge',            label: 'Home', end: true },
  { to: '/buildbridge/smartbuild', label: 'SmartBuild Config' },
  { to: '/buildbridge/quickbooks', label: 'QuickBooks'        },
];

const SUBSCRIPTION_ITEM = { to: '/buildbridge/subscription', label: 'Subscription' };

export default function AppLayout() {
  const { user, logout, loading, embedded, fetchWithAuth } = useAuth();

  // BuildBridge is included with the install, so a fresh tenant is never shown a
  // billing tab. Legacy tenants with a live paid subscription keep it, so they can
  // still see and cancel what they're being charged for. (The /subscription route
  // itself stays registered either way.)
  const [hasPaidPlan, setHasPaidPlan] = useState(false);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetchWithAuth('/api/subscription/mine')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setHasPaidPlan((d?.subscriptions ?? []).length > 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user, fetchWithAuth]);

  const navItems = hasPaidPlan
    ? [NAV_ITEMS[0], SUBSCRIPTION_ITEM, ...NAV_ITEMS.slice(1)]
    : NAV_ITEMS;

  // Embedded in GHL: measure how much of the iframe the parent clips below the
  // viewport and publish --bb-clip-bottom so bottom spacing compensates.
  useParentClipCompensation(embedded);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        {embedded ? 'Signing you in from Synergy…' : 'Loading…'}
      </div>
    );
  }

  // Signed out. Standalone visitors are auto-redirected to /auth by AuthProvider;
  // this state is only reachable when the embedded SSO handshake failed.
  if (!user) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <Hammer className="h-8 w-8" style={{ color: '#3d3672' }} />
        <p className="text-sm font-medium">We couldn't sign you in automatically.</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Reload this page to retry, or open BuildBridge in its own tab and log in with
          your Synergy account.
        </p>
        <Button asChild size="sm" style={{ backgroundColor: '#3d3672' }}>
          <a href="/auth" target="_top" rel="noreferrer">Log in with Synergy</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ── Top navigation bar ─────────────────────────────────────── */}
      <header
        className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-4 px-4"
        style={{ backgroundColor: '#3d3672' }}
      >
        {/* Brand */}
        <div className="flex items-center gap-2 shrink-0">
          <Hammer className="h-5 w-5 text-white" />
          <div className="leading-none">
            <span className="font-bold text-sm tracking-tight text-white">BuildBridge</span>
            <span
              className="hidden sm:block text-[10px] leading-none"
              style={{ color: '#75e6da' }}
            >
              by CSM Synergy
            </span>
          </div>
        </div>

        {/* Divider */}
        <div className="h-5 w-px shrink-0" style={{ backgroundColor: 'rgba(255,255,255,0.25)' }} />

        {/* Nav links */}
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto min-w-0 scrollbar-none">
          {navItems.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
                  isActive
                    ? 'text-white underline underline-offset-4 decoration-[#75e6da] decoration-2'
                    : 'text-white/75 hover:text-white hover:bg-[#1b7895]',
                )
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User + logout */}
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          {user && (
            <span
              className="hidden md:block text-xs truncate max-w-[160px]"
              style={{ color: 'rgba(255,255,255,0.7)' }}
            >
              {user.name ?? user.email ?? user.locationId}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2 text-white/75 hover:text-white hover:bg-[#1b7895]"
            onClick={logout}
            title="Log out"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline text-xs">Log out</span>
          </Button>
        </div>
      </header>

      {/* ── Page content ───────────────────────────────────────────── */}
      {/* Bottom padding grows by however much of the iframe GHL clips below
          the viewport (see useParentClipCompensation), so the end of the page
          is always scrollable into view. */}
      <main
        className="flex-1 px-4 pt-4 sm:px-6"
        style={{ paddingBottom: 'calc(1.5rem + var(--bb-clip-bottom, 0px))' }}
      >
        <Outlet />
      </main>
    </div>
  );
}
