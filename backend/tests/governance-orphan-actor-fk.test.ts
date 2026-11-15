// tests/governance-orphan-actor-fk.test.ts — the /governance PATCH instance of the orphan-actor FK.
//
// ⛔ THE SHAPE. `policies.updated_by` and `policy_changes.changed_by` are BOTH FKs onto `users.id`,
// and `patchGovernance` gates on `requireSuperAdmin` -> `authenticateWithoutLicense`, which never
// calls `ensureUser`. A super_admin granted directly in Keycloak therefore has a `sub` with NO
// `users` row, the `update policies` raised 23503 out of the route, and `route()` handed server.ts
// a non-HttpError it renders as a bare 500 — /governance was unusable for exactly the operators
// most likely to edit a policy, and the error named nothing.
//
// Both columns are nullable, so the honest degrade is `auditActorId` (host/audit-service.ts): the
// id when the row exists, NULL (a System action) when it does not, with the acting subject kept in
// the audit `metadata.actorSub` — the only carrier left, since the column is a FK, not free text.
// The sibling instance, `signup_approvals.decided_by`, is proven in superadmin-orphan-actor-fk.test.ts.
//
// ⛔⛔ ISOLATION — READ THIS BEFORE CHANGING ANYTHING BELOW.
//
// `policies` has NO `tenant_id`; it is listed as explicitly OUTSIDE RLS (migrations/0028_rls.sql:22)
// and is ONE GLOBAL TABLE that `policy-store` / `policy-enforcement` read live. A PATCH test here
// mutates state that every concurrently-running suite — and every other session sharing this
// database — reads. Three rules follow, and all three are load-bearing:
//
//  1. THE RESTORED VALUE IS SNAPSHOTTED, NEVER A LITERAL. `beforeAll` SELECTs the rail's current
//     value and `afterAll` puts THAT back. Restoring a hardcoded literal is not a restore, it is a
//     write dressed as one: see the sibling defect this file's PR fixed in governance.test.ts,
//     whose `RESTORE` map re-typed a 3-element `models.allowlist` and permanently truncated the
//     live rail for every other session the moment the live list grew past three.
//
//  2. THE MUTATION WINDOW IS MILLISECONDS, NOT THE FILE'S LIFETIME. Each test PATCHes, reads back
//     everything it needs, and restores the rail IMMEDIATELY — before asserting. Assertions run
//     against captured rows. `afterAll` restores again as a belt-and-braces for a mid-test throw.
//
//  3. THE RAIL IS THE LEAST-COLLIDING ONE AVAILABLE, WHICH IS NOT THE SAME AS COLLISION-FREE.
//     `block_publish.require_passing_tests` is written by NO other test file (governance.test.ts,
//     governance-enforcement-wire.test.ts and policy-enforcement.test.ts between them rewrite
//     spend.daily_llm_cap, models.allowlist, data.egress_allowlist, promotion.staging_canary_pct,
//     data.eu_only, models.external_http and data.pii_scrubbing — this rail is on none of those
//     lists), so nothing fights us over the restore. It is NOT unread: all 18 seeded rails are read
//     into the policy-store snapshot, so no unread rail exists to pick. Its one runtime consumer is
//     the publish gate at blocks/authoring-service.ts:352, asserted by block-tests.test.ts:186,204.
//     Flipping it true->false is momentarily PERMISSIVE, so rule 2 is what keeps that safe — do not
//     relax it. `promotion.staging_canary_pct` is the only rail with zero enforcement blast radius
//     but governance-enforcement-wire.test.ts rewrites it, which is the worse trade.
//
// Driven AS `cp_app` (NOBYPASSRLS) so the role matches production.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError, type User } from '../src/types';
import { Router } from '../src/utils/router';
import { registerGovernanceRoutes } from '../src/routes/governance';
import type { PolicyValue } from '../src/db/schema';
import { invalidatePolicyCache } from '../src/host/policy-store';
import {
  db,
  withTenantDbAsRuntimeRoleForTests,
  users,
  tenants,
  policies,
  policyChanges,
  auditLog,
} from '../src/db/client';

const TENANT = '00000000-0000-4000-8000-00000f4c0002';
const ORPHAN_ID = '00000000-0000-4000-8000-00000f4c2001'; // Keycloak-only — NO `users` row
const REAL_ID = '00000000-0000-4000-8000-00000f4c2002'; // the positive control — HAS a `users` row

// A `toggle`. See rule 3 above before substituting another key.
const KEY = 'block_publish.require_passing_tests';

