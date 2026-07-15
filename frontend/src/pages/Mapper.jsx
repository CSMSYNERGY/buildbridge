import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
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

// ─── GHL pipeline / stage selector ───────────────────────────────────────────
// Used for the `pipeline` and `opportunity_stage` mapper types, where the stored
// ghlValue must be a GHL pipeline id / stage id (not a contact custom field).

function GhlPipelineStageSelect({ mode, value, onChange, pipelines, fallback }) {
  // mode: 'pipeline' (value = pipeline id) | 'stage' (value = stage id)
  const [pipelineId, setPipelineId] = useState('');

  // In stage mode + edit, derive which pipeline owns the currently selected stage.
  useEffect(() => {
    if (mode === 'stage' && value && !pipelineId) {
      const owner = pipelines.find((p) => (p.stages ?? []).some((s) => s.id === value));
      if (owner) setPipelineId(owner.id);
    }
  }, [mode, value, pipelines, pipelineId]);

  const selectClass =
    'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

  if (fallback) {
    return (
      <Input
        placeholder={mode === 'pipeline' ? 'GHL pipeline id' : 'GHL stage id'}
        value={value}
        onChange={(e) => onChange(e.target.value, '')}
        required
      />
    );
  }

  if (mode === 'pipeline') {
    return (
      <select
        className={selectClass}
        value={value}
        onChange={(e) => {
          const p = pipelines.find((x) => x.id === e.target.value);
          onChange(e.target.value, p?.name ?? '');
        }}
      >
        <option value="">Select a pipeline…</option>
        {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    );
  }

  // stage mode — pick a pipeline to scope, then a stage within it
  const selectedPipeline = pipelines.find((p) => p.id === pipelineId);
  const stages = selectedPipeline?.stages ?? [];
  return (
    <div className="space-y-2">
      <select
        className={selectClass}
        value={pipelineId}
        onChange={(e) => {
          setPipelineId(e.target.value);
          onChange('', ''); // reset stage when the pipeline changes
        }}
      >
        <option value="">Select a pipeline…</option>
        {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select
        className={selectClass}
        value={value}
        disabled={!pipelineId}
        onChange={(e) => {
          const s = stages.find((x) => x.id === e.target.value);
          onChange(e.target.value, s && selectedPipeline ? `${selectedPipeline.name} → ${s.name}` : '');
        }}
      >
        <option value="">{pipelineId ? 'Select a stage…' : 'Choose a pipeline first'}</option>
        {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  );
}

// External-key suggestions per app + mapper type (e.g. IdeaRoom order statuses).
const IDEAROOM_STATUS_KEYS = ['default', 'save', 'quote', 'deposit', 'deposit-later', 'deposit-now-token', 'deposit-now-paying', 'deposit-now-charged'];
const EXTERNAL_KEY_SUGGESTIONS = {
  idearoom: {
    opportunity_stage: IDEAROOM_STATUS_KEYS,
    contact_tag: IDEAROOM_STATUS_KEYS,
    pipeline: ['default'],
  },
};

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
  const [allMappers, setAllMappers] = useState([]);

  // GHL fields
  const [ghlFields, setGhlFields] = useState([]);
  const [fieldsFallback, setFieldsFallback] = useState(false);

  // GHL pipelines + stages (for pipeline / opportunity_stage mappers)
  const [ghlPipelines, setGhlPipelines] = useState([]);
  const [pipelinesFallback, setPipelinesFallback] = useState(false);

  // Load all mappers, existing mapper (edit mode), and GHL fields in parallel
  useEffect(() => {
    const promises = [];

    promises.push(
      fetchWithAuth('/api/mappers')
        .then((r) => r.json())
        .then((d) => {
          const mappers = d.mappers ?? [];
          setAllMappers(mappers);
          if (!isNew) {
            const m = mappers.find((x) => x.id === id);
            if (m) {
              setForm((f) => ({
                ...f,
                appSlug: m.appSlug,
                mapperType: m.mapperType,
                externalKey: m.externalKey,
                ghlValue: m.ghlValue,
              }));
            }
          }
        })
        .catch(() => toast({ title: 'Failed to load mappers', variant: 'destructive' })),
    );

    promises.push(
      fetchWithAuth('/api/ghl/fields')
        .then((r) => {
          if (!r.ok) throw new Error('fields unavailable');
          return r.json();
        })
        .then((d) => setGhlFields(d.fields ?? []))
        .catch(() => setFieldsFallback(true)),
    );

    promises.push(
      fetchWithAuth('/api/ghl/pipelines')
        .then((r) => {
          if (!r.ok) throw new Error('pipelines unavailable');
          return r.json();
        })
        .then((d) => setGhlPipelines(d.pipelines ?? []))
        .catch(() => setPipelinesFallback(true)),
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
      navigate('/buildbridge/mappers');
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  const otherMappers = allMappers.filter((m) => m.id !== id);

  // GHL value input mode depends on the mapper type.
  const isPipelineType = form.mapperType === 'pipeline';
  const isStageType = form.mapperType === 'opportunity_stage';
  const isTagType = form.mapperType === 'contact_tag';
  const ghlValueLabel = isPipelineType
    ? 'GHL Pipeline'
    : isStageType
      ? 'GHL Stage'
      : isTagType
        ? 'GHL Tag'
        : 'GHL Field';
  const ghlValueFallback =
    isPipelineType || isStageType ? pipelinesFallback : isTagType ? false : fieldsFallback;
  const externalKeySuggestions = EXTERNAL_KEY_SUGGESTIONS[form.appSlug]?.[form.mapperType] ?? [];
  const externalKeyHint = externalKeySuggestions.length ? externalKeySuggestions[0] : 'e.g. STAGE_WON';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight" style={{ color: '#3d3672' }}>{isNew ? 'New Mapper' : 'Edit Mapper'}</h1>
        <p className="text-muted-foreground mt-1">
          {isNew ? 'Create a new field mapping.' : 'Update the GHL field for this mapper.'}
        </p>
      </div>

      <div className="flex gap-6 items-start">
      <div className="w-full max-w-lg shrink-0">
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
                placeholder={externalKeyHint}
                value={form.externalKey}
                onChange={set('externalKey')}
                disabled={!isNew}
                list={externalKeySuggestions.length ? 'externalKeySuggestions' : undefined}
                required
              />
              {externalKeySuggestions.length > 0 && (
                <datalist id="externalKeySuggestions">
                  {externalKeySuggestions.map((s) => <option key={s} value={s} />)}
                </datalist>
              )}
            </div>

            {/* GHL value — pipeline / stage selector or searchable custom-field dropdown */}
            <div className="space-y-1.5">
              <Label htmlFor="ghlValue">
                {ghlValueLabel}
                {ghlValueFallback && (
                  <span className="ml-2 text-xs text-muted-foreground">(enter id manually)</span>
                )}
              </Label>
              {isPipelineType ? (
                <GhlPipelineStageSelect
                  mode="pipeline"
                  value={form.ghlValue}
                  onChange={handleGhlFieldChange}
                  pipelines={ghlPipelines}
                  fallback={pipelinesFallback}
                />
              ) : isStageType ? (
                <GhlPipelineStageSelect
                  mode="stage"
                  value={form.ghlValue}
                  onChange={handleGhlFieldChange}
                  pipelines={ghlPipelines}
                  fallback={pipelinesFallback}
                />
              ) : isTagType ? (
                <Input
                  placeholder="Tag to apply, e.g. idearoom-lead"
                  value={form.ghlValue}
                  onChange={(e) => handleGhlFieldChange(e.target.value, e.target.value)}
                  required
                />
              ) : (
                <GhlFieldSelect
                  value={form.ghlValue}
                  onChange={handleGhlFieldChange}
                  fields={ghlFields}
                  fallback={fieldsFallback}
                />
              )}
              {/* Hidden input ensures form validation fires if empty */}
              <input type="hidden" value={form.ghlValue} required />
              {form.ghlValue && !ghlValueFallback && (
                <p className="text-xs text-muted-foreground font-mono">{form.ghlValue}</p>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={saving || !form.ghlValue}>
                {saving ? 'Saving…' : isNew ? 'Create Mapper' : 'Save Changes'}
              </Button>
              <Button type="button" variant="outline" asChild>
                <Link to="/buildbridge/mappers">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      </div>

      {/* Existing mappers panel */}
      {allMappers.length > 0 && (
        <div className="flex-1 min-w-0">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base" style={{ color: '#3d3672' }}>
                Existing Mappers ({allMappers.length})
              </CardTitle>
              <CardDescription>Reference of all configured mappings.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b" style={{ backgroundColor: '#dbeaff' }}>
                    <tr>
                      <th className="px-4 py-2 text-left font-medium" style={{ color: '#3d3672' }}>App</th>
                      <th className="px-4 py-2 text-left font-medium" style={{ color: '#3d3672' }}>Type</th>
                      <th className="px-4 py-2 text-left font-medium" style={{ color: '#3d3672' }}>External Key</th>
                      <th className="px-4 py-2 text-left font-medium" style={{ color: '#3d3672' }}>GHL Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {allMappers.map((m) => (
                      <tr
                        key={m.id}
                        className={m.id === id ? 'bg-blue-50' : 'hover:bg-muted/30'}
                      >
                        <td className="px-4 py-2"><Badge variant="secondary">{m.appSlug}</Badge></td>
                        <td className="px-4 py-2 text-muted-foreground text-xs">{m.mapperType}</td>
                        <td className="px-4 py-2 font-mono text-xs">{m.externalKey}</td>
                        <td className="px-4 py-2 font-mono text-xs">{m.ghlValue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
      </div>
    </div>
  );
}
