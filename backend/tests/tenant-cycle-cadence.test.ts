// tests/tenant-cycle-cadence.test.ts — W7 task C: a workspace's OWN voting schedule.
//
//   GET/PATCH /api/tenant/cycle-cadence (routes/tenant-cycle-cadence.ts) + the return to the platform
//   default (switchTenantCadence(…, null), 0112 `follows_platform`).
//
// Each test names the revert that turns it red:
//   1. cp_app, two tenants: A's admin reads/writes only A; a `tenantId` smuggled in the body or query
//      is refused (400 tenant_id_not_accepted) and B is untouched — revert: drop the refusal in
//      `callerTenant` / the PATCH body check.
//   2. a member / developer gets 403 — revert: `requireTenantAdmin` → `validateAuth`.
//   3. the identical value is a no-op (no history row, no audit row) — revert: the `noop` branch.
//   4. an audit row with tenant_id + actor — revert: the `recordAudit` call.
//   5. 409 cycle_busy while another transaction holds the tenant's cycle lock — revert: the
//      `isLockTimeout` mapping (it answers 500 then).
//   6. null returns to inheriting and the tenant then FOLLOWS a platform switch, even while its
//      return is still waiting for a boundary — revert: `switchCadence` treating a `follows_platform`
//      row as an override (step 3/5).
//   7. /api/me and GET /api/cycle/cadence carry the TENANT's effective cadence: off for a tenant that
//      chose off while the platform runs weekly — revert: `requestTenantId()` → null in me.ts.
//
// File-unique ids; far-future 2085 instants for the rolled-back engine test.
import { test, expect, afterAll, afterEach, beforeEach } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLog,
  db,
  policies,
  tenantCycleCadence,
  tenantCycleCadenceChanges,
  tenants,
  users,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { CYCLE_TENANT_LOCK_NS, switchCadence, switchTenantCadence, tickTenantCycles } from '../src/host/cycle-service';
import { CADENCE_POLICY_KEY, invalidateTenantCadenceCache, readCadencePolicyWithHistory } from '../src/host/cycle-cadence';
import { firstBoundaryAtOrAfter, periodFor } from '../src/host/period';
import { __setSnapshotOverrideForTests, buildSnapshot } from '../src/host/policy-store';
import { registerTenantCycleCadenceRoutes, readTenantCadenceView } from '../src/routes/tenant-cycle-cadence';
import { registerCycleRoutes } from '../src/routes/cycle';
import { registerMeRoutes } from '../src/routes/me';
import { policyDto } from '../src/routes/governance';
import { Router } from '../src/utils/router';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { User } from '../src/types';

type Db = typeof db;
const id = (tail: string) => `00000000-0000-4000-8000-${tail}`;
const TA = id('0000011007a1');
const TB = id('0000011007b2');
const UA = id('0000011008a1'); // tenant_admin of A
const MA = id('0000011009a1'); // member of A
const UB = id('0000011008b2'); // tenant_admin of B
const TR = id('000001100ed1'); // rolled-back engine tests
const TQ = id('000001100ed2');
const DAY = 86_400_000;

const adminA: User = { id: UA, email: 'w7c-ua@test', name: 'W7C Admin A', roles: ['tenant_admin'], tenantId: TA };
const memberA: User = { id: MA, email: 'w7c-ma@test', name: 'W7C Member A', roles: ['member'], tenantId: TA };
const developerA: User = { id: MA, email: 'w7c-ma@test', name: 'W7C Member A', roles: ['developer'], tenantId: TA };
const adminB: User = { id: UB, email: 'w7c-ub@test', name: 'W7C Admin B', roles: ['tenant_admin'], tenantId: TB };

const router = new Router();
registerTenantCycleCadenceRoutes(router);
registerCycleRoutes(router);
registerMeRoutes(router);

/** Call a route AS `user`, inside `tenant`'s request scope with the RUNTIME role (cp_app). */
async function call(
  user: User,
  tenant: string,
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
  const m = router.match(method, path.split('?')[0]!);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDbAsRuntimeRoleForTests(tenant, () => m.handler(req, ...m.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

async function ownRow(tenant: string) {
  const [r] = await db.select().from(tenantCycleCadence).where(eq(tenantCycleCadence.tenant_id, tenant));
  return r ?? null;
}
async function historyOf(tenant: string) {
  return db.select().from(tenantCycleCadenceChanges).where(eq(tenantCycleCadenceChanges.tenant_id, tenant));
}
async function auditRows(tenant: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant), eq(auditLog.action, 'cycle.cadence.tenant_change')));
}

