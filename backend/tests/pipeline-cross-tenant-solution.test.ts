// tests/pipeline-cross-tenant-solution.test.ts — promoting ANOTHER tenant's card must actually
// ship that tenant's solution.
//
// ⛔ THE SEAM. `pipeline_items` is deliberately OUTSIDE RLS (0028_rls.sql:24) so the platform
// Operate board shows EVERY tenant's cards. `solutions` is under strict RLS and carries a
// notNull `tenant_id`. `requireSuperAdmin` authenticates but never calls `refreshTenantGuc`, so
// `app.current_tenant` stays the OPERATOR'S OWN tenant for the whole request. Promoting a card
// owned by tenant B therefore ran
//     UPDATE solutions SET status='shipping' WHERE id = <B's solution>
// under tenant A's GUC — 0 rows, unchecked. The route returned 200 `live:true` and wrote a
// `deploy.production` audit row while the solution stayed in `voting` on B's marketplace.
// Rollback (`POST /:id/rollback`) had the identical shape in the other direction.
//
// WHY pipeline.test.ts IS BLIND TO IT, TWICE OVER: it runs as the table OWNER (RLS bypassed) AND
// every fixture it makes lives in the one DEMO tenant, so operator-tenant == card-tenant. This
// file crosses both axes — it runs AS `cp_app` via `withTenantDbAsRuntimeRoleForTests` and puts
// the solution in a DIFFERENT tenant from the acting operator.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError } from '../src/types';
import { Router } from '../src/utils/router';
import { registerPipelineRoutes } from '../src/routes/pipeline';
import {
  db,
  withTenantDbAsRuntimeRoleForTests,
  users,
  tenants,
  challenges,
  solutions,
  pipelineItems,
  pipelineReviews,
  auditLog,
  policies,
} from '../src/db/client';
import { invalidatePolicyCache } from '../src/host/policy-store';
import type { PolicyValue } from '../src/db/schema';
import type { User } from '../src/types';

// TENANT_A — where the acting platform operator's own claim points.
// TENANT_B — the tenant that actually OWNS the challenge, the solution and the card.
const TENANT_A = '00000000-0000-0000-0000-00000c7a0001';
const TENANT_B = '00000000-0000-0000-0000-00000c7b0001';
const ADMIN_ID = '00000000-0000-0000-0000-00000c7a1001';
const ADMIN_B_ID = '00000000-0000-0000-0000-00000c7a1002';
const AUTHOR_ID = '00000000-0000-0000-0000-00000c7b1001';
const USER_IDS = [ADMIN_ID, ADMIN_B_ID, AUTHOR_ID];
const MARK = 'ZTEST-XT ';

const operator: User = { id: ADMIN_ID, email: 'xt-op@test', name: 'Cross Op', roles: ['super_admin'], tenantId: TENANT_A };

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
registerPipelineRoutes(router);

