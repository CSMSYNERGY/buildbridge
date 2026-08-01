import { describe, it, expect } from 'vitest';
import {
  syncFlags,
  estimateStatus,
  shouldUpgradeStatus,
  readQbCustomerField,
  deriveContactName,
  qbAddressToGhl,
  ghlAddressToQb,
  mergeCustomFields,
  qbCustomFieldEntries,
  resolveItemRef,
  resolveSalesperson,
  salespersonCustomField,
  mergeQboCustomFields,
  milestoneIsDue,
  normalizeMilestoneInput,
  summarizeQboFault,
} from './qbSyncLogic.js';

describe('summarizeQboFault — scrubbed QBO Fault summary for the durable error log', () => {
  it('extracts type, code, Message and Detail from a v3 ValidationFault', () => {
    const body = JSON.stringify({
      Fault: {
        Error: [{
          Message: 'Invalid Reference Id',
          Detail: 'Invalid Reference Id : Line.SalesItemLineDetail.ItemRef',
          code: '2500',
          element: '',
        }],
        type: 'ValidationFault',
      },
      time: '2026-07-31T11:45:26.000-07:00',
    });
    expect(summarizeQboFault(body)).toBe(
      'ValidationFault — [2500] Invalid Reference Id: Invalid Reference Id : Line.SalesItemLineDetail.ItemRef',
    );
  });

  it('handles the lowercase gateway fault variant', () => {
    const body = JSON.stringify({
      fault: {
        error: [{ message: 'AppNotConfigured', detail: 'App not configured for company', code: '100' }],
        type: 'SYSTEMFAULT',
      },
    });
    expect(summarizeQboFault(body)).toBe(
      'SYSTEMFAULT — [100] AppNotConfigured: App not configured for company',
    );
  });

  it('scrubs an echoed email and phone out of Detail', () => {
    const body = JSON.stringify({
      Fault: {
        Error: [{
          Message: 'Duplicate Name Exists Error',
          Detail: 'Contact jane.doe@example.com at +1 (555) 123-4567 already exists',
          code: '6240',
        }],
        type: 'ValidationFault',
      },
    });
    const out = summarizeQboFault(body);
    expect(out).toContain('<email>');
    expect(out).toContain('<number>');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('555');
  });

  it('drops the Detail echo when it just repeats Message', () => {
    const body = JSON.stringify({
      Fault: { Error: [{ Message: 'Stale Object Error', Detail: 'Stale Object Error', code: '5010' }], type: 'ValidationFault' },
    });
    expect(summarizeQboFault(body)).toBe('ValidationFault — [5010] Stale Object Error');
  });

  it('joins multiple errors and caps at three', () => {
    const errs = Array.from({ length: 5 }, (_, i) => ({ Message: `Err ${i + 1}`, code: String(i + 1) }));
    const out = summarizeQboFault(JSON.stringify({ Fault: { Error: errs, type: 'ValidationFault' } }));
    expect(out).toContain('[1] Err 1; [2] Err 2; [3] Err 3');
    expect(out).not.toContain('Err 4');
  });

  it('returns null for non-JSON (an HTML gateway page) — never stores it raw', () => {
    expect(summarizeQboFault('<html><body>502 Bad Gateway</body></html>')).toBeNull();
  });

  it('returns null for empty input and unrecognised JSON shapes', () => {
    expect(summarizeQboFault('')).toBeNull();
    expect(summarizeQboFault(undefined)).toBeNull();
    expect(summarizeQboFault(JSON.stringify({ ok: true }))).toBeNull();
    expect(summarizeQboFault(JSON.stringify({ Fault: { Error: [{}] } }))).toBeNull();
  });

  it('falls back to the fault type when the Error array is missing or empty', () => {
    expect(summarizeQboFault(JSON.stringify({ Fault: { type: 'AuthenticationFault' } })))
      .toBe('fault type AuthenticationFault');
    expect(summarizeQboFault(JSON.stringify({ Fault: { Error: [], type: 'ValidationFault' } })))
      .toBe('fault type ValidationFault');
  });

  it('truncates to 300 chars', () => {
    const body = JSON.stringify({
      Fault: { Error: [{ Message: 'M', Detail: 'x'.repeat(500), code: '1' }], type: 'ValidationFault' },
    });
    expect(summarizeQboFault(body).length).toBe(300);
  });
});

