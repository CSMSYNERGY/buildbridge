import { describe, it, expect } from 'vitest';
import {
  DOC_FIELD_CATALOG,
  DOC_FIELD_KEYS,
  extractDocFields,
  shippingParts,
  repDisplayName,
  optionLabel,
  optionLabelKey,
  docFieldCatalog,
  optionsByField,
  customFieldKey,
  latestDocByCustomer,
  docFieldWrites,
} from './qbDocFields.js';

// A Rockwood estimate in the shape QuickBooks' /query returns it: free-form
// ShipAddr lines starting with the customer's name, a SubTotalLineDetail line, and
// the enhanced custom fields (Rep first, by DefinitionId order).
const ESTIMATE = {
  Id: '18008',
  DocNumber: '18008',
  TxnDate: '2026-08-12',
  MetaData: { LastUpdatedTime: '2026-08-12T14:02:00-07:00' },
  CustomerRef: { value: '412', name: 'Marcus Webb' },
  BillEmail: { Address: 'marcus@example.com' },
  ShipAddr: {
    Id: '77',
    Line1: 'Marcus Webb',
    Line2: '4821 Township Road 118',
    Line3: 'Millersburg, OH 44654',
  },
  Line: [
    {
      DetailType: 'SalesItemLineDetail',
      Description: '12x24 Lofted Barn. Painted LP SmartSide, charcoal metal roof.',
      Amount: 14250,
    },
    { DetailType: 'SubTotalLineDetail', Amount: 14250 },
  ],
  CustomField: [
    { DefinitionId: '1000000006', Name: 'Rep', Type: 'StringType', StringValue: '2' },
    { DefinitionId: '1000000007', Name: 'Siding Color', Type: 'StringType', StringValue: '4' },
  ],
};

// The same company's invoice: Balance/DueDate present, a shareable InvoiceLink, and
// SubTotal at the top level instead of a subtotal line.
const INVOICE = {
  Id: '9042',
  DocNumber: 'INV-9042',
  TxnDate: '2026-08-14',
  DueDate: '2026-09-13',
  Balance: 7125,
  SubTotal: 14250,
  InvoiceLink: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/abc123',
  MetaData: { LastUpdatedTime: '2026-08-14T09:15:00-07:00' },
  CustomerRef: { value: '412', name: 'Marcus Webb' },
  Line: [
    { DetailType: 'SalesItemLineDetail', Description: '12x24 Lofted Barn. Balance due.', Amount: 7125 },
  ],
  CustomField: [{ DefinitionId: '1000000006', Name: 'Rep', Type: 'StringType', StringValue: '2' }],
};

const REP_LABELS = [
  { externalKey: 'rep::1', ghlValue: 'Jon' },
  { externalKey: 'rep::2', ghlValue: 'Cody' },
  { externalKey: 'rep::3', ghlValue: 'Jadon' },
  { externalKey: 'rep::4', ghlValue: 'Jason' },
];

describe('extractDocFields — estimates', () => {
  const v = extractDocFields(ESTIMATE, { repField: 'Rep', repLabels: REP_LABELS });

  it('reports the document as an estimate and fills only the estimate ids', () => {
    expect(v.docType).toBe('estimate');
    expect(v.documentId).toBe('18008');
    expect(v.documentNumber).toBe('18008');
    expect(v.estimateId).toBe('18008');
    expect(v.estimateNumber).toBe('18008');
    // The invoice pair stays null so mapping both never blanks the other.
    expect(v.invoiceId).toBeNull();
    expect(v.invoiceNumber).toBeNull();
  });

  it('takes the subtotal from the SubTotalLineDetail line', () => {
    expect(v.subtotal).toBe('14250.00');
  });

  it('cuts the first sales line at the first full stop', () => {
    expect(v.line1Description).toBe('12x24 Lofted Barn');
  });

  it('reads name and email off the document', () => {
    expect(v.customerFullName).toBe('Marcus Webb');
    expect(v.customerFirstName).toBe('Marcus');
    expect(v.customerEmail).toBe('marcus@example.com');
  });

  it('has no phone without the customer record', () => {
    expect(v.customerPhone).toBeNull();
  });

  it('splits the shipping address, dropping the name line', () => {
    expect(v.shippingStreet).toBe('4821 Township Road 118');
    expect(v.shippingCityStateZip).toBe('Millersburg, OH 44654');
    expect(v.shippingFull).toBe('4821 Township Road 118, Millersburg, OH 44654');
  });

  it('carries the rep raw AND named', () => {
    expect(v.rep).toBe('2');
    expect(v.repName).toBe('Cody');
  });
});

