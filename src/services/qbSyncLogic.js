// Pure QuickBooks ↔ GHL sync decision logic — no I/O, unit-testable in isolation
// (kept free of db/env/network imports so tests don't drag in the whole app).

/**
 * Which halves of the sync run for a given per-tenant direction.
 * The read-only-QuickBooks guarantee lives here: 'qb_to_ghl' must yield
 * pushToQb=false so no code path can write to QuickBooks.
 */
export function syncFlags(direction) {
  return {
    pullFromQb: direction === 'qb_to_ghl' || direction === 'two_way',
    pushToQb: direction === 'ghl_to_qb' || direction === 'two_way',
  };
}

// QuickBooks sales-doc status ladder reflected into GHL. Higher wins.
export const QB_STATUS_RANK = {
  'Estimate created': 1,
  'Estimate sent': 2,
  Accepted: 3,
  Invoiced: 4,
};

/**
 * Map a QBO Estimate to a status label. Check acceptance FIRST: an accepted
 * estimate was almost always emailed too, so "Accepted" must win over
 * "Estimate sent" or the Accepted rung would be unreachable in practice.
 */
export function estimateStatus(estimate) {
  const txn = estimate?.TxnStatus ?? '';
  if (txn === 'Accepted' || txn === 'Closed') return 'Accepted';
  if ((estimate?.EmailStatus ?? '') === 'EmailSent') return 'Estimate sent';
  return 'Estimate created';
}

/**
 * Merge one GHL custom field into a contact's existing custom-field array,
 * replacing any prior value for the same field. Returned as [{id,value}] so a
 * PUT never wipes other custom fields even if GHL replaces the array wholesale.
 */
export function mergeCustomFields(existing, newField) {
  const targetId = newField.id;
  const kept = (existing ?? [])
    .filter((f) => f && (f.id ?? f.fieldKey) != null && f.id !== targetId && f.fieldKey !== targetId)
    .map((f) => ({ id: f.id ?? f.fieldKey, value: f.value ?? f.fieldValue }));
  return [...kept, newField];
}

/**
 * Should `incoming` overwrite the GHL field's `current` value?
 * Never downgrade a recognized status; overwrite when empty or unrecognized.
 */
export function shouldUpgradeStatus(current, incoming) {
  if (!current) return true;
  const c = QB_STATUS_RANK[current];
  const i = QB_STATUS_RANK[incoming] ?? 0;
  if (c === undefined) return true; // unknown current → overwrite with a known status
  return i > c;
}

/**
 * Derive a single display name from a GHL contact's fields, preferring an
 * explicit contactName, then first+last, then a plain name. Returns null only
 * when nothing usable is present (fixes the old `?? null` that never fired
 * because ''.join always returns a string).
 */
export function deriveContactName({ contactName, firstName, lastName, name } = {}) {
  const combined = [firstName, lastName].filter(Boolean).join(' ').trim();
  return (contactName && contactName.trim()) || combined || (name && name.trim()) || null;
}

/**
 * Map a QBO address (Customer BillAddr / ShipAddr) to GHL contact address
 * fields. Handles both structured addresses (City / CountrySubDivisionCode /
 * PostalCode) and free-form ones (Line1..Line5, where Line1 is often the
 * recipient name — dropped when it just repeats the customer's display name).
 * Returns {} when there's nothing to map.
 */
export function qbAddressToGhl(addr, displayName) {
  if (!addr || typeof addr !== 'object') return {};
  const out = {};

  const hasStructured = addr.City || addr.CountrySubDivisionCode || addr.PostalCode || addr.Country;
  if (hasStructured) {
    const street = [addr.Line1, addr.Line2, addr.Line3].filter(Boolean).join(', ');
    if (street) out.address1 = street;
    if (addr.City) out.city = addr.City;
    if (addr.CountrySubDivisionCode) out.state = addr.CountrySubDivisionCode;
    if (addr.PostalCode) out.postalCode = addr.PostalCode;
    if (addr.Country) out.country = addr.Country;
    return out;
  }

  // Free-form: Line1 is often the recipient name — drop it if it matches.
  const lines = [addr.Line1, addr.Line2, addr.Line3, addr.Line4, addr.Line5].filter(Boolean);
  const name = (displayName ?? '').trim();
  const withoutName = name ? lines.filter((l) => l.trim() !== name) : lines;
  const street = (withoutName.length ? withoutName : lines).join(', ');
  if (street) out.address1 = street;
  return out;
}