describe('syncFlags — per-tenant direction gating (read-only-QuickBooks guarantee)', () => {
  it('qb_to_ghl reads QuickBooks but NEVER pushes to it', () => {
    expect(syncFlags('qb_to_ghl')).toEqual({ pullFromQb: true, pushToQb: false });
  });
  it('ghl_to_qb pushes to QuickBooks only', () => {
    expect(syncFlags('ghl_to_qb')).toEqual({ pullFromQb: false, pushToQb: true });
  });
  it('two_way does both', () => {
    expect(syncFlags('two_way')).toEqual({ pullFromQb: true, pushToQb: true });
  });
  it('off does nothing', () => {
    expect(syncFlags('off')).toEqual({ pullFromQb: false, pushToQb: false });
  });
  it('unknown/undefined direction is inert (never writes QuickBooks)', () => {
    expect(syncFlags(undefined)).toEqual({ pullFromQb: false, pushToQb: false });
    expect(syncFlags('bogus')).toEqual({ pullFromQb: false, pushToQb: false });
  });
});

describe('estimateStatus — QBO estimate → status label', () => {
  it('maps a sent estimate to "Estimate sent"', () => {
    expect(estimateStatus({ EmailStatus: 'EmailSent', TxnStatus: 'Pending' })).toBe('Estimate sent');
  });
  it('maps Accepted / Closed TxnStatus to "Accepted"', () => {
    expect(estimateStatus({ TxnStatus: 'Accepted' })).toBe('Accepted');
    expect(estimateStatus({ TxnStatus: 'Closed' })).toBe('Accepted');
  });
  it('defaults to "Estimate created"', () => {
    expect(estimateStatus({ TxnStatus: 'Pending' })).toBe('Estimate created');
    expect(estimateStatus({})).toBe('Estimate created');
  });
  it('an Accepted estimate outranks EmailSent (it was emailed too, but Accepted is further along)', () => {
    expect(estimateStatus({ EmailStatus: 'EmailSent', TxnStatus: 'Accepted' })).toBe('Accepted');
    expect(estimateStatus({ EmailStatus: 'EmailSent', TxnStatus: 'Closed' })).toBe('Accepted');
  });
  it('EmailSent with a non-accepted status is "Estimate sent"', () => {
    expect(estimateStatus({ EmailStatus: 'EmailSent', TxnStatus: 'Pending' })).toBe('Estimate sent');
  });
});

describe('shouldUpgradeStatus — never downgrade', () => {
  it('writes when the field is empty', () => {
    expect(shouldUpgradeStatus(null, 'Estimate created')).toBe(true);
    expect(shouldUpgradeStatus('', 'Estimate sent')).toBe(true);
  });
  it('upgrades to a higher status', () => {
    expect(shouldUpgradeStatus('Estimate created', 'Estimate sent')).toBe(true);
    expect(shouldUpgradeStatus('Accepted', 'Invoiced')).toBe(true);
  });
  it('does NOT downgrade a higher status', () => {
    expect(shouldUpgradeStatus('Invoiced', 'Estimate sent')).toBe(false);
    expect(shouldUpgradeStatus('Accepted', 'Estimate created')).toBe(false);
  });
  it('does not rewrite the same status', () => {
    expect(shouldUpgradeStatus('Invoiced', 'Invoiced')).toBe(false);
  });
  it('overwrites an unrecognized current value with a known status', () => {
    expect(shouldUpgradeStatus('Some manual note', 'Estimate sent')).toBe(true);
  });
});

