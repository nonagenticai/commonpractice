// tests/seed-marketplace-i18n-tenant-scope.test.ts — the guard for seedMarketplaceI18n's row lookup.
//
// ⛔ THE DEFECT. `seed-marketplace-i18n.ts` resolved the row to translate with
// `.where(eq(challenges.title, c.enTitle)).limit(1)` — no tenant predicate, no ORDER BY. The title
// "Auto-summarize claim forms" is seeded by BOTH the platform marketplace (`seed-marketplace.ts`,
// into DEMO_TENANT_ID) and the tenant showcase (`seed-tenant-showcase.ts`, into whatever tenant it
// is called with — and two other test files in this suite call it with two more). Which of those
// rows received the 7 locales was decided by heap order: a function of the last UPDATE or VACUUM,
// not of anything a reader could name. The visible symptom is a marketplace screen that is Dutch
// after one seed run and English after the next, on the same database, with no code change between.
//
// ⛔ WHY THERE ARE TWO TESTS, AND WHY THE SECOND ONE HIDES THE DEMO ROW.
// The obvious test — "seed with two same-titled rows, assert the demo one won" — is DECORATIVE
// against the un-fixed code, because `.limit(1)` with no ORDER BY may perfectly well hand back the
// demo row anyway. It would pass on the defect roughly as often as not. So:
//   * test 1 is the POSITIVE half: the intended row is translated, and no foreign row is.
//   * test 2 is the NEGATIVE CONTROL, and it is deterministic. It renames the demo-tenant row so
//     that the OLD (title-based) predicate cannot match it at all — leaving the decoy as the only
//     row that predicate can find. Fixed code resolves by `(tenant_id, code)`, ignores the rename,
//     and writes nothing outside DEMO_TENANT_ID; reverted code has exactly one candidate and writes
//     the Dutch prose onto a foreign tenant's challenge. Revert the `eq(challenges.tenant_id, …)`
//     predicate in `seedMarketplaceI18n` and test 2 reds; that is the control, by name.
//
// ⚠️ THE FOREIGN-ROW ASSERTION IS A SET SWEEP, NOT AN ID CHECK, and that is deliberate. Asserting
// only "MY decoy has no rows" would go green on the defect whenever `.limit(1)` happened to pick a
// DIFFERENT foreign row (seed-preservation.test.ts and seed-vote-fabrication-guard.test.ts both
// seed the same title into other tenants against this same database). The assertion below is over
// EVERY challenge outside DEMO_TENANT_ID that carries this title, so no candidate escapes it.
//
// ⚠️ TEST 2 MUTATES A SEEDED ROW AND RESTORES IT IN A `finally`. `beforeAll` additionally repairs
// the title unconditionally, so a crashed earlier run cannot leave the marketplace anchor renamed
// for the rest of the suite.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, users, challenges, solutions, contentTranslations, runAsSystem } from '../src/db/client';
import { seedMarketplace } from '../src/db/seed-marketplace';
import { seedMarketplaceI18n } from '../src/db/seed-marketplace-i18n';
import { DEMO_TENANT_ID } from '../src/config';

/** The marketplace's challenge #1 — the row these translations belong to. */
const EN_TITLE = 'Auto-summarize claim forms';
const CODE = 'CH-284';
/** The `nl` title `seed-marketplace-i18n.ts` writes for it. Landing anywhere else is the defect. */
const NL_TITLE = 'Schadeformulieren automatisch samenvatten';

/** A tenant that is emphatically NOT the demo org. `challenges.tenant_id` is scoped by value with
 *  no FK (schema.ts), so no `tenants` row is required to make this a legal, distinct scope. */
const FOREIGN_TENANT = '00000000-0000-4000-8000-00000ff0e1e1';
const FOREIGN_USER = '00000000-0000-4000-8000-00000ff0e1e2';
/** Marks the decoy so cleanup can find it without matching the real seeded rows. */
const DECOY_MARK = 'ZI18NSCOPE';
/** Test 2's temporary title for the DEMO row. Unique, so nothing else can collide with it. */
const HIDDEN_TITLE = `${DECOY_MARK} temporarily hidden from the title predicate`;

let decoyChallengeId = '';

/** Every challenge OUTSIDE the demo tenant that carries the marketplace's EN title — i.e. every row
 *  the un-fixed lookup could have written to. */
async function foreignCandidateIds(): Promise<string[]> {
  const rows = await db
    .select({ id: challenges.id })
    .from(challenges)
    .where(and(ne(challenges.tenant_id, DEMO_TENANT_ID), eq(challenges.title, EN_TITLE)));
  return rows.map((r) => r.id);
}

/** Challenge translations attached to any of `ids`. Empty is the invariant. */
async function translationsOn(ids: string[]): Promise<{ entity_id: string; locale: string; field: string; value: string }[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      entity_id: contentTranslations.entity_id,
      locale: contentTranslations.locale,
      field: contentTranslations.field,
      value: contentTranslations.value,
    })
    .from(contentTranslations)
    .where(and(eq(contentTranslations.entity_type, 'challenge'), inArray(contentTranslations.entity_id, ids)));
}

async function demoAnchorId(): Promise<string> {
  const [row] = await db
    .select({ id: challenges.id })
    .from(challenges)
    .where(and(eq(challenges.tenant_id, DEMO_TENANT_ID), eq(challenges.code, CODE)));
  expect(row, `the marketplace anchor (tenant ${DEMO_TENANT_ID}, code ${CODE}) is missing — seedMarketplace() drifted`).toBeDefined();
  return row!.id;
}

