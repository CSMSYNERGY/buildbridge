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

/** Read a QBO Customer custom field by name (case-insensitive); null if unset/empty. */
export function readQbCustomerField(customer, fieldName) {
  if (!fieldName) return null;
  const cf = (customer?.CustomField ?? []).find(
    (f) => (f.Name ?? '').toLowerCase() === fieldName.toLowerCase(),
  );
  const value = cf?.StringValue?.trim();
  return value || null;
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