describe('deriveContactName — one clean name from GHL fields', () => {
  it('prefers an explicit contactName', () => {
    expect(deriveContactName({ contactName: 'Acme LLC', firstName: 'Jo', lastName: 'Bo' })).toBe('Acme LLC');
  });
  it('falls back to first + last', () => {
    expect(deriveContactName({ firstName: 'Jane', lastName: 'Doe' })).toBe('Jane Doe');
  });
  it('handles first name only', () => {
    expect(deriveContactName({ firstName: 'Jane' })).toBe('Jane');
  });
  it('falls back to a plain name field', () => {
    expect(deriveContactName({ name: 'Jane Doe' })).toBe('Jane Doe');
  });
  it('returns null when nothing usable is present (no empty strings)', () => {
    expect(deriveContactName({})).toBeNull();
    expect(deriveContactName({ firstName: '', lastName: '' })).toBeNull();
    expect(deriveContactName(undefined)).toBeNull();
  });
});

describe('qbAddressToGhl — QuickBooks address → GHL fields', () => {
  it('maps a structured Customer BillAddr (from the real Invoice payload)', () => {
    const addr = { Line1: 'PO Box 2005', Line2: '503 Mill Creek Trail', City: 'Hamilton', CountrySubDivisionCode: 'MT', PostalCode: '59840' };
    expect(qbAddressToGhl(addr, 'Steve Reitz')).toEqual({
      address1: 'PO Box 2005, 503 Mill Creek Trail',
      city: 'Hamilton',
      state: 'MT',
      postalCode: '59840',
    });
  });
  it('handles a free-form address and drops the leading name line (from the real Estimate payload)', () => {
    const addr = { Line1: 'Tomie Martin', Line2: '835 Hamilton Heights', Line3: 'Corvallis, MT  59828' };
    expect(qbAddressToGhl(addr, 'Tomie Martin')).toEqual({
      address1: '835 Hamilton Heights, Corvallis, MT  59828',
    });
  });
  it('keeps all free-form lines when none matches the name', () => {
    const addr = { Line1: '835 Hamilton Heights', Line2: 'Corvallis, MT 59828' };
    expect(qbAddressToGhl(addr, 'Someone Else')).toEqual({
      address1: '835 Hamilton Heights, Corvallis, MT 59828',
    });
  });
  it('returns {} for empty/missing address', () => {
    expect(qbAddressToGhl(null)).toEqual({});
    expect(qbAddressToGhl({})).toEqual({});
  });
});

describe('ghlAddressToQb — GHL contact address → QBO BillAddr', () => {
  it('maps a full GHL address', () => {
    const contact = { address1: '835 Hamilton Heights', city: 'Corvallis', state: 'MT', postalCode: '59828', country: 'US' };
    expect(ghlAddressToQb(contact)).toEqual({
      Line1: '835 Hamilton Heights',
      City: 'Corvallis',
      CountrySubDivisionCode: 'MT',
      PostalCode: '59828',
      Country: 'US',
    });
  });
  it('omits fields the contact does not have', () => {
    expect(ghlAddressToQb({ address1: 'PO Box 2005', postalCode: '59840' })).toEqual({
      Line1: 'PO Box 2005',
      PostalCode: '59840',
    });
  });
  it('returns null when the contact has no address at all — BillAddr must not be sent', () => {
    expect(ghlAddressToQb({})).toBeNull();
    expect(ghlAddressToQb()).toBeNull();
    expect(ghlAddressToQb({ firstName: 'Tomie', email: 't@example.com' })).toBeNull();
  });
  it('round-trips what qbAddressToGhl produced from a structured QB address', () => {
    const qbAddr = { Line1: 'PO Box 2005', City: 'Hamilton', CountrySubDivisionCode: 'MT', PostalCode: '59840' };
    expect(ghlAddressToQb(qbAddressToGhl(qbAddr, 'Steve Reitz'))).toEqual(qbAddr);
  });
});

