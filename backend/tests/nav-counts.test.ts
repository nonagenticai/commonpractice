// tests/nav-counts.test.ts — a sidebar badge must be counted in the scope of the page it opens.
//
// TWO DECISIONS ARE PINNED HERE, and they point in OPPOSITE directions. That is the whole reason
// this file exists: "make the badges consistent" is not the property. "Make each badge agree with
// its own destination" is.
//
//  1. `sandboxes` WAS WRONG. `/api/me` counted it under RLS (the caller's tenant) while
//     `GET /api/sandboxes` is `requireSuperAdmin` + `runAsSystem` — cross-tenant. Prod served
//     `sandboxes: 7` to a caller whose page listed more. It is now counted under `runAsSystem`,
//     and ONLY for a super_admin: everyone else gets NO KEY AT ALL, because a fleet-wide total in
//     every member's `/api/me` leaks platform volume to people the nav item already hides it from.
//
//  2. ⛔ `challenges` WAS ALREADY RIGHT — DO NOT "FIX" IT. `GET /api/challenges` applies no default
//     status filter, so the unfiltered RLS-scoped `count(*)` matches its destination's own `total`
//     exactly. Aligning it to home's `ne(status,'closed')` would INTRODUCE the very lie the
//     sandboxes half is removing. The test below compares the badge against the list route's own
//     `total`, with a CLOSED challenge in the fixture, so that "improvement" fails loudly.
//
// ⚠️ NO GLOBAL TABLE COUNTS. Every test file writes to ONE shared database (sequentially — ⚠️
// corrected 2026-08-16, they are NOT run concurrently; canonical note at the top of
// tests/metering-platform-calls.test.ts), so a fleet-wide absolute depends on which files ran
// before this one and on whatever any of them left behind or leaked past its own end. Everything here is scoped to two tenants this file owns:
// the tenant-scoped numbers are EXACT, and the cross-tenant one is a lower bound that only the
// broken (RLS-scoped) implementation can fall below.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerMeRoutes } from '../src/routes/me';
import { registerChallengeRoutes } from '../src/routes/challenges';
import {
  db,
  users,
  tenants,
  challenges,
  sandboxes,
  solutions,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts).
const TENANT_HOME = '00000000-0000-4000-8000-00000c3b0001';
const TENANT_OTHER = '00000000-0000-4000-8000-00000c3b0002';
const UID_SUPER = '00000000-0000-4000-8000-00000c3b0011';
const UID_MEMBER = '00000000-0000-4000-8000-00000c3b0012';
const UID_OTHER = '00000000-0000-4000-8000-00000c3b0013';
const SLUG_PREFIX = 'zws3-nav-';

/** Sandboxes this file plants in the caller's OWN tenant. */
const HOME_SANDBOXES = 2;
/** Sandboxes this file plants in a DIFFERENT tenant — invisible under RLS, visible to the fleet. */
const OTHER_SANDBOXES = 3;

/** Solutions this file plants in the caller's OWN tenant — pins `counts.solutions` to an exact
 *  value, the way `challenges` is pinned to `.toBe(3)`. */
const HOME_SOLUTIONS = 2;
/** A solution planted in a DIFFERENT tenant — must stay invisible under RLS. Its presence is what
 *  makes the `HOME_SOLUTIONS` pin non-vacuous: `solutions` is counted under caller RLS (unlike
 *  `sandboxes`, which is deliberately cross-tenant for a super_admin), so if `navCounts` ever
 *  dropped the tenant scoping on the `solutions` query (e.g. ran it through `runAsSystem` the way
 *  `sandboxes` legitimately does), this row would leak into the count and the `.toBe(HOME_SOLUTIONS)`
 *  assertion below would fail loudly instead of silently staying green. */
const OTHER_SOLUTIONS = 1;

