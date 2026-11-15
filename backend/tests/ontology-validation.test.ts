// tests/ontology-validation.test.ts — Phase 4: validate datasets injected into a run against the
// ontology entity they're bound to. Covers the PURE validator (type + PII coverage), the policy
// parse (data.validation_mode), and the DB orchestration (reverse-lookup + mapping + attrs) over
// real Postgres :5433.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import {
  validateInjectedDataset,
  validateInjectedAgainstOntology,
} from '../src/datasets/ontology-validation';
import { buildSnapshot } from '../src/host/policy-store';
import { resolveSampleByDatasetSlug } from '../src/ontology/sample-service';
import { createTenantEntity } from '../src/ontology/ontology-service';
import { upsertMapping } from '../src/datasets/mapping-service';
import type { Policy } from '../src/db/schema';
import type { DatasetColumn } from '../src/db/dataset-types';
import {
  db,
  users,
  tenants,
  datasets,
  ontologyEntities,
  ontologyEntitySamples,
  datasetMappings,
} from '../src/db/client';

// ---- pure validator ----

const COLS: DatasetColumn[] = [
  { name: 'clm_id', type: 'string' },
  { name: 'clm_amt', type: 'number' },
  { name: 'ssn_col', type: 'string', pii: false },
];
const ATTRS = [
  { name: 'claimId', type: 'string', pii: false },
  { name: 'amount', type: 'number', pii: false },
  { name: 'ssn', type: 'string', pii: true },
];
const MAP = { clm_id: 'claimId', clm_amt: 'amount', ssn_col: 'ssn' };

