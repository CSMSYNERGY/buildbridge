import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Eye, EyeOff, RefreshCw, CheckCircle2, XCircle, LogOut, Copy, Check } from 'lucide-react';

export default function IdeaRoom() {
  const { fetchWithAuth, user } = useAuth();
  const { toast } = useToast();

  const [form, setForm] = useState({ clientId: '', apiKey: '' });
  const [connectedClientId, setConnectedClientId] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [copied, setCopied] = useState(false);

  // The URL to hand to IdeaRoom support so their webhook posts leads to us.
  // Served from the same host as this app, keyed by GHL locationId for routing.
  const webhookUrl = user?.locationId
    ? `${window.location.origin}/webhooks/idearoom/${user.locationId}`
    : '';

  useEffect(() => {
    fetchWithAuth('/api/idearoom/config')
      .then((r) => r.json())
      .then((d) => {
        if (d.config) {
          setConnectedClientId(d.config.clientId ?? '');
          setHasApiKey(!!d.config.hasApiKey);
          const connected = !!d.config.clientId;
          setIsConnected(connected);
          if (d.config.clientId) setForm((f) => ({ ...f, clientId: d.config.clientId }));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchWithAuth]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: 'Could not copy', description: 'Copy the URL manually.', variant: 'destructive' });
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetchWithAuth('/api/idearoom/config', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      toast({ title: 'Configuration saved' });
      setConnectedClientId(form.clientId);
      setIsConnected(!!form.clientId);
      if (form.apiKey) setHasApiKey(true);
      setForm((f) => ({ ...f, apiKey: '' })); // don't keep the key in the field
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (!form.clientId || (!form.apiKey && !hasApiKey)) {
      toast({ title: 'Enter a client-id and API key first', variant: 'destructive' });
      return;
    }
    setTesting(true);
    setTestStatus(null);
    try {
      const res = await fetchWithAuth('/api/idearoom/test', {
        method: 'POST',
        body: JSON.stringify({ clientId: form.clientId, apiKey: form.apiKey || undefined }),
      });
      const data = await res.json();
      setTestStatus(data.success ? 'ok' : 'error');
      toast({
        title: data.success ? 'Credentials accepted' : 'Test failed',
        description: data.success ? undefined : (data.error ?? 'IdeaRoom rejected the credentials.'),
        variant: data.success ? 'default' : 'destructive',
      });
    } catch {
      setTestStatus('error');
      toast({ title: 'Test failed', description: 'Could not reach the IdeaRoom API.', variant: 'destructive' });
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetchWithAuth('/api/idearoom/config', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to disconnect');
      toast({ title: 'IdeaRoom disconnected' });
      setIsConnected(false);
      setConnectedClientId('');
      setHasApiKey(false);
      setForm({ clientId: '', apiKey: '' });
      setTestStatus(null);
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
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: '#3d3672' }}>IdeaRoom Config</h1>
          <p className="text-muted-foreground mt-1">
            Capture IdeaRoom configurator designs as leads in your CRM.
          </p>
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
                    {connectedClientId}{hasApiKey ? ' · REST key stored' : ''}
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
                <Badge variant="secondary">Not set up</Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Webhook URL — the value to give IdeaRoom support */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base" style={{ color: '#3d3672' }}>Webhook URL</CardTitle>
            <CardDescription>
              Give this URL to IdeaRoom support and ask them to send the <strong>Created</strong> (and
              <strong> Updated</strong>) events here. New configurator designs become leads
              automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input readOnly value={webhookUrl} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleCopy}
                title="Copy webhook URL"
                disabled={!webhookUrl}
                style={{ borderColor: '#1b7895', color: '#1b7895' }}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Account settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base" style={{ color: '#3d3672' }}>IdeaRoom Account</CardTitle>
            <CardDescription>
              The API key is encrypted at rest and never displayed after saving. It's only needed for
              the on-demand REST pull — leave it blank if you're using the webhook alone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="space-y-5">
              {/* client-id */}
              <div className="space-y-1.5">
                <Label htmlFor="clientId" style={{ color: '#3d3672' }}>Client ID</Label>
                <Input
                  id="clientId"
                  type="text"
                  placeholder="carportview-your-company"
                  value={form.clientId}
                  onChange={set('clientId')}
                  required
                />
              </div>

              {/* API key (optional) */}
              <div className="space-y-1.5">
                <Label htmlFor="apiKey" style={{ color: '#3d3672' }}>
                  REST API Key <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="apiKey"
                      type={showApiKey ? 'text' : 'password'}
                      placeholder={hasApiKey ? '•••••••• (leave blank to keep)' : 'x-api-key from IdeaRoom'}
                      value={form.apiKey}
                      onChange={set('apiKey')}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                    >
                      {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={testing}
                    onClick={handleTestConnection}
                    title="Test API credentials"
                    style={{ borderColor: '#1b7895', color: '#1b7895' }}
                  >
                    <RefreshCw className={`h-4 w-4 ${testing ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
                {testStatus && (
                  <Badge
                    className="mt-1"
                    style={
                      testStatus === 'ok'
                        ? { backgroundColor: '#75e6da', color: '#1a1a2e', borderColor: 'transparent' }
                        : {}
                    }
                    variant={testStatus === 'ok' ? undefined : 'destructive'}
                  >
                    {testStatus === 'ok' ? 'Credentials accepted' : 'Rejected'}
                  </Badge>
                )}
              </div>

              <Button
                type="submit"
                disabled={saving}
                className="w-full text-white"
                style={{ backgroundColor: '#3d3672' }}
              >
                {saving ? 'Saving…' : 'Save Configuration'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
