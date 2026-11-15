// tests/seat-limit.test.ts — the per-tenant seat cap (migration 0044, `tenants.max_members`).
//
// The cap must (a) be invisible when unset, so every pre-0044 tenant is unaffected, (b) reject the
// invite BEFORE any Keycloak identity is minted, and (c) never retroactively lock out people who
// are already in the workspace when the cap is lowered under them.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, tenants, users } from '../src/db/client';
import { assertSeatAvailable, claimSeat, getSeatUsage } from '../src/services/seat-limit';
import { HttpError } from '../src/utils/http';

const TENANT = '00000000-0000-4000-8000-0000000c9001';
const U1 = '00000000-0000-4000-8000-0000000c9011';
const U2 = '00000000-0000-4000-8000-0000000c9012';
const U3 = '00000000-0000-4000-8000-0000000c9013';
const U4 = '00000000-0000-4000-8000-0000000c9014';
const SEEDED = [U1, U2, U3, U4];

async function cleanup() {
  await db.delete(users).where(inArray(users.id, SEEDED));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

async function seedMembers(n: number) {
  await db.insert(users).values(
    SEEDED.slice(0, n).map((id, i) => ({
      id,
      email: `seat${i}@seat-test.co`,
      name: `Seat ${i}`,
      tenant_id: TENANT,
    })),
  );
}

const setCap = (max: number | null) =>
  db.update(tenants).set({ max_members: max }).where(eq(tenants.id, TENANT));

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: TENANT, name: 'Seat Test Co', slug: 'seat-test-co' });
}, 30_000);

afterAll(cleanup, 30_000);

test('an uncapped tenant reports unlimited seats and never blocks', async () => {
  await seedMembers(3);
  const usage = await getSeatUsage(TENANT);
  expect(usage.used).toBe(3);
  expect(usage.max).toBeNull();
  expect(usage.remaining).toBeNull();
  await expect(assertSeatAvailable(TENANT)).resolves.toBeDefined();
});

test('a tenant below its cap has seats left', async () => {
  await setCap(3);
  await seedMembers(1);
  const usage = await getSeatUsage(TENANT);
  expect(usage).toEqual({ used: 1, max: 3, remaining: 2 });
  await expect(assertSeatAvailable(TENANT)).resolves.toBeDefined();
});

test('a full tenant is a 409 seat_limit_reached carrying used/max', async () => {
  await setCap(2);
  await seedMembers(2);
  const err = (await assertSeatAvailable(TENANT).catch((e) => e)) as HttpError;
  expect(err).toBeInstanceOf(HttpError);
  expect(err.status).toBe(409);
  expect(err.code).toBe('seat_limit_reached');
  // The UI renders these — a bare error would leave the tenant-admin with nothing to ask for.
  expect(err.details).toEqual({ used: 2, max: 2 });
  expect(err.message).toContain('2');
});

test('lowering the cap below the current headcount blocks NEW invites but keeps everyone', async () => {
  await seedMembers(3);
  await setCap(1); // e.g. a downgrade; the three existing people must stay
  const usage = await getSeatUsage(TENANT);
  expect(usage.used).toBe(3);
  expect(usage.remaining).toBe(0); // clamped, never negative
  await expect(assertSeatAvailable(TENANT)).rejects.toMatchObject({ code: 'seat_limit_reached' });

  const stillThere = await db.select().from(users).where(eq(users.tenant_id, TENANT));
  expect(stillThere.length).toBe(3);
});

test('raising the cap immediately frees seats again', async () => {
  await setCap(2);
  await seedMembers(2);
  await expect(assertSeatAvailable(TENANT)).rejects.toMatchObject({ code: 'seat_limit_reached' });
  await setCap(5);
  const usage = await assertSeatAvailable(TENANT);
  expect(usage.remaining).toBe(3);
});

test('an unknown tenant reports zero usage rather than throwing', async () => {
  const usage = await getSeatUsage('00000000-0000-4000-8000-0000000c9fff');
  expect(usage).toEqual({ used: 0, max: null, remaining: null });
});

