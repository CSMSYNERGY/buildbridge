import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Select } from '../components/ui/select.jsx';
import { CheckCircle2, XCircle, AlertTriangle, HelpCircle, LogOut, Link2, RefreshCw, Receipt, X, Plus, Zap, ArrowRight, ArrowLeftRight, ChevronDown, ChevronUp, BookOpen } from 'lucide-react';

// The "what actually makes this happen" line under a component's title.
//
// Exists because of the specific critique that produced this layout: the page described
// three different behaviours as one undifferentiated "sync", so nothing on screen said that
// filling a date field is what creates an invoice. Each component now states its own
// trigger in the same visual slot, so the three are comparable at a glance.
function TriggerNote({ children }) {
  return (
    <div
      className="mt-2 flex items-start gap-2 rounded-md px-2.5 py-2"
      style={{ backgroundColor: '#f0f9fb', border: '1px solid #cdeaf1' }}
    >
      <Zap className="h-3.5 w-3.5 shrink-0 mt-0.5" style={{ color: '#1b7895' }} />
      <p className="text-xs leading-relaxed" style={{ color: '#1b5f75' }}>
        <span className="font-medium">What triggers this: </span>
        {children}
      </p>
    </div>
  );
}

// "3 minutes ago" / "2 days ago". Relative rather than absolute on purpose: the point of
// these timestamps is freshness ("was this checked recently?"), and a raw UTC string makes
// the reader do timezone arithmetic to answer that. Falls back to a locale date past a
// week, where the exact day matters more than the elapsed time.
function timeAgo(value) {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(value).toLocaleDateString();
}

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
  const [config, setConfig] = useState(null); // { realmId, environment, connectedAt } | null
  const [disconnecting, setDisconnecting] = useState(false);

  // ── Connection health ──────────────────────────────────────────────────────
  // Separate from `config` because "a credential row exists" and "the credential works"
  // are different facts. Conflating them is the bug this state exists to fix: on
  // 2026-07-28 this page showed a green "Connected" for 20+ hours on both live locations
  // while every sync failed, because `!!config` was the only thing it ever consulted.
  const [health, setHealth] = useState(null);       // { state:'ok'|'broken'|'unverified', message, lastOkAt, lastErrorAt }
  const [syncHealth, setSyncHealth] = useState(null); // { lastSyncAt, issues[] }
  // Distinguishes "we could not ask the server" from "not connected" — a backend outage
  // or an expired session used to render identically to a tenant who never connected.
  const [configFailed, setConfigFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, companyName, message, checkedAt }
  // True only when QuickBooks itself could not be reached for these lists. Without it an
  // auth failure printed "no custom fields in this QuickBooks company", blaming the
  // client's QuickBooks for our dead token.
  const [qbFieldsUnavailable, setQbFieldsUnavailable] = useState(false);
  const [qbItemsUnavailable, setQbItemsUnavailable] = useState(false);

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
  // Per-client milestone definitions (replaces the milestone_amount/milestone_date mappers).
  const [milestones, setMilestones] = useState([]);
  const [guideOpen, setGuideOpen] = useState(false);

  // Which QuickBooks item milestone invoices bill (a single `qb_item` mapper row).
  const [qbItems, setQbItems] = useState([]);
  const [itemMaps, setItemMaps] = useState([]);
  const [savingItemMap, setSavingItemMap] = useState(false);

  // Salesperson → QuickBooks sales document (migration 0008). `qb_salesperson`
  // mapper rows are Synergy user → the salesperson NAME QuickBooks stores, and
  // the user list is a dropdown for the same reason the QuickBooks field picker
  // is: this mapping is matched by id/email/name, so a typo fails by silently
  // never matching rather than by erroring.
  const [ghlUsers, setGhlUsers] = useState([]);
  const [spMaps, setSpMaps] = useState([]);
  const [spDraft, setSpDraft] = useState({ user: '', name: '' });
  const [savingSpMap, setSavingSpMap] = useState(false);

  // QuickBooks rep → Synergy assigned user (migration 0009). Two dropdowns: the rep
  // values seen on their own documents, and their Synergy users. A mapping is
  // required rather than name-matching because a QuickBooks dropdown puts the option
  // ID on the transaction — Rockwood's values are literally "1" and "2".
  const [repValues, setRepValues] = useState([]);
  const [repUserMaps, setRepUserMaps] = useState([]);
  const [repDraft, setRepDraft] = useState({ rep: '', user: '' });
  const [savingRepMap, setSavingRepMap] = useState(false);

  // A credential EXISTS. Deliberately still the gate for the settings + mapping cards:
  // when a token dies, the tenant's saved mappings and sync config are still valid and
  // must stay visible and editable. Hiding them would turn a token problem into apparent
  // data loss, and would remove the page they need in order to reconnect.
  const isConnected = !!config;
  // The credential WORKS. Only this drives the badge, the icon, and the alert.
  const isHealthy = isConnected && health?.state === 'ok';
  const isBroken = isConnected && health?.state === 'broken';
  // Open problems that are NOT about the token — e.g. Rockwood on 2026-07-29, whose
  // QuickBooks token was refreshing fine while its sync failed 28 times on a GoHighLevel
  // 400. Without this the card would go green and still be wrong.
  // Problems that are happening NOW (the server filters out anything a later success or a
  // period of quiet has disproved). When the credential itself is dead the red block above
  // already says "reconnect" and gives the button, so drop credential-class duplicates here
  // rather than telling someone the same thing twice and counting it as two problems.
  const openIssues = (syncHealth?.issues ?? []).filter((i) => !(
    isBroken && /reconnect below/i.test(i.summary ?? '')
  ));
  const hiddenIssueCount = Math.max(0, (syncHealth?.totalIssues ?? openIssues.length) - openIssues.length);
  // The persisted name wins; a just-completed Test fills it in before the next reload. Both
  // exist because the stored one only arrives on a page load, while the test result is
  // immediate — but the STORED one is what makes the name survive a refresh.
  const companyName = config?.companyName ?? testResult?.companyName ?? null;

  // Settings with defaults applied. Declared HERE, above every reader, rather than beside the
  // JSX that mostly uses it: itemRequiredForEstimates below runs in the render body, so a later
  // `const s` put this whole page in a temporal dead zone and every load of /buildbridge/quickbooks
  // died on "Cannot access 's' before initialization" (2026-08-04 → 08-05, 14 crashes).
  const s = settings ?? {
    qboSyncDirection: 'off',
    qboMilestoneInvoicing: false,
    qboContactSyncPipelineId: null,
    qboAssignedUserField: null,
    qboAssignedUserGhlField: null,
    qboStatusGhlField: null,
    qboRepToAssignee: false,
    qboSalespersonQbField: null,
    qboSalespersonSlot: 1,
    qboSalespersonGhlField: null,
    qboInvoiceLeadDays: 3,
  };

  // Extracted so the freshness re-read below can reuse it verbatim.
  const loadConfig = useCallback(() => (
    fetchWithAuth('/api/quickbooks/config')
      .then((r) => {
        if (!r.ok) {
          // 4xx/5xx is NOT "not connected" — say so rather than silently implying it.
          setConfigFailed(true);
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (!d) return null;
        setConfig(d.config ?? null);
        setHealth(d.health ?? null);
        return d;
      })
      .catch(() => { setConfigFailed(true); return null; })
  ), [fetchWithAuth]);

  useEffect(() => {
    let cancelled = false;
    // Captured by closure rather than read out of the Promise.all result array by index:
    // positional indices silently break the moment somebody reorders or inserts a request,
    // and the failure mode would be a card that quietly stops going red.
    let probeFailed = false;
    let configHealthState = null;
    Promise.all([
      loadConfig().then((d) => { configHealthState = d?.health?.state ?? null; }),
      fetchWithAuth('/api/quickbooks/health')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setSyncHealth(d); })
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
      // These two are the requests that DISCOVER a dead token: they hit QuickBooks, and a
      // 401 there is what makes the server mark the credential broken. Their result is
      // reported back so the settle handler below knows whether that just happened.
      // /items survived the removal of the Item Mappings card for both reasons — it is half
      // of that probe, and it fills the "Bill milestone invoices as" picker. Dropping it
      // would quietly halve how reliably this page notices a dead credential.
      fetchWithAuth('/api/quickbooks/fields')
        .then((r) => (r.ok ? r.json() : { fields: [], unavailable: true }))
        .then((d) => { setQbFields(d.fields ?? []); setQbFieldsUnavailable(!!d.unavailable); if (d.unavailable) probeFailed = true; })
        .catch(() => { setQbFieldsUnavailable(true); probeFailed = true; }),
      fetchWithAuth('/api/quickbooks/items')
        .then((r) => (r.ok ? r.json() : { items: [], unavailable: true }))
        .then((d) => { setQbItems(d.items ?? []); setQbItemsUnavailable(!!d.unavailable); if (d.unavailable) probeFailed = true; })
        .catch(() => { setQbItemsUnavailable(true); probeFailed = true; }),
      fetchWithAuth('/api/mappers?appSlug=quickbooks')
        .then((r) => (r.ok ? r.json() : { mappers: [] }))
        .then((d) => {
          const all = d.mappers ?? [];
          setMappings(all.filter((m) => m.mapperType === 'custom_field'));
          setItemMaps(all.filter((m) => m.mapperType === 'qb_item'));
          setSpMaps(all.filter((m) => m.mapperType === 'qb_salesperson'));
          setRepUserMaps(all.filter((m) => m.mapperType === 'qb_rep_user'));
        })
        .catch(() => {}),
      // Non-fatal: without the rep values the mapping row falls back to free text.
      fetchWithAuth('/api/quickbooks/rep-values')
        .then((r) => (r.ok ? r.json() : { values: [] }))
        .then((d) => setRepValues(d.values ?? []))
        .catch(() => {}),
      // Non-fatal: without the roster the salesperson picker falls back to the
      // saved values only — it must not stop the rest of the page loading.
      fetchWithAuth('/api/ghl/users')
        .then((r) => (r.ok ? r.json() : { users: [] }))
        .then((d) => setGhlUsers(d.users ?? []))
        .catch(() => {}),
      fetchWithAuth('/api/quickbooks/milestones')
        .then((r) => (r.ok ? r.json() : { definitions: [] }))
        .then((d) => setMilestones(d.definitions ?? []))
        .catch(() => {}),
    ])
      .then(() => {
        // ── Freshness re-read: fixes a race that would make this card lie on exactly the
        // load that matters most. /config is fetched in PARALLEL with /fields and /items,
        // so it reads the health row as it was BEFORE those two discovered the failure.
        // Without this, the page load that detects a dead token still renders green and
        // only a second, manual reload shows red — which is the original bug wearing a
        // different hat. Costs one extra request, and only when something actually failed.
        if (cancelled) return undefined;
        if (probeFailed && configHealthState !== 'broken') return loadConfig();
        return undefined;
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [fetchWithAuth, loadConfig]);

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

  // OAuth must run in its own top-level tab: inside the GHL iframe a same-window
  // navigation dead-ends (no Bearer header on navigations + Intuit refuses to
  // render framed). While the tab is open we poll config until the connection
  // lands, then flip the UI without a manual refresh.
  const [connecting, setConnecting] = useState(false);
  const [authUrl, setAuthUrl] = useState(null); // fallback link when the popup is blocked
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []); // cleanup on unmount

  // Ask QuickBooks, right now, whether the stored connection still works.
  //
  // `silent` is used by the connect flow, where a toast would pile on top of the
  // "QuickBooks connected" one. A failed probe is NOT an error state for this function —
  // it is the answer — so it resolves normally and updates the card.
  async function probeConnection({ silent = false } = {}) {
    setTesting(true);
    try {
      const res = await fetchWithAuth('/api/quickbooks/test', { method: 'POST' });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error || `Could not run the test (${res.status})`);
      setTestResult(d);
      // Reflect the probe in the card immediately rather than waiting for a reload: the
      // server has already recorded it against the credential row.
      setHealth((h) => ({
        ...(h ?? {}),
        state: d.ok ? 'ok' : 'broken',
        message: d.ok ? null : d.message,
        lastOkAt: d.ok ? d.checkedAt : (h?.lastOkAt ?? null),
        lastErrorAt: d.ok ? null : d.checkedAt,
      }));
      if (!silent) {
        toast({
          title: d.ok ? `Connected to ${d.companyName || 'QuickBooks'}` : 'QuickBooks is not reachable',
          description: d.ok ? 'BuildBridge can read and write in this QuickBooks company.' : d.message,
          ...(d.ok ? {} : { variant: 'destructive' }),
        });
      }
    } catch (err) {
      // The TEST failed, which says nothing about QuickBooks — do not touch `health`, or a
      // network blip would paint a working connection red.
      if (!silent) {
        toast({ title: 'Could not run the test', description: err.message, variant: 'destructive' });
      }
    } finally {
      setTesting(false);
    }
  }

  function startConnectPolling() {
    clearInterval(pollRef.current);
    setConnecting(true);
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > 3 * 60 * 1000) { // give up after 3 minutes
        clearInterval(pollRef.current);
        setConnecting(false);
        return;
      }
      try {
        const r = await fetchWithAuth('/api/quickbooks/config');
        const d = r.ok ? await r.json() : null;
        if (d?.config) {
          clearInterval(pollRef.current);
          setConnecting(false);
          setAuthUrl(null);
          setConfig(d.config);
          setHealth(d.health ?? null);
          setConfigFailed(false);
          // A fresh row is written by the OAuth callback BEFORE any QuickBooks API call is
          // attempted, so at this instant health is 'unverified', not 'ok'. Probing now
          // turns the connect flow into real proof and fills in the company name — which
          // is what lets someone notice immediately that they just connected the wrong
          // QuickBooks company.
          probeConnection({ silent: true });
          // Populate the now-unlocked cards (settings, QB fields, QB items).
          fetchWithAuth('/api/quickbooks/settings')
            .then((res) => (res.ok ? res.json() : null))
            .then((s) => setSettings(s?.settings ?? null))
            .catch(() => {});
          fetchWithAuth('/api/quickbooks/fields')
            .then((res) => (res.ok ? res.json() : { fields: [], unavailable: true }))
            .then((s) => { setQbFields(s.fields ?? []); setQbFieldsUnavailable(!!s.unavailable); })
            .catch(() => setQbFieldsUnavailable(true));
          fetchWithAuth('/api/quickbooks/items')
            .then((res) => (res.ok ? res.json() : { items: [], unavailable: true }))
            .then((s) => { setQbItems(s.items ?? []); setQbItemsUnavailable(!!s.unavailable); })
            .catch(() => setQbItemsUnavailable(true));
        }
      } catch { /* transient poll failure — keep polling */ }
    }, 3000);
  }

  async function handleConnect() {
    // Open the tab synchronously inside the click gesture (popup blockers),
    // then point it at Intuit once the authorize URL arrives.
    const oauthTab = window.open('', '_blank');
    try {
      const res = await fetchWithAuth('/api/quickbooks/connect-url');
      if (!res.ok) throw new Error(`Could not start the QuickBooks connection (${res.status})`);
      const data = await res.json();
      if (!data?.url) throw new Error('No authorize URL returned');
      if (oauthTab) oauthTab.location.href = data.url;
      else setAuthUrl(data.url); // popup blocked — render a user-clickable link instead
      startConnectPolling();
    } catch (err) {
      if (oauthTab) oauthTab.close();
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  }

  // Create/enable the legacy "Salesperson" sales-form custom field via the API
  // (the QBO UI no longer offers legacy fields; see backend createSalespersonField).
  const [creatingField, setCreatingField] = useState(false);
  async function handleCreateSalespersonField() {
    setCreatingField(true);
    try {
      const res = await fetchWithAuth('/api/quickbooks/salesperson-field', {
        method: 'POST',
        body: JSON.stringify({ name: 'Salesperson' }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error || `QuickBooks rejected the request (${res.status})`);
      setQbFields(d.fields ?? []);
      if (!s.qboAssignedUserField) setField('qboAssignedUserField')('Salesperson');
      toast({
        title: d.visibleToApi
          ? 'Salesperson field created in QuickBooks'
          : 'QuickBooks accepted the field but it is not yet visible to the API',
        description: d.visibleToApi
          ? 'It now appears on estimates and invoices in QuickBooks.'
          : 'This company may not support legacy custom fields — tell CSM Synergy support.',
        ...(d.visibleToApi ? {} : { variant: 'destructive' }),
      });
    } catch (err) {
      toast({ title: 'Could not create the field', description: err.message, variant: 'destructive' });
    } finally {
      setCreatingField(false);
    }
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

  /**
   * Save ONLY the milestone component's own two settings, immediately.
   *
   * The milestone card owns its persistence end to end — its milestone rows already save on
   * change, so its enable switch and lead time must too. Without this they depended on the
   * "Save settings" button that now lives in a DIFFERENT card, which meant you could turn
   * milestone invoicing on, add milestones, reload, and find the switch back off with your
   * milestones hidden behind it. They were saved, but they looked lost.
   *
   * A PARTIAL body, deliberately: upsertLocationSettings skips any key that is undefined, so
   * this cannot commit the sync card's half-finished edits. That matters — sync direction
   * decides whether we write to a client's QuickBooks at all, and flipping a milestone switch
   * must never be what turns that on.
   */
  async function saveMilestoneSettings(patch) {
    const next = { ...(settings ?? {}), ...patch };
    setSettings(next);                       // optimistic: the switch responds instantly
    try {
      const res = await fetchWithAuth('/api/quickbooks/settings', {
        method: 'PUT',
        body: JSON.stringify({
          qboMilestoneInvoicing: next.qboMilestoneInvoicing ?? false,
          qboInvoiceLeadDays: Number(next.qboInvoiceLeadDays) || 0,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not save');
      if (data?.settings) setSettings(data.settings);
    } catch (err) {
      // Put it back — a switch that looks saved but isn't is worse than one that snaps back.
      setSettings(settings);
      toast({ title: 'Could not save', description: err.message, variant: 'destructive' });
    }
  }

  async function handleSaveSettings() {
    setSaving(true);
    try {
      // Guard the settings-fetch-failure path: `settings` can be null here.
      const cur = settings ?? {};
      const res = await fetchWithAuth('/api/quickbooks/settings', {
        method: 'PUT',
        // Only the SYNC component's fields. The milestone switch and lead time are omitted on
        // purpose — the milestone card saves those itself, and each component owning its own
        // keys means neither can quietly overwrite the other's. Absent keys are skipped by
        // upsertLocationSettings, so a partial body is safe.
        body: JSON.stringify({
          qboSyncDirection: cur.qboSyncDirection ?? 'off',
          qboContactSyncPipelineId: cur.qboContactSyncPipelineId || null,
          qboAssignedUserField: cur.qboAssignedUserField || null,
          qboAssignedUserGhlField: cur.qboAssignedUserGhlField || null,
          qboStatusGhlField: cur.qboStatusGhlField || null,
          qboRepToAssignee: !!cur.qboRepToAssignee,
          qboSalespersonQbField: cur.qboSalespersonQbField || null,
          qboSalespersonSlot: cur.qboSalespersonSlot ?? 1,
          qboSalespersonGhlField: cur.qboSalespersonGhlField || null,
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

  // ── Salesperson mapping (Synergy user → QuickBooks salesperson name) ───────
  const userLabel = (v) => {
    const u = ghlUsers.find((x) => x.id === v || x.email === v || x.name === v);
    return u ? (u.email ? `${u.name} (${u.email})` : u.name) : v;
  };
  // The mapper's unique key is (location, app, type, externalKey), and externalKey
  // here is the QuickBooks salesperson NAME — so re-adding a name updates which
  // user points at it rather than creating a second row. That is the right shape
  // (one salesperson, one name) but it means the NAME is what must be unique, not
  // the user; a user already mapped is greyed out so the pairing stays 1:1.
  const usedSpUsers = new Set(spMaps.map((m) => m.ghlValue));

  async function addSalespersonMap() {
    if (!spDraft.user || !spDraft.name.trim()) return;
    setSavingSpMap(true);
    try {
      const res = await fetchWithAuth('/api/mappers', {
        method: 'POST',
        body: JSON.stringify({
          appSlug: 'quickbooks',
          mapperType: 'qb_salesperson',
          externalKey: spDraft.name.trim(),
          ghlValue: spDraft.user,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to add mapping');
      setSpMaps((prev) => [...prev.filter((m) => m.id !== data.mapper.id), data.mapper]);
      setSpDraft({ user: '', name: '' });
      toast({ title: 'Salesperson mapped' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSavingSpMap(false);
    }
  }

  async function deleteSalespersonMap(id) {
    try {
      const res = await fetchWithAuth(`/api/mappers/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove mapping');
      setSpMaps((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  }

  // ── QuickBooks rep → Synergy assigned user ─────────────────────────────────
  const repLabel = (v) => repValues.find((r) => r.value === v)?.label ?? v;
  const usedReps = new Set(repUserMaps.map((m) => m.externalKey));

  async function addRepUserMap() {
    if (!repDraft.rep || !repDraft.user) return;
    setSavingRepMap(true);
    try {
      const res = await fetchWithAuth('/api/mappers', {
        method: 'POST',
        body: JSON.stringify({
          appSlug: 'quickbooks',
          mapperType: 'qb_rep_user',
          externalKey: repDraft.rep,   // the QuickBooks rep value, exactly as it arrives
          ghlValue: repDraft.user,     // the Synergy user id to assign
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to add mapping');
      setRepUserMaps((prev) => [...prev.filter((m) => m.id !== data.mapper.id), data.mapper]);
      setRepDraft({ rep: '', user: '' });
      toast({ title: 'Rep mapped' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSavingRepMap(false);
    }
  }

  async function deleteRepUserMap(id) {
    try {
      const res = await fetchWithAuth(`/api/mappers/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove mapping');
      setRepUserMaps((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  }

  // ── Which QuickBooks item milestone invoices bill ───────────────────────────
  // What remains of the old Item Mappings card. That card mapped many QuickBooks items to
  // Synergy fields so an ESTIMATE could pick one per deal; Structure Studio → QuickBooks item
  // mapping is moving into Structure Studio itself (Carolyn, 2026-07-29: "it's Structure Studio
  // to QuickBooks… I just don't want you to spend more time building out items mapping in here").
  //
  // Milestone invoicing still needs to know which item to bill, and it cannot pick per deal —
  // a milestone invoice has no GHL field context, so resolveItemRef falls back to "exactly one
  // mapping = the location default". This select is therefore deliberately SINGLE-choice: it
  // keeps that one row correct instead of leaving invisible configuration steering real invoices.
  const milestoneItemMap = itemMaps.length === 1 ? itemMaps[0] : null;
  const milestoneItemId = milestoneItemMap?.externalKey ?? '';
  // Once the sync PUSHES to QuickBooks, this item stops being optional. An estimate
  // has no default to fall back on — upsertEstimate refuses without an itemRef and the
  // opportunity is skipped — whereas a milestone invoice does fall back. Same setting,
  // two very different consequences, so the copy below distinguishes them instead of
  // telling everyone they can leave it alone.
  const itemRequiredForEstimates = s.qboSyncDirection === 'ghl_to_qb' || s.qboSyncDirection === 'two_way';
  const itemLabel = (id) => {
    const it = qbItems.find((i) => i.id === id);
    if (!it) return id;
    return it.unitPrice != null ? `${it.name} ($${it.unitPrice})` : it.name;
  };

  /**
   * Point milestone invoices at a QuickBooks item (or clear the choice).
   *
   * DELETE-THEN-INSERT, never PUT. createMapper's conflict target is
   * (locationId, appSlug, mapperType, externalKey) — and externalKey IS the QuickBooks item id —
   * so POSTing a different item ADDS a second row rather than replacing the first. Two rows with
   * no per-deal field context make resolveItemRef return null, which silently bills QuickBooks'
   * default item '1' instead. PUT is equally wrong: it only changes ghlValue, not externalKey.
   */
  async function setMilestoneItem(itemId) {
    setSavingItemMap(true);
    try {
      // Clear every existing qb_item row first, so exactly one (or none) can remain.
      for (const m of itemMaps) {
        const del = await fetchWithAuth(`/api/mappers/${m.id}`, { method: 'DELETE' });
        if (!del.ok) throw new Error('Could not clear the previous item');
      }
      if (!itemId) {
        setItemMaps([]);
        toast({ title: 'Milestone invoices will use QuickBooks’ default item' });
        return;
      }
      const res = await fetchWithAuth('/api/mappers', {
        method: 'POST',
        body: JSON.stringify({
          appSlug: 'quickbooks',
          mapperType: 'qb_item',
          externalKey: itemId,
          // ghlValue is required by the endpoint and is what a per-deal estimate match would
          // use. Milestones have no deal context, so it is unused here — store the item id
          // itself rather than a field id, which would imply a mapping that does not exist.
          ghlValue: itemId,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not save the item');
      setItemMaps(data?.mapper ? [data.mapper] : []);
      toast({ title: `Milestone invoices will bill “${itemLabel(itemId)}”` });
    } catch (err) {
      toast({ title: 'Could not save the item', description: err.message, variant: 'destructive' });
    } finally {
      setSavingItemMap(false);
    }
  }

  // ── Milestone definitions (per-client milestone configuration) ──────────────
  // Replaces a hard-coded list of four milestones. A milestone is the client's own pair of
  // opportunity fields — "materials delivered dollar amount" + "materials delivered date"
  // — because every client names and structures these differently.

  // Only OPPORTUNITY fields are offered: a milestone belongs to a deal, not a person, and
  // Carolyn was explicit that this has to come from an opportunity field. The `model` flag
  // has always been on the wire from /api/ghl/fields; nothing used it until now.
  const opportunityFields = ghlFields.filter((f) => f.model === 'opportunity');
  // Fall back to every field if this location reports none as opportunity-scoped, so a
  // GHL response shape we haven't seen can't leave the dropdowns empty.
  const milestoneFieldOptions = opportunityFields.length ? opportunityFields : ghlFields;

  // Name the milestone after the field the user picked, so the normal path involves zero
  // typing. "Materials Delivered $ Amount (opportunity)" → "Materials Delivered". The user
  // can still override it, because this string prints on the QuickBooks invoice line.
  function deriveMilestoneLabel(fieldId) {
    const f = milestoneFieldOptions.find((x) => (x.id ?? x.key) === fieldId);
    if (!f) return '';
    return String(f.label ?? '')
      .replace(/\s*\(opportunity\)\s*$/i, '')
      .replace(/[\s$]*\b(dollar\s+)?amount\b\s*$/i, '')
      .replace(/\s*\$\s*$/, '')
      .trim() || String(f.label ?? '').replace(/\s*\(opportunity\)\s*$/i, '').trim();
  }

  async function saveMilestone(id, patch) {
    const current = milestones.find((m) => m.id === id);
    const body = { ...current, ...patch };
    // Don't round-trip an incomplete row: a milestone with no amount field can never
    // produce an amount, and the server rejects it. Keep the edit local until it's usable.
    if (!body.label || !body.amountField) {
      setMilestones((prev) => prev.map((m) => (m.id === id ? body : m)));
      return;
    }
    try {
      const res = await fetchWithAuth(`/api/quickbooks/milestones/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          label: body.label,
          amountField: body.amountField,
          dateField: body.dateField || null,
          sortOrder: body.sortOrder ?? 0,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not save this milestone');
      setMilestones((prev) => prev.map((m) => (m.id === id ? data.definition : m)));
    } catch (err) {
      toast({ title: 'Could not save the milestone', description: err.message, variant: 'destructive' });
    }
  }

  // Local-only until it has both required parts; created server-side on first valid save.
  function addMilestoneRow() {
    setMilestones((prev) => [
      ...prev,
      { id: `new-${Date.now()}`, label: '', amountField: '', dateField: '', sortOrder: prev.length, isNew: true },
    ]);
  }

  async function commitNewMilestone(tempId, patch) {
    const current = milestones.find((m) => m.id === tempId);
    const body = { ...current, ...patch };
    setMilestones((prev) => prev.map((m) => (m.id === tempId ? body : m)));
    if (!body.label || !body.amountField) return; // still incomplete — stay local
    try {
      const res = await fetchWithAuth('/api/quickbooks/milestones', {
        method: 'POST',
        body: JSON.stringify({
          label: body.label,
          amountField: body.amountField,
          dateField: body.dateField || null,
          sortOrder: body.sortOrder ?? 0,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not add this milestone');
      setMilestones((prev) => prev.map((m) => (m.id === tempId ? data.definition : m)));
    } catch (err) {
      toast({ title: 'Could not add the milestone', description: err.message, variant: 'destructive' });
    }
  }

  async function removeMilestone(id) {
    const row = milestones.find((m) => m.id === id);
    if (row?.isNew) { // never persisted — just drop it
      setMilestones((prev) => prev.filter((m) => m.id !== id));
      return;
    }
    try {
      const res = await fetchWithAuth(`/api/quickbooks/milestones/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not remove this milestone');
      setMilestones((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      toast({ title: 'Could not remove the milestone', description: err.message, variant: 'destructive' });
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
      {/* Page is a wide shell: the connection/status cards stay in a readable narrow
          column, while the settings + mappings sit side by side below (see the grid) so
          the space to the right of Integration Settings isn't wasted. */}
      <div className="max-w-6xl space-y-6" style={{ position: 'relative', zIndex: 1 }}>
        <div className="max-w-lg">
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: '#3d3672' }}>QuickBooks Config</h1>
          <p className="text-muted-foreground mt-1">Connect your QuickBooks Online company via secure OAuth.</p>
        </div>

        {/* Connection + connect/disconnect stay narrow — they are short, single-column
            content. 2xl rather than lg because the status row now carries TWO buttons
            (Test + Disconnect); at lg the company/verified line truncated to "· pr…". */}
        <div className="max-w-2xl space-y-6">
        {/* ── Connection Status ──────────────────────────────────────────────────
            THREE states, not two. The old card had exactly one input — does a
            credential row exist — so it could only ever say "Connected" or "Not
            connected", and it said "Connected" for 20+ hours on 2026-07-28 while both
            live locations' syncs failed on every run. Row-existence is now only the
            headline; whether the credential WORKS is a separate signal. */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              {!isConnected
                ? <XCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
                : isBroken
                  ? <AlertTriangle className="h-5 w-5 shrink-0" style={{ color: '#e53e3e' }} />
                  : isHealthy
                    ? <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: '#1b7895' }} />
                    /* 'unverified': a credential exists but has not been observed working.
                       A grey clock, NOT a green check — the whole point of this change is
                       that the page must not assert what it has not seen. */
                    : <HelpCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
              }
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" style={{ color: isBroken ? '#e53e3e' : '#3d3672' }}>
                  {!isConnected
                    ? (configFailed ? 'Status unavailable' : 'Not connected')
                    : isBroken
                      ? 'Action needed — reconnect QuickBooks'
                      : isHealthy
                        ? `Connected${companyName ? ` to ${companyName}` : ''}`
                        : 'Connected — not verified yet'}
                </p>
                {isConnected && (
                  <p className="text-sm text-muted-foreground truncate">
                    {/* The NAME leads, the realm id is the secondary detail. Showing only a
                        bare realm id is why the same QuickBooks company sat connected to two
                        sub-accounts without anyone noticing. Rendered for EVERY connected
                        state, not just the healthy one — knowing which company you're looking
                        at matters most when it's broken. */}
                    {companyName ? `${companyName} · ` : ''}Company {config.realmId} · {config.environment}
                    {isHealthy && health?.lastOkAt && ` · verified ${timeAgo(health.lastOkAt)}`}
                    {isBroken && health?.lastErrorAt && ` · failing since ${timeAgo(health.lastErrorAt)}`}
                  </p>
                )}
                {/* A backend/session failure is not evidence about QuickBooks either way. */}
                {!isConnected && configFailed && (
                  <p className="text-sm text-muted-foreground">
                    BuildBridge could not load the connection status. Reload the page, or contact CSM Synergy support if it persists.
                  </p>
                )}
              </div>
              {isConnected ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={testing}
                    onClick={() => probeConnection()}
                    className="gap-1.5"
                    title="Check right now whether BuildBridge can reach this QuickBooks company"
                  >
                    <RefreshCw className={`h-3.5 w-3.5${testing ? ' animate-spin' : ''}`} />
                    {testing ? 'Testing…' : 'Test'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disconnecting}
                    onClick={handleDisconnect}
                    className="gap-1.5"
                    style={{ borderColor: '#e53e3e', color: '#e53e3e' }}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </Button>
                </div>
              ) : (
                <Badge variant="secondary">{configFailed ? 'Unknown' : 'No connection'}</Badge>
              )}
            </div>

            {/* What to DO about it. Critical: the "Connect QuickBooks" card below is hidden
                whenever a credential row exists, so before this block a tenant with a dead
                token had no Reconnect affordance at all — their only route back was to
                guess that Disconnect-then-Connect was safe. */}
            {isBroken && (
              <div
                className="mt-3 rounded-md p-3"
                style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca' }}
              >
                <p className="text-sm" style={{ color: '#991b1b' }}>{health.message}</p>
                {health.lastOkAt && (
                  <p className="mt-1 text-xs" style={{ color: '#b91c1c' }}>
                    Last worked {timeAgo(health.lastOkAt)}. Nothing has synced since.
                  </p>
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={handleConnect}
                  disabled={connecting}
                  className="mt-2 gap-1.5 text-white"
                  style={{ backgroundColor: '#3d3672' }}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  {connecting ? 'Waiting for Intuit…' : 'Reconnect QuickBooks'}
                </Button>
              </div>
            )}

            {/* Problems that are NOT the token. Rockwood's connection was refreshing
                perfectly on 2026-07-29 while its sync failed 28 times on a GoHighLevel
                400 — a card built only on token health would have shown it green. */}
            {isConnected && openIssues.length > 0 && (
              <div
                className="mt-3 rounded-md p-3"
                style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a' }}
              >
                <p className="text-sm font-medium" style={{ color: '#92400e' }}>
                  {/* "currently" is load-bearing: the server only sends problems that are
                      still happening, and saying so is what stops this reading as a history. */}
                  {openIssues.length === 1
                    ? 'There is currently a problem with this integration'
                    : `There are currently ${openIssues.length} problems with this integration`}
                  {hiddenIssueCount > 0 && ` (${hiddenIssueCount} more not shown)`}
                </p>
                <ul className="mt-1 space-y-1">
                  {openIssues.map((iss, i) => (
                    <li key={`${(iss.kinds ?? []).join('-') || 'issue'}-${i}`} className="text-xs" style={{ color: '#b45309' }}>
                      {iss.summary}
                      {/* ALWAYS show when it last happened, not only when it repeated. Four of
                          the five lines on the 2026-07-29 report carried no time at all, so a
                          one-off from yesterday read exactly like something happening now. */}
                      {iss.lastSeenAt && (
                        <span className="opacity-80">
                          {' ('}
                          {iss.count > 1 ? `${iss.count} times, most recently ` : ''}
                          {timeAgo(iss.lastSeenAt)}
                          {')'}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs" style={{ color: '#b45309' }}>
                  CSM Synergy support can see the technical detail — send them this page.
                </p>
              </div>
            )}

            {/* Freshness. Absent for a location that has never completed a full pass, which
                must read as "never" — not be quietly omitted, and never as "just now". */}
            {isConnected && syncHealth && (
              <p className="mt-3 text-xs text-muted-foreground">
                {syncHealth.lastSyncAt
                  ? `Last completed sync ${timeAgo(syncHealth.lastSyncAt)}. BuildBridge checks about every 15 minutes.`
                  : 'No sync has completed yet for this location.'}
              </p>
            )}
          </CardContent>
        </Card>

        {!isConnected && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base" style={{ color: '#3d3672' }}>Connect QuickBooks</CardTitle>
              <CardDescription>
                Intuit opens in a new tab — approve access there and this page updates
                automatically. Tokens are encrypted at rest and refreshed automatically —
                no passwords are stored.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                onClick={handleConnect}
                disabled={connecting}
                className="w-full gap-2 text-white"
                style={{ backgroundColor: '#3d3672' }}
              >
                <Link2 className="h-4 w-4" />
                {connecting ? 'Waiting for Intuit… (finish in the new tab)' : 'Connect to QuickBooks'}
              </Button>
              {authUrl && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Pop-up blocked?{' '}
                  <a href={authUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#1b7895' }}>
                    Open Intuit in a new tab
                  </a>
                </p>
              )}
            </CardContent>
          </Card>
        )}

        </div>{/* /narrow column */}

        {/* ── Config grid: Integration Settings on the left, the mapping cards on the
             right so the space beside the settings form is used. Stacks on < lg. ── */}
        {isConnected && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">

        {isConnected && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2" style={{ color: '#3d3672' }}>
                <ArrowLeftRight className="h-4 w-4 shrink-0" style={{ color: '#1b7895' }} />
                Contact &amp; estimate sync
              </CardTitle>
              <CardDescription>
                Keeps contacts and estimates matching between QuickBooks and Synergy, and copies
                mapped fields across.
              </CardDescription>
              <TriggerNote>
                {s.qboSyncDirection === 'off'
                  ? <>Nothing yet — this component is off. Choose a direction below to switch it on.</>
                  : <>Runs on a <strong>schedule, about every 15 minutes</strong>. It looks for anything
                    changed since the last run and copies it across. No action is needed to set it off.</>}
              </TriggerNote>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Contact & estimate sync direction (Rockwood model) */}
              <div>
                <div className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 shrink-0" style={{ color: '#1b7895' }} />
                  <p className="text-sm font-medium" style={{ color: '#3d3672' }}>Direction</p>
                </div>
                <p className="text-xs text-muted-foreground mt-1 mb-2">
                  Choose how contacts and estimates move between QuickBooks and Synergy.
                </p>
                <Select
                  value={s.qboSyncDirection ?? 'off'}
                  onChange={(e) => setField('qboSyncDirection')(e.target.value)}
                >
                  <option value="off">Off — no contact/estimate sync</option>
                  <option value="qb_to_ghl">QuickBooks → Synergy (read-only; never changes QuickBooks)</option>
                  <option value="ghl_to_qb">Synergy → QuickBooks</option>
                  <option value="two_way">Two-way (last edit wins)</option>
                </Select>
                {s.qboSyncDirection === 'qb_to_ghl' && (
                  <p className="text-xs text-muted-foreground mt-1.5">
                    QuickBooks stays the source of truth — anything updated there flows into Synergy, and BuildBridge never writes back to QuickBooks.
                  </p>
                )}
              </div>

              {/* What to reflect FROM QuickBooks into GHL (QB→GHL directions) */}
              {(s.qboSyncDirection === 'qb_to_ghl' || s.qboSyncDirection === 'two_way') && (
                <div className="space-y-4 pl-6">
                  {/* Salesperson: QB custom field → Synergy custom field */}
                  <div className="space-y-1.5">
                    <Label htmlFor="assignedField">Salesperson — QuickBooks field</Label>
                    {/* Dropdown fed by the live QuickBooks field list (same source as
                        the Field mappings card) — typing field names invites typos and
                        silent mismatches. A saved value missing from the fetched list
                        stays selectable so a transient fetch failure can't wipe it. */}
                    <Select
                      id="assignedField"
                      value={s.qboAssignedUserField ?? ''}
                      onChange={(e) => setField('qboAssignedUserField')(e.target.value || null)}
                    >
                      <option value="">— none —</option>
                      {s.qboAssignedUserField &&
                        !qbFields.some((f) => f.name === s.qboAssignedUserField) && (
                          <option value={s.qboAssignedUserField}>
                            {s.qboAssignedUserField} (saved)
                          </option>
                        )}
                      {qbFields.map((f) => (
                        <option key={f.id ?? f.name} value={f.name}>{f.name}</option>
                      ))}
                    </Select>
                    {qbFields.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        {qbFieldsUnavailable
                          /* Never claim the company has no fields when we could not ask. */
                          ? 'BuildBridge could not read the custom fields from QuickBooks — fix the connection above, then reload.'
                          : 'No custom fields in this QuickBooks company yet — create one with the button below and it will appear here.'}
                      </p>
                    )}
                    <Label htmlFor="assignedGhl" className="pt-1 block">Copy it into this Synergy field</Label>
                    <Select
                      id="assignedGhl"
                      value={s.qboAssignedUserGhlField ?? ''}
                      onChange={(e) => setField('qboAssignedUserGhlField')(e.target.value || null)}
                    >
                      <option value="">— none —</option>
                      {ghlFields.map((f) => (
                        <option key={f.id ?? f.key} value={f.id ?? f.key}>{f.label}</option>
                      ))}
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Read from the <strong>estimate or invoice</strong> — that is where QuickBooks keeps sales-form
                      fields like <code>Rep</code>, even when they are marked hidden on the printed form. The most
                      recent document for each customer wins. Copying it into a Synergy field is optional; the
                      usual choice is to <strong>assign the Synergy user</strong> instead — see below.
                    </p>
                  </div>

                  {/* Rep → assigned user. Ahsan, 2026-08-01: "I should be able to click a
                      drop down for assigned users in Synergy and select Cody in there."
                      Needs no new field in the client's CRM, which is the whole point. */}
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm font-medium" style={{ color: '#3d3672' }}>
                      <input
                        type="checkbox"
                        checked={!!s.qboRepToAssignee}
                        onChange={(e) => setField('qboRepToAssignee')(e.target.checked)}
                      />
                      Set the Synergy <strong>assigned user</strong> from the QuickBooks rep
                    </label>
                    <p className="text-xs text-muted-foreground">
                      QuickBooks sends the dropdown's <strong>internal value</strong>, not the name — on this company
                      they are <code>1</code> and <code>2</code> — so each one has to be pointed at a person once.
                      Nothing is assigned until a rep is mapped and this box is ticked.
                    </p>

                    {s.qboRepToAssignee && (
                      <>
                        {repUserMaps.length > 0 ? (
                          <ul className="space-y-2">
                            {repUserMaps.map((m) => (
                              <li key={m.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                                <span className="font-medium truncate" style={{ color: '#3d3672' }}>
                                  {repLabel(m.externalKey)}
                                </span>
                                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span className="truncate" style={{ color: '#1b7895' }}>{userLabel(m.ghlValue)}</span>
                                <button
                                  type="button"
                                  onClick={() => deleteRepUserMap(m.id)}
                                  className="ml-auto text-xs text-muted-foreground hover:text-destructive"
                                >
                                  Remove
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No reps mapped yet — nothing will be assigned.
                          </p>
                        )}
                        <div className="flex gap-2">
                          <Select
                            value={repDraft.rep}
                            onChange={(e) => setRepDraft((d) => ({ ...d, rep: e.target.value }))}
                          >
                            <option value="">QuickBooks rep…</option>
                            {repValues.map((r) => (
                              <option key={r.value} value={r.value} disabled={usedReps.has(r.value)}>
                                {r.label === r.value ? r.value : `${r.label} (${r.value})`}
                              </option>
                            ))}
                          </Select>
                          <Select
                            value={repDraft.user}
                            onChange={(e) => setRepDraft((d) => ({ ...d, user: e.target.value }))}
                          >
                            <option value="">Synergy user…</option>
                            {ghlUsers.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.email ? `${u.name} (${u.email})` : u.name}
                              </option>
                            ))}
                          </Select>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={savingRepMap || !repDraft.rep || !repDraft.user}
                            onClick={addRepUserMap}
                          >
                            {savingRepMap ? 'Adding…' : 'Add'}
                          </Button>
                        </div>
                        {repValues.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            No rep values found on recent estimates or invoices yet. Pick the QuickBooks field above
                            first, then reload.
                          </p>
                        )}
                      </>
                    )}
                    {/* QBO's UI no longer offers legacy sales-form custom fields, and
                        only legacy fields are visible to the API — so the app creates
                        the field itself via the QuickBooks API. */}
                    <div className="pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={creatingField}
                        onClick={handleCreateSalespersonField}
                        className="gap-1.5"
                        style={{ borderColor: '#1b7895', color: '#1b7895' }}
                      >
                        <RefreshCw className={creatingField ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                        {creatingField ? 'Creating in QuickBooks…' : 'Create "Salesperson" field in QuickBooks'}
                      </Button>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Adds a "Salesperson" custom field to this company's sales forms
                        (estimates/invoices) so it can be filled in QuickBooks and synced here.
                      </p>
                    </div>
                  </div>

                  {/* QB estimate/invoice status → Synergy custom field */}
                  <div className="space-y-1.5">
                    <Label htmlFor="statusGhl">QuickBooks estimate/invoice status → Synergy field</Label>
                    <Select
                      id="statusGhl"
                      value={s.qboStatusGhlField ?? ''}
                      onChange={(e) => setField('qboStatusGhlField')(e.target.value || null)}
                    >
                      <option value="">— none —</option>
                      {ghlFields.map((f) => (
                        <option key={f.id ?? f.key} value={f.id ?? f.key}>{f.label}</option>
                      ))}
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      When an estimate or invoice is created/sent in QuickBooks, this Synergy field is updated
                      (Estimate created → Estimate sent → Accepted → Invoiced). QuickBooks is never modified.
                    </p>
                  </div>
                </div>
              )}

              {/* Contact-sync pipeline — only when a direction writes into QuickBooks */}
              {(s.qboSyncDirection === 'ghl_to_qb' || s.qboSyncDirection === 'two_way') && (
                <div className="space-y-1.5 pl-6">
                  <Label htmlFor="pipeline">Push contacts to QuickBooks from pipeline</Label>
                  <Select
                    id="pipeline"
                    value={s.qboContactSyncPipelineId ?? ''}
                    onChange={(e) => setField('qboContactSyncPipelineId')(e.target.value || null)}
                  >
                    <option value="">All contacts (no pipeline filter)</option>
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Only create QuickBooks customers for contacts that have an opportunity in this pipeline
                    (e.g. once a lead moves into "Buildings"). Edits to already-synced contacts always flow through.
                  </p>
                </div>
              )}

              {/* Salesperson → QuickBooks (GHL→QBO). QuickBooks' API never says who is
                  logged in, so the rep has to be carried across from Synergy and written
                  onto the estimate as a sales-form custom field. */}
              {(s.qboSyncDirection === 'ghl_to_qb' || s.qboSyncDirection === 'two_way') && (
                <div className="space-y-3 pl-6">
                  <div className="space-y-1.5">
                    <Label htmlFor="spQbField">Write the salesperson into this QuickBooks field</Label>
                    <div className="flex gap-2">
                      <Select
                        id="spQbField"
                        value={s.qboSalespersonQbField ?? ''}
                        onChange={(e) => setField('qboSalespersonQbField')(e.target.value || null)}
                      >
                        <option value="">— off —</option>
                        {s.qboSalespersonQbField
                          && !qbFields.some((f) => f.name === s.qboSalespersonQbField) && (
                            <option value={s.qboSalespersonQbField}>{s.qboSalespersonQbField} (saved)</option>
                        )}
                        {qbFields.map((f) => (
                          <option key={f.id ?? f.name} value={f.name}>{f.name}</option>
                        ))}
                      </Select>
                      {/* The slot IS QuickBooks' DefinitionId for the field — it has to
                          match the slot the company has that field in, or the write is
                          rejected. Three is all QuickBooks offers. */}
                      <Select
                        id="spSlot"
                        value={String(s.qboSalespersonSlot ?? 1)}
                        onChange={(e) => setField('qboSalespersonSlot')(Number(e.target.value))}
                        style={{ maxWidth: 110 }}
                      >
                        <option value="1">Slot 1</option>
                        <option value="2">Slot 2</option>
                        <option value="3">Slot 3</option>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Optional, and the reverse of the salesperson setting above: this <strong>writes</strong> a rep
                      from Synergy onto new QuickBooks estimates. Most companies want the read direction instead —
                      leave this off unless you specifically need Synergy to set the rep in QuickBooks.
                    </p>
                  </div>

                  {s.qboSalespersonQbField && (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="spGhlField">Or take it from this Synergy field on the deal (optional)</Label>
                        <Select
                          id="spGhlField"
                          value={s.qboSalespersonGhlField ?? ''}
                          onChange={(e) => setField('qboSalespersonGhlField')(e.target.value || null)}
                        >
                          <option value="">— use the assigned user —</option>
                          {ghlFields.map((f) => (
                            <option key={f.id ?? f.key} value={f.id ?? f.key}>{f.label}</option>
                          ))}
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          When this field has a value on the opportunity it wins — a name typed on the deal
                          beats the rule below. Otherwise the deal's assigned user is looked up here:
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label>Synergy user → QuickBooks salesperson</Label>
                        {spMaps.length > 0 ? (
                          <ul className="space-y-2">
                            {spMaps.map((m) => (
                              <li key={m.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                                <span className="truncate" style={{ color: '#1b7895' }}>{userLabel(m.ghlValue)}</span>
                                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span className="font-medium truncate" style={{ color: '#3d3672' }}>{m.externalKey}</span>
                                <button
                                  type="button"
                                  onClick={() => deleteSalespersonMap(m.id)}
                                  className="ml-auto text-xs text-muted-foreground hover:text-destructive"
                                >
                                  Remove
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No one is mapped yet — estimates will go across with the salesperson blank.
                          </p>
                        )}
                        <div className="flex gap-2">
                          <Select
                            value={spDraft.user}
                            onChange={(e) => setSpDraft((d) => ({ ...d, user: e.target.value }))}
                          >
                            <option value="">Synergy user…</option>
                            {ghlUsers.map((u) => (
                              <option key={u.id} value={u.id} disabled={usedSpUsers.has(u.id)}>
                                {u.email ? `${u.name} (${u.email})` : u.name}
                              </option>
                            ))}
                          </Select>
                          <Input
                            value={spDraft.name}
                            onChange={(e) => setSpDraft((d) => ({ ...d, name: e.target.value }))}
                            placeholder="Name as QuickBooks stores it"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={savingSpMap || !spDraft.user || !spDraft.name.trim()}
                            onClick={addSalespersonMap}
                          >
                            {savingSpMap ? 'Adding…' : 'Add'}
                          </Button>
                        </div>
                        {ghlUsers.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            BuildBridge could not read the user list from Synergy — reload, and check the
                            connection if it stays empty.
                          </p>
                        )}
                      </div>
                    </>
                  )}
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
              <TriggerNote>
                Used by the sync beside this card — <strong>every 15 minutes</strong>, on the same run.
                Adding a mapping here changes what that sync copies; it does not run anything on its own.
              </TriggerNote>
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
                  <Select
                    id="mapQb"
                    value={mapDraft.qb}
                    onChange={(e) => setMapDraft((d) => ({ ...d, qb: e.target.value }))}
                  >
                    <option value="">Select…</option>
                    {qbFields.map((f) => (
                      <option key={f.id} value={f.id} disabled={usedQb.has(f.id)}>
                        {f.name}{usedQb.has(f.id) ? ' (mapped)' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                <ArrowRight className="mb-2.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="space-y-1 min-w-0">
                  <Label htmlFor="mapGhl" className="text-xs">Synergy field</Label>
                  <Select
                    id="mapGhl"
                    value={mapDraft.ghl}
                    onChange={(e) => setMapDraft((d) => ({ ...d, ghl: e.target.value }))}
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
                  </Select>
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
                  {qbFieldsUnavailable
                    ? 'BuildBridge could not read the custom fields from QuickBooks, so this list is empty for that reason — not because the company has none. Fix the connection at the top of this page, then reload.'
                    : 'No QuickBooks custom fields found yet. Make sure custom fields are set up in the QuickBooks company, then reload to populate this list.'}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        </div>
        )}{/* /config grid */}

        {/* ══ COMPONENT 2 — Milestone invoicing (SmartBuild / post-frame model) ══════
            Its own component, not a sub-section of the sync above, because a client can
            run either one or both: Yoder Barnes sells sheds through one model and post-frame
            through this one. Enabling this must not require enabling the other. */}
        {isConnected && (
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <CardTitle className="text-base flex items-center gap-2" style={{ color: '#3d3672' }}>
                    <Receipt className="h-4 w-4 shrink-0" style={{ color: '#1b7895' }} />
                    Milestone invoicing
                  </CardTitle>
                  <CardDescription>
                    For jobs billed in stages — a deposit, then payments as the build progresses.
                  </CardDescription>
                </div>
                {/* Saves on the spot — see saveMilestoneSettings. This card has no Save button
                    because everything in it persists as you change it. */}
                <Toggle
                  checked={s.qboMilestoneInvoicing}
                  onChange={(v) => saveMilestoneSettings({ qboMilestoneInvoicing: v })}
                />
              </div>
              <TriggerNote>
                Marking an opportunity <strong>Won</strong> builds its invoice schedule. Each milestone's
                invoice is then created <strong>{s.qboInvoiceLeadDays ?? 3} day{(s.qboInvoiceLeadDays ?? 3) === 1 ? '' : 's'} before
                the date in its date field</strong> — so filling that date in is what creates the invoice.
                A milestone with no date field is invoiced as soon as the deal is Won.
              </TriggerNote>
            </CardHeader>

            {s.qboMilestoneInvoicing && (
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="leadDays">Create each invoice this far ahead of its date</Label>
                  <Select
                    id="leadDays"
                    className="max-w-[220px]"
                    value={String(s.qboInvoiceLeadDays ?? 3)}
                    onChange={(e) => saveMilestoneSettings({ qboInvoiceLeadDays: e.target.value })}
                  >
                    {/* A dropdown rather than a number box: nothing on this page should need
                        typing, and these are the only values anyone actually picks. */}
                    {[0, 1, 2, 3, 5, 7, 10, 14, 21, 30].map((n) => (
                      <option key={n} value={String(n)}>
                        {n === 0 ? 'On the milestone date' : `${n} day${n === 1 ? '' : 's'} before`}
                      </option>
                    ))}
                  </Select>
                </div>

                {/* Replaces the old Item Mappings card. A milestone invoice has no product
                    selection to read — it bills a stage of a job — so there is one choice per
                    client, not one per field. */}
                <div className="space-y-1.5">
                  <Label htmlFor="milestoneItem">
                    {itemRequiredForEstimates ? 'Bill invoices and estimates as' : 'Bill milestone invoices as'}
                  </Label>
                  <Select
                    id="milestoneItem"
                    className="max-w-[320px]"
                    value={milestoneItemId}
                    disabled={savingItemMap}
                    onChange={(e) => setMilestoneItem(e.target.value)}
                  >
                    {/* "Let QuickBooks choose" is safe for a milestone INVOICE — that path
                        falls back to a default item. It is NOT safe once the sync pushes
                        ESTIMATES: those fail closed with no item, and the opportunity is
                        skipped silently. Rockwood followed this option's advice and lost
                        every estimate for three days, so it says so now rather than
                        presenting the two cases as equivalent. */}
                    <option value="">
                      {itemRequiredForEstimates
                        ? "QuickBooks' default item — ⚠ estimates will NOT sync"
                        : "QuickBooks' default item"}
                    </option>
                    {qbItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}{i.unitPrice != null ? ` ($${i.unitPrice})` : ''}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {itemMaps.length > 1 ? (
                      <>
                        This company has <strong>{itemMaps.length} items</strong> saved from the older
                        setup, so BuildBridge can't tell which one to bill and falls back to QuickBooks'
                        default. Pick one above to replace them.
                      </>
                    ) : qbItems.length === 0 ? (
                      qbItemsUnavailable
                        ? "BuildBridge could not read Products & Services from QuickBooks, so this list is empty for that reason — not because the company has none. Fix the connection at the top of this page, then reload."
                        : 'No QuickBooks items found yet. Add a product or service in QuickBooks, then reload. Until then invoices use QuickBooks’ default item.'
                    ) : (
                      <>
                        The product or service every milestone invoice{itemRequiredForEstimates ? ' and every synced estimate' : ''} is billed against.
                        {milestoneItemMap
                          ? <> Currently <strong>{itemLabel(milestoneItemId)}</strong>.</>
                          : itemRequiredForEstimates
                            ? <> <strong style={{ color: '#B91C1C' }}>Nothing is chosen, so estimates are not reaching QuickBooks at all.</strong> An estimate has no default to fall back on — it is skipped instead. Pick an item to start them syncing.</>
                            : ' Leave this alone to let QuickBooks choose.'}
                      </>
                    )}
                  </p>
                </div>

                <div className="space-y-2 pt-1">
                  <p className="text-xs font-medium" style={{ color: '#3d3672' }}>Your milestones</p>
                  <p className="text-xs text-muted-foreground">
                    Pick the opportunity field holding each milestone's amount, and the field holding its
                    date. The name is taken from the field you pick — edit it if you want something
                    different on the invoice.
                  </p>

                  {milestones.length === 0 && (
                    <p className="text-xs text-muted-foreground pt-1">
                      No milestones yet. Add one below — for example an amount field called
                      “Deposit” with no date (invoiced on Won), then “Materials Delivered” with its
                      matching date field.
                    </p>
                  )}

                  {milestones.map((ms) => {
                    const commit = ms.isNew
                      ? (patch) => commitNewMilestone(ms.id, patch)
                      : (patch) => saveMilestone(ms.id, patch);
                    return (
                      <div key={ms.id} className="rounded-md border border-input p-2.5 space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label className="text-xs">Amount field</Label>
                            <Select
                              size="compact"
                              aria-label="Milestone amount field"
                              value={ms.amountField ?? ''}
                              onChange={(e) => {
                                const amountField = e.target.value;
                                // Auto-name from the chosen field, but never clobber a name
                                // the user has already edited.
                                //
                                // `autoLabel` is CLIENT-ONLY and deliberately so: the server
                                // neither stores nor returns it, so saveMilestone's
                                // `setMilestones(... data.definition)` drops it on every save.
                                // That is what makes this safe rather than a bug — read it as
                                // "autoLabel is only ever true for a row still being built
                                // locally". Persisted row → undefined → the `ms.label` branch
                                // wins and a hand-typed name survives. Row still local and
                                // auto-named → true → the name re-derives as you try different
                                // amount fields, which is the point.
                                //
                                // So do NOT "fix" this by persisting autoLabel: that would make
                                // a saved auto-name re-derive on the next amount-field change,
                                // silently rewriting a line that prints on a real invoice.
                                const label = ms.label && !ms.autoLabel ? ms.label : deriveMilestoneLabel(amountField);
                                commit({ amountField, label, autoLabel: true });
                              }}
                            >
                              <option value="">Choose a field…</option>
                              {milestoneFieldOptions.map((f) => (
                                <option key={`a-${ms.id}-${f.id ?? f.key}`} value={f.id ?? f.key}>{f.label}</option>
                              ))}
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Date field</Label>
                            <Select
                              size="compact"
                              aria-label="Milestone date field"
                              value={ms.dateField ?? ''}
                              onChange={(e) => commit({ dateField: e.target.value })}
                            >
                              {/* The explicit "no date" choice. This is what used to be the
                                  hard-coded deposit special case. */}
                              <option value="">None — invoice as soon as it's Won</option>
                              {milestoneFieldOptions.map((f) => (
                                <option key={`d-${ms.id}-${f.id ?? f.key}`} value={f.id ?? f.key}>{f.label}</option>
                              ))}
                            </Select>
                          </div>
                        </div>
                        <div className="flex items-end gap-2">
                          <div className="space-y-1 flex-1 min-w-0">
                            <Label className="text-xs">Name on the invoice</Label>
                            <Input
                              className="h-9 text-xs"
                              placeholder="Taken from the amount field"
                              value={ms.label ?? ''}
                              onChange={(e) => setMilestones((prev) => prev.map((m) => (
                                m.id === ms.id ? { ...m, label: e.target.value, autoLabel: false } : m
                              )))}
                              onBlur={() => commit({ label: ms.label, autoLabel: false })}
                            />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Remove milestone"
                            className="shrink-0"
                            onClick={() => removeMilestone(ms.id)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {ms.dateField
                            ? `Invoices ${s.qboInvoiceLeadDays ?? 3} day${(s.qboInvoiceLeadDays ?? 3) === 1 ? '' : 's'} before ${ghlLabel(ms.dateField)} is reached.`
                            : 'Invoices as soon as the opportunity is marked Won.'}
                        </p>
                      </div>
                    );
                  })}

                  <Button type="button" variant="outline" size="sm" onClick={addMilestoneRow} className="gap-1.5">
                    <Plus className="h-3.5 w-3.5" />
                    Add milestone
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        )}

        {/* Embedded setup guide — the config is the top of the page; this reference sits below it */}
        <Card>
          <CardHeader className="cursor-pointer select-none" onClick={() => setGuideOpen((v) => !v)}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 shrink-0" style={{ color: '#1b7895' }} />
                <CardTitle className="text-base" style={{ color: '#3d3672' }}>How the QuickBooks integration works</CardTitle>
              </div>
              {guideOpen
                ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
            </div>
            <CardDescription>A quick plain-English guide for setting this up.</CardDescription>
          </CardHeader>
          {guideOpen && (
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <div>
                <p className="font-medium" style={{ color: '#3d3672' }}>Two parts, switched on separately</p>
                <p className="mt-1">
                  BuildBridge links QuickBooks and Synergy so information flows automatically — no double
                  entry. There are two parts, and they work independently: use one, or run both
                  together. Each is triggered by something different, which is the important bit:
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li>
                    <strong>Contact &amp; estimate sync</strong> — keeps contacts, salesperson and
                    estimate/invoice status matching, and copies your mapped fields across.
                    <em> Triggered on a schedule, roughly every 15 minutes.</em>
                  </li>
                  <li>
                    <strong>Milestone invoicing</strong> — for jobs billed in stages.
                    <em> Triggered by your own opportunity fields: marking the deal Won builds the
                    schedule, and filling in a milestone's date field is what creates that invoice.</em>
                  </li>
                </ul>
              </div>
              <div>
                <p className="font-medium" style={{ color: '#3d3672' }}>Setup</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5">
                  <li>Click <strong>Connect to QuickBooks</strong> and approve access at Intuit (no passwords are stored). Check the company name shown afterwards is the right business.</li>
                  <li>If you want the sync: choose a <strong>direction</strong> — QuickBooks → Synergy is read-only and safe — then add any <strong>Field mappings</strong>.</li>
                  <li>If you bill in stages: turn on <strong>Milestone invoicing</strong> and add a milestone for each stage, choosing the opportunity field that holds its amount and the one that holds its date. Leave the date blank for anything billed straight away, like a deposit. Optionally pick which QuickBooks product or service those invoices are billed as.</li>
                  <li>Save. Nothing needs to be run by hand.</li>
                </ol>
              </div>
              <div>
                <p className="font-medium" style={{ color: '#3d3672' }}>Common questions</p>
                <p className="mt-1"><strong>Can I use more than one part at once?</strong> Yes — that's the point of them being separate. Selling sheds through one process and post-frame buildings through another is a normal setup.</p>
                <p className="mt-1"><strong>Why hasn't a milestone been invoiced?</strong> Most often its date field hasn't been filled in on the opportunity yet, or the deal isn't marked Won. Each milestone above shows exactly what it's waiting for.</p>
                <p className="mt-1"><strong>Will this change my QuickBooks?</strong> Not in QuickBooks → Synergy mode — it only reads. It writes to QuickBooks only if you pick "Synergy → QuickBooks", "Two-way", or milestone invoicing.</p>
                <p className="mt-1"><strong>Is it secure?</strong> You approve access on Intuit's own sign-in; your password is never stored. You can disconnect any time above.</p>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}
