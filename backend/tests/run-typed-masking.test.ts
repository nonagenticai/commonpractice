// tests/run-typed-masking.test.ts — a member's RUN reads masked data of the SAME TYPE (W8, 2026-10-15).
//
// The defect (live walk, /build "Test with this challenge's sample data" as a member): the run
// masking blanked every masked cell to the string "[redacted]", so a typed step declaring
// `amount: number` failed with "'amount' must be a finite number" — on ANY numeric column a member
// may not see, which by the member-view rule includes every UNMAPPED column. These tests drive the
// REAL router, a REAL runner subprocess and a block with TYPED outputs: the run must finish `ok`,
// the numbers must be numbers that are not the originals, and personal values found inside a
// visible text column must never reach the run output or the LLM provider.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerRunRoutes } from '../src/host/run-controller';
import { buildSnapshot, __setSnapshotOverrideForTests } from '../src/host/policy-store';
import { __setBrokerDepsForTests, mockProvider } from '../src/host/llm-broker';
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
const ORG = '00000000-0000-0000-0000-00000b710001';
const MEMBER_ID = '00000000-0000-0000-0000-00000b710011';
const DEV_ID = '00000000-0000-0000-0000-00000b710012';
const CREATOR_ID = '00000000-0000-0000-0000-00000b710013';
const DS_ID = '00000000-0000-0000-0000-00000b710021';
const ENTITY_ID = '00000000-0000-0000-0000-00000b710031';
const CH_ID = '00000000-0000-0000-0000-00000b710041';
const SLUG = 'w8-typed-mask-claims';
const BLOCK_SLUG = 'zw8-typed-mask';

const member: User = { id: MEMBER_ID, email: 'w8tm-m@test', name: 'W8 TM Member', roles: ['member'], tenantId: ORG };
const dev: User = { id: DEV_ID, email: 'w8tm-d@test', name: 'W8 TM Dev', roles: ['developer'], tenantId: ORG };

// `amount` (number) and `filed_date` (date) are UNMAPPED → masked for a member. `premium` is
// PII-flagged and numeric → masked. `remark` is mapped to a non-PII attribute → visible, but holds
// a BSN, an e-mail and a phone number inside its text → value-scrubbed.
const AMOUNTS = [2500, 13750];
const PREMIUMS = [41.25, 9.5];
const DATES = ['2026-01-15', '2026-02-20'];
const BSN = '111222333';
const EMAIL = 'eva.typedsecret@claims.example';
const PHONE = '06-12345678';
const REMARKS = [`Klant BSN ${BSN}, mail ${EMAIL}`, `Bel ${PHONE} na 17u`];

const DESCRIPTOR: BlockDescriptor = {
  inputs: { source: { type: 'dataset', required: true } },
  // TYPED outputs: the runner validates them — "[redacted]" in `amount` fails the step.
  outputs: {
    amount: { type: 'number' },
    premium: { type: 'number' },
    filed: { type: 'string' },
    rows: { type: 'json' },
    remarks: { type: 'string' },
  },
  capabilities: { network: false, dataset: true },
};
const SOURCE = `export default {
  descriptor: ${JSON.stringify(DESCRIPTOR)},
  async run(inputs, ctx) {
    const rows = await ctx.dataset(inputs.source);
    return {
      amount: rows[0].amount,
      premium: rows[0].premium,
      filed: rows[0].filed_date,
      rows,
      remarks: rows.map((r) => r.remark).join(' | '),
    };
  },
};
`;

const router = new Router();
registerRunRoutes(router);

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

