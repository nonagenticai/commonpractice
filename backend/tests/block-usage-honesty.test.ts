// tests/block-usage-honesty.test.ts — the two numbers the block library was inventing.
//
// THE DEFECTS THIS PINS.
//
// (1) ROW MULTIPLICATION. Every usage figure derived from a flow-run trace was
//     `count(*) FROM flow_runs fr, jsonb_array_elements(fr.trace) ev`. The lateral yields one row
//     per node_success EVENT, and `flow-executor.ts` emits one per foreach ITERATION, so a block
//     used ONCE inside a `foreach` over 400 rows reported 400 "runs" for a single execution —
//     inflating the block-edit sparkline, the "top consumers" list, and /it-dash's "Most used
//     blocks" (where loop-body blocks outranked everything else by construction).
//
// (2) A FROZEN SEED LITERAL SERVED AS TRUTH. `block_versions.usage_count` is written in exactly
//     one place — `db/seed.ts` — and incremented by nothing, ever. It was the library's DEFAULT
//     SORT KEY and the block-edit "Total uses" tile, so a seeded block claimed 4,821 uses directly
//     above a 30-day trend showing 2 runs, and a block genuinely executed 50 times read "Used 0×"
//     and sorted last forever.
//
// Both are asserted against REAL rows: a run whose trace carries N node_success events for one
// slug, and blocks whose seeded column and real run history deliberately disagree.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import { getDashboard } from '../src/host/ops-metrics';
import {
  db,
  users,
  flows,
  flowRuns,
  buildingBlocks,
  blockVersions,
  challenges,
  solutions,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { TraceEvent } from '../src/db/trace-types';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000b105001';
const user: User = { id: UID, email: 'ws5blocks@test', name: 'Usage Tester', roles: ['employee'], tenantId: DEMO_TENANT_ID };

// One marker so the ?q= filter isolates these rows from the 40-odd seeded blocks.
const MARK = 'zws5usage';
const SLUG_LOOP = `${MARK}-loop-body`; // used ONCE, inside a foreach over LOOP_ROWS rows
const SLUG_STALE = `${MARK}-stale-seed`; // seeded usage_count, zero real runs
const SLUG_REAL = `${MARK}-real-runs`; // usage_count 0, REAL_RUNS real runs
const SLUG_UNFINISHED = `${MARK}-unfinished`; // only ever seen in a run still status='running'
const SLUG_FLAKY = `${MARK}-flaky`; // ONE run, FLAKY_ERRORS node_error events inside it
const SLUG_POPULAR = `${MARK}-popular`; // run by CONSUMER_FLOWS separate flows — past the LIMIT 6
const ALL_SLUGS = [SLUG_LOOP, SLUG_STALE, SLUG_REAL, SLUG_UNFINISHED, SLUG_FLAKY, SLUG_POPULAR];

const LOOP_ROWS = 400;
const REAL_RUNS = 3;
const STALE_SEEDED_COUNT = 4821;
const FLAKY_ERRORS = 7; // > the alert's "2 or more RUNS" threshold, inside a single run
/** ⛔ 8, AND IT MUST STAY > 6. The top-consumers list is `ORDER BY r.runs DESC, f.id LIMIT 6`, so a
 *  fixture at or below the cap makes every assertion about the cap vacuous. */
const CONSUMER_FLOWS = 8;
const CONSUMER_CAP = 6;

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerBlockRoutes(router);

async function call(method: string, path: string): Promise<{ status: number; json: any }> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const res = await matched.handler(new Request(`http://localhost${path}`, { method }), ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const DESCRIPTOR = { inputs: {}, outputs: {}, capabilities: {} } as never;

async function makeBlock(slug: string, seededUsage: number) {
  const [block] = await db
    .insert(buildingBlocks)
    .values({ slug, name: `${MARK} ${slug}`, description: MARK, category: 'logic', tenant_id: DEMO_TENANT_ID })
    .returning();
  const [version] = await db
    .insert(blockVersions)
    .values({
      block_id: block!.id,
      version: '1.0.0',
      status: 'stable',
      descriptor: DESCRIPTOR,
      usage_count: seededUsage,
      published_at: new Date(),
    })
    .returning();
  await db.update(buildingBlocks).set({ current_version_id: version!.id }).where(eq(buildingBlocks.id, block!.id));
  return block!;
}

/** A node_success event for `slug`. Only `type` and `slug` are read by the usage queries; the
 *  rest is filled so the row is a structurally valid trace, as the executor writes it. */
function nodeSuccess(slug: string, i: number): TraceEvent {
  return {
    type: 'node_success',
    runId: '00000000-0000-0000-0000-00000b105ff0',
    ts: Date.now(),
    nodeId: `n${i}`,
    slug,
    durationMs: 1,
    cost: { ms: 1, usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 },
    outputPreview: '',
  } as TraceEvent;
}

/** A node_error event for `slug`, as the executor writes one when a node throws. */
function nodeError(slug: string, i: number): TraceEvent {
  return {
    type: 'node_error',
    runId: '00000000-0000-0000-0000-00000b105ff1',
    ts: Date.now(),
    nodeId: `n${i}`,
    slug,
    durationMs: 1,
    error: 'boom',
    kind: 'block_throw',
  } as TraceEvent;
}

async function makeRun(flowId: string, trace: TraceEvent[]) {
  await db.insert(flowRuns).values({
    flow_id: flowId,
    tenant_id: DEMO_TENANT_ID,
    triggered_by: UID,
    status: 'ok',
    trace,
    finished_at: new Date(),
  });
}

/** A run that is STILL EXECUTING: `finished_at` NULL, trace partial. The usage figures must not
 *  see it — the trend and consumers windows are keyed on `finished_at`, so a run counted here but
 *  invisible there prints "1 total run" above an empty 30-day chart. */
async function makeUnfinishedRun(flowId: string, trace: TraceEvent[]) {
  await db.insert(flowRuns).values({
    flow_id: flowId,
    tenant_id: DEMO_TENANT_ID,
    triggered_by: UID,
    status: 'running',
    trace,
    finished_at: null,
  });
}

let flowId = '';
let challengeId = '';
const consumerFlowIds: string[] = [];

async function cleanup() {
  const ids = (await db.select({ id: flows.id }).from(flows).where(like(flows.name, `${MARK}%`))).map((f) => f.id);
  if (ids.length) {
    await db.delete(flowRuns).where(inArray(flowRuns.flow_id, ids));
    await db.delete(solutions).where(inArray(solutions.flow_id, ids));
    await db.delete(flows).where(inArray(flows.id, ids));
  }
  await db.delete(challenges).where(like(challenges.title, `${MARK}%`));
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.slug, ALL_SLUGS));
  await db.delete(users).where(eq(users.id, UID));
  consumerFlowIds.length = 0;
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name }).onConflictDoNothing();
  const [flow] = await db
    .insert(flows)
    .values({ name: `${MARK} flow`, owner_id: UID, tenant_id: DEMO_TENANT_ID, graph: { nodes: [], edges: [] } as never })
    .returning();
  flowId = flow!.id;

  // TWO published solutions on the SAME flow. `solutions.flow_id` is neither unique nor NOT NULL,
  // and the top-consumers query used to LEFT JOIN it flat, so this one flow was emitted as TWO
  // GROUP BY rows — the same flow listed twice, each row claiming the same run count, crowding
  // real consumers out of a top-6 list. Without these rows the dedup assertion below is vacuous:
  // one flow with zero solutions cannot be split by a join to `solutions`.
  const [challenge] = await db
    .insert(challenges)
    .values({
      title: `${MARK} challenge`,
      work_area: 'Claims',
      submitter_id: UID,
      tenant_id: DEMO_TENANT_ID,
      status: 'voting',
    })
    .returning();
  challengeId = challenge!.id;
  for (const n of ['alpha', 'beta']) {
    await db.insert(solutions).values({
      challenge_id: challengeId,
      tenant_id: DEMO_TENANT_ID,
      title: `${MARK} solution ${n}`,
      author_id: UID,
      flow_id: flowId,
      status: 'voting',
      published_at: new Date(),
    });
  }

  // CONSUMER_FLOWS separate flows, each running SLUG_POPULAR once. Separate FLOWS, not separate
  // runs of one flow: the consumers list groups by flow, so eight runs of one flow is one consumer.
  for (let i = 0; i < CONSUMER_FLOWS; i++) {
    const [f] = await db
      .insert(flows)
      .values({ name: `${MARK} consumer ${i}`, owner_id: UID, tenant_id: DEMO_TENANT_ID, graph: { nodes: [], edges: [] } as never })
      .returning();
    consumerFlowIds.push(f!.id);
  }

  await makeBlock(SLUG_LOOP, 0);
  await makeBlock(SLUG_STALE, STALE_SEEDED_COUNT);
  await makeBlock(SLUG_REAL, 0);
  await makeBlock(SLUG_UNFINISHED, 0);
  await makeBlock(SLUG_FLAKY, 0);
  await makeBlock(SLUG_POPULAR, 0);

  // ONE run. The block sits in a foreach body, so the executor emitted LOOP_ROWS node_success
  // events for it inside this single execution.
  await makeRun(
    flowId,
    Array.from({ length: LOOP_ROWS }, (_, i) => nodeSuccess(SLUG_LOOP, i)),
  );
  // REAL_RUNS separate executions of the plain (non-loop) block. SLUG_STALE is never run.
  for (let i = 0; i < REAL_RUNS; i++) await makeRun(flowId, [nodeSuccess(SLUG_REAL, i)]);
  // One run stranded mid-execution: succeeded this block, never finished.
  await makeUnfinishedRun(flowId, [nodeSuccess(SLUG_UNFINISHED, 0)]);
  // ONE run in which the same block threw FLAKY_ERRORS times (a foreach body failing per row).
  await makeRun(
    flowId,
    Array.from({ length: FLAKY_ERRORS }, (_, i) => nodeError(SLUG_FLAKY, i)),
  );
  // One finished run per consumer flow. Descending `i + 1` run counts so the ORDER BY has real work
  // to do and the six that survive are the six BUSIEST, not an arbitrary six.
  for (const [i, fid] of consumerFlowIds.entries()) {
    for (let r = 0; r <= i; r++) await makeRun(fid, [nodeSuccess(SLUG_POPULAR, r)]);
  }

  asUser(user);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => asUser(user));