describe('mergeCustomFields — never wipe other custom fields', () => {
  it('adds a field when none exist', () => {
    expect(mergeCustomFields([], { id: 'status1', value: 'Invoiced' }))
      .toEqual([{ id: 'status1', value: 'Invoiced' }]);
    expect(mergeCustomFields(undefined, { id: 'status1', value: 'Invoiced' }))
      .toEqual([{ id: 'status1', value: 'Invoiced' }]);
  });
  it('preserves the salesperson field when writing status', () => {
    const existing = [{ id: 'sales1', value: 'Jane Doe' }];
    expect(mergeCustomFields(existing, { id: 'status1', value: 'Invoiced' })).toEqual([
      { id: 'sales1', value: 'Jane Doe' },
      { id: 'status1', value: 'Invoiced' },
    ]);
  });
  it('replaces the prior value for the same field id', () => {
    const existing = [{ id: 'status1', value: 'Estimate sent' }, { id: 'sales1', value: 'Jane' }];
    expect(mergeCustomFields(existing, { id: 'status1', value: 'Invoiced' })).toEqual([
      { id: 'sales1', value: 'Jane' },
      { id: 'status1', value: 'Invoiced' },
    ]);
  });
  it('normalizes fieldValue/fieldKey shapes from GHL reads', () => {
    const existing = [{ fieldKey: 'sales1', fieldValue: 'Jane' }];
    expect(mergeCustomFields(existing, { id: 'status1', value: 'Invoiced' })).toEqual([
      { id: 'sales1', value: 'Jane' },
      { id: 'status1', value: 'Invoiced' },
    ]);
  });
});

describe('qbCustomFieldEntries — mapped QuickBooks fields → GHL entries', () => {
  const customer = {
    CustomField: [
      { Name: 'Crew', StringValue: 'Team A' },
      { Name: 'PO Number', StringValue: '  9987 ' },
      { Name: 'Empty', StringValue: '' },
    ],
  };
  it('maps configured fields to {id,value}, trimming and skipping empty/unmapped', () => {
    const mappings = { Crew: 'ghlCrew', 'PO Number': 'ghlPo', Empty: 'ghlEmpty', Missing: 'ghlMissing' };
    expect(qbCustomFieldEntries(customer, mappings)).toEqual([
      { id: 'ghlCrew', value: 'Team A' },
      { id: 'ghlPo', value: '9987' },
    ]);
  });
  it('returns [] for no/empty mappings', () => {
    expect(qbCustomFieldEntries(customer, {})).toEqual([]);
    expect(qbCustomFieldEntries(customer, undefined)).toEqual([]);
  });
});

describe('readQbCustomerField — salesperson custom field read', () => {
  const customer = {
    CustomField: [
      { Name: 'Salesperson', StringValue: '  Jane Doe  ' },
      { Name: 'Region', StringValue: 'West' },
    ],
  };
  it('finds the field case-insensitively and trims the value', () => {
    expect(readQbCustomerField(customer, 'salesperson')).toBe('Jane Doe');
  });
  it('returns null when the field is missing, empty, or unnamed', () => {
    expect(readQbCustomerField(customer, 'Owner')).toBeNull();
    expect(readQbCustomerField({ CustomField: [{ Name: 'Salesperson', StringValue: '   ' }] }, 'Salesperson')).toBeNull();
    expect(readQbCustomerField({}, 'Salesperson')).toBeNull();
    expect(readQbCustomerField(customer, null)).toBeNull();
  });
});

describe('resolveItemRef — QBO item selection from qb_item mappings', () => {
  it('returns null when there are no item mappings (caller falls back to default item "1")', () => {
    expect(resolveItemRef([], {})).toBeNull();
    expect(resolveItemRef(undefined, {})).toBeNull();
    expect(resolveItemRef(null)).toBeNull();
  });

  it('uses the single mapped item as the location default even without a matching field value', () => {
    const maps = [{ externalKey: '42', ghlValue: 'building_type' }];
    expect(resolveItemRef(maps, {})).toBe('42');
    expect(resolveItemRef(maps, { building_type: '' })).toBe('42');
  });

  it('prefers the item whose mapped GHL field is set/truthy on the deal', () => {
    const maps = [
      { externalKey: '10', ghlValue: 'has_ramp' },
      { externalKey: '20', ghlValue: 'has_window' },
    ];
    expect(resolveItemRef(maps, { has_window: 'yes' })).toBe('20');
    expect(resolveItemRef(maps, { has_ramp: true, has_window: 'yes' })).toBe('10'); // first match wins
  });

  it('returns null when multiple items are mapped but none of their fields are set (ambiguous)', () => {
    const maps = [
      { externalKey: '10', ghlValue: 'has_ramp' },
      { externalKey: '20', ghlValue: 'has_window' },
    ];
    expect(resolveItemRef(maps, {})).toBeNull();
    expect(resolveItemRef(maps, { has_ramp: '', has_window: false })).toBeNull();
  });

  it('ignores malformed rows (missing externalKey) and coerces the id to a string', () => {
    expect(resolveItemRef([{ ghlValue: 'x' }, { externalKey: 7, ghlValue: 'y' }], { y: 1 })).toBe('7');
  });
});