describe('extractDocFields — invoices', () => {
  const v = extractDocFields(INVOICE, { repField: 'Rep', repLabels: REP_LABELS });

  it('detects an invoice from Balance/DueDate and fills only the invoice ids', () => {
    expect(v.docType).toBe('invoice');
    expect(v.invoiceId).toBe('9042');
    expect(v.invoiceNumber).toBe('INV-9042');
    expect(v.estimateId).toBeNull();
    expect(v.estimateNumber).toBeNull();
  });

  it('falls back to the top-level SubTotal when there is no subtotal line', () => {
    expect(v.subtotal).toBe('14250.00');
  });

  it('uses InvoiceLink as the document link', () => {
    expect(v.pdfLink).toBe('https://connect.intuit.com/portal/app/CommerceNetwork/view/abc123');
  });
});

describe('extractDocFields — the customer record', () => {
  const customer = {
    DisplayName: 'Marcus Webb',
    GivenName: 'Marcus',
    FamilyName: 'Webb',
    PrimaryPhone: { FreeFormNumber: '(330) 555-0142' },
    PrimaryEmailAddr: { Address: 'billing@example.com' },
  };

  it('supplies the phone, which no sales document carries', () => {
    const v = extractDocFields(ESTIMATE, { customer });
    expect(v.customerPhone).toBe('(330) 555-0142');
  });

  it('falls back to the customer email only when the document has none', () => {
    expect(extractDocFields(ESTIMATE, { customer }).customerEmail).toBe('marcus@example.com');
    const noBillEmail = { ...ESTIMATE, BillEmail: undefined };
    expect(extractDocFields(noBillEmail, { customer }).customerEmail).toBe('billing@example.com');
  });

  it('falls back to Mobile when there is no primary phone', () => {
    const v = extractDocFields(ESTIMATE, {
      customer: { Mobile: { FreeFormNumber: '330-555-0199' } },
    });
    expect(v.customerPhone).toBe('330-555-0199');
  });

  it('reads the name off the customer when the document has no CustomerRef name', () => {
    const v = extractDocFields({ ...ESTIMATE, CustomerRef: { value: '412' } }, { customer });
    expect(v.customerFullName).toBe('Marcus Webb');
    expect(v.customerFirstName).toBe('Marcus');
  });
});

describe('extractDocFields — webhook-shaped payloads', () => {
  // The invoice trigger the Zaps use sends one `Line` OBJECT plus the full list
  // under `Lines`, and embeds the whole Customer instead of a CustomerRef.
  it('reads Lines[] and an embedded Customer', () => {
    const v = extractDocFields({
      Id: '5',
      DocNumber: '5',
      Balance: 100,
      Line: { DetailType: 'SalesItemLineDetail', Description: 'Single line object' },
      Lines: [
        { DetailType: 'SalesItemLineDetail', Description: 'From Lines. Ignored tail.' },
        { DetailType: 'SubTotalLineDetail', Amount: 250 },
      ],
      Customer: {
        DisplayName: 'Ruth Yoder',
        GivenName: 'Ruth',
        PrimaryPhone: { FreeFormNumber: '555-0100' },
        PrimaryEmailAddr: { Address: 'ruth@example.com' },
      },
    });
    expect(v.line1Description).toBe('From Lines');
    expect(v.subtotal).toBe('250.00');
    expect(v.customerFullName).toBe('Ruth Yoder');
    expect(v.customerPhone).toBe('555-0100');
    expect(v.customerEmail).toBe('ruth@example.com');
  });

  it('accepts a lone Line object', () => {
    const v = extractDocFields({
      Id: '6',
      Line: { DetailType: 'SalesItemLineDetail', Description: 'Only line' },
    });
    expect(v.line1Description).toBe('Only line');
  });

  it('trusts an explicit type over the Balance/DueDate heuristic', () => {
    const v = extractDocFields({ Id: '7', DocNumber: '7' }, { type: 'invoice' });
    expect(v.docType).toBe('invoice');
    expect(v.invoiceNumber).toBe('7');
  });
});