// ---- T1: the load-bearing one ----

test('a block used ONCE inside a foreach over 400 rows counts as 1 run, not 400', async () => {
  const { status, json } = await call('GET', `/api/blocks?q=${MARK}`);
  expect(status).toBe(200);
  const loop = json.items.find((i: { slug: string }) => i.slug === SLUG_LOOP);
  expect(loop).toBeDefined();
  // The trace really does carry 400 node_success events — the fixture is not the fix.
  const eventRows = (await db.execute(sql`
    SELECT count(*)::int AS events FROM flow_runs fr, jsonb_array_elements(fr.trace) ev
    WHERE ev->>'type' = 'node_success' AND ev->>'slug' = ${SLUG_LOOP}
  `)) as unknown as { events: number }[];
  expect(eventRows[0]!.events).toBe(LOOP_ROWS);
  // ...and exactly one run produced them.
  expect(loop.usage_count).toBe(1);
});

test('the usage trend and top-consumers list count runs, not foreach iterations', async () => {
  const { status, json } = await call('GET', `/api/blocks/${SLUG_LOOP}`);
  expect(status).toBe(200);
  const trendTotal = json.usageTrend.reduce((a: number, p: { runs: number }) => a + p.runs, 0);
  expect(trendTotal).toBe(1);
  expect(json.consumers).toHaveLength(1);
  expect(json.consumers[0].runs).toBe(1);
});

