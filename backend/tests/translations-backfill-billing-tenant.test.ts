// tests/translations-backfill-billing-tenant.test.ts — WHO PAYS for a translation queued by the
// admin backfill, and what the route is allowed to CLAIM when nobody can.
//
// ⛔ THE MECHANISM. `translation_jobs` HAS NO `tenant_id`. The tenant that gets METERED for a job's
// LLM spend is derived downstream, in `processPendingBatch`, as `tenantOf(job.requested_by)` —
// `users.tenant_id` of the REQUESTER (host/translation-service.ts). `/run` then bills that tenant
// through `withTenantTx` → `usage_counters`. So `requested_by` is not audit decoration on this
// table: it IS the billing key.
//
// That makes `POST /api/admin/translations/queue` a billing surface. If the backfill's SELECTs can
// see content outside the operator's own tenant while its INSERT stamps the OPERATOR as
// `requested_by`, then tenant B's content is queued and tenant A is charged for translating it —
// exactly the harm `/run`'s own comment refuses ("Wrapping it would bill the platform for every
// tenant's translations"), one function upstream.
//
// Two further teeth on the same seam, both asserted below:
//   · `enqueueTranslations`' `onConflictDoUpdate` sets `requested_by = excluded.requested_by`, and
//     the route accepts `force: true` which DROPS the `setWhere` guard. A platform-wide backfill
//     therefore RE-STAMPS cells a tenant's own user legitimately queued (challenges.ts,
//     solutions.ts, authoring-service.ts) and moves the bill onto the operator.
//   · An operator with no local `users` row degrades `requested_by` to NULL. NULL is not
//     "unattributed but fine" — `processPendingBatch` fails EVERY such job with `no metering
//     actor`. A 200 `{queued: N}` for jobs that provably cannot drain is a success response for
//     work that will never happen.
//
// Driven AS `cp_app` (NOBYPASSRLS) via `withTenantDbAsRuntimeRoleForTests`, because production's
// runtime role is `cp_app`; as the table OWNER every RLS assertion here is vacuous.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError, type User } from '../src/types';
import { Router } from '../src/utils/router';
import { registerTranslationRoutes } from '../src/routes/translations';
import {
  enqueueTranslations,
  processPendingBatch,
  tenantOf,
} from '../src/host/translation-service';
import {
  db,
  withTenantDbAsRuntimeRoleForTests,
  users,
  tenants,
  challenges,
  translationJobs,
} from '../src/db/client';

const TENANT_A = '00000000-0000-4000-8000-00000ba50001'; // the OPERATOR's own workspace
const TENANT_B = '00000000-0000-4000-8000-00000ba50002'; // where the CONTENT actually lives
const ADMIN_ID = '00000000-0000-4000-8000-00000ba51001'; // seated super_admin, homed in TENANT_A
const ORPHAN_ID = '00000000-0000-4000-8000-00000ba51002'; // Keycloak-only — NO `users` row
const AUTHOR_B_ID = '00000000-0000-4000-8000-00000ba51003'; // a TENANT_B person
const USER_IDS = [ADMIN_ID, AUTHOR_B_ID];
const MARK = 'ZTEST-BILL ';

const seatedOperator: User = {
  id: ADMIN_ID, email: 'bill-op@test', name: 'Bill Op', roles: ['super_admin'], tenantId: TENANT_A,
};
const orphanOperator: User = {
  id: ORPHAN_ID, email: 'bill-orphan@test', name: 'Bill Orphan', roles: ['super_admin'], tenantId: TENANT_A,
};

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

