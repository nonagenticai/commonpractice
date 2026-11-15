// tests/seed-cross-tenant-scope.test.ts — sibling of seed-marketplace-i18n-tenant-scope.test.ts,
// for the two seed-lookup defects that file did not cover.
//
// ⛔ TEST 1 GUARDS A LOOKUP THAT **WRITES**. `seed-example-blocks.ts`'s `upsertGlobalBlock` resolved
// the row to (re)publish with `.where(eq(buildingBlocks.slug, b.slug))` — no tenant predicate, no
// limit. That is not a read-only imprecision. For every block carrying `reversionOnChange` (all
// three ontology-derived DATA blocks), the `changed` branch INSERTS a new `block_versions` row
// against whatever that SELECT returned and REPOINTS its `current_version_id`. So the PLATFORM
// seeder could pick a TENANT's block that merely shares the slug and republish it — on every boot,
// silently, over an author's own current version. `blocks/authoring-service.ts:162` and
// `ontology/data-block-derivation.ts:117` both scope this same "is the platform slug taken" read
// with `isNull(tenant_id)`; the seeder now matches them.
//
// ⛔ TEST 2 GUARDS THE CHALLENGE PICK IN `seed-marketplace.ts`. It had the tenant predicate but
// keyed on `title`, which no index makes unique — `routes/challenges.ts` inserts with no duplicate
// guard, so one tenant may hold two rows with one title and the pick was heap order. The row that
// lookup returns is the parent of all five seeded solutions and, via `lisaSolutionId`, the weekly
// winner. It now keys on `(tenant_id, code)`, which carries the partial unique index
// `challenges_tenant_code_key` (schema.ts:760).
//
// ⛔ WHY BOTH TESTS HIDE THE INTENDED ROW INSTEAD OF JUST ADDING A DECOY.
// The obvious fixture — "two candidates, assert the right one won" — is DECORATIVE against both
// defects, because an unordered one-row `SELECT` may perfectly well hand back the intended row
// anyway; it would pass on the defect roughly as often as not, and a green that is a coin flip is
// worse than no test. So each test makes the INTENDED row unreachable by the OLD predicate, leaving
// the decoy as the ONLY row that predicate can find. Fixed code resolves by the NEW predicate,
// ignores the hiding, and leaves the decoy alone; reverted code has exactly one candidate and MUST
// hit it. Both reds are deterministic, not probabilistic.
//
// ⚠️ BOTH TESTS MUTATE SEEDED ROWS AND RESTORE THEM IN A `finally`, and `beforeAll` additionally
// repairs both mutations unconditionally, so a crashed earlier run cannot leave a slug or a title
// hidden for the rest of the suite. Same convention as seed-marketplace-i18n-tenant-scope.test.ts.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  db,
  users,
  buildingBlocks,
  blockVersions,
  blockTests,
  challenges,
  solutions,
  contentTranslations,
  runAsSystem,
} from '../src/db/client';
import { seedExampleBlocks } from '../src/db/seed-example-blocks';
import { seedMarketplace } from '../src/db/seed-marketplace';
import { requireScannedSource } from '../src/blocks/source-gate';
import { DEMO_TENANT_ID } from '../src/config';

// ───────────────────────────── test 1 fixture constants ─────────────────────────────

/** An ontology-derived data block — i.e. one seeded with `reversionOnChange: true`, which is the
 *  only path that turns this lookup into a WRITE. A hand-authored block would exercise the
 *  find-or-create arm and prove nothing about the overwrite. */
const BLOCK_SLUG = 'example-claim-data';
/** Where the platform block's slug is parked while test 1 runs. Unique, so nothing can collide. */
const HIDDEN_SLUG = 'zz-crosstenant-hidden-example-claim-data';
/** Marks rows this file creates so cleanup can find them without touching seeded ones. */
const MARK = 'ZXTENANTSCOPE';
/** The tenant block's source. Must differ from the compiled data-block source so that
 *  `upsertGlobalBlock`'s `changed` check is TRUE — otherwise the reversion branch never runs and
 *  the defect has no opportunity to fire. A trivially safe module: the source gate scans it. */
const TENANT_SOURCE = `export default {
  async run() {
    return { rows: [], count: 0 };
  }
};
`;

let tenantBlockId = '';
let tenantVersionId = '';

// ───────────────────────────── test 2 fixture constants ─────────────────────────────

