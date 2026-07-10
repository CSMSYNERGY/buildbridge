import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { CheckCircle2, XCircle, LogOut, Link2 } from 'lucide-react';

export default function QuickBooks() {
  const { fetchWithAuth } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null); // { realmId, environment } | null
  const [disconnecting, setDisconnecting] = useState(false);

  const isConnected = !!config;

  useEffect(() => {
    fetchWithAuth('/api/quickbooks/config')
      .then((r) => r.json())
      .then((d) => setConfig(d.config ?? null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchWithAuth]);

  // Surface the OAuth round-trip result (?connected=1 / ?error=...) then clean the URL.
  useEffect(() => {
    if (searchParams.get('connected')) {
      toast({ title: 'QuickBooks connected' });
      setSearchParams({}, { replace: true });
    } else if (searchParams.get('error')) {
      toast({
        title: 'Could not connect QuickBooks',
        description: searchParams.get('error'),
        variant: 'destructive',
      });
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, toast]);

  function handleConnect() {
    // Full-page navigation into the server-side OAuth flow.
    window.location.href = '/auth/quickbooks/connect';
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetchWithAuth('/api/quickbooks/config', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to disconnect');
      toast({ title: 'QuickBooks disconnected' });
      setConfig(null);
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading configuration…</p>;

  return (
    <div style={{ position: 'relative' }}>
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
      <div className="max-w-lg space-y-6" style={{ position: 'relative', zIndex: 1 }}>
        <div>
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: '#3d3672' }}>QuickBooks Config</h1>
          <p className="text-muted-foreground mt-1">Connect your QuickBooks Online company via secure OAuth.</p>
        </div>

        {/* Connection Status */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              {isConnected
                ? <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: '#1b7895' }} />
                : <XCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
              }
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" style={{ color: '#3d3672' }}>
                  {isConnected ? 'Connected' : 'Not connected'}
                </p>
                {isConnected && (
                  <p className="text-sm text-muted-foreground truncate">
                    Company (realm) {config.realmId} · {config.environment}
                  </p>
                )}
              </div>
              {isConnected ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disconnecting}
                  onClick={handleDisconnect}
                  className="shrink-0 gap-1.5"
                  style={{ borderColor: '#e53e3e', color: '#e53e3e' }}
                >
                  <LogOut className="h-3.5 w-3.5" />
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              ) : (
                <Badge variant="secondary">No connection</Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {!isConnected && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base" style={{ color: '#3d3672' }}>Connect QuickBooks</CardTitle>
              <CardDescription>
                You'll be redirected to Intuit to authorize access. Tokens are encrypted at rest and
                refreshed automatically — no passwords are stored.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                onClick={handleConnect}
                className="w-full gap-2 text-white"
                style={{ backgroundColor: '#3d3672' }}
              >
                <Link2 className="h-4 w-4" />
                Connect to QuickBooks
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
