import { useEffect, useRef, useState, useCallback } from 'react';
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
  suite: 'BuildBridge Suite (All Apps)',
};

function formatPrice(cents) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
}

// Inject the Collect.js script once and resolve when CollectJS is ready.
function loadCollectJs(collectJsUrl, tokenizationKey) {
  return new Promise((resolve, reject) => {
    if (window.CollectJS) return resolve(window.CollectJS);
    const existing = document.querySelector('script[data-collectjs]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.CollectJS));
      existing.addEventListener('error', reject);
      return;
    }
    const s = document.createElement('script');
    s.src = collectJsUrl;
    s.async = true;
    s.dataset.collectjs = 'true';
    s.setAttribute('data-tokenization-key', tokenizationKey);
    s.onload = () => resolve(window.CollectJS);
    s.onerror = () => reject(new Error('Failed to load Collect.js'));
    document.head.appendChild(s);
  });
}

export default function Subscription() {
  const { fetchWithAuth, user } = useAuth();
  const { toast } = useToast();
  const [grouped, setGrouped] = useState({});
  const [checkout, setCheckout] = useState(null);   // { tokenizationKey, collectJsUrl }
  const [subs, setSubs] = useState([]);             // active subscriptions
  const [billing, setBilling] = useState('monthly');
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState(null);
  const [canceling, setCanceling] = useState(null);
  const [collectReady, setCollectReady] = useState(false);

  // The plan the shopper is paying for right now — read by the Collect.js
  // callback (which is registered once, so it needs a ref rather than state).
  const pendingPlanRef = useRef(null);

  const refreshSubs = useCallback(() => {
    fetchWithAuth('/api/subscription/mine')
      .then((r) => (r.ok ? r.json() : { subscriptions: [] }))
      .then((d) => setSubs(d.subscriptions ?? []))
      .catch(() => setSubs([]));
  }, [fetchWithAuth]);

  // Load plans + checkout config (public — works even outside GHL SSO).
  useEffect(() => {
    fetch('/api/subscription/plans', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        setGrouped(d.grouped ?? {});
        setCheckout(d.checkout ?? null);
      })
      .catch(() => toast({ title: 'Failed to load plans', variant: 'destructive' }))
      .finally(() => setLoading(false));
  }, [toast]);

  // Load the caller's current subscriptions (needs auth; silently empty if not).
  useEffect(() => { refreshSubs(); }, [refreshSubs]);

  // Create the subscription once Collect.js hands us a payment token.
  const onToken = useCallback(async (token) => {
    const plan = pendingPlanRef.current;
    if (!plan) return;
    setSubscribing(plan.id);
    try {
      const res = await fetchWithAuth('/api/subscription/create', {
        method: 'POST',
        body: JSON.stringify({ planId: plan.id, paymentToken: token, name: user?.name, email: user?.email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Subscription failed');
      toast({ title: 'Subscribed!', description: 'Your subscription is now active.' });
      refreshSubs();
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSubscribing(null);
      pendingPlanRef.current = null;
    }
  }, [fetchWithAuth, user, toast, refreshSubs]);

  // Initialise Collect.js (lightbox) once the public config is available.
  useEffect(() => {
    if (!checkout?.tokenizationKey || !checkout?.collectJsUrl) return;
    let cancelled = false;
    loadCollectJs(checkout.collectJsUrl, checkout.tokenizationKey)
      .then((CollectJS) => {
        if (cancelled || !CollectJS) return;
        CollectJS.configure({
          variant: 'lightbox',
          callback: (response) => { if (response?.token) onToken(response.token); },
        });
        setCollectReady(true);
      })
      .catch(() => toast({ title: 'Payment form failed to load', variant: 'destructive' }));
    return () => { cancelled = true; };
  }, [checkout, onToken, toast]);

  function handleSubscribe(plan) {
    if (!user) {
      toast({ title: 'Sign in required', description: 'Open BuildBridge from GoHighLevel to subscribe.', variant: 'destructive' });
      return;
    }
    if (!checkout?.tokenizationKey) {
      toast({ title: 'Billing not configured', description: 'Checkout is not available yet.', variant: 'destructive' });
      return;
    }
    if (!collectReady || !window.CollectJS) {
      toast({ title: 'One moment', description: 'Payment form is still loading — try again.' });
      return;
    }
    pendingPlanRef.current = plan;
    window.CollectJS.startPaymentRequest();  // opens the Collect.js lightbox
  }

  async function handleCancel(subscriptionId) {
    setCanceling(subscriptionId);
    try {
      const res = await fetchWithAuth('/api/subscription/cancel', {
        method: 'DELETE',
        body: JSON.stringify({ subscriptionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Cancel failed');
      toast({ title: 'Subscription cancelled' });
      refreshSubs();
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setCanceling(null);
    }
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading plans…</p>;

  const activeByApp = new Set(subs.map((s) => s.appSlug));

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
      <div className="space-y-8 max-w-5xl" style={{ position: 'relative', zIndex: 1 }}>
        <div>
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: '#3d3672' }}>Subscription</h1>
          <p className="text-muted-foreground mt-1">Choose the plan that fits your workflow.</p>
        </div>

        {/* Current subscriptions */}
        {subs.length > 0 && (
          <Card style={{ borderColor: '#1b7895' }}>
            <CardHeader>
              <CardTitle className="text-lg" style={{ color: '#3d3672' }}>Your active subscriptions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {subs.map((s) => (
                <div key={s.subscriptionId} className="flex items-center justify-between border-b pb-3 last:border-0 last:pb-0">
                  <div>
                    <div className="font-medium">{APP_LABELS[s.appSlug] ?? s.appSlug}</div>
                    <div className="text-sm text-muted-foreground">
                      {formatPrice(s.priceUsd)}/{s.billingInterval === 'annual' ? 'yr' : 'mo'}
                      {s.currentPeriodEnd && ` · renews ${new Date(s.currentPeriodEnd).toLocaleDateString()}`}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    disabled={canceling === s.subscriptionId}
                    onClick={() => handleCancel(s.subscriptionId)}
                  >
                    {canceling === s.subscriptionId ? 'Cancelling…' : 'Cancel'}
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Monthly / Annual toggle */}
        <div className="flex items-center gap-3">
          <span className={billing === 'monthly' ? 'font-medium' : 'text-muted-foreground'}>Monthly</span>
          <button
            onClick={() => setBilling((b) => (b === 'monthly' ? 'annual' : 'monthly'))}
            className="relative inline-flex h-6 w-11 rounded-full transition-colors focus:outline-none"
            style={{ backgroundColor: billing === 'annual' ? '#3d3672' : '#e2e8f0' }}
            role="switch"
            aria-checked={billing === 'annual'}
          >
            <span
              className={`inline-block h-5 w-5 translate-y-0.5 rounded-full bg-white shadow transition-transform ${billing === 'annual' ? 'translate-x-5' : 'translate-x-0.5'}`}
            />
          </button>
          <span className={billing === 'annual' ? 'font-medium' : 'text-muted-foreground'}>
            Annual{' '}
            <Badge className="ml-1" style={{ backgroundColor: '#75e6da', color: '#1a1a2e', borderColor: 'transparent' }}>
              Save ~17%
            </Badge>
          </span>
        </div>

        {/* Plan cards grouped by app */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(grouped).map(([appSlug, appPlans]) => {
            const plan = appPlans.find((p) => p.billingInterval === billing) ?? appPlans[0];
            const isCurrent = activeByApp.has(appSlug);
            return (
              <Card key={appSlug} className="flex flex-col" style={{ borderColor: '#1b7895' }}>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2" style={{ color: '#3d3672' }}>
                    {APP_LABELS[appSlug] ?? appSlug}
                    {isCurrent && (
                      <Badge style={{ backgroundColor: '#75e6da', color: '#1a1a2e', borderColor: 'transparent' }}>
                        Current
                      </Badge>
                    )}
                  </CardTitle>
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
                      <Check className="h-4 w-4 shrink-0" style={{ color: '#1b7895' }} />
                      Full {APP_LABELS[appSlug] ?? appSlug} integration
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 shrink-0" style={{ color: '#1b7895' }} />
                      Synergy workflow actions
                    </li>
                    {appSlug === 'suite' && (
                      <li className="flex items-center gap-2">
                        <Check className="h-4 w-4 shrink-0" style={{ color: '#1b7895' }} />
                        All apps included
                      </li>
                    )}
                  </ul>
                </CardContent>
                <CardFooter>
                  <Button
                    className="w-full text-white"
                    style={{ backgroundColor: '#3d3672' }}
                    disabled={subscribing === plan.id || isCurrent}
                    onClick={() => handleSubscribe(plan)}
                  >
                    {isCurrent ? 'Subscribed' : subscribing === plan.id ? 'Processing…' : 'Subscribe'}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
