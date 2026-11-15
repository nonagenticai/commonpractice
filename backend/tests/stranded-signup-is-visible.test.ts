// tests/stranded-signup-is-visible.test.ts
//
// THE DEFECT: a real external user authenticated against Keycloak with no `tenant_id` claim —
// the deliberate, correct outcome for someone nobody has routed to a workspace yet — and
// `ensureUser`'s no-claim branch did ONLY `upsertRow(tx, user)`. That created a bare `users` row
// and nothing else: no entry in the super_admin approval queue, no audit trail, nothing an
// operator could ever see or search for. The person sat there, fully authenticated, invisible to
// the one screen (`/api/signup-approvals`) whose entire job is to surface exactly this case — for
// 83 days, until someone found them by accident.
//
// The fix makes the no-claim branch ALSO record a pending `signup_approvals` row (idempotent —
// this branch runs on EVERY authenticated request the stranded user ever makes, not once) and
// exactly ONE audit row on first creation. This file pins that end state. It does NOT read
// `user-service.ts` to discover current behaviour: the no-claim branch was being rewritten
// concurrently with this file, so these tests are written against the specified end state, not
// against whatever the source happened to say at the time.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, users, tenants, auditLog, signupApprovals } from '../src/db/client';
import { ensureUser } from '../src/services/user-service';
import type { User } from '../src/types';

// Own id range + own email domain ('@stranded.test') so cleanup here can never collide with
// user-service.test.ts's own fixtures (which share the same `ensureUser` entrypoint) or with
// onboarding.test.ts's '-c2.test' signup_approvals rows.
const NOCLAIM_SINGLE = '00000000-0000-0000-0000-00000000e501'; // one call — pins the NULL tenant + the new row
const NOCLAIM_LOOP = '00000000-0000-0000-0000-00000000e502'; // repeated sequential calls — the idempotence test
const NOCLAIM_BURST = '00000000-0000-0000-0000-00000000e503'; // concurrent calls — same idempotence, racier
const SEATED = '00000000-0000-0000-0000-00000000e504'; // holds a CP seat (users.tenant_id)
const UNPROVISIONED_CLAIM = '00000000-0000-0000-0000-00000000e505'; // claim names a tenant CP lacks
const PROVISIONED_CLAIM = '00000000-0000-0000-0000-00000000e506'; // claim names a REAL CP tenant
const SUPER = '00000000-0000-0000-0000-00000000e507'; // super_admin, no workspace
const TENANT = '00000000-0000-0000-0000-00000000e5a1';
/** A well-formed tenant id that is deliberately NEVER inserted into `tenants` — an fr/portal
 *  tenant with no CP workspace, the 2026-10-06 production case. */
const UNPROVISIONED_TENANT = '00000000-0000-0000-0000-00000000e5a2';
const IDS = [
  NOCLAIM_SINGLE,
  NOCLAIM_LOOP,
  NOCLAIM_BURST,
  SEATED,
  UNPROVISIONED_CLAIM,
  PROVISIONED_CLAIM,
  SUPER,
];

function user(id: string, tenantId?: string, roles: string[] = []): User {
  return {
    id,
    email: `strand-${id.slice(-4)}@stranded.test`,
    name: `Stranded ${id.slice(-4)}`,
    roles,
    ...(tenantId ? { tenantId } : {}),
  };
}

const emailOf = (id: string) => user(id).email;

/** signup_approvals rows for one identity, matched the same way notify-self de-dupes: case
 *  insensitively on email (the table's own partial unique index is `lower(email)`). */
const approvalsFor = (email: string) =>
  db.select().from(signupApprovals).where(sql`lower(email) = ${email.toLowerCase()}`);

/** audit rows targeting one identity. Every OTHER audit write in this file's neighbour,
 *  user-service.test.ts (`user.jit_seat_denied`), keys `target_id`
 *  to the user id — asserting the same shape here, not a specific `action` string, since the
 *  exact action name is not specified and is not this test's business to invent. */
const auditsFor = (userId: string) => db.select().from(auditLog).where(eq(auditLog.target_id, userId));

async function cleanup() {
  await db.delete(auditLog).where(inArray(auditLog.target_id, IDS));
  await db.delete(signupApprovals).where(sql`lower(email) LIKE '%@stranded.test'`);
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, IDS));
  await db.delete(users).where(inArray(users.id, IDS));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see user-service.test.ts).
beforeEach(async () => {
  await cleanup();
  await db
    .insert(tenants)
    .values({ id: TENANT, name: 'Stranded-Signup Tenant', slug: 'stranded-signup' })
    .onConflictDoNothing({ target: tenants.id });
}, 30_000);
afterAll(cleanup, 30_000);

test('a token with no tenant_id claim still creates a users row with tenant_id NULL', async () => {
  // Pinned, not "fixed": this is the deliberate, correct outcome for someone nobody has routed to
  // a workspace yet. Nobody should ever "fix" this by fabricating a tenant.
  await ensureUser(user(NOCLAIM_SINGLE));
  const [row] = await db.select().from(users).where(eq(users.id, NOCLAIM_SINGLE));
  expect(row).toBeDefined();
  expect(row!.tenant_id).toBeNull();
});

test('…and now also creates exactly one pending signup_approvals row for that identity', async () => {
  await ensureUser(user(NOCLAIM_SINGLE));
  const rows = await approvalsFor(emailOf(NOCLAIM_SINGLE));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('pending');
});

