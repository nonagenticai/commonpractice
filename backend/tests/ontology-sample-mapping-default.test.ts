// tests/ontology-sample-mapping-default.test.ts — the data contract has to be REACHABLE from the
// UI, not just implementable.
//
// ⛔ THE DEFECT THIS GUARDS, AND WHY IT NEEDED A CONSTRUCTION PROOF RATHER THAN A UNIT STUB.
// `bindEntitySample` is the ONLY writer of `ontology_entity_samples.mapping_id`, and neither of its
// two callers ever supplied one: the seed passed `{datasetId, isPrimary}` and
// `PUT /api/ontology/entities/:id/samples` passed `body.mappingId ?? null` from a screen with no
// mapping picker. So every row in that table held NULL, and `validateInjectedAgainstOntology`
// SKIPS a NULL binding by design. Net effect: `pii_uncovered` and `type_mismatch` could not fire
// for any real tenant however corrupt the data, and the 422/warn-pill UI built on top of them was
// unreachable code. A test that hand-inserted a `mapping_id` (as tests/run-data-findings.test.ts
// does, correctly, for what IT proves) would have stayed green through the entire defect.
//
// So this file goes through the REAL surfaces, end to end, in the order a human hits them:
//   1. save a confirmed mapping via `PUT /api/datasets/:slug/mappings`   (the Datasets screen)
//   2. bind the sample via `PUT /api/ontology/entities/:id/samples` with the EXACT body the
//      ontology page sends — `{datasetId, isPrimary}`, NO mappingId                (the Ontology screen)
//   3. corrupt the dataset so it genuinely violates the contract
//   4. `POST /api/runs` and assert a finding comes back
// Step 4 answered "0 findings" before this change and answers a real `type_mismatch` +
// `pii_uncovered` after it. Also pinned here: the NULL case still skips silently (no confirmed
// mapping ⇒ genuinely nothing to validate), and an explicit `mappingId` is stored unchanged.
//
// ⛔ AND THEN, IN THE OTHER ORDER — the two tests at the bottom of this file. Steps 1 and 2 above
// are the LUCKY order. The mapping is resolved when the run READS the binding, not when the
// binding is written, so `mapping_id` stays NULL for every UI-shaped bind and that is CORRECT.
// Do not "fix" a NULL `mapping_id` back into a stored id: it is what makes bind-before-confirm and
// `ON DELETE SET NULL` decay both harmless. `mapping_id` non-NULL means one thing only — a caller
// explicitly named a mapping.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerRunRoutes } from '../src/host/run-controller';
import { registerOntologyRoutes } from '../src/routes/ontology';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { buildSnapshot, __setSnapshotOverrideForTests } from '../src/host/policy-store';
import { createTenantEntity } from '../src/ontology/ontology-service';
import { upsertMapping } from '../src/datasets/mapping-service';
import {
  db,
  users,
  tenants,
  flows,
  flowRuns,
  flowRunEvents,
  datasets,
  datasetRows,
  datasetMappings,
  ontologyEntities,
  ontologyEntitySamples,
  buildingBlocks,
  blockVersions,
  sandboxes,
  auditLog,
  withTenantDb,
} from '../src/db/client';
import type { BlockDescriptor } from '../src/db/block-types';
import type { DatasetColumn } from '../src/db/dataset-types';
import type { FlowGraph } from '../src/db/flow-types';
import type { User } from '../src/types';
import { requireScannedSource } from '../src/blocks/source-gate';

const ORG = '00000000-0000-0000-0000-00000f9d0001';
const USER_ID = '00000000-0000-0000-0000-00000f9dda01';
const DS_ID = '0f9d0000-0000-4000-8000-00000f9d1001';
const DS_UNMAPPED_ID = '0f9d0000-0000-4000-8000-00000f9d1002';
const DS_ORDER_ID = '0f9d0000-0000-4000-8000-00000f9d1003';
const SLUG = 'ztest-dmapdef-claims';
const SLUG_UNMAPPED = 'ztest-dmapdef-orphan';
const SLUG_ORDER = 'ztest-dmapdef-order';
const BLOCK_SLUG = 'ztest-dmapdef-load';

