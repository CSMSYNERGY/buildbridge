import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { Hammer, LogOut, CreditCard, Sliders, Home } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { Button } from '../components/ui/button.jsx';

const NAV_ITEMS = [
  { to: '/app',              label: 'Home',              icon: Home,       end: true },
  { to: '/app/subscription', label: 'Subscription',      icon: CreditCard            },
  { to: '/app/mappers',      label: 'Mappers',           icon: Sliders               },
  { to: '/app/smartbuild',   label: 'SmartBuild Config', icon: Hammer                },
];

export default function AppLayout() {
  const { user, logout, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ── Top navigation bar ─────────────────────────────────────── */}
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center border-b bg-white px-4 gap-4">

        {/* Brand */}
        <div className="flex items-center gap-2 shrink-0">
          <Hammer className="h-5 w-5 text-primary" />
          <div className="leading-none">
            <span className="font-bold text-sm tracking-tight">BuildBridge</span>
            <span className="hidden sm:block text-[10px] text-muted-foreground leading-none">
              by CSM Synergy
            </span>
          </div>
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-border shrink-0" />

        {/* Nav links — horizontally scrollable on narrow viewports */}
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto min-w-0 scrollbar-none">
          {NAV_ITEMS.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
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
            <span className="hidden md:block text-xs text-muted-foreground truncate max-w-[160px]">
              {user.email ?? user.locationId}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-destructive px-2"
            onClick={logout}
            title="Log out"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline text-xs">Log out</span>
          </Button>
        </div>
      </header>

      {/* ── Page content ───────────────────────────────────────────── */}
      <main className="flex-1 p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}
