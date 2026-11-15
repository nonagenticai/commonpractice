// tests/solutions.test.ts — marketplace Solutions routes (Session 5).
// leaderboard (ranked by votes, scoped to a challenge), detail (block chain derived
// from the linked flow's graph + comparison bars + hasVoted), create (links a flow +
// challenge). Test rows isolated by a unique title marker.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerSolutionRoutes } from '../src/routes/solutions';
import { db, users, challenges, solutions, flows, flowRuns, votes, buildingBlocks, blockVersions, contentTranslations, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { weekString } from '../src/host/cycle-service';
import type { FlowGraph } from '../src/db/flow-types';
import type { User } from '../src/types';
import { requireScannedSource } from '../src/blocks/source-gate';
import { upsertTranslation } from '../src/db/translations';
import { BLOCK_I18N } from '../src/blocks/i18n-key';

const UID = '00000000-0000-0000-0000-00000c300001';
const user: User = { id: UID, email: 'soltest@test', name: 'Sol Tester', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const MARK = 'ZSOLTEST';
/** The library blocks this file plants, named once so `cleanup()` can also reach their
 *  `content_translations` rows — which no foreign key would take with them. */
const BLOCK_SLUGS = ['zsoltest-read', 'zsoltest-summary'];

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerSolutionRoutes(router);

// `headers` is the LOCALE SEAM and the reason it exists: `negotiateLocale` reads `accept-language`
// off the Request and nothing else, so a helper that could not set it made every solutions test an
// `en` test — and on `en` `getTranslationsBatch` short-circuits to an empty map, so the whole
// overlay (title, and now the block names on both DTOs) was unexercised by this file.
async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
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
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  const chIds = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  const solIds = chIds.length ? (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, chIds))).map((r) => r.id) : [];
  if (solIds.length) await db.delete(votes).where(inArray(votes.target_id, solIds));
  await db.delete(flowRuns).where(eq(flowRuns.triggered_by, UID));
  if (solIds.length) await db.delete(solutions).where(inArray(solutions.id, solIds));
  await db.delete(flows).where(eq(flows.owner_id, UID));
  const testBlocks = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(like(buildingBlocks.slug, 'zsoltest-%'));
  if (testBlocks.length) await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, testBlocks.map((row) => row.id)));
  // `content_translations` has no FK to `building_blocks` — it is keyed by (entity_type, entity_id)
  // and sits OUTSIDE RLS by design (blocks/i18n-key.ts), so deleting the block leaves the nl row
  // behind and the next run reads a translation for a slug it just re-created. Deleted by hand.
  await db.delete(contentTranslations).where(inArray(contentTranslations.entity_id, BLOCK_SLUGS));
  if (chIds.length) await db.delete(challenges).where(inArray(challenges.id, chIds));
  await db.delete(users).where(eq(users.id, UID));
}

let challengeId = '';
let flowId = '';
/** The PUBLICATION SNAPSHOT the nl test reads. Built in `beforeAll` because it has to pin the real
 *  `blockId`/`blockVersionId` of the two blocks this file plants, and its node SLUGS are those
 *  blocks' slugs — unlike the `read-claim-form`/`ai-summarize` chain above, whose names resolve out
 *  of the seeded platform catalogue. Owning both the block row AND its translation is what lets this
 *  test assert a Dutch string without writing over `content_translations` rows that migration 0073
 *  planted for the shared platform blocks (that table has no tenant column and no RLS — see
 *  blocks/i18n-key.ts — so an upsert against a platform slug is a fleet-wide overwrite). */