async function postRun(body: unknown) {
  const matched = router.match('POST', '/api/runs')!;
  const req = new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const res = await withTenantDb(ORG, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let blockId = '';
let versionId = '';

async function cleanup() {
  const runIds = (await db.select({ id: flowRuns.id }).from(flowRuns).where(eq(flowRuns.tenant_id, ORG))).map((r) => r.id);
  if (runIds.length) {
    await db.delete(flowRunEvents).where(inArray(flowRunEvents.run_id, runIds));
    await db.delete(flowRuns).where(inArray(flowRuns.id, runIds));
  }
  await db.delete(auditLog).where(inArray(auditLog.actor_id, [MEMBER_ID, DEV_ID]));
  await db.delete(sandboxes).where(eq(sandboxes.tenant_id, ORG));
  await db.delete(flows).where(eq(flows.tenant_id, ORG));
  await db.delete(challengeDatasets).where(eq(challengeDatasets.challenge_id, CH_ID));
  await db.delete(challenges).where(eq(challenges.id, CH_ID));
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
  await db.execute(sql`DELETE FROM usage_counters WHERE user_id IN (${MEMBER_ID}, ${DEV_ID})`);
  await db.delete(users).where(inArray(users.id, [MEMBER_ID, DEV_ID, CREATOR_ID]));
  await db.delete(tenants).where(eq(tenants.id, ORG));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: ORG, name: 'W8 Typed Mask Org', slug: 'w8-typed-mask-org' });
  await db.insert(users).values([
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: ORG },
    { id: DEV_ID, email: dev.email, name: dev.name, tenant_id: ORG, tenant_role: 'developer' },
    { id: CREATOR_ID, email: 'w8tm-c@test', name: 'W8 TM Creator', tenant_id: ORG },
  ]);
  await db.insert(datasets).values({
    id: DS_ID, owner_id: CREATOR_ID, tenant_id: ORG, name: 'Typed Claims', slug: SLUG, source_type: 'json', row_count: 2,
    columns: [
      { name: 'amount', type: 'number' },
      { name: 'premium', type: 'number', pii: true },
      { name: 'filed_date', type: 'date' },
      { name: 'remark', type: 'string' },
    ],
  });
  await db.insert(datasetRows).values(
    [0, 1].map((i) => ({
      dataset_id: DS_ID, idx: i,
      data: { amount: AMOUNTS[i], premium: PREMIUMS[i], filed_date: DATES[i], remark: REMARKS[i] },
    })),
  );
  await db.insert(ontologyEntities).values({ id: ENTITY_ID, scope: 'generic', department: 'W8TMDept', name: 'W8TMClaim', label: 'Claim', tenant_id: ORG });
  await db.insert(ontologyAttributes).values([{ entity_id: ENTITY_ID, name: 'remark', type: 'string' }]);
  await db.insert(datasetMappings).values({
    dataset_id: DS_ID, entity_id: ENTITY_ID, industry: '', department: 'W8TMDept',
    column_map: { remark: 'remark' }, confirmed: true, tenant_id: ORG,
  });
  await db.insert(challenges).values({ id: CH_ID, tenant_id: ORG, title: 'W8 typed', description: 'x', work_area: 'Claims', submitter_id: CREATOR_ID, status: 'voting', week: '2026-W42' });
  await db.insert(challengeDatasets).values({ challenge_id: CH_ID, dataset_slug: SLUG, added_by: CREATOR_ID });
  const [block] = await db.insert(buildingBlocks).values({ slug: BLOCK_SLUG, name: 'typed mask', category: 'data' }).returning();
  const [version] = await db
    .insert(blockVersions)
    .values({ block_id: block!.id, version: '1.0.0', status: 'stable', published_at: new Date(), source_ts: requireScannedSource(SOURCE), descriptor: DESCRIPTOR as never })
    .returning();
  blockId = block!.id;
  versionId = version!.id;
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
  __setSnapshotOverrideForTests({ ...buildSnapshot([]), piiScrubbing: false, dataValidation: 'warn' });
}, 30_000);