test('users.tenant_id — the seat column — is indexed (migration 0048)', async () => {
  // Anti-drift, in the style of rls-coverage.test.ts. Every seat check counts
  // `users WHERE tenant_id = $1`, and the SSO/JIT guard runs that count on a path an over-cap
  // tenant re-enters on every request from every refused user. Unindexed that is a sequential scan
  // of the whole users table, inside a transaction holding one of four pool slots.
  const [row] = await db.execute(
    sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'users_tenant_id_idx'`,
  );
  expect(row, 'users_tenant_id_idx must exist — see migrations/0048_users_tenant_id_idx.sql').toBeDefined();
  expect(String((row as { indexdef: string }).indexdef)).toContain('tenant_id');
});

// ---- concurrency: the cap is check-then-act, and a returned check cannot stop the next write ----

/** One invite, done properly: the seat is claimed and FILLED inside a single locked transaction. */
const invite = (id: string, email: string) =>
  claimSeat(TENANT, { existingEmail: email }, async (tx) => {
    await tx.insert(users).values({ id, email, name: email, tenant_id: TENANT });
    return id;
  });

test('two invites racing for the LAST seat: exactly one wins', async () => {
  // The proven failure: both callers counted 2-of-3, both passed the check, both inserted, and the
  // workspace ended on `used: 4, max: 3`. A cap that can be exceeded by pressing the button twice
  // is not a cap — and seats are what a customer is billed for.
  await setCap(3);
  await seedMembers(2);

  const results = await Promise.allSettled([
    invite(U3, 'race-a@seat-test.co'),
    invite(U4, 'race-b@seat-test.co'),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  expect(won.length).toBe(1);
  expect(lost.length).toBe(1);
  expect(lost[0]!.reason).toBeInstanceOf(HttpError);
  expect((lost[0]!.reason as HttpError).code).toBe('seat_limit_reached');

  // The decisive assertion: the headcount never exceeds the cap.
  const usage = await getSeatUsage(TENANT);
  expect(usage).toEqual({ used: 3, max: 3, remaining: 0 });
});

test('the loser of the race left NO half-created member behind', async () => {
  // The rejected claim rolls back inside the same transaction that took the lock, so a failed
  // invite cannot leave an orphan row that permanently occupies a seat nobody holds.
  await setCap(3);
  await seedMembers(2);
  await Promise.allSettled([
    invite(U3, 'race-c@seat-test.co'),
    invite(U4, 'race-d@seat-test.co'),
  ]);
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.tenant_id, TENANT));
  expect(rows.length).toBe(3);
});

test('claimSeat rolls the seat back when the work inside it fails', async () => {
  await setCap(3);
  await seedMembers(1);
  await expect(
    claimSeat(TENANT, {}, async (tx) => {
      await tx.insert(users).values({
        id: U3,
        email: 'doomed@seat-test.co',
        name: 'Doomed',
        tenant_id: TENANT,
      });
      throw new Error('keycloak rollback / license issuance failed');
    }),
  ).rejects.toThrow('keycloak rollback');
  expect((await getSeatUsage(TENANT)).used).toBe(1);
});

test('an uncapped tenant claims seats concurrently without blocking either', async () => {
  // The lock must not turn "unlimited" into a queue that fails: both claims succeed.
  await seedMembers(1);
  const results = await Promise.allSettled([
    invite(U3, 'free-a@seat-test.co'),
    invite(U4, 'free-b@seat-test.co'),
  ]);
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  expect((await getSeatUsage(TENANT)).used).toBe(3);
});

test('a resumable retry for an EXISTING member still passes under the lock', async () => {
  // Onboarding checkpoints the Keycloak sub and retries; by then the local row exists, and a
  // tenant sitting exactly on its cap must not 409 forever on its own half-onboarded person.
  await setCap(2);
  await seedMembers(2);
  const usage = await claimSeat(TENANT, { existingEmail: 'SEAT0@seat-test.co' }, async () => 'ok');
  expect(usage).toBe('ok');
});
