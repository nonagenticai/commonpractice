// tests/ontology-cache-ttl.test.ts — the compiled-ontology cache is unbounded in BOTH time and
// size, and its invalidation never leaves the process.
//
// THE DEFECT this file pins. `compileEffective` memoizes into a module-level `Map` that is only
// ever dropped by `invalidateOntologyCache()`, a bare in-process `compileCache.clear()`. Production
// runs 2 replicas with no sessionAffinity and no DestinationRule, so a write served by pod A clears
// only pod A. Every write handler on /ontology is `await write(); await loadGraph();` and
// `loadGraph()` is a fresh fetch through the Service — it lands on pod B ~50% of the time and pod B
// answers from a cache that has no idea the row changed. With no TTL, pod B stayed stale until it
// happened to serve a write for that tenant or restarted, so the user's own edit flickered in and
// out across page reloads. The same stale graph feeds datasets/mapping-service.ts and the MCP
// tools/resources.
//
// HOW THIS REPRODUCES A TWO-POD RACE IN ONE PROCESS. Phase 1 compiles (populating the cache), then
// the row is inserted **straight through the `db` handle** — NOT via `createTenantEntity`, which
// calls `invalidateOntologyCache()` and would destroy the point. A direct insert is exactly what
// pod B experiences: the table changed underneath it and nothing told it so.
//
// BOTH DIRECTIONS ARE PINNED ON PURPOSE. The after-TTL test alone would pass if someone "fixed" the
// staleness by deleting the memoization outright; the inside-TTL test alone would pass on the
// unfixed source. Only the pair says "the cache still caches, AND it stops lying within a bounded
// window." Measured, not assumed — deleting the cache read turns the inside-TTL partner red, and
// each of removing / inverting the TTL comparison, ignoring the injected clock, removing the size
// bound, setting MAX_ENTRIES to 0, and evicting newest-first turns exactly one test red.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  compileEffective,
  invalidateOntologyCache,
  __cacheStatsForTests,
} from '../src/ontology/ontology-service';
import { seedOntology } from '../src/db/seed-ontology';
import { db, ontologyEntities, tenants } from '../src/db/client';

const ORG = '00000000-0000-0000-0000-00000cac0001';
const INDUSTRY = 'insurance';
const DEPARTMENT = 'Claims';
/** Unique to this file so a leak into another file's compile would be unmistakable. */
const ENTITY = 'ZZCacheTtlProbe';

/** A fixed wall clock. Every read below injects its own `now`, so nothing here depends on how long
 *  the suite takes to run — the TTL boundary is crossed by arithmetic, never by waiting. */
const T0 = 1_760_000_000_000;

/** Did the compiled graph for (ORG, insurance, Claims) contain the probe entity at time `now`? */
async function probeVisible(now: number): Promise<boolean> {
  const compiled = await compileEffective(INDUSTRY, DEPARTMENT, { tenantId: ORG, now });
  return compiled.entities.some((e) => e.name === ENTITY);
}

// The three phases run once, in order, in beforeAll — the ORDER IS LOAD-BEARING. The inside-TTL
// read must happen BEFORE the after-TTL read: the after-TTL read is a miss that re-populates the
// entry with `at = T0 + 6000`, after which a T0 + 4000 read would be a hit on the FRESH value and
// the non-vacuity partner would pass for the wrong reason.
// ⛔ INITIALISED TO `null`, NOT `false`. Two of the three assertions below expect `false`, so
// seeding these with `false` makes them pass when the phases never ran at all — "measured false"
// and "never measured" become indistinguishable, which is exactly the vacuity this file claims to
// guard against. A fresh verifier deleted all three phase assignments and 3 of 4 tests still
// passed. `null` fails both polarities.
const seen: { beforeInsert: boolean | null; insideTtl: boolean | null; afterTtl: boolean | null } = {
  beforeInsert: null,
  insideTtl: null,
  afterTtl: null,
};