describe('resolveSalesperson — who gets credited on the QuickBooks document', () => {
  // Fixtures use example.com on purpose — this repo is PUBLIC, so no real client's
  // domain, staff name or identifier belongs in it, including in test data.
  const maps = [
    { externalKey: 'Dave Miller', ghlValue: 'usr_dave' },
    { externalKey: 'Anna Ruiz', ghlValue: 'anna@example.com' },
    { externalKey: 'Sam Poole', ghlValue: 'Sam Poole' },
  ];
  const dave = { id: 'usr_dave', email: 'dave@example.com', name: 'Dave Miller' };

  it('writes nothing when nothing is configured or nothing matches', () => {
    expect(resolveSalesperson()).toBeNull();
    expect(resolveSalesperson({ mappings: [], user: dave })).toBeNull();
    expect(resolveSalesperson({ mappings: maps, user: null })).toBeNull();
    expect(resolveSalesperson({ mappings: maps, user: { id: 'usr_nobody' } })).toBeNull();
  });

  it('NEVER falls back to the GHL user\'s own name when unmapped', () => {
    // The whole point: a plausible-but-unrecognised name in a client's books
    // misattributes commission while looking authoritative.
    expect(resolveSalesperson({ mappings: maps, user: { id: 'usr_x', name: 'Someone Else' } })).toBeNull();
  });

  it('matches the assigned user by id, email, or name — case- and space-insensitively', () => {
    expect(resolveSalesperson({ mappings: maps, user: dave })).toBe('Dave Miller');
    expect(resolveSalesperson({ mappings: maps, user: { id: 'u2', email: 'ANNA@example.com ' } })).toBe('Anna Ruiz');
    expect(resolveSalesperson({ mappings: maps, user: { id: 'u3', firstName: 'Sam', lastName: 'Poole' } })).toBe('Sam Poole');
  });

  it('lets a per-deal GHL custom field override the assigned-user mapping', () => {
    const r = resolveSalesperson({
      mappings: maps, user: dave, ghlFieldId: 'cf_sp', ghlFieldValues: { cf_sp: 'Guest Closer' },
    });
    expect(r).toBe('Guest Closer');
  });

  it('falls through to the mapping when the override field is absent or blank', () => {
    const base = { mappings: maps, user: dave, ghlFieldId: 'cf_sp' };
    expect(resolveSalesperson({ ...base, ghlFieldValues: {} })).toBe('Dave Miller');
    expect(resolveSalesperson({ ...base, ghlFieldValues: { cf_sp: '   ' } })).toBe('Dave Miller');
  });

  it('takes the first meaningful entry from a multi-select override field', () => {
    const r = resolveSalesperson({
      mappings: [], ghlFieldId: 'cf_sp', ghlFieldValues: { cf_sp: ['', 'Anna Ruiz', 'Dave Miller'] },
    });
    expect(r).toBe('Anna Ruiz');
  });
});