/** The marketplace's challenge #1 and its CH-nnn badge — the row seedMarketplace must resolve. */
const EN_TITLE = 'Auto-summarize claim forms';
const ANCHOR_CODE = 'CH-284';
/** Test 2's temporary title for the anchor, hiding it from the OLD title-based predicate. */
const HIDDEN_TITLE = `${MARK} temporarily hidden from the title predicate`;
/** The same-tenant duplicate. A DIFFERENT code — `challenges_tenant_code_key` forbids two rows
 *  sharing (tenant, code), and it is precisely that index the fixed lookup relies on. Same TITLE,
 *  same tenant: exactly the shape `routes/challenges.ts` can produce, since it inserts with no
 *  duplicate-title guard. */
const DECOY_CODE = 'CH-901';
const DECOY_USER = '00000000-0000-4000-8000-00000cc0e2e1';

let decoyChallengeId = '';

// ───────────────────────────── helpers ─────────────────────────────

async function globalBlockBySlug(slug: string): Promise<{ id: string; current: string | null } | null> {
  const [row] = await db
    .select({ id: buildingBlocks.id, current: buildingBlocks.current_version_id })
    .from(buildingBlocks)
    .where(and(eq(buildingBlocks.slug, slug), isNull(buildingBlocks.tenant_id)));
  return row ?? null;
}

async function versionIdsOf(blockId: string): Promise<string[]> {
  const rows = await db.select({ id: blockVersions.id }).from(blockVersions).where(eq(blockVersions.block_id, blockId));
  return rows.map((r) => r.id);
}

/** Hard-delete a block and everything hanging off it. `current_version_id` is cleared first so the
 *  block → version reference cannot block the version delete whichever way the FK is declared. */
async function dropBlock(blockId: string): Promise<void> {
  await db.update(buildingBlocks).set({ current_version_id: null }).where(eq(buildingBlocks.id, blockId));
  await db.delete(blockTests).where(eq(blockTests.block_id, blockId));
  await db.delete(blockVersions).where(eq(blockVersions.block_id, blockId));
  await db.delete(buildingBlocks).where(eq(buildingBlocks.id, blockId));
}

/** Every block this file created, global or tenant-owned, in whatever state a crashed run left. */
async function dropFixtureBlocks(): Promise<void> {
  const rows = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(and(eq(buildingBlocks.slug, BLOCK_SLUG), eq(buildingBlocks.tenant_id, DEMO_TENANT_ID)));
  for (const r of rows) await dropBlock(r.id);
}

async function dropDecoyChallenges(): Promise<void> {
  const ids = (
    await db
      .select({ id: challenges.id })
      .from(challenges)
      .where(and(eq(challenges.tenant_id, DEMO_TENANT_ID), eq(challenges.code, DECOY_CODE)))
  ).map((r) => r.id);
  if (ids.length) {
    const solIds = (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, ids))).map((r) => r.id);
    const allIds = [...ids, ...solIds];
    await db.delete(contentTranslations).where(inArray(contentTranslations.entity_id, allIds));
    await db.delete(solutions).where(inArray(solutions.challenge_id, ids));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
  await db.delete(users).where(eq(users.id, DECOY_USER));
}

/** Repair anything a crashed earlier run may have left hidden. Unconditional, and BEFORE seeding. */
async function repairHidden(): Promise<void> {
  await db.update(buildingBlocks).set({ slug: BLOCK_SLUG }).where(eq(buildingBlocks.slug, HIDDEN_SLUG));
  await db.update(challenges).set({ title: EN_TITLE }).where(eq(challenges.title, HIDDEN_TITLE));
}