/** Every dataset this file owns — cleanup and the mapping-scope deletes must cover all of them. */
const ALL_DS_IDS = [DS_ID, DS_UNMAPPED_ID, DS_ORDER_ID];

// `developer` — the role BOTH the ontology sample routes (requireOntologyManager) and the dataset
// mapping route gate on. Same user drives the run, so this is one person doing one workflow.
const user: User = {
  id: USER_ID,
  email: 'dmapdef@test',
  name: 'Della Mapper',
  roles: ['developer'],
  tenantId: ORG,
};

// CLEAN data that satisfies the contract. Step 3 corrupts a copy of it in place.
const COLS: DatasetColumn[] = [
  { name: 'clm_id', type: 'string' },
  { name: 'amt_col', type: 'number' },
  { name: 'ssn_col', type: 'string', pii: true },
];
const CLEAN_ROWS = [
  { clm_id: 'C1', amt_col: 10, ssn_col: '111-22-3333' },
  { clm_id: 'C2', amt_col: 20, ssn_col: '444-55-6666' },
];
const COLUMN_MAP = { clm_id: 'claimId', amt_col: 'amount', ssn_col: 'ssn' };

// The ORDER-PROOF dataset is born violating the contract, so the only variable in that test is
// WHEN the mapping is confirmed relative to the bind — never whether the data is bad.
const ORDER_COLS: DatasetColumn[] = [
  { name: 'clm_id', type: 'string' },
  { name: 'amt_col', type: 'number' },
  { name: 'ssn_col', type: 'string' }, // NOT flagged pii → pii_uncovered once mapped to `ssn`
];
const ORDER_ROWS = [
  { clm_id: 'O1', amt_col: 'not-a-number', ssn_col: '111-22-3333' },
  { clm_id: 'O2', amt_col: 'also-not', ssn_col: '444-55-6666' },
];

const DESCRIPTOR: BlockDescriptor = {
  inputs: { source: { type: 'dataset', required: true } },
  outputs: { count: { type: 'number' } },
  capabilities: { network: false },
};
const SOURCE = `export default {
  descriptor: ${JSON.stringify(DESCRIPTOR)},
  async run(inputs, ctx) {
    const rows = await ctx.dataset(inputs.source);
    return { count: rows.length };
  },
};
`;

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerRunRoutes(router);
registerOntologyRoutes(router);
registerDatasetRoutes(router);

/** Drive a route the way the browser does, inside the tenant's RLS session. */
async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDb(ORG, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** The stored `mapping_id` for one (entity, dataset) binding — the field under test. */
async function storedMappingId(datasetId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ mappingId: ontologyEntitySamples.mapping_id })
    .from(ontologyEntitySamples)
    .where(
      and(
        eq(ontologyEntitySamples.dataset_id, datasetId),
        eq(ontologyEntitySamples.tenant_id, ORG),
      ),
    );
  return row?.mappingId;
}

function pinWarn() {
  __setSnapshotOverrideForTests({
    ...buildSnapshot([]),
    dataValidation: 'warn',
    piiScrubbing: false,
  });
}

let entityId = '';
let orphanEntityId = '';
let orderEntityId = '';
let flowId = '';
let orderFlowId = '';
let unmappedFlowId = '';

async function cleanup() {
  const runIds = (
    await db.select({ id: flowRuns.id }).from(flowRuns).where(eq(flowRuns.tenant_id, ORG))
  ).map((r) => r.id);
  if (runIds.length) {
    await db.delete(flowRunEvents).where(inArray(flowRunEvents.run_id, runIds));
    await db.delete(flowRuns).where(inArray(flowRuns.id, runIds));
  }
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  await db.delete(sandboxes).where(eq(sandboxes.tenant_id, ORG));
  await db.delete(flows).where(eq(flows.tenant_id, ORG));
  await db.delete(ontologyEntitySamples).where(eq(ontologyEntitySamples.tenant_id, ORG));
  // Mappings written through the route are GLOBAL scope (tenant_id NULL) — delete by dataset.
  await db
    .delete(datasetMappings)
    .where(inArray(datasetMappings.dataset_id, ALL_DS_IDS));
  await db.delete(datasetRows).where(inArray(datasetRows.dataset_id, ALL_DS_IDS));
  await db.delete(datasets).where(eq(datasets.tenant_id, ORG));
  await db.delete(ontologyEntities).where(eq(ontologyEntities.tenant_id, ORG));
  const blocks = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(like(buildingBlocks.slug, `${BLOCK_SLUG}%`));
  if (blocks.length) {
    await db.delete(blockVersions).where(inArray(blockVersions.block_id, blocks.map((b) => b.id)));
    await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, blocks.map((b) => b.id)));
  }
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(tenants).where(eq(tenants.id, ORG));
}

