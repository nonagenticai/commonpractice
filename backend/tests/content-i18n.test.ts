// tests/content-i18n.test.ts — §5B UGC i18n overlay. A challenge/solution's
// localizable fields (title/description/business_impact) are overlaid from
// content_translations by the request's Accept-Language, with EN base-column
// fallback when a field has no translation. Covers list + detail, both routes.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { registerSolutionRoutes } from '../src/routes/solutions';
import { db, users, challenges, solutions, votes, comments, contentTranslations } from '../src/db/client';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c118001';
const user: User = { id: UID, email: 'i18ntest@test', name: 'Iris i18n', roles: ['employee'] };
const MARK = 'ZI18NTEST';

const router = new Router();
registerChallengeRoutes(router);
registerSolutionRoutes(router);

async function call(method: string, path: string, locale?: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const headers: Record<string, string> = {};
  if (locale) headers['accept-language'] = locale;
  const req = new Request(`http://localhost${path}`, { method, headers });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let challengeId = '';
let solutionId = '';

async function cleanup() {
  const ids = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(votes).where(inArray(votes.target_id, ids));
    await db.delete(comments).where(inArray(comments.challenge_id, ids));
    const solIds = (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, ids))).map((r) => r.id);
    if (solIds.length) {
      await db.delete(votes).where(inArray(votes.target_id, solIds));
      for (const sid of solIds) await db.delete(contentTranslations).where(eq(contentTranslations.entity_id, sid));
    }
    await db.delete(solutions).where(inArray(solutions.challenge_id, ids));
    for (const cid of ids) await db.delete(contentTranslations).where(eq(contentTranslations.entity_id, cid));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
  await db.delete(users).where(eq(users.id, UID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name, avatar_initials: 'II' }).onConflictDoNothing();
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });

  const [c] = await db
    .insert(challenges)
    .values({
      title: `${MARK} English title`,
      description: 'English description',
      business_impact: 'English impact',
      work_area: 'Claims',
      submitter_id: UID,
      tenant_id: UID,
      status: 'voting',
      votes_count: 999,
      week: '2026-W21',
    })
    .returning();
  challengeId = c!.id;

  const [s] = await db
    .insert(solutions)
    .values({ challenge_id: challengeId, tenant_id: UID, title: `${MARK} English solution`, author_id: UID, votes_count: 5, blocks_used: ['ai-summarize'] })
    .returning();
  solutionId = s!.id;

  // Arabic: translate the challenge title + description (NOT business_impact → fallback).
  await db.insert(contentTranslations).values([
    { entity_type: 'challenge', entity_id: challengeId, locale: 'ar', field: 'title', value: 'عنوان عربي' },
    { entity_type: 'challenge', entity_id: challengeId, locale: 'ar', field: 'description', value: 'وصف عربي' },
    { entity_type: 'solution', entity_id: solutionId, locale: 'ar', field: 'title', value: 'حل عربي' },
  ]);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('detail: Accept-Language ar overlays title+description, falls back to en for the untranslated field', async () => {
  const ar = await call('GET', `/api/challenges/${challengeId}`, 'ar');
  expect(ar.status).toBe(200);
  expect(ar.json.title).toBe('عنوان عربي');
  expect(ar.json.description).toBe('وصف عربي');
  // business_impact has no ar row → English base column survives.
  expect(ar.json.businessImpact).toBe('English impact');
  // nested solution title is overlaid too.
  expect(ar.json.solutions[0].title).toBe('حل عربي');
});

test('detail: en (and unsupported locales) returns the base English columns', async () => {
  const en = await call('GET', `/api/challenges/${challengeId}`, 'en');
  expect(en.json.title).toBe(`${MARK} English title`);
  expect(en.json.description).toBe('English description');

  // An unsupported Accept-Language negotiates to en → base columns.
  const zz = await call('GET', `/api/challenges/${challengeId}`, 'zz');
  expect(zz.json.title).toBe(`${MARK} English title`);
});

test('list: Accept-Language ar localizes the challenge card title', async () => {
  const ar = await call('GET', `/api/challenges?q=${MARK}`, 'ar');
  const row = ar.json.items.find((i: { id: string }) => i.id === challengeId);
  expect(row.title).toBe('عنوان عربي');

  const en = await call('GET', `/api/challenges?q=${MARK}`, 'en');
  const enRow = en.json.items.find((i: { id: string }) => i.id === challengeId);
  expect(enRow.title).toBe(`${MARK} English title`);
});

test('solution detail: Accept-Language ar overlays the solution + challenge title', async () => {
  const ar = await call('GET', `/api/solutions/${solutionId}`, 'ar');
  expect(ar.status).toBe(200);
  expect(ar.json.title).toBe('حل عربي');
  expect(ar.json.challenge.title).toBe('عنوان عربي');
});

test('solution list: Accept-Language ar localizes the solution title + scoped challenge header', async () => {
  const ar = await call('GET', `/api/solutions?challenge_id=${challengeId}`, 'ar');
  const row = ar.json.items.find((i: { id: string }) => i.id === solutionId);
  expect(row.title).toBe('حل عربي');
  expect(ar.json.challenge.title).toBe('عنوان عربي');
});