const orphanOperator: User = {
  id: ORPHAN_ID, email: 'gov-orphan@test', name: 'Gov Orphan', roles: ['super_admin'], tenantId: TENANT,
};
const realOperator: User = {
  id: REAL_ID, email: 'gov-seated@test', name: 'Gov Seated', roles: ['super_admin'], tenantId: TENANT,
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
registerGovernanceRoutes(router);

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
    // ⛔ server.ts:385 turns a non-HttpError into a bare 500 — mirror it HERE. Without this catch
    // the pre-fix RED is an uncaught 23503 that aborts the file, not an assertion failure that
    // names the defect; the run then proves nothing about `afterAll` having restored the rail.
    return { status: 500, json: { error: 'Internal Server Error', thrown: String(err).slice(0, 300) } };
  }
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** The rail exactly as we found it — restored verbatim, never re-typed. See rule 1. */
let SNAP: { value: PolicyValue; updated_by: string | null; updated_at: Date };
/**
 * Rows that existed before the CURRENT test ran; anything outside these sets is that test's own.
 *
 * ⛔ THESE ADVANCE AFTER EACH TEST. Both tests below PATCH the same rail, so a baseline frozen at
 * `beforeAll` would make the second test see the first test's diff as well and its
 * `toHaveLength(1)` would fail for a reason that has nothing to do with the code under test.
 */
let baseChangeIds = new Set<string>();
let baseAuditIds = new Set<string>();
/** Every row this file minted, across both tests — the exact delete list for `afterAll`. */
const mintedChangeIds: string[] = [];
const mintedAuditIds: string[] = [];

async function readPolicy() {
  const [row] = await db.select().from(policies).where(eq(policies.key, KEY));
  return row!;
}

async function changeRows() {
  return db.select().from(policyChanges).where(eq(policyChanges.policy_key, KEY));
}

async function auditRows() {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'policy.change'), eq(auditLog.target_id, KEY)));
}

/**
 * The rows the just-finished PATCH added, with the baselines advanced past them and the ids banked
 * for `afterAll`'s targeted delete. Call ONCE per PATCH, before restoring.
 */
async function takeNew() {
  const changes = (await changeRows()).filter((c) => !baseChangeIds.has(c.id));
  const audits = (await auditRows()).filter((a) => !baseAuditIds.has(a.id));
  for (const c of changes) {
    baseChangeIds.add(c.id);
    mintedChangeIds.push(c.id);
  }
  for (const a of audits) {
    baseAuditIds.add(a.id);
    mintedAuditIds.push(a.id);
  }
  return { changes, audits };
}

/** Put the rail back the way we found it. Idempotent, and safe to call twice. */
async function restoreRail() {
  await db
    .update(policies)
    .set({ value: SNAP.value, updated_by: SNAP.updated_by, updated_at: SNAP.updated_at })
    .where(eq(policies.key, KEY));
  // The route dropped the cached snapshot on the way in; drop it again so nothing in THIS process
  // keeps serving the flipped value after the row has gone back.
  invalidatePolicyCache();
}

beforeAll(async () => {
  SNAP = await readPolicy();
  expect(typeof SNAP.value).toBe('boolean'); // a `toggle`; the flip below depends on it
  baseChangeIds = new Set((await changeRows()).map((r) => r.id));
  baseAuditIds = new Set((await auditRows()).map((r) => r.id));

  await db
    .insert(tenants)
    .values([{ id: TENANT, name: 'Gov FK Orphan Org', slug: `govfkorphan-${TENANT.slice(-6)}` }])
    .onConflictDoNothing({ target: tenants.id });

  // The positive control's seat. Inserted BEFORE the non-vacuity check so a mixed-up id pair fails
  // loudly here rather than silently making both tests measure the same actor.
  await db
    .insert(users)
    .values({ id: REAL_ID, email: realOperator.email, name: realOperator.name, avatar_initials: 'GS' })
    .onConflictDoNothing({ target: users.id });

  // ⛔ NON-VACUITY: the orphan must genuinely have no seat, or this whole file is decor — a PATCH
  // by a seated actor cannot exercise the FK at all and would pass against the pre-fix route.
  const seat = await db.select({ id: users.id }).from(users).where(eq(users.id, ORPHAN_ID));
  expect(seat.length).toBe(0);
  // ...and the control must genuinely HAVE one, or assertion 6 degrades into a second orphan case.
  const control = await db.select({ id: users.id }).from(users).where(eq(users.id, REAL_ID));
  expect(control.length).toBe(1);
}, 60_000);

