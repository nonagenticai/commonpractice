// tests/invite-cross-tenant-cascade.test.ts — P0 regression: an invite must never destroy ANOTHER
// tenant's data.
//
// The old invite path cleared a "ghost" `users` row (no Keycloak identity behind it) so a stranded
// address could be invited again, guarded by a dependants count that ran on the INVITING tenant's
// RLS-scoped connection — so another tenant's dependants were invisible, the guard passed, and the
// ON DELETE CASCADE FKs took that tenant's spend ledger, notifications and chats with the row.
//
// Invites (services/invite-service.ts) no longer delete `users` rows at all: a live row in another
// workspace is refused `email_in_other_tenant`, a live row here `already_member`, and a homeless row
// is simply invitable and left in place. This file pins that, as `cp_app`.
//
// ⛔ THIS FILE ONLY PROVES ANYTHING WHEN IT RUNS AS `cp_app`. The default test DSN is the table
// OWNER, which BYPASSES RLS. `withTenantDbAsRuntimeRoleForTests` makes the request connection behave
// like production (SET ROLE cp_app + the tenant GUC); see rls-isolation.test.ts.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  auditLog,
  usageEvents,
  notifications,
  chatSessions,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { tenantInvites } from '../src/db/schema';
import { Router } from '../src/utils/router';
import { registerOnboardingRoutes } from '../src/routes/onboarding';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  __setKeycloakAdminForTests,
  type KeycloakAdminClient,
} from '../src/services/keycloak-admin';
import { findUserDependants } from '../src/services/provisioning';
import type { User } from '../src/types';

// RFC-4122-valid v4 uuids (3rd group '4xxx', 4th '8xxx') — zod's .uuid() rejects anything else in
// the request body, and prod tenant ids are gen_random_uuid() too.
const TENANT_A = '00000000-0000-4000-8000-00000c1a0001'; // the VICTIM's tenant
const TENANT_B = '00000000-0000-4000-8000-00000c1a0002'; // the INVITING tenant
const VICTIM = '00000000-0000-4000-8000-00000c1a0a01';
const SADMIN_ID = '00000000-0000-4000-8000-00000c1a0a02';
const NEW_SUB = '00000000-0000-4000-8000-00000c1a0a03';
const AUDIT_GHOST = '00000000-0000-4000-8000-00000c1a0a04';
const CLEAN_GHOST = '00000000-0000-4000-8000-00000c1a0a05';
const SEEDED_SUBS = [VICTIM, SADMIN_ID, NEW_SUB, AUDIT_GHOST, CLEAN_GHOST];

const VICTIM_EMAIL = 'victim@xtenant.test';
const AUDIT_GHOST_EMAIL = 'auditor@xtenant.test';
const CLEAN_GHOST_EMAIL = 'debris@xtenant.test';

// The super_admin doing the inviting. Its claim tenant is B — note that `requireSuperAdmin` does NOT
// call `refreshTenantGuc`, so the request connection keeps whatever tenant the claim carried, which
// is exactly the situation the bug needed.
const superAdmin: User = {
  id: SADMIN_ID,
  email: 'sa-xt@t',
  name: 'SA',
  roles: ['super_admin'],
  tenantId: TENANT_B,
};

const deletedSubs: string[] = [];

/** Keycloak knows nothing about any of these addresses → an invite mints a new identity. */
function makeKc(): KeycloakAdminClient {
  return {
    async createRealmUser() {
      return NEW_SUB;
    },
    async logoutUser() {},
    async executeActionsEmail() {},
    async deleteRealmUser(userId) {
      deletedSubs.push(userId);
    },
    async listRealmUsers() {
      return [];
    },
    async findRealmUserByUsernameOrEmail() {
      return null; // the whole premise: no identity stands behind the local row
    },
    async backfillUserEmail() {},
    async getRealmRolesForUsers(userIds) {
      return new Map(userIds.map((u) => [u, [] as string[]]));
    },
    async createIdentityProvider() {},
    async getIdentityProvider() {
      return null;
    },
    async updateIdentityProvider() {},
    async deleteIdentityProvider() {},
    async createIdpMapper() {},
    async listIdpMappers() {
      return [];
    },
    async deleteIdpMapper() {},
  };
}

const router = new Router();
registerOnboardingRoutes(router);

/** Drive the LIVE route, on a request connection that behaves like production: role `cp_app`,
 *  `app.current_tenant` = the inviting tenant. */
async function invite(email: string, tenantId: string): Promise<Response> {
  return withTenantDbAsRuntimeRoleForTests(tenantId, async () => {
    const m = router.match('POST', '/api/invites');
    if (!m) throw new Error('no route for POST /api/invites');
    return m.handler(
      new Request('http://t/api/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, tenantId }),
      }),
      ...m.params,
    );
  });
}