/**
 * Map a GHL contact's address fields to a QBO BillAddr object — the reverse of
 * qbAddressToGhl. Returns null when the contact has no address fields at all,
 * so callers can omit BillAddr entirely (QBO treats BillAddr as a whole object
 * even on a sparse update: sending one replaces the customer's existing
 * address, so it must only be sent when GHL actually has an address to say).
 */
export function ghlAddressToQb({ address1, city, state, postalCode, country } = {}) {
  if (!address1 && !city && !state && !postalCode && !country) return null;
  return {
    ...(address1 ? { Line1: address1 } : {}),
    ...(city ? { City: city } : {}),
    ...(state ? { CountrySubDivisionCode: state } : {}),
    ...(postalCode ? { PostalCode: postalCode } : {}),
    ...(country ? { Country: country } : {}),
  };
}

/**
 * Build GHL contact customFields entries [{id, value}] from configured
 * QuickBooks→GHL custom-field mappings (mappings = { '<QBO field label>':
 * '<GHL field id>' }). Reads each QBO field off the customer by name; skips
 * fields that are unset on this customer or unmapped.
 */
export function qbCustomFieldEntries(customer, mappings) {
  const out = [];
  for (const [qbField, ghlId] of Object.entries(mappings ?? {})) {
    if (!ghlId) continue;
    const value = readQbCustomerField(customer, qbField);
    if (value) out.push({ id: ghlId, value });
  }
  return out;
}

/**
 * Read a custom field by name (case-insensitive) off ANY QBO entity that carries a
 * `CustomField[]` — Customer, Estimate, Invoice. Null if unset/empty.
 *
 * The entity matters, and getting it wrong is why the salesperson mapping never
 * worked. Carolyn's 2026-07-31 screen share showed the field on the ESTIMATE
 * (`Rep` = "Cody", marked *(hidden)*, alongside Siding/Trim/Roofing Color) — QBO
 * sales-form custom fields live on the transaction, not on the customer record.
 * `readQbCustomerField` below is the historical alias and still reads the Customer;
 * new callers should say which entity they mean.
 */
export function readQbCustomField(entity, fieldName) {
  const cf = findQbCustomField(entity, fieldName);
  return cf ? qbCustomFieldValue(cf) : null;
}

/** The raw CustomField entry matching `fieldName`, or null. */
export function findQbCustomField(entity, fieldName) {
  if (!fieldName) return null;
  const want = String(fieldName).trim().toLowerCase();
  return (entity?.CustomField ?? []).find(
    (f) => String(f?.Name ?? '').trim().toLowerCase() === want,
  ) ?? null;
}

/**
 * Pull the value out of a CustomField entry, whatever shape it arrived in.
 *
 * Legacy sales-form slots are always `StringType` + `StringValue`. **Enhanced
 * (modern) fields are not** — they support String, Number, Date and **List**, and
 * List is what a DROPDOWN is. Rockwood's `Rep`, `Siding Color`, `Trim Color` and
 * `Roofing Color` are all dropdowns, which is itself proof they are enhanced
 * fields: a legacy slot is a free-text box and cannot be a dropdown at all.
 *
 * Intuit's exact JSON for a List value is not something I could confirm from the
 * docs, so this reads every plausible carrier rather than betting on one, and a
 * dropdown that arrives as `{Name, Value}` (an option id plus its label) yields the
 * LABEL — "Cody" is what belongs in Synergy, not an option id nobody recognises.
 * `describeQbCustomField` reports the keys actually seen so the real shape gets
 * recorded the first time a live document carries one.
 */
