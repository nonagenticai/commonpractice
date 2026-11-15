// tests/challenge-sample-test.test.ts — W8/P4 "Test with this challenge's sample data" in /build.
//
// `POST /api/runs { flowId, sampleChallengeId }` binds the challenge's linked sample data into the
// flow's first dataset input for THIS run (the stored flow is not written), and — for a reader who
// is not a data manager — injects it MASKED with the same rule as the sample-data preview.
//
// Driven through the REAL router against real Postgres with a REAL runner subprocess, like
// run-data-findings.test.ts: the masking claim is about what the run's RESULTS echo back, so the
// assertion reads the persisted `flow_run_events`, not a helper's return value.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerRunRoutes } from '../src/host/run-controller';
import { buildSnapshot, __setSnapshotOverrideForTests } from '../src/host/policy-store';
import { __setBrokerDepsForTests, mockProvider } from '../src/host/llm-broker';
import { pickSampleBinding } from '../src/challenges/sample-test';
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
  buildingBlocks,
  blockVersions,
  sandboxes,
  auditLog,
  challenges,
  challengeDatasets,
  withTenantDb,
} from '../src/db/client';
import type { BlockDescriptor } from '../src/db/block-types';
import type { FlowGraph } from '../src/db/flow-types';
import type { User } from '../src/types';
import { requireScannedSource } from '../src/blocks/source-gate';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts).
const ORG = '00000000-0000-0000-0000-00000a8d0001';
const ORG_OTHER = '00000000-0000-0000-0000-00000a8d0002';
const MEMBER_ID = '00000000-0000-0000-0000-00000a8d0011';
const DEV_ID = '00000000-0000-0000-0000-00000a8d0012';
const CREATOR_ID = '00000000-0000-0000-0000-00000a8d0013';
const OTHER_ID = '00000000-0000-0000-0000-00000a8d0014';
const DS_ID = '00000000-0000-0000-0000-00000a8d0021';
const ENTITY_ID = '00000000-0000-0000-0000-00000a8d0031';
const CH_ID = '00000000-0000-0000-0000-00000a8d0041';
const CH_EMPTY = '00000000-0000-0000-0000-00000a8d0042';
const CH_FOREIGN = '00000000-0000-0000-0000-00000a8d0043';
const SLUG = 'w8-sample-test-claims';
const BLOCK_SLUG = 'zw8-sample-echo';

const member: User = { id: MEMBER_ID, email: 'w8p4-m@test', name: 'W8 Member', roles: ['member'], tenantId: ORG };
const dev: User = { id: DEV_ID, email: 'w8p4-d@test', name: 'W8 Dev', roles: ['developer'], tenantId: ORG };

// `amt` is mapped (confirmed) to a non-PII attribute → a member may see it.
// `email` is flagged PII → masked. `notes` is unmapped → masked for a member (member-view rule).
const AMOUNT = '777123';
const EMAIL = 'eva.p4secret@x.invalid';
const NOTES = 'Lives at Dorpsweg 12';

const DESCRIPTOR: BlockDescriptor = {
  inputs: { source: { type: 'dataset', required: true } },
  outputs: { joined: { type: 'string' } },
  capabilities: { network: false, dataset: true },
};
// Echoes every value it received, so the run's own output is what the masking claim is about.
const SOURCE = `export default {
  descriptor: ${JSON.stringify(DESCRIPTOR)},
  async run(inputs, ctx) {
    const rows = await ctx.dataset(inputs.source);
    return { joined: rows.map((r) => [r.amt, r.email, r.notes].join('|')).join(';') };
  },
};
`;

const router = new Router();
registerRunRoutes(router);

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

async function postRun(tenant: string, body: unknown) {
  const matched = router.match('POST', '/api/runs')!;
  const req = new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const res = await withTenantDb(tenant, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let versionId = '';
let blockId = '';
let memberFlow = '';
let devFlow = '';
let noInputFlow = '';

function graphWith(config: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: 'n1', blockId, blockVersionId: versionId, slug: 'echo', label: 'Echo claims', category: 'data', config, position: { x: 0, y: 0 } },
    ],
    edges: [],
  };
}

