import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { ChevronDown, Search } from 'lucide-react';
import { cn } from '../lib/utils.js';

const APP_SLUGS = ['smartbuild', 'idearoom', 'quickbooks', 'monday'];
const MAPPER_TYPES = ['opportunity_stage', 'contact_tag', 'pipeline', 'custom_field'];

// ─── Searchable GHL field dropdown ───────────────────────────────────────────

function GhlFieldSelect({ value, onChange, fields, fallback }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);
  const searchRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    function handler(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Focus search input when opened
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  if (fallback) {
    return (
      <Input
        placeholder="e.g. custom_fields.value_1"
        value={value}
        onChange={(e) => onChange(e.target.value, '')}
        required
      />
    );
  }

  const filtered = fields.filter(
    (f) =>
      f.label.toLowerCase().includes(search.toLowerCase()) ||
      f.key.toLowerCase().includes(search.toLowerCase()),
  );

  const selected = fields.find((f) => f.key === value);
  const displayLabel = selected?.label ?? value ?? '';

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          !displayLabel && 'text-muted-foreground',
        )}
      >
        <span className="truncate">{displayLabel || 'Select a GHL field…'}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg">
          {/* Search */}
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search fields…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Options */}
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">No fields found.</li>
            ) : (
              filtered.map((f) => (
                <li key={f.key}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(f.key, f.label);
                      setOpen(false);
                      setSearch('');
                    }}
                    className={cn(
                      'flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                      f.key === value && 'bg-accent font-medium',
                    )}
                  >
                    <span>{f.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{f.key}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

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
    ghlValue: '',     // stored key, e.g. "custom_fields.value_1"
    ghlLabel: '',     // display label, e.g. "Job Name"
  });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // GHL fields
  const [ghlFields, setGhlFields] = useState([]);
  const [fieldsFallback, setFieldsFallback] = useState(false);

  // Load existing mapper (edit mode) and GHL fields in parallel
  useEffect(() => {
    const promises = [];

    if (!isNew) {
      promises.push(
        fetchWithAuth(`/api/mappers`)
          .then((r) => r.json())
          .then((d) => {
            const m = d.mappers?.find((x) => x.id === id);
            if (m) {
              setForm((f) => ({
                ...f,
                appSlug: m.appSlug,
                mapperType: m.mapperType,
                externalKey: m.externalKey,
                ghlValue: m.ghlValue,
              }));
            }
          })
          .catch(() => toast({ title: 'Failed to load mapper', variant: 'destructive' })),
      );
    }

    promises.push(
      fetchWithAuth('/api/ghl/fields')
        .then((r) => {
          if (!r.ok) throw new Error('fields unavailable');
          return r.json();
        })
        .then((d) => setGhlFields(d.fields ?? []))
        .catch(() => setFieldsFallback(true)),
    );

    Promise.all(promises).finally(() => setLoading(false));
  }, [id, isNew, fetchWithAuth, toast]);

  // After fields load in edit mode, backfill the display label
  useEffect(() => {
    if (ghlFields.length && form.ghlValue && !form.ghlLabel) {
      const match = ghlFields.find((f) => f.key === form.ghlValue);
      if (match) setForm((f) => ({ ...f, ghlLabel: match.label }));
    }
  }, [ghlFields, form.ghlValue, form.ghlLabel]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  function handleGhlFieldChange(key, label) {
    setForm((f) => ({ ...f, ghlValue: key, ghlLabel: label }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = isNew
        ? await fetchWithAuth('/api/mappers', {
            method: 'POST',
            body: JSON.stringify({
              appSlug: form.appSlug,
              mapperType: form.mapperType,
              externalKey: form.externalKey,
              ghlValue: form.ghlValue,
            }),
          })
        : await fetchWithAuth(`/api/mappers/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ ghlValue: form.ghlValue }),
          });

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
          {isNew ? 'Create a new field mapping.' : 'Update the GHL field for this mapper.'}
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

            {/* GHL field — searchable dropdown or fallback text input */}
            <div className="space-y-1.5">
              <Label htmlFor="ghlValue">
                GHL Field
                {fieldsFallback && (
                  <span className="ml-2 text-xs text-muted-foreground">(enter field key manually)</span>
                )}
              </Label>
              <GhlFieldSelect
                value={form.ghlValue}
                onChange={handleGhlFieldChange}
                fields={ghlFields}
                fallback={fieldsFallback}
              />
              {/* Hidden input ensures form validation fires if empty */}
              <input type="hidden" value={form.ghlValue} required />
              {form.ghlValue && !fieldsFallback && (
                <p className="text-xs text-muted-foreground font-mono">{form.ghlValue}</p>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={saving || !form.ghlValue}>
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