/** Drive the route AS `cp_app` with `app.current_tenant` = TENANT_A, mirroring server.ts:356. */
async function callJson(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let res: Response;
  try {
    res = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () =>
      matched.handler(req, ...matched.params),
    );
  } catch (err) {
    // server.ts:385 turns a non-HttpError into a bare 500 — mirror it so the status matches.
    return { status: 500, json: { error: 'Internal Server Error', thrown: String(err).slice(0, 200) } };
  }
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function makeChallengeIn(tenantId: string, submitter: string) {
  const [ch] = await db
    .insert(challenges)
    .values({
      title: `${MARK}title`,
      description: `${MARK}description`,
      code: `BILL-${crypto.randomUUID().slice(0, 6)}`,
      submitter_id: submitter,
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
  const rows = await db
    .select({ id: challenges.id })
    .from(challenges)
    .where(like(challenges.title, `${MARK}%`));
  if (rows.length) {
    await db.delete(translationJobs).where(
      inArray(translationJobs.entity_id, rows.map((r) => r.id)),
    );
  }
  await db.delete(challenges).where(like(challenges.title, `${MARK}%`));
}

beforeAll(async () => {
  await cleanup();
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db
    .insert(tenants)
    .values([
      { id: TENANT_A, name: 'Bill Operator Org', slug: `bill-a-${TENANT_A.slice(-6)}` },
      { id: TENANT_B, name: 'Bill Content Org', slug: `bill-b-${TENANT_B.slice(-6)}` },
    ])
    .onConflictDoNothing({ target: tenants.id });
  await db
    .insert(users)
    .values([
      { id: ADMIN_ID, email: seatedOperator.email, name: seatedOperator.name, tenant_id: TENANT_A },
      { id: AUTHOR_B_ID, email: 'bill-author-b@test', name: 'Bill Author B', tenant_id: TENANT_B },
    ])
    .onConflictDoNothing();
  // ⛔ NON-VACUITY on the two facts every assertion below rests on.
  expect(await tenantOf(ADMIN_ID)).toBe(TENANT_A);
  expect(await tenantOf(AUTHOR_B_ID)).toBe(TENANT_B);
  const seat = await db.select({ id: users.id }).from(users).where(eq(users.id, ORPHAN_ID));
  expect(seat.length).toBe(0);
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

test('the backfill never queues a job that meters a tenant which does not own the content', async () => {
  const ch = await makeChallengeIn(TENANT_B, AUTHOR_B_ID);

  const r = await callJson('POST', '/api/admin/translations/queue', {
    entityType: 'challenge',
    entityId: ch.id,
  });

  const jobs = await jobsFor(ch.id);
  const metered = await Promise.all(jobs.map((j) => tenantOf(j.requested_by)));
  console.log(
    `[MEASURED] content tenant = ${ch.tenant_id}  metered tenant(s) = ` +
      `${[...new Set(metered)].join(',') || '<none: 0 jobs>'}  MATCH=` +
      `${metered.every((t) => t === ch.tenant_id)}  route=${r.status} queued=${r.json?.queued ?? '-'}`,
  );

  // ⛔ THE ASSERTION. Every job that exists for TENANT_B's challenge must bill TENANT_B. A job that
  // bills the operator's TENANT_A is a cross-tenant billing mixer.
  for (const t of metered) expect(t).toBe(TENANT_B);

  // ⛔ NON-VACUITY: the same route, same operator, same call shape against content the operator CAN
  // see must still queue — otherwise the loop above is green because the route is simply broken.
  const own = await makeChallengeIn(TENANT_A, ADMIN_ID);
  const r2 = await callJson('POST', '/api/admin/translations/queue', {
    entityType: 'challenge',
    entityId: own.id,
  });
  expect(r2.status).toBe(200);
  expect(r2.json.queued).toBeGreaterThan(0);
  const ownJobs = await jobsFor(own.id);
  expect(ownJobs.length).toBeGreaterThan(0);
  const ownMetered = await Promise.all(ownJobs.map((j) => tenantOf(j.requested_by)));
  console.log(
    `[MEASURED control] content tenant = ${own.tenant_id}  metered tenant(s) = ` +
      `${[...new Set(ownMetered)].join(',')}  MATCH=` +
      `${ownMetered.every((t) => t === own.tenant_id)}  route=${r2.status} queued=${r2.json.queued}`,
  );
  for (const t of ownMetered) expect(t).toBe(TENANT_A);
});

test('a force backfill does not RE-STAMP a job another tenant\'s user queued (moving their bill onto the operator)', async () => {
  const ch = await makeChallengeIn(TENANT_B, AUTHOR_B_ID);
  // The legitimate enqueue a TENANT_B user's own content edit performs (challenges.ts:533).
  const n = await enqueueTranslations(
    'challenge',
    ch.id,
    [{ field: 'title', value: ch.title }],
    AUTHOR_B_ID,
  );
  expect(n).toBeGreaterThan(0);
  const before = await jobsFor(ch.id);
  expect(before.every((j) => j.requested_by === AUTHOR_B_ID)).toBe(true);

  // `force: true` drops enqueueTranslations' `setWhere` guard, so EVERY matched cell is rewritten.
  await callJson('POST', '/api/admin/translations/queue', {
    entityType: 'challenge',
    entityId: ch.id,
    force: true,
  });

  const after = await jobsFor(ch.id);
  for (const j of after) {
    expect(j.requested_by).toBe(AUTHOR_B_ID);
    expect(await tenantOf(j.requested_by)).toBe(TENANT_B);
  }
});

test('a job with a NULL requested_by cannot drain — NULL is not "unattributed but fine"', async () => {
  const ch = await makeChallengeIn(TENANT_A, ADMIN_ID);
  await db.insert(translationJobs).values({
    entity_type: 'challenge',
    entity_id: ch.id,
    field: 'title',
    target_locale: 'nl',
    source_text: `${MARK}source`,
    source_hash: 'deadbeef',
    status: 'pending',
    attempts: 0,
    requested_by: null,
  });
  // Make it the globally-oldest pending row so `limit: 1` (order by created_at asc) picks EXACTLY
  // this job and the drain touches no other session's data.
  await db
    .update(translationJobs)
    .set({ created_at: sql`timestamptz '2000-01-01T00:00:00Z'` })
    .where(and(eq(translationJobs.entity_id, ch.id), isNull(translationJobs.requested_by)));

  const out = await processPendingBatch(new Date(), db, 1, async () => {
    throw new Error('the translator must never be reached for a job with no metering actor');
  });

  expect(out.processed).toBe(0);
  expect(out.failed).toBe(1);
  const [j] = await jobsFor(ch.id);
  expect(j!.error).toBe('no metering actor');
  expect(j!.attempts).toBe(1);
});

test('an operator with no users row is REFUSED — the route never reports queued work that cannot drain', async () => {
  const ch = await makeChallengeIn(TENANT_A, ADMIN_ID);
  install(orphanOperator);

  const r = await callJson('POST', '/api/admin/translations/queue', {
    entityType: 'challenge',
    entityId: ch.id,
  });

  // The old bare 500 (an unguarded 23503 out of the route) is NOT acceptable either.
  expect(r.status).not.toBe(500);
  // ⛔ …and neither is a 200 with a `queued` count. `requested_by` would be NULL, and the previous
  // test proves every such job fails the drain with `no metering actor`. A success response for
  // undrainable work is the same lie in the other direction.
  expect(r.status).not.toBe(200);
  expect(r.json?.code ?? r.json?.error).toBe('no_metering_actor');

  // Nothing undrainable was left behind.
  const orphanJobs = await db
    .select()
    .from(translationJobs)
    .where(and(eq(translationJobs.entity_id, ch.id), isNull(translationJobs.requested_by)));
  expect(orphanJobs.length).toBe(0);
});