describe('salespersonCustomField — the QBO legacy sales-form entry', () => {
  it('builds a StringType entry keyed on the slot as DefinitionId', () => {
    expect(salespersonCustomField('Salesperson', 2, 'Dave Miller')).toEqual([
      { DefinitionId: '2', Name: 'Salesperson', Type: 'StringType', StringValue: 'Dave Miller' },
    ]);
  });

  it('returns null unless field name, value, and a legal slot are all present', () => {
    expect(salespersonCustomField('', 1, 'Dave')).toBeNull();
    expect(salespersonCustomField('Salesperson', 1, '')).toBeNull();
    expect(salespersonCustomField('Salesperson', 1, '   ')).toBeNull();
    expect(salespersonCustomField('Salesperson', 0, 'Dave')).toBeNull();
    expect(salespersonCustomField('Salesperson', 4, 'Dave')).toBeNull();
  });
});

describe('mergeQboCustomFields — a sparse update must not blank other slots', () => {
  const existing = [
    { DefinitionId: '1', Name: 'Salesperson', Type: 'StringType', StringValue: 'Old Rep' },
    { DefinitionId: '3', Name: 'Job #', Type: 'StringType', StringValue: 'J-1042' },
  ];

  it('replaces our slot and leaves every other slot untouched', () => {
    const ours = salespersonCustomField('Salesperson', 1, 'Dave Miller');
    const merged = mergeQboCustomFields(existing, ours);
    expect(merged).toHaveLength(2);
    expect(merged.find((f) => f.DefinitionId === '1').StringValue).toBe('Dave Miller');
    expect(merged.find((f) => f.DefinitionId === '3').StringValue).toBe('J-1042');
  });

  it('sends NOTHING when we have nothing to add, rather than echoing the document back', () => {
    // An unconfigured location must issue the exact request it issued before this
    // feature existed — re-posting QuickBooks' own array risks a 400 on read-only
    // properties, for zero benefit.
    expect(mergeQboCustomFields(existing, null)).toBeNull();
    expect(mergeQboCustomFields(existing, [])).toBeNull();
  });

  it('returns null — not [] — when there is nothing on either side, so the field is OMITTED', () => {
    // upsertEstimate only sends CustomField when non-empty; an empty array on a
    // sparse update would erase whatever the client had typed in QuickBooks.
    expect(mergeQboCustomFields(null, null)).toBeNull();
    expect(mergeQboCustomFields([], [])).toBeNull();
  });

  it('adds our entry to a document that had no custom fields at all', () => {
    const ours = salespersonCustomField('Salesperson', 1, 'Dave Miller');
    expect(mergeQboCustomFields(undefined, ours)).toEqual(ours);
  });
});

