// tests/run-data-findings.test.ts — `POST /api/runs` must TELL SOMEONE when the injected test data
// violates the ontology data contract.
//
// ⛔ THE DEFECT. `data.validation_mode` ships as `warn` (backend/src/db/seed-platform.ts), and in
// `warn` the run pre-flight computed a full `DataValidationFinding[]` — dataset, column, attribute,
// and the sentence "…would be injected UNREDACTED" — then threw all of it away: an audit row
// carrying the integer `2`, and a 201 body byte-identical to a clean run. The tester watched a
// green run while PII went into the sandbox unredacted. In `block` the findings did reach the 422,
// but the audit row was the same bare integer, so the auditor could not tell a type slip from a
// PII leak without reproducing the run.
//
// These tests assert the two carriers separately, because they fail separately:
//   • the 201 body    → `dataValidation: { mode, findings }` (the thing the browser can render)
//   • the audit row   → `findingRules` + `findingRefs` (the thing the auditor reads later)
//
// The run is driven through the REAL router against real Postgres, exactly like runs.test.ts —
// a hand-built call to `validateInjectedAgainstOntology` would prove the validator (already
// covered by ontology-validation.test.ts) and nothing about what the ROUTE does with it.
//
// The governance snapshot is pinned with `__setSnapshotOverrideForTests` rather than by writing
// `policies` rows: the policy table is shared platform state and a mutation here would leak into
// every other file in the suite. It also pins `piiScrubbing: false` — with redaction ON the
// injected values are blanked, which changes what `type_mismatch` sees.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerRunRoutes } from '../src/host/run-controller';
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
  ontologyAttributes,
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

const ORG = '00000000-0000-0000-0000-00000f000001';
const USER_ID = '00000000-0000-0000-0000-00000f00da01';
const DS_ID = '0f000000-0000-4000-8000-00000fda0001';
const SLUG = 'ztest-dfind-claims';
const BLOCK_SLUG = 'ztest-dfind-load';
const user: User = {
  id: USER_ID,
  email: 'dfind@test',
  name: 'Dee Finder',
  roles: ['employee'],
  tenantId: ORG,
};

// `ssn_col` is NOT flagged pii and `amt_col` is a number attribute fed a string → one finding of
// EACH rule, from ONE dataset. Two rules is the point: `findingRules` must be a set of both, and
// the frontend's index-keyed list exists because one column can raise both.
const COLS: DatasetColumn[] = [
  { name: 'clm_id', type: 'string' },
  { name: 'amt_col', type: 'number' },
  { name: 'ssn_col', type: 'string', pii: false },
];
const ROWS = [
  { clm_id: 'C1', amt_col: 'not-a-number', ssn_col: '111-22-3333' },
  { clm_id: 'C2', amt_col: 'also-not', ssn_col: '444-55-6666' },
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

async function postRun(body: unknown, idempotencyKey = crypto.randomUUID()) {
  const matched = router.match('POST', '/api/runs')!;
  const req = new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  const res = await withTenantDb(ORG, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Pin the governance snapshot, varying only the policy under test. */
function pinMode(mode: 'warn' | 'block') {
  __setSnapshotOverrideForTests({
    ...buildSnapshot([]),
    dataValidation: mode,
    piiScrubbing: false,
  });
}

/** Every `data`-category audit row this actor has written so far. Deliberately UNORDERED — the
 *  callers below identify their row by IDENTITY, never by position. See `postRunCapturingAudit`. */
async function dataAuditRows() {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, USER_ID), eq(auditLog.category, 'data')));
}

/**
 * Post a run and hand back the ONE `data` audit row THAT run wrote, found by id-difference
 * against a snapshot taken immediately before the call.
 *
 * ⛔ THE DEFECT THIS REPLACES — a CI-only flake that reddened innocent PRs (#238 failed on two
 * assertions in a file it does not touch). This helper used to be:
 *
 *     const rows = await db.select().from(auditLog).where(actor = USER_ID and category = 'data');
 *     return rows.at(-1);                       // "the row this run just wrote"
 *
 * `at(-1)` is not "the newest row" — it is "whatever row Postgres happened to hand back last",
 * and a SELECT with no ORDER BY promises NOTHING about that. In practice the planner picks
 * `Index Scan using audit_log_actor_id_idx`, and a btree returns duplicate keys in ctid order,
 * so the rows come back in PHYSICAL HEAP ORDER — i.e. in the order the pages happened to be
 * filled, which is not the order the rows were inserted. Two things decide that placement and
 * neither is under this file's control:
 *   • `withTenantDb` reserves a connection per request, so consecutive runs in this file write
 *     their audit rows over DIFFERENT pooled backends, each of which appends to its OWN cached
 *     target page (`rd_targblock`);
 *   • `audit_log` is shared, append-only platform state that all ~155 test files write and their
 *     cleanups delete, so the Free Space Map is constantly offering reclaimed LOW-numbered pages.
 * The moment a later row lands on a lower page than an earlier one, `at(-1)` silently returns a
 * STALE row — the `warn` row from three tests ago instead of this run's `run.blocked`, or a
 * `findings: 2` row instead of this run's `findings: 3`. Both of the CI failures were that, and
 * neither had anything to do with the branch under test: the response body was correct in both.
 * It is load-dependent because it is a placement lottery, which is why it hid: green on three
 * consecutive idle-laptop suite runs, 13 of 20 red once another process was writing and
 * VACUUMing `audit_log` concurrently.
 *
 * Ordering the query would paper over it; asking "which row did not exist a moment ago" removes
 * the question. Do NOT reintroduce a positional read here.
 */