/** Put the dataset back to CLEAN so each case starts from a contract-satisfying baseline. */
async function restoreClean() {
  await db.update(datasets).set({ columns: COLS }).where(eq(datasets.id, DS_ID));
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, DS_ID));
  await db
    .insert(datasetRows)
    .values(CLEAN_ROWS.map((data, idx) => ({ dataset_id: DS_ID, idx, data })));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores bunfig's
// [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db
    .insert(tenants)
    .values({ id: ORG, name: 'MapDefault Org', slug: 'zmapdefault-org', industry: 'insurance' });
  await db.insert(users).values({ id: USER_ID, email: user.email, name: user.name, tenant_id: ORG });
  await db.insert(datasets).values([
    {
      id: DS_ID,
      owner_id: USER_ID,
      tenant_id: ORG,
      name: 'MapDefault Claims',
      slug: SLUG,
      source_type: 'json',
      row_count: CLEAN_ROWS.length,
      columns: COLS,
    },
    {
      id: DS_UNMAPPED_ID,
      owner_id: USER_ID,
      tenant_id: ORG,
      name: 'MapDefault Orphan',
      slug: SLUG_UNMAPPED,
      source_type: 'json',
      row_count: 1,
      columns: COLS,
    },
    {
      id: DS_ORDER_ID,
      owner_id: USER_ID,
      tenant_id: ORG,
      name: 'MapDefault Order',
      slug: SLUG_ORDER,
      source_type: 'json',
      row_count: ORDER_ROWS.length,
      columns: ORDER_COLS,
    },
  ]);
  await restoreClean();
  await db.insert(datasetRows).values({ dataset_id: DS_UNMAPPED_ID, idx: 0, data: CLEAN_ROWS[0]! });
  await db
    .insert(datasetRows)
    .values(ORDER_ROWS.map((data, idx) => ({ dataset_id: DS_ORDER_ID, idx, data })));

  const entity = await createTenantEntity(ORG, {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'MapDefaultClaim',
    label: 'Map Default Claim',
    attributes: [
      { name: 'claimId', type: 'string' },
      { name: 'amount', type: 'number' },
      { name: 'ssn', type: 'string', pii: true },
    ],
  });
  entityId = entity.id;
  const orphan = await createTenantEntity(ORG, {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'MapDefaultOrphan',
    label: 'Map Default Orphan',
    attributes: [{ name: 'claimId', type: 'string' }],
  });
  orphanEntityId = orphan.id;
  const order = await createTenantEntity(ORG, {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'MapDefaultOrder',
    label: 'Map Default Order',
    attributes: [
      { name: 'claimId', type: 'string' },
      { name: 'amount', type: 'number' },
      { name: 'ssn', type: 'string', pii: true },
    ],
  });
  orderEntityId = order.id;

  const [block] = await db
    .insert(buildingBlocks)
    .values({ slug: BLOCK_SLUG, name: 'load for map default', category: 'data' })
    .returning();
  const [version] = await db
    .insert(blockVersions)
    .values({
      block_id: block!.id,
      version: '1.0.0',
      status: 'stable',
      published_at: new Date(),
      source_ts: requireScannedSource(SOURCE),
      descriptor: DESCRIPTOR as never,
    })
    .returning();
  const graphFor = (source: string): FlowGraph => ({
    nodes: [
      {
        id: 'n1',
        blockId: block!.id,
        blockVersionId: version!.id,
        slug: 'load',
        label: 'load',
        category: 'data',
        config: { source },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  });
  const [flow] = await db
    .insert(flows)
    .values({ name: 'mapdefault-flow', owner_id: USER_ID, graph: graphFor(SLUG), tenant_id: ORG })
    .returning();
  flowId = flow!.id;
  // A SECOND flow injecting only the order-proof dataset, so that test is unaffected by whatever
  // the other cases have left on DS_ID.
  const [orderFlow] = await db
    .insert(flows)
    .values({
      name: 'mapdefault-order-flow',
      owner_id: USER_ID,
      graph: graphFor(SLUG_ORDER),
      tenant_id: ORG,
    })
    .returning();
  orderFlowId = orderFlow!.id;
  // …and one injecting only the unmapped dataset, so "the validator stays SILENT" can be asserted
  // about that dataset rather than about whatever DS_ID happens to hold.
  const [unmappedFlow] = await db
    .insert(flows)
    .values({
      name: 'mapdefault-unmapped-flow',
      owner_id: USER_ID,
      graph: graphFor(SLUG_UNMAPPED),
      tenant_id: ORG,
    })
    .returning();
  unmappedFlowId = unmappedFlow!.id;
  asUser(user);
  pinWarn();
}, 60_000);