async function cleanup() {
  // Setup + teardown run OUTSIDE any tenant context, i.e. as the owner — so they see every tenant.
  await db.delete(auditLog).where(inArray(auditLog.actor_id, SEEDED_SUBS));
  await db.delete(chatSessions).where(inArray(chatSessions.user_id, SEEDED_SUBS));
  await db.delete(notifications).where(inArray(notifications.user_id, SEEDED_SUBS));
  await db.delete(usageEvents).where(inArray(usageEvents.user_id, SEEDED_SUBS));
  await db.delete(tenantInvites).where(inArray(tenantInvites.tenant_id, [TENANT_A, TENANT_B]));
  await db.delete(users).where(inArray(users.id, SEEDED_SUBS));
  await db.delete(users).where(sql`lower(email) LIKE '%@xtenant.test'`);
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS, so a slow one fails as
// "(unnamed) [5003ms]" with no file or cause (see license-provisioning.test.ts).
beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => superAdmin });
  __setKeycloakAdminForTests(makeKc());
  deletedSubs.length = 0;
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Victim Tenant', slug: 'xt-victim' },
    { id: TENANT_B, name: 'Inviting Tenant', slug: 'xt-inviter' },
  ]);
  await db
    .insert(users)
    .values({ id: SADMIN_ID, email: superAdmin.email, name: 'SA', tenant_id: TENANT_B });
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  await cleanup();
}, 30_000);

test('invite: a ghost row whose CASCADE dependants live in ANOTHER tenant is never cleared', async () => {
  // Tenant A's member: metering, a notification and a chat session — all RLS-scoped to A, all
  // ON DELETE CASCADE from users.id, none of them visible from tenant B's connection.
  await db
    .insert(users)
    .values({ id: VICTIM, email: VICTIM_EMAIL, name: 'Victim', tenant_id: TENANT_A });
  await db.insert(usageEvents).values({
    tenant_id: TENANT_A, user_id: VICTIM, provider: 'stub', model: 'm', tokens_in: 5, tokens_out: 5,
  });
  await db.insert(notifications).values({
    tenant_id: TENANT_A, user_id: VICTIM, kind: 'test', title: 'hello',
  });
  await db.insert(chatSessions).values({ tenant_id: TENANT_A, user_id: VICTIM, title: 'chat' });

  // Sanity: the guard's own view MUST be cross-tenant even while tenant B holds the connection.
  // Before the fix this returned nothing at all from here — which is the entire bug.
  const seenFromB = await withTenantDbAsRuntimeRoleForTests(TENANT_B, () =>
    findUserDependants(VICTIM),
  );
  expect(seenFromB.map((d) => d.ref).sort()).toEqual([
    'chat_sessions.user_id',
    'notifications.user_id',
    'usage_events.user_id',
  ]);

  // A super_admin of tenant B invites the victim's address: refused, the person belongs to A.
  const res = await invite(VICTIM_EMAIL, TENANT_B);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error?: string }).error).toBe('email_in_other_tenant');

  // Tenant A is untouched — the row itself and all three cascade dependants.
  const [row] = await db.select({ id: users.id, t: users.tenant_id }).from(users).where(eq(users.id, VICTIM));
  expect(row?.t).toBe(TENANT_A);
  expect((await db.select().from(usageEvents).where(eq(usageEvents.user_id, VICTIM))).length).toBe(1);
  expect((await db.select().from(notifications).where(eq(notifications.user_id, VICTIM))).length).toBe(1);
  expect((await db.select().from(chatSessions).where(eq(chatSessions.user_id, VICTIM))).length).toBe(1);
});

test('invite: an existing member row is never cleared — audit attribution (SET NULL dependant) survives', async () => {
  // `audit_log.actor_id` is ON DELETE SET NULL, so it never blocked the delete and was never
  // counted: clearing the ghost silently anonymised its audit trail. Eleven columns across ten
  // tables behave this way; audit attribution is the bulk of them.
  await db
    .insert(users)
    .values({ id: AUDIT_GHOST, email: AUDIT_GHOST_EMAIL, name: 'Auditor', tenant_id: TENANT_B });
  await db.insert(auditLog).values({
    actor_id: AUDIT_GHOST, action: 'policy.update', category: 'governance', target_type: 'policy',
  });

  const res = await invite(AUDIT_GHOST_EMAIL, TENANT_B);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error?: string }).error).toBe('already_member');

  const rows = await db.select({ actor: auditLog.actor_id }).from(auditLog).where(eq(auditLog.actor_id, AUDIT_GHOST));
  expect(rows.length).toBe(1); // before the fix: 0 rows matched — actor_id had been nulled
});

test('invite: a homeless row (no workspace) is invitable and is NOT deleted', async () => {
  // The old path hard-deleted such "debris" so the address could be re-invited. Invites now never
  // delete a `users` row: the homeless row stays, and acceptance seats whoever proves the email.
  await db
    .insert(users)
    .values({ id: CLEAN_GHOST, email: CLEAN_GHOST_EMAIL, name: 'Debris', tenant_id: null });

  const res = await invite(CLEAN_GHOST_EMAIL, TENANT_B);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { invite: { tenantId: string; email: string; role: string } };
  expect(body.invite.tenantId).toBe(TENANT_B);
  expect(body.invite.email).toBe(CLEAN_GHOST_EMAIL);
  expect(body.invite.role).toBe('member');

  const rows = await db
    .select({ id: users.id, t: users.tenant_id })
    .from(users)
    .where(sql`lower(${users.email}) = ${CLEAN_GHOST_EMAIL}`);
  expect(rows).toEqual([{ id: CLEAN_GHOST, t: null }]);
  const pending = await db.select().from(tenantInvites).where(eq(tenantInvites.tenant_id, TENANT_B));
  expect(pending.map((r) => r.status)).toEqual(['pending']);
  expect(deletedSubs).toEqual([]);
});
