// tests/license-client.test.ts — Phase 4 / F.1: the licenses-service introspection client
// (services/license-client.ts). Tested against an injected `fetch` (no live licenses service).
// Proves the load-bearing behaviours: the full response is parsed, introspection is cached for the
// TTL (and refreshed after it), and a non-2xx / transport failure THROWS (so Gate 2 fails closed —
// an unreachable licenses service must never resolve to "active").
import { test, expect } from 'bun:test';
import {
  LicenseClientService,
  LicenseClientError,
  type LicenseIntrospectResponse,
} from '../src/services/license-client';

const URL = 'http://licenses.test/license/introspect';

const ACTIVE: LicenseIntrospectResponse = {
  active: true,
  tenant_id: '00000000-0000-0000-0000-0000000f1001',
  app: { key: 'commonpractice', name: 'Common Practice' },
  status: 'active',
  expires_at: '2999-01-01T00:00:00Z',
};

function makeFetch(body: unknown, status = 200) {
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    calls++;
    // echo the request body back through so the test can assert the {token} shape if it wants
    void init;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function svc(fetchImpl: typeof fetch, now: () => number = () => 1000) {
  return new LicenseClientService({
    introspectUrl: URL,
    cacheTtlMs: 300_000, // 5 min
    fetchImpl,
    now,
  });
}

test('introspect parses the full response (active, tenant_id, app.key, expires_at)', async () => {
  const f = makeFetch(ACTIVE);
  const r = await svc(f.fetchImpl).introspect('tok-A');
  expect(r.active).toBe(true);
  expect(r.tenant_id).toBe('00000000-0000-0000-0000-0000000f1001');
  expect(r.app?.key).toBe('commonpractice');
  expect(r.expires_at).toBe('2999-01-01T00:00:00Z');
});

test('introspection is cached for the TTL and refreshed after it', async () => {
  const clock = { t: 1000 };
  const f = makeFetch(ACTIVE);
  const s = svc(f.fetchImpl, () => clock.t);

  await s.introspect('tok-A');
  await s.introspect('tok-A'); // within TTL → served from cache
  expect(f.calls()).toBe(1);

  clock.t += 300_001; // past the 5-min window
  await s.introspect('tok-A'); // → re-introspected
  expect(f.calls()).toBe(2);
});

test('the cache is keyed per-token (distinct tokens each hit the service)', async () => {
  const f = makeFetch(ACTIVE);
  const s = svc(f.fetchImpl);
  await s.introspect('tok-A');
  await s.introspect('tok-B');
  expect(f.calls()).toBe(2);
});

test('a non-2xx response throws LicenseClientError (fail-closed)', async () => {
  const f = makeFetch('nope', 500);
  await expect(svc(f.fetchImpl).introspect('tok-A')).rejects.toBeInstanceOf(LicenseClientError);
});

test('a transport failure throws (never swallowed into active)', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
  const s = svc(fetchImpl);
  await expect(s.introspect('tok-A')).rejects.toBeInstanceOf(LicenseClientError);
});