async function cleanup() {
  const runIds = (await db.select({ id: flowRuns.id }).from(flowRuns).where(eq(flowRuns.tenant_id, ORG))).map((r) => r.id);
  if (runIds.length) {
    await db.delete(flowRunEvents).where(inArray(flowRunEvents.run_id, runIds));
    await db.delete(flowRuns).where(inArray(flowRuns.id, runIds));
  }
  await db.delete(auditLog).where(inArray(auditLog.actor_id, [MEMBER_ID, DEV_ID]));
  await db.delete(sandboxes).where(eq(sandboxes.tenant_id, ORG));
  await db.delete(flows).where(eq(flows.tenant_id, ORG));
  await db.delete(challengeDatasets).where(inArray(challengeDatasets.challenge_id, [CH_ID, CH_EMPTY, CH_FOREIGN]));
  await db.delete(challenges).where(inArray(challenges.id, [CH_ID, CH_EMPTY, CH_FOREIGN]));
  await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, DS_ID));
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, DS_ID));
  await db.delete(datasets).where(eq(datasets.id, DS_ID));
  await db.delete(ontologyAttributes).where(eq(ontologyAttributes.entity_id, ENTITY_ID));
  await db.delete(ontologyEntities).where(eq(ontologyEntities.id, ENTITY_ID));
  const blocks = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(like(buildingBlocks.slug, `${BLOCK_SLUG}%`));
  if (blocks.length) {
    await db.delete(blockVersions).where(inArray(blockVersions.block_id, blocks.map((b) => b.id)));
    await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, blocks.map((b) => b.id)));
  }
  // The LLM-block run meters a call against the member (usage_counters → users is NO ACTION).
  await db.execute(sql`DELETE FROM usage_counters WHERE user_id IN (${MEMBER_ID}, ${DEV_ID})`);
  await db.delete(users).where(inArray(users.id, [MEMBER_ID, DEV_ID, CREATOR_ID, OTHER_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [ORG, ORG_OTHER]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: ORG, name: 'W8 Sample Org', slug: 'w8-sample-org' },
    { id: ORG_OTHER, name: 'W8 Sample Other', slug: 'w8-sample-other' },
  ]);
  await db.insert(users).values([
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: ORG },
    { id: DEV_ID, email: dev.email, name: dev.name, tenant_id: ORG, tenant_role: 'developer' },
    { id: CREATOR_ID, email: 'w8p4-c@test', name: 'W8 Creator', tenant_id: ORG },
    { id: OTHER_ID, email: 'w8p4-o@test', name: 'W8 Other', tenant_id: ORG_OTHER },
  ]);
  await db.insert(datasets).values({
    id: DS_ID, owner_id: CREATOR_ID, tenant_id: ORG, name: 'Sample Claims', slug: SLUG, source_type: 'json', row_count: 1,
    columns: [
      { name: 'amt', type: 'number' },
      { name: 'email', type: 'string', pii: true },
      { name: 'notes', type: 'string' },
    ],
  });
  await db.insert(datasetRows).values({ dataset_id: DS_ID, idx: 0, data: { amt: Number(AMOUNT), email: EMAIL, notes: NOTES } });
  await db.insert(ontologyEntities).values({ id: ENTITY_ID, scope: 'generic', department: 'W8SampleDept', name: 'W8SampleClaim', label: 'Claim', tenant_id: ORG });
  await db.insert(ontologyAttributes).values([
    { entity_id: ENTITY_ID, name: 'amount', type: 'number' },
    { entity_id: ENTITY_ID, name: 'email', type: 'string', pii: true },
  ]);
  await db.insert(datasetMappings).values({
    dataset_id: DS_ID, entity_id: ENTITY_ID, industry: '', department: 'W8SampleDept',
    column_map: { amt: 'amount', email: 'email' }, confirmed: true, tenant_id: ORG,
  });
  await db.insert(challenges).values([
    { id: CH_ID, tenant_id: ORG, title: 'W8 sample', description: 'x', work_area: 'Claims', submitter_id: CREATOR_ID, status: 'voting', week: '2026-W42' },
    { id: CH_EMPTY, tenant_id: ORG, title: 'W8 no data', description: 'x', work_area: 'Claims', submitter_id: CREATOR_ID, status: 'voting', week: '2026-W42' },
    { id: CH_FOREIGN, tenant_id: ORG_OTHER, title: 'W8 foreign', description: 'x', work_area: 'Claims', submitter_id: OTHER_ID, status: 'voting', week: '2026-W42' },
  ]);
  await db.insert(challengeDatasets).values({ challenge_id: CH_ID, dataset_slug: SLUG, added_by: CREATOR_ID });

  const [block] = await db.insert(buildingBlocks).values({ slug: BLOCK_SLUG, name: 'sample echo', category: 'data' }).returning();
  const [version] = await db
    .insert(blockVersions)
    .values({ block_id: block!.id, version: '1.0.0', status: 'stable', published_at: new Date(), source_ts: requireScannedSource(SOURCE), descriptor: DESCRIPTOR as never })
    .returning();
  blockId = block!.id;
  versionId = version!.id;
  // A summary block with NO dataset input — the "nowhere to put it" case.
  const [b2] = await db.insert(buildingBlocks).values({ slug: `${BLOCK_SLUG}-nodata`, name: 'no data', category: 'logic' }).returning();
  const noDataDescriptor: BlockDescriptor = { inputs: {}, outputs: { x: { type: 'string' } }, capabilities: { network: false } };
  const [v2] = await db
    .insert(blockVersions)
    .values({
      block_id: b2!.id, version: '1.0.0', status: 'stable', published_at: new Date(),
      source_ts: requireScannedSource(`export default { descriptor: ${JSON.stringify(noDataDescriptor)}, async run() { return { x: 'ok' }; } };\n`),
      descriptor: noDataDescriptor as never,
    })
    .returning();

  const [mf] = await db.insert(flows).values({ name: 'member flow', owner_id: MEMBER_ID, graph: graphWith({}), tenant_id: ORG }).returning();
  const [df] = await db.insert(flows).values({ name: 'dev flow', owner_id: DEV_ID, graph: graphWith({}), tenant_id: ORG }).returning();
  const [nf] = await db
    .insert(flows)
    .values({
      name: 'no input flow', owner_id: MEMBER_ID, tenant_id: ORG,
      graph: { nodes: [{ id: 'n1', blockId: b2!.id, blockVersionId: v2!.id, slug: 'nodata', label: 'x', category: 'logic', config: {}, position: { x: 0, y: 0 } }], edges: [] },
    })
    .returning();
  memberFlow = mf!.id;
  devFlow = df!.id;
  noInputFlow = nf!.id;
  // Governance scrubbing OFF, so the ONLY thing masking a member's run is the W8 rule.
  __setSnapshotOverrideForTests({ ...buildSnapshot([]), piiScrubbing: false, dataValidation: 'warn' });
}, 60_000);