describe('shippingParts', () => {
  it('keeps a street line that is not preceded by a name line', () => {
    expect(shippingParts({ Line1: '55 Main St', Line2: 'Berlin, OH 44610' }, 'Somebody Else'))
      .toEqual({
        street: '55 Main St',
        cityStateZip: 'Berlin, OH 44610',
        full: '55 Main St, Berlin, OH 44610',
      });
  });

  it('handles a five-line address', () => {
    const p = shippingParts({
      Line1: 'Marcus Webb',
      Line2: 'c/o Rockwood',
      Line3: 'Building 4',
      Line4: '4821 Township Road 118',
      Line5: 'Millersburg, OH 44654-1234',
    }, 'Marcus Webb');
    expect(p.street).toBe('4821 Township Road 118');
    expect(p.cityStateZip).toBe('Millersburg, OH 44654-1234');
    expect(p.full).toBe('c/o Rockwood, Building 4, 4821 Township Road 118, Millersburg, OH 44654-1234');
  });

  it('composes the city line from structured fields when no line matches the shape', () => {
    const p = shippingParts({
      Line1: '4821 Township Road 118',
      City: 'Millersburg',
      CountrySubDivisionCode: 'OH',
      PostalCode: '44654',
    }, null);
    expect(p.cityStateZip).toBe('Millersburg, OH 44654');
    expect(p.street).toBe('4821 Township Road 118');
    expect(p.full).toBe('4821 Township Road 118, Millersburg, OH 44654');
  });

  it('returns nulls for a missing address rather than placeholder text', () => {
    expect(shippingParts(undefined, 'Marcus Webb')).toEqual({
      street: null, cityStateZip: null, full: null,
    });
  });

  it('does not treat the only line as the city line and leave no street', () => {
    const p = shippingParts({ Line1: 'Millersburg, OH 44654' }, null);
    expect(p.cityStateZip).toBe('Millersburg, OH 44654');
    expect(p.street).toBe('Millersburg, OH 44654');
  });
});

describe('repDisplayName', () => {
  it('maps an option id to the tenant-configured name', () => {
    expect(repDisplayName(REP_LABELS, '3')).toBe('Jadon');
  });

  it('matches case-insensitively and ignores surrounding space', () => {
    expect(repDisplayName([{ externalKey: 'rep::cody', ghlValue: 'Cody Miller' }], ' Cody ', 'Rep'))
      .toBe('Cody Miller');
  });

  it('falls back to the raw value when the rep is unmapped — never to a guess', () => {
    expect(repDisplayName(REP_LABELS, '9')).toBe('9');
  });

  it('is null when there is no rep at all', () => {
    expect(repDisplayName(REP_LABELS, null)).toBeNull();
    expect(repDisplayName(REP_LABELS, '   ')).toBeNull();
  });
});

describe('latestDocByCustomer', () => {
  it('picks the newest document per customer, invoices and estimates alike', () => {
    const map = latestDocByCustomer([ESTIMATE], [INVOICE]);
    expect(map.size).toBe(1);
    expect(map.get('412').type).toBe('invoice');
    expect(map.get('412').doc.Id).toBe('9042');
  });

  it('ignores array order — an older invoice does not beat a newer estimate', () => {
    const older = { ...INVOICE, MetaData: { LastUpdatedTime: '2026-01-01T00:00:00-07:00' } };
    const map = latestDocByCustomer([ESTIMATE], [older]);
    expect(map.get('412').doc.Id).toBe('18008');
  });

  it('skips documents with no customer', () => {
    expect(latestDocByCustomer([{ Id: '1' }], []).size).toBe(0);
  });

  it('orders customers by document recency, not estimates-then-invoices', () => {
    // The sync only visits a bounded number of contacts per pass, so a customer
    // whose INVOICE just changed must not queue behind every older estimate.
    const oldEstimate = {
      Id: 'E1', CustomerRef: { value: '100' },
      MetaData: { LastUpdatedTime: '2026-01-01T00:00:00-07:00' },
    };
    const newInvoice = {
      Id: 'I1', CustomerRef: { value: '200' },
      MetaData: { LastUpdatedTime: '2026-08-14T00:00:00-07:00' },
    };
    expect([...latestDocByCustomer([oldEstimate], [newInvoice]).keys()]).toEqual(['200', '100']);
  });
});