export function qbCustomFieldValue(cf) {
  if (!cf) return null;
  const scalar = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object') {
      // A chosen option: prefer human-readable label keys over the id.
      for (const k of ['Label', 'Name', 'StringValue', 'Value', 'value']) {
        const inner = scalar(v[k]);
        if (inner) return inner;
      }
    }
    return null;
  };
  for (const k of ['StringValue', 'Value', 'ListValue', 'NumberValue', 'DateValue', 'BooleanValue']) {
    const v = scalar(cf[k]);
    if (v) return v;
  }
  return null;
}

/**
 * The KEYS present on a CustomField entry — never the values. For diagnostics: it
 * tells us how QuickBooks actually serialises a dropdown without putting a
 * salesperson's name into error_events, which is customer data.
 */
export function describeQbCustomField(cf) {
  if (!cf || typeof cf !== 'object') return null;
  return Object.keys(cf)
    .map((k) => (cf[k] && typeof cf[k] === 'object' ? `${k}{${Object.keys(cf[k]).join('|')}}` : k))
    .join(',');
}

/** Historical alias — reads a QBO **Customer** custom field. See readQbCustomField. */
export const readQbCustomerField = readQbCustomField;

/**
 * Distinct custom-field NAMES actually present on a batch of QBO transactions.
 *
 * This is the answer to "the custom field isn't popping up in BuildBridge". The
 * field picker was fed from two definition sources, and on this company both come
 * back empty: REST `Preferences` only carries the three LEGACY sales-form slots,
 * and the modern Custom fields manager is only readable through the App
 * Foundations GraphQL API, which 403s without a scope Intuit gates behind a paid
 * tier. But the VALUES ride along on every transaction regardless — Rockwood's
 * estimate carries `Rep`, `Siding Color`, `Trim Color` and `Roofing Color` — so
 * the reliable way to learn a company's field names is to read its own documents
 * rather than ask for a schema we are not allowed to see.
 *
 * Returns [{ name, definitionId, seenOn }], most-frequent first, so the picker
 * offers the fields the company actually uses.
 */
