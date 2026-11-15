// tests/seed-marketplace-winner.test.ts — the demo seed must never manufacture a CROSS-TENANT
// weekly winner (a row whose tenant_id is not its solution's tenant).
//
// This is not hypothetical. The seed adopts an existing solution when one already matches
// (challenge, title), so on a database carrying pre-C.1 data it picks up a row living in one of the
// old per-USER tenants (`u-<hex>`) — and the winner insert used to pair that id with a hardcoded
// DEMO_TENANT_ID. Migration 0047 exists to heal exactly that row, and because seeds run at backend
// BOOT, production re-created it NINE SECONDS after 0047 deleted it:
//
//   0047 applied            2026-07-29T01:45:32.535Z
//   misaligned row born     2026-07-29T01:45:41.101Z   tenant "Common Practice Demo",
//                                                      solution owned by "Mary Smit"
//
// A cross-tenant winner is worse than a missing one: GET /api/winner resolves the solution under
// the caller's RLS, finds nothing, and the tenant's marquee page renders its empty state while a
// real winner sits in the table.
import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, solutions, weeklyWinners, challenges, users } from '../src/db/client';
import { seedMarketplace, showcaseWeeks } from '../src/db/seed-marketplace';
import { DEMO_TENANT_ID } from '../src/config';

const SEED_WEEK = showcaseWeeks(new Date()).winnerWeek;

const OTHER_TENANT = '00000000-0000-0000-0000-0000005eed01';

test('the demo seed never writes a winner whose solution belongs to another tenant', async () => {
  await seedMarketplace();

  const rows = await db
    .select({
      winnerTenant: weeklyWinners.tenant_id,
      solutionTenant: solutions.tenant_id,
      week: weeklyWinners.week,
    })
    .from(weeklyWinners)
    .innerJoin(solutions, eq(solutions.id, weeklyWinners.solution_id));

  expect(rows.length).toBeGreaterThan(0); // the seed really did write one — not vacuously true
  for (const r of rows) {
    expect(r.winnerTenant).toBe(r.solutionTenant);
  }
});

test('a legacy solution in a FOREIGN tenant is adopted with its own tenant, not the demo one', async () => {
  // Reproduces the production shape directly: the winning solution already exists under a
  // different tenant before the seed runs, exactly as it does on a database with pre-C.1 rows.
  await seedMarketplace(); // establish the challenge + users the seed keys off

  const [ch] = await db
    .select({ id: challenges.id })
    .from(challenges)
    .where(eq(challenges.code, 'CH-284'));
  // ⛔ This used to be `if (!ch) return;` — which reports PASS while executing zero
  // assertions whenever the seed drifts. The cross-tenant-winner regression this test
  // exists to catch would then go green and undetected. If the anchor is missing, the
  // test's premise is broken and that is itself a failure worth seeing.
  expect(ch, "seed anchor challenge 'CH-284' is missing — seedMarketplace() drifted").toBeDefined();

  const [author] = await db.select({ id: users.id }).from(users).limit(1);

  // Re-home the adopted solution to a foreign tenant and drop the winner row, then re-seed.
  const [win] = await db
    .select({ id: weeklyWinners.id, solutionId: weeklyWinners.solution_id })
    .from(weeklyWinners)
    // ⛔ DERIVED, NEVER A LITERAL. `seedMarketplace` used to stamp a hardcoded `'2026-W21'`, which
    // is exactly the staleness that emptied the demo board; it now derives its week from `now()`.
    // Reading it the same way keeps this a drift check on the SEED rather than on a frozen string.
    .where(eq(weeklyWinners.week, SEED_WEEK));
  // Same reason as the anchor assertion above: a bare `return` here made the whole
  // cross-tenant adoption check pass without running any of it.
  expect(win, `seed winner for week '${SEED_WEEK}' is missing — seedMarketplace() drifted`).toBeDefined();
  expect(author, 'no users exist — the seed did not run').toBeDefined();
  // `expect(...).toBeDefined()` asserts but does not NARROW for the compiler, and `win` is
  // dereferenced below. This throw is unreachable given the assertions above; it exists so
  // the narrowing is real rather than a non-null assertion that would hide a genuine null.
  if (!win || !author) throw new Error('unreachable: asserted defined above');

  await db.delete(weeklyWinners).where(eq(weeklyWinners.id, win.id));
  await db
    .update(solutions)
    .set({ tenant_id: OTHER_TENANT })
    .where(eq(solutions.id, win.solutionId));

  try {
    await seedMarketplace();

    const [after] = await db
      .select({ winnerTenant: weeklyWinners.tenant_id, solutionTenant: solutions.tenant_id })
      .from(weeklyWinners)
      .innerJoin(solutions, eq(solutions.id, weeklyWinners.solution_id))
      .where(eq(weeklyWinners.solution_id, win.solutionId));

    // Whatever it wrote, it must be aligned — and it must NOT have claimed the demo tenant.
    expect(after).toBeDefined();
    expect(after!.winnerTenant).toBe(after!.solutionTenant);
    expect(after!.winnerTenant).not.toBe(DEMO_TENANT_ID);
  } finally {
    // MUST restore even when the assertion above throws. Without the finally a failing run leaves a
    // cross-tenant row behind, and every SUBSEQUENT run of this file fails on the leftover rather
    // than on the code — which reads exactly like a fix that did not work.
    await db.delete(weeklyWinners).where(eq(weeklyWinners.solution_id, win.solutionId));
    await db.update(solutions).set({ tenant_id: DEMO_TENANT_ID }).where(eq(solutions.id, win.solutionId));
    await seedMarketplace();
  }
}, 30_000);
