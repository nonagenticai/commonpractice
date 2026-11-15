// tests/block-tests.test.ts — Phase 2-B per-block tests + publish gate.
// Integration: drives the block-test routes via in-process Request objects against
// the seeded CI/dev Postgres (:5433), executing real runner subprocesses. Auth is
// installed through the __setAuthOverridesForTests seam (NO mock.module).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import { seed } from '../src/db/seed';
import { seedDatasets } from '../src/db/seed-datasets';
import { seedPlatform } from '../src/db/seed-platform';
import { db, buildingBlocks, datasets, policies, users, withTenantDb } from '../src/db/client';
import { sampleInputsFor } from '../src/blocks/test-runner';
import { createDataset } from '../src/datasets/dataset-service';
import { parseJsonValue } from '../src/datasets/parse/json';
import { invalidatePolicyCache } from '../src/host/policy-store';
import type { User } from '../src/types';

const DOUBLER = 'test-bt-doubler';
const NOTESTS = 'test-bt-notests';
const TEST_SLUGS = [DOUBLER, NOTESTS];

const PII_DS_NAME = 'test-bt-pii-fixture';

async function cleanup() {
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.slug, TEST_SLUGS));
  await db.delete(datasets).where(eq(datasets.name, PII_DS_NAME));
}

const platformUser: User = {
  id: '00000000-0000-0000-0000-0000000000aa',
  email: 'plat@test',
  name: 'Plat',
  roles: ['super_admin', 'employee'],
  tenantId: '00000000-0000-0000-0000-0000000000aa',
};

function asUser(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, role) => {
      if (!u.roles.includes(role)) {
        const { UnauthorizedError } = await import('../src/types');
        throw new UnauthorizedError(`Role '${role}' required`);
      }
      return u;
    },
  });
}

const router = new Router();
registerBlockRoutes(router);

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const JSON_ACCEPT = { accept: 'application/json' };

const DOUBLER_SOURCE = `export default {
  descriptor: { inputs: { x: { type: 'number', required: true } }, outputs: { doubled: { type: 'number' } }, capabilities: {} },
  async run(inputs, ctx) { return { doubled: inputs.x * 2 }; }
};`;

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seed();
  await seedPlatform(); // ensures block_publish.require_passing_tests policy exists
  await seedDatasets(); // load-dataset block + its seeded tests + sample-claims
  await cleanup();
}, 30_000);
afterAll(cleanup, 30_000);
afterEach(() => __setAuthOverridesForTests(undefined));

// ---- tests CRUD ----

test('platform can create, list, patch and delete a block test', async () => {
  asUser(platformUser);
  await call('POST', '/api/blocks', {
    slug: DOUBLER,
    name: DOUBLER,
    category: 'logic',
    source_ts: DOUBLER_SOURCE,
    descriptor: {
      inputs: { x: { type: 'number', required: true } },
      outputs: { doubled: { type: 'number' } },
      capabilities: {},
    },
  });

  const created = await call('POST', `/api/blocks/${DOUBLER}/tests`, {
    name: 'doubles 5',
    inputs: { x: 5 },
    expected: { doubled: 10 },
    assert_mode: 'subset',
  });
  expect(created.status).toBe(201);
  const testId = created.json.id;

  const list = await call('GET', `/api/blocks/${DOUBLER}/tests?version=0.1.0`);
  expect(list.status).toBe(200);
  expect(list.json.total).toBe(1);

  const patched = await call('PATCH', `/api/blocks/${DOUBLER}/tests/${testId}`, { enabled: false });
  expect(patched.status).toBe(200);
  expect(patched.json.enabled).toBe(false);

  const del = await call('DELETE', `/api/blocks/${DOUBLER}/tests/${testId}`);
  expect(del.status).toBe(200);
  const after = await call('GET', `/api/blocks/${DOUBLER}/tests`);
  expect(after.json.total).toBe(0);
});

// ---- run tests through the real subprocess ----

test('running tests reports pass/fail via the real runner', async () => {
  asUser(platformUser);
  // pass + fail in one suite
  await call('POST', `/api/blocks/${DOUBLER}/tests`, {
    name: 'pass-doubles', inputs: { x: 5 }, expected: { doubled: 10 }, assert_mode: 'subset',
  });
  await call('POST', `/api/blocks/${DOUBLER}/tests`, {
    name: 'fail-wrong', inputs: { x: 5 }, expected: { doubled: 999 }, assert_mode: 'subset',
  });

  const run = await call('POST', `/api/blocks/${DOUBLER}/versions/0.1.0/test`, undefined, JSON_ACCEPT);
  expect(run.status).toBe(200);
  expect(run.json.total).toBe(2);
  expect(run.json.passed).toBe(1);
  expect(run.json.testsPassing).toBe(false);
  const byName = new Map(run.json.results.map((r: any) => [r.name, r.status]));
  expect(byName.get('pass-doubles')).toBe('pass');
  expect(byName.get('fail-wrong')).toBe('fail');
});

