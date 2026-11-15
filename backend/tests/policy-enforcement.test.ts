// tests/policy-enforcement.test.ts — THE Session 6 headline: a policy edited in the
// `policies` table changes runtime behaviour with NO restart. These tests flip real
// policy rows (+ invalidate the ≤5s cache) and assert the broker, the idle-sweep
// watchdog, and the run-gate honour the live value. The broker's `limits` are NOT
// overridden — they come from the real policy store, so the seam is genuinely exercised.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { db, users, usageCounters, sandboxes, policies, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { PolicyValue } from '../src/db/schema';
import { brokerLlmCall, __setBrokerDepsForTests, type Provider } from '../src/host/llm-broker';
import { getSnapshot, buildSnapshot, invalidatePolicyCache } from '../src/host/policy-store';
import { getSandboxLimits, sweepIdleSandboxes } from '../src/host/sandbox-service';
import { enforceRunPolicies } from '../src/host/run-policy';
import type { FlowGraph } from '../src/db/flow-types';
import type { BlockDescriptor } from '../src/db/block-types';

// ⛔ Fixture ids must be UNIQUE PER TEST FILE. Every file runs against one database and each
// DELETEs then re-INSERTs its fixtures — so a shared id means one file rips a row out from under
// another's. (⚠️ CORRECTED 2026-08-16: this used to say "bun runs test files concurrently". It
// does not — see the canonical note at the top of tests/metering-platform-calls.test.ts. The
// sharing is sequential and just as destructive.) That is what the intermittent
// `usage_counters_user_id_fkey` / audit_log failures in the full suite were:
// this file previously shared its user/tenant ids with tests/runs.test.ts.
const USER_ID = '00000000-0000-0000-0000-0000000c2001';
const TEST_IDS = [USER_ID];

// Direct service calls bypass the request wrapper that sets the tenant_id GUC.
const meter = <T>(fn: () => Promise<T>) => withTenantDb(DEMO_TENANT_ID, fn);

// Snapshot of the seeded policy values we mutate, so afterAll can restore them.
const TOUCHED = [
  'spend.daily_llm_cap',
  'spend.weekly_spend_ceiling',
  'models.allowlist',
  'spend.auto_suspend_idle',
] as const;
const DEFAULTS: Record<string, PolicyValue> = {
  'spend.daily_llm_cap': 50,
  'spend.weekly_spend_ceiling': 15,
  'models.allowlist': ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  'spend.auto_suspend_idle': '7 days',
};

const TEST_MODEL = 'claude-opus-4-7';
const ALLOWLIST_WITH_TEST_MODEL: PolicyValue = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

/** Collapse a broker result to a single comparable outcome string.
 *
 *  `expect(res.ok).toBe(true)` reports only `Expected: true / Received: false` — it throws away
 *  the ONE thing that says why, and the rejection kind (`model_not_allowed` vs `llm_capped`) is
 *  precisely what distinguishes a real regression from a missing precondition. Asserting the
 *  outcome instead makes a failure self-describing on first read. */
const outcomeOf = (res: { ok: true } | { ok: false; kind: string }): string =>
  res.ok ? 'ok' : res.kind;

function fakeProvider(): { provider: Provider; calls: () => number } {
  let calls = 0;
  return {
    provider: async (req) => {
      calls++;
      return { text: `echo:${req.prompt}`, tokensIn: 10, tokensOut: 5 };
    },
    calls: () => calls,
  };
}

async function setPolicy(key: string, value: PolicyValue): Promise<void> {
  await db
    .insert(policies)
    .values({ key, category: 'test', label: key, control: 'number', value })
    .onConflictDoUpdate({ target: policies.key, set: { value } });
  invalidatePolicyCache();
}

async function cleanup() {
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, TEST_IDS));
  await db.delete(sandboxes).where(inArray(sandboxes.owner_id, TEST_IDS));
  await db.delete(users).where(inArray(users.id, TEST_IDS));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  await db
    .insert(users)
    .values({ id: USER_ID, email: 'policy@test', name: 'Policy' })
    .onConflictDoNothing({ target: users.id });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  for (const key of TOUCHED) await setPolicy(key, DEFAULTS[key]!);
  invalidatePolicyCache();
  await cleanup();
}, 30_000);

