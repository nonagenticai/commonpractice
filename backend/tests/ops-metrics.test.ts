// tests/ops-metrics.test.ts — Session 4 Ops dashboard aggregates.
// Metrics are GLOBAL (seed + live), so we assert (a) structure, (b) the platform
// gate, and (c) deltas from a known insert (test files run sequentially, so the
// DB during this file = the static seed + only this file's rows).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError } from '../src/types';
import { Router } from '../src/utils/router';
import { registerOpsRoutes } from '../src/routes/ops';
import { getDashboard } from '../src/host/ops-metrics';
import type {
  Dashboard,
  SandboxErrorAlert,
  HighLatencyAlert,
  BlockErrorsAlert,
  SandboxSuspendedEvent,
} from '../src/host/ops-metrics';
import {
  db,
  users,
  tenants,
  sandboxes,
  usageCounters,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-0000000ab001';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000ab002';
const OTHER_USER = '00000000-0000-0000-0000-0000000ab003';
const platform: User = { id: UID, email: 'ops@test', name: 'Ops Admin', roles: ['super_admin', 'employee'], tenantId: DEMO_TENANT_ID };
const employee: User = { id: UID, email: 'ops@test', name: 'Ops Admin', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const SLUG_PREFIX = 'ztest-ops-';

function install(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, role) => {
      if (!u.roles.includes(role)) throw new UnauthorizedError(`Role '${role}' required`);
      return u;
    },
  });
}

const router = new Router();
registerOpsRoutes(router);

async function callJson(method: string, path: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const res = await withTenantDbAsRuntimeRoleForTests(DEMO_TENANT_ID, () =>
    matched.handler(new Request(`http://localhost${path}`, { method }), ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  // flow_runs FIRST: `flow_runs.triggered_by` REFERENCES users(id), so deleting the user below
  // while this file's synthetic runs are still there fails on the FK, and the failure surfaces as
  // an unrelated afterAll error two files later.
  await db.execute(sql`DELETE FROM flow_runs WHERE triggered_by = ${UID}`);
  // This file's synthetic blocks (the topBlocks name fixture). Prefix-scoped so it cannot touch
  // the seeded platform library.
  await db.execute(sql`DELETE FROM building_blocks WHERE slug LIKE ${SLUG_PREFIX + '%'}`);
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, UID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, UID));
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, OTHER_USER));
  await db.delete(users).where(eq(users.id, OTHER_USER));
  await db.delete(users).where(eq(users.id, UID));
  await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: platform.email, name: platform.name }).onConflictDoNothing();
  install(platform);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => install(platform));

test('non-platform user is rejected from the dashboard (401)', async () => {
  install(employee);
  const r = await callJson('GET', '/api/ops/dashboard');
  expect(r.status).toBe(403);
});

test('dashboard has the expected structure (24h buckets, ranked blocks, events)', async () => {
  const d = await getDashboard();

  expect(typeof d.stats.activeSandboxes).toBe('number');
  expect(typeof d.stats.dailyLlmCalls).toBe('number');
  expect(typeof d.stats.spendTodayUsd).toBe('number');
  expect(d.stats.p95LatencyMs === null || typeof d.stats.p95LatencyMs === 'number').toBe(true);

  expect(d.health.buckets).toHaveLength(24);
  for (const b of d.health.buckets) {
    expect(typeof b.activeRuns).toBe('number');
    expect(typeof b.llmCalls).toBe('number');
    expect(new Date(b.hourTs).toString()).not.toBe('Invalid Date');
  }

  // Seeded runs → most-used blocks ranked desc, top bar at 100%.
  expect(d.topBlocks.length).toBeGreaterThan(0);
  expect(d.topBlocks[0]!.pct).toBe(100);
  for (let i = 1; i < d.topBlocks.length; i++) {
    expect(d.topBlocks[i]!.count).toBeLessThanOrEqual(d.topBlocks[i - 1]!.count);
  }

  // Seeded fatima sandbox is in error → a needs-attention item exists.
  expect(d.attention.some((a) => a.kind === 'sandbox_error')).toBe(true);

  expect(Array.isArray(d.events)).toBe(true);
  for (const e of d.events) {
    expect(typeof e.actor).toBe('string');
    expect(typeof e.text).toBe('string');
  }
});

