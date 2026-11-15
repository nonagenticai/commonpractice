// tests/me-support-email.test.ts — /api/me carries the "Feedback" link's address (SUPPORT_EMAIL).
//
// Unset is a supported state: the field is null and the SPA hides the link — the backend never
// invents an address. A value that is not a plain address is treated as unset, because the SPA
// concatenates it into a `mailto:` href.
import { test, expect, afterAll, afterEach } from 'bun:test';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerMeRoutes } from '../src/routes/me';
import { supportEmail } from '../src/config';
import type { User } from '../src/types';

// A caller with no CP users row (no workspace): /api/me still answers 200 for them.
const caller: User = {
  id: '00000000-0000-4000-8000-00005e1fa001',
  email: 'support-email-probe@test',
  name: 'Support Email Probe',
  roles: ['member'],
};

const router = new Router();
registerMeRoutes(router);
const was = process.env.SUPPORT_EMAIL;

async function me(): Promise<{ status: number; json: Record<string, unknown> }> {
  __setAuthOverridesForTests({ validateAuth: async () => caller, requireRole: async () => caller });
  const m = router.match('GET', '/api/me')!;
  const res = await m.handler(new Request('http://localhost/api/me'), ...m.params);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

afterEach(() => {
  if (was === undefined) delete process.env.SUPPORT_EMAIL;
  else process.env.SUPPORT_EMAIL = was;
});
afterAll(() => __setAuthOverridesForTests(undefined));

test('unset SUPPORT_EMAIL → supportEmail: null (the field is present, the link is hidden)', async () => {
  delete process.env.SUPPORT_EMAIL;
  const { status, json } = await me();
  expect(status).toBe(200);
  expect(json).toHaveProperty('supportEmail', null);
});

test('set SUPPORT_EMAIL → carried verbatim (trimmed) on /api/me', async () => {
  process.env.SUPPORT_EMAIL = '  help@example.test ';
  const { status, json } = await me();
  expect(status).toBe(200);
  expect(json.supportEmail).toBe('help@example.test');
});

test('a value that is not a plain address is treated as unset', () => {
  for (const bad of ['', '   ', 'nobody', 'a@b', 'x@y.z?subject=hi', 'a b@c.de', '"x"@y.de', 'javascript:alert(1)@x.de']) {
    process.env.SUPPORT_EMAIL = bad;
    expect(supportEmail(), JSON.stringify(bad)).toBeNull();
  }
  process.env.SUPPORT_EMAIL = 'feedback+cp@sub.example.test';
  expect(supportEmail()).toBe('feedback+cp@sub.example.test');
});