async function settle() {
  for (let i = 0; i < 200; i++) {
    const live = await db.select({ id: flowRuns.id }).from(flowRuns).where(and(eq(flowRuns.tenant_id, ORG), eq(flowRuns.status, 'running')));
    if (!live.length) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('a run did not finish in time');
}

afterEach(async () => {
  await settle();
}, 30_000);

afterAll(async () => {
  __setSnapshotOverrideForTests(undefined);
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 60_000);

/** Everything the run wrote, as one string. */
async function runOutput(runId: string): Promise<string> {
  await settle();
  const rows = await db.select({ event: flowRunEvents.event }).from(flowRunEvents).where(eq(flowRunEvents.run_id, runId));
  return JSON.stringify(rows.map((r) => r.event));
}

test('P4: a member\'s sample test binds the challenge\'s data to the first dataset input — and the results come back masked', async () => {
  asUser(member);
  const r = await postRun(ORG, { flowId: memberFlow, sampleChallengeId: CH_ID });
  expect(r.status).toBe(201);
  expect(r.json.sampleTest).toEqual({ binding: { nodeId: 'n1', input: 'source', slug: SLUG, source: 'challenge' } });
  const out = await runOutput(r.json.runId);
  // Positive control: the run really read the challenge's data (the mapped, non-PII value).
  expect(out).toContain(AMOUNT);
  // …and nothing the member's preview hides: the PII column and the unmapped free text.
  expect(out).not.toContain(EMAIL);
  expect(out).not.toContain('p4secret');
  expect(out).not.toContain('Dorpsweg');
  // The stored flow is not written by the server — the binding lives on this run's copy.
  const [f] = await db.select({ graph: flows.graph }).from(flows).where(eq(flows.id, memberFlow));
  expect((f!.graph as FlowGraph).nodes[0]!.config).toEqual({});
});

test('P4: a data manager\'s sample test reads the same data unmasked (the masking is the reader\'s, not the data\'s)', async () => {
  asUser(dev);
  const r = await postRun(ORG, { flowId: devFlow, sampleChallengeId: CH_ID });
  expect(r.status).toBe(201);
  const out = await runOutput(r.json.runId);
  expect(out).toContain(AMOUNT);
  expect(out).toContain(NOTES);
});

test('P4: a challenge with no sample data linked answers sample_none_linked (no run)', async () => {
  asUser(member);
  const count = async () => (await db.select({ id: flowRuns.id }).from(flowRuns).where(eq(flowRuns.flow_id, memberFlow))).length;
  const before = await count();
  const r = await postRun(ORG, { flowId: memberFlow, sampleChallengeId: CH_EMPTY });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('sample_none_linked');
  expect(await count()).toBe(before);
});

test('P4: a flow with no step that reads data answers sample_no_data_input', async () => {
  asUser(member);
  const r = await postRun(ORG, { flowId: noInputFlow, sampleChallengeId: CH_ID });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('sample_no_data_input');
});

test('P4: another tenant\'s challenge is not found (404) — its data is never bound', async () => {
  asUser(member);
  const r = await postRun(ORG, { flowId: memberFlow, sampleChallengeId: CH_FOREIGN });
  expect(r.status).toBe(404);
});

test('P4: sampleChallengeId is refused on a solution run', async () => {
  asUser(member);
  const r = await postRun(ORG, { solutionId: crypto.randomUUID(), sampleChallengeId: CH_ID });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('validation');
});

// ---- ordinary runs (no sampleChallengeId) — the same masking (2026-10-15) ----
// The masking used to apply ONLY when `sampleChallengeId` was set. A member who wired the same
// dataset into the node by hand and pressed Test-run got every raw value back — and so did any
// ctx.llm() prompt a block built from the rows, i.e. the tenant's external LLM.

async function flowReading(owner: string, block: string, version: string): Promise<string> {
  const [f] = await db
    .insert(flows)
    .values({
      name: `ordinary ${owner.slice(-4)} ${block.slice(0, 6)}`, owner_id: owner, tenant_id: ORG,
      graph: {
        nodes: [{ id: 'n1', blockId: block, blockVersionId: version, slug: 'echo', label: 'Echo', category: 'data', config: { source: SLUG }, position: { x: 0, y: 0 } }],
        edges: [],
      },
    })
    .returning();
  return f!.id;
}

test('an ORDINARY run by a member (flow wired to the dataset by hand) reads it masked — pii_scrubbing OFF', async () => {
  asUser(member);
  const r = await postRun(ORG, { flowId: await flowReading(MEMBER_ID, blockId, versionId) });
  expect(r.status).toBe(201);
  expect(r.json.sampleTest).toBeUndefined();
  const out = await runOutput(r.json.runId);
  expect(out).toContain(AMOUNT); // positive control: the run read the data
  expect(out).not.toContain('p4secret'); // the PII-flagged column
  expect(out).not.toContain('Dorpsweg'); // the UNMAPPED free-text column (no column flag at all)
});

test('an ORDINARY run by a data manager is unchanged — raw values (scrubbing is off in this file)', async () => {
  asUser(dev);
  const r = await postRun(ORG, { flowId: await flowReading(DEV_ID, blockId, versionId) });
  expect(r.status).toBe(201);
  const out = await runOutput(r.json.runId);
  expect(out).toContain(AMOUNT);
  expect(out).toContain(NOTES);
  expect(out).toContain(EMAIL);
});

test('an LLM block in a member\'s ordinary run sends the provider masked values only', async () => {
  const llmDescriptor: BlockDescriptor = {
    inputs: { source: { type: 'dataset', required: true } },
    outputs: { summary: { type: 'string' } },
    capabilities: { network: false, dataset: true, llm: true },
  };
  const llmSource = `export default {
  descriptor: ${JSON.stringify(llmDescriptor)},
  async run(inputs, ctx) {
    const rows = await ctx.dataset(inputs.source);
    const r = await ctx.llm({ prompt: "Summarise these claims: " + JSON.stringify(rows) });
    return { summary: r.text };
  },
};
`;
  const [b] = await db.insert(buildingBlocks).values({ slug: `${BLOCK_SLUG}-llm`, name: 'sample llm', category: 'ai' }).returning();
  const [v] = await db
    .insert(blockVersions)
    .values({ block_id: b!.id, version: '1.0.0', status: 'stable', published_at: new Date(), source_ts: requireScannedSource(llmSource), descriptor: llmDescriptor as never })
    .returning();
  const prompts: string[] = [];
  __setBrokerDepsForTests({
    provider: async (req) => {
      prompts.push(req.prompt);
      return mockProvider(req);
    },
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  try {
    asUser(member);
    const r = await postRun(ORG, { flowId: await flowReading(MEMBER_ID, b!.id, v!.id) });
    expect(r.status).toBe(201);
    await settle();
    // Positive control: the provider WAS called, with the rows the block read.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(AMOUNT);
    expect(prompts[0]).not.toContain('p4secret');
    expect(prompts[0]).not.toContain('Dorpsweg');
  } finally {
    __setBrokerDepsForTests(undefined);
  }
});

// ---- the pure binding rule ----

const desc = new Map<string, BlockDescriptor>([
  ['v-ds', { inputs: { source: { type: 'dataset' } }, outputs: {}, capabilities: {} } as unknown as BlockDescriptor],
  ['v-def', { inputs: { source: { type: 'dataset', default: 'entity-sample' } }, outputs: {}, capabilities: {} } as unknown as BlockDescriptor],
]);
const node = (id: string, v: string, b: string, config: Record<string, unknown> = {}) =>
  ({ id, blockId: b, blockVersionId: v, slug: id, label: id, category: 'data', config, position: { x: 0, y: 0 } }) as FlowGraph['nodes'][number];

test('P4 binding: an input already reading a challenge dataset is kept as it is', () => {
  const g: FlowGraph = { nodes: [node('a', 'v-ds', 'b1', { source: 'other' }), node('b', 'v-ds', 'b1', { source: 'mine' })], edges: [] };
  expect(pickSampleBinding(g, desc, ['mine'], new Set())).toEqual({ kind: 'bound', binding: { nodeId: 'b', input: 'source', slug: 'mine', source: 'already' } });
});

test('P4 binding: an already-derived data block for linked information is used before binding a dataset', () => {
  const g: FlowGraph = { nodes: [node('a', 'v-ds', 'b1'), node('b', 'v-def', 'entity-block')], edges: [] };
  expect(pickSampleBinding(g, desc, ['mine'], new Set(['entity-block']))).toEqual({
    kind: 'bound', binding: { nodeId: 'b', input: 'source', slug: 'entity-sample', source: 'entity_block' },
  });
});

test('P4 binding: an input fed by an edge is not overwritten; nothing linked is reported', () => {
  const g: FlowGraph = {
    nodes: [node('a', 'v-ds', 'b1'), node('b', 'v-ds', 'b1')],
    edges: [{ id: 'e', source: 'a', sourceHandle: 'rows', target: 'a', targetHandle: 'source' }],
  };
  expect(pickSampleBinding(g, desc, ['mine'], new Set())).toEqual({ kind: 'bound', binding: { nodeId: 'b', input: 'source', slug: 'mine', source: 'challenge' } });
  expect(pickSampleBinding(g, desc, [], new Set())).toEqual({ kind: 'none_linked' });
  expect(pickSampleBinding({ nodes: [], edges: [] }, desc, ['mine'], new Set())).toEqual({ kind: 'no_data_input' });
});