test('flipping spend.daily_llm_cap to 0 in the DB caps the broker (no override)', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({ provider: fp.provider }); // limits come from the REAL store
  await setPolicy('spend.daily_llm_cap', 100);
  await setPolicy('spend.weekly_spend_ceiling', 100);
  // `policies` is a GLOBAL table and `reserveCall` checks the allowlist FIRST, before either
  // spend gate. This test used to set the two caps and inherit whatever allowlist the process
  // happened to be left with — so it passed or failed on test-file ORDER, which is exactly how
  // it went red on CI while passing on a re-run of the identical commit. Set every gate it
  // depends on. `models.allowlist` is already in TOUCHED, so afterAll still restores it.
  await setPolicy('models.allowlist', ALLOWLIST_WITH_TEST_MODEL);

  const ok = await meter(() => brokerLlmCall(USER_ID, { model: TEST_MODEL, prompt: 'hi' }));
  expect(outcomeOf(ok)).toBe('ok');

  await setPolicy('spend.daily_llm_cap', 0); // edit + cache invalidate
  const capped = await meter(() => brokerLlmCall(USER_ID, { model: TEST_MODEL, prompt: 'hi' }));
  expect(outcomeOf(capped)).toBe('llm_capped');
});

test('models.allowlist refuses a model not on the list', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({ provider: fp.provider });
  await setPolicy('spend.daily_llm_cap', 100);
  await setPolicy('spend.weekly_spend_ceiling', 100);
  await setPolicy('models.allowlist', ['claude-opus-4-7']);

  const blocked = await meter(() => brokerLlmCall(USER_ID, { model: 'gpt-4o', prompt: 'x' }));
  expect(outcomeOf(blocked)).toBe('model_not_allowed');
  expect(fp.calls()).toBe(0); // refused before the provider

  const allowed = await meter(() => brokerLlmCall(USER_ID, { model: TEST_MODEL, prompt: 'x' }));
  expect(outcomeOf(allowed)).toBe('ok');
});

test('spend.auto_suspend_idle drives getSandboxLimits + the idle sweep', async () => {
  await setPolicy('spend.auto_suspend_idle', '3 days');
  const limits = await getSandboxLimits();
  expect(limits.autoSuspendIdleMinutes).toBe(3 * 24 * 60);

  const now = new Date();
  const old = new Date(now.getTime() - 5 * 24 * 60 * 60_000); // 5 days idle
  const recent = new Date(now.getTime() - 1 * 60 * 60_000); // 1h idle
  const inserted = await db.insert(sandboxes).values([
    { tenant_id: DEMO_TENANT_ID, owner_id: USER_ID, slug: `pe-old-${crypto.randomUUID().slice(0, 6)}`, status: 'idle', last_active_at: old },
    { tenant_id: DEMO_TENANT_ID, owner_id: USER_ID, slug: `pe-new-${crypto.randomUUID().slice(0, 6)}`, status: 'idle', last_active_at: recent },
  ]).returning({ id: sandboxes.id });

  const swept = await sweepIdleSandboxes(db, now); // no explicit limits → reads policy
  const sweptIds = new Set(swept);
  expect(sweptIds.has(inserted[0]!.id)).toBe(true);
  expect(sweptIds.has(inserted[1]!.id)).toBe(false);
});

test('run-gate: models.external_http OFF refuses a network-capable block', () => {
  const snap = buildSnapshot([
    { key: 'models.external_http', category: 'm', label: '', description: '', control: 'toggle', value: false, options: null, unit: null, enabled: true, sort: 0, updated_by: null, updated_at: new Date(), effective_from: null, previous_value: null },
    { key: 'data.pii_scrubbing', category: 'd', label: '', description: '', control: 'toggle', value: false, options: null, unit: null, enabled: true, sort: 0, updated_by: null, updated_at: new Date(), effective_from: null, previous_value: null },
  ]);
  const descriptors = new Map<string, BlockDescriptor>([
    ['v1', { inputs: {}, outputs: {}, capabilities: { network: true } }],
  ]);
  const graph: FlowGraph = {
    nodes: [{ id: 'n1', blockId: 'b1', blockVersionId: 'v1', slug: 'fetch-thing', label: '', category: 'data', config: {}, position: { x: 0, y: 0 } }],
    edges: [],
  };
  const v = enforceRunPolicies(graph, descriptors, snap);
  expect(v?.code).toBe('policy_network_blocked');
  // ⛔ THE NAME OF THE OFFENDING NODE IS PART OF THE REFUSAL. Both callers put this on the wire
  // as `details.blockSlug`, and the SPA's localized copy interpolates it. Without it the Dutch
  // sentence can only say "a block in this flow" — anonymous, on a graph of up to 40 nodes.
  // Asserted against the node's OWN slug, not a constant, so a violation that reported the wrong
  // node would still fail.
  expect(v?.nodeSlug).toBe('fetch-thing');

  // Same graph, policy ON → allowed.
  const snapOn = buildSnapshot([
    { key: 'models.external_http', category: 'm', label: '', description: '', control: 'toggle', value: true, options: null, unit: null, enabled: true, sort: 0, updated_by: null, updated_at: new Date(), effective_from: null, previous_value: null },
  ]);
  expect(enforceRunPolicies(graph, descriptors, snapOn)).toBeNull();
});

