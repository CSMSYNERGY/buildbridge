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

  const [form, setForm] = useState({ apiKey: '', baseUrl: '' });
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState(null); // 'ok' | 'error' | null

  useEffect(() => {
    fetchWithAuth('/api/smartbuild/config')
      .then((r) => r.json())
      .then((d) => {
        if (d.config) setForm({ apiKey: d.config.apiKey ?? '', baseUrl: d.config.baseUrl ?? '' });
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
    if (!form.baseUrl) {
      toast({ title: 'Enter a Base URL first', variant: 'destructive' });
      return;
    }
    setTesting(true);
    setTestStatus(null);
    try {
      const res = await fetch(`${form.baseUrl}/health`, { method: 'GET' });
      setTestStatus(res.ok ? 'ok' : 'error');
      toast({
        title: res.ok ? 'Connection successful' : 'Connection failed',
        variant: res.ok ? 'default' : 'destructive',
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
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">SmartBuild Config</h1>
        <p className="text-muted-foreground mt-1">Connect your SmartBuild account credentials.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">API Credentials</CardTitle>
          <CardDescription>
            These credentials are encrypted at rest. Your API key is never exposed in plaintext.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-5">
            {/* API Key */}
            <div className="space-y-1.5">
              <Label htmlFor="apiKey">API Key</Label>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showKey ? 'text' : 'password'}
                  placeholder="sk-••••••••••••••••"
                  value={form.apiKey}
                  onChange={set('apiKey')}
                  className="pr-10"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Base URL */}
            <div className="space-y-1.5">
              <Label htmlFor="baseUrl">SmartBuild Base URL</Label>
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
                >
                  <RefreshCw className={`h-4 w-4 ${testing ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              {testStatus && (
                <Badge variant={testStatus === 'ok' ? 'success' : 'destructive'} className="mt-1">
                  {testStatus === 'ok' ? 'Connected' : 'Unreachable'}
                </Badge>
              )}
            </div>

            <Button type="submit" disabled={saving} className="w-full">
              {saving ? 'Saving…' : 'Save Configuration'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