async function cleanup() {
  await db.delete(ontologyEntities).where(eq(ontologyEntities.tenant_id, ORG));
  await db.delete(tenants).where(eq(tenants.id, ORG));
}

beforeAll(async () => {
  await seedOntology();
  await cleanup();
  await db
    .insert(tenants)
    .values({ id: ORG, name: 'Cache TTL Org', slug: 'cache-ttl-org', industry: INDUSTRY });
  invalidateOntologyCache();

  // Phase 1 — pod B compiles and caches the cell at T0. The probe does not exist yet.
  seen.beforeInsert = await probeVisible(T0);

  // Phase 2 — pod A writes. Direct insert: no invalidation reaches this process, exactly as no
  // invalidation reaches the other replica in production.
  await db.insert(ontologyEntities).values({
    scope: 'industry_dept',
    industry: INDUSTRY,
    department: DEPARTMENT,
    name: ENTITY,
    label: 'Cache TTL Probe',
    tenant_id: ORG,
  });

  // Phase 3 — pod B is asked again, 4s later (inside the TTL) and 6s later (past it).
  seen.insideTtl = await probeVisible(T0 + 4_000);
  seen.afterTtl = await probeVisible(T0 + 6_000);
}, 60_000);

afterAll(async () => {
  await cleanup();
  invalidateOntologyCache();
}, 30_000);

test('the probe is genuinely absent before the write (the phases are not measuring noise)', () => {
  expect(seen.beforeInsert).toBe(false);
});

// NON-VACUITY PARTNER. Red if the cache read is deleted or bypassed — i.e. if someone "fixes" the
// staleness by throwing the memoization away. Inside the TTL the stale answer is the CORRECT
// behaviour: that is the bargain a cache makes.
//
// NB it is NOT this test that catches `MAX_ENTRIES = 0`, contrary to the obvious guess: eviction
// runs before the `set`, so a zero cap deletes one entry and then still stores the new one. A zero
// cap is caught by the size test below, which requires the newest key to be present.
test('inside the TTL the cross-pod write is still invisible — the cache really caches', () => {
  expect(seen.insideTtl).toBe(false);
});

// THE ASSERTION. Red on the unfixed source, where the entry lives until the process restarts.
test('past the TTL the cross-pod write becomes visible without any in-process invalidation', () => {
  expect(seen.afterTtl).toBe(true);
});

// The key space is caller-controlled: routes/ontology.ts validates only that industry/department
// are non-empty, never that they name a real matrix cell, so `?industry=x&department=<anything>`
// mints a new entry holding a whole compiled graph. Unbounded, that is a memory leak reachable by
// any authenticated caller.
test('the cache is bounded in size, evicting oldest-first', async () => {
  invalidateOntologyCache();
  const { maxEntries } = __cacheStatsForTests();
  // ⛔ PIN THE VALUE, NOT JUST THE MECHANISM. Every other assertion here reads `maxEntries` from
  // the implementation, so the expectation moves with the constant and the cap's SIZE is invisible:
  // a fresh verifier set MAX_ENTRIES = 5000 — 25x the memory this bound exists to prevent — and all
  // four tests still passed. The FIFO mechanism was pinned; the number never was.
  expect(maxEntries).toBe(200);
  const now = T0; // fixed: eviction must be deterministic and owe nothing to the clock
  const departments = Array.from({ length: maxEntries + 50 }, (_, i) => `ZZDept${i}`);
  for (const department of departments) {
    await compileEffective(INDUSTRY, department, { tenantId: ORG, now });
  }

  const stats = __cacheStatsForTests();
  expect(stats.size).toBeLessThanOrEqual(maxEntries);

  const keyFor = (department: string) => `${ORG}::en::${INDUSTRY}::${department}`;
  // Newest survives, oldest was evicted — FIFO, not random.
  expect(stats.keys).toContain(keyFor(departments.at(-1)!));
  expect(stats.keys).not.toContain(keyFor(departments[0]!));

  invalidateOntologyCache();
});