test('a flow with TWO published solutions is listed ONCE in top consumers', async () => {
  // The fixture flow really does carry two solutions — the fixture is not the fix. Without them
  // this assertion is vacuous: a flow with no `solutions` row cannot be split by the join.
  const sols = await db.select({ id: solutions.id }).from(solutions).where(eq(solutions.flow_id, flowId));
  expect(sols).toHaveLength(2);

  const { json } = await call('GET', `/api/blocks/${SLUG_LOOP}`);
  const flowIds = json.consumers.map((c: { flowId: string }) => c.flowId);
  // The flat LEFT JOIN emitted one GROUP BY row per (flow, solution) pair, so this flow appeared
  // TWICE, each row claiming the same run count.
  expect(flowIds.filter((id: string) => id === flowId)).toHaveLength(1);
  expect(new Set(flowIds).size).toBe(flowIds.length);
  // ...and the one row that survives is attributed to a real solution, deterministically the
  // oldest — not to a null.
  const mine = json.consumers.find((c: { flowId: string }) => c.flowId === flowId);
  expect(mine.solutionId).not.toBeNull();
  expect(mine.solutionTitle).toContain('alpha');
});

test('a run still executing (finished_at NULL) is not counted as a use', async () => {
  // The trend and consumers windows are keyed on `finished_at`, so a run counted in the total but
  // invisible to them printed "1 total run" directly above an empty 30-day chart.
  const { json } = await call('GET', `/api/blocks?q=${MARK}`);
  const item = json.items.find((i: { slug: string }) => i.slug === SLUG_UNFINISHED);
  expect(item).toBeDefined();

  // The unfinished run really exists and really carries this slug — the fixture is not the fix.
  const evRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM flow_runs fr, jsonb_array_elements(fr.trace) ev
    WHERE ev->>'type' = 'node_success' AND ev->>'slug' = ${SLUG_UNFINISHED}
      AND fr.finished_at IS NULL
  `)) as unknown as { n: number }[];
  expect(evRows[0]!.n).toBe(1);

  expect(item.usage_count).toBe(0);

  const detail = await call('GET', `/api/blocks/${SLUG_UNFINISHED}`);
  expect(detail.json.usageCount).toBe(0);
  // The chart it sits above is empty, and now the tile agrees with it.
  const trendTotal = detail.json.usageTrend.reduce((a: number, p: { runs: number }) => a + p.runs, 0);
  expect(trendTotal).toBe(0);
});

test('the block list has a deterministic order, so blocks tied at 0 uses do not reshuffle', async () => {
  // With usage REAL rather than seeded, most of the library ties at 0 (16 of the 24 seeded blocks)
  // and the JS `items.sort` is stable — so whatever order Postgres hands back survives every tie.
  // With no ORDER BY that is heap order, which moves the moment a row is UPDATEd: the same request
  // returned a different tail for no reason a user could see.
  const items = () =>
    call('GET', `/api/blocks?q=${MARK}&sort=usage`).then((r) =>
      (r.json.items as { slug: string; usage_count: number }[]),
    );

  const before = await items();
  const zeroBefore = before.filter((i) => i.usage_count === 0).map((i) => i.slug);
  expect(zeroBefore.length).toBeGreaterThan(2); // the fixture really does have a tied tail
  // The tail is in SLUG order, not the order the rows happen to sit in the heap (which is the
  // insertion order LOOP, STALE, REAL, UNFINISHED, FLAKY).
  expect(zeroBefore).toEqual([...zeroBefore].sort());

  // A plain UPDATE writes a new heap tuple at the end of the table, so an unordered seq scan
  // returns this row in a different position afterwards.
  await db
    .update(buildingBlocks)
    .set({ description: `${MARK} touched` })
    .where(eq(buildingBlocks.slug, SLUG_STALE));

  expect((await items()).map((i) => i.slug)).toEqual(before.map((i) => i.slug));
});

test('N failures of one block inside ONE run do not arm the "failing repeatedly" alert', async () => {
  // The alert's copy says "N errored runs in the last 7 days" and its threshold is "2 or more
  // runs". Counting node_error EVENTS, a single run of a foreach whose body throws on every row
  // armed it by itself and reported 7 (here) / 400 (in prod) "errored runs".
  const evRows = (await db.execute(sql`
    SELECT count(*)::int AS events, count(DISTINCT fr.id)::int AS runs
    FROM flow_runs fr, jsonb_array_elements(fr.trace) ev
    WHERE ev->>'type' = 'node_error' AND ev->>'slug' = ${SLUG_FLAKY}
  `)) as unknown as { events: number; runs: number }[];
  expect(evRows[0]!.events).toBe(FLAKY_ERRORS); // the fixture is not the fix
  expect(evRows[0]!.runs).toBe(1);

  const dash = await getDashboard();
  const armed = dash.attention.filter((a) => a.kind === 'block_errors' && a.title.includes(SLUG_FLAKY));
  expect(armed).toEqual([]);
});

test('/it-dash "Most used blocks" ranks by runs, so a loop body cannot buy the top slot', async () => {
  // Same multiplication, third surface: with count(*) this block's single execution scored
  // LOOP_ROWS points over the 7-day window and took rank 1 outright, above every block that
  // genuinely ran in more flows (the busiest seeded block has 55 runs).
  const dash = await getDashboard();
  const loop = dash.topBlocks.find((b) => b.slug === SLUG_LOOP);
  expect(loop?.count ?? 0).toBeLessThan(LOOP_ROWS);
  expect(dash.topBlocks[0]?.slug).not.toBe(SLUG_LOOP);
});

// ---- T2: the frozen seed literal ----

test('a block with a seeded usage_count but no real runs reports 0 uses', async () => {
  const { json } = await call('GET', `/api/blocks?q=${MARK}`);
  const stale = json.items.find((i: { slug: string }) => i.slug === SLUG_STALE);
  // The column really does hold the seed literal — again, the fixture is not the fix.
  const [row] = await db
    .select({ n: blockVersions.usage_count })
    .from(blockVersions)
    .innerJoin(buildingBlocks, eq(buildingBlocks.id, blockVersions.block_id))
    .where(eq(buildingBlocks.slug, SLUG_STALE));
  expect(row!.n).toBe(STALE_SEEDED_COUNT);
  expect(stale.usage_count).toBe(0);
});

test('a block with real runs and usage_count = 0 reports its real count', async () => {
  const { json } = await call('GET', `/api/blocks?q=${MARK}`);
  const real = json.items.find((i: { slug: string }) => i.slug === SLUG_REAL);
  expect(real.usage_count).toBe(REAL_RUNS);
});

test('the default "most used" sort ranks real runs above a seeded literal', async () => {
  const { json } = await call('GET', `/api/blocks?q=${MARK}&sort=usage`);
  const order = json.items.map((i: { slug: string }) => i.slug);
  expect(order.indexOf(SLUG_REAL)).toBeLessThan(order.indexOf(SLUG_STALE));
});

test('block detail serves the real count as usageCount AND on every version row', async () => {
  const { json } = await call('GET', `/api/blocks/${SLUG_REAL}`);
  expect(json.usageCount).toBe(REAL_RUNS);
  // The per-version field is overwritten in the RESPONSE so an older frontend — which reads the
  // selected version's usage_count — is not served the dead column during a roll.
  // ⛔ NON-VACUITY: `.every()` on an empty array is vacuously true, so pin the population first —
  // `makeBlock` inserts exactly one version per block and nothing else in this fixture adds one.
  // Without this, `getBlock` returning `versions: []` would still pass the check below.
  expect(json.versions).toHaveLength(1);
  expect(json.versions.every((v: { usage_count: number }) => v.usage_count === REAL_RUNS)).toBe(true);

  const stale = await call('GET', `/api/blocks/${SLUG_STALE}`);
  expect(stale.json.usageCount).toBe(0);
  expect(stale.json.versions).toHaveLength(1);
  expect(stale.json.versions.every((v: { usage_count: number }) => v.usage_count === 0)).toBe(true);
});

// ---- T3: the cap the list never admitted to ----

test('⛔ THE DEFECT: eight consuming flows are served as six, with no total', async () => {
  // The fixture is not the fix: eight DISTINCT flows really do carry a finished run of this block.
  const rows = (await db.execute(sql`
    SELECT count(DISTINCT fr.flow_id)::int AS flows
    FROM flow_runs fr, jsonb_array_elements(fr.trace) ev
    WHERE ev->>'type' = 'node_success' AND ev->>'slug' = ${SLUG_POPULAR}
      AND fr.finished_at IS NOT NULL
  `)) as unknown as { flows: number }[];
  expect(rows[0]!.flows).toBe(CONSUMER_FLOWS);

  const { status, json } = await call('GET', `/api/blocks/${SLUG_POPULAR}`);
  expect(status).toBe(200);
  // The cap itself is unchanged — six is still what the panel renders.
  expect(json.consumers).toHaveLength(CONSUMER_CAP);
  // …and the response now says so. Without this the block-edit "Where it's used" panel reads as a
  // COMPLETE inventory of the blast radius to a maintainer weighing a breaking change.
  expect(json.consumersTotal).toBe(CONSUMER_FLOWS);
});

test('the six that survive the cap are the six BUSIEST, and the window did not eat the LIMIT', async () => {
  // ⛔ NON-VACUITY FOR THE `count(*) OVER ()`. A window function is evaluated over the SELECT's
  // whole result set and BEFORE `LIMIT` — that is the entire reason it costs no second query. The
  // failure mode of getting that wrong is not a wrong total, it is a wrong LIST: an implementation
  // that reached for a subquery or dropped the LIMIT would return all eight rows here.
  const { json } = await call('GET', `/api/blocks/${SLUG_POPULAR}`);
  const runs = json.consumers.map((c: { runs: number }) => c.runs);
  // Flow i ran it i+1 times, so the busiest six are 8,7,6,5,4,3 — the two 1-run and 2-run flows are
  // the ones cut.
  expect(runs).toEqual([8, 7, 6, 5, 4, 3]);
  expect(new Set(json.consumers.map((c: { flowId: string }) => c.flowId)).size).toBe(CONSUMER_CAP);
});

test('a block UNDER the cap reports its real total, not the cap', async () => {
  // ⛔ THE OVER-CORRECTION GUARD. Hardcoding `consumersTotal = 6`, or deriving it from
  // `consumers.length`, passes the case above and makes the field a lie everywhere else — and the
  // frontend gates its disclosure on `consumersTotal > consumers.length`, so a total pinned to the
  // row count would silently disable the notice this whole change exists to render.
  const { json } = await call('GET', `/api/blocks/${SLUG_LOOP}`);
  expect(json.consumers).toHaveLength(1);
  expect(json.consumersTotal).toBe(1);
});

test('a block nothing has run reports 0 consumers and 0 total', async () => {
  // No rows means no row to read the window value off. Zero is the right answer rather than a
  // missing one: the panel renders its empty state and a cap notice would be noise.
  const { json } = await call('GET', `/api/blocks/${SLUG_STALE}`);
  expect(json.consumers).toEqual([]);
  expect(json.consumersTotal).toBe(0);
});
