// tests/metering-reconcile.test.ts — does the reconciler actually notice a disagreement?
//
// ⛔ WHAT IT IS FOR. CP's `usage_events` ledger and billing-service's per-actor totals are two
// independent accounts of the same money, and until `host/metering-reconcile.ts` nothing compared
// them. The estate has been burned by both directions already: 0 rows / $0.00 in
// `billing_cost_events` for months while every local screen looked perfect, and — before migration
// 0090 — 100 % of central spend landing `unlicensed` because the emit sent `users.id` where a
// licences Subject was expected. The second one is why the comparison is PER-ACTOR: the TOTAL was
// right throughout, so any check that summed by tenant would have passed happily.
//
// ⛔ AND THE CASES BELOW ARE MOSTLY ABOUT WHEN IT MUST **NOT** FIRE. A reconciler that reports a
// mismatch on a healthy day is worse than none: the alert is muted within a week, and the real
// under-count is then invisible for exactly the reason it was invisible the first time. So there
// are as many "this is NOT a mismatch" cases here as "this IS".
//
// ⚠️ EVERY CASE NAMES ITS MUTATION TARGET, per the house discipline (tests/user-service.test.ts).
//
// ⛔ THE DAY IS 2001-02-03, AND THAT IS NOT DECORATION. `reconcileMeteringDay` reads ACROSS ALL
// TENANTS (it is a scheduler tick, not a request), so every `usage_events` row this suite has ever
// written is in its scan's way. Pinning the fixture to a day two decades before this repo existed
// makes the population exactly the rows seeded below — no other file can contribute to a total
// asserted here, and the assertions can be exact numbers instead of deltas.
//
// Fixture ids use the `…00000d2c…` prefix, which no other test file uses — see
// tests/fixture-id-collisions.test.ts.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray, sql } from 'drizzle-orm';
import { db, users, tenants, usageEvents } from '../src/db/client';
import {
  reconcileMeteringDay,
  previousUtcDay,
  MISMATCH_EPSILON_USD,
  RECONCILE_MISMATCH_USD_GAUGE,
  RECONCILE_TENANTS_COMPARED_GAUGE,
} from '../src/host/metering-reconcile';
import { TICK_LOCK, TICK_MIN_INTERVAL_MS, meteringReconcileTickKey } from '../src/host/tick-locks';
import {
  __setBillingAdminForTests,
  BillingAdminError,
  type BillingAdminClient,
  type BillingActorCost,
  type BillingInvoice,
  type BillingInvoicePreview,
} from '../src/services/billing-admin';

const DAY = '2001-02-03';
const AT = new Date(`${DAY}T12:00:00Z`);

const TENANT = '00000000-0000-0000-0000-00000d2c0a01';
const USER_1 = '00000000-0000-0000-0000-00000d2c1001';
const USER_2 = '00000000-0000-0000-0000-00000d2c1002';
const SUBJECT_1 = '00000000-0000-0000-0000-00000d2c5001';
const SUBJECT_2 = '00000000-0000-0000-0000-00000d2c5002';
const USER_IDS = [USER_1, USER_2];

/**
 * Seed one settled ledger row: a `usage_events` row PLUS the `metering_outbox` row marked `sent`.
 *
 * ⛔ THE OUTBOX ROW IS THE POINT, NOT BOILERPLATE. `metering-reconcile.ts`'s `SETTLED_ONLY`
 * compares only rows Redis has acknowledged, because an undelivered row is legitimately absent
 * from billing and reporting it would make the reconciler fire on every healthy day the drainer
 * happened to be behind. A fixture that skipped the outbox row would therefore seed rows the
 * reconciler correctly ignores, and every assertion below would read 0 — a suite that passes by
 * measuring nothing.
 */
async function settledRow(opts: {
  userId: string;
  subjectId: string | null;
  costUsd: string;
}): Promise<string> {
  const [row] = await db
    .insert(usageEvents)
    .values({
      tenant_id: TENANT,
      user_id: opts.userId,
      provider: 'stub',
      model: 'm',
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: opts.costUsd,
      price_source: 'provider',
      license_subject_id: opts.subjectId,
      created_at: AT,
    })
    .returning({ id: usageEvents.id });
  const id = row!.id;
  await db.execute(sql`
    INSERT INTO metering_outbox (tenant_id, usage_event_id, fields, status, sent_at)
    VALUES (${TENANT}::uuid, ${id}::uuid, '{}'::jsonb, 'sent', now())
  `);
  return id;
}