/** A warn-mode run REALLY spawns a subprocess; let it finish or the next case 409s sandbox_busy. */
async function settle() {
  for (let i = 0; i < 200; i++) {
    const live = await db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(and(eq(flowRuns.tenant_id, ORG), eq(flowRuns.status, 'running')));
    if (!live.length) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('a run did not finish in time');
}

// explicit hook timeout — see the long note in license-provisioning.test.ts.
afterEach(async () => {
  await settle();
  asUser(user);
  pinWarn();
}, 30_000);

afterAll(async () => {
  __setSnapshotOverrideForTests(undefined);
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 60_000);

// ─────────────────────────────── the construction proof, in order ───────────────────────────────

test('THE PROOF, step 1-2: a UI-shaped bind with NO mappingId stores the confirmed mapping', async () => {
  // Step 1 — the Datasets screen saves a confirmed mapping for (dataset, entity).
  const saved = await call('PUT', `/api/datasets/${SLUG}/mappings`, {
    mappings: [
      {
        entityId,
        industry: 'insurance',
        department: 'Claims',
        columnMap: COLUMN_MAP,
        confidence: 1,
      },
    ],
  });
  expect(saved.status).toBe(200);

  // Step 2 — the Ontology screen binds the sample. This body is EXACTLY what
  // frontend/src/routes/ontology/+page.svelte sends: no mappingId, because no control produces one.
  const bound = await call('PUT', `/api/ontology/entities/${entityId}/samples`, {
    datasetId: DS_ID,
    isPrimary: true,
  });
  expect(bound.status).toBe(200);

  // The stored column stays NULL — the caller named no mapping, so there is no OVERRIDE to store.
  // This is not the old defect wearing a new hat: the next test runs the same binding and gets
  // real findings, because the RUN resolves the mapping. Storing the resolver's answer here is the
  // thing that broke, and the two tests at the bottom of this file are why.
  expect(await storedMappingId(DS_ID)).toBeNull();
  expect(bound.json.sample.mappingId).toBeNull();
  const [mapping] = await db
    .select({ id: datasetMappings.id, confirmed: datasetMappings.confirmed })
    .from(datasetMappings)
    .where(eq(datasetMappings.dataset_id, DS_ID));
  expect(mapping!.confirmed).toBe(true);
});

test('THE PROOF, step 3-4: corrupted data now produces findings through the REAL run route', async () => {
  // Sanity first: the SAME binding over CLEAN data says nothing. Without this, a test that only
  // asserted "findings appear" could be satisfied by a validator that fires unconditionally.
  const clean = await call('POST', '/api/runs', { flowId });
  expect(clean.status).toBe(201);
  expect('dataValidation' in clean.json).toBe(false);
  await settle();

  // Step 3 — corrupt it. Two independent violations of the contract the human confirmed:
  //   • `amt_col` is mapped to the `amount` NUMBER attribute; feed it strings → type_mismatch
  //   • `ssn_col` is mapped to the `ssn` PII attribute; unflag the column → pii_uncovered, i.e.
  //     those values go into the sandbox in the clear.
  await db
    .update(datasets)
    .set({ columns: COLS.map((c) => (c.name === 'ssn_col' ? { ...c, pii: false } : c)) })
    .where(eq(datasets.id, DS_ID));
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, DS_ID));
  await db.insert(datasetRows).values([
    { dataset_id: DS_ID, idx: 0, data: { clm_id: 'C1', amt_col: 'not-a-number', ssn_col: '111-22-3333' } },
    { dataset_id: DS_ID, idx: 1, data: { clm_id: 'C2', amt_col: 'also-not', ssn_col: '444-55-6666' } },
  ]);

  try {
    // Step 4 — the real route, warn mode (the shipped default).
    const { status, json } = await call('POST', '/api/runs', { flowId });
    expect(status).toBe(201);
    // ⛔ RED BEFORE THE FIX: `dataValidation` was ABSENT here. Same corrupted data, same route,
    // same policy — zero findings, because the binding carried no mapping. That silence is the
    // entire defect: the pre-flight, the 422 and the amber pill were all unreachable.
    expect(
      json.dataValidation,
      'the run reported nothing about deliberately corrupted data — the contract is inert',
    ).toBeDefined();
    const findings = json.dataValidation.findings as Record<string, unknown>[];
    expect([...new Set(findings.map((f) => f.rule))].sort()).toEqual([
      'pii_uncovered',
      'type_mismatch',
    ]);
    const pii = findings.find((f) => f.rule === 'pii_uncovered')!;
    expect(pii.dataset).toBe(SLUG);
    expect(pii.column).toBe('ssn_col');
    expect(pii.attribute).toBe('ssn');
    const tm = findings.find((f) => f.rule === 'type_mismatch')!;
    expect(tm.column).toBe('amt_col');
    expect(tm.count).toBe(2);
  } finally {
    await restoreClean();
  }
});