// ⛔⛔ THE FIXTURE'S `name` MUST DIFFER FROM ITS `slug`, AND THAT IS THE WHOLE TEST.
//
// `/it-dash` "Most used blocks" rendered `label={b.slug}` — a kebab-case identifier in a mono
// font — because `TopBlock` had no `name`. This asserts the DTO now carries one.
//
// The trap: `backend/src/db/seed.ts` sets `name` IDENTICAL to `slug` for all twelve platform
// blocks. Any assertion written against a seeded block reduces to `expect(name).toBe(slug)`,
// which passes against `name: x.slug`, against a client-side `?? slug`, and against NO FIX AT
// ALL (undefined !== the slug is the only thing separating them, and `toBe` on two undefineds
// would not even get that far). So the block is inserted HERE, named 'Claim form reader' with
// slug 'ztest-ops-read-claim-form' — two strings that cannot be confused for one another.
//
// REVERT THAT TURNS THIS RED: drop `name` from the `building_blocks` select in `getTopBlocks`,
// or return `name: slug`.
const NAMED_SLUG = 'ztest-ops-read-claim-form';
const NAMED_NAME = 'Claim form reader';

test('topBlocks carry the block NAME, which is not its slug', async () => {
  const flowRows = (await db.execute(sql`SELECT id FROM flows LIMIT 1`)) as unknown as {
    id: string;
  }[];
  const flow = flowRows[0];
  expect(flow, 'no flows in the corpus — this test cannot run').toBeDefined();

  await db.execute(
    sql`INSERT INTO building_blocks (slug, name, category) VALUES (${NAMED_SLUG}, ${NAMED_NAME}, 'data')`,
  );

  // Rank it FIRST rather than hoping: the aggregate is `ORDER BY n DESC LIMIT 6` over a shared
  // corpus, so a fixed run count could fall off the list as the seed grows.
  const beforeMax = (await getDashboard()).topBlocks[0]?.count ?? 0;
  const trace = JSON.stringify([{ type: 'node_success', slug: NAMED_SLUG, nodeId: 'n1' }]);
  for (let i = 0; i < beforeMax + 2; i++) {
    await db.execute(
      sql`INSERT INTO flow_runs (flow_id, triggered_by, tenant_id, status, trace, finished_at, total_ms)
          VALUES (${flow!.id}, ${UID}, ${DEMO_TENANT_ID}, 'ok', ${trace}::jsonb,
                  now() - interval '1 hour', 100)`,
    );
  }

  const top = (await getDashboard()).topBlocks[0]!;
  expect(top.slug, 'the fixture block did not rank first — the assertions below are vacuous').toBe(
    NAMED_SLUG,
  );
  expect(top.name).toBeDefined();
  expect(top.name).toBe(NAMED_NAME);
  expect(top.name).not.toBe(top.slug);
});

// ⛔⛔ CROSS-TENANT LEAK GUARD. `/it-dash` IS THE FLEET-WIDE super_admin SCREEN.
//
// `getTopBlocks` looks blocks up BY BARE SLUG, and since migration 0037 the slug is unique only
// PER OWNER (`building_blocks_slug_owner_uq` on `(slug, coalesce(tenant_id, zero-uuid))`), so the
// SAME slug legally exists for the platform AND for every tenant at once. The route runs the whole
// dashboard inside `runAsSystem` (routes/ops.ts:13) — cp_app's RLS read policy is not in play, so
// the lookup genuinely sees every tenant's private rows.
//
// Before the `name` column was added the collision only picked a bar COLOUR. Adding `name` promoted
// it to the human-readable LABEL: one tenant's private block name rendered on a screen every other
// tenant's platform operator reads. `?? b.slug` at the render site does NOT help — a name IS
// present, it is simply the wrong tenant's.
//
// This repo has already fixed this exact class once; see `src/blocks/i18n-key.ts`, which documents
// bare-slug keying letting "tenant B publishing `invoice-parser` OVERWRITE tenant A's row" and
// states "Sharing a slug is not exotic: 0037 exists to enable it."
//
// THE RULE: a fleet-wide screen resolves the PLATFORM-owned row (`tenant_id IS NULL`) or nothing.
// It never names one tenant's private block. `name`/`category` are resolved by the SAME lookup so
// the label and the colour cannot come from different rows.
//
// REVERTS THAT TURN THIS RED: drop the `isNull(buildingBlocks.tenant_id)` predicate from
// `getTopBlocks`' `building_blocks` select (whichever row the heap yields last wins), or resolve
// `category` from a different query than `name`.
const COLLIDE_SLUG = 'ztest-ops-collide-block';
const COLLIDE_PLATFORM_NAME = 'Platform claim reader';
const COLLIDE_TENANT_NAME = 'ACME internal payroll extractor';