beforeAll(async () => {
  await dropFixtureBlocks();
  await dropDecoyChallenges();
  await repairHidden();

  // The seeded state both tests measure against must exist before either can prove anything.
  await runAsSystem('boot-seed', () => seedExampleBlocks());
  await runAsSystem('boot-seed', () => seedMarketplace());

  // --- test 1 decoy: a TENANT-owned block squatting the platform slug. Legal: `createBlockCore`
  // reserves a slug GLOBALLY (authoring-service.ts:159-167) but nothing makes `slug` unique across
  // tenants, so this row is exactly what a tenant author can mint. DEMO_TENANT_ID is used rather
  // than an invented uuid because `building_blocks.tenant_id` is a real tenant reference and the
  // demo tenant is guaranteed to exist by the platform seed.
  const [tenantBlock] = await db
    .insert(buildingBlocks)
    .values({
      slug: BLOCK_SLUG,
      name: `${MARK} tenant-owned claim data`,
      description: `${MARK} tenant-owned block squatting the platform slug`,
      category: 'data',
      region: 'eu-west',
      cost_class: 'low',
      license: 'internal',
      tenant_id: DEMO_TENANT_ID,
    })
    .returning({ id: buildingBlocks.id });
  tenantBlockId = tenantBlock!.id;

  // Its one and only version. The descriptor is copied from the platform block's current version so
  // this fixture does not have to hand-build a valid `BlockDescriptor`; the SOURCE is deliberately
  // different, which is what makes `upsertGlobalBlock`'s `changed` test true and arms the reversion.
  const platform = await globalBlockBySlug(BLOCK_SLUG);
  expect(
    platform?.current,
    `the platform block '${BLOCK_SLUG}' is absent after seedExampleBlocks() — its ontology entity did not resolve, so this file would be testing a code path that never runs`,
  ).toBeTruthy();
  const [platformVersion] = await db
    .select({ descriptor: blockVersions.descriptor })
    .from(blockVersions)
    .where(eq(blockVersions.id, platform!.current!));

  const [v] = await db
    .insert(blockVersions)
    .values({
      block_id: tenantBlockId,
      version: '3.7.0',
      status: 'stable',
      docs_md: `${MARK} tenant docs`,
      source_ts: requireScannedSource(TENANT_SOURCE),
      descriptor: platformVersion!.descriptor,
      examples: [],
      tests_passing: true,
      published_at: new Date(),
    })
    .returning({ id: blockVersions.id });
  tenantVersionId = v!.id;
  await db.update(buildingBlocks).set({ current_version_id: tenantVersionId }).where(eq(buildingBlocks.id, tenantBlockId));

  // --- test 2 decoy: a second challenge with the SAME title in the SAME tenant.
  await db
    .insert(users)
    .values({ id: DECOY_USER, email: 'xtenant-scope-decoy@test', name: 'Duplicate Title Submitter' })
    .onConflictDoNothing({ target: users.id });
  const [decoy] = await db
    .insert(challenges)
    .values({
      title: EN_TITLE,
      description: `${MARK} same-tenant duplicate title`,
      business_impact: `${MARK} same-tenant duplicate title`,
      work_area: 'Claims',
      submitter_id: DECOY_USER,
      tenant_id: DEMO_TENANT_ID,
      status: 'solution_phase',
      week: '2026-W21',
      code: DECOY_CODE,
    })
    .returning({ id: challenges.id });
  decoyChallengeId = decoy!.id;
}, 120_000);

afterAll(async () => {
  await repairHidden();
  await dropFixtureBlocks();
  await dropDecoyChallenges();
}, 60_000);

// ───────────────────────────── test 1 — DEFECT 1 ─────────────────────────────

test('the platform block seed never republishes a TENANT block that shares the slug', async () => {
  const platformBefore = await globalBlockBySlug(BLOCK_SLUG);
  expect(platformBefore, 'the platform block vanished between beforeAll and this test').not.toBeNull();

  const tenantVersionsBefore = await versionIdsOf(tenantBlockId);
  expect(
    tenantVersionsBefore,
    'the tenant fixture block does not have exactly its one seeded version — the baseline is wrong',
  ).toHaveLength(1);

  // Park the platform row's slug so the OLD, unscoped predicate has exactly ONE candidate: the
  // tenant's block. Without this the un-fixed `.where(eq(slug, …))` might return the platform row
  // anyway and the test would go green on the defect roughly half the time.
  await db.update(buildingBlocks).set({ slug: HIDDEN_SLUG }).where(eq(buildingBlocks.id, platformBefore!.id));
  let createdGlobalId: string | null = null;
  try {
    const candidates = await db
      .select({ id: buildingBlocks.id })
      .from(buildingBlocks)
      .where(eq(buildingBlocks.slug, BLOCK_SLUG));
    expect(
      candidates.map((c) => c.id),
      'the tenant block is not the sole candidate for the unscoped predicate — this test has nothing to catch',
    ).toEqual([tenantBlockId]);

    await runAsSystem('boot-seed', () => seedExampleBlocks());

    // 1. THE OVERWRITE ASSERTION. The reversion branch repoints `current_version_id`; if the seeder
    //    resolved the tenant's row, this is a different uuid.
    const [tenantAfter] = await db
      .select({ current: buildingBlocks.current_version_id, updated: buildingBlocks.updated_at })
      .from(buildingBlocks)
      .where(eq(buildingBlocks.id, tenantBlockId));
    expect(
      tenantAfter?.current,
      "the platform seeder repointed a TENANT block's current_version_id — its lookup is not scoped to global blocks",
    ).toBe(tenantVersionId);

    // 2. THE SAME DEFECT SEEN FROM THE OTHER SIDE. Even if `current_version_id` were somehow
    //    restored, the reversion leaves a new `block_versions` row behind. Asserting the version
    //    SET (not merely the count) means a swap cannot cancel out.
    const tenantVersionsAfter = await versionIdsOf(tenantBlockId);
    expect(
      tenantVersionsAfter,
      "the platform seeder published a new version onto a TENANT block — every boot would add one",
    ).toEqual(tenantVersionsBefore);

    // 3. NON-VACUITY. With the platform slug parked, the fixed lookup finds nothing global and must
    //    CREATE the platform block. If it did not, the seeder skipped this block entirely (a
    //    missing ontology entity, say) and assertions 1-2 above are vacuously green.
    const createdGlobal = await globalBlockBySlug(BLOCK_SLUG);
    expect(
      createdGlobal,
      'the seeder created no global block for this slug — it never reached upsertGlobalBlock, so nothing above was tested',
    ).not.toBeNull();
    createdGlobalId = createdGlobal!.id;
    expect(createdGlobalId, 'the "created" global block is the tenant block — the scope predicate is inverted').not.toBe(tenantBlockId);
  } finally {
    // Remove the block the fixed path created BEFORE restoring the parked slug, so the two can
    // never coexist under one slug.
    if (createdGlobalId) await dropBlock(createdGlobalId);
    await db.update(buildingBlocks).set({ slug: BLOCK_SLUG }).where(eq(buildingBlocks.id, platformBefore!.id));
  }
});

