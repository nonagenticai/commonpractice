// tests/dataset-member-masking.test.ts — W8/P7: every read path that hands dataset VALUES to a
// browser masks them for a reader who is NOT a data manager (owner decision 2026-10-14). The rule
// lives in src/datasets/member-view.ts: a value is shown only for a column that is not flagged PII,
// is mapped by a CONFIRMED mapping, and maps only to non-PII ontology attributes. Unmapped ⇒ masked.
//
// ⛔ EVERY MEMBER READ RUNS AS `cp_app` (withTenantDbAsRuntimeRoleForTests). The mask decision reads
// `dataset_mappings` and the ontology under RLS; the owner connection bypasses RLS, so an owner-role
// test could pass while the production role saw no mapping (or a wider set) — see
// commonpractice-metering-bypass memory. The fixture's meta-test below proves RLS is biting.
//
// The fixture has one column of each kind, so each assertion pins one branch of the rule:
//   claim_id     → mapped to a non-PII attribute           → SHOWN
//   holder_name  → mapped to a PII attribute (`holder`)    → masked (ontology flag)
//   notes        → not mapped                              → masked (unmapped default)
//   email        → mapped to a non-PII attribute BUT the column is flagged pii → masked (column flag)
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { registerConnectorRoutes } from '../src/routes/connectors';
import { registerChallengeRoutes } from '../src/routes/challenges';
import {
  db,
  tenants,
  users,
  datasets,
  datasetRows,
  datasetMappings,
  ontologyEntities,
  ontologyAttributes,
  challenges,
  challengeDatasets,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { PII_REDACTION } from '../src/db/dataset-types';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts).
const T = '00000000-0000-0000-0000-00000a8b0001';
const T_OTHER = '00000000-0000-0000-0000-00000a8b0002';
const MEMBER_ID = '00000000-0000-0000-0000-00000a8b0011';
const DEV_ID = '00000000-0000-0000-0000-00000a8b0012';
const ENTITY_ID = '00000000-0000-0000-0000-00000a8b0021';
const ENTITY2_ID = '00000000-0000-0000-0000-00000a8b0022';
// RFC-shaped (version 4) on purpose: `PUT …/mappings` validates `entityId` with z.uuid().
const ENTITY3_ID = '00000000-0000-4000-8000-00000a8b0023';
const DS_ID = '00000000-0000-0000-0000-00000a8b0031';
const CONN_ID = '00000000-0000-0000-0000-00000a8b0032';
const OTHER_DS_ID = '00000000-0000-0000-0000-00000a8b0033';
const FREE_DS_ID = '00000000-0000-0000-0000-00000a8b0034';
const FREE_SLUG = 'w8-mask-free-text';
const CH_ID = '00000000-0000-0000-0000-00000a8b0041';
const SLUG = 'w8-mask-claims';
const CONN_SLUG = 'w8-mask-feed';

const member: User = { id: MEMBER_ID, email: 'w8m-member@test', name: 'W8 Member', roles: [], tenantId: T };
const developer: User = { id: DEV_ID, email: 'w8m-dev@test', name: 'W8 Dev', roles: ['developer'], tenantId: T };

const COLUMNS = [
  { name: 'claim_id', type: 'string' as const, sample: 'CLM-1' },
  { name: 'holder_name', type: 'string' as const, sample: 'Anna de Vries' },
  { name: 'notes', type: 'string' as const, sample: 'Called Anna at home' },
  { name: 'email', type: 'string' as const, pii: true, sample: 'anna@x.invalid' },
];
const ROWS = [
  { claim_id: 'CLM-1', holder_name: 'Anna de Vries', notes: 'Called Anna at home', email: 'anna@x.invalid' },
  { claim_id: 'CLM-2', holder_name: 'Bram Jansen', notes: 'Lives at Kade 4', email: 'bram@x.invalid' },
];
const MASKED = ['holder_name', 'notes', 'email'];

const router = new Router();
registerDatasetRoutes(router);
registerConnectorRoutes(router);
registerChallengeRoutes(router);

