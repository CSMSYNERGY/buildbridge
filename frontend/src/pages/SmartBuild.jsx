import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';

export default function SmartBuild() {
  const { fetchWithAuth } = useAuth();
  const { toast } = useToast();

  const [form, setForm] = useState({ username: '', password: '', baseUrl: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState(null);

  useEffect(() => {
    fetchWithAuth('/api/smartbuild/config')
      .then((r) => r.json())
      .then((d) => {
        if (d.config) setForm({ username: d.config.username ?? '', password: d.config.password ?? '', baseUrl: d.config.baseUrl ?? '' });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchWithAuth]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base" style={{ color: '#3d3672' }}>Login Credentials</CardTitle>
          <CardDescription>
            These credentials are encrypted at rest and never exposed in plaintext.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
    </div>
    </div>
  );
}