async function cleanup() {
  await db.delete(auditLog).where(inArray(auditLog.tenant_id, [TA, TB]));
  await db.delete(users).where(inArray(users.id, [UA, MA, UB]));
  // Cascades the override rows and their history.
  await db.delete(tenants).where(inArray(tenants.id, [TA, TB]));
  invalidateTenantCadenceCache();
}

async function setup() {
  await cleanup();
  await db.insert(tenants).values([
    { id: TA, name: 'W7C A', slug: 'w7c-a-0000011007a1' },
    { id: TB, name: 'W7C B', slug: 'w7c-b-0000011007b2' },
  ]);
  await db.insert(users).values([
    { id: UA, email: adminA.email, name: adminA.name, tenant_id: TA },
    { id: MA, email: memberA.email, name: memberA.name, tenant_id: TA },
    { id: UB, email: adminB.email, name: adminB.name, tenant_id: TB },
  ]);
  // B already runs its own monthly schedule, with one history entry.
  await db.insert(tenantCycleCadence).values({ tenant_id: TB, value: 'month', updated_by: UB });
  await db.insert(tenantCycleCadenceChanges).values({ tenant_id: TB, old_value: 'week', new_value: 'month', actor_id: UB });
  invalidateTenantCadenceCache();
}

beforeEach(setup, 30_000);
afterEach(() => {
  __setAuthOverridesForTests(undefined);
  __setSnapshotOverrideForTests(undefined);
});
afterAll(cleanup, 30_000);

// ── 1. cross-tenant, as cp_app ────────────────────────────────────────────────────────────────────
test('⛔ A’s tenant_admin reads and writes only A — a tenantId in the body or query is refused, B untouched (cp_app)', async () => {
  const before = await call(adminA, TA, 'GET', '/api/tenant/cycle-cadence');
  expect(before.status).toBe(200);
  expect(before.json).toMatchObject({ value: null, followsPlatform: true, history: [] });
  expect(['off', 'week', 'month', 'quarter', 'year']).toContain(before.json.platformDefault as string);

  // Smuggled tenant: body, then query. Both refused BEFORE anything is written.
  const smuggled = await call(adminA, TA, 'PATCH', '/api/tenant/cycle-cadence', { value: 'year', tenantId: TB });
  expect(smuggled.status).toBe(400);
  expect(smuggled.json.error).toBe('tenant_id_not_accepted');
  const viaQuery = await call(adminA, TA, 'PATCH', `/api/tenant/cycle-cadence?tenantId=${TB}`, { value: 'year' });
  expect(viaQuery.status).toBe(400);
  expect(viaQuery.json.error).toBe('tenant_id_not_accepted');
  const readQuery = await call(adminA, TA, 'GET', `/api/tenant/cycle-cadence?tenantId=${TB}`);
  expect(readQuery.status).toBe(400);
  expect((await ownRow(TB))!.value).toBe('month');
  expect(await ownRow(TA)).toBeNull();

  // A real change lands on A only.
  const patched = await call(adminA, TA, 'PATCH', '/api/tenant/cycle-cadence', { value: 'quarter' });
  expect(patched.status).toBe(200);
  expect(patched.json).toMatchObject({ changed: true, value: 'quarter', followsPlatform: false });
  expect((await ownRow(TA))!.value).toBe('quarter');
  expect((await ownRow(TB))!.value).toBe('month');
  expect(await historyOf(TB)).toHaveLength(1);

  // A's history shows A's change (with its actor's name) and never B's.
  const after = await call(adminA, TA, 'GET', '/api/tenant/cycle-cadence');
  const hist = after.json.history as { newValue: string; actorName: string | null }[];
  expect(hist).toHaveLength(1);
  expect(hist[0]).toMatchObject({ newValue: 'quarter', actorName: 'W7C Admin A' });

  // And B's admin still sees B's month.
  const b = await call(adminB, TB, 'GET', '/api/tenant/cycle-cadence');
  expect(b.json).toMatchObject({ value: 'month', followsPlatform: false });
  expect((b.json.history as unknown[]).length).toBe(1);
}, 30_000);

// ── 2. role gate ──────────────────────────────────────────────────────────────────────────────────
test('⛔ a member and a developer get 403 on GET and PATCH; nothing is written', async () => {
  for (const u of [memberA, developerA]) {
    const g = await call(u, TA, 'GET', '/api/tenant/cycle-cadence');
    expect(g.status).toBe(403);
    expect(g.json.error).toBe('tenant_admin_required');
    const p = await call(u, TA, 'PATCH', '/api/tenant/cycle-cadence', { value: 'off' });
    expect(p.status).toBe(403);
  }
  expect(await ownRow(TA)).toBeNull();
  expect(await historyOf(TA)).toHaveLength(0);
}, 30_000);