/** A ledger row the drainer has NOT delivered yet — committed locally, correctly absent at billing. */
async function pendingRow(opts: { userId: string; subjectId: string; costUsd: string }): Promise<void> {
  const [row] = await db
    .insert(usageEvents)
    .values({
      tenant_id: TENANT,
      user_id: opts.userId,
      provider: 'stub',
      model: 'm',
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: opts.costUsd,
      price_source: 'provider',
      license_subject_id: opts.subjectId,
      created_at: AT,
    })
    .returning({ id: usageEvents.id });
  await db.execute(sql`
    INSERT INTO metering_outbox (tenant_id, usage_event_id, fields, status)
    VALUES (${TENANT}::uuid, ${row!.id}::uuid, '{}'::jsonb, 'pending')
  `);
}

/** A billing client that answers `actorCosts` from a canned table and records what it was asked. */
function fakeBilling(
  actors: BillingActorCost[] | (() => never),
): { client: BillingAdminClient; asked: { tenantId: string; start: string; end: string }[] } {
  const asked: { tenantId: string; start: string; end: string }[] = [];
  const client: BillingAdminClient = {
    async actorCosts(tenantId, start, end): Promise<BillingActorCost[]> {
      asked.push({ tenantId, start, end });
      if (typeof actors === 'function') return actors();
      return actors;
    },
    async invoicePreview(): Promise<BillingInvoicePreview> {
      throw new Error('not used by the reconciler');
    },
    async invoices(): Promise<BillingInvoice[]> {
      throw new Error('not used by the reconciler');
    },
    async invoice(): Promise<BillingInvoice> {
      throw new Error('not used by the reconciler');
    },
  };
  return { client, asked };
}

const actor = (subjectId: string, costUsd: number, events = 1): BillingActorCost => ({
  subjectId,
  actorId: '',
  costUsd,
  events,
});