test('NO confirmed mapping ⇒ the binding stays NULL and the validator skips SILENTLY', async () => {
  // The unchanged branch, and it must stay unchanged: a dataset nobody has mapped has nothing to
  // be validated AGAINST, so inventing a projection would be worse than saying nothing.
  const bound = await call('PUT', `/api/ontology/entities/${orphanEntityId}/samples`, {
    datasetId: DS_UNMAPPED_ID,
    isPrimary: true,
  });
  expect(bound.status).toBe(200);
  expect(bound.json.sample.mappingId).toBeNull();
  expect(await storedMappingId(DS_UNMAPPED_ID)).toBeNull();

  // …and a run injecting THAT dataset is clean, not merely finding-free: no `dataValidation` key.
  const { status, json } = await call('POST', '/api/runs', { flowId: unmappedFlowId });
  expect(status).toBe(201);
  expect('dataValidation' in json).toBe(false);
});

test('an UNCONFIRMED mapping is NOT defaulted to — a machine guess must not drive the gate', async () => {
  // `confirmed=false` is a heuristic/LLM PROPOSAL. Under `data.validation_mode: block` it could
  // refuse a run, so it is not allowed to become the projection by default.
  const proposal = await upsertMapping({
    datasetId: DS_UNMAPPED_ID,
    entityId: orphanEntityId,
    industry: 'insurance',
    department: 'Claims',
    columnMap: { clm_id: 'claimId' },
    confidence: 0.6,
    source: 'auto',
    confirmed: false,
    // tenantId: null = the GLOBAL scope this fixture has always written in (mapping writes became
    // tenant-scoped; readers still resolve "mine OR global", so behaviour here is unchanged).
    tenantId: null,
  });
  try {
    const bound = await call('PUT', `/api/ontology/entities/${orphanEntityId}/samples`, {
      datasetId: DS_UNMAPPED_ID,
      isPrimary: true,
    });
    expect(bound.status).toBe(200);
    expect(bound.json.sample.mappingId).toBeNull();

    // ⛔ AND AT READ TIME, which is where it now matters. Resolution moved to the run, so a NULL
    // binding is no longer a guarantee of silence — `resolveDefaultMappingId` re-decides on every
    // run and this is the assertion that keeps `confirmed=false` out of the gate.
    const { status, json } = await call('POST', '/api/runs', { flowId: unmappedFlowId });
    expect(status).toBe(201);
    expect(
      'dataValidation' in json,
      'an unreviewed machine proposal became the projection at read time — under ' +
        '`data.validation_mode: block` a heuristic guess can now refuse a run',
    ).toBe(false);

    // Passing that same unconfirmed id EXPLICITLY is refused too — otherwise the override path is
    // simply a way to ask for what the resolver just declined.
    const forced = await call('PUT', `/api/ontology/entities/${orphanEntityId}/samples`, {
      datasetId: DS_UNMAPPED_ID,
      mappingId: proposal.id,
      isPrimary: true,
    });
    expect(forced.status).toBe(400);
    expect(forced.json.error).toBe('mapping_dataset_mismatch');
  } finally {
    await db.delete(datasetMappings).where(eq(datasetMappings.id, proposal.id));
  }
});