async function postRunCapturingAudit(body: unknown) {
  const before = new Set((await dataAuditRows()).map((r) => r.id));
  const res = await postRun(body);
  const fresh = (await dataAuditRows()).filter((r) => !before.has(r.id));
  // The loud guard. If a future change makes this run write zero or several `data` rows, that is
  // what the failure says — rather than a baffling mismatch on a field of the wrong row.
  if (fresh.length !== 1) {
    throw new Error(
      `expected this run to write exactly ONE data audit row, saw ${fresh.length}` +
        (fresh.length ? ` (${fresh.map((r) => r.action).join(', ')})` : '') +
        ' — the audit assertions below are about to read a row this run did not write',
    );
  }
  return { ...res, audit: fresh[0]! };
}

let flowId = '';
let entityId = '';

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
  // `upsertMapping` writes GLOBAL-scope rows (tenant_id NULL) — delete by dataset, not by tenant.
  await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, DS_ID));
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, DS_ID));
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

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: ORG, name: 'Findings Org', slug: 'zfindings-org', industry: 'insurance' });
  await db.insert(users).values({ id: USER_ID, email: user.email, name: user.name, tenant_id: ORG });
  await db.insert(datasets).values({
    id: DS_ID,
    owner_id: USER_ID,
    tenant_id: ORG,
    name: 'Findings Claims',
    slug: SLUG,
    source_type: 'json',
    row_count: ROWS.length,
    columns: COLS,
  });
  await db
    .insert(datasetRows)
    .values(ROWS.map((data, idx) => ({ dataset_id: DS_ID, idx, data })));

  const entity = await createTenantEntity(ORG, {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'FindClaim',
    label: 'Find Claim',
    attributes: [
      { name: 'claimId', type: 'string' },
      { name: 'amount', type: 'number' },
      { name: 'ssn', type: 'string', pii: true },
    ],
  });
  entityId = entity.id;
  const mapping = await upsertMapping({
    datasetId: DS_ID,
    entityId: entity.id,
    industry: 'insurance',
    department: 'Claims',
    columnMap: { clm_id: 'claimId', amt_col: 'amount', ssn_col: 'ssn' },
    confidence: 1,
    source: 'human',
    confirmed: true,
    // tenantId: null = the GLOBAL scope this fixture has always written in (mapping writes became
    // tenant-scoped; readers still resolve "mine OR global", so behaviour here is unchanged).
    tenantId: null,
  });
  await db.insert(ontologyEntitySamples).values({
    entity_id: entity.id,
    dataset_id: DS_ID,
    mapping_id: mapping.id,
    is_primary: true,
    tenant_id: ORG,
  });

  const [block] = await db
    .insert(buildingBlocks)
    .values({ slug: BLOCK_SLUG, name: 'load for findings', category: 'data' })
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
  const graph: FlowGraph = {
    nodes: [
      {
        id: 'n1',
        blockId: block!.id,
        blockVersionId: version!.id,
        slug: 'load',
        label: 'load',
        category: 'data',
        config: { source: SLUG },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
  const [flow] = await db
    .insert(flows)
    .values({ name: 'findings-flow', owner_id: USER_ID, graph, tenant_id: ORG })
    .returning();
  flowId = flow!.id;
  asUser(user);
}, 60_000);

/** A warn-mode run REALLY spawns a subprocess. Wait it out, or the next case 409s `sandbox_busy`
 *  and the teardown races a live pump still writing flow_run_events. */
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

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks. `settle()` polls a real run to completion, so this one has a
// genuine ceiling to state.
afterEach(async () => {
  await settle();
  asUser(user); // keep auth installed across cases
}, 30_000);

afterAll(async () => {
  __setSnapshotOverrideForTests(undefined);
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 60_000);

// ---------------------------------------------------------------- warn (the shipped default)

test('warn mode: the 201 body carries the findings the run proceeded despite', async () => {
  pinMode('warn');
  const { status, json } = await postRun({ flowId });
  expect(status).toBe(201);
  // The run PROCEEDED — that is the state the warning has to survive, not a substitute for it.
  expect(json.status).toBe('running');
  expect(json.runId).toBeString();

  // ⛔ RED BEFORE THE FIX: `dataValidation` was absent entirely, so the browser had nothing to
  // read and the body was indistinguishable from a clean run.
  expect(json.dataValidation).toBeDefined();
  expect(json.dataValidation.mode).toBe('warn');
  const findings = json.dataValidation.findings as Record<string, unknown>[];
  expect(findings.length).toBe(2);

  const pii = findings.find((f) => f.rule === 'pii_uncovered')!;
  expect(pii).toBeDefined();
  // All four addressing fields, because a sentence without them names no column.
  expect(pii.dataset).toBe(SLUG);
  expect(pii.column).toBe('ssn_col');
  expect(pii.attribute).toBe('ssn');
  expect(pii.message).toContain('unredacted');
});

test('warn mode: the audit row NAMES the rules and the refs, not just a count', async () => {
  pinMode('warn');
  const { status, audit: row } = await postRunCapturingAudit({ flowId });
  // The mode ACTUALLY TOOK — assert it before asserting the branch it selects, so a snapshot that
  // failed to pin fails as "the run was not in warn mode" instead of as a confusing action mismatch.
  expect(status, 'warn mode did not take — the run was refused, not warned').toBe(201);
  expect(row.action).toBe('data.validation_warn');
  const meta = row.metadata as Record<string, unknown>;
  // The count stays — it is the TRUE total and `findingRefs` may be capped.
  expect(meta.findings).toBe(2);
  // ⛔ RED BEFORE THE FIX: `findings: 2` was the entire story.
  expect([...(meta.findingRules as string[])].sort()).toEqual(['pii_uncovered', 'type_mismatch']);
  expect(meta.findingRefs).toContain(`${SLUG}.ssn_col→ssn`);
  expect(meta.findingRefs).toContain(`${SLUG}.amt_col→amount`);
});

test('a clean run body is UNCHANGED — `dataValidation` is absent, not empty', async () => {
  // The conditional spread is the contract: the client checks `!!body.dataValidation`, so the
  // happy path must not start shipping a key that is always there.
  pinMode('warn');
  await db.update(datasets).set({ columns: COLS.map((c) => (c.name === 'ssn_col' ? { ...c, pii: true } : c)) }).where(eq(datasets.id, DS_ID));
  await db.update(datasetRows).set({ data: { clm_id: 'C1', amt_col: 10, ssn_col: '111' } }).where(eq(datasetRows.dataset_id, DS_ID));
  try {
    const { status, json } = await postRun({ flowId });
    expect(status).toBe(201);
    expect('dataValidation' in json).toBe(false);
  } finally {
    await db.update(datasets).set({ columns: COLS }).where(eq(datasets.id, DS_ID));
    await db.delete(datasetRows).where(eq(datasetRows.dataset_id, DS_ID));
    await db.insert(datasetRows).values(ROWS.map((data, idx) => ({ dataset_id: DS_ID, idx, data })));
  }
});

// ---------------------------------------------------------------- block

test('block mode: the 422 carries count + expected on the type_mismatch', async () => {
  pinMode('block');
  const { status, json } = await postRun({ flowId });
  expect(status).toBe(422);
  expect(json.error).toBe('data_validation_failed');
  const findings = (json.details.findings ?? json.findings) as Record<string, unknown>[];
  const tm = findings.find((f) => f.rule === 'type_mismatch')!;
  expect(tm).toBeDefined();
  // ⛔ RED BEFORE THE FIX: only `message` had these, baked into an English sentence a Dutch UI
  // cannot reuse.
  expect(tm.count).toBe(2);
  expect(tm.expected).toBeString();
  expect(tm.column).toBe('amt_col');
  expect(tm.attribute).toBe('amount');
  // `message` is unchanged and still says the same thing — old frontends keep working.
  expect(tm.message).toContain("Column 'amt_col' has 2 value(s)");
  // `pii_uncovered` carries NEITHER field — they are optional for a reason.
  const pii = findings.find((f) => f.rule === 'pii_uncovered')!;
  expect(pii.count).toBeUndefined();
  expect(pii.expected).toBeUndefined();
});

test('block mode: the audit row names the rules too', async () => {
  pinMode('block');
  const { status, audit: row } = await postRunCapturingAudit({ flowId });
  // The mode ACTUALLY TOOK. Without this, a snapshot override that silently failed to pin would
  // show up as `Expected "run.blocked" / Received "data.validation_warn"` — which reads like the
  // controller took the wrong branch, and sent the last investigation down exactly that path.
  expect(status, 'block mode did not take — the run was warned, not refused').toBe(422);
  expect(row.action).toBe('run.blocked');
  const meta = row.metadata as Record<string, unknown>;
  expect(meta.findings).toBe(2);
  expect([...(meta.findingRules as string[])].sort()).toEqual(['pii_uncovered', 'type_mismatch']);
  expect((meta.findingRefs as string[]).length).toBe(2);
});

// ---------------------------------------------------------------- the audit ref budget

test('findingRefs is DEDUPED before the cap — one column raising both rules is one address', async () => {
  // ⛔ THE DEFECT. `findingRules` was deduped and `findingRefs` was not, so ONE column raising
  // BOTH rules — a PII attribute on an unflagged column whose values also mistype, which
  // build/+page.svelte's own index-key comment calls "the very first realistic case" — emitted the
  // identical `dataset.column→attribute` twice. `findingRefs` is an ADDRESS list, not a finding
  // list (the count above carries multiplicity), so slicing before deduping spent two of the 20
  // budgeted slots on one address: the auditor's window could hold as few as 10 distinct addresses,
  // on exactly the runs that have the most to say.
  //
  // The fixture makes `amt_col` raise both: it is already a string fed to the `amount` NUMBER
  // attribute (type_mismatch); flagging that attribute PII while the column is not flagged adds
  // pii_uncovered on the SAME column. `ssn_col` keeps raising its own single finding, so the run
  // produces 3 findings at 2 distinct addresses — the exact shape the bug hid in.
  pinMode('warn');
  await db
    .update(ontologyAttributes)
    .set({ pii: true })
    .where(and(eq(ontologyAttributes.entity_id, entityId), eq(ontologyAttributes.name, 'amount')));
  try {
    const { status, json, audit: row } = await postRunCapturingAudit({ flowId });
    expect(status).toBe(201);
    const findings = json.dataValidation.findings as Record<string, unknown>[];
    // Three findings — the body is NOT deduped, and must not be: each is a distinct violation with
    // its own sentence, and the browser renders all of them.
    expect(findings.length).toBe(3);
    expect(findings.filter((f) => f.column === 'amt_col').length).toBe(2);

    const meta = row.metadata as Record<string, unknown>;
    const refs = meta.findingRefs as string[];
    // The true total still says 3 — a deduped ref list must never be mistaken for the count. The
    // body above already proved the run SAW 3; this reads the row that same run wrote, so a
    // mismatch here is a claim about the audit metadata and nothing else.
    expect(meta.findings).toBe(3);
    // ⛔ RED BEFORE THE FIX: `[…amt_col→amount, …amt_col→amount, …ssn_col→ssn]`, length 3.
    expect(refs.length, 'the same address was budgeted twice').toBe(2);
    expect([...refs].sort()).toEqual([`${SLUG}.amt_col→amount`, `${SLUG}.ssn_col→ssn`]);
    expect(new Set(refs).size).toBe(refs.length);
  } finally {
    await db
      .update(ontologyAttributes)
      .set({ pii: false })
      .where(and(eq(ontologyAttributes.entity_id, entityId), eq(ontologyAttributes.name, 'amount')));
  }
});

// ---------------------------------------------------------------- the idempotent replay

test('the IDEMPOTENT REPLAY carries the findings too — a retry must not drop the alert', async () => {
  // ⛔ THE UNENFORCED CONTRACT. The `claimed.reused` branch spreads `...dataValidationBody` and
  // argues at length in a comment that "an idempotent replay is the SAME run against the SAME data,
  // so it carries the same warning". Nothing tested it: deleting the spread left every case green.
  //
  // It is not a hypothetical. A retry is the ORDINARY consequence of a flaky network — the browser
  // never sees the first response, sends the same Idempotency-Key, and gets the replay. If the
  // replay drops `dataValidation`, that request path silently loses the only notice that PII is
  // going into the sandbox unredacted, on exactly the runs where the client already lost one
  // response. The failure mode is a warning that appears or not depending on packet loss.
  pinMode('warn');
  const key = crypto.randomUUID();
  const first = await postRun({ flowId }, key);
  expect(first.status).toBe(201);
  expect(first.json.dataValidation).toBeDefined();

  const replay = await postRun({ flowId }, key);
  // Same run, not a second one — otherwise this proves nothing about the replay branch.
  expect(replay.json.idempotent).toBe(true);
  expect(replay.json.runId).toBe(first.json.runId);

  // ⛔ RED WITHOUT THE SPREAD: `undefined`.
  expect(
    replay.json.dataValidation,
    'the retried request lost the warning the first response carried',
  ).toBeDefined();
  expect(replay.json.dataValidation.mode).toBe('warn');
  // Byte-for-byte the same report, not a degraded summary of it.
  expect(replay.json.dataValidation).toEqual(first.json.dataValidation);
});
