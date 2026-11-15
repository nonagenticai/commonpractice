// tests/data-block-compiler.test.ts — Phase 3: the PURE entity → data-block compiler (no DB).
// Asserts the locked port shape (per-attribute scalar ports + rows/count), the type map, PII
// carry-through, deterministic slug, the defaulted dataset input, and the reference-by-slug source.
import { test, expect, describe } from 'bun:test';
import {
  compileDataBlock,
  dataBlockSlug,
  mapOntologyType,
  type DerivationInput,
} from '../src/ontology/data-block-compiler';

const baseEntity: DerivationInput['entity'] = {
  key: 'industry_dept:insurance:Claims:Claim',
  name: 'Claim',
  label: 'Claim',
  description: 'An insurance claim.',
  attributes: [
    { name: 'claimId', type: 'string', pii: false, description: 'The claim reference.' },
    { name: 'amount', type: 'number', pii: false, description: null },
    { name: 'ssn', type: 'string', pii: true, description: null },
    { name: 'meta', type: 'weird-custom-type', pii: false, description: null },
  ],
};

describe('mapOntologyType', () => {
  test('maps known ontology types to FieldTypes', () => {
    expect(mapOntologyType('string')).toBe('string');
    expect(mapOntologyType('text')).toBe('string');
    expect(mapOntologyType('date')).toBe('string');
    expect(mapOntologyType('email')).toBe('string');
    expect(mapOntologyType('number')).toBe('number');
    expect(mapOntologyType('integer')).toBe('number');
    expect(mapOntologyType('currency')).toBe('number');
    expect(mapOntologyType('boolean')).toBe('boolean');
    expect(mapOntologyType('string[]')).toBe('string[]');
    expect(mapOntologyType('json')).toBe('json');
  });
  test('unknown / custom types default to json', () => {
    expect(mapOntologyType('weird-custom-type')).toBe('json');
    expect(mapOntologyType('')).toBe('json');
  });
});

describe('dataBlockSlug', () => {
  test('is deterministic, kebab-case, prefixed', () => {
    expect(dataBlockSlug('industry_dept:insurance:Claims:Claim')).toBe(
      'data-industry-dept-insurance-claims-claim',
    );
    expect(dataBlockSlug('generic::Service:Customer')).toBe('data-generic-service-customer');
  });
  test('caps at 64 chars with no trailing dash', () => {
    const slug = dataBlockSlug('x'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('compileDataBlock', () => {
  const compiled = compileDataBlock({
    entity: baseEntity,
    datasetSlug: 'sample-claims',
    columnMap: { clm_id: 'claimId', clm_amt: 'amount' },
  });

  test('produces a data block with a deterministic slug', () => {
    expect(compiled.category).toBe('data');
    expect(compiled.slug).toBe('data-industry-dept-insurance-claims-claim');
    expect(compiled.name).toBe('Claim data');
    expect(compiled.description).toBe('An insurance claim.');
  });

  test('emits one scalar output port per attribute, typed + PII-flagged', () => {
    const out = compiled.descriptor.outputs;
    expect(out.claimId).toEqual({ type: 'string', description: 'The claim reference.' });
    expect(out.amount).toEqual({ type: 'number' });
    expect(out.ssn).toEqual({ type: 'string', pii: true });
    expect(out.meta).toEqual({ type: 'json' });
  });

  test('adds auxiliary rows (json) + count (number) ports for foreach (P5)', () => {
    expect(compiled.descriptor.outputs.rows!.type).toBe('json');
    expect(compiled.descriptor.outputs.count!.type).toBe('number');
  });

  test('declares one optional dataset input defaulted to the bound slug', () => {
    const src = compiled.descriptor.inputs.source!;
    expect(src.type).toBe('dataset');
    expect(src.default).toBe('sample-claims');
    expect(src.required).toBeUndefined(); // defaulted → never an unwired-input failure
    // ⛔ THIS ASSERTION USED TO READ `capabilities.mockData === true`, AND IT PINNED THE DEFECT.
    // A derived data block's `run()` is `await ctx.dataset(slug)` and never calls `ctx.mockData`
    // (the very next test greps the generated source for exactly that). It declared `mockData` only
    // to pass the executor's old shared gate — and the "Simulated" badge renders off that same flag,
    // so every ontology-derived block was about to tell a tenant that its own bound dataset was
    // fabricated. Asserting BOTH halves: the grant is present, and the fabrication claim is absent.
    expect(compiled.descriptor.capabilities.dataset).toBe(true);
    expect(compiled.descriptor.capabilities.mockData).toBeUndefined();
    expect(compiled.descriptor.capabilities.network).toBe(false);
  });

  test('source references the dataset by slug + bakes the column_map projection (no rows inlined)', () => {
    expect(compiled.source_ts).toContain('ctx.dataset(slug)');
    expect(compiled.source_ts).toContain('"clm_id":"claimId"');
    expect(compiled.source_ts).toContain('"sample-claims"');
    expect(compiled.source_ts).toContain('"claimId": first["claimId"]');
    expect(compiled.source_ts).toContain('rows: rows');
    expect(compiled.source_ts).toContain('count: rows.length');
  });

  test('empty column_map → identity passthrough', () => {
    const c = compileDataBlock({ entity: baseEntity, datasetSlug: 'ds', columnMap: {} });
    expect(c.source_ts).toContain('const COLMAP = {}');
  });

  test('falls back to a label-based description when the entity has none', () => {
    const c = compileDataBlock({
      entity: { ...baseEntity, description: null },
      datasetSlug: 'ds',
      columnMap: {},
    });
    expect(c.description).toBe('Sample data for the Claim entity.');
  });
});