export function collectTxnCustomFieldNames(estimates = [], invoices = []) {
  const seen = new Map(); // lower(name) -> { name, definitionId, seenOn:Set, count }
  const scan = (list, label) => {
    for (const txn of Array.isArray(list) ? list : []) {
      for (const f of txn?.CustomField ?? []) {
        const name = String(f?.Name ?? '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const hit = seen.get(key) ?? { name, definitionId: null, seenOn: new Set(), count: 0 };
        hit.count += 1;
        hit.seenOn.add(label);
        // First non-empty DefinitionId wins — it is stable per field, and having it
        // lets a future writer address the field without a second lookup.
        if (!hit.definitionId && f?.DefinitionId != null) hit.definitionId = String(f.DefinitionId);
        seen.set(key, hit);
      }
    }
  };
  scan(estimates, 'Estimate');
  scan(invoices, 'Invoice');
  return [...seen.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((h) => ({ name: h.name, definitionId: h.definitionId, seenOn: [...h.seenOn] }));
}

/**
 * Which salesperson/rep value to reflect into GHL for each QB customer.
 *
 * Keyed by QB customer id because that is what links to a GHL contact. Newest
 * document wins: `TxnDate` then `MetaData.LastUpdatedTime`, so a rep change on a
 * later estimate supersedes an older one rather than depending on array order.
 * Invoices and estimates are treated equally — the field is the same field, and a
 * company that only invoices should still get a rep.
 */
export function repByCustomer(estimates = [], invoices = [], fieldName) {
  const out = new Map(); // customerId -> { value, when }
  if (!fieldName) return out;
  const when = (t) => Date.parse(t?.MetaData?.LastUpdatedTime ?? t?.TxnDate ?? '') || 0;
  for (const txn of [...(estimates ?? []), ...(invoices ?? [])]) {
    const customerId = txn?.CustomerRef?.value;
    if (!customerId) continue;
    const value = readQbCustomField(txn, fieldName);
    if (!value) continue;
    const ts = when(txn);
    const prev = out.get(customerId);
    if (!prev || ts >= prev.when) out.set(customerId, { value, when: ts });
  }
  return new Map([...out].map(([k, v]) => [k, v.value]));
}

/**
 * Pick the QBO Item id to put on an invoice/estimate line from the tenant's
 * configured item mappings (mapperType 'qb_item'; each row externalKey = QBO
 * Item Id, ghlValue = the GHL/Synergy field that selects it) and this deal's
 * GHL field values. Returns the item id, or null when the caller should fall
 * back to QBO's built-in default item.
 *
 *   1. Prefer an item whose mapped GHL field is set/truthy on this deal.
 *   2. Else, if exactly one item is mapped, use it as the location default.
 *   3. Else null (ambiguous — don't guess which item to bill).
 */
export function resolveItemRef(itemMappings, ghlFieldValues = {}) {
  const maps = Array.isArray(itemMappings) ? itemMappings.filter((m) => m && m.externalKey) : [];
  if (maps.length === 0) return null;

  const values = ghlFieldValues ?? {};
  for (const m of maps) {
    const v = m.ghlValue != null ? values[m.ghlValue] : undefined;
    if (v !== undefined && v !== null && v !== '' && v !== false) {
      return String(m.externalKey);
    }
  }

  if (maps.length === 1) return String(maps[0].externalKey);
  return null;
}

/**
 * Resolve the salesperson NAME to stamp on a QuickBooks sales document for one
 * deal, or null to write nothing.
 *
 * QuickBooks' API never exposes the logged-in user, so the salesperson has to be
 * carried across from GHL (Carolyn, 2026-07-31). Two sources, most-specific first:
 *
 *   1. `ghlFieldId` — a GHL opportunity custom field naming the salesperson
 *      outright. A value typed on THIS deal beats a location-wide rule, so it
 *      wins. This is the "driven by a GHL custom field" half of the requirement.
 *   2. `mappings` (mapperType 'qb_salesperson') — the deal's assigned GHL user
 *      translated to a QuickBooks salesperson name. Each row is
 *      { ghlValue: <user id | email | name>, externalKey: <QBO salesperson name> }.
 *      Matching accepts any of the three because the client types this mapping by
 *      hand and an id is the least likely thing they have to hand; comparison is
 *      case-insensitive and trimmed for the same reason.
 *
 * Returns null when neither resolves. That is deliberate and NOT a fallback to the
 * GHL user's own name: an unrecognised name written into a client's books is worse
 * than an empty field, because it looks authoritative and silently misattributes
 * commission. Same lesson as the hardcoded ItemRef '1'.
 *
 * @param {object}   opts
 * @param {Array}    [opts.mappings]        qb_salesperson mapper rows
 * @param {object}   [opts.ghlFieldValues]  { <fieldId>: value } for this deal
 * @param {?string}  [opts.ghlFieldId]      configured salesperson custom-field id
 * @param {?object}  [opts.user]            the deal's assigned GHL user
 * @returns {?string}
 */
export function resolveSalesperson({
  mappings, ghlFieldValues = {}, ghlFieldId = null, user = null,
} = {}) {
  // 1. Per-deal override.
  if (ghlFieldId) {
    const raw = (ghlFieldValues ?? {})[ghlFieldId];
    // Arrays turn up for multi-select GHL fields; take the first meaningful entry
    // rather than stringifying the whole array into the client's books.
    const first = Array.isArray(raw) ? raw.find((v) => v != null && String(v).trim() !== '') : raw;
    const value = first == null ? '' : String(first).trim();
    if (value) return value;
  }

  // 2. Assigned user → mapper row.
  const maps = Array.isArray(mappings)
    ? mappings.filter((m) => m && m.externalKey && m.ghlValue != null)
    : [];
  if (maps.length === 0 || !user) return null;

  const norm = (v) => String(v ?? '').trim().toLowerCase();
  // Every identifier this user could plausibly have been written down as.
  const identities = new Set(
    [user.id, user.email, user.name, [user.firstName, user.lastName].filter(Boolean).join(' ')]
      .map(norm)
      .filter(Boolean),
  );
  if (identities.size === 0) return null;

  const hit = maps.find((m) => identities.has(norm(m.ghlValue)));
  return hit ? String(hit.externalKey).trim() || null : null;
}

/**
 * Build the QuickBooks `CustomField` array that carries the salesperson, or null
 * when the location has not configured the feature / nothing resolved.
 *
 * Shape is Intuit's legacy sales-form custom field: DefinitionId is the slot
 * (1-3), Name must match what the company has that slot named, and the value is
 * always StringType — the legacy slots are strings only.
 *
 * @param {?string} fieldName  location's qboSalespersonQbField
 * @param {number}  slot       location's qboSalespersonSlot (1-3)
 * @param {?string} value      resolved salesperson name
 */
export function salespersonCustomField(fieldName, slot, value) {
  const name = String(fieldName ?? '').trim();
  const val = String(value ?? '').trim();
  if (!name || !val) return null;
  const id = Number(slot);
  if (![1, 2, 3].includes(id)) return null;
  return [{ DefinitionId: String(id), Name: name, Type: 'StringType', StringValue: val }];
}

/**
 * Merge our CustomField entries into whatever the QuickBooks document already
 * carries, keyed on DefinitionId (the slot), ours winning.
 *
 * This exists because a QBO sparse update REPLACES an array wholesale rather than
 * merging it. Sending only slot 1 on an update would therefore blank slots 2 and 3
 * — other people's fields, on a document we were only asked to re-price. Read the
 * document's own CustomField back and merge, exactly as the GHL contact path
 * already does for custom fields on its side.
 *
 * @param {Array} existing  the document's current CustomField array
 * @param {Array} ours      entries to set (may be null/empty)
 */
export function mergeQboCustomFields(existing, ours) {
  const base = Array.isArray(existing) ? existing.filter(Boolean) : [];
  const add = Array.isArray(ours) ? ours.filter(Boolean) : [];
  // Nothing of ours to write ⇒ send NOTHING, rather than echoing the document's
  // own fields back at it. A location that has not configured this feature must
  // produce a byte-identical request to the one it produced before this existed:
  // echoing means re-posting values QuickBooks gave us, and any read-only
  // property that came back in that array turns a working sync into a 400.
  if (add.length === 0) return null;
  const byId = new Map(base.map((f) => [String(f.DefinitionId ?? ''), f]));
  for (const f of add) byId.set(String(f.DefinitionId ?? ''), f);
  return [...byId.values()];
}

// Same scrub rules as ghlService's summarizeGhlError — the two summaries feed the
// same error_events table under the same "no customer data" constraint.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONEISH_RE = /\+?[\d][\d\s().-]{6,}\d/g;
const MAX_FAULT = 300;

/**
 * Extract a scrubbed one-line summary from a QBO error body, or null.
 *
 * QBO error bodies carry a stable Fault envelope:
 *   {"Fault":{"Error":[{"Message":"…","Detail":"…","code":"2500","element":"…"}],
 *     "type":"ValidationFault"}}
 * (Intuit's API gateway variant uses lowercase fault/error.) `code` + `Message`
 * are Intuit's generic catalogue strings; `Detail` is what actually names the
 * offending field (e.g. "Invalid Reference Id : Line.SalesItemLineDetail.ItemRef")
 * but CAN echo company data (a duplicate DisplayName, an address), so it gets the
 * same email/number scrub as GHL reasons. Non-JSON (an HTML gateway page) and
 * unrecognised JSON are dropped entirely — never stored raw.
 */
export function summarizeQboFault(rawBody) {
  if (!rawBody) return null;
  let fault;
  try {
    const parsed = JSON.parse(rawBody);
    fault = parsed?.Fault ?? parsed?.fault ?? null;
  } catch {
    return null;
  }
  const errors = fault?.Error ?? fault?.error;
  if (!Array.isArray(errors) || errors.length === 0) {
    return typeof fault?.type === 'string' && fault.type ? `fault type ${fault.type}` : null;
  }
  const parts = errors.slice(0, 3).map((e) => {
    const code = e?.code ?? e?.Code;
    const message = [e?.Message, e?.message].find((v) => typeof v === 'string' && v) ?? '';
    const detail = [e?.Detail, e?.detail].find((v) => typeof v === 'string' && v) ?? '';
    // Detail usually restates Message before the colon — keep it only when it adds.
    const tail = detail && detail !== message ? `${message ? ': ' : ''}${detail}` : '';
    const text = `${message}${tail}`;
    if (!text) return null;
    return `${code != null && code !== '' ? `[${code}] ` : ''}${text}`;
  }).filter(Boolean);
  if (parts.length === 0) return null;
  const type = typeof fault?.type === 'string' && fault.type ? `${fault.type} — ` : '';
  return `${type}${parts.join('; ')}`
    .replace(EMAIL_RE, '<email>')
    .replace(PHONEISH_RE, '<number>')
    .slice(0, MAX_FAULT);
}

// How long a milestone name may be. It prints on a QuickBooks invoice line.
const MAX_MILESTONE_LABEL = 120;

/**
 * Validate and normalize one milestone definition from the UI.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, error }` rather than throwing, which keeps
 * this file free of imports and therefore trivially unit-testable — the same reason
 * resolveItemRef lives here. The service turns a failure into a 400.
 *
 * Rejects rather than coercing. A milestone with a blank name would print an empty invoice
 * line, and one with no amount field can never produce an amount — that is dead
 * configuration that nonetheless LOOKS configured, which is the worst of both worlds.
 */
export function normalizeMilestoneInput(input) {
  const raw = input ?? {};

  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) return { ok: false, error: 'A milestone needs a name.' };
  if (label.length > MAX_MILESTONE_LABEL) {
    return { ok: false, error: `A milestone name must be ${MAX_MILESTONE_LABEL} characters or fewer.` };
  }

  const amountField = typeof raw.amountField === 'string' ? raw.amountField.trim() : '';
  if (!amountField) {
    return { ok: false, error: 'Choose which opportunity field holds this milestone’s amount.' };
  }

  // An unset dropdown sends '' — normalize to null so "invoice on Won" is one check
  // everywhere downstream instead of a mix of '' and null.
  const dateField = typeof raw.dateField === 'string' && raw.dateField.trim() ? raw.dateField.trim() : null;
  if (dateField && dateField === amountField) {
    return { ok: false, error: 'The amount and date must be two different fields.' };
  }

  const n = Number(raw.sortOrder);
  return {
    ok: true,
    value: { label, amountField, dateField, sortOrder: Number.isFinite(n) ? Math.trunc(n) : 0 },
  };
}

/**
 * Is this scheduled milestone due to be invoiced yet?
 *
 * The rule Carolyn described (2026-07-28): "this happens when this date field gets filled
 * is when it creates an invoice" / "we're going to create an invoice when it reaches this
 * date". So:
 *
 *   awaitsDate = false  → the client configured NO date field for this milestone.
 *                         Invoice as soon as the opportunity is Won (deposit-style).
 *   awaitsDate = true   → wait for the date field to be filled, then invoice
 *                         `invoiceLeadDays` before it.
 *
 * The load-bearing difference from the previous behaviour: a milestone that WANTS a date
 * but does not have one yet is **waiting, not due**. Before, a null date always meant
 * "invoice immediately", so a milestone whose date had not been filled in yet was billed
 * the moment the deal was Won — the opposite of what filling the date is supposed to do.
 *
 * Pure and exported for tests; `invoiceDueMilestones` narrows in SQL first, then calls
 * this as the authority so the rule lives in exactly one place.
 */
export function milestoneIsDue(row, now = new Date()) {
  if (!row) return false;
  if (!row.awaitsDate) return true;

  const raw = row.milestoneDate;
  if (!raw) return false; // date field configured but not filled in yet → still waiting

  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return false; // unparseable → never silently bill

  const leadDays = Number.isFinite(row.invoiceLeadDays) ? row.invoiceLeadDays : 0;
  const dueAt = date.getTime() - leadDays * 24 * 60 * 60 * 1000;
  return now.getTime() >= dueAt;
}