describe('docFieldWrites', () => {
  const values = extractDocFields(ESTIMATE, { repField: 'Rep', repLabels: REP_LABELS });

  it('writes only mapped fields, using the GHL field id', () => {
    const writes = docFieldWrites(values, [
      { externalKey: 'documentNumber', ghlValue: 'cf_doc' },
      { externalKey: 'repName', ghlValue: 'cf_rep' },
    ]);
    expect(writes).toEqual([
      { id: 'cf_doc', value: '18008' },
      { id: 'cf_rep', value: 'Cody' },
    ]);
  });

  it('skips a field this document does not carry, so the other type is not blanked', () => {
    const writes = docFieldWrites(values, [{ externalKey: 'invoiceNumber', ghlValue: 'cf_inv' }]);
    expect(writes).toEqual([]);
  });

  it('skips a value the contact already holds', () => {
    const mappings = [{ externalKey: 'documentNumber', ghlValue: 'cf_doc' }];
    const current = [{ id: 'cf_doc', value: '18008' }];
    expect(docFieldWrites(values, mappings, current)).toEqual([]);
  });

  it('matches the held value by fieldKey too', () => {
    const mappings = [{ externalKey: 'documentNumber', ghlValue: 'contact.estimate_no' }];
    const current = [{ fieldKey: 'contact.estimate_no', fieldValue: '18008' }];
    expect(docFieldWrites(values, mappings, current)).toEqual([]);
  });

  it('reads the opportunity custom-field shape when comparing', () => {
    // Opportunities come back as {id, key, fieldValue} rather than {id, value}.
    const mappings = [{ externalKey: 'documentNumber', ghlValue: 'opp_field_1' }];
    expect(docFieldWrites(values, mappings, [
      { id: 'opp_field_1', key: 'opportunity.estimate_no', fieldValue: '18008' },
    ])).toEqual([]);
    expect(docFieldWrites(values, mappings, [
      { id: 'opp_field_1', key: 'opportunity.estimate_no', fieldValue: '17999' },
    ])).toEqual([{ id: 'opp_field_1', value: '18008' }]);
  });

  it('writes when the held value differs', () => {
    const mappings = [{ externalKey: 'documentNumber', ghlValue: 'cf_doc' }];
    const current = [{ id: 'cf_doc', value: '17999' }];
    expect(docFieldWrites(values, mappings, current)).toEqual([{ id: 'cf_doc', value: '18008' }]);
  });

  it('never sends two writes for one target field', () => {
    const writes = docFieldWrites(values, [
      { externalKey: 'documentNumber', ghlValue: 'cf_same' },
      { externalKey: 'estimateNumber', ghlValue: 'cf_same' },
    ]);
    expect(writes).toEqual([{ id: 'cf_same', value: '18008' }]);
  });

  it('ignores rows with no target and unknown field keys', () => {
    expect(docFieldWrites(values, [
      { externalKey: 'documentNumber', ghlValue: '' },
      { externalKey: 'notAField', ghlValue: 'cf_x' },
    ])).toEqual([]);
  });
});

describe('DOC_FIELD_CATALOG', () => {
  it('has a unique key for every entry, and extraction returns exactly those keys', () => {
    expect(new Set(DOC_FIELD_KEYS).size).toBe(DOC_FIELD_CATALOG.length);
    expect(Object.keys(extractDocFields(ESTIMATE)).sort()).toEqual([...DOC_FIELD_KEYS].sort());
  });

  it('carries a label and a description for each field — the mapping UI shows both', () => {
    for (const f of DOC_FIELD_CATALOG) {
      expect(f.label).toBeTruthy();
      expect(f.description).toBeTruthy();
    }
  });
});

