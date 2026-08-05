import { describe, it, expect } from 'vitest';
import {
  syncFlags,
  estimateStatus,
  shouldUpgradeStatus,
  readQbCustomerField,
  readQbCustomField,
  qbCustomFieldValue,
  describeQbCustomField,
  collectTxnCustomFieldNames,
  collectRepValues,
  resolveAssignee,
  repByCustomer,
  deriveContactName,
  nameSyncDecision,
  qbCustomerChanges,
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

  // The 2026-08-05 client report: QBO customer names kept reverting to all lowercase
  // while GHL showed them properly capitalised.
  it('takes the capitalised first+last over a lowercase blob of the same name', () => {
    expect(deriveContactName({ contactName: 'john smith', firstName: 'John', lastName: 'Smith' }))
      .toBe('John Smith');
    expect(deriveContactName({ name: 'john smith', firstName: 'John', lastName: 'Smith' }))
      .toBe('John Smith');
  });
  it('keeps the blob when it is a DIFFERENT name, lowercase or not', () => {
    // contactName is where a company/DBA name lives — not a casing variant.
    expect(deriveContactName({ contactName: 'acme llc', firstName: 'Jo', lastName: 'Bo' }))
      .toBe('acme llc');
  });
  it('keeps the blob when IT is the capitalised one', () => {
    expect(deriveContactName({ contactName: 'John Smith', firstName: 'john', lastName: 'smith' }))
      .toBe('John Smith');
  });
  it('keeps first+last ABOVE a plain `name`, as it always did', () => {
    // Ranking `name` above the parts would silently change which value becomes a
    // QuickBooks DisplayName — and `name` is where the QB→GHL half writes the ledger's
    // own DisplayName back into GHL, so "Smith, John" would start beating "John Smith".
    expect(deriveContactName({ name: 'Smith, John', firstName: 'John', lastName: 'Smith' }))
      .toBe('John Smith');
    // Which also means a lowercase `name` is already outranked and needs no casing rule.
    expect(deriveContactName({ name: 'john smith', firstName: 'John', lastName: 'Smith' }))
      .toBe('John Smith');
  });
  it('trims each part before joining, so padded GHL fields still match the blob', () => {
    // Padded fields are routine in CSV-imported GHL contacts; " Smith" would otherwise
    // defeat the equality test and let the lowercase blob through.
    expect(deriveContactName({ contactName: 'john smith', firstName: 'John ', lastName: ' Smith' }))
      .toBe('John Smith');
  });
  it('collapses internal whitespace when comparing the two spellings', () => {
    expect(deriveContactName({ contactName: 'john  smith', firstName: 'John', lastName: 'Smith' }))
      .toBe('John Smith');
  });
  it('leaves an intentional mixed-case spelling alone', () => {
    expect(deriveContactName({ contactName: 'McDonald Farms', firstName: 'McDonald', lastName: 'Farms' }))
      .toBe('McDonald Farms');
    // Neither side has capitals to prefer → first-listed wins, as before.
    expect(deriveContactName({ contactName: 'john smith', firstName: 'john', lastName: 'smith' }))
      .toBe('john smith');
  });
});