function as(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

async function call(path: string) {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const res = await matched.handler(new Request(`http://localhost${path}`), ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** The production shape: `cp_app` (NOBYPASSRLS) with the tenant GUC set. */
const asRuntime = (path: string) => withTenantDbAsRuntimeRoleForTests(T, () => call(path));

async function cleanup() {
  await db.delete(challengeDatasets).where(eq(challengeDatasets.challenge_id, CH_ID));
  await db.delete(challenges).where(eq(challenges.id, CH_ID));
  await db.delete(datasetMappings).where(inArray(datasetMappings.dataset_id, [DS_ID, CONN_ID, OTHER_DS_ID, FREE_DS_ID]));
  await db.delete(datasetRows).where(inArray(datasetRows.dataset_id, [DS_ID, CONN_ID, OTHER_DS_ID, FREE_DS_ID]));
  await db.delete(datasets).where(inArray(datasets.id, [DS_ID, CONN_ID, OTHER_DS_ID, FREE_DS_ID]));
  await db.delete(ontologyAttributes).where(inArray(ontologyAttributes.entity_id, [ENTITY_ID, ENTITY2_ID, ENTITY3_ID]));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.id, [ENTITY_ID, ENTITY2_ID, ENTITY3_ID]));
  await db.delete(users).where(inArray(users.id, [MEMBER_ID, DEV_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [T, T_OTHER]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: T, name: 'W8 Mask Tenant', slug: 'w8-mask' },
    { id: T_OTHER, name: 'W8 Mask Other', slug: 'w8-mask-other' },
  ]);
  await db.insert(users).values([
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: T },
    { id: DEV_ID, email: developer.email, name: developer.name, tenant_id: T },
  ]);
  await db.insert(ontologyEntities).values([
    { id: ENTITY_ID, scope: 'generic', department: 'W8MaskDept', name: 'W8MaskClaim', label: 'Claim', tenant_id: T },
    { id: ENTITY2_ID, scope: 'generic', department: 'W8MaskDept', name: 'W8MaskNote', label: 'Note', tenant_id: T },
    { id: ENTITY3_ID, scope: 'generic', department: 'W8MaskDept', name: 'W8MaskRemark', label: 'Remark', tenant_id: T },
  ]);
  await db.insert(ontologyAttributes).values([
    { entity_id: ENTITY_ID, name: 'claim_id', type: 'string', pii: false },
    { entity_id: ENTITY_ID, name: 'holder', type: 'string', pii: true },
    { entity_id: ENTITY_ID, name: 'contact', type: 'string', pii: false },
    { entity_id: ENTITY2_ID, name: 'text', type: 'string', pii: false },
    { entity_id: ENTITY3_ID, name: 'text', type: 'string', pii: false },
  ]);
  await db.insert(datasets).values([
    { id: DS_ID, owner_id: DEV_ID, tenant_id: T, name: 'W8 Claims', slug: SLUG, source_type: 'csv', columns: COLUMNS, row_count: 2 },
    { id: CONN_ID, owner_id: DEV_ID, tenant_id: T, name: 'W8 Feed', slug: CONN_SLUG, source_type: 'http', columns: COLUMNS, row_count: 2 },
    // Another tenant's dataset whose confirmed mapping would UNMASK `notes` — it must not leak into
    // T's decision (the mapping is keyed by dataset, so it cannot, but this pins it).
    { id: OTHER_DS_ID, owner_id: DEV_ID, tenant_id: T_OTHER, name: 'W8 Other', slug: SLUG, source_type: 'csv', columns: COLUMNS, row_count: 0 },
  ]);
  // A column a data manager has mapped to a NON-PII attribute — so it is SHOWN to members — whose
  // free text nevertheless carries personal values. Value detection must catch them in place.
  await db.insert(datasets).values({
    id: FREE_DS_ID, owner_id: DEV_ID, tenant_id: T, name: 'W8 Free text', slug: FREE_SLUG, source_type: 'csv', row_count: 2,
    columns: [{ name: 'claim_id', type: 'string', sample: 'Bel 06-12345678 na 17u' }],
  });
  await db.insert(datasetRows).values([
    { dataset_id: FREE_DS_ID, idx: 0, data: { claim_id: 'Bel 06-12345678 na 17u' } },
    { dataset_id: FREE_DS_ID, idx: 1, data: { claim_id: 'Mail j.bakker@voorbeeld.nl, IBAN NL91 ABNA 0417 1643 00' } },
  ]);
  await db.insert(datasetMappings).values({
    dataset_id: FREE_DS_ID, entity_id: ENTITY_ID, industry: '', department: 'W8MaskDept', column_map: { claim_id: 'claim_id' }, confirmed: true, tenant_id: T,
  });
  await db.insert(datasetRows).values([
    ...ROWS.map((data, idx) => ({ dataset_id: DS_ID, idx, data })),
    ...ROWS.map((data, idx) => ({ dataset_id: CONN_ID, idx, data })),
  ]);
  const columnMap = { claim_id: 'claim_id', holder_name: 'holder', email: 'contact' };
  await db.insert(datasetMappings).values([
    { dataset_id: DS_ID, entity_id: ENTITY_ID, industry: '', department: 'W8MaskDept', column_map: columnMap, confirmed: true, tenant_id: T },
    { dataset_id: CONN_ID, entity_id: ENTITY_ID, industry: '', department: 'W8MaskDept', column_map: columnMap, confirmed: true, tenant_id: T },
    // An UNCONFIRMED mapping of `notes` to a non-PII attribute: a proposal, not a decision, so it
    // must not unmask anything.
    { dataset_id: DS_ID, entity_id: ENTITY2_ID, industry: '', department: 'W8MaskDept', column_map: { notes: 'text' }, confirmed: false, tenant_id: T },
  ]);
  await db.insert(challenges).values({
    id: CH_ID,
    tenant_id: T,
    title: 'W8 mask challenge',
    work_area: 'Claims',
    submitter_id: MEMBER_ID,
    status: 'voting',
    week: '2026-W42',
  });
  await db.insert(challengeDatasets).values({ challenge_id: CH_ID, dataset_slug: SLUG, added_by: MEMBER_ID });
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

const colSample = (cols: { name: string; sample?: unknown }[], name: string) =>
  cols.find((c) => c.name === name)?.sample;

test('the fixture really runs under RLS — another tenant\'s dataset is invisible to cp_app', async () => {
  const seen = await withTenantDbAsRuntimeRoleForTests(T, async () =>
    (await db.select({ id: datasets.id }).from(datasets).where(inArray(datasets.id, [DS_ID, OTHER_DS_ID]))).map((r) => r.id),
  );
  expect(seen).toEqual([DS_ID]);
});

test('GET /api/datasets/:slug — a member gets masked values; only the mapped non-PII column is shown', async () => {
  as(member);
  const r = await asRuntime(`/api/datasets/${SLUG}`);
  expect(r.status).toBe(200);
  expect(r.json.rows).toHaveLength(2);
  expect(r.json.maskedColumns).toEqual(MASKED);
  for (const row of r.json.rows) {
    expect(row.holder_name).toBe(PII_REDACTION);
    expect(row.notes).toBe(PII_REDACTION);
    expect(row.email).toBe(PII_REDACTION);
  }
  expect(r.json.rows.map((x: { claim_id: string }) => x.claim_id)).toEqual(['CLM-1', 'CLM-2']);
  // The column `sample` is a real cell value and must be masked the same way.
  expect(colSample(r.json.columns, 'holder_name')).toBe(PII_REDACTION);
  expect(colSample(r.json.columns, 'notes')).toBe(PII_REDACTION);
  expect(colSample(r.json.columns, 'claim_id')).toBe('CLM-1');
  expect(JSON.stringify(r.json)).not.toContain('Anna');
});

test('GET /api/datasets/:slug — a data manager (developer) gets raw values', async () => {
  as(developer);
  const r = await asRuntime(`/api/datasets/${SLUG}`);
  expect(r.status).toBe(200);
  expect(r.json.maskedColumns).toEqual([]);
  expect(r.json.rows).toEqual(ROWS);
  expect(colSample(r.json.columns, 'holder_name')).toBe('Anna de Vries');
});

test('GET /api/datasets — the list masks column samples for a member, not for a developer', async () => {
  as(member);
  const m = await asRuntime('/api/datasets');
  const mine = m.json.items.find((d: { slug: string }) => d.slug === SLUG);
  expect(mine.maskedColumns).toEqual(MASKED);
  expect(colSample(mine.columns, 'holder_name')).toBe(PII_REDACTION);
  expect(JSON.stringify(mine)).not.toContain('Anna');

  as(developer);
  const d = await asRuntime('/api/datasets');
  const raw = d.json.items.find((x: { slug: string }) => x.slug === SLUG);
  expect(colSample(raw.columns, 'holder_name')).toBe('Anna de Vries');
});

test('GET /api/connectors/:slug and the list — a member gets masked values, a developer raw', async () => {
  as(member);
  const r = await asRuntime(`/api/connectors/${CONN_SLUG}`);
  expect(r.status).toBe(200);
  expect(r.json.maskedColumns).toEqual(MASKED);
  expect(r.json.rows[0]).toEqual({ claim_id: 'CLM-1', holder_name: PII_REDACTION, notes: PII_REDACTION, email: PII_REDACTION });
  const list = await asRuntime('/api/connectors');
  const item = list.json.items.find((c: { slug: string }) => c.slug === CONN_SLUG);
  expect(colSample(item.columns, 'notes')).toBe(PII_REDACTION);

  as(developer);
  const raw = await asRuntime(`/api/connectors/${CONN_SLUG}`);
  expect(raw.json.rows).toEqual(ROWS);
});

test('GET /api/challenges/:id — the challenge\'s sample data carries masked column samples for a member', async () => {
  as(member);
  const r = await asRuntime(`/api/challenges/${CH_ID}`);
  expect(r.status).toBe(200);
  const ds = r.json.datasets.find((d: { slug: string }) => d.slug === SLUG);
  expect(ds.maskedColumns).toEqual(MASKED);
  expect(colSample(ds.columns, 'holder_name')).toBe(PII_REDACTION);
  expect(JSON.stringify(r.json.datasets)).not.toContain('Anna');

  as(developer);
  const raw = await asRuntime(`/api/challenges/${CH_ID}`);
  const rawDs = raw.json.datasets.find((d: { slug: string }) => d.slug === SLUG);
  expect(rawDs.maskedColumns).toEqual([]);
  expect(colSample(rawDs.columns, 'holder_name')).toBe('Anna de Vries');
});

test('a SHOWN column is still value-scrubbed for a member — phone, e-mail and IBAN replaced in place; raw for a developer', async () => {
  as(member);
  const r = await asRuntime(`/api/datasets/${FREE_SLUG}`);
  expect(r.status).toBe(200);
  expect(r.json.maskedColumns).toEqual([]); // mapped to a non-PII attribute: the column is shown…
  expect(r.json.rows.map((x: { claim_id: string }) => x.claim_id)).toEqual([
    `Bel ${PII_REDACTION} na 17u`, // …but the personal value inside it is not
    `Mail ${PII_REDACTION}, IBAN ${PII_REDACTION}`,
  ]);
  expect(colSample(r.json.columns, 'claim_id')).toBe(`Bel ${PII_REDACTION} na 17u`);

  as(developer);
  const raw = await asRuntime(`/api/datasets/${FREE_SLUG}`);
  expect(raw.json.rows[0].claim_id).toBe('Bel 06-12345678 na 17u');
  expect(colSample(raw.json.columns, 'claim_id')).toBe('Bel 06-12345678 na 17u');
});

// ---- who may confirm/delete a mapping (2026-10-15) ----
// A confirmed mapping to a non-PII attribute is what UNMASKS a column for members, so confirming or
// deleting one is a data manager's decision. These routes used to call `resolveTenant` only: any
// member could PUT `notes → Note.text` and every member then saw the free-text column raw.

async function send(method: 'PUT' | 'DELETE', path: string, body?: unknown) {
  const matched = router.match(method, path);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await withTenantDbAsRuntimeRoleForTests(T, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// A different (industry × department) cell from the fixture's, so the replace-for-cell prune of a
// developer's PUT cannot touch the fixture's `claim_id` mapping.
const UNMASK_NOTES = {
  mappings: [{ entityId: ENTITY3_ID, industry: 'W8MaskInd', department: 'W8MaskDept', columnMap: { notes: 'text' }, confidence: 1 }],
};

test('PUT /api/datasets/:slug/mappings — a member is refused (403) and the column STAYS masked', async () => {
  as(member);
  const r = await send('PUT', `/api/datasets/${SLUG}/mappings`, UNMASK_NOTES);
  expect(r.status).toBe(403);
  expect(r.json.error).toBe('data_manager_required');
  const written = await db.select({ id: datasetMappings.id }).from(datasetMappings).where(eq(datasetMappings.entity_id, ENTITY3_ID));
  expect(written).toEqual([]);
  const view = await asRuntime(`/api/datasets/${SLUG}`);
  expect(view.json.maskedColumns).toContain('notes');
  expect(JSON.stringify(view.json.rows)).not.toContain('Called Anna');
});

test('DELETE /api/datasets/:slug/mappings/:entityId — a member is refused (403) and the mapping survives', async () => {
  as(member);
  const r = await send('DELETE', `/api/datasets/${SLUG}/mappings/${ENTITY_ID}`);
  expect(r.status).toBe(403);
  expect(r.json.error).toBe('data_manager_required');
  const still = await db
    .select({ id: datasetMappings.id })
    .from(datasetMappings)
    .where(and(eq(datasetMappings.entity_id, ENTITY_ID), eq(datasetMappings.dataset_id, DS_ID)));
  expect(still.length).toBe(1);
});

test('a data manager may confirm a mapping (200) — which is what unmasks the column — and delete it (200)', async () => {
  as(developer);
  const put = await send('PUT', `/api/datasets/${SLUG}/mappings`, UNMASK_NOTES);
  expect(put.status).toBe(200);
  as(member);
  const shown = await asRuntime(`/api/datasets/${SLUG}`);
  expect(shown.json.maskedColumns).not.toContain('notes');

  as(developer);
  const del = await send('DELETE', `/api/datasets/${SLUG}/mappings/${ENTITY3_ID}`);
  expect(del.status).toBe(200);
  as(member);
  const masked = await asRuntime(`/api/datasets/${SLUG}`);
  expect(masked.json.maskedColumns).toContain('notes');
});
