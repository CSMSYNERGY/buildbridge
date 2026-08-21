// Estimate / invoice → Synergy field extraction.
//
// This is the BuildBridge port of the code node that has been running inside
// Rockwood's GHL workflows behind the three Zapier Zaps ("New Estimate QB to GHL",
// "Edit Estimate QB to GHL", "Invoice Sent QB to GHL"). Those Zaps POST the entire
// raw QuickBooks document to a GHL inbound webhook and the code node picks it
// apart; everything below reproduces that logic against the documents BuildBridge
// already reads from QuickBooks, so the Zaps and the hand-maintained JavaScript can
// be retired.
//
// Two things are deliberately NOT ported:
//   • `REP_NAMES = { "1": "Jon", "2": "Cody", … }` — a hardcoded map inside a code
//     node nobody but us can edit. Rep labels are `qb_rep_label` mapper rows now, so
//     the client renames a rep in their own UI (see `repDisplayName`).
//   • The `"Not found"` placeholders. A CRM field reading "Not found" is worse than
//     an empty one — it looks like data, merge tags print it, and it overwrites a
//     value that was correct. Everything here returns null and the caller skips the
//     write.
//
// Pure module: no db, no fetch. Unit-tested in qbDocFields.test.js.

import { findQbCustomField, qbCustomFieldValue } from './qbSyncLogic.js';

/**
 * Every field a tenant can map, in the order the mapping UI lists them.
 *
 * `key` is stored as the mapper row's `externalKey`, so renaming one silently
 * unmaps whatever a client had configured — add, don't rename.
 *
 * `description` is shown under the field name in BuildBridge → QuickBooks; it is
 * the only explanation the person doing the mapping gets, so it says where the
 * value comes from rather than restating the label.
 */
export const DOC_FIELD_CATALOG = [
  { key: 'documentNumber', label: 'Document number', description: 'The estimate or invoice number, whichever this document is.' },
  { key: 'documentId', label: 'Document ID', description: "QuickBooks' internal id for the document." },
  { key: 'docType', label: 'Document type', description: 'Either "estimate" or "invoice".' },
  { key: 'estimateNumber', label: 'Estimate number', description: 'Only written when the latest document is an estimate — an invoice never blanks it.' },
  { key: 'estimateId', label: 'Estimate ID', description: "QuickBooks' internal id, estimates only." },
  { key: 'invoiceNumber', label: 'Invoice number', description: 'Only written when the latest document is an invoice — an estimate never blanks it.' },
  { key: 'invoiceId', label: 'Invoice ID', description: "QuickBooks' internal id, invoices only." },
  { key: 'subtotal', label: 'Subtotal', description: "The document's subtotal line, or its own SubTotal when it has no subtotal line." },
  { key: 'line1Description', label: 'First line description', description: 'The first sales line, cut at the first full stop — the building, not the paragraph after it.' },
  { key: 'pdfLink', label: 'PDF / document link', description: 'The shareable QuickBooks link, when the company has one for this document.' },
  { key: 'customerFullName', label: 'Customer full name', description: 'The name on the document, else the QuickBooks customer record.' },
  { key: 'customerFirstName', label: 'Customer first name', description: "The customer's given name, else the first word of the full name." },
  { key: 'customerEmail', label: 'Customer email', description: "The document's billing email, else the customer record's." },
  { key: 'customerPhone', label: 'Customer phone', description: 'From the QuickBooks customer record — sales documents do not carry a phone.' },
  { key: 'shippingStreet', label: 'Shipping street', description: 'The street line of the shipping address, with the customer name and the city line stripped off.' },
  { key: 'shippingCityStateZip', label: 'Shipping city, state ZIP', description: 'The "City, ST 12345" line of the shipping address.' },
  { key: 'shippingFull', label: 'Shipping address (full)', description: 'Every shipping line joined with commas, name line removed.' },
  { key: 'rep', label: 'Rep (raw value)', description: 'The rep exactly as QuickBooks sends it. A dropdown sends an option id ("2"), not a name.' },
  { key: 'repName', label: 'Rep name', description: 'The rep value run through the rep-name list on this page. Falls back to the raw value when unmapped.' },
];