describe('normalizeMilestoneInput — what the milestone editor is allowed to save', () => {
  const ok = { label: 'Materials Delivered', amountField: 'fA', dateField: 'fB', sortOrder: 2 };

  it('accepts a complete milestone and trims the label', () => {
    const r = normalizeMilestoneInput({ ...ok, label: '  Materials Delivered  ' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ label: 'Materials Delivered', amountField: 'fA', dateField: 'fB', sortOrder: 2 });
  });

  it('accepts no date field and normalizes it to null (the invoice-on-Won case)', () => {
    expect(normalizeMilestoneInput({ label: 'Deposit', amountField: 'fA' }).value.dateField).toBeNull();
    expect(normalizeMilestoneInput({ label: 'Deposit', amountField: 'fA', dateField: '' }).value.dateField).toBeNull();
    expect(normalizeMilestoneInput({ label: 'Deposit', amountField: 'fA', dateField: '   ' }).value.dateField).toBeNull();
  });

  it('rejects a blank or whitespace-only name — it would print an empty invoice line', () => {
    expect(normalizeMilestoneInput({ label: '', amountField: 'fA' }).ok).toBe(false);
    expect(normalizeMilestoneInput({ label: '   ', amountField: 'fA' }).ok).toBe(false);
    expect(normalizeMilestoneInput({ amountField: 'fA' }).ok).toBe(false);
  });

  it('rejects a missing amount field — it could never produce an amount', () => {
    const r = normalizeMilestoneInput({ label: 'Deposit' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/amount/i);
  });

  it('rejects the same field used for both amount and date', () => {
    const r = normalizeMilestoneInput({ label: 'Oops', amountField: 'fA', dateField: 'fA' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/two different fields/i);
  });

  it('rejects an over-long name rather than silently truncating it', () => {
    expect(normalizeMilestoneInput({ label: 'x'.repeat(121), amountField: 'fA' }).ok).toBe(false);
    expect(normalizeMilestoneInput({ label: 'x'.repeat(120), amountField: 'fA' }).ok).toBe(true);
  });

  it('defaults a non-numeric sortOrder to 0 instead of storing NaN', () => {
    expect(normalizeMilestoneInput({ ...ok, sortOrder: 'abc' }).value.sortOrder).toBe(0);
    expect(normalizeMilestoneInput({ ...ok, sortOrder: undefined }).value.sortOrder).toBe(0);
    expect(normalizeMilestoneInput({ ...ok, sortOrder: '3' }).value.sortOrder).toBe(3);
    expect(normalizeMilestoneInput({ ...ok, sortOrder: 1.9 }).value.sortOrder).toBe(1);
  });

  it('survives a missing or non-object body', () => {
    expect(normalizeMilestoneInput(undefined).ok).toBe(false);
    expect(normalizeMilestoneInput(null).ok).toBe(false);
  });
});

describe('milestoneIsDue — when a scheduled milestone gets invoiced', () => {
  const NOW = new Date('2026-08-01T12:00:00Z');
  const days = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

  it('invoices a milestone with no date field as soon as it is scheduled (deposit-style)', () => {
    expect(milestoneIsDue({ awaitsDate: false, milestoneDate: null, invoiceLeadDays: 3 }, NOW)).toBe(true);
  });

  it('does NOT invoice a milestone that wants a date until the date is filled in', () => {
    // The behaviour change. Previously a null date meant "invoice immediately", so a
    // milestone whose date had not been entered yet was billed the moment the deal was Won.
    expect(milestoneIsDue({ awaitsDate: true, milestoneDate: null, invoiceLeadDays: 3 }, NOW)).toBe(false);
  });

  it('invoices exactly `invoiceLeadDays` before the date, not on the date', () => {
    const row = { awaitsDate: true, milestoneDate: days(3), invoiceLeadDays: 3 };
    expect(milestoneIsDue(row, NOW)).toBe(true);                       // boundary: lead window opens now
    expect(milestoneIsDue({ ...row, milestoneDate: days(4) }, NOW)).toBe(false); // one day early
  });

  it('invoices a date already in the past', () => {
    expect(milestoneIsDue({ awaitsDate: true, milestoneDate: days(-10), invoiceLeadDays: 3 }, NOW)).toBe(true);
  });

  it('with zero lead days, waits until the date itself', () => {
    expect(milestoneIsDue({ awaitsDate: true, milestoneDate: days(1), invoiceLeadDays: 0 }, NOW)).toBe(false);
    expect(milestoneIsDue({ awaitsDate: true, milestoneDate: NOW, invoiceLeadDays: 0 }, NOW)).toBe(true);
  });

  it('accepts a date string as well as a Date (drivers differ on what they hand back)', () => {
    expect(milestoneIsDue({ awaitsDate: true, milestoneDate: '2026-07-01T00:00:00Z', invoiceLeadDays: 3 }, NOW)).toBe(true);
    expect(milestoneIsDue({ awaitsDate: true, milestoneDate: '2026-12-25T00:00:00Z', invoiceLeadDays: 3 }, NOW)).toBe(false);
  });

  it('never bills on an unparseable date or a missing row', () => {
    expect(milestoneIsDue({ awaitsDate: true, milestoneDate: 'not a date', invoiceLeadDays: 3 }, NOW)).toBe(false);
    expect(milestoneIsDue(null, NOW)).toBe(false);
  });

  it('treats a missing invoiceLeadDays as zero rather than NaN (which would never be due)', () => {
    expect(milestoneIsDue({ awaitsDate: true, milestoneDate: days(-1) }, NOW)).toBe(true);
    expect(milestoneIsDue({ awaitsDate: true, milestoneDate: days(1) }, NOW)).toBe(false);
  });
});
