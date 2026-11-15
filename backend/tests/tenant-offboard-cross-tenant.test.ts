// tests/tenant-offboard-cross-tenant.test.ts — P0 regression: offboarding one workspace must
// destroy exactly that workspace, and must ACTUALLY revoke its credentials rather than report that
// it did.
//
// ⛔ THE DEFECT THIS FILE IS SHAPED AROUND. `tenants` and `users` sit OUTSIDE RLS (0028 §COVERAGE),
// but `mcp_api_keys` and `agent_sessions` are INSIDE it — strict `tenant_id =
// app_current_tenant_uuid()` policies with no NULL passthrough (0028 §4a). The offboard route is
// `requireSuperAdmin`, and that guard — unlike `requireTenantAdmin` — never calls
// `refreshTenantGuc`, so `app.current_tenant` stays the OPERATOR'S OWN workspace, which by
// definition is not the one being offboarded.
//
// If the write transaction runs on the request's `cp_app` connection instead of under
// `runAsSystem`, the two credential UPDATEs match ZERO ROWS and return zero. The tenant really is
// suspended and the user rows really are tombstoned, so the operator reads "2 members offboarded"
// and believes it worked — while every departed employee keeps a working MCP API key and a
// renewable agent refresh token. Exactly the hole the feature exists to close, reported as a
// success.
//
// ⛔ THIS FILE ONLY PROVES ANYTHING WHEN IT RUNS AS `cp_app`. The default test DSN is the table
// OWNER, which BYPASSES RLS — under the owner the broken version sees every tenant and this test
// passes vacuously. `withTenantDbAsRuntimeRoleForTests` is what makes the request connection behave
// like production (SET ROLE cp_app + the tenant GUC); see rls-isolation.test.ts and
// invite-cross-tenant-cascade.test.ts for the full rationale.
//
// ⛔ AND THE ASSERTION THAT CARRIES IT IS `keysRevoked > 0` FOR TENANT A. Without it every other
// assertion here (B untouched, no B identity deleted) is satisfied by a route that does nothing at
// all to the credentials — a broken implementation is trivially good at not touching tenant B.
//
// ⛔ THE SECOND DEFECT, AND THE REASON THE FIXTURE LOOKS THE WAY IT DOES. Cross-tenant containment
// is not only "did we touch tenant B's rows" — it is "did we scope each write by the TENANT the
// row belongs to". `agent_sessions` carries its own `tenant_id`, stamped once at mint from the
// `app.current_tenant` GUC, while `users.tenant_id` is a separate mutable column that
// `moveUserHomeTenant` re-points. Nothing ties the two together, so a session's tenant and its
// owner's HOME tenant can disagree — and a revoke keyed on the member id list then reaches into a
// live bystander workspace while missing rows inside the workspace being closed.
//
// This file used to be unable to see that, because every session it seeded was issued as
// `withTenantDb(t, () => issueAgentSession(<a member of t>))` — the two columns ALWAYS agreed. The
// fixture shared the implementation's blind spot and was green either way. It now seeds both
// misaligned directions; see the seeding block in `beforeEach` and the second test.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  auditLog,
  mcpApiKeys,
  agentSessions,
  withTenantDb,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  __setKeycloakAdminForTests,
  type KeycloakAdminClient,
} from '../src/services/keycloak-admin';
import { mintKey, DEFAULT_SCOPES } from '../src/services/mcp-api-key';
import { issueAgentSession } from '../src/services/agent-session';
import type { User } from '../src/types';

const TENANT_A = '00000000-0000-4000-8000-00000f0c0001'; // offboarded
const TENANT_B = '00000000-0000-4000-8000-00000f0c0002'; // the bystander, AND the operator's claim
const SADMIN_ID = '00000000-0000-4000-8000-00000f0c0a01';
const A_ONE = '00000000-0000-4000-8000-00000f0c0a02';
const A_TWO = '00000000-0000-4000-8000-00000f0c0a03';
const B_ONE = '00000000-0000-4000-8000-00000f0c0a04';
const B_TWO = '00000000-0000-4000-8000-00000f0c0a05';
const SEEDED = [SADMIN_ID, A_ONE, A_TWO, B_ONE, B_TWO];
const B_SUBS = [B_ONE, B_TWO];
const TENANT_IDS = [TENANT_A, TENANT_B];
const SLUG_A = 'xt-offboard-a';

