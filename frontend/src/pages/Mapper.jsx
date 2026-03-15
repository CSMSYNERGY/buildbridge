import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';

const APP_SLUGS = ['smartbuild', 'idearoom', 'quickbooks', 'monday', 'suite'];
const MAPPER_TYPES = ['opportunity_stage', 'contact_tag', 'pipeline', 'custom_field'];

export default function Mapper() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { fetchWithAuth } = useAuth();
  const { toast } = useToast();

  const [form, setForm] = useState({
    appSlug: 'smartbuild',
    mapperType: 'opportunity_stage',
    externalKey: '',
    ghlValue: '',
  });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!isNew);

  useEffect(() => {
    if (isNew) return;
    fetchWithAuth(`/api/mappers?id=${id}`)
      .then((r) => r.json())
      .then((d) => {
        const m = d.mappers?.find((x) => x.id === id);
        if (m) setForm({ appSlug: m.appSlug, mapperType: m.mapperType, externalKey: m.externalKey, ghlValue: m.ghlValue });
      })
      .catch(() => toast({ title: 'Failed to load mapper', variant: 'destructive' }))
      .finally(() => setLoading(false));
  }, [id, isNew, fetchWithAuth, toast]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = isNew
        ? await fetchWithAuth('/api/mappers', { method: 'POST', body: JSON.stringify(form) })
        : await fetchWithAuth(`/api/mappers/${id}`, { method: 'PUT', body: JSON.stringify({ ghlValue: form.ghlValue }) });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      toast({ title: isNew ? 'Mapper created' : 'Mapper updated' });
      navigate('/app/mappers');
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{isNew ? 'New Mapper' : 'Edit Mapper'}</h1>
        <p className="text-muted-foreground mt-1">
          {isNew ? 'Create a new field mapping.' : 'Update the GHL value for this mapper.'}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mapper Details</CardTitle>
          <CardDescription>Map an external integration field to a GoHighLevel value.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* App slug */}
            <div className="space-y-1.5">
              <Label htmlFor="appSlug">App</Label>
              <select
                id="appSlug"
                value={form.appSlug}
                onChange={set('appSlug')}
                disabled={!isNew}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {APP_SLUGS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* Mapper type */}
            <div className="space-y-1.5">
              <Label htmlFor="mapperType">Mapper Type</Label>
              <select
                id="mapperType"
                value={form.mapperType}
                onChange={set('mapperType')}
                disabled={!isNew}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {MAPPER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            {/* External key */}
            <div className="space-y-1.5">
              <Label htmlFor="externalKey">External Key</Label>
              <Input
                id="externalKey"
                placeholder="e.g. STAGE_WON"
                value={form.externalKey}
                onChange={set('externalKey')}
                disabled={!isNew}
                required
              />
            </div>

            {/* GHL value */}
            <div className="space-y-1.5">
              <Label htmlFor="ghlValue">GHL Value</Label>
              <Input
                id="ghlValue"
                placeholder="e.g. Won"
                value={form.ghlValue}
                onChange={set('ghlValue')}
                required
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : isNew ? 'Create Mapper' : 'Save Changes'}
              </Button>
              <Button type="button" variant="outline" asChild>
                <Link to="/app/mappers">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
