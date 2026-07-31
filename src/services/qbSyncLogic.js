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