describe('validateInjectedDataset (pure)', () => {
  test('clean data + PII column flagged → no findings', () => {
    const cols = COLS.map((c) => (c.name === 'ssn_col' ? { ...c, pii: true } : c));
    const f = validateInjectedDataset({
      datasetSlug: 'ds',
      columns: cols,
      columnMap: MAP,
      attributes: ATTRS,
      rows: [{ clm_id: 'C1', clm_amt: 100, ssn_col: '111' }],
    });
    expect(f).toEqual([]);
  });

  test('PII attribute on a non-PII column → pii_uncovered', () => {
    const f = validateInjectedDataset({
      datasetSlug: 'ds',
      columns: COLS,
      columnMap: MAP,
      attributes: ATTRS,
      rows: [{ clm_id: 'C1', clm_amt: 100, ssn_col: '111' }],
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe('pii_uncovered');
    expect(f[0]!.attribute).toBe('ssn');
    expect(f[0]!.column).toBe('ssn_col');
  });

  test('value not matching the attribute type → type_mismatch', () => {
    const cols = COLS.map((c) => (c.name === 'ssn_col' ? { ...c, pii: true } : c));
    const f = validateInjectedDataset({
      datasetSlug: 'ds',
      columns: cols,
      columnMap: MAP,
      attributes: ATTRS,
      // amount (number) fed a non-numeric string + an object
      rows: [
        { clm_id: 'C1', clm_amt: 'not-a-number', ssn_col: '111' },
        { clm_id: 'C2', clm_amt: { nested: true }, ssn_col: '222' },
      ],
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe('type_mismatch');
    expect(f[0]!.column).toBe('clm_amt');
    expect(f[0]!.message).toContain('2 value');
  });

  test('null/absent values are not type errors', () => {
    const cols = COLS.map((c) => (c.name === 'ssn_col' ? { ...c, pii: true } : c));
    const f = validateInjectedDataset({
      datasetSlug: 'ds',
      columns: cols,
      columnMap: MAP,
      attributes: ATTRS,
      rows: [{ clm_id: 'C1', clm_amt: null, ssn_col: '111' }],
    });
    expect(f).toEqual([]);
  });

  test('empty columnMap → no findings (cannot validate meaning)', () => {
    expect(
      validateInjectedDataset({
        datasetSlug: 'ds',
        columns: COLS,
        columnMap: {},
        attributes: ATTRS,
        rows: [{ clm_amt: 'whatever' }],
      }),
    ).toEqual([]);
  });
});

describe('buildSnapshot data.validation_mode', () => {
  test("defaults to 'warn' when absent", () => {
    expect(buildSnapshot([]).dataValidation).toBe('warn');
  });
  test("parses 'block'", () => {
    const rows = [{ key: 'data.validation_mode', value: 'block' }] as unknown as Policy[];
    expect(buildSnapshot(rows).dataValidation).toBe('block');
  });
});

// ---- DB orchestration ----

const ORG = '00000000-0000-0000-0000-00000e000001';
const DEV_ID = '00000000-0000-0000-0000-00000e00de01';
const DS_ID = '0a000000-0000-4000-8000-00000eda0001';
let entityId: string;

async function cleanup() {
  await db.delete(ontologyEntitySamples).where(inArray(ontologyEntitySamples.tenant_id, [ORG]));
  await db.delete(datasets).where(inArray(datasets.tenant_id, [ORG]));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.tenant_id, [ORG]));
  await db.delete(users).where(inArray(users.id, [DEV_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [ORG]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([{ id: ORG, name: 'Val Org', slug: 'val-org', industry: 'insurance' }]);
  await db.insert(users).values([{ id: DEV_ID, email: 'val-dev@test', name: 'Val Dev', tenant_id: ORG }]);
  await db.insert(datasets).values([
    {
      id: DS_ID,
      owner_id: DEV_ID,
      tenant_id: ORG,
      name: 'Val Claims',
      slug: 'val-claims',
      source_type: 'json',
      row_count: 2,
      columns: COLS, // ssn_col NOT pii
    },
  ]);
  const e = await createTenantEntity(ORG, {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'ValClaim',
    label: 'Val Claim',
    attributes: [
      { name: 'claimId', type: 'string' },
      { name: 'amount', type: 'number' },
      { name: 'ssn', type: 'string', pii: true },
    ],
  });
  entityId = e.id;
  const mapping = await upsertMapping({
    datasetId: DS_ID,
    entityId,
    industry: 'insurance',
    department: 'Claims',
    columnMap: MAP,
    confidence: 1,
    source: 'human',
    confirmed: true,
    // tenantId: null = the GLOBAL scope this fixture has always written in (mapping writes became
    // tenant-scoped; readers still resolve "mine OR global", so behaviour here is unchanged).
    tenantId: null,
  });
  await db.insert(ontologyEntitySamples).values({
    entity_id: entityId,
    dataset_id: DS_ID,
    mapping_id: mapping.id,
    is_primary: true,
    tenant_id: ORG,
  });
}, 30_000);

afterAll(cleanup, 30_000);

test('resolveSampleByDatasetSlug returns the primary binding', async () => {
  const b = await resolveSampleByDatasetSlug(ORG, 'val-claims');
  expect(b).not.toBeNull();
  expect(b!.entityId).toBe(entityId);
  expect(b!.isPrimary).toBe(true);
  expect(b!.mappingId).not.toBeNull();
});

test('unbound slug → null', async () => {
  expect(await resolveSampleByDatasetSlug(ORG, 'no-such-slug')).toBeNull();
});

test('validateInjectedAgainstOntology flags the ontology-PII attr on the non-PII column', async () => {
  const findings = await validateInjectedAgainstOntology(ORG, {
    'val-claims': {
      columns: COLS, // ssn_col not pii
      rows: [{ clm_id: 'C1', clm_amt: 100, ssn_col: '111-22-3333' }],
    },
  });
  expect(findings.some((f) => f.rule === 'pii_uncovered' && f.attribute === 'ssn')).toBe(true);
});

test('validateInjectedAgainstOntology is clean for a conformant dataset', async () => {
  const findings = await validateInjectedAgainstOntology(ORG, {
    'val-claims': {
      columns: COLS.map((c) => (c.name === 'ssn_col' ? { ...c, pii: true } : c)),
      rows: [{ clm_id: 'C1', clm_amt: 100, ssn_col: '111' }],
    },
  });
  expect(findings).toEqual([]);
});

test('an unbound injected dataset is skipped (no findings)', async () => {
  const findings = await validateInjectedAgainstOntology(ORG, {
    'no-such-slug': { columns: COLS, rows: [{ clm_amt: 'bad' }] },
  });
  expect(findings).toEqual([]);
});
