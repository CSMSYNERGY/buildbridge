import { describe, it, expect } from 'vitest';
import {
  syncFlags,
  estimateStatus,
  shouldUpgradeStatus,
  readQbCustomerField,
  deriveContactName,
  qbAddressToGhl,
  mergeCustomFields,
  qbCustomFieldEntries,
} from './qbSyncLogic.js';

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