describe('nameSyncDecision — push a name CHANGE, never a difference', () => {
  it('seeds the baseline and writes nothing when there is none (legacy or adopted link)', () => {
    // The whole point: a customer we did not name keeps its ledger spelling, and the
    // next genuine rename still propagates because we now know what GHL said.
    expect(nameSyncDecision('John Smith', null)).toEqual({ push: false, baseline: 'John Smith' });
    expect(nameSyncDecision('John Smith', undefined)).toEqual({ push: false, baseline: 'John Smith' });
  });
  it('says nothing when the GHL name has not changed since our last push', () => {
    expect(nameSyncDecision('John Smith', 'John Smith')).toEqual({ push: false, baseline: null });
  });
  it('pushes a real rename and moves the baseline', () => {
    expect(nameSyncDecision('John Smythe', 'John Smith'))
      .toEqual({ push: true, baseline: 'John Smythe' });
  });
  it('a QuickBooks-side hand-edit cannot trigger a push — only GHL moves the baseline', () => {
    // Client fixed "john smith" -> "John Smith" in QuickBooks. GHL still says what it
    // said, so we have nothing to report and their edit survives every later pass.
    expect(nameSyncDecision('john smith', 'john smith')).toEqual({ push: false, baseline: null });
  });
  it('treats a GHL casing change as a change (qbCustomerChanges is the second gate)', () => {
    expect(nameSyncDecision('John Smith', 'john smith'))
      .toEqual({ push: true, baseline: 'John Smith' });
  });
  it('does nothing at all when GHL has no name', () => {
    expect(nameSyncDecision(null, 'John Smith')).toEqual({ push: false, baseline: null });
    expect(nameSyncDecision('   ', null)).toEqual({ push: false, baseline: null });
  });
});

