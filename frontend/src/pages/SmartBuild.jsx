import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Eye, EyeOff, RefreshCw, ChevronDown, ChevronUp, CheckCircle2, XCircle, LogOut, X, ArrowRight } from 'lucide-react';

export default function SmartBuild() {
  const { fetchWithAuth } = useAuth();
  const { toast } = useToast();

  const [form, setForm] = useState({ username: '', password: '', baseUrl: '' });
  const [connectedEmail, setConnectedEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  // Field mappings (SmartBuild field → Synergy field)
  const [ghlFields, setGhlFields] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [mapDraft, setMapDraft] = useState({ sb: '', ghl: '' });
  const [savingMap, setSavingMap] = useState(false);

  useEffect(() => {
    fetchWithAuth('/api/smartbuild/config')
      .then((r) => r.json())
      .then((d) => {
        if (d.config) {
          setConnectedEmail(d.config.username ?? '');
          const connected = !!(d.config.username);
          setIsConnected(connected);
          setCredentialsOpen(!connected);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchWithAuth]);

  // Load Synergy (GHL) fields + this location's SmartBuild field mappings.
  useEffect(() => {
    fetchWithAuth('/api/ghl/fields')
      .then((r) => (r.ok ? r.json() : { fields: [] }))
      .then((d) => setGhlFields(d.fields ?? []))
      .catch(() => {});
    fetchWithAuth('/api/mappers?appSlug=smartbuild')
      .then((r) => (r.ok ? r.json() : { mappers: [] }))
      .then((d) => setMappings((d.mappers ?? []).filter((m) => m.mapperType === 'custom_field')))
      .catch(() => {});
  }, [fetchWithAuth]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const usedGhl = new Set(mappings.map((m) => m.ghlValue));
  const ghlLabel = (id) => ghlFields.find((f) => (f.id ?? f.key) === id)?.label ?? id;

  async function addMapping() {
    const sb = mapDraft.sb.trim();
    if (!sb || !mapDraft.ghl) return;
    setSavingMap(true);
    try {
      const res = await fetchWithAuth('/api/mappers', {
        method: 'POST',
        body: JSON.stringify({
          appSlug: 'smartbuild',
          mapperType: 'custom_field',
          externalKey: sb,
          ghlValue: mapDraft.ghl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to add mapping');
      setMappings((prev) => [...prev.filter((m) => m.id !== data.mapper.id), data.mapper]);
      setMapDraft({ sb: '', ghl: '' });
      toast({ title: 'Mapping added' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSavingMap(false);
    }
  }

  async function deleteMapping(id) {
    try {
      const res = await fetchWithAuth(`/api/mappers/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove mapping');
      setMappings((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetchWithAuth('/api/smartbuild/config', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      toast({ title: 'Configuration saved' });
      setConnectedEmail(form.username);
      setIsConnected(!!form.username);
      if (form.username) {
        setForm({ username: '', password: '', baseUrl: '' });
        setCredentialsOpen(false);
      }
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (!form.baseUrl || !form.username || !form.password) {
      toast({ title: 'Enter all credentials first', variant: 'destructive' });
      return;
    }
    setTesting(true);
    setTestStatus(null);
    try {
      const res = await fetchWithAuth('/api/smartbuild/test', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: form.baseUrl, username: form.username, password: form.password }),
      });
      const data = await res.json();
      setTestStatus(data.success ? 'ok' : 'error');
      toast({
        title: data.success ? 'Connection successful' : 'Connection failed',
        description: data.success ? undefined : (data.error ?? 'Invalid credentials or unreachable server.'),
        variant: data.success ? 'default' : 'destructive',
      });
    } catch {
      setTestStatus('error');
      toast({ title: 'Connection failed', description: 'Could not reach the SmartBuild server.', variant: 'destructive' });
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetchWithAuth('/api/smartbuild/config', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to disconnect');
      toast({ title: 'Account disconnected' });
      setIsConnected(false);
      setConnectedEmail('');
      setForm({ username: '', password: '', baseUrl: '' });
      setCredentialsOpen(true);
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
        <h1 className="text-3xl font-bold tracking-tight" style={{ color: '#3d3672' }}>SmartBuild Config</h1>
        <p className="text-muted-foreground mt-1">Connect your SmartBuild account credentials.</p>
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
                <p className="text-sm text-muted-foreground truncate">{connectedEmail}</p>
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
              <Badge variant="secondary">No credentials</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          className="cursor-pointer select-none"
          onClick={() => setCredentialsOpen((v) => !v)}
        >
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base" style={{ color: '#3d3672' }}>Login Credentials</CardTitle>
              <CardDescription>
                These credentials are encrypted at rest and never exposed in plaintext.
              </CardDescription>
            </div>
            {credentialsOpen
              ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
              : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            }
          </div>
        </CardHeader>
        {credentialsOpen && <CardContent>
          <form onSubmit={handleSave} className="space-y-5">
            {/* Username */}
            <div className="space-y-1.5">
              <Label htmlFor="username" style={{ color: '#3d3672' }}>Username</Label>
              <Input
                id="username"
                type="text"
                placeholder="your@email.com"
                value={form.username}
                onChange={set('username')}
                required
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <Label htmlFor="password" style={{ color: '#3d3672' }}>Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••••••••••"
                  value={form.password}
                  onChange={set('password')}
                  className="pr-10"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Base URL */}
            <div className="space-y-1.5">
              <Label htmlFor="baseUrl" style={{ color: '#3d3672' }}>SmartBuild Base URL</Label>
              <div className="flex gap-2">
                <Input
                  id="baseUrl"
                  type="url"
                  placeholder="https://app.smartbuild.io"
                  value={form.baseUrl}
                  onChange={set('baseUrl')}
                  required
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={testing}
                  onClick={handleTestConnection}
                  title="Test connection"
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
                  {testStatus === 'ok' ? 'Connected' : 'Unreachable'}
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
        </CardContent>}
      </Card>

      {/* Field mappings — SmartBuild field → Synergy field */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base" style={{ color: '#3d3672' }}>Field mappings</CardTitle>
          <CardDescription>
            Map a SmartBuild field to a Synergy field. Enter the SmartBuild field key, then pick the Synergy field it fills.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {mappings.length > 0 ? (
            <ul className="space-y-2">
              {mappings.map((m) => (
                <li key={m.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="font-mono text-xs truncate" style={{ color: '#3d3672' }}>{m.externalKey}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate" style={{ color: '#1b7895' }}>{ghlLabel(m.ghlValue)}</span>
                  <button
                    type="button"
                    onClick={() => deleteMapping(m.id)}
                    className="ml-auto shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label="Remove mapping"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No field mappings yet.</p>
          )}

          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="space-y-1 min-w-0">
              <Label htmlFor="sbField" className="text-xs">SmartBuild field</Label>
              <Input
                id="sbField"
                placeholder="e.g. job_name"
                value={mapDraft.sb}
                onChange={(e) => setMapDraft((d) => ({ ...d, sb: e.target.value }))}
              />
            </div>
            <ArrowRight className="mb-2.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1 min-w-0">
              <Label htmlFor="sbGhl" className="text-xs">Synergy field</Label>
              <select
                id="sbGhl"
                value={mapDraft.ghl}
                onChange={(e) => setMapDraft((d) => ({ ...d, ghl: e.target.value }))}
                className="flex h-10 w-full rounded-md border border-input bg-background px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Select…</option>
                {ghlFields.map((f) => {
                  const id = f.id ?? f.key;
                  return (
                    <option key={id} value={id} disabled={usedGhl.has(id)}>
                      {f.label}{usedGhl.has(id) ? ' (mapped)' : ''}
                    </option>
                  );
                })}
              </select>
            </div>
          </div>

          <Button
            type="button"
            onClick={addMapping}
            disabled={savingMap || !mapDraft.sb.trim() || !mapDraft.ghl}
            className="text-white"
            style={{ backgroundColor: '#3d3672' }}
          >
            {savingMap ? 'Adding…' : 'Add mapping'}
          </Button>
        </CardContent>
      </Card>
    </div>
    </div>
  );
}
