import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import { CreditCard, Sliders, Hammer, ArrowRight } from 'lucide-react';

const QUICK_LINKS = [
  { to: '/app/subscription', label: 'Manage Subscription', icon: CreditCard, description: 'View and change your plan' },
  { to: '/app/mappers',      label: 'Configure Mappers',   icon: Sliders,     description: 'Map integration fields to GHL' },
  { to: '/app/smartbuild',   label: 'SmartBuild Config',   icon: Hammer,      description: 'Set up your SmartBuild credentials' },
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
    fetchWithAuth('/api/subscription/plans')
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d && setSubs(d.plans ?? []))
      .catch(() => {});
  }, [fetchWithAuth]);

  const activeSubs = subs.filter((s) => s.status === 'active');

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Welcome banner */}
      <div className="rounded-lg px-6 py-5 text-white" style={{ backgroundColor: '#3d3672' }}>
        <h1 className="text-2xl font-bold tracking-tight">Welcome to BuildBridge</h1>
        <p className="mt-1 text-sm" style={{ color: 'rgba(255,255,255,0.75)' }}>
          Location ID: <code className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}>{user?.locationId}</code>
        </p>
      </div>

      {/* Subscription status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base" style={{ color: '#3d3672' }}>Subscription Status</CardTitle>
          <CardDescription>Your currently active plans</CardDescription>
        </CardHeader>
        <CardContent>
          {activeSubs.length === 0 ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">No active subscriptions</p>
              <Button asChild size="sm" variant="outline" style={{ borderColor: '#1b7895', color: '#1b7895' }}>
                <Link to="/app/subscription">View Plans</Link>
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {activeSubs.map((s) => (
                <Badge key={s.id} variant={statusVariant(s.status)}>
                  {s.name ?? s.planId}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick links */}
      <div className="grid gap-4 sm:grid-cols-3">
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
  );
}