describe('qbCustomerChanges — only write what QuickBooks does not already have', () => {
  const customer = {
    DisplayName: 'John Smith',
    GivenName: 'John',
    FamilyName: 'Smith',
    PrimaryEmailAddr: { Address: 'john@example.com' },
    PrimaryPhone: { FreeFormNumber: '(406) 555-0100' },
    BillAddr: { Line1: '12 Mill Creek', City: 'Hamilton', CountrySubDivisionCode: 'MT' },
  };

  it('is empty when nothing differs', () => {
    expect(qbCustomerChanges(
      { name: 'John Smith', firstName: 'John', lastName: 'Smith', email: 'john@example.com', phone: '(406) 555-0100' },
      customer,
    )).toEqual({});
  });
  it('IGNORES a case-only difference — the client curates capitals in their own books', () => {
    expect(qbCustomerChanges(
      { name: 'john smith', firstName: 'john', lastName: 'smith', email: 'JOHN@example.com' },
      customer,
    )).toEqual({});
  });
  it('still writes a real rename', () => {
    expect(qbCustomerChanges({ name: 'John Smythe', lastName: 'Smythe' }, customer))
      .toEqual({ DisplayName: 'John Smythe', FamilyName: 'Smythe' });
  });
  // The same lesson as the name, one field over: GHL normalises phones, so a byte
  // comparison would rewrite the client's formatting on every single pass.
  it('IGNORES a phone reformat — same digits, same phone', () => {
    expect(qbCustomerChanges({ phone: '4065550100' }, customer)).toEqual({});
    expect(qbCustomerChanges({ phone: '406.555.0100' }, customer)).toEqual({});
  });
  it('IGNORES the E.164 form GHL normalises a US number into', () => {
    // This is the actual round trip: QB holds "(406) 555-0100", the QB→GHL half copies
    // it to GHL, GHL stores "+14065550100", and a byte comparison would then rewrite the
    // client's formatting every 15 minutes — the reported incident, on PrimaryPhone.
    expect(qbCustomerChanges({ phone: '+14065550100' }, customer)).toEqual({});
    expect(qbCustomerChanges({ phone: '+1 (406) 555-0100' }, customer)).toEqual({});
  });
  it('still writes a genuinely different number', () => {
    expect(qbCustomerChanges({ phone: '4065559999' }, customer))
      .toEqual({ PrimaryPhone: { FreeFormNumber: '4065559999' } });
  });
  it('writes TRIMMED values, not just compares trimmed ones', () => {
    // A padded address earns a QBO ValidationFault on every pass forever, because a
    // rejected write never advances the link.
    expect(qbCustomerChanges({ email: '  NEW@example.com  ' }, customer))
      .toEqual({ PrimaryEmailAddr: { Address: 'NEW@example.com' } });
    expect(qbCustomerChanges({ name: '  John Smythe ' }, customer))
      .toEqual({ DisplayName: 'John Smythe' });
  });
  it('pins the existing DisplayName whenever a name COMPONENT goes over without it', () => {
    // QBO regenerates DisplayName from the components supplied when DisplayName is
    // absent, which would defeat the whole fix. Sending back the value it already
    // holds cannot change anything.
    expect(qbCustomerChanges({ firstName: 'Jonathan' }, customer))
      .toEqual({ GivenName: 'Jonathan', DisplayName: 'John Smith' });
  });
  it('does not invent a DisplayName for a customer that has none', () => {
    expect(qbCustomerChanges({ firstName: 'Jonathan' }, { GivenName: 'John' }))
      .toEqual({ GivenName: 'Jonathan' });
  });
  it('omits BillAddr when every key we would send already matches', () => {
    expect(qbCustomerChanges(
      { billAddr: { Line1: '12 Mill Creek', City: 'hamilton' } },
      customer,
    )).toEqual({});
  });
  it('sends BillAddr whole when any part differs', () => {
    const billAddr = { Line1: '99 New Road', City: 'Hamilton' };
    expect(qbCustomerChanges({ billAddr }, customer)).toEqual({ BillAddr: billAddr });
  });
  it('writes everything for a customer QuickBooks has nothing on', () => {
    expect(qbCustomerChanges({ name: 'New Person', firstName: 'New', email: 'new@example.com' }, {}))
      .toEqual({
        DisplayName: 'New Person',
        GivenName: 'New',
        PrimaryEmailAddr: { Address: 'new@example.com' },
      });
  });
  it('never blanks a QuickBooks value GHL simply lacks', () => {
    expect(qbCustomerChanges({ name: 'John Smith' }, customer)).toEqual({});
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

describe('collectTxnCustomFieldNames — learning field names from the company\'s own documents', () => {
  // Modelled on Rockwood's real estimate (2026-07-31 screen share): four sales-form
  // custom fields, of which `Rep` is the salesperson and is marked hidden.
  const est = {
    CustomField: [
      { DefinitionId: '1', Name: 'Rep', StringValue: 'Cody' },
      { DefinitionId: '2', Name: 'Siding Color', StringValue: 'Lifetime Wood Treatment' },
      { DefinitionId: '3', Name: 'Trim Color', StringValue: 'Lifetime Wood Treatment' },
      { DefinitionId: '4', Name: 'Roofing Color', StringValue: 'Burnished Slate' },
    ],
  };

  it('finds every field name on the transaction, with its DefinitionId', () => {
    const got = collectTxnCustomFieldNames([est], []);
    expect(got.map((f) => f.name).sort()).toEqual(['Rep', 'Roofing Color', 'Siding Color', 'Trim Color']);
    expect(got.find((f) => f.name === 'Rep')).toMatchObject({ definitionId: '1', seenOn: ['Estimate'] });
  });

  it('merges estimates and invoices and ranks the most-used field first', () => {
    const inv = { CustomField: [{ DefinitionId: '1', Name: 'Rep', StringValue: 'Dana' }] };
    const got = collectTxnCustomFieldNames([est], [inv]);
    expect(got[0].name).toBe('Rep');
    expect(got[0].seenOn.sort()).toEqual(['Estimate', 'Invoice']);
  });

  it('survives empty, missing and malformed input rather than throwing', () => {
    expect(collectTxnCustomFieldNames()).toEqual([]);
    expect(collectTxnCustomFieldNames([{}], [null])).toEqual([]);
    expect(collectTxnCustomFieldNames([{ CustomField: [{ Name: '  ' }] }], [])).toEqual([]);
  });
});

describe('repByCustomer — carrying the rep off the transaction, keyed to the QB customer', () => {
  const mk = (customerId, rep, updated) => ({
    CustomerRef: { value: customerId },
    MetaData: { LastUpdatedTime: updated },
    CustomField: rep ? [{ DefinitionId: '1', Name: 'Rep', StringValue: rep }] : [],
  });

  it('reads the configured field off the estimate', () => {
    const got = repByCustomer([mk('58', 'Cody', '2026-07-31T10:00:00Z')], [], 'Rep');
    expect(got.get('58')).toBe('Cody');
  });

  it('is case-insensitive on the field name, as QuickBooks labels are', () => {
    expect(repByCustomer([mk('58', 'Cody', '2026-07-31T10:00:00Z')], [], 'rep').get('58')).toBe('Cody');
  });

  it('takes the NEWEST document when a customer has several, not array order', () => {
    const older = mk('58', 'Cody', '2026-07-01T10:00:00Z');
    const newer = mk('58', 'Dana', '2026-07-31T10:00:00Z');
    expect(repByCustomer([newer, older], [], 'Rep').get('58')).toBe('Dana');
    expect(repByCustomer([older, newer], [], 'Rep').get('58')).toBe('Dana');
  });

  it('treats invoices as equal to estimates — an invoice-only company still gets a rep', () => {
    expect(repByCustomer([], [mk('58', 'Cody', '2026-07-31T10:00:00Z')], 'Rep').get('58')).toBe('Cody');
  });

  it('writes nothing when unconfigured, unset, or the customer is unknown', () => {
    expect(repByCustomer([mk('58', 'Cody', '2026-07-31T10:00:00Z')], [], null).size).toBe(0);
    expect(repByCustomer([mk('58', '', '2026-07-31T10:00:00Z')], [], 'Rep').size).toBe(0);
    expect(repByCustomer([mk(undefined, 'Cody', '2026-07-31T10:00:00Z')], [], 'Rep').size).toBe(0);
  });

  it('does not confuse two customers', () => {
    const got = repByCustomer(
      [mk('58', 'Cody', '2026-07-31T10:00:00Z'), mk('77', 'Dana', '2026-07-31T11:00:00Z')], [], 'Rep',
    );
    expect(got.get('58')).toBe('Cody');
    expect(got.get('77')).toBe('Dana');
  });
});

describe('readQbCustomField — reads any entity that carries CustomField[]', () => {
  it('reads off an Estimate, which is where sales-form fields actually live', () => {
    const estimate = { CustomField: [{ Name: 'Rep', StringValue: 'Cody' }] };
    expect(readQbCustomField(estimate, 'Rep')).toBe('Cody');
    // The historical alias is the same function — a Customer carrying the field
    // still works, it just is not where QuickBooks puts it.
    expect(readQbCustomerField(estimate, 'Rep')).toBe('Cody');
  });
});

describe('qbCustomFieldValue — dropdown (List) fields, not just legacy text', () => {
  // Rockwood's four fields are all DROPDOWNS, which is itself proof they are
  // enhanced fields: a legacy slot is a free-text box and cannot be a dropdown.
  // Intuit's exact List JSON is unconfirmed, so every plausible carrier is read.
  it('reads a legacy StringType value', () => {
    expect(qbCustomFieldValue({ Type: 'StringType', StringValue: 'Cody' })).toBe('Cody');
  });

  it('reads a bare Value', () => {
    expect(qbCustomFieldValue({ Type: 'ListType', Value: 'Cody' })).toBe('Cody');
  });

  it('prefers the LABEL over the option id when a dropdown arrives as an object', () => {
    // An option id in a Synergy field would be meaningless to staff.
    expect(qbCustomFieldValue({ Type: 'ListType', Value: { Id: '7', Name: 'Cody' } })).toBe('Cody');
    expect(qbCustomFieldValue({ ListValue: { Label: 'Cody', Id: '7' } })).toBe('Cody');
  });

  it('trims, and treats blank or absent as no value', () => {
    expect(qbCustomFieldValue({ StringValue: '  Cody  ' })).toBe('Cody');
    expect(qbCustomFieldValue({ StringValue: '   ' })).toBeNull();
    expect(qbCustomFieldValue({ Type: 'ListType' })).toBeNull();
    expect(qbCustomFieldValue(null)).toBeNull();
  });

  it('resolves a dropdown end-to-end through repByCustomer', () => {
    const txn = {
      CustomerRef: { value: '58' },
      MetaData: { LastUpdatedTime: '2026-07-31T18:00:00Z' },
      CustomField: [{ DefinitionId: '1', Name: 'Rep', Type: 'ListType', Value: { Id: '7', Name: 'Cody' } }],
    };
    expect(repByCustomer([txn], [], 'Rep').get('58')).toBe('Cody');
  });
});

describe('resolveAssignee — QuickBooks rep value → Synergy user id', () => {
  // Rockwood's real values: QuickBooks sends the dropdown's OPTION ID, so these are
  // "1" and "2", not names. Nothing is inferable from "1" — hence a mapping.
  const maps = [
    { externalKey: '1', ghlValue: 'usr_cody' },
    { externalKey: '2', ghlValue: 'usr_carolyn' },
  ];

  it('maps an option id to the user it was pointed at', () => {
    expect(resolveAssignee(maps, '1')).toBe('usr_cody');
    expect(resolveAssignee(maps, '2')).toBe('usr_carolyn');
  });

  it('never guesses — an unmapped value assigns nobody', () => {
    expect(resolveAssignee(maps, '3')).toBeNull();
    expect(resolveAssignee([], '1')).toBeNull();
    expect(resolveAssignee(maps, '')).toBeNull();
    expect(resolveAssignee(maps, null)).toBeNull();
    expect(resolveAssignee(undefined, '1')).toBeNull();
  });

  it('tolerates a name-shaped value, trimmed and case-insensitively', () => {
    const byName = [{ externalKey: 'Cody', ghlValue: 'usr_cody' }];
    expect(resolveAssignee(byName, ' cody ')).toBe('usr_cody');
  });

  it('ignores rows with no user to assign', () => {
    expect(resolveAssignee([{ externalKey: '1', ghlValue: '' }], '1')).toBeNull();
  });
});

describe('collectRepValues — the left-hand dropdown of the mapping UI', () => {
  const mk = (v) => ({ CustomField: [{ DefinitionId: '1', Name: 'Rep', StringValue: v }] });

  it('returns distinct values, most-used first', () => {
    const got = collectRepValues([mk('1'), mk('2'), mk('1')], [], 'Rep');
    expect(got.map((r) => r.value)).toEqual(['1', '2']);
    expect(got[0].count).toBe(2);
  });

  it('falls back to the value as its own label when no label is carried', () => {
    // The honest case for Rockwood: the id IS all we get, so the UI shows the id.
    expect(collectRepValues([mk('1')], [], 'Rep')[0].label).toBe('1');
  });

  it('surfaces a label when a dropdown arrives as an object', () => {
    const txn = { CustomField: [{ Name: 'Rep', Value: { Id: '1', Name: 'Cody' } }] };
    const got = collectRepValues([txn], [], 'Rep');
    expect(got[0]).toMatchObject({ value: 'Cody', label: 'Cody' });
  });

  it('returns [] with no field configured or nothing to read', () => {
    expect(collectRepValues([mk('1')], [], null)).toEqual([]);
    expect(collectRepValues([], [], 'Rep')).toEqual([]);
  });
});

describe('describeQbCustomField — report the shape, never the value', () => {
  it('names the keys, including nested ones, and no data', () => {
    const shape = describeQbCustomField({ DefinitionId: '1', Name: 'Rep', Value: { Id: '7', Name: 'Cody' } });
    expect(shape).toBe('DefinitionId,Name,Value{Id|Name}');
    expect(shape).not.toContain('Cody');
  });

  it('returns null for a missing entry', () => {
    expect(describeQbCustomField(null)).toBeNull();
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