export const DOC_FIELD_KEYS = DOC_FIELD_CATALOG.map((f) => f.key);

// A company's OWN custom fields, added to the catalog above at runtime.
//
// The nineteen fields above are the same for everyone — every QuickBooks document
// has a number, a customer and a total. Everything a particular business actually
// tracks is in its custom fields, and those differ per company: Rockwood carries
// Rep, Siding Color, Trim Color and Roofing Color; the next client will carry
// something else entirely. They are DISCOVERED from the company's own documents
// (see collectTxnCustomFieldNames) rather than configured, so a new client can map
// their own fields the day they connect, with no code and no list to maintain.
export const CUSTOM_FIELD_PREFIX = 'custom:';

/** Catalog key for one of the company's own custom fields. */
export function customFieldKey(name) {
  return `${CUSTOM_FIELD_PREFIX}${String(name ?? '').trim()}`;
}

/** The custom field NAME behind a catalog key, or null for the built-in fields. */
export function customFieldName(key) {
  const k = String(key ?? '');
  return k.startsWith(CUSTOM_FIELD_PREFIX) ? k.slice(CUSTOM_FIELD_PREFIX.length) : null;
}

/**
 * The full mappable catalog for one company: the built-ins, then its own custom
 * fields in the order they were discovered (most frequently used first).
 */