test('run-gate: data.pii_scrubbing refuses a pii input from a non-mock source', () => {
  const snap = buildSnapshot([
    { key: 'data.pii_scrubbing', category: 'd', label: '', description: '', control: 'toggle', value: true, options: null, unit: null, enabled: true, sort: 0, updated_by: null, updated_at: new Date(), effective_from: null, previous_value: null },
  ]);
  // producer (v-plain) → consumer (v-pii) whose input `record` is pii.
  const descriptors = new Map<string, BlockDescriptor>([
    ['v-plain', { inputs: {}, outputs: { out: { type: 'json' } }, capabilities: {} }],
    ['v-mock', { inputs: {}, outputs: { out: { type: 'json' } }, capabilities: { mockData: true } }],
    // A producer that may read the tenant's REAL datasets and fabricates nothing. See `fromDataset`.
    ['v-dataset', { inputs: {}, outputs: { out: { type: 'json' } }, capabilities: { dataset: true } }],
    ['v-pii', { inputs: { record: { type: 'json', pii: true } }, outputs: {}, capabilities: {} }],
  ]);
  const consumer = { id: 'c', blockId: 'b', blockVersionId: 'v-pii', slug: 'use-pii', label: '', category: 'data' as const, config: {}, position: { x: 0, y: 0 } };

  const fromPlain: FlowGraph = {
    nodes: [{ id: 'p', blockId: 'b', blockVersionId: 'v-plain', slug: 'src', label: '', category: 'data', config: {}, position: { x: 0, y: 0 } }, consumer],
    edges: [{ id: 'e', source: 'p', sourceHandle: 'out', target: 'c', targetHandle: 'record' }],
  };
  const piiViolation = enforceRunPolicies(fromPlain, descriptors, snap);
  expect(piiViolation?.code).toBe('policy_pii_violation');
  // The CONSUMER's slug, not the producer's: the node the author has to change is the one whose
  // pii input is fed badly. Naming 'src' here would send them to the wrong block.
  expect(piiViolation?.nodeSlug).toBe('use-pii');

  const fromMock: FlowGraph = {
    nodes: [{ id: 'm', blockId: 'b', blockVersionId: 'v-mock', slug: 'mock', label: '', category: 'data', config: {}, position: { x: 0, y: 0 } }, consumer],
    edges: [{ id: 'e', source: 'm', sourceHandle: 'out', target: 'c', targetHandle: 'record' }],
  };
  expect(enforceRunPolicies(fromMock, descriptors, snap)).toBeNull();

  // ⛔ THE THIRD ARM, AND IT PINS A DELIBERATE TIGHTENING RATHER THAN A PRE-EXISTING RULE.
  // `capabilities.mockData` used to mean BOTH "fabricates its output" AND "may call ctx.dataset",
  // so `load-dataset` and every ontology-derived data block declared it purely to reach their own
  // rows — and that declaration ALSO bought them a free pass through this gate. A flow could feed
  // REAL dataset rows straight into a `pii`-marked input with pii_scrubbing ON and be allowed.
  //
  // Now that the bits are split, `run-policy.ts` still checks `mockData` ONLY, which is what the
  // policy has always claimed to mean: the producer must FABRICATE. A `dataset`-capable producer
  // emits the tenant's real rows, so it is refused. Without this arm the widening
  // (`mockData || dataset`) reads as a harmless consistency fix to the next author and silently
  // disarms `data.pii_scrubbing`; the `fromMock` arm above alone would not notice.
  const fromDataset: FlowGraph = {
    nodes: [{ id: 'd', blockId: 'b', blockVersionId: 'v-dataset', slug: 'load-dataset', label: '', category: 'data', config: {}, position: { x: 0, y: 0 } }, consumer],
    edges: [{ id: 'e', source: 'd', sourceHandle: 'out', target: 'c', targetHandle: 'record' }],
  };
  const datasetViolation = enforceRunPolicies(fromDataset, descriptors, snap);
  expect(datasetViolation?.code).toBe('policy_pii_violation');
  expect(datasetViolation?.nodeSlug).toBe('use-pii');
});

test('getSnapshot reflects the seeded demo values', async () => {
  for (const key of TOUCHED) await setPolicy(key, DEFAULTS[key]!);
  const s = await getSnapshot();
  expect(s.dailyLlmCap).toBe(50);
  expect(s.weeklySpendUsd).toBe(15);
  expect(s.allowlistedModels).toContain('claude-opus-4-7');
  expect(s.autoSuspendIdleMinutes).toBe(7 * 24 * 60);
});