test('repeated calls (a real request loop) leave exactly ONE approval row and ONE audit row', async () => {
  // THE SHARPEST TEST. This branch runs on every authenticated request the stranded user makes —
  // every page load, every API call — for as long as they stay stranded. A per-request row here is
  // the exact failure mode this file exists to catch: it would flood the approval queue and the
  // audit trail with one row per request instead of one row per person.
  for (let i = 0; i < 5; i++) {
    await ensureUser(user(NOCLAIM_LOOP));
  }
  const approvals = await approvalsFor(emailOf(NOCLAIM_LOOP));
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.status).toBe('pending');

  const audits = await auditsFor(NOCLAIM_LOOP);
  expect(audits).toHaveLength(1);

  // The users row itself must also still be singular — the pre-existing idempotence guarantee,
  // re-asserted here so a regression that broke ANY of the three writes shows up in one test.
  expect(await db.select().from(users).where(eq(users.id, NOCLAIM_LOOP))).toHaveLength(1);
});

test('a concurrent burst of the same no-claim identity does not double-write either row', async () => {
  // The same idempotence claim under a race instead of a loop — an SPA boot fires several requests
  // at once, all carrying the same no-claim identity.
  await Promise.all([
    ensureUser(user(NOCLAIM_BURST)),
    ensureUser(user(NOCLAIM_BURST)),
    ensureUser(user(NOCLAIM_BURST)),
  ]);
  expect(await approvalsFor(emailOf(NOCLAIM_BURST))).toHaveLength(1);
  expect(await auditsFor(NOCLAIM_BURST)).toHaveLength(1);
  expect(await db.select().from(users).where(eq(users.id, NOCLAIM_BURST))).toHaveLength(1);
});

test('an already-seated user (CP row with a tenant_id) creates no approval row at all', async () => {
  // Seated means CP's own `users.tenant_id`, never the token claim.
  await db
    .insert(users)
    .values({ id: SEATED, email: emailOf(SEATED), name: 'Seated', tenant_id: TENANT, keycloak_sub: SEATED });
  for (let i = 0; i < 3; i++) await ensureUser(user(SEATED));
  const [row] = await db.select().from(users).where(eq(users.id, SEATED));
  expect(row!.tenant_id).toBe(TENANT);
  expect(await approvalsFor(emailOf(SEATED))).toHaveLength(0);
});

test('a token claim naming an UNPROVISIONED tenant is stranded like no claim — queued once, never seated', async () => {
  // Production 2026-10-06: the claim named an fr/portal tenant CP never provisioned. The claim is
  // now ignored entirely, so this is simply a workspace-less user.
  for (let i = 0; i < 3; i++) {
    await ensureUser(user(UNPROVISIONED_CLAIM, UNPROVISIONED_TENANT));
  }
  const [row] = await db.select().from(users).where(eq(users.id, UNPROVISIONED_CLAIM));
  expect(row!.tenant_id).toBeNull();
  const approvals = await approvalsFor(emailOf(UNPROVISIONED_CLAIM));
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.status).toBe('pending');
  expect(await auditsFor(UNPROVISIONED_CLAIM)).toHaveLength(1);
});

test('a token claim naming a REAL CP tenant still seats nobody — the user is queued', async () => {
  await ensureUser(user(PROVISIONED_CLAIM, TENANT));
  const [row] = await db.select().from(users).where(eq(users.id, PROVISIONED_CLAIM));
  expect(row!.tenant_id).toBeNull();
  expect(await approvalsFor(emailOf(PROVISIONED_CLAIM))).toHaveLength(1);
});

test('a workspace-less super_admin is platform staff, not a signup — nothing is queued', async () => {
  await ensureUser(user(SUPER, undefined, ['super_admin']));
  const [row] = await db.select().from(users).where(eq(users.id, SUPER));
  expect(row!.tenant_id).toBeNull();
  expect(row!.role).toBe('platform'); // what keeps census C (the stranded alert) off this row
  expect(await approvalsFor(emailOf(SUPER))).toHaveLength(0);
});

test('an EXISTING workspace-less row is marked platform on its next super_admin request', async () => {
  await ensureUser(user(SUPER)); // first seen without the role — an ordinary strand
  await db.delete(signupApprovals).where(sql`lower(email) = ${emailOf(SUPER)}`);
  await ensureUser(user(SUPER, undefined, ['super_admin']));
  const [row] = await db.select().from(users).where(eq(users.id, SUPER));
  expect(row!.role).toBe('platform');
});

// ---- NOT ASSERTED: stranded → approved → seated end-to-end -----------------------------------
// Assertion (5) in the task ("a user who is stranded and then approved through the normal flow
// ends up seated") is deliberately not written here. Exercising the real approve route
// (routes/onboarding.ts `POST /api/signup-approvals/:id/approve`) needs a fake KeycloakAdminClient
// injected via `__setKeycloakAdminForTests` — onboarding.test.ts builds one (`makeKc`, ~80 lines),
// but it is defined inline in that file, not exposed as a shared test helper anywhere in
// `tests/helpers/`. Duplicating that scaffolding here to exercise a code path this file's owner
// (user-service.ts) does not itself contain would be exactly the "elaborate scaffolding" the task
// asked to avoid rather than build. If that end-to-end guarantee needs pinning, it belongs beside
// the approve-flow tests in onboarding.test.ts, which already has the fake KC client in scope.
