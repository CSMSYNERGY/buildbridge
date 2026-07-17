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

/** Read a QBO Customer custom field by name (case-insensitive); null if unset/empty. */
export function readQbCustomerField(customer, fieldName) {
  if (!fieldName) return null;
  const cf = (customer?.CustomField ?? []).find(
    (f) => (f.Name ?? '').toLowerCase() === fieldName.toLowerCase(),
  );
  const value = cf?.StringValue?.trim();
  return value || null;
}