/** Drive the route AS cp_app with `app.current_tenant` = TENANT_A — the operator's own scope. */
async function callJson(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function setPolicy(key: string, value: PolicyValue) {
  await db.update(policies).set({ value }).where(eq(policies.key, key));
}

/** A challenge + solution owned by TENANT_B, plus a board card linked to it. */
async function makeCardInTenantB(stage: 'staging' | 'production', live = false) {
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK}ch`, code: `XT-${crypto.randomUUID().slice(0, 6)}`, submitter_id: AUTHOR_ID, work_area: 'Claims', tenant_id: TENANT_B })
    .returning();
  const [sol] = await db
    .insert(solutions)
    .values({ challenge_id: ch!.id, author_id: AUTHOR_ID, title: `${MARK}sol`, status: stage === 'production' ? 'shipping' : 'voting', tenant_id: TENANT_B })
    .returning();
  const [item] = await db
    .insert(pipelineItems)
    .values({ title: `${MARK}${crypto.randomUUID().slice(0, 6)}`, stage, author_id: AUTHOR_ID, solution_id: sol!.id, live, rollout_pct: live ? 100 : 5 })
    .returning();
  // Two distinct reviewers, so the governance gate is satisfied and the only thing left to fail
  // is the cross-tenant write itself.
  await db.insert(pipelineReviews).values([
    { pipeline_item_id: item!.id, reviewer_id: ADMIN_ID },
    { pipeline_item_id: item!.id, reviewer_id: ADMIN_B_ID },
  ]).onConflictDoNothing();
  await db.update(pipelineItems).set({ reviewed: true, reviewer_count: 2, reviewed_by: ADMIN_B_ID, reviewed_at: new Date() }).where(eq(pipelineItems.id, item!.id));
  return { item: item!, solution: sol! };
}

async function solutionStatus(id: string) {
  const [r] = await db.select({ status: solutions.status }).from(solutions).where(eq(solutions.id, id));
  return r?.status;
}

async function cleanup() {
  await db.delete(pipelineItems).where(like(pipelineItems.title, `${MARK}%`));
  await db.delete(auditLog).where(inArray(auditLog.actor_id, USER_IDS));
  await db.delete(solutions).where(inArray(solutions.author_id, USER_IDS));
  await db.delete(challenges).where(inArray(challenges.submitter_id, USER_IDS));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeAll(async () => {
  await cleanup();
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Operator Org', slug: `xt-a-${TENANT_A.slice(-6)}` },
    { id: TENANT_B, name: 'Card Owner Org', slug: `xt-b-${TENANT_B.slice(-6)}` },
  ]).onConflictDoNothing({ target: tenants.id });
  await db.insert(users).values([
    { id: ADMIN_ID, email: operator.email, name: operator.name, tenant_id: TENANT_A },
    { id: ADMIN_B_ID, email: 'xt-op-b@test', name: 'Cross Op B', tenant_id: TENANT_A },
    { id: AUTHOR_ID, email: 'xt-author@test', name: 'Bee Author', tenant_id: TENANT_B },
  ]).onConflictDoNothing();
  await setPolicy('promotion.mandatory_review', true);
  await setPolicy('promotion.required_reviewers', '2');
  invalidatePolicyCache();
  install(operator);
}, 60_000);

afterAll(async () => {
  await cleanup();
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, USER_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
  __setAuthOverridesForTests(undefined);
}, 60_000);

afterEach(async () => {
  install(operator);
  await cleanup();
}, 60_000);

test('promoting another tenant\'s card actually ships that tenant\'s solution', async () => {
  const { item, solution } = await makeCardInTenantB('staging');
  expect(await solutionStatus(solution.id)).toBe('voting');

  const r = await callJson('PATCH', `/api/pipeline/${item.id}`, { stage: 'production' });
  expect(r.status).toBe(200);
  expect(r.json.live).toBe(true);

  // ⛔ THE ASSERTION THE 200 CANNOT STAND IN FOR. The card says "live"; the marketplace the
  // solution belongs to must agree.
  expect(await solutionStatus(solution.id)).toBe('shipping');
});

test('rolling another tenant\'s card back actually returns that tenant\'s solution to voting', async () => {
  const { item, solution } = await makeCardInTenantB('production', true);
  expect(await solutionStatus(solution.id)).toBe('shipping');

  const r = await callJson('POST', `/api/pipeline/${item.id}/rollback`);
  expect(r.status).toBe(200);
  expect(r.json.live).toBe(false);

  expect(await solutionStatus(solution.id)).toBe('voting');
});

test('leaving Production returns another tenant\'s solution to voting', async () => {
  const { item, solution } = await makeCardInTenantB('production', true);
  expect(await solutionStatus(solution.id)).toBe('shipping');

  const r = await callJson('PATCH', `/api/pipeline/${item.id}`, { stage: 'staging' });
  expect(r.status).toBe(200);

  expect(await solutionStatus(solution.id)).toBe('voting');
});

// Non-vacuity: the SAME route on a card in the operator's OWN tenant must keep working, so the fix
// cannot be "always bypass" nor "always refuse".
test('a card in the operator\'s own tenant still promotes', async () => {
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK}ch-own`, code: `XT-${crypto.randomUUID().slice(0, 6)}`, submitter_id: AUTHOR_ID, work_area: 'Claims', tenant_id: TENANT_A })
    .returning();
  const [sol] = await db
    .insert(solutions)
    .values({ challenge_id: ch!.id, author_id: AUTHOR_ID, title: `${MARK}sol-own`, status: 'voting', tenant_id: TENANT_A })
    .returning();
  const [item] = await db
    .insert(pipelineItems)
    .values({ title: `${MARK}${crypto.randomUUID().slice(0, 6)}`, stage: 'staging', author_id: AUTHOR_ID, solution_id: sol!.id, rollout_pct: 5 })
    .returning();
  await db.insert(pipelineReviews).values([
    { pipeline_item_id: item!.id, reviewer_id: ADMIN_ID },
    { pipeline_item_id: item!.id, reviewer_id: ADMIN_B_ID },
  ]).onConflictDoNothing();

  const r = await callJson('PATCH', `/api/pipeline/${item!.id}`, { stage: 'production' });
  expect(r.status).toBe(200);
  expect(await solutionStatus(sol!.id)).toBe('shipping');
});