async function dropDecoy(): Promise<void> {
  const ids = (await db.select({ id: challenges.id }).from(challenges).where(eq(challenges.tenant_id, FOREIGN_TENANT))).map((r) => r.id);
  if (ids.length) {
    const solIds = (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, ids))).map((r) => r.id);
    const allIds = [...ids, ...solIds];
    await db.delete(contentTranslations).where(inArray(contentTranslations.entity_id, allIds));
    await db.delete(solutions).where(inArray(solutions.challenge_id, ids));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
  await db.delete(users).where(eq(users.id, FOREIGN_USER));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks, so a slow one fails as
// "(unnamed) [5003ms]" with no file or cause. Same note as content-i18n.test.ts.
beforeAll(async () => {
  await dropDecoy();
  // Repair a title a crashed earlier run of test 2 may have left renamed, BEFORE seeding.
  await db.update(challenges).set({ title: EN_TITLE }).where(eq(challenges.title, HIDDEN_TITLE));
  // The marketplace must exist for there to be an intended row at all.
  await runAsSystem('boot-seed', () => seedMarketplace());

  // ⚠️ NO `tenant_id` ON THE USER. `users.tenant_id` carries a real FK to `tenants` (schema.ts),
  // so stamping FOREIGN_TENANT here would need a tenants row this test has no reason to create.
  // `challenges.tenant_id` is scoped BY VALUE with no FK — it is the only column that has to carry
  // the foreign scope for this fixture to reproduce the collision.
  await db
    .insert(users)
    .values({ id: FOREIGN_USER, email: 'i18n-scope-foreign@test', name: 'Foreign Tenant Submitter' })
    .onConflictDoNothing({ target: users.id });
  // The decoy: same title, same CH-nnn badge (legal — `challenges_tenant_code_key` is unique per
  // TENANT), different org. This is the shape `seed-tenant-showcase.ts` produces in real life.
  const [decoy] = await db
    .insert(challenges)
    .values({
      title: EN_TITLE,
      description: `${DECOY_MARK} foreign-tenant decoy`,
      business_impact: `${DECOY_MARK} foreign-tenant decoy`,
      work_area: 'Claims',
      submitter_id: FOREIGN_USER,
      tenant_id: FOREIGN_TENANT,
      status: 'solution_phase',
      week: '2026-W21',
      code: CODE,
    })
    .returning({ id: challenges.id });
  decoyChallengeId = decoy!.id;
}, 60_000);

afterAll(async () => {
  await db.update(challenges).set({ title: EN_TITLE }).where(eq(challenges.title, HIDDEN_TITLE));
  await dropDecoy();
}, 30_000);

test('the marketplace i18n seed writes onto the demo tenant\'s challenge, not a same-titled foreign one', async () => {
  const anchorId = await demoAnchorId();

  // Baseline: nothing outside the demo tenant carries a challenge translation yet. Clearing here
  // rather than asserting it establishes a known zero even on a database a previously-red run of
  // this file dirtied — the assertion that matters runs AFTER the seeder, below.
  const before = await foreignCandidateIds();
  expect(before, 'the decoy was not created — the fixture is not exercising the collision').toContain(decoyChallengeId);
  if (before.length) await db.delete(contentTranslations).where(inArray(contentTranslations.entity_id, before));

  const { rows } = await runAsSystem('boot-seed', () => seedMarketplaceI18n());
  expect(rows, 'the seeder resolved no rows at all — it cannot have proved anything').toBeGreaterThan(0);

  // 1. The INTENDED row got the Dutch prose.
  const [nlTitle] = await db
    .select({ value: contentTranslations.value })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, 'challenge'),
        eq(contentTranslations.entity_id, anchorId),
        eq(contentTranslations.locale, 'nl'),
        eq(contentTranslations.field, 'title'),
      ),
    );
  expect(nlTitle?.value).toBe(NL_TITLE);

  // 2. NO foreign-tenant row did — swept over every candidate, not just our decoy.
  const leaked = await translationsOn(await foreignCandidateIds());
  expect(leaked, `the marketplace i18n seed wrote onto ${leaked.length} translation row(s) outside the demo tenant`).toEqual([]);
});

test('NEGATIVE CONTROL — with the demo row unreachable by title, the seeder still writes nothing to a foreign tenant', async () => {
  const anchorId = await demoAnchorId();

  // Hide the demo row from the OLD, title-based predicate. The fixed lookup resolves by
  // (tenant_id, code) and is unaffected; a reverted lookup is left with exactly one candidate —
  // the foreign decoy — so it MUST write there, and the sweep below MUST red.
  await db.update(challenges).set({ title: HIDDEN_TITLE }).where(eq(challenges.id, anchorId));
  try {
    const candidates = await foreignCandidateIds();
    expect(candidates, 'no foreign candidate remains — this control has nothing to catch').toContain(decoyChallengeId);
    await db.delete(contentTranslations).where(inArray(contentTranslations.entity_id, candidates));

    await runAsSystem('boot-seed', () => seedMarketplaceI18n());

    const leaked = await translationsOn(await foreignCandidateIds());
    expect(
      leaked,
      'the row lookup is not tenant-scoped: with the demo row hidden it fell through onto a foreign tenant\'s challenge',
    ).toEqual([]);
  } finally {
    await db.update(challenges).set({ title: EN_TITLE }).where(eq(challenges.id, anchorId));
  }
});