afterAll(async () => {
  await restoreRail();
  // Delete only the rows this file minted, by id. A blanket delete on `policy_key` / `target_id`
  // would destroy real recorded history that other sessions and the GET route read.
  await takeNew(); // sweep up anything a mid-test throw left unbanked
  if (mintedChangeIds.length) {
    await db.delete(policyChanges).where(inArray(policyChanges.id, mintedChangeIds));
  }
  if (mintedAuditIds.length) await db.delete(auditLog).where(inArray(auditLog.id, mintedAuditIds));
  // Only after the FK children are gone, and only after `updated_by` is back to the snapshot.
  await db.delete(users).where(inArray(users.id, [REAL_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
  __setAuthOverridesForTests(undefined);
}, 60_000);

test('PATCH does not 500 for a super_admin with no users row; the edit lands, attribution degrades to System', async () => {
  install(orphanOperator);
  const newValue = !(SNAP.value as boolean);

  const r = await callJson('PATCH', `/api/governance/${KEY}`, { value: newValue });

  // Read EVERYTHING before restoring — see isolation rule 2. Assertions run on these captures.
  const after = await readPolicy();
  const { changes: newChanges, audits: newAudits } = await takeNew();
  await restoreRail();

  // 1. The route answers, and answers with the edit — not a bare 500 out of a 23503.
  expect(r.status).not.toBe(500);
  expect(r.status).toBe(200);
  expect(r.json.value).toBe(newValue);

  // 2. The edit was NOT LOST. A 200 whose write silently vanished is the same lie as the 500; this
  //    is what separates `auditActorId`'s honest degrade from "swallow the FK and skip the update".
  expect(after.value).toBe(newValue);

  // 3. …with the actor degraded to System, because there is no row to point at.
  expect(after.updated_by).toBeNull();

  // 4. Exactly ONE diff, correctly attributed and correctly valued. `toHaveLength(1)` also refuses
  //    a route that retried the insert after the FK and minted two.
  expect(newChanges).toHaveLength(1);
  expect(newChanges[0]!.changed_by).toBeNull();
  expect(newChanges[0]!.old_value).toBe(SNAP.value);
  expect(newChanges[0]!.new_value).toBe(newValue);

  // 5. The acting subject SURVIVES, in the only place left for it. Without this the degrade would
  //    be indistinguishable from a genuinely System-initiated policy change, which on a compliance
  //    surface is a worse outcome than the 500 it replaced.
  //
  //    ⚠️ READ THIS BEFORE TREATING THE NEXT LINE AS PROOF OF governance.ts's `actorSub`. It is NOT.
  //    On the ORPHAN path the insert 23503s and `recordAudit`'s own FK fallback retries with
  //    `metadata: { ...entry.metadata, actorSub: entry.actorId }` (host/audit-service.ts:136) — it
  //    injects `actorSub` ITSELF. So deleting `actorSub` from routes/governance.ts's `recordAudit`
  //    call leaves this assertion passing: measured, not assumed. What this line actually pins is
  //    the END-TO-END shape a compliance reader depends on (a System-attributed row that still names
  //    who acted), reached by either author. The line in governance.ts is pinned ONLY by the
  //    POSITIVE CONTROL below, where a seated actor raises no FK, the fallback never runs, and the
  //    route's own metadata is the sole source of `actorSub`. Do not delete that test as redundant.
  expect(newAudits).toHaveLength(1);
  expect(newAudits[0]!.action).toBe('policy.change');
  expect(newAudits[0]!.target_id).toBe(KEY);
  expect(newAudits[0]!.metadata?.actorSub).toBe(ORPHAN_ID);
  // `audit_log.actor_id` is a FK too; recordAudit's own orphan fallback re-attributes it to System.
  expect(newAudits[0]!.actor_id).toBeNull();
});

test('POSITIVE CONTROL: a PATCH by a seated super_admin still stamps updated_by with their id', async () => {
  // ⛔ WHY THIS TEST IS NOT OPTIONAL. `auditActorId` (host/audit-service.ts:57-62) catches EVERY
  // error and returns null. A pool timeout, a revoked SELECT grant on `users`, or an RLS change
  // that hides the row would therefore attribute a REAL operator's policy edit to System — silently,
  // permanently, on the compliance surface. The orphan test above passes just as happily in that
  // world, because null is exactly what it expects. Only a seated actor can tell the honest degrade
  // apart from a blanket one.
  install(realOperator);
  const newValue = !(SNAP.value as boolean);

  const r = await callJson('PATCH', `/api/governance/${KEY}`, { value: newValue });

  const after = await readPolicy();
  const { changes: newChanges, audits: newAudits } = await takeNew();
  await restoreRail();

  expect(r.status).toBe(200);
  expect(after.value).toBe(newValue);
  // THE POINT: not null, and not somebody else.
  expect(after.updated_by).not.toBeNull();
  expect(after.updated_by).toBe(REAL_ID);

  expect(newChanges).toHaveLength(1);
  expect(newChanges[0]!.changed_by).toBe(REAL_ID);
  expect(newAudits).toHaveLength(1);
  expect(newAudits[0]!.actor_id).toBe(REAL_ID);
  expect(newAudits[0]!.metadata?.actorSub).toBe(REAL_ID);
});
