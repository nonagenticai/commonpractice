// tests/locale.test.ts — §5B locale wiring: Accept-Language negotiation, the
// /api/me + PATCH /api/me/locale endpoints, and the content_translations
// fallback (locale → en → null). Test rows are isolated to a synthetic user id.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, and } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerMeRoutes } from '../src/routes/me';
import { negotiateLocale } from '../src/utils/locale';
import { getTranslation } from '../src/db/translations';
import { db, users, contentTranslations } from '../src/db/client';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c10ca1e';
const user: User = { id: UID, email: 'loctest@test', name: 'Lo Cale', roles: ['employee'] };
const ENT = 'ztest_book';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerMeRoutes(router);

async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  asUser(user);
  await db
    .insert(users)
    .values({ id: UID, email: user.email, name: user.name, locale: 'en' })
    .onConflictDoNothing({ target: users.id });
}, 30_000);

afterEach(async () => {
  // reset the user's locale between tests
  await db.update(users).set({ locale: 'en' }).where(eq(users.id, UID));
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await db.delete(contentTranslations).where(eq(contentTranslations.entity_id, ENT));
  await db.delete(users).where(eq(users.id, UID));
}, 30_000);

test('negotiateLocale: stored preference wins over Accept-Language', () => {
  const req = new Request('http://x', { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } });
  expect(negotiateLocale(req, 'de')).toBe('de');
});

test('negotiateLocale: parses the first supported base tag', () => {
  const req = new Request('http://x', { headers: { 'accept-language': 'pt-BR,ar-EG;q=0.8,en;q=0.5' } });
  expect(negotiateLocale(req, null)).toBe('ar');
});

test('negotiateLocale: unsupported pref + no header → en', () => {
  expect(negotiateLocale(new Request('http://x'), 'klingon')).toBe('en');
});

test('GET /api/me returns the persisted locale', async () => {
  await db.update(users).set({ locale: 'he' }).where(eq(users.id, UID));
  const r = await call('GET', '/api/me');
  expect(r.status).toBe(200);
  expect(r.json.id).toBe(UID);
  expect(r.json.locale).toBe('he');
});

test('PATCH /api/me/locale persists a supported locale', async () => {
  const r = await call('PATCH', '/api/me/locale', { locale: 'nl' });
  expect(r.status).toBe(200);
  expect(r.json.locale).toBe('nl');
  const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, UID));
  expect(row?.locale).toBe('nl');
});

test('PATCH /api/me/locale rejects an unsupported locale', async () => {
  const r = await call('PATCH', '/api/me/locale', { locale: 'klingon' });
  expect(r.status).toBe(422);
});

test('getTranslation: locale hit, then en fallback, then null', async () => {
  await db.insert(contentTranslations).values([
    { entity_type: 'book', entity_id: ENT, locale: 'en', field: 'content', value: 'EN body' },
    { entity_type: 'book', entity_id: ENT, locale: 'nl', field: 'content', value: 'NL body' },
  ]);
  // exact-locale hit
  expect(await getTranslation('book', ENT, 'nl', 'content')).toBe('NL body');
  // missing locale → en fallback
  expect(await getTranslation('book', ENT, 'de', 'content')).toBe('EN body');
  // missing field entirely → null
  expect(await getTranslation('book', ENT, 'en', 'missing')).toBeNull();
});
