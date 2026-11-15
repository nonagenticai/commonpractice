// tests/superadmin-orphan-actor-fk.test.ts — a super_admin with NO local `users` row must not 500
// the routes that stamp them into a nullable FK column.
//
// ⛔ THE SHAPE. `requireSuperAdmin` runs `authenticateWithoutLicense`, which never calls
// `ensureUser`, and super_admins are granted directly in Keycloak — so `actor.id` is a Keycloak
// `sub` that frequently has no row in `users`. Several routes write that value straight into a
// column that is a FK onto `users.id`. The insert raises 23503, `route()` rethrows a non-HttpError
// and server.ts turns it into a bare 500: the route is unusable for exactly the platform's most
// privileged operators, and the failure names nothing.
//
// Every one of these columns is NULLABLE, so the honest degrade is `auditActorId` — the id when the
// row exists, NULL (a System action) when it does not, with the acting subject preserved in the
// audit `metadata`. That is the same trade routes/tenant-users.ts and routes/translations.ts make.
//
// Covered here: `signup_approvals.decided_by` (routes/onboarding.ts). The sibling instance —
// `policies.updated_by` + `policy_changes.changed_by` (routes/governance.ts) — is fixed the same
// way but is NOT exercised here: `policies` is a single global table with 18 seeded rows and no
// tenant scope, so a test that PATCHes one races every other suite (and every other session)
// sharing this database. See the handoff note.
//
// Driven AS `cp_app` (NOBYPASSRLS) so the role matches production.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError, type User } from '../src/types';
import { Router } from '../src/utils/router';
import { registerOnboardingRoutes } from '../src/routes/onboarding';
import {
  db,
  withTenantDbAsRuntimeRoleForTests,
  users,
  tenants,
  signupApprovals,
} from '../src/db/client';

const TENANT = '00000000-0000-4000-8000-00000f4c0001';
const ORPHAN_ID = '00000000-0000-4000-8000-00000f4c1001'; // Keycloak-only — NO `users` row
const MARK = 'ztest-fkorphan';

const orphanOperator: User = {
  id: ORPHAN_ID, email: 'fk-orphan@test', name: 'FK Orphan', roles: ['super_admin'], tenantId: TENANT,
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
registerOnboardingRoutes(router);

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
    res = await withTenantDbAsRuntimeRoleForTests(TENANT, () =>
      matched.handler(req, ...matched.params),
    );
  } catch (err) {
    // server.ts:385 turns a non-HttpError into a bare 500 — mirror it.
    return { status: 500, json: { error: 'Internal Server Error', thrown: String(err).slice(0, 300) } };
  }
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  await db.delete(signupApprovals).where(eq(signupApprovals.name, MARK));
}

beforeAll(async () => {
  await cleanup();
  await db
    .insert(tenants)
    .values([{ id: TENANT, name: 'FK Orphan Org', slug: `fkorphan-${TENANT.slice(-6)}` }])
    .onConflictDoNothing({ target: tenants.id });
  // ⛔ NON-VACUITY: the operator must genuinely have no seat, or this whole file is decor.
  const seat = await db.select({ id: users.id }).from(users).where(eq(users.id, ORPHAN_ID));
  expect(seat.length).toBe(0);
  install(orphanOperator);
}, 60_000);

afterAll(async () => {
  await cleanup();
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
  __setAuthOverridesForTests(undefined);
}, 60_000);

test('rejecting a signup does not 500 for a super_admin with no users row', async () => {
  const [approval] = await db
    .insert(signupApprovals)
    .values({
      email: `fk-orphan-${crypto.randomUUID().slice(0, 8)}@ztest.invalid`,
      name: MARK,
      status: 'pending',
    })
    .returning();

  const r = await callJson('POST', `/api/signup-approvals/${approval!.id}/reject`);

  // `signup_approvals.decided_by` is a FK onto `users.id`; the orphan sub raised 23503 out of the
  // route and server.ts turned it into a bare 500.
  expect(r.status).not.toBe(500);
  expect(r.status).toBe(200);
  expect(r.json.approval.status).toBe('rejected');
  // The decision is RECORDED (a rejected approval that still reads `pending` would be the same
  // lie), with the actor degraded to System because there is no row to point at.
  const [row] = await db
    .select()
    .from(signupApprovals)
    .where(eq(signupApprovals.id, approval!.id));
  expect(row!.status).toBe('rejected');
  expect(row!.decided_at).not.toBeNull();
  expect(row!.decided_by).toBeNull();
});