// ───────────────────────────── test 2 — DEFECT 2 ─────────────────────────────

test('the marketplace seed resolves its challenge by (tenant, code), not by a title the tenant can hold twice', async () => {
  const [anchor] = await db
    .select({ id: challenges.id })
    .from(challenges)
    .where(and(eq(challenges.tenant_id, DEMO_TENANT_ID), eq(challenges.code, ANCHOR_CODE)));
  expect(anchor, `the marketplace anchor (tenant ${DEMO_TENANT_ID}, code ${ANCHOR_CODE}) is missing — seedMarketplace() drifted`).toBeDefined();

  // The seeded solutions currently hang off the anchor. That is the invariant under test.
  const solutionsOnAnchorBefore = await db
    .select({ id: solutions.id })
    .from(solutions)
    .where(eq(solutions.challenge_id, anchor!.id));
  expect(
    solutionsOnAnchorBefore.length,
    'no solutions hang off the anchor — seedMarketplace() did not run, so there is nothing to misroute',
  ).toBeGreaterThan(0);

  // Hide the anchor from the OLD title-based predicate, leaving the same-tenant decoy as its only
  // candidate. The fixed lookup keys on `code` and is unaffected.
  await db.update(challenges).set({ title: HIDDEN_TITLE }).where(eq(challenges.id, anchor!.id));
  try {
    const titleCandidates = await db
      .select({ id: challenges.id })
      .from(challenges)
      .where(and(eq(challenges.tenant_id, DEMO_TENANT_ID), eq(challenges.title, EN_TITLE)));
    expect(
      titleCandidates.map((c) => c.id),
      'the decoy is not the sole (tenant, title) candidate — this test has nothing to catch',
    ).toEqual([decoyChallengeId]);

    await runAsSystem('boot-seed', () => seedMarketplace());

    // 1. THE NONDETERMINISM ASSERTION. A title-keyed lookup resolves the decoy and then inserts all
    //    five solutions onto it — and, via `lisaSolutionId`, would hand it the weekly winner.
    const strays = await db
      .select({ id: solutions.id, title: solutions.title })
      .from(solutions)
      .where(eq(solutions.challenge_id, decoyChallengeId));
    expect(
      strays,
      `seedMarketplace attached ${strays.length} solution(s) to a same-titled duplicate: its challenge lookup is keyed on a column the tenant can hold twice`,
    ).toEqual([]);

    // 2. THE POSITIVE HALF. The intended row still owns them — an empty database would satisfy
    //    assertion 1 alone.
    const solutionsOnAnchorAfter = await db
      .select({ id: solutions.id })
      .from(solutions)
      .where(eq(solutions.challenge_id, anchor!.id));
    expect(solutionsOnAnchorAfter.map((s) => s.id).sort()).toEqual(solutionsOnAnchorBefore.map((s) => s.id).sort());

    // 3. AND NO DUPLICATE ANCHOR. A lookup that missed the renamed row would INSERT a second
    //    CH-284 for this tenant; `challenges_tenant_code_key` would raise 23505 first, so this
    //    assertion is a belt on the seeder having taken the skip path, not the insert path.
    const anchors = await db
      .select({ id: challenges.id })
      .from(challenges)
      .where(and(eq(challenges.tenant_id, DEMO_TENANT_ID), eq(challenges.code, ANCHOR_CODE)));
    expect(anchors.map((a) => a.id)).toEqual([anchor!.id]);
  } finally {
    await db.update(challenges).set({ title: EN_TITLE }).where(eq(challenges.id, anchor!.id));
  }
});