describe('universal option labels — any dropdown field, any client', () => {
  const LABELS = [
    { externalKey: 'rep::2', ghlValue: 'Cody' },
    { externalKey: 'siding color::4', ghlValue: 'Barn Red' },
  ];

  it('scopes names by FIELD, so option 2 can mean different things on two fields', () => {
    const labels = [
      { externalKey: 'rep::2', ghlValue: 'Cody' },
      { externalKey: 'trim color::2', ghlValue: 'White' },
    ];
    expect(optionLabel(labels, 'Rep', '2')).toBe('Cody');
    expect(optionLabel(labels, 'Trim Color', '2')).toBe('White');
  });

  it('falls back to the raw option number when nobody has named it', () => {
    expect(optionLabel(LABELS, 'Roofing Color', '7')).toBe('7');
  });

  it('builds its key case-insensitively from field and value', () => {
    expect(optionLabelKey(' Siding Color ', ' 4 ')).toBe('siding color::4');
  });

  it('adds the company OWN custom fields to the catalog, after the built-ins', () => {
    const catalog = docFieldCatalog(['Rep', 'Siding Color']);
    expect(catalog.length).toBe(DOC_FIELD_CATALOG.length + 2);
    const custom = catalog.filter((f) => f.custom);
    expect(custom.map((f) => f.key)).toEqual(['custom:Rep', 'custom:Siding Color']);
    expect(custom[1].label).toBe('Siding Color');
  });

  it('de-duplicates discovered field names and ignores blanks', () => {
    const catalog = docFieldCatalog(['Rep', 'rep', '  ', null]);
    expect(catalog.filter((f) => f.custom).length).toBe(1);
  });

  it('extracts a mapped custom field, named where a name exists', () => {
    const values = extractDocFields(ESTIMATE, {
      optionLabels: LABELS,
      customFieldNames: ['Rep', 'Siding Color'],
    });
    expect(values[customFieldKey('Rep')]).toBe('Cody');
    expect(values[customFieldKey('Siding Color')]).toBe('Barn Red');
  });

  it('gives an unnamed custom field its raw value rather than nothing', () => {
    const values = extractDocFields(ESTIMATE, { customFieldNames: ['Siding Color'] });
    expect(values[customFieldKey('Siding Color')]).toBe('4');
  });

  it('reports null for a custom field this document does not carry', () => {
    const values = extractDocFields(ESTIMATE, { customFieldNames: ['Roofing Color'] });
    expect(values[customFieldKey('Roofing Color')]).toBeNull();
  });

  it('a mapped custom field writes like any other catalog field', () => {
    const values = extractDocFields(ESTIMATE, {
      optionLabels: LABELS, customFieldNames: ['Siding Color'],
    });
    expect(docFieldWrites(values, [{ externalKey: 'custom:Siding Color', ghlValue: 'cf_siding' }]))
      .toEqual([{ id: 'cf_siding', value: 'Barn Red' }]);
  });
});

describe('optionsByField — what needs naming, discovered from the documents', () => {
  it('lists every field with its distinct values, most used first', () => {
    const second = {
      ...ESTIMATE,
      Id: '18009',
      CustomField: [
        { Name: 'Rep', StringValue: '2' },
        { Name: 'Siding Color', StringValue: '9' },
      ],
    };
    const out = optionsByField([ESTIMATE, second], [], [{ externalKey: 'rep::2', ghlValue: 'Cody' }]);
    const rep = out.find((f) => f.field === 'Rep');
    expect(rep.values).toEqual([{ value: '2', label: 'Cody', count: 2 }]);
    const siding = out.find((f) => f.field === 'Siding Color');
    expect(siding.values.map((v) => v.value).sort()).toEqual(['4', '9']);
    // Unnamed options report label null, which is what the editor shows as empty.
    expect(siding.values.every((v) => v.label === null)).toBe(true);
  });

  it('is empty when no document carries a custom field', () => {
    expect(optionsByField([{ Id: '1' }], [])).toEqual([]);
  });
});
