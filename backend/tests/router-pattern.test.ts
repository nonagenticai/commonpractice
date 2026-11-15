// tests/router-pattern.test.ts — Router compiles a registered path pattern with
// every literal character matched literally; only `:name` tokens become capture
// groups. The previous compiler escaped `/` and substituted `:name` but left
// every other regex metacharacter live, so `/api/audit/export.csv` matched
// `/api/audit/exportXcsv` and a `.` in a path acted as a wildcard.
import { test, expect } from 'bun:test';
import { Router } from '../src/utils/router';

const ok = async (_req: Request, ...params: string[]) => new Response(JSON.stringify(params));

test('a literal dot matches only a dot', () => {
  const router = new Router();
  router.add('GET', '/api/audit/export.csv', ok);

  expect(router.match('GET', '/api/audit/export.csv')?.template).toBe('/api/audit/export.csv');
  expect(router.match('GET', '/api/audit/exportXcsv')).toBeNull();
});

test('other regex metacharacters round-trip literally', () => {
  const router = new Router();
  router.add('GET', '/api/x(a)+b', ok);

  expect(router.match('GET', '/api/x(a)+b')).not.toBeNull();
  // `(a)+` must be the four literal characters, not a repeated capture group.
  expect(router.match('GET', '/api/xaaaab')).toBeNull();
  expect(router.match('GET', '/api/xab')).toBeNull();
});

test('a backslash in the pattern is a literal backslash, not an escape', () => {
  const router = new Router();
  router.add('GET', '/api/a\\b', ok);

  expect(router.match('GET', '/api/a\\b')).not.toBeNull();
  expect(router.match('GET', '/api/a')).toBeNull();
});

test(':name becomes a capture group; surrounding literals stay literal', () => {
  const router = new Router();
  router.add('PATCH', '/api/blocks/:slug/versions/:version', ok);

  const hit = router.match('PATCH', '/api/blocks/my.block/versions/0.1.0');
  expect(hit?.params).toEqual(['my.block', '0.1.0']);
  // `([^/]+)` cannot swallow a separator.
  expect(router.match('PATCH', '/api/blocks/a/b/versions/0.1.0')).toBeNull();
});

test('patterns stay anchored at both ends', () => {
  const router = new Router();
  router.add('GET', '/health', ok);

  expect(router.match('GET', '/health')).not.toBeNull();
  expect(router.match('GET', '/health/extra')).toBeNull();
  expect(router.match('GET', '/api/health')).toBeNull();
});