/** The operator's claim tenant is B — which is what puts the WRONG tenant in the request's GUC and
 *  makes this test able to see the defect. `requireSuperAdmin` never re-points it. */
const superAdmin: User = {
  id: SADMIN_ID,
  email: 'sa-xt-offboard@t',
  name: 'SA',
  roles: ['platform', 'super_admin'],
  tenantId: TENANT_B,
};

const deletedSubs: string[] = [];

function makeKc(): KeycloakAdminClient {
  return {
    async createRealmUser() {
      return A_ONE;
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
      return null;
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
registerAdminRoutes(router);

/** Drive the LIVE route on a request connection that behaves like production: role `cp_app`,
 *  `app.current_tenant` = the OPERATOR'S tenant (B), while the target is A. */
async function offboardAsRuntimeRole(tenantId: string, confirmSlug: string): Promise<Response> {
  return withTenantDbAsRuntimeRoleForTests(TENANT_B, async () => {
    const m = router.match('POST', `/api/tenants/${tenantId}/offboard`);
    if (!m) throw new Error('no route for POST /api/tenants/:id/offboard');
    return m.handler(
      new Request(`http://t/api/tenants/${tenantId}/offboard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmSlug }),
      }),
      ...m.params,
    );
  });
}

/**
 * The four seeded agent sessions, named `sessionIn<the session's OWN tenant>OwnedBy<the owner's
 * HOME tenant>`. Two agree, two deliberately DISAGREE — the pair the old fixture could not express.
 */
let sessionInAOwnedByA = '';
let sessionInBOwnedByB = '';
let sessionInAOwnedByB = '';
let sessionInBOwnedByA = '';

/** Every seeded agent session, keyed by id, read back OUTSIDE any tenant context — i.e. as the
 *  owner, which bypasses RLS — so a row this test expects to survive cannot be hidden rather than
 *  present, and a row it expects revoked cannot be invisible rather than untouched. */
async function sessionsById() {
  const rows = await db.select().from(agentSessions).where(inArray(agentSessions.user_id, SEEDED));
  // `as const` is load-bearing, not decoration: without it TS widens the pair to
  // `(string | AgentSession)[]` and the Map becomes `Map<string | AgentSession, string | AgentSession>`,
  // so every `.get(id)!.revoked_at` below stops type-checking.
  return new Map(rows.map((r) => [r.id, r] as const));
}

async function cleanup() {
  // Setup + teardown run OUTSIDE any tenant context, i.e. as the owner — so they see every tenant.
  await db.delete(auditLog).where(inArray(auditLog.actor_id, SEEDED));
  await db.delete(auditLog).where(inArray(auditLog.target_id, [...SEEDED, ...TENANT_IDS]));
  await db.delete(mcpApiKeys).where(inArray(mcpApiKeys.tenant_id, TENANT_IDS));
  await db.delete(mcpApiKeys).where(inArray(mcpApiKeys.issued_by, SEEDED));
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, SEEDED));
  await db.delete(users).where(inArray(users.id, SEEDED)); // agent_sessions cascade from here
  await db.delete(tenants).where(inArray(tenants.id, TENANT_IDS));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS.
beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => superAdmin });
  __setKeycloakAdminForTests(makeKc());
  deletedSubs.length = 0;
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Departing Co', slug: SLUG_A },
    { id: TENANT_B, name: 'Bystander Co', slug: 'xt-offboard-b' },
  ]);
  await db.insert(users).values([
    // Homeless, so the operator is not a member of either workspace and is never tombstoned.
    { id: SADMIN_ID, email: superAdmin.email, name: 'SA', tenant_id: null },
    { id: A_ONE, email: 'one@a.xtoff.test', name: 'A1', tenant_id: TENANT_A },
    { id: A_TWO, email: 'two@a.xtoff.test', name: 'A2', tenant_id: TENANT_A },
    { id: B_ONE, email: 'one@b.xtoff.test', name: 'B1', tenant_id: TENANT_B },
    { id: B_TWO, email: 'two@b.xtoff.test', name: 'B2', tenant_id: TENANT_B },
  ]);
  // Two live MCP keys in EACH workspace.
  for (const [tenantId, issuers] of [
    [TENANT_A, [A_ONE, A_TWO]],
    [TENANT_B, [B_ONE, B_TWO]],
  ] as const) {
    for (const issuedBy of issuers) {
      await mintKey({ tenantId, issuedBy, name: `key-${issuedBy}`, scopes: [...DEFAULT_SCOPES] });
    }
  }

  // ---- FOUR live agent sessions: one ALIGNED and one MISALIGNED per workspace ----
  //
  // `agent_sessions.tenant_id` is now written EXPLICITLY by `issueAgentSession`, from the tenant
  // its caller passes (it used to be left to the `app_current_tenant_uuid()` DEFAULT — same value
  // on this path, since every call below passes the very tenant its `withTenantDb` binds, but no
  // longer two independent derivations that merely happened to agree).
  //
  // ⛔ THE ARGUMENT IS THE GUC TENANT, NOT THE OWNER'S HOME TENANT, AND THAT IS THE FIXTURE. The
  // tenant a session belongs to is decided at MINT, NOT by its owner's `users.tenant_id`, so
  // issuing under one workspace's scope on behalf of another workspace's member produces the
  // misaligned row exactly as production does when `moveUserHomeTenant` re-points a person's home
  // tenant and leaves their existing sessions where they were minted. Passing `A_ONE`'s or
  // `B_TWO`'s HOME tenant here instead would quietly delete the misalignment this file exists to
  // detect — see the next paragraph.
  //
  // ⛔ THE MISALIGNED PAIR IS WHAT MAKES THIS FILE ABLE TO SEE THE BUG AT ALL. With only the two
  // aligned rows, `WHERE tenant_id = :id` and `WHERE user_id IN (members)` select the same set and
  // the test is green against either — which is precisely how the cross-tenant write shipped.
  sessionInAOwnedByA = (
    await withTenantDb(TENANT_A, () => issueAgentSession(A_ONE, [], TENANT_A))
  ).sessionId;
  sessionInBOwnedByB = (
    await withTenantDb(TENANT_B, () => issueAgentSession(B_ONE, [], TENANT_B))
  ).sessionId;
  // Grants access to A; held by someone whose home is B. Offboarding A MUST revoke it — otherwise
  // the closed workspace keeps a renewable refresh chain into itself.
  sessionInAOwnedByB = (
    await withTenantDb(TENANT_A, () => issueAgentSession(B_TWO, [], TENANT_A))
  ).sessionId;
  // Grants access to B; held by someone whose home is A. Offboarding A MUST leave it alone — B is
  // live and did not ask for this. This is the exact row the member-id predicate wrongly revoked.
  sessionInBOwnedByA = (
    await withTenantDb(TENANT_B, () => issueAgentSession(A_TWO, [], TENANT_B))
  ).sessionId;
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  await cleanup();
}, 30_000);

test('offboarding tenant A revokes A’s credentials for real, and leaves tenant B entirely alone', async () => {
  const res = await offboardAsRuntimeRole(TENANT_A, SLUG_A);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    usersOffboarded: number;
    keysRevoked: number;
    sessionsRevoked: number;
    keycloakDeleted?: unknown;
  };

  // ⛔ THE ASSERTION THAT MAKES THIS FILE WORTH RUNNING. Without `runAsSystem` on the write
  // transaction, `mcp_api_keys` is RLS-scoped to the OPERATOR'S tenant (B), this UPDATE matches zero
  // rows, and the route answers 200 with `keysRevoked: 0` while both of A's keys keep working.
  // Every other assertion below is satisfied by that broken version.
  expect(body.keysRevoked).toBe(2);
  // TWO, not one: the fixture now seeds a second session whose `tenant_id` is A (held by a user
  // whose home is B). Both grant access to A, so both must die with it. NOTE this count alone does
  // NOT discriminate the scoping rule — the old member-id predicate also reaches two rows here,
  // just the WRONG two. The second test is what separates them, row by row.
  expect(body.sessionsRevoked).toBe(2);
  expect(body.usersOffboarded).toBe(2);
  // The realm is shared with fr: offboarding ends CP access, never the login. The response no
  // longer reports a Keycloak delete count because there is none.
  expect(body.keycloakDeleted).toBeUndefined();

  // …and the rows themselves, read back as the owner.
  for (const k of await db.select().from(mcpApiKeys).where(eq(mcpApiKeys.tenant_id, TENANT_A))) {
    expect(k.revoked_at).toBeInstanceOf(Date);
  }
  for (const s of await db.select().from(agentSessions).where(eq(agentSessions.user_id, A_ONE))) {
    expect(s.revoked_at).toBeInstanceOf(Date);
  }

  // ---- tenant B: untouched in every dimension the offboard writes ----
  const bUsers = await db.select().from(users).where(eq(users.tenant_id, TENANT_B));
  expect(bUsers.length).toBe(2);
  for (const u of bUsers) expect(u.deleted_at).toBeNull();

  const bKeys = await db.select().from(mcpApiKeys).where(eq(mcpApiKeys.tenant_id, TENANT_B));
  expect(bKeys.length).toBe(2);
  for (const k of bKeys) expect(k.revoked_at).toBeNull();

  const bSessions = await db.select().from(agentSessions).where(eq(agentSessions.user_id, B_ONE));
  expect(bSessions.length).toBe(1);
  expect(bSessions[0]!.revoked_at).toBeNull();

  const [b] = await db.select().from(tenants).where(eq(tenants.id, TENANT_B));
  expect(b!.status).toBe('active');
  expect(b!.offboarded_at).toBeNull();

  // No subject — A's or B's — was handed to Keycloak's delete. The portal realm is shared with fr,
  // so a departed workspace member keeps their login; `deleteRealmUser` is irreversible.
  expect(deletedSubs).toEqual([]);
  for (const sub of B_SUBS) expect(deletedSubs).not.toContain(sub);
});

test('offboarding A revokes sessions by the SESSION’s tenant, not by whose members hold them', async () => {
  // ---- NON-VACUITY FIRST: prove the fixture actually produced the misalignment ----
  // If the GUC default ever stopped stamping `tenant_id` at mint — or if someone "tidied" the
  // seeding back to issuing each session under its owner's own tenant — all four rows would line up
  // and every assertion below would be satisfied by BOTH scoping rules. Then this test would pass
  // while proving nothing, which is exactly the state it was written to escape. So: assert the
  // disagreement exists, and that everything starts live, BEFORE the act.
  const before = await sessionsById();
  expect(before.size).toBe(4);
  expect(before.get(sessionInAOwnedByB)!.tenant_id).toBe(TENANT_A);
  expect(before.get(sessionInAOwnedByB)!.user_id).toBe(B_TWO); // …whose home tenant is B
  expect(before.get(sessionInBOwnedByA)!.tenant_id).toBe(TENANT_B);
  expect(before.get(sessionInBOwnedByA)!.user_id).toBe(A_TWO); // …whose home tenant is A
  for (const s of before.values()) expect(s.revoked_at).toBeNull();

  const res = await offboardAsRuntimeRole(TENANT_A, SLUG_A);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessionsRevoked: number };
  const after = await sessionsById();

  // ⛔ THIS PAIR CATCHES THE UNDER-REVOKE. `sessionInAOwnedByB` grants access to A, but its owner
  // is not an A member, so a revoke keyed on A's member ids never sees it: tenant A finishes being
  // offboarded still carrying a live, renewable refresh chain INTO ITSELF — the precise hole this
  // whole feature exists to close, reported as a success.
  expect(after.get(sessionInAOwnedByB)!.revoked_at).toBeInstanceOf(Date);
  expect(after.get(sessionInAOwnedByA)!.revoked_at).toBeInstanceOf(Date);

  // ⛔ THIS PAIR CATCHES THE OVER-REVOKE. `sessionInBOwnedByA` grants access to B — a LIVE
  // workspace nobody offboarded — and a member-id revoke kills it purely because its holder's home
  // happens to be A. That is a write across the tenant boundary, performed by the containment
  // feature, and invisible to B's operator until one of their people is silently logged out.
  expect(after.get(sessionInBOwnedByA)!.revoked_at).toBeNull();
  expect(after.get(sessionInBOwnedByB)!.revoked_at).toBeNull();

  // …and the same claim as SETS, so no future predicate can satisfy the four rows named above while
  // quietly touching a fifth. A presence check on the rows you thought of cannot catch a superset.
  const revoked = [...after.values()].filter((s) => s.revoked_at !== null);
  expect(new Set(revoked.map((s) => s.id))).toEqual(
    new Set([sessionInAOwnedByA, sessionInAOwnedByB]),
  );

  // THE REPORTED COUNT MATCHES WHAT ACTUALLY CHANGED IN THE DATABASE. Without this the route could
  // revoke exactly the right rows and still hand the operator a number that reconciles against
  // nothing — and `sessionsRevoked` is copied verbatim into the `tenant.offboard` audit metadata,
  // so a wrong one is wrong permanently.
  expect(body.sessionsRevoked).toBe(revoked.length);
  expect(body.sessionsRevoked).toBe(2);
});
