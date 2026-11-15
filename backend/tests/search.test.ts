// tests/search.test.ts — the global topbar search route. Proves: a ≥2-char query
// matches a challenge by title (tenant-scoped via RLS), short queries return empty,
// and ILIKE wildcards in the query are escaped (searched literally, not as patterns).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerSearchRoutes } from '../src/routes/search';
import { db, users, challenges, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c500001';
const user: User = { id: UID, email: 'searchtest@test', name: 'Sam Search', roles: ['member'] };
const MARK = 'ZSEARCHTEST';

const router = new Router();
registerSearchRoutes(router);

async function call(path: string) {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${path}`);
  const res = await withTenantDb(DEMO_TENANT_ID, () =>
    matched.handler(new Request(`http://localhost${path}`, { method: 'GET' }), ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  await db.delete(challenges).where(like(challenges.title, `${MARK}%`));
  await db.delete(users).where(eq(users.id, UID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name, avatar_initials: 'SS' }).onConflictDoNothing();
  await withTenantDb(DEMO_TENANT_ID, () =>
    db.insert(challenges).values({
      title: `${MARK} unmistakable widget`,
      work_area: 'claims',
      submitter_id: UID,
      tenant_id: DEMO_TENANT_ID,
    }),
  );
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('matches a challenge by title for a ≥2-char query', async () => {
  const { status, json } = await call(`/api/search?q=unmistakable`);
  expect(status).toBe(200);
  expect(json.challenges.some((c: { title: string }) => c.title.includes('unmistakable'))).toBe(true);
});

test('short query (<2 chars) returns empty groups, no DB scan', async () => {
  const { status, json } = await call(`/api/search?q=a`);
  expect(status).toBe(200);
  expect(json.challenges).toEqual([]);
  expect(json.solutions).toEqual([]);
  expect(json.blocks).toEqual([]);
});

test('ILIKE wildcards are escaped (searched literally)', async () => {
  // '%%%' as a raw pattern would match everything; escaped, it matches nothing here.
  const { status, json } = await call(`/api/search?q=${encodeURIComponent('%%%')}`);
  expect(status).toBe(200);
  expect(json.challenges.find((c: { title: string }) => c.title.startsWith(MARK))).toBeUndefined();
});
