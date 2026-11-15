// tests/search-i18n.test.ts — searching in the language the product is being read in.
//
// ⛔ THE DEFECT. Every discover surface OVERLAYS its text from `content_translations`
// (§5B: routes/challenges.ts, routes/solutions.ts, routes/blocks.ts all call
// `negotiateLocale` + `getTranslationsBatch` before returning) — but the SEARCH predicate
// behind those same routes only ever ILIKEd the ENGLISH base column, and
// routes/search.ts (the topbar) did not know the overlay existed at all. So a Dutch reader
// looking at "Schadeformulieren automatisch samenvatten" on screen and typing
// `schadeformulieren` into the box got 0 rows, `counts.all = 0` and an empty state —
// under a row that was still visibly on the page. Nothing anywhere ILIKEd
// `content_translations`.
//
// ⚠️ EVERY CASE IS PAIRED nl + en, AND THE PAIRING IS THE TEST — the same discipline
// tests/marketplace-i18n.test.ts spells out. The `en` half is what forces the nl hit to have
// come from `content_translations` rather than from a base column that happened to contain
// the token: the Dutch tokens below exist ONLY in translation rows, so under `en` the same
// query must find nothing. An nl-only assertion would pass against a route that ILIKEd
// everything.
//
// The third arm — an ENGLISH query under an `nl` locale — pins the other half of the
// contract: the base column must STILL match (a user types the English product term), and
// what comes back must be the Dutch text the list pages render, not the English base.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerSearchRoutes } from '../src/routes/search';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { registerSolutionRoutes } from '../src/routes/solutions';
import { registerBlockRoutes } from '../src/routes/blocks';
import {
  db,
  users,
  challenges,
  solutions,
  votes,
  buildingBlocks,
  blockVersions,
  contentTranslations,
  withTenantDb,
} from '../src/db/client';
import { emptyDescriptor } from '../src/db/block-types';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c5e0001';
const user: User = { id: UID, email: 'searchi18n@test', name: 'Sanne Zoeker', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const MARK = 'ZI18NSEARCH';

// The base (en) columns carry the *English* tokens; the Dutch tokens exist ONLY in
// content_translations. That separation is what makes the en half of each pair meaningful.
const EN_CHALLENGE = `${MARK} English Zclaimwidget`;
const NL_CHALLENGE = `${MARK} Nederlands Zschadewidget`;
const EN_SOLUTION = `${MARK} English Zsolutionwidget`;
const NL_SOLUTION = `${MARK} Nederlands Zoplossingwidget`;
const GLOBAL_SLUG = 'zi18nsearch-global';
const TENANT_SLUG = 'zi18nsearch-tenant';
const EN_GLOBAL_BLOCK = `${MARK} English Zblockwidget`;
const NL_GLOBAL_BLOCK = `${MARK} Nederlands Zblokwidget`;
const EN_TENANT_BLOCK = `${MARK} English Ztenantblockwidget`;
const NL_TENANT_BLOCK = `${MARK} Nederlands Ztenantblokwidget`;

const BLK_G = '00000000-0000-0000-0000-00000c5e0011';
const BLK_T = '00000000-0000-0000-0000-00000c5e0012';
const VER_G = '00000000-0000-0000-0000-00000c5e0021';
const VER_T = '00000000-0000-0000-0000-00000c5e0022';

const router = new Router();
registerSearchRoutes(router);
registerChallengeRoutes(router);
registerSolutionRoutes(router);
registerBlockRoutes(router);

async function call(path: string, locale: string) {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method: 'GET',
    headers: { 'accept-language': locale },
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let challengeId = '';
let solutionId = '';

async function cleanup() {
  const chIds = (
    await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))
  ).map((r) => r.id);
  if (chIds.length) {
    const solIds = (
      await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, chIds))
    ).map((r) => r.id);
    for (const id of [...chIds, ...solIds]) {
      await db.delete(contentTranslations).where(eq(contentTranslations.entity_id, id));
    }
    await db.delete(votes).where(inArray(votes.target_id, [...chIds, ...solIds]));
    if (solIds.length) await db.delete(solutions).where(inArray(solutions.id, solIds));
    await db.delete(challenges).where(inArray(challenges.id, chIds));
  }
  await db
    .delete(contentTranslations)
    .where(inArray(contentTranslations.entity_id, [GLOBAL_SLUG, `${DEMO_TENANT_ID}:${TENANT_SLUG}`]));
  // Drop the back-pointer before the versions, else `building_blocks_current_version_fk` blocks it.
  await db
    .update(buildingBlocks)
    .set({ current_version_id: null })
    .where(inArray(buildingBlocks.id, [BLK_G, BLK_T]));
  await db.delete(blockVersions).where(inArray(blockVersions.id, [VER_G, VER_T]));
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, [BLK_G, BLK_T]));
  await db.delete(users).where(eq(users.id, UID));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeAll(async () => {
  await cleanup();
  await db
    .insert(users)
    .values({ id: UID, email: user.email, name: user.name, avatar_initials: 'SZ', tenant_id: DEMO_TENANT_ID })
    .onConflictDoNothing();
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });

  const [c] = await db
    .insert(challenges)
    .values({
      title: EN_CHALLENGE,
      work_area: 'Claims',
      submitter_id: UID,
      tenant_id: DEMO_TENANT_ID,
      status: 'voting',
      votes_count: 3,
      week: '2026-W21',
    })
    .returning();
  challengeId = c!.id;

  const [s] = await db
    .insert(solutions)
    .values({
      challenge_id: challengeId,
      title: EN_SOLUTION,
      author_id: UID,
      status: 'voting',
      votes_count: 2,
      blocks_used: [],
      tenant_id: DEMO_TENANT_ID,
      week: '2026-W21',
    })
    .returning();
  solutionId = s!.id;

  // `building_blocks.current_version_id` and `block_versions.block_id` reference each other, so
  // the blocks go in first WITHOUT a current version, then the versions, then the back-pointer.
  // A version is REQUIRED for the topbar: routes/search.ts only offers published blocks
  // (`current_version_id IS NOT NULL`).
  await db.insert(buildingBlocks).values([
    { id: BLK_G, slug: GLOBAL_SLUG, name: EN_GLOBAL_BLOCK, description: 'base prose', category: 'logic', tenant_id: null },
    { id: BLK_T, slug: TENANT_SLUG, name: EN_TENANT_BLOCK, description: 'base prose', category: 'logic', tenant_id: DEMO_TENANT_ID, maintainer_id: UID },
  ]);
  await db.insert(blockVersions).values([
    { id: VER_G, block_id: BLK_G, version: '1.0.0', docs_md: 'EN docs', status: 'stable', descriptor: emptyDescriptor() },
    { id: VER_T, block_id: BLK_T, version: '1.0.0', docs_md: 'EN docs', status: 'stable', descriptor: emptyDescriptor() },
  ]);
  await db.update(buildingBlocks).set({ current_version_id: VER_G }).where(eq(buildingBlocks.id, BLK_G));
  await db.update(buildingBlocks).set({ current_version_id: VER_T }).where(eq(buildingBlocks.id, BLK_T));

  // The Dutch editions. Blocks are keyed by OWNERSHIP (blocks/i18n-key.ts): a global block by
  // its bare slug, a tenant block by `${tenant}:${slug}` — both shapes are exercised.
  await db.insert(contentTranslations).values([
    { entity_type: 'challenge', entity_id: challengeId, locale: 'nl', field: 'title', value: NL_CHALLENGE },
    { entity_type: 'solution', entity_id: solutionId, locale: 'nl', field: 'title', value: NL_SOLUTION },
    { entity_type: 'block', entity_id: GLOBAL_SLUG, locale: 'nl', field: 'name', value: NL_GLOBAL_BLOCK },
    { entity_type: 'block_tenant', entity_id: `${DEMO_TENANT_ID}:${TENANT_SLUG}`, locale: 'nl', field: 'name', value: NL_TENANT_BLOCK },
  ]);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

