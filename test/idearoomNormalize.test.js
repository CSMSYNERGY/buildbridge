import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeLead } from '../src/services/idearoomNormalize.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'fixtures');
const loadFixture = (name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));

const carports = loadFixture('idearoom-carports-webhook-sample.json');
const sheds = loadFixture('idearoom-sheds-webhook-sample.json');

describe('normalizeLead — Carports (CarportView) sample', () => {
  const lead = normalizeLead(carports);

  it('maps the customer contact', () => {
    expect(lead.contact.email).toBe('rpannell@idearoom.com');
    expect(lead.contact.name).toBe('Testingly Testlicious');
    expect(lead.contact.phone).toBe('1234567890');
    expect(lead.contact.state).toBe('TX');
    expect(lead.contact.postalCode).toBe('75001');
  });

  it('uses integrationProperties for the product summary', () => {
    expect(lead.productSummary).toContain('Steel Barn');
    expect(lead.productSummary).toMatch(/20'\s*x\s*21'/);
  });

  it('maps event, hash, design link, and status', () => {
    expect(lead.eventType).toBe('created');
    expect(lead.hash).toBe('ef91cc417451ecfba13c726c738b7c6e');
    expect(lead.designUrl).toMatch(/^https?:\/\//);
    expect(lead.status).toBe('quote');
  });

  it('takes monetaryValue from totalPrice', () => {
    expect(lead.monetaryValue).toBe(carports.order.totalPrice);
    expect(typeof lead.monetaryValue).toBe('number');
  });

  it('collects render images as http(s) URLs', () => {
    expect(lead.images.length).toBeGreaterThan(0);
    expect(lead.images.every((u) => /^https?:\/\//.test(u))).toBe(true);
  });

  it('summarizes line items into a spec string', () => {
    expect(lead.specSummary).toContain('Style: Steel Barn');
    expect(Array.isArray(lead.lineItems)).toBe(true);
    expect(lead.lineItems.length).toBeGreaterThan(0);
  });
});

describe('normalizeLead — Sheds (ShedView) sample', () => {
  const lead = normalizeLead(sheds);

  it('maps the customer contact', () => {
    expect(lead.contact.email).toBe('rpannell@idearoom.com');
    expect(lead.contact.name).toBe('Testingly Testlicious');
  });

  it('falls back to sharePost.description when integrationProperties is absent', () => {
    // Sheds fixture has no integrationProperties → summary comes from sharePost.
    expect(sheds.order.integrationProperties ?? null).toBeNull();
    expect(lead.productSummary).toBe('Utility - 10x20');
  });

  it('takes monetaryValue from totalPrice and collects images', () => {
    expect(lead.monetaryValue).toBe(sheds.order.totalPrice);
    expect(lead.images.length).toBeGreaterThan(0);
  });
});

describe('normalizeLead — resilience', () => {
  it('handles an empty / missing payload without throwing', () => {
    const lead = normalizeLead({});
    expect(lead.contact.email).toBeNull();
    expect(lead.monetaryValue).toBeNull();
    expect(lead.images).toEqual([]);
    expect(lead.lineItems).toEqual([]);
    expect(lead.productSummary).toBe('IdeaRoom building');
  });

  it('normalizes eventType casing', () => {
    expect(normalizeLead({ eventType: 'Created' }).eventType).toBe('created');
  });
});
