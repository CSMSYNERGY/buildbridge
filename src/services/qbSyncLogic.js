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

/** Map a QBO Estimate to a status label. EmailStatus 'EmailSent' outranks TxnStatus. */
export function estimateStatus(estimate) {
  if ((estimate?.EmailStatus ?? '') === 'EmailSent') return 'Estimate sent';
  const txn = estimate?.TxnStatus ?? '';
  if (txn === 'Accepted' || txn === 'Closed') return 'Accepted';
  return 'Estimate created';
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

/** Read a QBO Customer custom field by name (case-insensitive); null if unset/empty. */
export function readQbCustomerField(customer, fieldName) {
  if (!fieldName) return null;
  const cf = (customer?.CustomField ?? []).find(
    (f) => (f.Name ?? '').toLowerCase() === fieldName.toLowerCase(),
  );
  const value = cf?.StringValue?.trim();
  return value || null;
}