test('expect_error test passes when the block errors (missing required input)', async () => {
  asUser(platformUser);
  // remove the failing test so the suite can be green, keep pass + an expect_error
  const list = await call('GET', `/api/blocks/${DOUBLER}/tests`);
  for (const t of list.json.items) {
    if (t.name === 'fail-wrong') await call('DELETE', `/api/blocks/${DOUBLER}/tests/${t.id}`);
  }
  await call('POST', `/api/blocks/${DOUBLER}/tests`, {
    name: 'missing-x-errors', inputs: {}, expect_error: true, expected_error_kind: 'validation',
  });
  const run = await call('POST', `/api/blocks/${DOUBLER}/versions/0.1.0/test`, undefined, JSON_ACCEPT);
  expect(run.json.testsPassing).toBe(true);
  const byName = new Map(run.json.results.map((r: any) => [r.name, r.status]));
  expect(byName.get('missing-x-errors')).toBe('pass');
});

// ---- lint endpoint ----

test('lint endpoint flags a type error in unsaved source', async () => {
  asUser(platformUser);
  const r = await call('POST', `/api/blocks/${DOUBLER}/versions/0.1.0/lint`, {
    source_ts: `export default { descriptor: { inputs:{}, outputs:{}, capabilities:{} }, async run(i, ctx){ const n: number = "x"; return { n }; } };`,
  });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(false);
  expect(r.json.findings.some((f: any) => f.source === 'type')).toBe(true);
});

// ---- publish gate ----

test('publish to stable is blocked when a block has no tests', async () => {
  asUser(platformUser);
  await call('POST', '/api/blocks', {
    slug: NOTESTS,
    name: NOTESTS,
    category: 'logic',
    source_ts: DOUBLER_SOURCE,
    descriptor: {
      inputs: { x: { type: 'number', required: true } },
      outputs: { doubled: { type: 'number' } },
      capabilities: {},
    },
  });
  const pub = await call('POST', `/api/blocks/${NOTESTS}/versions/0.1.0/publish`, { status: 'stable' });
  expect(pub.status).toBe(422);
  expect(pub.json.error).toBe('tests_required');
}, 30_000);

test('publish to stable is blocked when a test fails, allowed when all pass', async () => {
  asUser(platformUser);
  // NOTESTS currently has DOUBLER_SOURCE; add a failing test → blocked.
  const fail = await call('POST', `/api/blocks/${NOTESTS}/tests`, {
    name: 'will-fail', inputs: { x: 1 }, expected: { doubled: 7 }, assert_mode: 'subset',
  });
  const blocked = await call('POST', `/api/blocks/${NOTESTS}/versions/0.1.0/publish`, { status: 'stable' });
  expect(blocked.status).toBe(422);
  expect(blocked.json.error).toBe('tests_failing');

  // fix the test to match → publish succeeds.
  await call('PATCH', `/api/blocks/${NOTESTS}/tests/${fail.json.id}`, { expected: { doubled: 2 } });
  const ok = await call('POST', `/api/blocks/${NOTESTS}/versions/0.1.0/publish`, { status: 'stable' });
  expect(ok.status).toBe(200);
  expect(ok.json.status).toBe('stable');
  expect(ok.json.tests_passing).toBe(true);
}, 30_000);

// ---- Phase 2: one-off simulate (no persist) ----

test('sampleInputsFor fills descriptor defaults then overlays the first example', () => {
  const descriptor = {
    inputs: {
      src: { type: 'dataset' as const, default: 'sample-claims' },
      threshold: { type: 'number' as const },
    },
  };
  // no examples → just the dataset default
  expect(sampleInputsFor(descriptor, [])).toEqual({ src: 'sample-claims' });
  // example inputs win over / extend the defaults
  const examples = [{ name: 'e1', inputs: { src: 'other-ds', threshold: 5 } }];
  expect(sampleInputsFor(descriptor, examples)).toEqual({ src: 'other-ds', threshold: 5 });
});

test('simulate runs the block once and returns outputs (happy path)', async () => {
  asUser(platformUser);
  // DOUBLER was created in the first test; run it once with explicit inputs.
  const sim = await call('POST', `/api/blocks/${DOUBLER}/versions/0.1.0/simulate`, { inputs: { x: 21 } });
  expect(sim.status).toBe(200);
  expect(sim.json.status).toBe('ok');
  expect(sim.json.outputs.doubled).toBe(42);
  expect(sim.json.error).toBeNull();
  expect(typeof sim.json.durationMs).toBe('number');
  // simulate persists nothing: the block has no recorded test results from this call.
});

test('simulate returns a classified error for a bad run (missing required input)', async () => {
  asUser(platformUser);
  // No inputs + no examples/defaults on DOUBLER → descriptor validation fails in the runner.
  const sim = await call('POST', `/api/blocks/${DOUBLER}/versions/0.1.0/simulate`, { inputs: {} });
  expect(sim.status).toBe(200);
  expect(sim.json.status).toBe('error');
  expect(sim.json.outputs).toBeNull();
  expect(sim.json.error.kind).toBe('validation');
  expect(typeof sim.json.error.message).toBe('string');
});

