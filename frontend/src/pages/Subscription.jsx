import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../components/ui/card.jsx';
import { Button } from '../components/ui/button.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Check } from 'lucide-react';

const APP_LABELS = {
  smartbuild: 'SmartBuild',
  idearoom: 'IdeaRoom',
  quickbooks: 'QuickBooks',
  monday: 'Monday.com',
  suite: 'Suite (All Apps)',
};

function formatPrice(cents) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
}

export default function Subscription() {
  const { fetchWithAuth, user } = useAuth();
  const { toast } = useToast();
  const [grouped, setGrouped] = useState({});
  const [billing, setBilling] = useState('monthly');
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState(null);

  useEffect(() => {
    fetchWithAuth('/api/subscription/plans')
      .then((r) => r.json())
      .then((d) => setGrouped(d.grouped ?? {}))
      .catch(() => toast({ title: 'Failed to load plans', variant: 'destructive' }))
      .finally(() => setLoading(false));
  }, [fetchWithAuth, toast]);

  async function handleSubscribe(planId) {
    setSubscribing(planId);
    try {
      const res = await fetchWithAuth('/api/subscription/create', {
        method: 'POST',
        body: JSON.stringify({ planId, name: user?.name, email: user?.email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      toast({ title: 'Subscribed!', description: 'Your subscription is now active.' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSubscribing(null);
    }
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading plans…</p>;

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Subscription</h1>
        <p className="text-muted-foreground mt-1">Choose the plan that fits your workflow.</p>
      </div>

      {/* Monthly / Annual toggle */}
      <div className="flex items-center gap-3">
        <span className={billing === 'monthly' ? 'font-medium' : 'text-muted-foreground'}>Monthly</span>
        <button
          onClick={() => setBilling((b) => (b === 'monthly' ? 'annual' : 'monthly'))}
          className="relative inline-flex h-6 w-11 rounded-full bg-muted transition-colors focus:outline-none data-[checked]:bg-primary"
          data-checked={billing === 'annual' ? '' : undefined}
          role="switch"
          aria-checked={billing === 'annual'}
        >
          <span
            className={`inline-block h-5 w-5 translate-x-0.5 translate-y-0.5 rounded-full bg-white shadow transition-transform ${billing === 'annual' ? 'translate-x-5' : ''}`}
          />
        </button>
        <span className={billing === 'annual' ? 'font-medium' : 'text-muted-foreground'}>
          Annual <Badge variant="success" className="ml-1">Save ~17%</Badge>
        </span>
      </div>

      {/* Plan cards grouped by app */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(grouped).map(([appSlug, plans]) => {
          const plan = plans.find((p) => p.billingInterval === billing) ?? plans[0];
          return (
            <Card key={appSlug} className="flex flex-col">
              <CardHeader>
                <CardTitle className="text-lg">{APP_LABELS[appSlug] ?? appSlug}</CardTitle>
                <CardDescription>
                  <span className="text-3xl font-bold text-foreground">
                    {formatPrice(plan.priceUsd)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    /{billing === 'annual' ? 'yr' : 'mo'}
                  </span>
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500 shrink-0" />
                    Full {APP_LABELS[appSlug] ?? appSlug} integration
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500 shrink-0" />
                    GHL workflow actions
                  </li>
                  {appSlug === 'suite' && (
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                      All apps included
                    </li>
                  )}
                </ul>
              </CardContent>
              <CardFooter>
                <Button
                  className="w-full"
                  disabled={subscribing === plan.id}
                  onClick={() => handleSubscribe(plan.id)}
                >
                  {subscribing === plan.id ? 'Processing…' : 'Subscribe'}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
