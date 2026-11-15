// tests/marketplace-i18n.test.ts — §5B UGC overlay on the two surfaces that never had one.
//
// ⛔ THE DEFECT. `getTranslationsBatch` + `negotiateLocale` are called by
// routes/{challenges,solutions,blocks}.ts and ontology-service.ts — but NOT by
// marketplace-summary.ts, which serves BOTH `/api/home/summary` and `/api/winner`. So the same
// challenge showed its Dutch title on /challenges and its English original in home's Trending
// card and on /winner, one click apart. 721 content_translations rows exist in prod, so the
// inconsistency was live on every page load, in every non-English locale.
//
// ⚠️ EVERY CASE IS PAIRED nl + en, AND THAT PAIRING IS THE TEST. `getTranslationsBatch`
// SHORT-CIRCUITS to an empty map for the default locale, so an `nl`-only assertion passes
// identically whether the overlay is wired or not (a route that always returns the base column
// satisfies it just as well). The `en` case is what forces the nl string to have come from
// `content_translations` rather than from the row.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerMarketplaceSummaryRoutes } from '../src/routes/marketplace-summary';
import { db, users, challenges, solutions, votes, weeklyWinners, contentTranslations } from '../src/db/client';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000cd18001';
const user: User = { id: UID, email: 'mkti18n@test', name: 'Mika Tien', roles: ['employee'], tenantId: UID };
const MARK = 'ZMKTI18N';
const WEEK = '2096-W50';

const router = new Router();
registerMarketplaceSummaryRoutes(router);

async function call(path: string, locale: string) {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const req = new Request(`http://localhost${path}`, { method: 'GET', headers: { 'accept-language': locale } });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let challengeId = '';
let winnerId = '';
let mentionId = '';

async function cleanup() {
  await db.delete(weeklyWinners).where(eq(weeklyWinners.week, WEEK));
  const chIds = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  if (chIds.length) {
    const solIds = (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, chIds))).map((r) => r.id);
    for (const id of [...chIds, ...solIds]) await db.delete(contentTranslations).where(eq(contentTranslations.entity_id, id));
    await db.delete(votes).where(inArray(votes.target_id, [...chIds, ...solIds]));
    if (solIds.length) await db.delete(solutions).where(inArray(solutions.id, solIds));
    await db.delete(challenges).where(inArray(challenges.id, chIds));
  }
  await db.delete(users).where(eq(users.id, UID));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name, avatar_initials: 'MT' }).onConflictDoNothing();
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });

  // A challenge the caller submitted AND voted on, so it appears in all three of home's lists:
  // trending, yourActivity.submitted and yourActivity.votedOn. One fixture, three overlays.
  const [c] = await db
    .insert(challenges)
    .values({ title: `${MARK} English challenge`, work_area: 'Claims', submitter_id: UID, tenant_id: UID, status: 'voting', votes_count: 4321, week: WEEK })
    .returning();
  challengeId = c!.id;
  await db.insert(votes).values({ user_id: UID, target_type: 'challenge', target_id: challengeId, tenant_id: UID });

  const sols = await db
    .insert(solutions)
    .values([
      { challenge_id: challengeId, title: `${MARK} English winner`, author_id: UID, status: 'shipping', votes_count: 90, blocks_used: [], tenant_id: UID, week: WEEK },
      { challenge_id: challengeId, title: `${MARK} English mention`, author_id: UID, status: 'voting', votes_count: 50, blocks_used: [], tenant_id: UID, week: WEEK },
    ])
    .returning();
  winnerId = sols[0]!.id;
  mentionId = sols[1]!.id;
  await db.insert(weeklyWinners).values({ week: WEEK, solution_id: winnerId, challenge_id: challengeId, tenant_id: UID, stats: { totalVotesCast: 140, solutionsSubmitted: 2 } });

  await db.insert(contentTranslations).values([
    { entity_type: 'challenge', entity_id: challengeId, locale: 'nl', field: 'title', value: 'Nederlandse uitdaging' },
    { entity_type: 'solution', entity_id: winnerId, locale: 'nl', field: 'title', value: 'Nederlandse winnaar' },
    { entity_type: 'solution', entity_id: mentionId, locale: 'nl', field: 'title', value: 'Nederlandse vermelding' },
  ]);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('home trending: nl serves the translated challenge title, en serves the base column', async () => {
  const nl = await call('/api/home/summary', 'nl');
  expect(nl.status).toBe(200);
  const nlRow = nl.json.trending.find((r: { id: string }) => r.id === challengeId);
  expect(nlRow, 'the fixture challenge must be in trending or this test asserts nothing').toBeTruthy();
  expect(nlRow.title).toBe('Nederlandse uitdaging');

  const en = await call('/api/home/summary', 'en');
  const enRow = en.json.trending.find((r: { id: string }) => r.id === challengeId);
  expect(enRow.title).toBe(`${MARK} English challenge`);
});