// ── 3 + 4. no-op and audit ────────────────────────────────────────────────────────────────────────
test('⛔ the identical value is a no-op (no history, no audit); a change writes ONE audit row with tenant + actor', async () => {
  const first = await call(adminA, TA, 'PATCH', '/api/tenant/cycle-cadence', { value: 'month' });
  expect(first.json.changed).toBe(true);
  const audits = await auditRows(TA);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ tenant_id: TA, actor_id: UA, category: 'policy', target_id: TA });
  expect(audits[0]!.metadata).toMatchObject({ newValue: 'month', followsPlatform: false });

  const again = await call(adminA, TA, 'PATCH', '/api/tenant/cycle-cadence', { value: 'month' });
  expect(again.status).toBe(200);
  expect(again.json).toMatchObject({ changed: false, value: 'month' });
  expect(await historyOf(TA)).toHaveLength(1);
  expect(await auditRows(TA)).toHaveLength(1);

  // Returning to the platform default is a change too (audited); a second return is a no-op.
  const back = await call(adminA, TA, 'PATCH', '/api/tenant/cycle-cadence', { value: null });
  expect(back.json).toMatchObject({ changed: true, value: null, followsPlatform: true });
  const backAgain = await call(adminA, TA, 'PATCH', '/api/tenant/cycle-cadence', { value: null });
  expect(backAgain.json.changed).toBe(false);
  expect(await auditRows(TA)).toHaveLength(2);
  expect((await historyOf(TA)).filter((h) => h.follows_platform)).toHaveLength(1);

  // An unknown value is a validation error, not a write.
  const bad = await call(adminA, TA, 'PATCH', '/api/tenant/cycle-cadence', { value: 'fortnight' });
  expect(bad.status).toBe(422);
  expect(bad.json.error).toBe('validation');
  expect(await historyOf(TA)).toHaveLength(2);
}, 30_000);

