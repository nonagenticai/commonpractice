// tests/translations-cross-tenant-backfill.test.ts — what `POST /api/admin/translations/queue` is
// allowed to CLAIM about a backfill it can only partly see.
//
// ⛔ RETRACTION. The first version of this file asserted the opposite contract — that the backfill
// "queues ANOTHER tenant's content" — and it was wrong, not merely incomplete. The `runAsSystem`
// wrap that made it pass turned this route into a cross-tenant BILLING mixer:
// `translation_jobs` has no `tenant_id`, so the metered tenant is `tenantOf(job.requested_by)`
// (host/translation-service.ts) and `/run` charges it via `withTenantTx` -> `usage_counters`.
// A platform-wide read with one `requestedBy` queues tenant B's rows and bills tenant A.
// Measured: content tenant …ba50002, metered tenant …ba50001.
// The full billing contract now lives in tests/translations-backfill-billing-tenant.test.ts.
// That file also retracts this one's other wrong claim — that a NULL `requested_by` leaves jobs
// "unattributed rather than absent". NULL is UNDRAINABLE: `processPendingBatch` fails every such
// job with `no metering actor`, so a 200 `{queued: N}` was a success response for work that could
// never happen.
//
// What is left here is the honesty half, which the wrap was a wrong answer TO: the route may not
// answer a green `{queued: 0}` for an entity it simply cannot see. `backfillTranslations` now
// reports `matched` alongside `queued` so the route can tell "already up to date" apart from "not
// in your workspace", and returns 404 for the second.
//
// ⛔ WHY THIS SURVIVED BEFORE: seed-datasets.ts:313 gives the AUTH_BYPASS id a `users` row, and
// every other translation test puts its fixtures in the ONE demo tenant — operator-tenant ==
// content-tenant on both axes. This file crosses them, AS `cp_app` (NOBYPASSRLS).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError, type User } from '../src/types';
import { Router } from '../src/utils/router';
import { registerTranslationRoutes } from '../src/routes/translations';
import {
  db,
  withTenantDbAsRuntimeRoleForTests,
  users,
  tenants,
  challenges,
  translationJobs,
} from '../src/db/client';

const TENANT_A = '00000000-0000-0000-0000-00000c7c0001'; // the operator's own claim
const TENANT_B = '00000000-0000-0000-0000-00000c7c0002'; // where the content actually lives
const ADMIN_ID = '00000000-0000-0000-0000-00000c7c1001'; // has a `users` row
const AUTHOR_ID = '00000000-0000-0000-0000-00000c7c1003';
const USER_IDS = [ADMIN_ID, AUTHOR_ID];
const MARK = 'ZTEST-TRX ';

const seatedOperator: User = { id: ADMIN_ID, email: 'trx-op@test', name: 'Trx Op', roles: ['super_admin'], tenantId: TENANT_A };

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
registerTranslationRoutes(router);

/** Drive the route AS `cp_app` (NOBYPASSRLS) with `app.current_tenant` = TENANT_A. */
async function callJson(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // `route()` rethrows anything that is not an HttpError/ZodError/UnauthorizedError and
  // server.ts:385 turns that into a bare 500 — mirror it so the status matches a browser's.
  let res: Response;
  try {
    res = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () => matched.handler(req, ...matched.params));
  } catch (err) {
    return { status: 500, json: { error: 'Internal Server Error', thrown: String(err).slice(0, 200) } };
  }
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function makeChallengeIn(tenantId: string) {
  const [ch] = await db
    .insert(challenges)
    .values({
      title: `${MARK}title`,
      description: `${MARK}description`,
      code: `TRX-${crypto.randomUUID().slice(0, 6)}`,
      submitter_id: AUTHOR_ID,
      work_area: 'Claims',
      tenant_id: tenantId,
    })
    .returning();
  return ch!;
}

async function jobsFor(entityId: string) {
  return db.select().from(translationJobs).where(eq(translationJobs.entity_id, entityId));
}

async function cleanup() {
  const rows = await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`));
  if (rows.length) {
    await db.delete(translationJobs).where(inArray(translationJobs.entity_id, rows.map((r) => r.id)));
  }
  await db.delete(challenges).where(like(challenges.title, `${MARK}%`));
}

beforeAll(async () => {
  await cleanup();
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Trx Operator Org', slug: `trx-a-${TENANT_A.slice(-6)}` },
    { id: TENANT_B, name: 'Trx Content Org', slug: `trx-b-${TENANT_B.slice(-6)}` },
  ]).onConflictDoNothing({ target: tenants.id });
  await db.insert(users).values([
    { id: ADMIN_ID, email: seatedOperator.email, name: seatedOperator.name, tenant_id: TENANT_A },
    { id: AUTHOR_ID, email: 'trx-author@test', name: 'Trx Author', tenant_id: TENANT_B },
  ]).onConflictDoNothing();
  install(seatedOperator);
}, 60_000);

afterAll(async () => {
  await cleanup();
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, USER_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
  __setAuthOverridesForTests(undefined);
}, 60_000);

afterEach(async () => {
  install(seatedOperator);
  await cleanup();
}, 60_000);

test('an entity the operator cannot see is a 404, NOT a green {queued: 0}', async () => {
  const ch = await makeChallengeIn(TENANT_B);

  const r = await callJson('POST', '/api/admin/translations/queue', {
    entityType: 'challenge',
    entityId: ch.id,
  });

  // ⛔ THE ASSERTION THE OLD `queued: 0` STOOD IN FOR. `{queued: 0}` with a 200 renders in the
  // admin panel as a successful no-op — the operator is told the entity needs no translation when
  // in fact it was never looked at. `matched === 0` on an explicit id is a miss, and says so.
  expect(r.status).toBe(404);
  expect(r.json.code ?? r.json.error).toBe('translation_entity_not_visible');
  expect((await jobsFor(ch.id)).length).toBe(0);
});

test('a challenge in the operator\'s OWN tenant is queued, and `matched` counts it', async () => {
  const ch = await makeChallengeIn(TENANT_A);
  const r = await callJson('POST', '/api/admin/translations/queue', {
    entityType: 'challenge',
    entityId: ch.id,
  });
  expect(r.status).toBe(200);
  expect(r.json.queued).toBeGreaterThan(0);
  expect(r.json.matched).toBe(1);
  expect((await jobsFor(ch.id)).length).toBe(r.json.queued);
});

test('a SECOND run over an unchanged entity is `matched: 1, queued: 0` — a real no-op, not a miss', async () => {
  const ch = await makeChallengeIn(TENANT_A);
  const first = await callJson('POST', '/api/admin/translations/queue', {
    entityType: 'challenge',
    entityId: ch.id,
  });
  expect(first.json.queued).toBeGreaterThan(0);

  const second = await callJson('POST', '/api/admin/translations/queue', {
    entityType: 'challenge',
    entityId: ch.id,
  });

  // ⛔ NON-VACUITY FOR THE 404 ABOVE: `queued: 0` MUST still be reachable with a 200, or the new
  // rule would just be "0 is always an error" and the `setWhere` no-op would start 404ing.
  expect(second.status).toBe(200);
  expect(second.json.queued).toBe(0);
  expect(second.json.matched).toBe(1);
});
