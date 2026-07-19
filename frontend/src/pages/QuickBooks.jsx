import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { CheckCircle2, XCircle, LogOut, Link2, RefreshCw, Receipt, X, ArrowRight } from 'lucide-react';

// Small controlled on/off switch (no dedicated Switch component in the kit).
function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
      style={{ backgroundColor: checked ? '#1b7895' : '#cbd5e1' }}
    >
      <span
        className="inline-block h-5 w-5 transform rounded-full bg-white transition-transform"
        style={{ transform: checked ? 'translateX(22px)' : 'translateX(2px)' }}
      />
    </button>
  );
}

export default function QuickBooks() {
  const { fetchWithAuth } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null); // { realmId, environment } | null
  const [disconnecting, setDisconnecting] = useState(false);

  // Per-tenant feature settings
  const [settings, setSettings] = useState(null);
  const [pipelines, setPipelines] = useState([]);
  const [ghlFields, setGhlFields] = useState([]);
  const [saving, setSaving] = useState(false);

  // Custom-field mappings (QuickBooks field ↔ Synergy field)
  const [qbFields, setQbFields] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [mapDraft, setMapDraft] = useState({ qb: '', ghl: '' });
  const [savingMap, setSavingMap] = useState(false);

  const isConnected = !!config;

  useEffect(() => {
    Promise.all([
      fetchWithAuth('/api/quickbooks/config')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setConfig(d?.config ?? null))
        .catch(() => {}),
      fetchWithAuth('/api/quickbooks/settings')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setSettings(d?.settings ?? null))
        .catch(() => {}),
      fetchWithAuth('/api/ghl/pipelines')
        .then((r) => (r.ok ? r.json() : { pipelines: [] }))
        .then((d) => setPipelines(d.pipelines ?? []))
        .catch(() => {}),
      fetchWithAuth('/api/ghl/fields')
        .then((r) => (r.ok ? r.json() : { fields: [] }))
        .then((d) => setGhlFields(d.fields ?? []))
        .catch(() => {}),
      fetchWithAuth('/api/quickbooks/fields')
        .then((r) => (r.ok ? r.json() : { fields: [] }))
        .then((d) => setQbFields(d.fields ?? []))
        .catch(() => {}),
      fetchWithAuth('/api/mappers?appSlug=quickbooks')
        .then((r) => (r.ok ? r.json() : { mappers: [] }))
        .then((d) => setMappings((d.mappers ?? []).filter((m) => m.mapperType === 'custom_field')))
        .catch(() => {}),
    ]).finally(() => setLoading(false));
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

  const setField = (field) => (value) => setSettings((s) => ({ ...s, [field]: value }));

  async function handleSaveSettings() {
    setSaving(true);
    try {
      // Guard the settings-fetch-failure path: `settings` can be null here.
      const cur = settings ?? {};
      const res = await fetchWithAuth('/api/quickbooks/settings', {
        method: 'PUT',
        body: JSON.stringify({
          qboSyncDirection: cur.qboSyncDirection ?? 'off',
          qboMilestoneInvoicing: cur.qboMilestoneInvoicing ?? false,
          qboContactSyncPipelineId: cur.qboContactSyncPipelineId || null,
          qboAssignedUserField: cur.qboAssignedUserField || null,
          qboAssignedUserGhlField: cur.qboAssignedUserGhlField || null,
          qboStatusGhlField: cur.qboStatusGhlField || null,
          qboInvoiceLeadDays: Number(cur.qboInvoiceLeadDays) || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      setSettings(data.settings);
      toast({ title: 'Settings saved' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  // ── Custom-field mapping helpers ───────────────────────────────────────────
  const usedQb = new Set(mappings.map((m) => m.externalKey));
  const usedGhl = new Set(mappings.map((m) => m.ghlValue));
  const qbLabel = (id) => qbFields.find((f) => f.id === id)?.name ?? id;
  const ghlLabel = (id) => ghlFields.find((f) => (f.id ?? f.key) === id)?.label ?? id;

  async function addMapping() {
    if (!mapDraft.qb || !mapDraft.ghl) return;
    setSavingMap(true);
    try {
      const res = await fetchWithAuth('/api/mappers', {
        method: 'POST',
        body: JSON.stringify({
          appSlug: 'quickbooks',
          mapperType: 'custom_field',
          externalKey: mapDraft.qb,
          ghlValue: mapDraft.ghl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to add mapping');
      setMappings((prev) => [...prev.filter((m) => m.id !== data.mapper.id), data.mapper]);
      setMapDraft({ qb: '', ghl: '' });
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

  if (loading) return <p className="text-muted-foreground text-sm">Loading configuration…</p>;

  const s = settings ?? {
    qboSyncDirection: 'off',
    qboMilestoneInvoicing: false,
    qboContactSyncPipelineId: null,
    qboAssignedUserField: null,
    qboAssignedUserGhlField: null,
    qboStatusGhlField: null,
    qboInvoiceLeadDays: 3,
  };

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

        {/* Feature Settings — one app, opt into whichever aspects this client uses */}
        {isConnected && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base" style={{ color: '#3d3672' }}>Integration Settings</CardTitle>
              <CardDescription>
                Turn on only the parts this company needs. Both are off until you enable them.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Contact & estimate sync direction (Rockwood model) */}
              <div>
                <div className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 shrink-0" style={{ color: '#1b7895' }} />
                  <p className="text-sm font-medium" style={{ color: '#3d3672' }}>Contact &amp; estimate sync</p>
                </div>
                <p className="text-xs text-muted-foreground mt-1 mb-2">
                  Choose how contacts and estimates move between QuickBooks and HighLevel.
                </p>
                <select
                  value={s.qboSyncDirection ?? 'off'}
                  onChange={(e) => setField('qboSyncDirection')(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="off">Off — no contact/estimate sync</option>
                  <option value="qb_to_ghl">QuickBooks → HighLevel (read-only; never changes QuickBooks)</option>
                  <option value="ghl_to_qb">HighLevel → QuickBooks</option>
                  <option value="two_way">Two-way (last edit wins)</option>
                </select>
                {s.qboSyncDirection === 'qb_to_ghl' && (
                  <p className="text-xs text-muted-foreground mt-1.5">
                    QuickBooks stays the source of truth — anything updated there flows into HighLevel, and BuildBridge never writes back to QuickBooks.
                  </p>
                )}
              </div>

              {/* What to reflect FROM QuickBooks into GHL (QB→GHL directions) */}
              {(s.qboSyncDirection === 'qb_to_ghl' || s.qboSyncDirection === 'two_way') && (
                <div className="space-y-4 pl-6">
                  {/* Salesperson: QB custom field → GHL custom field */}
                  <div className="space-y-1.5">
                    <Label htmlFor="assignedField">Salesperson — QuickBooks field name</Label>
                    <Input
                      id="assignedField"
                      placeholder="e.g. Salesperson"
                      value={s.qboAssignedUserField ?? ''}
                      onChange={(e) => setField('qboAssignedUserField')(e.target.value)}
                    />
                    <Label htmlFor="assignedGhl" className="pt-1 block">Copy it into this GHL field</Label>
                    <select
                      id="assignedGhl"
                      value={s.qboAssignedUserGhlField ?? ''}
                      onChange={(e) => setField('qboAssignedUserGhlField')(e.target.value || null)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">— none —</option>
                      {ghlFields.map((f) => (
                        <option key={f.id ?? f.key} value={f.id ?? f.key}>{f.label}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      The salesperson from that QuickBooks field is copied into this GHL custom field. Set both to enable.
                    </p>
                  </div>

                  {/* QB estimate/invoice status → GHL custom field */}
                  <div className="space-y-1.5">
                    <Label htmlFor="statusGhl">QuickBooks estimate/invoice status → GHL field</Label>
                    <select
                      id="statusGhl"
                      value={s.qboStatusGhlField ?? ''}
                      onChange={(e) => setField('qboStatusGhlField')(e.target.value || null)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">— none —</option>
                      {ghlFields.map((f) => (
                        <option key={f.id ?? f.key} value={f.id ?? f.key}>{f.label}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      When an estimate or invoice is created/sent in QuickBooks, this GHL field is updated
                      (Estimate created → Estimate sent → Accepted → Invoiced). QuickBooks is never modified.
                    </p>
                  </div>
                </div>
              )}

              {/* Contact-sync pipeline — only when a direction writes into QuickBooks */}
              {(s.qboSyncDirection === 'ghl_to_qb' || s.qboSyncDirection === 'two_way') && (
                <div className="space-y-1.5 pl-6">
                  <Label htmlFor="pipeline">Push contacts to QuickBooks from pipeline</Label>
                  <select
                    id="pipeline"
                    value={s.qboContactSyncPipelineId ?? ''}
                    onChange={(e) => setField('qboContactSyncPipelineId')(e.target.value || null)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">All contacts (no pipeline filter)</option>
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Only create QuickBooks customers for contacts that have an opportunity in this pipeline
                    (e.g. once a lead moves into "Buildings"). Edits to already-synced contacts always flow through.
                  </p>
                </div>
              )}

              <div className="h-px bg-border" />

              {/* Milestone invoicing (Yoder) */}
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Receipt className="h-4 w-4 shrink-0" style={{ color: '#1b7895' }} />
                    <p className="text-sm font-medium" style={{ color: '#3d3672' }}>Milestone auto-invoicing</p>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    When an opportunity is Won, create the QuickBooks customer and schedule milestone invoices
                    (deposit, materials, roof, completion).
                  </p>
                </div>
                <Toggle checked={s.qboMilestoneInvoicing} onChange={setField('qboMilestoneInvoicing')} />
              </div>

              {s.qboMilestoneInvoicing && (
                <div className="space-y-3 pl-6">
                  <div className="space-y-1.5">
                    <Label htmlFor="leadDays">Invoice lead time (days before each milestone date)</Label>
                    <Input
                      id="leadDays"
                      type="number"
                      min="0"
                      className="max-w-[120px]"
                      value={s.qboInvoiceLeadDays ?? 3}
                      onChange={(e) => setField('qboInvoiceLeadDays')(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      The deposit is invoiced immediately on Won; the others this many days before their date.
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Map each milestone's amount and date fields under{' '}
                    <Link to="/buildbridge/mappers" className="underline" style={{ color: '#1b7895' }}>Mappers</Link>{' '}
                    (app <span className="font-mono">quickbooks</span>, types{' '}
                    <span className="font-mono">milestone_amount</span> / <span className="font-mono">milestone_date</span>).
                  </p>
                </div>
              )}

              <div className="pt-1">
                <Button
                  type="button"
                  onClick={handleSaveSettings}
                  disabled={saving}
                  className="text-white"
                  style={{ backgroundColor: '#3d3672' }}
                >
                  {saving ? 'Saving…' : 'Save settings'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Field mappings — QuickBooks custom field ↔ Synergy field */}
        {isConnected && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base" style={{ color: '#3d3672' }}>Field mappings</CardTitle>
              <CardDescription>
                Map a QuickBooks custom field to a Synergy field. A field that's already mapped is greyed
                out so it can't be used twice.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {mappings.length > 0 ? (
                <ul className="space-y-2">
                  {mappings.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                      <span className="font-medium truncate" style={{ color: '#3d3672' }}>{qbLabel(m.externalKey)}</span>
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

              {/* Add a mapping: QuickBooks field → Synergy field */}
              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                <div className="space-y-1 min-w-0">
                  <Label htmlFor="mapQb" className="text-xs">QuickBooks field</Label>
                  <select
                    id="mapQb"
                    value={mapDraft.qb}
                    onChange={(e) => setMapDraft((d) => ({ ...d, qb: e.target.value }))}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">Select…</option>
                    {qbFields.map((f) => (
                      <option key={f.id} value={f.id} disabled={usedQb.has(f.id)}>
                        {f.name}{usedQb.has(f.id) ? ' (mapped)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <ArrowRight className="mb-2.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="space-y-1 min-w-0">
                  <Label htmlFor="mapGhl" className="text-xs">Synergy field</Label>
                  <select
                    id="mapGhl"
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
                disabled={savingMap || !mapDraft.qb || !mapDraft.ghl}
                className="text-white"
                style={{ backgroundColor: '#3d3672' }}
              >
                {savingMap ? 'Adding…' : 'Add mapping'}
              </Button>

              {qbFields.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No QuickBooks custom fields found yet. Reconnect QuickBooks (and make sure custom fields are
                  set up in the QuickBooks company), then reload to populate this list.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
