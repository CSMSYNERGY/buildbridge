import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Check, Sliders, Hammer, ArrowRight } from 'lucide-react';

const QUICK_LINKS = [
  { to: '/buildbridge/quickbooks', label: 'QuickBooks',        icon: Sliders, description: 'Connect QuickBooks and map fields' },
  { to: '/buildbridge/smartbuild', label: 'SmartBuild Config', icon: Hammer,  description: 'Set up your SmartBuild credentials' },
];

function statusVariant(status) {
  if (!status) return 'outline';
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  return 'destructive';
}

export default function Home() {
  const { user, fetchWithAuth } = useAuth();
  const [subs, setSubs] = useState([]);

  useEffect(() => {
    // This location's actual active subscriptions — not the plan catalog.
    fetchWithAuth('/api/subscription/mine')
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d && setSubs(d.subscriptions ?? []))
      .catch(() => {});
  }, [fetchWithAuth]);

  const activeSubs = subs;

  return (
    <div style={{ position: 'relative' }}>
      {/* Full-page background watermark */}
      <img
        src="/buildbridge/logo.png"
        alt=""
        aria-hidden="true"
        style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '70%', height: 'auto', opacity: 0.06,
          pointerEvents: 'none', userSelect: 'none', zIndex: 0,
        }}
      />

      {/* Page content */}
      <div className="space-y-6 max-w-3xl" style={{ position: 'relative', zIndex: 1 }}>
        {/* Welcome banner */}
        <div className="rounded-lg px-6 py-5 text-white" style={{ backgroundColor: '#3d3672' }}>
          <h1 className="text-2xl font-bold tracking-tight">
            Welcome{user?.name ? `, ${user.name}` : ' to BuildBridge'}
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'rgba(255,255,255,0.75)' }}>
            {user?.email ?? 'BuildBridge by CSM Synergy'}
          </p>
        </div>

        {/* What's included. Every integration ships with the install, so a fresh
            location sees "included" here — not an upsell. Legacy paid tenants still
            see their plan badges. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base" style={{ color: '#3d3672' }}>What's included</CardTitle>
            <CardDescription>Active for this Synergy sub-account</CardDescription>
          </CardHeader>
          <CardContent>
            {activeSubs.length === 0 ? (
              <div className="flex items-start gap-2">
                <Check className="h-4 w-4 shrink-0 mt-0.5" style={{ color: '#1b7895' }} />
                <p className="text-sm text-muted-foreground">
                  All BuildBridge integrations are included with your install — nothing to buy.
                  Pick one below to set it up.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {activeSubs.map((s) => (
                  <Badge key={s.subscriptionId ?? s.planId} variant={statusVariant(s.status)}>
                    {s.planName ?? s.planId}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick links */}
        <div className="grid gap-4 sm:grid-cols-2">
          {QUICK_LINKS.map(({ to, label, icon: Icon, description }) => (
            <Link key={to} to={to}>
              <Card className="h-full transition-shadow hover:shadow-md cursor-pointer" style={{ borderColor: '#1b7895' }}>
                <CardContent className="flex flex-col gap-3 p-5">
                  <div className="flex items-center justify-between">
                    <Icon className="h-5 w-5" style={{ color: '#75e6da' }} />
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="font-medium text-sm" style={{ color: '#3d3672' }}>{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