test('home yourActivity.submitted: nl translated, en base', async () => {
  const nl = await call('/api/home/summary', 'nl');
  const nlRow = nl.json.yourActivity.submitted.find((r: { id: string }) => r.id === challengeId);
  expect(nlRow, 'the fixture must appear in submitted').toBeTruthy();
  expect(nlRow.title).toBe('Nederlandse uitdaging');

  const en = await call('/api/home/summary', 'en');
  expect(en.json.yourActivity.submitted.find((r: { id: string }) => r.id === challengeId).title).toBe(`${MARK} English challenge`);
});

test('home yourActivity.votedOn: nl translated, en base', async () => {
  const nl = await call('/api/home/summary', 'nl');
  const nlRow = nl.json.yourActivity.votedOn.find((r: { id: string }) => r.id === challengeId);
  expect(nlRow, 'the fixture must appear in votedOn').toBeTruthy();
  expect(nlRow.title).toBe('Nederlandse uitdaging');

  const en = await call('/api/home/summary', 'en');
  expect(en.json.yourActivity.votedOn.find((r: { id: string }) => r.id === challengeId).title).toBe(`${MARK} English challenge`);
});

test('winner: the winning solution title is overlaid in nl and is the base column in en', async () => {
  const nl = await call('/api/winner', 'nl');
  expect(nl.status).toBe(200);
  expect(nl.json.winner.solution.id).toBe(winnerId);
  expect(nl.json.winner.solution.title).toBe('Nederlandse winnaar');

  const en = await call('/api/winner', 'en');
  expect(en.json.winner.solution.title).toBe(`${MARK} English winner`);
});

test('winner: the honorable mentions are overlaid in the SAME batch as the winner', async () => {
  const nl = await call('/api/winner', 'nl');
  expect(nl.json.honorableMentions).toHaveLength(1);
  expect(nl.json.honorableMentions[0].id).toBe(mentionId);
  expect(nl.json.honorableMentions[0].title).toBe('Nederlandse vermelding');

  const en = await call('/api/winner', 'en');
  expect(en.json.honorableMentions[0].title).toBe(`${MARK} English mention`);
});

test('winner: the challenge title is overlaid too — /winner must not disagree with /challenges', async () => {
  const nl = await call('/api/winner', 'nl');
  expect(nl.json.winner.challenge.id).toBe(challengeId);
  expect(nl.json.winner.challenge.title).toBe('Nederlandse uitdaging');

  const en = await call('/api/winner', 'en');
  expect(en.json.winner.challenge.title).toBe(`${MARK} English challenge`);
});

test('an untranslated locale falls back to the base column rather than blanking the title', async () => {
  // Only `nl` rows exist. `de` must degrade to the English edition, not to null/'' — the
  // overlay is additive, never destructive.
  const de = await call('/api/winner', 'de');
  expect(de.json.winner.solution.title).toBe(`${MARK} English winner`);
  expect(de.json.winner.challenge.title).toBe(`${MARK} English challenge`);
  expect(de.json.honorableMentions[0].title).toBe(`${MARK} English mention`);
});