// ---------------------------------------------------------------------------
// The topbar (GET /api/search) — challenges ∪ solutions ∪ blocks.
// ---------------------------------------------------------------------------

test('topbar: a Dutch query matches the Dutch challenge title, and returns it', async () => {
  const { status, json } = await call('/api/search?q=Zschadewidget', 'nl');
  expect(status).toBe(200);
  const hit = json.challenges.find((c: { id: string }) => c.id === challengeId);
  expect(hit, 'THE DEFECT: the topbar ILIKEd only the EN base column, so a Dutch term found nothing').toBeTruthy();
  expect(hit.title, 'a row matched in Dutch must be RENDERED in Dutch, not in the base edition').toBe(NL_CHALLENGE);
});

test('topbar: the same Dutch query under en finds nothing (non-vacuity)', async () => {
  const { json } = await call('/api/search?q=Zschadewidget', 'en');
  expect(json.challenges.find((c: { id: string }) => c.id === challengeId)).toBeUndefined();
});

test('topbar: an English term still matches under nl, and renders the Dutch title', async () => {
  const { json } = await call('/api/search?q=Zclaimwidget', 'nl');
  const hit = json.challenges.find((c: { id: string }) => c.id === challengeId);
  expect(hit, 'the base column must stay searchable — a user may type the English product term').toBeTruthy();
  expect(hit.title).toBe(NL_CHALLENGE);
});