test('a slug owned by BOTH the platform and a tenant resolves to the platform row, never the tenant name', async () => {
  const flowRows = (await db.execute(sql`SELECT id FROM flows LIMIT 1`)) as unknown as {
    id: string;
  }[];
  const flow = flowRows[0]!;

  // Platform row FIRST, tenant row SECOND — the heap order that made the tenant row win.
  await db.execute(
    sql`INSERT INTO building_blocks (slug, name, category, tenant_id)
        VALUES (${COLLIDE_SLUG}, ${COLLIDE_PLATFORM_NAME}, 'data', NULL)`,
  );
  await db.execute(
    sql`INSERT INTO building_blocks (slug, name, category, tenant_id)
        VALUES (${COLLIDE_SLUG}, ${COLLIDE_TENANT_NAME}, 'ai', ${DEMO_TENANT_ID})`,
  );
  // Both rows really are there — otherwise the unique index rejected one and there is no collision
  // left to test.
  const [collideCount] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM building_blocks WHERE slug = ${COLLIDE_SLUG}`,
  )) as unknown as { n: number }[];
  expect(Number(collideCount!.n), 'the collision fixture did not land — test is vacuous').toBe(2);

  const beforeMax = (await getDashboard()).topBlocks[0]?.count ?? 0;
  const trace = JSON.stringify([{ type: 'node_success', slug: COLLIDE_SLUG, nodeId: 'n1' }]);
  for (let i = 0; i < beforeMax + 2; i++) {
    await db.execute(
      sql`INSERT INTO flow_runs (flow_id, triggered_by, tenant_id, status, trace, finished_at, total_ms)
          VALUES (${flow.id}, ${UID}, ${DEMO_TENANT_ID}, 'ok', ${trace}::jsonb,
                  now() - interval '1 hour', 100)`,
    );
  }

  const top = (await getDashboard()).topBlocks[0]!;
  expect(top.slug, 'the collision fixture did not rank first — the assertions below are vacuous').toBe(
    COLLIDE_SLUG,
  );
  // THE POSITIVE HALF: the platform name is what a fleet screen shows.
  expect(top.name).toBe(COLLIDE_PLATFORM_NAME);
  // THE LEAK HALF.
  expect(top.name).not.toBe(COLLIDE_TENANT_NAME);
  // The bar COLOUR is resolved by the same rule, so label and colour cannot drift apart.
  expect(top.category).toBe('data');
  expect(top.category).not.toBe('ai');

  // ORDER INDEPENDENCE, not luck. An UPDATE writes a new tuple version at the end of the heap, so
  // this flips the physical order the two rows come back in. A "whichever row arrives last wins"
  // implementation passes above and fails here; a "first wins" one fails above and passes here.
  await db.execute(
    sql`UPDATE building_blocks SET name = ${COLLIDE_PLATFORM_NAME}
        WHERE slug = ${COLLIDE_SLUG} AND tenant_id IS NULL`,
  );
  const reordered = (await getDashboard()).topBlocks[0]!;
  expect(reordered.slug).toBe(COLLIDE_SLUG);
  expect(reordered.name).toBe(COLLIDE_PLATFORM_NAME);
  expect(reordered.category).toBe('data');
});

test('a top block owned ONLY by a tenant is not named on the fleet dashboard (falls back to the slug)', async () => {
  // The collision case above is the loud one, but the leak does not need a collision: a slug that
  // exists ONLY as one tenant's private block would still have put that tenant's private name on
  // every operator's fleet screen. The DTO says null and the render falls back to the slug —
  // exactly what /it-dash showed before `name` existed at all, which is the point.
  const flowRows = (await db.execute(sql`SELECT id FROM flows LIMIT 1`)) as unknown as {
    id: string;
  }[];
  const flow = flowRows[0]!;
  const PRIVATE_SLUG = 'ztest-ops-tenant-private-block';
  const PRIVATE_NAME = 'ACME payroll reconciliation';
  await db.execute(
    sql`INSERT INTO building_blocks (slug, name, category, tenant_id)
        VALUES (${PRIVATE_SLUG}, ${PRIVATE_NAME}, 'ai', ${DEMO_TENANT_ID})`,
  );
  const beforeMax = (await getDashboard()).topBlocks[0]?.count ?? 0;
  const trace = JSON.stringify([{ type: 'node_success', slug: PRIVATE_SLUG, nodeId: 'n1' }]);
  for (let i = 0; i < beforeMax + 2; i++) {
    await db.execute(
      sql`INSERT INTO flow_runs (flow_id, triggered_by, tenant_id, status, trace, finished_at, total_ms)
          VALUES (${flow.id}, ${UID}, ${DEMO_TENANT_ID}, 'ok', ${trace}::jsonb,
                  now() - interval '1 hour', 100)`,
    );
  }
  const top = (await getDashboard()).topBlocks[0]!;
  expect(top.slug, 'the private-block fixture did not rank first — vacuous').toBe(PRIVATE_SLUG);
  expect(top.name).toBeNull();
  expect(top.category).toBeNull();
  // Belt: the private name is nowhere in the whole payload, not merely absent from this one field.
  expect(JSON.stringify(await getDashboard())).not.toContain(PRIVATE_NAME);
});

test('a top block with no building_blocks row reports a null name (the render falls back)', async () => {
  // `getTopBlocks` derives slugs from `flow_runs.trace`, NOT from `building_blocks`, so a deleted
  // or renamed block still ranks and has no row to name it. This is why `?? b.slug` at the render
  // site is required rather than defensive — and why the DTO says `null` instead of quietly
  // substituting the slug, which would make the two cases indistinguishable.
  const flowRows = (await db.execute(sql`SELECT id FROM flows LIMIT 1`)) as unknown as {
    id: string;
  }[];
  const flow = flowRows[0]!;
  const GHOST = 'ztest-ops-deleted-block';
  const beforeMax = (await getDashboard()).topBlocks[0]?.count ?? 0;
  const trace = JSON.stringify([{ type: 'node_success', slug: GHOST, nodeId: 'n1' }]);
  for (let i = 0; i < beforeMax + 2; i++) {
    await db.execute(
      sql`INSERT INTO flow_runs (flow_id, triggered_by, tenant_id, status, trace, finished_at, total_ms)
          VALUES (${flow.id}, ${UID}, ${DEMO_TENANT_ID}, 'ok', ${trace}::jsonb,
                  now() - interval '1 hour', 100)`,
    );
  }
  const top = (await getDashboard()).topBlocks[0]!;
  expect(top.slug, 'the ghost slug did not rank first — this assertion would be vacuous').toBe(
    GHOST,
  );
  expect(top.name).toBeNull();
});

test('stats reflect a known insert (active sandbox + today usage deltas)', async () => {
  const before = (await getDashboard()).stats;

  // Two non-suspended sandboxes (count toward "active") + known usage today.
  await db.insert(sandboxes).values([
    { owner_id: UID, tenant_id: DEMO_TENANT_ID, slug: SLUG_PREFIX + 'a', status: 'idle', last_active_at: new Date() },
    { owner_id: UID, tenant_id: DEMO_TENANT_ID, slug: SLUG_PREFIX + 'b', status: 'running', last_active_at: new Date() },
  ]);
  // Conflict target names the tenant-aligned key (0058). `DO UPDATE` cannot be untargeted, so
  // this must change in the same release that adds the wide key — after 0059 drops the
  // pre-tenancy `(user_id, day)`, the old target 42P10s and reds CI.
  await db.execute(
    sql`INSERT INTO usage_counters (user_id, tenant_id, day, llm_calls, spend_usd)
        VALUES (${UID}, ${DEMO_TENANT_ID}, current_date, 50, 0.5)
        ON CONFLICT (tenant_id, user_id, day) DO UPDATE SET llm_calls = 50, spend_usd = 0.5`,
  );

  const after = (await getDashboard()).stats;
  expect(after.activeSandboxes - before.activeSandboxes).toBe(2);
  expect(after.dailyLlmCalls - before.dailyLlmCalls).toBe(50);
  expect(after.spendTodayUsd - before.spendTodayUsd).toBeCloseTo(0.5, 5);
});

// ⛔ HALF OF A MATCHED PAIR. Its twin is 'list + inspect report today usage from usage_counters'
// in tests/sandboxes-routes.test.ts, which seeds the SAME row shape (llm_calls = 3,
// platform_llm_calls = 5) and asserts a DIFFERENT number — 3, not 8. That asymmetry is deliberate
// and neither half means anything alone:
//   * THIS query (host/ops-metrics.ts:65) is the /it-dash FLEET-LOAD headline. A background call
//     is exactly as real as a human one, so it must sum BOTH columns — the translation drainer
//     alone can produce ~240 calls/hour, and counting only llm_calls would make all of it
//     invisible on the one screen whose entire job is to see it.
//   * The sandboxes query sits in a PER-PERSON row labelled with a named human's usage, so it
//     must sum llm_calls ONLY. Attributing 608 background calls to whoever clicked Backfill is a
//     false statement about a person.
// Anyone "harmonising" the two reds exactly one of these.
test('the fleet LLM-calls headline counts platform load as well as human calls (0061)', async () => {
  // REVERT THAT TURNS THIS RED: change ops-metrics.ts:65 back to `SUM(llm_calls)` — the delta
  // drops from 8 to 3, i.e. the 5 background calls vanish from the dashboard.
  await db.delete(usageCounters).where(eq(usageCounters.user_id, UID));
  const before = (await getDashboard()).stats.dailyLlmCalls;

  await db.execute(
    sql`INSERT INTO usage_counters (user_id, tenant_id, day, llm_calls, platform_llm_calls, spend_usd)
        VALUES (${UID}, ${DEMO_TENANT_ID}, current_date, 3, 5, 0)
        ON CONFLICT (tenant_id, user_id, day) DO UPDATE
          SET llm_calls = 3, platform_llm_calls = 5, spend_usd = 0`,
  );

  const after = (await getDashboard()).stats.dailyLlmCalls;
  expect(
    after - before,
    'the fleet headline must report 3 human + 5 platform = 8; reporting 3 hides every background call',
  ).toBe(8);
});

test('the platform route sees another tenant while the request connection is cp_app-scoped', async () => {
  const before = (await callJson('GET', '/api/ops/dashboard')).json.stats.activeSandboxes;
  await db.insert(tenants).values({ id: OTHER_TENANT, name: 'Ops other', slug: 'ztest-ops-other' });
  await db.insert(users).values({
    id: OTHER_USER,
    email: 'ops-other@test',
    name: 'Ops Other',
    tenant_id: OTHER_TENANT,
  });
  await db.insert(sandboxes).values({
    owner_id: OTHER_USER,
    tenant_id: OTHER_TENANT,
    slug: `${SLUG_PREFIX}other-tenant`,
    status: 'idle',
  });
  const after = (await callJson('GET', '/api/ops/dashboard')).json.stats.activeSandboxes;
  expect(after - before).toBe(1);
});

test('a suspended sandbox does NOT count as active', async () => {
  const before = (await getDashboard()).stats.activeSandboxes;
  await db.insert(sandboxes).values({ owner_id: UID, tenant_id: DEMO_TENANT_ID, slug: SLUG_PREFIX + 'susp', status: 'suspended', last_active_at: new Date() });
  const after = (await getDashboard()).stats.activeSandboxes;
  expect(after).toBe(before); // suspended excluded
});

// ==================================================================================================
// The i18n split (WS-1): /it-dash alerts + feed carry MACHINE FIELDS, and the English prose beside
// them is a one-deploy fallback, not the product.
// ==================================================================================================

const BOOM_SLUG = 'ztest-ops-boom';

/** The one `sandbox_error` alert, or undefined. Typed as a predicate so the union narrows. */
function sandboxAlert(d: Dashboard): SandboxErrorAlert | undefined {
  return d.attention.find((a): a is SandboxErrorAlert => a.kind === 'sandbox_error');
}

// ⛔ THE COUNT BUG. `title` was composed from `errored.length`, and `errored` is `LIMIT 5`. Twelve
// broken sandboxes therefore headlined "5 sandboxes in error" — the alert under-reported the
// incident by more than half, while the deep-link it offers showed all twelve.
//
// REVERT THAT TURNS THIS RED: in host/ops-metrics.ts `getAttention`, drop the separate
// `SELECT count(*)` and set `const errorCount = errored.length`. `errorCount` then pins at 5 and
// the `before + 7` assertion fails for any `before`.
test('the sandbox-error headline counts ALL error sandboxes, not the 5 sampled owners', async () => {
  const before = sandboxAlert(await getDashboard())?.errorCount ?? 0;

  await db.insert(sandboxes).values(
    Array.from({ length: 7 }, (_, i) => ({
      owner_id: UID,
      tenant_id: DEMO_TENANT_ID,
      slug: `${SLUG_PREFIX}err-${i}`,
      project: `ztest project ${i}`,
      status: 'error' as const,
      last_active_at: new Date(),
    })),
  );

  const a = sandboxAlert(await getDashboard());
  expect(a, 'seven error sandboxes produced no sandbox_error alert at all').toBeDefined();

  expect(a!.errorCount, 'errorCount must be the true COUNT(*), not the LIMIT 5 sample size').toBe(
    before + 7,
  );
  expect(a!.owners.length, 'the owner sample is capped at 5').toBe(5);
  // The two numbers are DIFFERENT here, which is the whole point of shipping both.
  expect(a!.errorCount).toBeGreaterThan(a!.owners.length);
  // …and the deprecated English still shown to an old frontend agrees with the true count.
  expect(a!.title).toBe(`${before + 7} sandboxes in error`);
});

test('machine fields are RAW — no units, no rounding, no pre-formatting', async () => {
  const d = await getDashboard();

  const a = sandboxAlert(d);
  expect(a).toBeDefined();
  expect(typeof a!.errorCount).toBe('number');
  expect(Array.isArray(a!.owners)).toBe(true);
  for (const o of a!.owners) {
    expect(typeof o.name).toBe('string');
    expect(o.project === null || typeof o.project === 'string').toBe(true);
    // ⛔ The owner list must arrive as STRUCTURE, not as the pre-joined "a · b; c · d" sentence —
    // the browser owns the separator, and `data-finding-label.ts` sets that precedent.
    expect(o.name).not.toContain(';');
  }

  const lat = d.attention.find((x): x is HighLatencyAlert => x.kind === 'high_latency');
  if (lat) {
    // The seed's 24h P95 is above the 2000 ms threshold, so this branch is the live one; the
    // guard is here so a re-seeded corpus degrades to "not asserted" rather than to a false red.
    expect(typeof lat.p95Ms).toBe('number');
    expect(typeof lat.thresholdMs).toBe('number');
    expect(lat.thresholdMs).toBe(2000);
    // REVERT THAT TURNS THIS RED: send `(p95 / 1000).toFixed(2) + 's'` as `p95Ms`, i.e. move the
    // unit back to the server. Integer-ms is the contract; seconds are a rendering decision.
    expect(Number.isInteger(lat.p95Ms)).toBe(true);
    expect(String(lat.p95Ms)).not.toMatch(/[a-z]/i);
  }
});

// REVERT THAT TURNS THIS RED: hard-code `interval '7 days'` back into the block-errors query and
// leave `windowDays: 14` (or vice versa) — the copy and the query drift, which is exactly what the
// single constant exists to prevent. Also red if `windowDays` is dropped from the payload.
test('block_errors carries slug + runCount + the SAME window the query used', async () => {
  const flowRows = (await db.execute(sql`SELECT id FROM flows LIMIT 1`)) as unknown as {
    id: string;
  }[];
  const flow = flowRows[0];
  expect(flow, 'no flows in the corpus — this test cannot run').toBeDefined();
  const trace = JSON.stringify([
    { type: 'node_error', slug: BOOM_SLUG, nodeId: 'n1', error: 'boom', kind: 'block_throw' },
  ]);
  // TWO separate runs: the alert's threshold is `>= 2` RUNS, deliberately not 2 error events.
  for (let i = 0; i < 2; i++) {
    await db.execute(
      sql`INSERT INTO flow_runs (flow_id, triggered_by, tenant_id, status, trace, finished_at, total_ms)
          VALUES (${flow!.id}, ${UID}, ${DEMO_TENANT_ID}, 'failed', ${trace}::jsonb,
                  now() - interval '1 hour', NULL)`,
    );
  }

  const d = await getDashboard();
  const b = d.attention.find(
    (x): x is BlockErrorsAlert => x.kind === 'block_errors' && x.slug === BOOM_SLUG,
  );
  expect(b, `no block_errors alert for ${BOOM_SLUG}`).toBeDefined();
  expect(b!.runCount).toBe(2);
  expect(b!.windowDays).toBe(7);
  // The deprecated English must quote the SAME window number the query filtered on.
  expect(b!.detail).toContain(`last ${b!.windowDays} days`);
  expect(b!.detail).toContain(`${b!.runCount} errored runs`);
});

test('feed events carry machine fields beside the prose', async () => {
  // ⛔ SEEDED, NOT SAMPLED. The corpus's newest 8 events are all `block_published`, so a loop over
  // whatever `getEvents` happens to return exercises ONE of the three branches and the other two
  // assert nothing. (Measured: a mutation that shipped a humanised "Ok" as `runStatus` left this
  // test green until these rows were added.) So: force one of each into the window, then assert
  // below that all three kinds were actually seen.
  const flowRows = (await db.execute(sql`SELECT id FROM flows LIMIT 1`)) as unknown as {
    id: string;
  }[];
  expect(flowRows[0], 'no flows in the corpus — this test cannot run').toBeDefined();
  await db.execute(
    sql`INSERT INTO flow_runs (flow_id, triggered_by, tenant_id, status, finished_at, total_ms)
        VALUES (${flowRows[0]!.id}, ${UID}, ${DEMO_TENANT_ID}, 'ok', now(), NULL)`,
  );
  await db.insert(sandboxes).values([
    // One WITH a project and one WITHOUT: `project` is nullable and null selects a different
    // sentence on the frontend, so both shapes have to reach the wire.
    {
      owner_id: UID,
      tenant_id: DEMO_TENANT_ID,
      slug: `${SLUG_PREFIX}susp-proj`,
      project: 'ztest suspended project',
      status: 'suspended' as const,
    },
    {
      owner_id: UID,
      tenant_id: DEMO_TENANT_ID,
      slug: `${SLUG_PREFIX}susp-noproj`,
      project: null,
      status: 'suspended' as const,
    },
  ]);
  // ⛔ THE THIRD KIND HAS TO BE PINNED TOO — LEAVING IT TO THE SEED IS THE BUG, NOT A SHORTCUT.
  // The two inserts above force `run_finished` and `sandbox_suspended` into the window at `now()`;
  // `block_published` was left to whatever the seed happened to leave behind, and that asymmetry is
  // what makes this test go red on an aged DB while NOTHING is broken.
  //
  // MECHANISM: `getEvents` (host/ops-metrics.ts:392-425) is a UNION ALL of three CAPPED subqueries
  // — block_versions `ORDER BY published_at DESC LIMIT 6`, flow_runs `ORDER BY finished_at DESC
  // LIMIT 6`, sandboxes `LIMIT 4` — under an outer `ORDER BY ts DESC LIMIT 8`. The seeded
  // `block_published` rows are stamped ONCE at seed time (`db/seed.ts:516`, `published_at: new
  // Date()`) and never refreshed. Meanwhile THIS FILE inserts `beforeMax + 2` flow_runs at
  // `now() - interval '1 hour'` in four earlier tests (:158-164, :228-234, :278-284, :305-311),
  // `beforeMax` compounds, and there is no per-test cleanup — only `afterAll`. So on any DB more
  // than ~1h past its seed, those runs outrank every seeded block row, `block_published` is squeezed
  // out of the LIMIT-8 window, and the non-vacuity gate below fires as a PHANTOM regression. Three
  // separate sessions have each burned a diagnostic cycle on that. A seeded row cannot be relied on
  // to survive the LIMIT-8 window on an aged database — so publish our own, at `now()`.
  //
  // NO CLEANUP CHANGE NEEDED: `cleanup()` (:67) deletes `building_blocks WHERE slug LIKE
  // 'ztest-ops-%'` and `SLUG_PREFIX` is exactly that prefix, while `block_versions.block_id` is
  // `onDelete: 'cascade'` (db/schema.ts:389-391), so the version row goes with the block. The block
  // delete also runs BEFORE the `users` delete at :72, so `published_by` never blocks on its FK.
  const [pubBlock] = (await db.execute(
    sql`INSERT INTO building_blocks (slug, name, category)
        VALUES (${SLUG_PREFIX + 'pub'}, 'Ops feed publish fixture', 'data')
        RETURNING id`,
  )) as unknown as { id: string }[];
  expect(
    pubBlock,
    'the block_published fixture did not insert — the gate below would red for the wrong reason',
  ).toBeDefined();
  // `version` is deliberately BARE ('1.0.0', no 'v') — the `not.toMatch(/^v/)` assertion below is
  // about what the SERVER ships, so the fixture must not pre-satisfy it with a prefixed literal.
  await db.execute(
    sql`INSERT INTO block_versions (block_id, version, status, descriptor, published_by, published_at)
        VALUES (${pubBlock!.id}, '1.0.0', 'stable', '{}'::jsonb, ${UID}, now())`,
  );

  const d = await getDashboard();
  expect(d.events.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  for (const e of d.events) {
    seen.add(e.kind);
    switch (e.kind) {
      case 'block_published':
        expect(typeof e.block).toBe('string');
        expect(typeof e.version).toBe('string');
        // The version arrives BARE — the "v" prefix is presentation and lives in the catalog.
        expect(e.version).not.toMatch(/^v/);
        break;
      case 'run_finished':
        expect(typeof e.flow).toBe('string');
        // ⛔ The RAW pg enum, so the browser can route it through the existing `runStatusLabel`.
        // REVERT THAT TURNS THIS RED: ship a humanised "Ok"/"Failed" from the server.
        expect(['running', 'ok', 'partial', 'failed']).toContain(e.runStatus);
        break;
      case 'sandbox_suspended':
        expect(e.project === null || typeof e.project === 'string').toBe(true);
        // '' must be normalised to null, or the frontend picks the "· " sentence for no project.
        expect(e.project).not.toBe('');
        break;
    }
  }

  // ⛔ THE NON-VACUITY GATE. Without this, a feed that happened to contain only one kind would
  // report three green branches it never entered.
  expect([...seen].sort(), 'the feed did not carry all three event kinds').toEqual([
    'block_published',
    'run_finished',
    'sandbox_suspended',
  ]);
  // Both `project` shapes really reached the wire, so the `not.toBe('')` above means something.
  const suspended = d.events.filter(
    (e): e is SandboxSuspendedEvent => e.kind === 'sandbox_suspended',
  );
  expect(suspended.some((e) => e.project === null)).toBe(true);
  expect(suspended.some((e) => typeof e.project === 'string')).toBe(true);
});

// ⛔ THE MID-ROLL CONTRACT. The browser reaches the API through the k8s SERVICE, which
// load-balances across old and new pods for a rolling deploy — so an OLD frontend, which renders
// `item.title` / `item.text` directly and has never heard of `errorCount`, really is answered by a
// NEW pod. Blanking these fields blanks the alert panel of every still-open old tab.
//
// REVERT THAT TURNS THIS RED: delete `title:` (or `detail:` / `text:`) from any one of the six
// object literals in getAttention/getEvents.
test('⛔ every alert and event still ships non-empty English prose (old-frontend fallback)', async () => {
  const d = await getDashboard();
  expect(d.attention.length, 'no alerts — the assertions below would pass vacuously').toBeGreaterThan(0);
  expect(d.events.length, 'no events — the assertions below would pass vacuously').toBeGreaterThan(0);

  for (const a of d.attention) {
    expect(typeof a.title, `${a.kind}.title`).toBe('string');
    expect(a.title.trim().length, `${a.kind}.title is blank`).toBeGreaterThan(0);
    expect(typeof a.detail, `${a.kind}.detail`).toBe('string');
    expect(a.detail.trim().length, `${a.kind}.detail is blank`).toBeGreaterThan(0);
  }
  for (const e of d.events) {
    expect(typeof e.text, `${e.kind}.text`).toBe('string');
    expect(e.text.trim().length, `${e.kind}.text is blank`).toBeGreaterThan(0);
  }
});

// ⛔ THE SOURCE GUARD. English word forms chosen from a number cannot be right in eight languages
// — pl has three integer plural categories and ar has five. That job belongs to the catalog
// (`ops_alert_sandbox_error_title`, `ops_alert_block_errors_detail`), which declares per locale
// only the categories that language genuinely writes. What is left in this file is a DEPRECATED
// English fallback, and it is fenced.
test('no ad-hoc English pluralisation survives outside the deprecated legacy-prose region', async () => {
  const src = await Bun.file(new URL('../src/host/ops-metrics.ts', import.meta.url)).text();

  // ⛔ NON-VACUITY FIRST. A mistyped path yields '' and every `not.toMatch` below passes while
  // asserting nothing. Assert we read a file, and that it is THIS file.
  expect(src.length, 'ops-metrics.ts read as empty — the path is wrong').toBeGreaterThan(2000);
  expect(src).toContain('BLOCK_ERROR_WINDOW_DAYS');
  expect(src).toContain('getAttention');

  // The inline suffix splice the count bug hid behind: `sandbox${n > 1 ? 'es' : ''}`.
  // REVERT THAT TURNS THIS RED: restore `` `${n} sandbox${n > 1 ? 'es' : ''} in error` ``.
  //
  // ⛔ BOTH BRANCHES, AND EMPTY STRINGS COUNT. The first version of this regex was
  // `/\?\s*['"`]e?s['"`]\s*:/` — it inspected only the ternary's TRUE branch, so it caught the
  // historical spelling and almost nothing else. An adversarial review measured it: of six
  // evasions, FIVE passed green, including `n === 1 ? '' : 's'`, which is the single most common
  // pluralisation idiom in JavaScript and is logically identical to the bug. A tripwire that only
  // recognises the exact typo it was written for is decoration.
  expect(src, "a `? 's' :` / `: 's'` suffix splice is back").not.toMatch(
    /\?\s*['"`]e?s?['"`]\s*:\s*['"`]e?s?['"`]/,
  );

  // Word-form-from-number anywhere OUTSIDE the fenced region.
  const begin = src.indexOf('⛔ BEGIN LEGACY PROSE');
  const end = src.indexOf('⛔ END LEGACY PROSE');
  expect(begin, 'the LEGACY PROSE region markers are gone — the fence is unenforceable').toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const outside = src.slice(0, begin) + src.slice(end);
  // REVERT THAT TURNS THIS RED: move `legacySandboxErrorTitle`'s body (or any
  // `n === 1 ? 'x' : 'xs'`) back inline into getAttention, outside the fence.
  // ⛔ `*`, NOT `+`, ON BOTH SIDES. With `+` an empty branch could not match, so
  // `n === 1 ? '' : 'sandboxes'` — the ordinary way to write this — walked straight through.
  expect(
    outside,
    'a word form is being chosen from a number outside the deprecated region',
  ).not.toMatch(/\?\s*['"`][A-Za-z ]*['"`]\s*:\s*['"`][A-Za-z ]*['"`]/);

  // ⚠️ WHAT THIS GUARD STILL CANNOT SEE, STATED RATHER THAN IMPLIED. It is a source REGEX, so it
  // recognises the ternary-of-two-literals shape and nothing else. Measured evasions that remain
  // green: `if (n === 1) { return 'sandbox' } return 'sandboxes'`;
  // `['sandbox','sandboxes'][n === 1 ? 0 : 1]`; and `n === 1 ? ONE : MANY` against consts. Closing
  // those needs an AST rule, not a longer pattern — do not let this comment tempt you into a regex
  // arms race. The guard's real job is to make the ORIGINAL bug un-restorable and to make a casual
  // reintroduction noisy; treat anything cleverer as unguarded and rely on review.
});