afterAll(async () => {
  __setSnapshotOverrideForTests(undefined);
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 60_000);

async function flowFor(owner: string, config: Record<string, unknown>, block = blockId, version = versionId): Promise<string> {
  const graph: FlowGraph = {
    nodes: [{ id: 'n1', blockId: block, blockVersionId: version, slug: 'typed', label: 'Typed', category: 'data', config, position: { x: 0, y: 0 } }],
    edges: [],
  };
  const [f] = await db.insert(flows).values({ name: `tm ${crypto.randomUUID().slice(0, 6)}`, owner_id: owner, graph, tenant_id: ORG }).returning();
  return f!.id;
}

interface Finished {
  status: string;
  events: Array<Record<string, unknown>>;
  all: string;
  outputs: Record<string, unknown> | null;
}

async function finished(runId: string): Promise<Finished> {
  await settle();
  const [run] = await db.select({ status: flowRuns.status }).from(flowRuns).where(eq(flowRuns.id, runId));
  const events = (await db.select({ event: flowRunEvents.event }).from(flowRunEvents).where(eq(flowRunEvents.run_id, runId))).map(
    (r) => r.event as Record<string, unknown>,
  );
  const ok = events.find((e) => e.type === 'node_success');
  let outputs: Record<string, unknown> | null = null;
  if (ok && typeof ok.outputPreview === 'string') {
    try {
      outputs = JSON.parse(ok.outputPreview);
    } catch {
      outputs = null;
    }
  }
  return { status: run!.status, events, all: JSON.stringify(events), outputs };
}

/** No original value anywhere. Numbers are checked against the step's OUTPUT only — the event log
 *  carries timestamps and durations whose digits could contain "2500" by coincidence. */
function assertNoOriginals(all: string, numbersIn: string) {
  for (const a of AMOUNTS) expect(numbersIn).not.toContain(String(a));
  for (const p of PREMIUMS) expect(numbersIn).not.toContain(String(p));
  for (const d of DATES) expect(all).not.toContain(d);
  expect(all).not.toContain(BSN);
  expect(all).not.toContain('typedsecret');
  expect(all).not.toContain(PHONE);
}

test('a member\'s SAMPLE TEST on unmapped number + date columns finishes ok — typed, and not the originals', async () => {
  asUser(member);
  const r = await postRun({ flowId: await flowFor(MEMBER_ID, {}), sampleChallengeId: CH_ID });
  expect(r.status).toBe(201);
  const run = await finished(r.json.runId);
  // The defect: the step failed "'amount' must be a finite number" and the run was `failed`.
  expect(run.all).not.toContain('finite number');
  expect(run.status).toBe('ok');
  const out = run.outputs!;
  expect(out).not.toBeNull();
  expect(typeof out.amount).toBe('number');
  expect(Number.isInteger(out.amount)).toBe(true);
  expect(String(out.amount)).toHaveLength(String(AMOUNTS[0]).length); // similar magnitude
  expect(out.amount).not.toBe(AMOUNTS[0]);
  expect(typeof out.premium).toBe('number');
  expect(out.premium).not.toBe(PREMIUMS[0]);
  expect(typeof out.filed).toBe('string');
  expect(out.filed as string).toMatch(/^\d{4}-\d{2}-\d{2}$/); // same format
  expect(out.filed).not.toBe(DATES[0]);
  // Ordering within the column is kept (one offset per column).
  const rows = out.rows as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(2);
  expect((rows[0]!.filed_date as string) < (rows[1]!.filed_date as string)).toBe(true);
  // The visible text column keeps its words; only the personal spans are replaced, typed.
  expect(out.remarks as string).toContain('Klant BSN 000000000, mail email@example.invalid');
  expect(out.remarks as string).toContain('Bel +31 6 00000000 na 17u');
  assertNoOriginals(run.all, JSON.stringify(run.outputs));
});

test('the masked values are stable: the same member run twice reads the same synthetic numbers', async () => {
  asUser(member);
  const a = await finished((await postRun({ flowId: await flowFor(MEMBER_ID, { source: SLUG }) })).json.runId);
  const b = await finished((await postRun({ flowId: await flowFor(MEMBER_ID, { source: SLUG }) })).json.runId);
  expect(a.status).toBe('ok');
  expect(a.outputs!.amount).toBe(b.outputs!.amount);
  expect(a.outputs!.filed).toBe(b.outputs!.filed);
});

test('with data.pii_scrubbing ON, a member\'s run on a PII-flagged NUMBER column still finishes ok (no "[redacted]" string)', async () => {
  __setSnapshotOverrideForTests({ ...buildSnapshot([]), piiScrubbing: true, dataValidation: 'warn' });
  asUser(member);
  const r = await postRun({ flowId: await flowFor(MEMBER_ID, { source: SLUG }) });
  expect(r.status).toBe(201);
  const run = await finished(r.json.runId);
  expect(run.all).not.toContain('[redacted]');
  expect(run.status).toBe('ok');
  expect(typeof run.outputs!.premium).toBe('number');
  assertNoOriginals(run.all, JSON.stringify(run.outputs));
});

test('a data manager\'s run is unchanged — raw values', async () => {
  asUser(dev);
  const r = await postRun({ flowId: await flowFor(DEV_ID, { source: SLUG }) });
  expect(r.status).toBe(201);
  const run = await finished(r.json.runId);
  expect(run.status).toBe('ok');
  expect(run.outputs!.amount).toBe(AMOUNTS[0]);
  expect(run.outputs!.premium).toBe(PREMIUMS[0]);
  expect(run.outputs!.filed).toBe(DATES[0]);
  expect(run.all).toContain(BSN);
  expect(run.all).toContain(EMAIL);
  expect(run.all).toContain(PHONE);
});

test('the LLM provider receives no BSN, e-mail, phone or original number from a member\'s run', async () => {
  const llmDescriptor: BlockDescriptor = {
    inputs: { source: { type: 'dataset', required: true } },
    outputs: { summary: { type: 'string' } },
    capabilities: { network: false, dataset: true, llm: true },
  };
  const llmSource = `export default {
  descriptor: ${JSON.stringify(llmDescriptor)},
  async run(inputs, ctx) {
    const rows = await ctx.dataset(inputs.source);
    const r = await ctx.llm({ prompt: "Summarise: " + JSON.stringify(rows) });
    return { summary: r.text };
  },
};
`;
  const [b] = await db.insert(buildingBlocks).values({ slug: `${BLOCK_SLUG}-llm`, name: 'typed llm', category: 'ai' }).returning();
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
    const r = await postRun({ flowId: await flowFor(MEMBER_ID, { source: SLUG }, b!.id, v!.id) });
    expect(r.status).toBe(201);
    await settle();
    expect(prompts).toHaveLength(1); // positive control: the provider was called with the rows
    expect(prompts[0]).toContain('Klant BSN 000000000');
    assertNoOriginals(prompts[0]!, prompts[0]!);
  } finally {
    __setBrokerDepsForTests(undefined);
  }
});