test("a mapping authored for ANOTHER entity is REFUSED, not stored", async () => {
  // Pre-existing hole, harmless only while the validator was inert: the explicit path checked
  // `dataset_id` and nothing else. Now that a stored id is honoured at read time as an override
  // that SKIPS resolution, whatever this accepts is what a run is gated on — so it has to satisfy
  // every rule the resolver does. A mapping for a different entity projects this dataset's columns
  // onto another entity's attribute names; the validator drops the unknown names rather than
  // misvalidating them, so the old behaviour was a binding that silently validated NOTHING.
  const foreign = await upsertMapping({
    datasetId: DS_ID,
    entityId: orphanEntityId,
    industry: 'insurance',
    department: 'Claims',
    columnMap: { clm_id: 'claimId' },
    confidence: 1,
    source: 'human',
    confirmed: true,
    // tenantId: null = the GLOBAL scope this fixture has always written in (mapping writes became
    // tenant-scoped; readers still resolve "mine OR global", so behaviour here is unchanged).
    tenantId: null,
  });
  try {
    const bound = await call('PUT', `/api/ontology/entities/${entityId}/samples`, {
      datasetId: DS_ID,
      mappingId: foreign.id,
      isPrimary: true,
    });
    expect(bound.status).toBe(400);
    expect(bound.json.error).toBe('mapping_dataset_mismatch');
    // …and nothing was written: a refused bind must not half-apply.
    expect(await storedMappingId(DS_ID)).toBeNull();
  } finally {
    await db.delete(datasetMappings).where(eq(datasetMappings.id, foreign.id));
  }
});