async function cleanup(): Promise<void> {
  // metering_outbox.usage_event_id is ON DELETE CASCADE, so removing the ledger rows removes the
  // outbox rows with them — no separate delete, and no chance of orphaning one half of the pair.
  await db.delete(usageEvents).where(inArray(usageEvents.user_id, USER_IDS));
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, USER_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks; see
// license-provisioning.test.ts for the full note.
beforeEach(async () => {
  await cleanup();
  await db
    .insert(tenants)
    .values({ id: TENANT, name: 'Reconcile Tenant', slug: 'reconcile-d2c' })
    .onConflictDoNothing({ target: tenants.id });
  await db
    .insert(users)
    .values([
      { id: USER_1, email: 'u1@d2c', name: 'U1', tenant_id: TENANT },
      { id: USER_2, email: 'u2@d2c', name: 'U2', tenant_id: TENANT },
    ])
    .onConflictDoNothing({ target: users.id });
}, 30_000);

afterAll(async () => {
  __setBillingAdminForTests(undefined);
  await cleanup();
}, 30_000);

// ---- agreement ---------------------------------------------------------------------------------

/**
 * MUTATION TARGET: the epsilon comparison
 * `if (Math.abs(deltaUsd) <= MISMATCH_EPSILON_USD) continue;` in `reconcileMeteringDay`, and the
 * `SUBJECT_KEY` fragment it joins on.
 *
 * ⛔ THE ZERO IS ONLY MEANINGFUL BESIDE `tenantsCompared`, WHICH IS WHY BOTH ARE ASSERTED.
 * `mismatchUsd === 0` is the value this function returns when the two ledgers agree AND the value
 * it returns when it compared nothing at all — a disabled flag, a billing outage, an empty day.
 * Asserting the zero alone would be a gate that cannot fail; asserting the denominator with it is
 * what makes it a measurement.
 */
test('⛔ agreement reports ZERO mismatch — and a non-zero denominator that makes the zero mean something', async () => {
  await settledRow({ userId: USER_1, subjectId: SUBJECT_1, costUsd: '1.500000' });
  await settledRow({ userId: USER_2, subjectId: SUBJECT_2, costUsd: '2.250000' });
  const { client, asked } = fakeBilling([actor(SUBJECT_1, 1.5), actor(SUBJECT_2, 2.25)]);
  __setBillingAdminForTests(client);

  const out = await reconcileMeteringDay(DAY);

  expect(out.mismatchUsd).toBe(0);
  expect(out.actorsMismatched).toBe(0);
  expect(out.deltas).toEqual([]);
  // THE DENOMINATORS. Without these three the zero above proves nothing.
  expect(out.tenantsCompared).toBe(1);
  expect(out.tenantsUnavailable).toBe(0);
  expect(out.actorsCompared).toBe(2);
  // …and billing really was asked, for THIS tenant and THIS single day (start === end).
  expect(asked).toEqual([{ tenantId: TENANT, start: DAY, end: DAY }]);
});

// ---- disagreement ------------------------------------------------------------------------------

/**
 * MUTATION TARGET: `const deltaUsd = cp.usd - bill.usd;` and the `deltas.push({...})` that follows
 * it in `reconcileMeteringDay`.
 *
 * The induced delta is 0.50 on ONE of two actors, with the other in perfect agreement — so a
 * mutation that reported every actor, or that summed the tenant instead of the actor, is caught by
 * `actorsMismatched` being exactly 1 rather than by the money alone.
 */
test('⛔ an induced per-actor delta is reported, named by SUBJECT, with the healthy actor untouched', async () => {
  await settledRow({ userId: USER_1, subjectId: SUBJECT_1, costUsd: '1.500000' });
  await settledRow({ userId: USER_2, subjectId: SUBJECT_2, costUsd: '2.250000' });
  // Billing is missing $0.50 of SUBJECT_1's spend; SUBJECT_2 agrees exactly.
  __setBillingAdminForTests(fakeBilling([actor(SUBJECT_1, 1.0), actor(SUBJECT_2, 2.25)]).client);

  const out = await reconcileMeteringDay(DAY);

  expect(out.actorsCompared).toBe(2);
  expect(out.actorsMismatched).toBe(1);
  expect(out.mismatchUsd).toBeCloseTo(0.5, 8);
  expect(out.deltas).toHaveLength(1);
  const d = out.deltas[0]!;
  expect(d.subjectId).toBe(SUBJECT_1);
  expect(d.cpUsd).toBeCloseTo(1.5, 8);
  expect(d.billingUsd).toBeCloseTo(1.0, 8);
  // SIGN IS LOAD-BEARING: positive means CP has MORE than billing, i.e. spend that was sent and
  // never landed. Flipping the subtraction would still produce a "mismatch" and would point an
  // operator at over-billing when the defect is under-billing.
  expect(d.deltaUsd).toBeGreaterThan(0);
});

/**
 * MUTATION TARGET: the union in
 * `for (const subjectId of new Set([...cpActors.keys(), ...billingActors.keys()]))`.
 *
 * ⛔ ITERATING CP'S KEYS ALONE IS THE OBVIOUS SPELLING AND IT IS STRUCTURALLY BLIND TO THE WORSE
 * DEFECT. An actor billing has that CP does not means spend was attributed — and invoiced — to
 * somebody this ledger never credited. That is money leaving on a bill CP cannot explain, and a
 * CP-keyed loop cannot see it at all: not a small delta, no row, no finding.
 */
test('⛔ an actor BILLING has and CP does not is a mismatch too', async () => {
  await settledRow({ userId: USER_1, subjectId: SUBJECT_1, costUsd: '1.500000' });
  __setBillingAdminForTests(
    fakeBilling([actor(SUBJECT_1, 1.5), actor(SUBJECT_2, 7.0, 3)]).client,
  );

  const out = await reconcileMeteringDay(DAY);

  expect(out.actorsCompared).toBe(2);
  expect(out.actorsMismatched).toBe(1);
  const d = out.deltas[0]!;
  expect(d.subjectId).toBe(SUBJECT_2);
  expect(d.cpUsd).toBe(0);
  expect(d.billingUsd).toBeCloseTo(7.0, 8);
  expect(d.deltaUsd).toBeLessThan(0); // billing has MORE — the opposite sign, and it must show
});

// ---- when it must NOT fire ---------------------------------------------------------------------

/**
 * MUTATION TARGET: the `SETTLED_ONLY` fragment (`EXISTS (… metering_outbox … status = 'sent')`) in
 * `cpSettledDay`. Delete it — "why filter, we want to compare everything" — and this case reds.
 *
 * ⛔ THIS IS THE CASE THAT DECIDES WHETHER THE ALERT SURVIVES CONTACT WITH PRODUCTION. The outbox
 * exists so a Redis outage DELAYS spend instead of losing it, so there is always a legitimate
 * population of committed rows billing has correctly not seen. Comparing them would report that
 * healthy backlog as missing money every single day — and the backlog already has its own
 * instrument (`commonpractice_metering_outbox_pending` / `…_oldest_pending_age_seconds`). Two
 * questions, two instruments.
 */
test('⛔ an UNDELIVERED ledger row is NOT a mismatch — the outbox backlog is not missing money', async () => {
  await settledRow({ userId: USER_1, subjectId: SUBJECT_1, costUsd: '1.500000' });
  // $99 committed locally and still queued. Billing has correctly never heard of it.
  await pendingRow({ userId: USER_2, subjectId: SUBJECT_2, costUsd: '99.000000' });
  __setBillingAdminForTests(fakeBilling([actor(SUBJECT_1, 1.5)]).client);

  const out = await reconcileMeteringDay(DAY);

  expect(out.mismatchUsd).toBe(0);
  expect(out.actorsMismatched).toBe(0);
  // NON-VACUITY: the settled row WAS compared, so the zero above is the pending row being excluded
  // and not the whole day being skipped.
  expect(out.tenantsCompared).toBe(1);
  expect(out.actorsCompared).toBe(1);

  // …and the proof that the $99 row is really there and really would have been found: mark it
  // sent, and the same comparison now reports it.
  await db.execute(
    sql`UPDATE metering_outbox SET status = 'sent', sent_at = now() WHERE tenant_id = ${TENANT}::uuid AND status = 'pending'`,
  );
  const after = await reconcileMeteringDay(DAY);
  expect(after.actorsMismatched).toBe(1);
  expect(after.mismatchUsd).toBeCloseTo(99, 8);
});

/**
 * MUTATION TARGET: `MISMATCH_EPSILON_USD` and the `<=` comparison that uses it.
 *
 * ⛔ THE TOLERANCE MUST BE THE LEDGER'S PRECISION, NOT A CENT. `usage_events.cost_usd` is
 * `numeric(12,6)` and the wire carries `.toFixed(8)`, so exact equality would red on a healthy
 * day's last digit. But this deployment's ENTIRE metered traffic priced out at $1.09 for the month
 * of August — so a $0.01 tolerance would swallow essentially every disagreement the tick exists to
 * find. Both directions are asserted: a sub-epsilon difference is not a finding, and a difference
 * one order of magnitude above it is.
 */
test('⛔ the tolerance is the ledgers own precision — not a cent, and not zero', async () => {
  await settledRow({ userId: USER_1, subjectId: SUBJECT_1, costUsd: '1.500000' });

  // Below the epsilon: rounding, not drift.
  __setBillingAdminForTests(fakeBilling([actor(SUBJECT_1, 1.5 - MISMATCH_EPSILON_USD / 2)]).client);
  expect((await reconcileMeteringDay(DAY)).actorsMismatched).toBe(0);

  // A tenth of a cent — comfortably above the epsilon and FAR below a cent. This is the assertion
  // that reds if somebody "rounds to the nearest cent" for tidiness.
  __setBillingAdminForTests(fakeBilling([actor(SUBJECT_1, 1.499)]).client);
  const out = await reconcileMeteringDay(DAY);
  expect(out.actorsMismatched).toBe(1);
  expect(out.mismatchUsd).toBeCloseTo(0.001, 8);
});

/**
 * MUTATION TARGET: the `catch` around `client.actorCosts(...)` in `reconcileMeteringDay` — the
 * `tenantsUnavailable++; continue;` branch.
 *
 * ⛔ A FAILED READ IS NOT `$0`. The tempting `catch { return [] }` would treat an unreachable
 * billing as "billing has nothing for this tenant" and report the tenant's ENTIRE day as missing
 * money — a maximally alarming finding manufactured by an outage, pointing at an accounting
 * failure that is not happening. The tenant is counted as UNCOMPARED instead, and
 * `tenantsUnavailable` is what stops the resulting zero from reading as agreement.
 */
test('⛔ a billing outage does NOT become a 100% mismatch — the tenant is counted as uncompared', async () => {
  await settledRow({ userId: USER_1, subjectId: SUBJECT_1, costUsd: '1.500000' });
  __setBillingAdminForTests(
    fakeBilling((): never => {
      throw new BillingAdminError(503, 'billing admin transport error: connect ECONNREFUSED');
    }).client,
  );

  const out = await reconcileMeteringDay(DAY);

  expect(out.tenantsUnavailable).toBe(1);
  expect(out.tenantsCompared).toBe(0);
  expect(out.actorsCompared).toBe(0);
  expect(out.actorsMismatched).toBe(0);
  // The mismatch total IS zero — and it is only readable as "no drift" because `tenantsCompared`
  // above is 0, which is exactly why an alert on the mismatch gauge alone is a gate that cannot
  // fail. See the gauge block at the top of host/metering-reconcile.ts.
  expect(out.mismatchUsd).toBe(0);
});

/**
 * MUTATION TARGET: `SUBJECT_KEY` (`COALESCE(ue.license_subject_id::text, '')`) in
 * host/metering-reconcile.ts.
 *
 * ⛔ A NULL SUBJECT IS A REAL BUCKET ON BOTH SIDES, NOT A ROW TO DROP. It is spend that settled
 * while the member held no entitlement, and billing keeps the same unattributed bucket. Dropping
 * it would hide precisely the rows most likely to disagree — the ones whose attribution is already
 * known to be incomplete — while making the report look cleaner.
 */
test('⛔ spend with NO subject is compared as the unattributed bucket, not discarded', async () => {
  await settledRow({ userId: USER_1, subjectId: null, costUsd: '3.000000' });
  // Billing reports $1 in its own unattributed bucket. $2 of the day is unaccounted for.
  __setBillingAdminForTests(fakeBilling([actor('', 1.0)]).client);

  const out = await reconcileMeteringDay(DAY);

  expect(out.actorsCompared).toBe(1);
  expect(out.actorsMismatched).toBe(1);
  expect(out.deltas[0]!.subjectId).toBe('');
  expect(out.mismatchUsd).toBeCloseTo(2, 8);
});

// ---- registration + keying ---------------------------------------------------------------------

/**
 * MUTATION TARGET: the `meteringReconcile` entries in `TICK_LOCK` / `TICK_MIN_INTERVAL_MS` and the
 * `meteringReconcileTickKey` helper (src/host/tick-locks.ts).
 *
 * ⛔ THE PER-DAY KEY IS NOT STYLE. The reconciler fires daily under a 12 h claim window — the same
 * order of magnitude as its period, which is the `cycle` / `auditExport` shape. With a bare
 * cadence key a deploy's boot catch-up consumes that day's window and the scheduled run is refused,
 * silently (a refused claim resolves to `undefined`; it does not throw). That exact pairing cost
 * ~27 h of unclosed marketplace cycle and two missing compliance exports. Asserting the key is
 * per-day is asserting the fix.
 *
 * ⚠️ AND THE KEY MUST STILL BE IN THE REGISTRY. `TICK_LOCK` is the one place that answers "which
 * ticks exist"; a key that lived only inside a template string at its call site would be invisible
 * to it, which is how `runLeaseReconciler` hid for months.
 */
test('⛔ the reconcile tick is registered in TICK_LOCK and keyed PER UTC DAY', () => {
  expect(TICK_LOCK.meteringReconcile).toBe('metering_reconcile');
  expect(meteringReconcileTickKey('2026-09-17')).toBe('metering_reconcile:2026-09-17');
  // Two different days are two different claims — the property the bare key does not have.
  expect(meteringReconcileTickKey('2026-09-17')).not.toBe(meteringReconcileTickKey('2026-09-18'));

  // The window sits strictly below the 24 h fire period, which is the invariant every entry in
  // TICK_MIN_INTERVAL_MS is written against.
  expect(TICK_MIN_INTERVAL_MS.meteringReconcile).toBeLessThan(24 * 60 * 60 * 1000);

  // `previousUtcDay` is what the scheduler feeds that key: YESTERDAY, never today. Today's day is
  // incomplete — billing's consumer has not flushed it — so reconciling it would report a
  // shortfall on every single run.
  expect(previousUtcDay(new Date('2026-03-01T00:30:00Z'))).toBe('2026-02-28');
  expect(previousUtcDay(new Date('2026-01-01T23:59:00Z'))).toBe('2025-12-31');
});

/**
 * ⚠️ NOT AN ASSERTION — A RECORDED GAP, deliberately left un-tested rather than silently assumed.
 *
 * `reconcileMeteringDay` calls `setGauge` for four names, and `host/metrics.ts setGauge` SILENTLY
 * IGNORES any name outside `PRESEEDED_GAUGES`. Those four are not registered there yet (that file
 * is owned by another change in flight), so every one of those calls is a no-op and `/metrics`
 * carries no reconcile series at all. A test asserting the series renders would red the build for
 * a reason that is not this change's to fix; a test asserting it does NOT render would have to be
 * deleted the moment it is. So neither is written — the names are asserted to be the constants the
 * call sites use, which is the half that CAN drift inside this file, and the registration is
 * reported as an outstanding item.
 */
test('the gauge names the call sites use are the exported constants (the registration itself is pending)', () => {
  expect(RECONCILE_MISMATCH_USD_GAUGE).toBe('metering_reconcile_mismatch_usd');
  expect(RECONCILE_TENANTS_COMPARED_GAUGE).toBe('metering_reconcile_tenants_compared');
});
