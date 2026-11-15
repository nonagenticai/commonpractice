// tests/smoke.test.ts — Session 0 logic smoke (no DB needed). The live HTTP
// /health + /api/me check is in the verification curl, not here, so `bun test`
// stays fast and DB-independent.
import { test, expect, afterEach } from 'bun:test';
import {
  validateAuth,
  requireRole,
  __setAuthOverridesForTests,
} from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { UnauthorizedError, type User } from '../src/types';

afterEach(() => __setAuthOverridesForTests(undefined));

const bareReq = () => new Request('http://localhost/api/me');

test('AUTH_BYPASS yields a super_admin dev user (unified taxonomy)', async () => {
  const user = await validateAuth(bareReq());
  expect(user.email).toBe('dev@localhost');
  expect(user.roles).toContain('super_admin');
});

test('requireRole passes for a held role under bypass', async () => {
  const user = await requireRole(bareReq(), 'super_admin');
  expect(user.roles).toContain('super_admin');
});

test('__setAuthOverridesForTests replaces the auth surface (no mock.module)', async () => {
  const fake: User = { id: 'x', email: 'a@b.c', name: 'A', roles: ['employee'] };
  __setAuthOverridesForTests({ validateAuth: async () => fake });
  expect(await validateAuth(bareReq())).toEqual(fake);
});

test('requireRole rejects a missing role', async () => {
  const fake: User = { id: 'x', email: 'a@b.c', name: 'A', roles: ['employee'] };
  __setAuthOverridesForTests({ validateAuth: async () => fake });
  // requireRole (no override) falls through to validateAuth (overridden)
  await expect(requireRole(bareReq(), 'super_admin')).rejects.toBeInstanceOf(
    UnauthorizedError,
  );
});

test('Router matches paths and extracts params', () => {
  const r = new Router();
  const h = async () => new Response('ok');
  r.add('GET', '/api/blocks/:slug', h);
  const m = r.match('GET', '/api/blocks/read-claim-form');
  expect(m?.params).toEqual(['read-claim-form']);
  expect(r.match('POST', '/api/blocks/x')).toBeNull();
  expect(r.match('GET', '/health')).toBeNull();
});