// ---------------------------------------------------------------------------------------------
// THE READ HALF OF THE SAME SEAM (WS7).
//
// The write half above was fixed with `runAsSystem`. The READS were left behind, and they fail in
// the same direction for the same reason: `requireSuperAdmin` never calls `refreshTenantGuc`, so
// every request-scoped SELECT is still bound to the OPERATOR'S tenant.
//   • `enqueueWinner(solutionId)` SELECTs `solutions` on the request db → another tenant's winner
//     is invisible → returns null → the route 422s `solution_not_found` for a solution that is
//     plainly on screen. That is the winner → production path, dead.
//   • the board's solution→challenge join (`codeRows` in GET, `challengeRefFor` on the item
//     routes) reads two RLS tables → `challengeCode`/`challengeId` come back null for every
//     cross-tenant card → KanbanCard.svelte's `{#if card.featured && card.challengeCode}` never
//     renders the `★ #CH-nnn` badge.
// ---------------------------------------------------------------------------------------------

/** A challenge + solution owned by TENANT_B with NO pipeline card yet — the enqueue input. */
async function makeWinnerInTenantB() {
  const code = `XT-${crypto.randomUUID().slice(0, 6)}`;
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK}ch-win`, code, submitter_id: AUTHOR_ID, work_area: 'Claims', tenant_id: TENANT_B })
    .returning();
  const [sol] = await db
    .insert(solutions)
    .values({ challenge_id: ch!.id, author_id: AUTHOR_ID, title: `${MARK}winner`, status: 'voting', tenant_id: TENANT_B, week: '2026-W20' })
    .returning();
  return { challenge: ch!, solution: sol! };
}

test('enqueueing ANOTHER tenant\'s winner creates its card (not 422 solution_not_found)', async () => {
  const { solution } = await makeWinnerInTenantB();

  const r = await callJson('POST', '/api/pipeline/enqueue', { solutionId: solution.id });

  expect(r.status).toBe(201);
  expect(r.json.solutionId).toBe(solution.id);
  // The card must really exist on the board, not just be echoed back.
  const [card] = await db.select().from(pipelineItems).where(eq(pipelineItems.solution_id, solution.id));
  expect(card?.stage).toBe('review');
});

test('enqueue is still idempotent across tenants — a second call returns the same card', async () => {
  const { solution } = await makeWinnerInTenantB();
  const first = await callJson('POST', '/api/pipeline/enqueue', { solutionId: solution.id });
  expect(first.status).toBe(201);
  const second = await callJson('POST', '/api/pipeline/enqueue', { solutionId: solution.id });
  expect(second.status).toBe(201);
  expect(second.json.id).toBe(first.json.id);
  const cards = await db.select().from(pipelineItems).where(eq(pipelineItems.solution_id, solution.id));
  expect(cards.length).toBe(1);
});

test('a solution that genuinely does not exist still 422s', async () => {
  const r = await callJson('POST', '/api/pipeline/enqueue', { solutionId: crypto.randomUUID() });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('solution_not_found');
});

test('the board shows the challenge code badge for ANOTHER tenant\'s card', async () => {
  const { challenge, solution } = await makeWinnerInTenantB();
  const [item] = await db
    .insert(pipelineItems)
    .values({ title: `${MARK}${crypto.randomUUID().slice(0, 6)}`, stage: 'review', author_id: AUTHOR_ID, solution_id: solution.id, featured: true, position: 0 })
    .returning();

  const r = await callJson('GET', '/api/pipeline');
  expect(r.status).toBe(200);
  const card = r.json.columns
    .flatMap((c: { items: { id: string; challengeCode: string | null; challengeId: string | null }[] }) => c.items)
    .find((i: { id: string }) => i.id === item!.id);
  expect(card).toBeDefined();
  // ⛔ THE BADGE. KanbanCard.svelte renders `★ #{card.challengeCode}` only when it is non-null.
  expect(card.challengeCode).toBe(challenge.code);
  expect(card.challengeId).toBe(challenge.id);
});

test('the enqueue response itself carries the cross-tenant challenge code', async () => {
  const { challenge, solution } = await makeWinnerInTenantB();
  const r = await callJson('POST', '/api/pipeline/enqueue', { solutionId: solution.id });
  expect(r.status).toBe(201);
  expect(r.json.challengeCode).toBe(challenge.code);
  expect(r.json.challengeId).toBe(challenge.id);
});