let nlGraph: FlowGraph = { nodes: [], edges: [] };

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name, avatar_initials: 'ST' }).onConflictDoNothing();
  // ⚠️ RE-BASELINED, NOT LOOSENED: the host challenge now carries the RUNNING ISO week. It used to
  // take the `text NOT NULL DEFAULT ''` week — the pre-0047 legacy shape — and the submit route
  // accepted a solution onto it, because the only guard was `status = 'closed'`. That is precisely
  // the defect challenge-submission-gate.test.ts exists for (prod filed a 2026-W33 solution against
  // a 2026-W23 challenge), so this fixture was asserting the bug. A challenge nobody can submit to
  // is a useless host for a file about submitting: it gets a live week, which is what a real
  // challenge on a live board has.
  const [c] = await db
    .insert(challenges)
    .values({ title: `${MARK} host`, work_area: 'Claims', submitter_id: UID, tenant_id: UID, week: weekString(new Date()) })
    .returning();
  challengeId = c!.id;
  const [readBlock] = await db.insert(buildingBlocks).values({ slug: 'zsoltest-read', name: 'read', category: 'data' }).returning();
  const [readVersion] = await db.insert(blockVersions).values({
    block_id: readBlock!.id, version: '1.0.0', status: 'stable', published_at: new Date(),
    source_ts: requireScannedSource('export default { async run() { return { out: "x" }; } }'),
    descriptor: { inputs: {}, outputs: { out: { type: 'string' } }, capabilities: {} },
  }).returning();
  const [summaryBlock] = await db.insert(buildingBlocks).values({ slug: 'zsoltest-summary', name: 'summary', category: 'ai' }).returning();
  const [summaryVersion] = await db.insert(blockVersions).values({
    block_id: summaryBlock!.id, version: '1.0.0', status: 'stable', published_at: new Date(),
    source_ts: requireScannedSource('export default { async run(inputs) { return { out: inputs.in }; } }'),
    descriptor: { inputs: { in: { type: 'string', required: true } }, outputs: { out: { type: 'string' } }, capabilities: {} },
  }).returning();
  const graph: FlowGraph = {
    nodes: [
      { id: 'n1', blockId: readBlock!.id, blockVersionId: readVersion!.id, slug: 'read-claim-form', label: 'read-claim-form', category: 'data', config: {}, position: { x: 0, y: 0 } },
      { id: 'n2', blockId: summaryBlock!.id, blockVersionId: summaryVersion!.id, slug: 'ai-summarize', label: 'ai-summarize', category: 'ai', config: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n2', targetHandle: 'in' }],
  };
  const [f] = await withTenantDb(DEMO_TENANT_ID, () => db.insert(flows).values({ name: `${MARK} flow`, owner_id: UID, graph }).returning());
  flowId = f!.id;
  nlGraph = {
    nodes: [
      { id: 'm1', blockId: readBlock!.id, blockVersionId: readVersion!.id, slug: 'zsoltest-read', label: 'zsoltest-read', category: 'data', config: {}, position: { x: 0, y: 0 } },
      // ⛔ THE CONTROL-FLOW TOKEN, ON THE BOARD ON PURPOSE. `foreach` is a loop CONTAINER, not a
      // block: `flow-types.ts` says its blockId/blockVersionId are empty and the library has never
      // held a row for the slug, so before the filter it rendered as a chip linking to
      // `/block-edit?slug=foreach` — a guaranteed 404 wearing an English identifier. It sits BETWEEN
      // the two real nodes so a filter that merely truncated would still red.
      { id: 'm2', blockId: '', blockVersionId: '', slug: 'foreach', label: 'foreach', category: 'logic', kind: 'foreach', config: {}, position: { x: 200, y: 0 }, loop: { maxIterations: 10 } },
      { id: 'm3', blockId: summaryBlock!.id, blockVersionId: summaryVersion!.id, slug: 'zsoltest-summary', label: 'zsoltest-summary', category: 'ai', config: {}, position: { x: 400, y: 0 } },
    ],
    edges: [],
  };
  asUser(user);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => asUser(user));

test('create a solution linking a flow + challenge, then leaderboard ranks it', async () => {
  const created = await call('POST', '/api/solutions', {
    challenge_id: challengeId,
    title: `${MARK} my solution`,
    flow_id: flowId,
    blocks_used: ['read-claim-form', 'ai-summarize'],
  });
  expect(created.status).toBe(201);
  expect(created.json.flow_id).toBe(flowId);
  // The create route used to omit `week` entirely, so every user-submitted solution took the
  // '' column default and the weekly close (`where week = '2026-W30'`) could never see it —
  // seven straight weeks of "Closed · no winner". It must carry the live ISO week.
  expect(created.json.week).toBe(weekString(new Date()));

  // A higher-voted peer to check ranking.
  await withTenantDb(DEMO_TENANT_ID, () => db.insert(solutions).values({ challenge_id: challengeId, title: `${MARK} peer`, author_id: UID, votes_count: 999, blocks_used: [] }));

  const list = await call('GET', `/api/solutions?challenge_id=${challengeId}`);
  expect(list.status).toBe(200);
  expect(list.json.challenge.id).toBe(challengeId);
  expect(list.json.items[0].title).toBe(`${MARK} peer`);
  expect(list.json.items[0].rank).toBe(1);
  expect(list.json.items.find((i: { title: string }) => i.title === `${MARK} my solution`).hasFlow).toBe(true);
});

test('detail derives the block chain from the linked flow graph', async () => {
  const [s] = await db.select({ id: solutions.id }).from(solutions).where(eq(solutions.title, `${MARK} my solution`));
  const detail = await call('GET', `/api/solutions/${s!.id}`);
  expect(detail.status).toBe(200);
  // ⛔ EACH CHAIN ENTRY IS `{slug, name}`, AND THE `name` IS THE CATALOGUE'S, NOT THE SLUG.
  // `slug` is the link target (`/block-edit?slug=…`) and the machine identity; `name` is the only
  // half a reader can read — `FlowChain.svelte` used to render `{slug}`, so a Dutch reader met
  // `read-claim-form → ai-summarize` inside a fully Dutch card.
  //
  // WHY THESE TWO STRINGS AND NOT THE SLUGS. No `accept-language` here, so `negotiateLocale`
  // returns `en`, `getTranslationsBatch` short-circuits to an empty map for the default locale
  // (db/translations.ts:125-127), and `blockDisplayNames` therefore serves `building_blocks.name`
  // verbatim for each global row it matched. Both slugs ARE global rows: `read-claim-form` →
  // 'Read claim form' and `ai-summarize` → 'Summarize with AI' are planted by `bun run seed`
  // (db/seed.ts BLOCKS), which CI runs before the suite (ci-cd.yaml:144) exactly as local dev does.
  // Falling back to the slug would mean the catalogue lookup found nothing — see the nl test below,
  // which pins the same resolution one rung further down for this file's own planted blocks.
  expect(detail.json.flow.chain).toEqual([
    { slug: 'read-claim-form', name: 'Read claim form' },
    { slug: 'ai-summarize', name: 'Summarize with AI' },
  ]);
  expect(detail.json.challenge.id).toBe(challengeId);
  // comparison bars: leader is the 999-vote peer at 100%.
  expect(detail.json.comparison[0].pct).toBe(100);
  expect(detail.json.comparison.some((c: { isThis: boolean }) => c.isThis)).toBe(true);
  // ⛔ BUILD TIME IS GONE FROM THE PRODUCT, WIRE INCLUDED. It had no honest source: the column was
  // NULL for every solution created through Build → Submit (`build/entry.ts` never sent it), so
  // /winner rendered a literal '—' as a hero stat and this page's byline read "Submitted 3d ago ·
  // Build time —". Re-adding `buildTimeMinutes: s.build_time_minutes` to the detail DTO in
  // routes/solutions.ts reds this line. `in`, not a value compare: a resurrected field carrying
  // `null` is exactly the regression, and `detail.json.buildTimeMinutes === undefined` would pass
  // for it.
  expect('buildTimeMinutes' in detail.json).toBe(false);
});

test('a Dutch reader gets Dutch block names on the chain — and the English slugs are untouched', async () => {
  // ⛔ WHAT THIS PROVES AND WHY NO OTHER TEST CAN. `/solutions/[id]` is the SIXTH render site of a
  // block's name and the only one the browser cannot repair on its own: the SPA's slug→name store
  // is published exclusively by /build's `loadPalette()`, so on this route it is EMPTY and
  // `FlowChain.svelte` prints whatever the DTO hands it. If the name is not localized HERE it is
  // never localized at all, and a Dutch reader meets English identifiers inside a Dutch card. The
  // frontend render test cannot see that — it is handed a chain and asked to draw it.
  //
  // Both halves are asserted because each fails differently and silently:
  //   • the NAME must follow `accept-language` — a hardcoded or `en`-only lookup reads as "the
  //     overlay works" on every English CI run and ships English to the only audience that needs it;
  //   • the SLUG must NOT — it is the `/block-edit?slug=…` link target and the identity `RunConsole`
  //     prints, so translating it turns a working link into a 404 in Dutch only.
  await upsertTranslation(BLOCK_I18N, 'zsoltest-read', 'nl', 'name', 'ZSOLTEST Claimformulier lezen');
  await upsertTranslation(BLOCK_I18N, 'zsoltest-summary', 'nl', 'name', 'ZSOLTEST Samenvatten met AI');
  // Inserted directly rather than through POST /api/solutions: `published_graph` is the publication
  // SNAPSHOT the detail route reads, and going through the create route would drag the whole
  // publish-time validator (resolveExecutableBlocks + policy gate) over a fixture whose only job is
  // to carry three node slugs.
  const [nlSol] = await withTenantDb(DEMO_TENANT_ID, () =>
    db.insert(solutions).values({
      challenge_id: challengeId, title: `${MARK} nl solution`, author_id: UID,
      flow_id: flowId, published_graph: nlGraph, blocks_used: ['zsoltest-read', 'zsoltest-summary'],
    }).returning(),
  );

  const nl = await call('GET', `/api/solutions/${nlSol!.id}`, undefined, { 'accept-language': 'nl-NL,nl;q=0.9' });
  expect(nl.status).toBe(200);
  expect(nl.json.flow.chain).toEqual([
    { slug: 'zsoltest-read', name: 'ZSOLTEST Claimformulier lezen' },
    { slug: 'zsoltest-summary', name: 'ZSOLTEST Samenvatten met AI' },
  ]);
  // The same overlay on the OTHER surface this DTO feeds — the no-flow `blocksUsed` line, which
  // rendered `blocksUsed.join(' · ')` and so printed English slugs in a Dutch card too.
  expect(nl.json.blocksUsedNames).toEqual(['ZSOLTEST Claimformulier lezen', 'ZSOLTEST Samenvatten met AI']);
  // `foreach` is filtered, not merely last: it was planted BETWEEN the two real nodes above.
  expect(nl.json.flow.chain.map((n: { slug: string }) => n.slug)).not.toContain('foreach');

  // ⛔ THE OTHER SIDE OF THE SEAM. Without this an assertion on `nl` alone passes for a route that
  // ignores `accept-language` entirely and hardcodes the Dutch string — `en` must still get the
  // base `building_blocks.name` columns ('read', 'summary'), because `getTranslationsBatch`
  // short-circuits for the default locale and never reads the rows just written above.
  const en = await call('GET', `/api/solutions/${nlSol!.id}`, undefined, { 'accept-language': 'en-GB,en;q=0.9' });
  expect(en.status).toBe(200);
  expect(en.json.flow.chain).toEqual([
    { slug: 'zsoltest-read', name: 'read' },
    { slug: 'zsoltest-summary', name: 'summary' },
  ]);
});

test('the create schema REFUSES the two removed fields rather than storing them', async () => {
  // `.strict()` does the work; this pins that the keys were removed from the schema and not merely
  // dropped from the INSERT (which would have accepted and silently discarded them). Re-adding
  // either key to `createSolutionSchema` reds this.
  //
  // ⚠️ 422, not 400: `utils/http.ts:125` maps a ZodError to `unprocessable`. The 400s elsewhere in
  // this file come from hand-written param guards, not from the body schema.
  for (const body of [
    { challenge_id: challengeId, title: `${MARK} rejected`, build_time_minutes: 90 },
    { challenge_id: challengeId, title: `${MARK} rejected`, demo_seconds: 60 },
  ]) {
    const r = await call('POST', '/api/solutions', body);
    expect(r.status).toBe(422);
  }
  expect(await db.select().from(solutions).where(eq(solutions.title, `${MARK} rejected`))).toHaveLength(0);
});

test('create against a missing challenge is 422', async () => {
  const r = await call('POST', '/api/solutions', { challenge_id: '00000000-0000-0000-0000-00000c3fffff', title: 'x' });
  expect(r.status).toBe(422);
});

test('create against a CLOSED challenge is 422, not a 201 onto a dead board', async () => {
  // There was no guard at all: a solution would be accepted, stamped with the CURRENT week, and
  // could then win it — producing a "this week's winner" whose challenge closed weeks ago.
  //
  // ⚠️ THE WEEK IS THE LIVE ONE ON PURPOSE, so this still pins the `status` ARM specifically. The
  // guard is now a disjunction (`status = 'closed'` OR the cycle is over — challengeClosedSql), and
  // with the old weekless fixture BOTH arms fired: the test would have stayed green with the status
  // arm deleted, naming a reason it was no longer testing. The cycle arm is covered by its own
  // cases in challenge-submission-gate.test.ts.
  const [closedCh] = await db
    .insert(challenges)
    .values({ title: `${MARK} closed host`, work_area: 'Claims', submitter_id: UID, tenant_id: UID, status: 'closed', week: weekString(new Date()) })
    .returning();
  const r = await call('POST', '/api/solutions', { challenge_id: closedCh!.id, title: `${MARK} too late` });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('challenge_closed');
  expect(await db.select().from(solutions).where(eq(solutions.challenge_id, closedCh!.id))).toHaveLength(0);
});

test('detail on a missing solution is 404', async () => {
  const r = await call('GET', '/api/solutions/00000000-0000-0000-0000-00000c3fffff');
  expect(r.status).toBe(404);
});

test('leaderboard with a non-UUID challenge_id is 400 (not a silent empty list)', async () => {
  const r = await call('GET', '/api/solutions?challenge_id=not-a-uuid');
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('invalid_challenge_id');
});

test('leaderboard with no challenge_id is 200 (unscoped)', async () => {
  const r = await call('GET', '/api/solutions');
  expect(r.status).toBe(200);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WS-2 — the demo duration is MEASURED, and it is measured off the RUN, not off the flow.
//
// `solutions.demo_seconds` was a seeded constant: 84/73/90/88/65 typed into seed-marketplace.ts,
// NULL for every solution a real person ever submitted, and hidden behind a truthiness check on the
// board so the invention and the absence looked identical. It is replaced by the most recent
// successful run STAMPED TO THIS SOLUTION (`flow_runs.solution_id`, migration 0065) — the run that
// `POST /api/runs {solutionId}`, i.e. the "Try it" button, creates.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A finished run against the shared test flow, optionally attributed to a solution. */
async function seedRun(opts: {
  solutionId: string | null;
  status: 'ok' | 'failed';
  totalMs: number | null;
  finishedAt: Date;
}) {
  const [run] = await db
    .insert(flowRuns)
    .values({
      flow_id: flowId,
      solution_id: opts.solutionId,
      tenant_id: DEMO_TENANT_ID,
      triggered_by: UID,
      status: opts.status,
      total_ms: opts.totalMs,
      started_at: new Date(opts.finishedAt.getTime() - 1000),
      finished_at: opts.finishedAt,
    })
    .returning();
  return run!;
}

test('demoMs is the latest SUCCESSFUL run of THIS solution — not the column, not the latest run', async () => {
  const [sol] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(solutions)
      .values({ challenge_id: challengeId, title: `${MARK} decoy`, author_id: UID, flow_id: flowId, blocks_used: [] })
      .returning(),
  );

  // ⛔ THE DECOY. The dead column is loaded with a value nothing else in this test can produce, so
  // "the route went back to reading `solutions.demo_seconds`" cannot hide as a plausible number:
  // restoring `demoSeconds: s.demo_seconds` to either DTO makes the assertions below read 999.
  await db.update(solutions).set({ demo_seconds: 999 }).where(eq(solutions.id, sol!.id));

  // Four runs on this solution, oldest → newest. Each one is a different revert's answer.
  await seedRun({ solutionId: sol!.id, status: 'ok', totalMs: 90_000, finishedAt: new Date('2026-08-01T10:00:00Z') });
  await seedRun({ solutionId: sol!.id, status: 'ok', totalMs: 3400, finishedAt: new Date('2026-08-02T10:00:00Z') });
  await seedRun({ solutionId: sol!.id, status: 'failed', totalMs: 1, finishedAt: new Date('2026-08-03T10:00:00Z') });
  // ⚠️ THE NEWEST ROW OF ALL, AND ITS DURATION IS NULL. This is not a stray fixture: `handle.totalMs`
  // starts null (run-controller.ts:195) and is only assigned from the `run_complete` frame
  // (run-controller.ts:500), so a run that ended without that frame — runner killed, stream cut, the
  // reconciler sweeping a stale lease — persists exactly like this. It is `ok` and it is newest, so
  // it wins every ordering; only `total_ms IS NOT NULL` keeps it out.
  await seedRun({ solutionId: sol!.id, status: 'ok', totalMs: null, finishedAt: new Date('2026-08-04T10:00:00Z') });

  const list = await call('GET', `/api/solutions?challenge_id=${challengeId}`);
  expect(list.status).toBe(200);
  const row = list.json.items.find((i: { title: string }) => i.title === `${MARK} decoy`);
  expect(row, 'the decoy solution is not on the board').toBeTruthy();

  const detail = await call('GET', `/api/solutions/${sol!.id}`);
  expect(detail.status).toBe(200);

  // ⛔ EVERY REVERT AND WHAT IT PRODUCES HERE, so a future reader can check the guard is real:
  //   • restore `demoSeconds: s.demo_seconds` in routes/solutions.ts (either DTO)  →  999
  //   • drop `eq(flowRuns.status, 'ok')` in host/solution-demo.ts                  →  1
  //   • drop `isNotNull(flowRuns.total_ms)` there                                  →  null
  //   • flip the `finished_at desc` in that ORDER BY to `asc`                      →  90000
  // Only the real implementation answers 3400, and both DTOs must agree — they share one helper.
  expect(row.demoMs).toBe(3400);
  expect(detail.json.demoMs).toBe(3400);

  // …and the old field is gone from the wire, not merely nulled. `in`, not `=== undefined`: a
  // resurrected `demoSeconds: null` is the regression and would pass a value compare.
  expect('demoSeconds' in row).toBe(false);
  expect('demoSeconds' in detail.json).toBe(false);
});

test('a run stamped to one solution does not become its SIBLING on the same flow', async () => {
  // ⛔ THE TEST THAT PINS THE WHOLE ARGUMENT FOR MIGRATION 0065. `flow_runs` already had `flow_id`,
  // so "join the runs through the flow" is the cheap answer that needs no column at all. It is
  // wrong, and this is why: ONE flow can back SEVERAL solutions (routes/flows.ts:165-167 uses
  // `.limit(1)` precisely because that reverse lookup is ambiguous). Both rows below share
  // `flowId`. Exactly one of them has ever been demoed.
  const [solA] = await withTenantDb(DEMO_TENANT_ID, () =>
    db.insert(solutions).values({ challenge_id: challengeId, title: `${MARK} sibling A`, author_id: UID, flow_id: flowId, blocks_used: [] }).returning(),
  );
  const [solB] = await withTenantDb(DEMO_TENANT_ID, () =>
    db.insert(solutions).values({ challenge_id: challengeId, title: `${MARK} sibling B`, author_id: UID, flow_id: flowId, blocks_used: [] }).returning(),
  );
  expect(solA!.flow_id).toBe(solB!.flow_id);

  await seedRun({ solutionId: solA!.id, status: 'ok', totalMs: 777, finishedAt: new Date('2026-08-05T10:00:00Z') });

  const a = await call('GET', `/api/solutions/${solA!.id}`);
  const b = await call('GET', `/api/solutions/${solB!.id}`);

  // Change the key in host/solution-demo.ts from `flowRuns.solution_id` to `flowRuns.flow_id` and
  // B reports 777 — A's demo, on B's page, forever. That is the failure mode; it is silent, it is
  // plausible, and no other test in this repo can see it.
  expect(a.json.demoMs).toBe(777);
  expect(b.json.demoMs).toBeNull();
});

test('an UNSTAMPED run — a /build draft on the same flow — is nobody\'s demo', async () => {
  // The other half of the same argument: draft runs land in the same `flow_id` bucket as published
  // demos, so a `flow_id` join reports the author's scratch iterations as the solution's demo time.
  const [sol] = await withTenantDb(DEMO_TENANT_ID, () =>
    db.insert(solutions).values({ challenge_id: challengeId, title: `${MARK} draft-only`, author_id: UID, flow_id: flowId, blocks_used: [] }).returning(),
  );
  await seedRun({ solutionId: null, status: 'ok', totalMs: 12_345, finishedAt: new Date('2026-08-06T10:00:00Z') });

  const detail = await call('GET', `/api/solutions/${sol!.id}`);
  // ⛔ `toBeNull`, and the DTO must never coalesce this to 0. "Nobody has run it" and "it ran
  // instantly" are different claims, and only one of them is true.
  expect(detail.json.demoMs).toBeNull();
});