const superAdmin: User = {
  id: UID_SUPER,
  email: 'ws3nav-super@test',
  name: 'Zws3 Nav Super',
  roles: ['super_admin', 'tenant_admin'],
  tenantId: TENANT_HOME,
};
const member: User = {
  id: UID_MEMBER,
  email: 'ws3nav-member@test',
  name: 'Zws3 Nav Member',
  roles: ['member'],
  tenantId: TENANT_HOME,
};

const router = new Router();
registerMeRoutes(router);
registerChallengeRoutes(router);

async function call(as: User, path: string) {
  __setAuthOverridesForTests({ validateAuth: async () => as, requireRole: async () => as });
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const req = new Request(`http://localhost${path}`);
  const res = await withTenantDbAsRuntimeRoleForTests(TENANT_HOME, () =>
    matched.handler(req, ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  await db.delete(solutions).where(inArray(solutions.tenant_id, [TENANT_HOME, TENANT_OTHER]));
  await db.delete(sandboxes).where(inArray(sandboxes.owner_id, [UID_SUPER, UID_OTHER]));
  await db.delete(challenges).where(inArray(challenges.tenant_id, [TENANT_HOME, TENANT_OTHER]));
  await db.delete(users).where(inArray(users.id, [UID_SUPER, UID_MEMBER, UID_OTHER]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_HOME, TENANT_OTHER]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT_HOME, name: 'Zws3 Nav Home', slug: 'zws3-nav-home' },
    { id: TENANT_OTHER, name: 'Zws3 Nav Other', slug: 'zws3-nav-other' },
  ]);
  await db.insert(users).values([
    { id: UID_SUPER, tenant_id: TENANT_HOME, email: superAdmin.email, name: superAdmin.name },
    { id: UID_MEMBER, tenant_id: TENANT_HOME, email: member.email, name: member.name },
    { id: UID_OTHER, tenant_id: TENANT_OTHER, email: 'ws3nav-other@test', name: 'Zws3 Nav Other' },
  ]);

  let n = 0;
  for (let i = 0; i < HOME_SANDBOXES; i++) {
    await db.insert(sandboxes).values({
      owner_id: UID_SUPER,
      tenant_id: TENANT_HOME,
      slug: `${SLUG_PREFIX}${n++}`,
      status: 'running',
      last_active_at: new Date(),
    });
  }
  for (let i = 0; i < OTHER_SANDBOXES; i++) {
    await db.insert(sandboxes).values({
      owner_id: UID_OTHER,
      tenant_id: TENANT_OTHER,
      slug: `${SLUG_PREFIX}${n++}`,
      status: 'running',
      last_active_at: new Date(),
    });
  }

  // Three challenges in the caller's tenant, ONE OF THEM CLOSED — the discriminator for decision 2.
  // `.returning()` so the solutions fixtures below have a real `challenge_id` to hang off (the FK
  // is NOT NULL) without inflating this count — `homeChallenges` stays at 3 either way.
  const homeChallenges = await db
    .insert(challenges)
    .values([
      { title: 'Zws3 nav open A', work_area: 'Claims', submitter_id: UID_SUPER, tenant_id: TENANT_HOME, status: 'voting' },
      { title: 'Zws3 nav open B', work_area: 'Claims', submitter_id: UID_SUPER, tenant_id: TENANT_HOME, status: 'solution_phase' },
      { title: 'Zws3 nav closed C', work_area: 'Claims', submitter_id: UID_SUPER, tenant_id: TENANT_HOME, status: 'closed' },
    ])
    .returning();

  // A parent challenge in the OTHER tenant, purely so OTHER_SOLUTIONS below has a valid FK target.
  // tenant_id: TENANT_OTHER keeps it invisible to every RLS-scoped `challenges` assertion in this
  // file (`call()` always scopes to TENANT_HOME), so it cannot perturb the `.toBe(3)` pins.
  const [otherChallenge] = await db
    .insert(challenges)
    .values({ title: 'Zws3 nav other X', work_area: 'Claims', submitter_id: UID_OTHER, tenant_id: TENANT_OTHER, status: 'voting' })
    .returning();

  // HOME_SOLUTIONS in the caller's own tenant (pins `counts.solutions`); OTHER_SOLUTIONS in the
  // other tenant (the cross-tenant-leak discriminator — see its declaration above).
  for (let i = 0; i < HOME_SOLUTIONS; i++) {
    await db.insert(solutions).values({
      challenge_id: homeChallenges[0]!.id,
      title: `${SLUG_PREFIX}solution-home-${i}`,
      author_id: UID_SUPER,
      tenant_id: TENANT_HOME,
    });
  }
  for (let i = 0; i < OTHER_SOLUTIONS; i++) {
    await db.insert(solutions).values({
      challenge_id: otherChallenge!.id,
      title: `${SLUG_PREFIX}solution-other-${i}`,
      author_id: UID_OTHER,
      tenant_id: TENANT_OTHER,
    });
  }
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('the sandboxes badge counts the FLEET for a super_admin, not just their own tenant', async () => {
  const res = await call(superAdmin, '/api/me');
  expect(res.status).toBe(200);

  // Under RLS the caller can see only their own tenant's HOME_SANDBOXES. Anything at or below that
  // means the count is still tenant-scoped — which is exactly what dropping `runAsSystem` does.
  expect(res.json.counts.sandboxes).toBeGreaterThanOrEqual(HOME_SANDBOXES + OTHER_SANDBOXES);
  expect(res.json.counts.sandboxes).toBeGreaterThan(HOME_SANDBOXES);

  // Sanity: the tenant-scoped view really is the smaller number, or the bound above is meaningless.
  const visibleUnderRls = await withTenantDbAsRuntimeRoleForTests(TENANT_HOME, () =>
    db.select({ id: sandboxes.id }).from(sandboxes),
  );
  expect(visibleUnderRls).toHaveLength(HOME_SANDBOXES);
});

test('the sandboxes key is ABSENT for a caller who cannot open /sandboxes', async () => {
  const res = await call(member, '/api/me');
  expect(res.status).toBe(200);
  // Not 0 — absent. A fleet-wide total is platform-volume information, and the nav item is
  // super_admin-gated, so there is nothing for a member's browser to do with it.
  expect(Object.keys(res.json.counts)).not.toContain('sandboxes');
  expect(res.json.counts.sandboxes).toBeUndefined();
  // The two tenant-scoped badges are still served to everyone.
  expect(res.json.counts.challenges).toBe(3);
  // ⛔ EXACT, NOT `.toBeGreaterThanOrEqual(0)` — that was vacuous against every value, including a
  // cross-tenant total. Kills the mutant that drops the tenant filter on the `solutions` count in
  // navCounts (e.g. routes it through `runAsSystem` the way `sandboxes` legitimately is): with
  // OTHER_SOLUTIONS actually seeded in TENANT_OTHER, a leaked query reads
  // HOME_SOLUTIONS + OTHER_SOLUTIONS = 3, not 2, and this assertion catches it. Same bug class the
  // sandboxes test above documents for `runAsSystem`/RLS — here the correct behaviour is the
  // opposite direction (stay RLS-scoped, never go cross-tenant).
  expect(res.json.counts.solutions).toBe(HOME_SOLUTIONS);
});

test('⛔ the challenges badge equals GET /api/challenges own total — including CLOSED rows', async () => {
  const me = await call(superAdmin, '/api/me');
  const list = await call(superAdmin, '/api/challenges');
  expect(list.status).toBe(200);

  // Both are RLS-scoped to a tenant this file owns, so both numbers are exact, not approximate.
  expect(list.json.total).toBe(3);
  expect(me.json.counts.challenges).toBe(list.json.total);

  // And the closed one is genuinely in the destination's own list — so a navCounts that filtered
  // `ne(status,'closed')` (2) would disagree with the page it opens (3).
  const statuses = (list.json.items as { status: string }[]).map((r) => r.status).sort();
  expect(statuses).toEqual(['closed', 'solution_phase', 'voting']);
});