export function docFieldCatalog(customFieldNames = []) {
  const seen = new Set();
  const dynamic = [];
  for (const raw of customFieldNames ?? []) {
    const name = String(raw ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    dynamic.push({
      key: customFieldKey(name),
      label: name,
      description: `A custom field on this company's estimates and invoices. Dropdown fields arrive as an option number — name them below and the name is what Synergy gets.`,
      custom: true,
    });
  }
  return [...DOC_FIELD_CATALOG, ...dynamic];
}

/**
 * Mapper key for one option of one dropdown field: `<field>::<value>`, both
 * lower-cased so a row typed as "rep::2" matches a document carrying "Rep" / "2".
 *
 * Scoped by FIELD because option numbers restart per field — "2" is Cody under Rep
 * and something else entirely under Siding Color. The rep-only version of this
 * table could not have told them apart.
 */
export function optionLabelKey(fieldName, value) {
  return `${String(fieldName ?? '').trim().toLowerCase()}::${String(value ?? '').trim().toLowerCase()}`;
}

/**
 * What a company calls one option of one dropdown field. Falls back to the raw
 * value — an unnamed option still syncs, as the number QuickBooks sent.
 *
 * This table exists because Intuit does not expose a dropdown's options over any
 * API we can reach: the modern definitions live behind the App Foundations scope
 * (tier-gated, 403 on every company we have), and even that query returns labels
 * for the FIELD, not for its options. So the names have to come from the person who
 * can see the dropdown. Once per option, for any field, for any client.
 */
export function optionLabel(mappings, fieldName, value) {
  const raw = str(value);
  if (!raw) return null;
  const want = optionLabelKey(fieldName, raw);
  const hit = (Array.isArray(mappings) ? mappings : []).find(
    (m) => m && m.ghlValue && String(m.externalKey ?? '').trim().toLowerCase() === want,
  );
  return hit ? String(hit.ghlValue) : raw;
}

/** Trimmed string, or null for anything empty/absent. Keeps blanks out of the CRM. */
function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * Sales lines, whatever shape they arrived in.
 *
 * QuickBooks' REST documents carry `Line[]`. The invoice trigger the Zaps use sends
 * a single `Line` OBJECT plus the full list under `Lines` — handled here too, so the
 * same extractor still works if a webhook path is ever added beside the polling sync.
 */
function lineItemsOf(doc) {
  if (Array.isArray(doc?.Lines)) return doc.Lines;
  if (Array.isArray(doc?.Line)) return doc.Line;
  if (doc?.Line && typeof doc.Line === 'object') return [doc.Line];
  return [];
}

/** Money as a plain 2-decimal string ("12345.60"). Non-numeric input passes through. */
function amount(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : str(v);
}

/**
 * Is this an invoice? An explicit type wins; otherwise the same test the code node
 * uses — invoices carry Balance/DueDate and estimates never do.
 */
function isInvoiceDoc(doc, type) {
  if (type) return String(type).toLowerCase() === 'invoice';
  return doc?.Balance !== undefined || doc?.DueDate !== undefined;
}

/**
 * Pull the shipping address apart the way the GHL code node does.
 *
 * Ship-to addresses on these documents are free-form: 3–5 numbered lines with no
 * fixed meaning, often starting with the customer's own name and ending with
 * "City, ST 12345". So the name line is dropped when it repeats the customer, the
 * city line is recognised by shape and popped off the end, and what is left is the
 * street.
 *
 * The structured fields (City / CountrySubDivisionCode / PostalCode) are a fallback
 * for the city line — the Zapier trigger rarely carried them, but the REST documents
 * BuildBridge reads often do, and composing them beats reporting nothing.
 */
export function shippingParts(addr, fullName) {
  const ship = addr ?? {};
  let lines = [ship.Line1, ship.Line2, ship.Line3, ship.Line4, ship.Line5]
    .map((l) => (l == null ? '' : String(l)))
    .filter((l) => l.trim());

  const name = String(fullName ?? '').trim().toLowerCase();
  if (lines.length && name && lines[0].trim().toLowerCase() === name) lines = lines.slice(1);

  const cityRe = /,\s*[A-Za-z]{2}\s+\d{5}(-\d{4})?\s*$/;
  let cityStateZip = null;
  if (lines.length && cityRe.test(lines[lines.length - 1])) {
    cityStateZip = lines.pop().trim();
  } else {
    const composed = [
      str(ship.City),
      [str(ship.CountrySubDivisionCode), str(ship.PostalCode)].filter(Boolean).join(' '),
    ].filter(Boolean).join(', ');
    cityStateZip = str(composed);
  }

  const street = lines.length ? str(lines[lines.length - 1]) : str(ship.Line1);
  const full = str([...lines, cityStateZip].filter(Boolean).join(', '));

  return { street, cityStateZip, full };
}

/**
 * The rep's display name — one instance of `optionLabel`, kept as its own function
 * because the rep is the one dropdown value the sync ALSO uses for a decision
 * (which Synergy user owns the lead), not just for display.
 */
export function repDisplayName(labelMappings, repValue, repField = 'rep') {
  return optionLabel(labelMappings, repField, repValue);
}

/**
 * Every catalog value for one estimate or invoice.
 *
 * @param {object} doc               A QuickBooks Estimate or Invoice.
 * @param {object} [opts]
 * @param {object} [opts.customer]   The QBO Customer record, when we have it — the
 *                                   only source of a phone number.
 * @param {string} [opts.repField]   Name of the QuickBooks custom field holding the
 *                                   rep (on Rockwood: "Rep").
 * @param {Array}  [opts.repLabels]  `qb_rep_label` mapper rows.
 * @param {string} [opts.type]       'estimate' | 'invoice' when the caller knows.
 * @returns {Object<string, ?string>} Keyed by DOC_FIELD_CATALOG key; null = nothing
 *                                    to write for this field.
 */
export function extractDocFields(doc, {
  customer, repField, repLabels, type, optionLabels, customFieldNames = [],
} = {}) {
  const d = doc ?? {};
  const cust = customer ?? d.Customer ?? {};
  // `repLabels` is the historical name for the same rows; either may be passed.
  const labels = optionLabels ?? repLabels;

  const lines = lineItemsOf(d);
  const firstSalesLine = lines.find((l) => l?.DetailType === 'SalesItemLineDetail');
  const subTotalLine = lines.find((l) => l?.DetailType === 'SubTotalLineDetail');

  const fullName = str(d.CustomerRef?.name)
    ?? str(cust.DisplayName)
    ?? str(cust.FullyQualifiedName)
    ?? str([cust.GivenName, cust.FamilyName].filter(Boolean).join(' '));

  const firstName = str(cust.GivenName) ?? (fullName ? str(fullName.split(' ')[0]) : null);

  const invoice = isInvoiceDoc(d, type);
  const id = str(d.Id);
  const number = str(d.DocNumber);

  const ship = shippingParts(d.ShipAddr, fullName);

  const rep = repField ? str(qbCustomFieldValue(findQbCustomField(d, repField))) : null;

  // The company's own custom fields, named where a name exists. A dropdown sends an
  // option number, so without the label table a client's "Siding Color" reaches
  // Synergy as "4" — the same defect the rep had, one field over.
  const custom = {};
  for (const raw of customFieldNames ?? []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const value = str(qbCustomFieldValue(findQbCustomField(d, name)));
    custom[customFieldKey(name)] = value ? optionLabel(labels, name, value) : null;
  }

  return {
    ...custom,
    documentNumber: number,
    documentId: id,
    docType: invoice ? 'invoice' : 'estimate',
    estimateNumber: invoice ? null : number,
    estimateId: invoice ? null : id,
    invoiceNumber: invoice ? number : null,
    invoiceId: invoice ? id : null,
    subtotal: amount(subTotalLine?.Amount !== undefined ? subTotalLine.Amount : d.SubTotal),
    line1Description: str(str(firstSalesLine?.Description)?.split('.')[0]),
    // `InvoiceLink` only comes back when the query asks for it (include=invoiceLink);
    // `pdf` is what the Zapier trigger called the same thing.
    pdfLink: str(d.InvoiceLink) ?? str(d.pdf),
    customerFullName: fullName,
    customerFirstName: firstName,
    customerEmail: str(d.BillEmail?.Address) ?? str(cust.PrimaryEmailAddr?.Address),
    customerPhone: str(cust.PrimaryPhone?.FreeFormNumber)
      ?? str(cust.Mobile?.FreeFormNumber)
      ?? str(cust.AlternatePhone?.FreeFormNumber),
    shippingStreet: ship.street,
    shippingCityStateZip: ship.cityStateZip,
    shippingFull: ship.full,
    rep,
    repName: optionLabel(labels, repField ?? 'rep', rep),
  };
}

/**
 * Every distinct value each custom field has carried, with the name the tenant has
 * given it — the data behind the "name your dropdown values" editor.
 *
 * Discovered, not configured: whatever a company's documents carry is what needs
 * naming, so this works the same on the first client and the twentieth. A field that
 * is free text rather than a dropdown simply shows its values and needs no names.
 *
 * @returns {Array<{field: string, values: Array<{value: string, label: ?string, count: number}>}>}
 */
export function optionsByField(estimates = [], invoices = [], labelMappings = []) {
  const byField = new Map(); // lower(field) -> { field, values: Map(value -> count) }
  for (const doc of [...(estimates ?? []), ...(invoices ?? [])]) {
    for (const cf of doc?.CustomField ?? []) {
      const field = String(cf?.Name ?? '').trim();
      const value = str(qbCustomFieldValue(cf));
      if (!field || !value) continue;
      const key = field.toLowerCase();
      const hit = byField.get(key) ?? { field, values: new Map() };
      hit.values.set(value, (hit.values.get(value) ?? 0) + 1);
      byField.set(key, hit);
    }
  }

  return [...byField.values()].map((f) => ({
    field: f.field,
    values: [...f.values.entries()]
      .map(([value, count]) => {
        const named = optionLabel(labelMappings, f.field, value);
        return { value, label: named === value ? null : named, count };
      })
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  })).sort((a, b) => a.field.localeCompare(b.field));
}

/**
 * Fill a tenant-written template like "{customerFirstName} {line1Description}"
 * from the extracted document values.
 *
 * This is how the opportunity NAME stays configuration instead of code: the legacy
 * GHL workflow hardcoded "first name + first line description", the next client
 * will want something else, and a template each tenant types is the universal form
 * of both. Unknown or empty keys render as nothing rather than leaking "{foo}"
 * into a deal name a salesperson reads; whitespace is collapsed so a missing
 * middle token does not leave a double space.
 */
export function renderTemplate(template, values = {}) {
  const t = str(template);
  if (!t) return null;
  const out = t.replace(/\{([^{}]+)\}/g, (_, key) => str(values[String(key).trim()]) ?? '');
  return str(out.replace(/\s+/g, ' '));
}

/**
 * The newest estimate or invoice per QuickBooks customer.
 *
 * Same "newest document wins" rule as `repByCustomer`: `MetaData.LastUpdatedTime`
 * then `TxnDate`, so a re-sent estimate supersedes an older one regardless of array
 * order, and estimates and invoices compete on equal terms — a company that only
 * invoices still gets values.
 *
 * The RESULT is ordered newest document first, and that ordering is load-bearing:
 * the sync visits a bounded number of contacts per pass, so whoever sits at the
 * front is who gets written this tick. Insertion order would put every estimate
 * ahead of every invoice, which on an invoice-heavy company means a document that
 * changed a minute ago queues behind fifty that did not.
 *
 * @returns {Map<string, {doc: object, type: string}>}
 */
export function latestDocByCustomer(estimates = [], invoices = []) {
  const out = new Map(); // customerId -> { doc, type, when }
  const when = (t) => Date.parse(t?.MetaData?.LastUpdatedTime ?? t?.TxnDate ?? '') || 0;
  const scan = (list, type) => {
    for (const doc of Array.isArray(list) ? list : []) {
      const customerId = doc?.CustomerRef?.value;
      if (!customerId) continue;
      const ts = when(doc);
      const prev = out.get(String(customerId));
      if (!prev || ts >= prev.when) out.set(String(customerId), { doc, type, when: ts });
    }
  };
  scan(estimates, 'estimate');
  scan(invoices, 'invoice');
  return new Map(
    [...out]
      .sort((a, b) => b[1].when - a[1].when)
      .map(([k, v]) => [k, { doc: v.doc, type: v.type }]),
  );
}

/**
 * Turn extracted values + `qb_doc_field` mapper rows into GHL contact customFields
 * entries `[{id, value}]`.
 *
 * Skips anything the document did not carry, which is the rule that makes estimate
 * and invoice numbers safe to map to separate fields: an invoice arriving after an
 * estimate has no estimate number, so it writes none, and the estimate number the
 * client is looking at stays put.
 *
 * `current` (the record's existing custom fields, as GHL returns them) suppresses
 * writes that would set a field to what it already holds — a no-op PUT still costs a
 * request and still bumps the record's updated stamp, which echo suppression then
 * has to reason about.
 *
 * Contacts and opportunities return custom fields in different shapes (`value` vs
 * `fieldValue`, `fieldKey` vs `key`), so all of them are read here. The RESULT is
 * the contact shape `{id, value}`; the opportunity caller converts it, because it is
 * only the write side of those two endpoints that differs.
 */
export function docFieldWrites(values, mappings, current = []) {
  const held = new Map();
  for (const f of Array.isArray(current) ? current : []) {
    const v = f?.value ?? f?.fieldValue ?? f?.fieldValueString;
    if (f?.id) held.set(f.id, v);
    if (f?.fieldKey) held.set(f.fieldKey, v);
    if (f?.key) held.set(f.key, v);
  }

  const writes = [];
  const seen = new Set();
  for (const m of Array.isArray(mappings) ? mappings : []) {
    const key = str(m?.externalKey);
    const target = str(m?.ghlValue);
    if (!key || !target || seen.has(target)) continue;
    const value = values?.[key];
    if (value == null || value === '') continue;
    if (String(held.get(target) ?? '') === String(value)) continue;
    seen.add(target);
    writes.push({ id: target, value: String(value) });
  }
  return writes;
}