test('an EXPLICIT mappingId always wins — read-time resolution never overrides the caller', async () => {
  // The caller's choice has to survive a resolver that would pick something else, so this builds a
  // case where the two genuinely differ. `resolveDefaultMappingId`'s first tie-break is
  // "tenant-owned beats global", so a tenant-scoped mapping for the SAME pair outranks a global
  // one. The two project different columns, so the RUN says which one was used — asserting the
  // stored uuid alone would not prove the reader honoured it.
  //
  // ⚠️ WHICH SIDE THE DATASETS SCREEN WRITES CHANGED. It used to leave `tenant_id` NULL, so this
  // test read its row as the GLOBAL half and added the tenant half by hand. That was the defect:
  // under the runtime role `cp_app` a NULL-scoped write is refused outright (0028 §4c INSERT
  // WITH CHECK) — the screen 500'd in production and only ever "worked" because the test
  // connection is the table owner. `PUT /api/datasets/:slug/mappings` now writes the dataset's
  // TENANT, so the screen supplies the tenant-owned half and the GLOBAL half — a seeded row, the
  // only kind that is legitimately NULL — is what this test has to fabricate.
  const putTenantMapping = (columnMap: Record<string, string>) =>
    call('PUT', `/api/datasets/${SLUG}/mappings`, {
      mappings: [{ entityId, industry: 'insurance', department: 'Claims', columnMap, confidence: 1 }],
    });
  // deliberately does NOT map ssn_col
  expect((await putTenantMapping({ amt_col: 'amount' })).status).toBe(200);
  const [tenantMapping] = await db
    .select({ id: datasetMappings.id })
    .from(datasetMappings)
    .where(
      and(
        eq(datasetMappings.dataset_id, DS_ID),
        eq(datasetMappings.entity_id, entityId),
        eq(datasetMappings.tenant_id, ORG),
      ),
    );
  expect(tenantMapping).toBeDefined();
  const [globalMapping] = await db
    .insert(datasetMappings)
    .values({
      dataset_id: DS_ID,
      entity_id: entityId,
      tenant_id: null, // a seeded row: global scope, and it DOES map ssn_col
      industry: 'insurance',
      department: 'Claims',
      column_map: COLUMN_MAP,
      confidence: 1,
      source: 'human',
      confirmed: true,
    })
    .returning();

  // Corrupt BOTH columns, so the projection alone decides which rules can fire.
  await db
    .update(datasets)
    .set({ columns: COLS.map((c) => (c.name === 'ssn_col' ? { ...c, pii: false } : c)) })
    .where(eq(datasets.id, DS_ID));
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, DS_ID));
  await db.insert(datasetRows).values([
    { dataset_id: DS_ID, idx: 0, data: { clm_id: 'C1', amt_col: 'nope', ssn_col: '111-22-3333' } },
  ]);

  try {
    // A. No explicit id → the reader resolves, and the tenant-scoped mapping outranks the global
    //    one. Only `amt_col` is projected, so `ssn_col` cannot raise anything.
    await call('PUT', `/api/ontology/entities/${entityId}/samples`, {
      datasetId: DS_ID,
      isPrimary: true,
    });
    const resolved = await call('POST', '/api/runs', { flowId });
    expect(resolved.status).toBe(201);
    expect([
      ...new Set((resolved.json.dataValidation.findings as Record<string, unknown>[]).map((f) => f.rule)),
    ]).toEqual(['type_mismatch']);
    await settle();

    // B. Same data, same mappings — but the caller names the GLOBAL one. It maps `ssn_col` too, so
    //    `pii_uncovered` appears. If read-time resolution had overridden the stored override, this
    //    would still be the tenant mapping's `type_mismatch`-only answer.
    const bound = await call('PUT', `/api/ontology/entities/${entityId}/samples`, {
      datasetId: DS_ID,
      mappingId: globalMapping!.id,
      isPrimary: true,
    });
    expect(bound.status).toBe(200);
    expect(await storedMappingId(DS_ID)).toBe(globalMapping!.id);

    const overridden = await call('POST', '/api/runs', { flowId });
    expect(overridden.status).toBe(201);
    const rules = [
      ...new Set((overridden.json.dataValidation.findings as Record<string, unknown>[]).map((f) => f.rule)),
    ].sort();
    expect(rules, "the reader re-resolved and discarded the caller's explicit mapping").toEqual([
      'pii_uncovered',
      'type_mismatch',
    ]);
  } finally {
    await settle();
    // Leave the pair with ONE mapping carrying COLUMN_MAP, exactly as later readers found it
    // before: drop the fabricated global row, and put the tenant row's full projection back.
    await db.delete(datasetMappings).where(eq(datasetMappings.id, globalMapping!.id));
    await putTenantMapping(COLUMN_MAP);
    await restoreClean();
    // Re-bind with no override so later readers see the ordinary NULL state.
    await call('PUT', `/api/ontology/entities/${entityId}/samples`, {
      datasetId: DS_ID,
      isPrimary: true,
    });
  }
});

// ───────────────────────── the ORDER proof: resolution must happen at READ time ─────────────────────────

