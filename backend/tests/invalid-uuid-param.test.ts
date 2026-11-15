// tests/invalid-uuid-param.test.ts — a malformed uuid path param must yield a clean 400, not a 500.
// Before the route() wrapper mapped Postgres 22P02 ("invalid input syntax for type uuid"), a request
// like GET /api/challenges/not-a-uuid reached `eq(challenges.id, 'not-a-uuid')`, Postgres raised
// 22P02, and it surfaced as an unhandled 500. The wrapper now maps 22P02 -> 400 invalid_input.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { db, users, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c700002';
const user: User = { id: UID, email: 'badid@test', name: 'Bad Id', roles: ['employee'], tenantId: UID };

const router = new Router();
registerChallengeRoutes(router);

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
  await db
    .insert(users)
    .values({ id: UID, email: user.email, name: user.name, avatar_initials: 'BI' })
    .onConflictDoNothing();
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests({});
  await db.delete(users).where(eq(users.id, UID));
}, 30_000);

async function call(method: string, path: string) {
  const matched = router.match(method, path)!;
  const req = new Request(`http://localhost${path}`, { method });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('GET /api/challenges/:id with a malformed uuid returns 400, not 500', async () => {
  const res = await call('GET', '/api/challenges/not-a-uuid');
  expect(res.status).toBe(400);
  expect(res.json.error).toBe('invalid_input');
});

test('a well-formed but absent uuid still returns 404 (unchanged)', async () => {
  const res = await call('GET', '/api/challenges/00000000-0000-7000-8000-000000000000');
  expect(res.status).toBe(404);
});