test('topbar: English query under en is unchanged (no regression)', async () => {
  const { json } = await call('/api/search?q=Zclaimwidget', 'en');
  const hit = json.challenges.find((c: { id: string }) => c.id === challengeId);
  expect(hit).toBeTruthy();
  expect(hit.title).toBe(EN_CHALLENGE);
});

test('topbar: Dutch solution title is matched and returned', async () => {
  const nl = await call('/api/search?q=Zoplossingwidget', 'nl');
  const hit = nl.json.solutions.find((s: { id: string }) => s.id === solutionId);
  expect(hit).toBeTruthy();
  expect(hit.title).toBe(NL_SOLUTION);
  const en = await call('/api/search?q=Zoplossingwidget', 'en');
  expect(en.json.solutions.find((s: { id: string }) => s.id === solutionId)).toBeUndefined();
});

test('topbar: Dutch block name is matched and returned — global AND tenant key', async () => {
  const global = await call('/api/search?q=Zblokwidget', 'nl');
  const gHit = global.json.blocks.find((b: { slug: string }) => b.slug === GLOBAL_SLUG);
  expect(gHit, 'global blocks are keyed by the bare slug').toBeTruthy();
  expect(gHit.name).toBe(NL_GLOBAL_BLOCK);

  const tenant = await call('/api/search?q=Ztenantblokwidget', 'nl');
  const tHit = tenant.json.blocks.find((b: { slug: string }) => b.slug === TENANT_SLUG);
  expect(tHit, 'tenant blocks are keyed by `${tenant}:${slug}` — blocks/i18n-key.ts').toBeTruthy();
  expect(tHit.name).toBe(NL_TENANT_BLOCK);

  const en = await call('/api/search?q=Zblokwidget', 'en');
  expect(en.json.blocks.find((b: { slug: string }) => b.slug === GLOBAL_SLUG)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// The challenge board (GET /api/challenges?q=) — rows AND the counts aggregation.
// ---------------------------------------------------------------------------

test('board: a Dutch query returns the row, in Dutch, and the counts agree with it', async () => {
  const { status, json } = await call('/api/challenges?q=Zschadewidget', 'nl');
  expect(status).toBe(200);
  expect(json.items.length, 'THE DEFECT: `ilike(title, …)` on the EN base column returned 0 rows').toBe(1);
  expect(json.items[0].id).toBe(challengeId);
  expect(json.items[0].title).toBe(NL_CHALLENGE);
  // counts must be computed over the SAME predicate as the rows, or the chips lie about a
  // board that does show the row.
  expect(json.counts.all).toBe(1);
  expect(json.counts.Claims).toBe(1);
  expect(json.total).toBe(1);
});

test('board: the same Dutch query under en returns nothing (non-vacuity)', async () => {
  const { json } = await call('/api/challenges?q=Zschadewidget', 'en');
  expect(json.items.length).toBe(0);
  expect(json.counts.all).toBe(0);
});

test('board: an English term under nl still matches, and renders Dutch', async () => {
  const { json } = await call('/api/challenges?q=Zclaimwidget', 'nl');
  expect(json.items.length).toBe(1);
  expect(json.items[0].title).toBe(NL_CHALLENGE);
  expect(json.counts.all).toBe(1);
});

test('board: English under en is unchanged (no regression)', async () => {
  const { json } = await call('/api/challenges?q=Zclaimwidget', 'en');
  expect(json.items.length).toBe(1);
  expect(json.items[0].title).toBe(EN_CHALLENGE);
  expect(json.counts.all).toBe(1);
});

// ---------------------------------------------------------------------------
// The solution board (GET /api/solutions?q=) and the block library (GET /api/blocks?q=) —
// the same shape, the same box, the same defect.
// ---------------------------------------------------------------------------

test('solution board: a Dutch query returns the row in Dutch, and `total` agrees', async () => {
  const nl = await call('/api/solutions?q=Zoplossingwidget', 'nl');
  expect(nl.json.items.length).toBe(1);
  expect(nl.json.items[0].id).toBe(solutionId);
  expect(nl.json.items[0].title).toBe(NL_SOLUTION);
  expect(nl.json.total, 'rows and total share ONE predicate').toBe(1);

  const en = await call('/api/solutions?q=Zoplossingwidget', 'en');
  expect(en.json.items.length).toBe(0);
  expect(en.json.total).toBe(0);
});

test('block library: a Dutch query returns the block in Dutch — global AND tenant key', async () => {
  const nl = await call('/api/blocks?q=Zblokwidget', 'nl');
  const gHit = nl.json.items.find((b: { slug: string }) => b.slug === GLOBAL_SLUG);
  expect(gHit).toBeTruthy();
  expect(gHit.name).toBe(NL_GLOBAL_BLOCK);

  const nlT = await call('/api/blocks?q=Ztenantblokwidget', 'nl');
  const tHit = nlT.json.items.find((b: { slug: string }) => b.slug === TENANT_SLUG);
  expect(tHit).toBeTruthy();
  expect(tHit.name).toBe(NL_TENANT_BLOCK);

  const en = await call('/api/blocks?q=Zblokwidget', 'en');
  expect(en.json.items.find((b: { slug: string }) => b.slug === GLOBAL_SLUG)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// The shipped demo content — the concrete failure, against the row the seed writes.
// ---------------------------------------------------------------------------

test('the seeded demo challenge is findable by its Dutch title', async () => {
  // seed-marketplace-i18n.ts: en "Auto-summarize claim forms" → nl
  // "Schadeformulieren automatisch samenvatten".
  const board = await call('/api/challenges?q=schadeformulieren', 'nl');
  expect(
    board.json.items.length,
    'a Dutch reader typing a word off their own screen got 0 rows and counts.all = 0',
  ).toBeGreaterThan(0);
  expect(board.json.counts.all).toBe(board.json.items.length);
  expect(board.json.items[0].title.toLowerCase()).toContain('schadeformulieren');

  const topbar = await call('/api/search?q=schadeformulieren', 'nl');
  expect(topbar.json.challenges.length).toBeGreaterThan(0);
  expect(topbar.json.challenges[0].title.toLowerCase()).toContain('schadeformulieren');
});