test('THE ORDER PROOF: bind FIRST, confirm the mapping SECOND — the run still finds it', async () => {
  // ⛔ THE DEFECT THIS GUARDS. Resolving the mapping when the sample is BOUND only works if the
  // curator confirms the mapping BEFORE binding. Nothing enforces or even hints at that order:
  // frontend/src/routes/ontology/+page.svelte binds from a screen with NO mapping picker, so the
  // natural instinct — attach the test data first, map the columns second — leaves `mapping_id`
  // NULL forever. `PUT /api/datasets/:slug/mappings` re-resolves nothing (routes/datasets.ts),
  // so only an unbind/rebind or "Make primary" heals it, by accident. This is the exact sequence
  // that produced a permanently inert contract for a real tenant.

  // 1. Bind. No mapping exists for this (dataset, entity) pair yet.
  const bound = await call('PUT', `/api/ontology/entities/${orderEntityId}/samples`, {
    datasetId: DS_ORDER_ID,
    isPrimary: true,
  });
  expect(bound.status).toBe(200);
  expect(bound.json.sample.mappingId).toBeNull();
  expect(await storedMappingId(DS_ORDER_ID)).toBeNull();

  // With genuinely nothing to validate against, the run is silent — and must stay silent.
  // Without this assertion the test could be satisfied by a validator that fires unconditionally.
  const before = await call('POST', '/api/runs', { flowId: orderFlowId });
  expect(before.status).toBe(201);
  expect('dataValidation' in before.json).toBe(false);
  await settle();

  // 2. NOW confirm the mapping, from the Datasets screen — after the bind.
  const saved = await call('PUT', `/api/datasets/${SLUG_ORDER}/mappings`, {
    mappings: [
      {
        entityId: orderEntityId,
        industry: 'insurance',
        department: 'Claims',
        columnMap: COLUMN_MAP,
        confidence: 1,
      },
    ],
  });
  expect(saved.status).toBe(200);

  // The stored column is UNTOUCHED by that save — and this assertion is deliberate, not incidental.
  // It pins WHY the resolution cannot live at bind time: no write path re-resolves it.
  expect(
    await storedMappingId(DS_ORDER_ID),
    'PUT /mappings re-resolves nothing — if this is ever non-null, read-time resolution has been ' +
      'quietly replaced by a second write-time one and the two can drift',
  ).toBeNull();

  // 3. Run again. NO re-bind, NO "Make primary", no unbind/rebind — nothing but the run.
  const { status, json } = await call('POST', '/api/runs', { flowId: orderFlowId });
  expect(status).toBe(201);
  // ⛔ RED BEFORE READ-TIME RESOLUTION: `dataValidation` was ABSENT. Same corrupt data, same
  // confirmed mapping, same policy — silent, purely because the curator did two steps in the
  // order the UI invites.
  expect(
    json.dataValidation,
    'the run said nothing about deliberately corrupt data whose mapping IS confirmed — resolution ' +
      'is still happening at bind time and the order of operations still decides the outcome',
  ).toBeDefined();
  const findings = json.dataValidation.findings as Record<string, unknown>[];
  expect([...new Set(findings.map((f) => f.rule))].sort()).toEqual([
    'pii_uncovered',
    'type_mismatch',
  ]);
  expect(findings.find((f) => f.rule === 'pii_uncovered')!.column).toBe('ssn_col');
  expect(findings.find((f) => f.rule === 'type_mismatch')!.count).toBe(2);
});

test('THE DECAY PROOF: a pruned mapping self-heals on the next run, with no re-bind', async () => {
  // ⛔ THE SECOND DECAY PATH. `ontology_entity_samples.mapping_id` is ON DELETE SET NULL, and
  // `pruneCellMappings` fires inside EVERY `PUT /mappings` save for entities dropped from the
  // cell. So a stored mapping silently reverts to NULL mid-life. Under write-time resolution
  // nothing ever re-heals it; under read-time resolution the next run simply re-resolves.
  const cell = { industry: 'insurance', department: 'Claims', confidence: 1 };

  // Re-point the cell at a DIFFERENT entity: this prunes the order entity's mapping outright.
  const repointed = await call('PUT', `/api/datasets/${SLUG_ORDER}/mappings`, {
    mappings: [{ entityId: orphanEntityId, columnMap: { clm_id: 'claimId' }, ...cell }],
  });
  expect(repointed.status).toBe(200);
  const survivors = await db
    .select({ entityId: datasetMappings.entity_id })
    .from(datasetMappings)
    .where(eq(datasetMappings.dataset_id, DS_ORDER_ID));
  expect(survivors.map((s) => s.entityId)).toEqual([orphanEntityId]);

  // Put it back — a NEW row, with a NEW id the old binding could never have stored.
  const restored = await call('PUT', `/api/datasets/${SLUG_ORDER}/mappings`, {
    mappings: [
      { entityId: orderEntityId, columnMap: COLUMN_MAP, ...cell },
      { entityId: orphanEntityId, columnMap: { clm_id: 'claimId' }, ...cell },
    ],
  });
  expect(restored.status).toBe(200);
  expect(await storedMappingId(DS_ORDER_ID)).toBeNull();

  const { status, json } = await call('POST', '/api/runs', { flowId: orderFlowId });
  expect(status).toBe(201);
  expect(
    json.dataValidation,
    'the contract stayed dead after a prune+restore — a mapping edit elsewhere can still kill it',
  ).toBeDefined();
  expect((json.dataValidation.findings as unknown[]).length).toBeGreaterThan(0);
});
