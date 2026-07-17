import { describe, it, expect } from 'vitest';
import {
  syncFlags,
  estimateStatus,
  shouldUpgradeStatus,
  readQbCustomerField,
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
  it('EmailSent outranks an Accepted TxnStatus', () => {
    expect(estimateStatus({ EmailStatus: 'EmailSent', TxnStatus: 'Accepted' })).toBe('Estimate sent');
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