// ── 5. bounded wait ───────────────────────────────────────────────────────────────────────────────
test('⛔ 409 cycle_busy while another transaction holds the tenant’s cycle lock (waited on the advisory lock, then gave up)', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let gotLock!: () => void;
  const locked = new Promise<void>((r) => (gotLock = r));
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CYCLE_TENANT_LOCK_NS}::int, hashtext(${TA}::uuid::text))`);
    gotLock();
    await held;
  });
  await locked;
  try {
    const pending = call(adminA, TA, 'PATCH', '/api/tenant/cycle-cadence', { value: 'year' });
    // Deterministic: the PATCH really is queued on the advisory lock (not failing for another reason).
    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i++) {
      const rows = (await db.execute(
        sql`select count(*)::int as n from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`,
      )) as unknown as { n: number }[];
      waiting = Number(rows[0]?.n ?? 0);
      if (waiting === 0) await Bun.sleep(50);
    }
    expect(waiting).toBeGreaterThan(0);
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('cycle_busy');
  } finally {
    release();
    await holder;
  }
  expect(await ownRow(TA)).toBeNull();
  expect(await auditRows(TA)).toHaveLength(0);
}, 40_000);

// ── 6. return to the platform default, then follow a platform switch (rolled back) ─────────────────
class Rollback extends Error {}
async function inRolledBackTx(fn: (tx: Db) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

test('⛔ null returns to the platform default at the next boundary, and the tenant then FOLLOWS a platform switch', async () => {
  await inRolledBackTx(async (tx) => {
    await tx.insert(tenants).values([
      { id: TR, name: 'W7C R', slug: 'w7c-r-000001100ed1' },
      { id: TQ, name: 'W7C Q', slug: 'w7c-q-000001100ed2' },
    ]);
    await tx
      .update(policies)
      .set({ value: 'week', effective_from: null, previous_value: null, updated_at: new Date('2085-01-01T00:00:00Z') })
      .where(eq(policies.key, CADENCE_POLICY_KEY));
    const t0 = new Date('2085-03-05T12:00:00Z'); // a Monday-to-Sunday week in the middle of March

    // R chooses OFF (nothing running), then returns to the platform default (weekly).
    expect((await switchTenantCadence(TR, 'off', null, { at: t0, database: tx })).changed).toBe(true);
    const t1 = new Date(t0.getTime() + 3_600_000);
    const back = await switchTenantCadence(TR, null, null, { at: t1, database: tx });
    expect(back.changed).toBe(true);
    const monday = firstBoundaryAtOrAfter('week', t1);
    // Never a partly-elapsed week: weekly takes over at the next Monday, and until then R stays off.
    expect(back.pending).toEqual({ at: monday, previous: 'off' });
    let v = await readTenantCadenceView(TR, t1, tx);
    expect(v).toMatchObject({ value: null, followsPlatform: true, effectiveValue: 'off', pendingValue: 'week', platformDefault: 'week' });
    expect(v.effectiveFrom?.toISOString()).toBe(monday.toISOString());

    // The platform switches week → month BEFORE R's return took effect: R follows it.
    const t2 = new Date(t1.getTime() + 3_600_000);
    await switchCadence('month', t2, tx, { updatedBy: null });
    const firstOfMonth = firstBoundaryAtOrAfter('month', t2);
    v = await readTenantCadenceView(TR, t2, tx);
    expect(v, 'a returning tenant did not follow the platform switch').toMatchObject({
      value: null,
      followsPlatform: true,
      effectiveValue: 'off',
      pendingValue: 'month',
      platformDefault: 'month',
    });
    expect(v.effectiveFrom?.toISOString()).toBe(firstOfMonth.toISOString());
    const engine = await readCadencePolicyWithHistory(tx, TR, { lock: false, at: t2 });
    expect(engine.setting).toBe('month');

    // After the boundary R inherits plainly, and its tick opens the platform's month.
    const t3 = new Date(firstOfMonth.getTime() + 2 * DAY);
    v = await readTenantCadenceView(TR, t3, tx);
    expect(v).toMatchObject({ value: null, followsPlatform: true });
    expect((await tickTenantCycles(t3, TR, tx)).opened).toBe(periodFor('month', t3).key);

    // Q pins the value it inherits (month), then returns: the platform's cadence takes over AT ONCE —
    // no carrier row — and Q follows the next platform switch like any inheriting tenant.
    const t4 = new Date(t3.getTime() + DAY);
    await switchTenantCadence(TQ, 'month', null, { at: t4, database: tx });
    const qBack = await switchTenantCadence(TQ, null, null, { at: new Date(t4.getTime() + 60_000), database: tx });
    expect(qBack).toMatchObject({ changed: true, pending: null });
    expect(await tx.select().from(tenantCycleCadence).where(eq(tenantCycleCadence.tenant_id, TQ))).toHaveLength(0);
    const t5 = new Date(t4.getTime() + DAY);
    const sw = await switchCadence('quarter', t5, tx, { updatedBy: null });
    expect(sw.inheriting).toContain(TQ);
    const q = await readCadencePolicyWithHistory(tx, TQ, { lock: false, at: t5 });
    expect(q.setting).toBe('quarter');
  });
  invalidateTenantCadenceCache();
}, 60_000);

// ── 7. the member-facing reads follow the TENANT ──────────────────────────────────────────────────
test('⛔ /api/me and GET /api/cycle/cadence say OFF for a tenant that chose off while the platform runs weekly', async () => {
  // The platform runs weekly (snapshot override: the shared `policies` row is never flipped here).
  __setSnapshotOverrideForTests({ ...buildSnapshot([]), cycleCadence: 'week', cycleCadenceSwitchAt: null, cycleCadencePrevious: null });
  await db.insert(tenantCycleCadence).values({ tenant_id: TA, value: 'off', updated_by: UA });
  await db.delete(tenantCycleCadence).where(eq(tenantCycleCadence.tenant_id, TB)); // B inherits
  invalidateTenantCadenceCache();

  const meA = await call(memberA, TA, 'GET', '/api/me');
  expect(meA.status).toBe(200);
  expect(meA.json.cycleCadence).toBe('off');
  const cadA = await call(memberA, TA, 'GET', '/api/cycle/cadence');
  expect(cadA.json.effective).toBe('off');
  // Positive control: the platform really is on — an inheriting tenant reads weekly.
  const meB = await call(adminB, TB, 'GET', '/api/me');
  expect(meB.json.cycleCadence).toBe('week');
}, 30_000);

// ── 8. the governance rail's date is the PLATFORM's ──────────────────────────────────────────────
test('⛔ GET /api/governance carries the platform cadence switch date on the rail (not the tenant endpoint’s)', async () => {
  const [row] = await db.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
  expect(row, 'seeded cycle.cadence row').toBeTruthy();
  const now = new Date('2085-03-05T12:00:00Z');
  const future = new Date('2085-04-01T00:00:00Z');
  expect(policyDto({ ...row!, effective_from: future, previous_value: 'week' }, now).effectiveFrom).toEqual(future);
  // A switch already in force is not "pending".
  expect(policyDto({ ...row!, effective_from: new Date('2085-03-01T00:00:00Z'), previous_value: 'week' }, now).effectiveFrom).toBeNull();
  expect(policyDto({ ...row!, effective_from: null, previous_value: null }, now).effectiveFrom).toBeNull();
});