// ---- PII redaction on the simulate path (the MCP → external-LLM vector) ----
//
// This test exists because the ORIGINAL bug was invisible to every other test in this
// file: `test-runner.ts` passed `redact = false` hardcoded, and the whole suite stayed
// green because no seeded dataset carries a `pii: true` column. So a green run proved
// nothing at all about redaction. This one FAILS if that hardcoded `false` comes back —
// verified by reverting the fix, not assumed.
//
// Why simulate specifically: its JSON result is what the `simulate_block` MCP tool
// returns, and mcp/tools.ts pushes that straight into the agent's message list, which
// ai/agent.ts ships to the tenant's configured EXTERNAL LLM on the next turn.
test('simulate redacts pii columns — the simulate_block MCP result must not carry raw PII', async () => {
  asUser(platformUser);
  const PII_VALUE = 'leak-me@example.invalid';

  // ⛔ FIXTURES RESOLVE IN THE TENANT THE REQUEST IS SCOPED TO, not in `users.tenant_id`.
  // `blocks/test-runner.ts` used to call `homeTenantOf(ctxUserId)` here, which made the copilot's
  // own `simulate_block` tool read the caller's STALE home tenant and so miss their workspace's
  // datasets entirely; it now takes the tenant its caller threads in. This test used to mirror the
  // old expression, so it has to move with it — and the move is toward production, not away:
  // a real simulate always arrives inside a request whose GUC is already bound, which is what the
  // `withTenantDb` around the call below supplies for the bare-handler `call()` helper.
  const fixtureTenant = platformUser.tenantId!;
  // platformUser is a synthetic auth-override identity with no `users` row, and
  // datasets.owner_id is a real FK — borrow any seeded user for the audit column.
  // tenant_id has no FK, so the fixture tenant above is still what gets scoped on.
  const [owner] = await db.select({ id: users.id }).from(users).limit(1);
  const ds = await createDataset({
    ownerId: owner!.id,
    tenantId: fixtureTenant,
    name: PII_DS_NAME,
    sourceType: 'json',
    parsed: parseJsonValue([{ id: 'C-1', email: PII_VALUE }]),
  });

  // A human data-manager flags the column. Inference never sets `pii` on its own, so
  // without this write there is nothing for the redactor to act on.
  await db
    .update(datasets)
    .set({ columns: ds.columns.map((c) => (c.name === 'email' ? { ...c, pii: true } : c)) })
    .where(eq(datasets.id, ds.id));

  // Set the gate this test depends on rather than inheriting it. `policies` is a GLOBAL
  // table and other files rewrite these keys — inheriting one is exactly what made
  // policy-enforcement.test.ts decide pass/fail on test-file ORDER (PR #155).
  // NB the value must be a PLAIN boolean: policy-store's `asBool` returns its fallback
  // for anything else, and this key's fallback is `true` — so an object-shaped value
  // would make this test pass without the policy row meaning anything.
  await db
    .insert(policies)
    .values({
      key: 'data.pii_scrubbing',
      category: 'data_isolation',
      label: 'PII scrubbing on submitted material',
      control: 'toggle',
      value: true,
    })
    .onConflictDoUpdate({ target: policies.key, set: { value: true } });
  invalidatePolicyCache();

  const sim = await withTenantDb(fixtureTenant, () =>
    call('POST', '/api/blocks/load-dataset/versions/1.0.0/simulate', {
      inputs: { source: ds.slug },
    }),
  );
  // Collapse to a named outcome — `toBe('ok')` on a bare boolean would discard the
  // one field that separates "redaction regressed" from "the fixture never loaded".
  expect(sim.json.status === 'ok' ? 'ok' : `${sim.status}:${JSON.stringify(sim.json.error)}`).toBe(
    'ok',
  );

  const rows = sim.json.outputs.rows as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  // Non-PII columns must survive — a redactor that nukes everything would also pass
  // the assertion below while destroying the feature.
  expect(rows[0]!.id).toBe('C-1');
  expect(rows[0]!.email).toBe('[redacted]');
  // The assertion that actually matches the threat: nothing anywhere in the payload
  // that crosses the MCP boundary may contain the raw value.
  expect(JSON.stringify(sim.json)).not.toContain(PII_VALUE);
}, 30_000);

test('the seeded load-dataset tests pass against the seeded dataset', async () => {
  asUser(platformUser);
  const [block] = await db
    .select({ current: buildingBlocks.current_version_id })
    .from(buildingBlocks)
    .where(eq(buildingBlocks.slug, 'load-dataset'));
  const version = block!.current!;
  // resolve the version string
  const detail = await call('GET', '/api/blocks/load-dataset');
  const v = detail.json.versions.find((x: any) => x.id === version)?.version ?? '1.0.0';
  const run = await call('POST', `/api/blocks/load-dataset/versions/${v}/test`, undefined, JSON_ACCEPT);
  expect(run.status).toBe(200);
  expect(run.json.total).toBe(2);
  expect(run.json.testsPassing).toBe(true);
});
