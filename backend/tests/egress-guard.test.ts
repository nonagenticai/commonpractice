// tests/egress-guard.test.ts — the connector egress gate (Phase 2-A). Pure unit tests
// over assertEgressAllowed: the external-HTTP master switch, the per-host allowlist
// (exact + wildcard + port), and the SSRF private/loopback/metadata reject. DNS is
// injected via the test seam so an offline run is deterministic.
import { test, expect, afterEach } from 'bun:test';
import {
  assertEgressAllowed,
  parseTarget,
  EgressBlockedError,
  __setEgressHooksForTests,
} from '../src/host/egress-guard';
import { buildSnapshot } from '../src/host/policy-store';
import type { Policy } from '../src/db/schema';

function snap(externalHttp: boolean, allowlist: string[]) {
  const rows: Policy[] = [
    { key: 'models.external_http', value: externalHttp } as Policy,
    { key: 'data.egress_allowlist', value: allowlist } as Policy,
  ];
  return buildSnapshot(rows);
}

function resolvesTo(ip: string) {
  __setEgressHooksForTests({ lookup: async () => [ip] });
}

afterEach(() => __setEgressHooksForTests(undefined));

test('parseTarget handles postgres URLs and bare host:port', () => {
  expect(parseTarget('postgresql://u:p@db.example.com:5432/app')).toEqual({
    host: 'db.example.com',
    port: 5432,
  });
  expect(parseTarget('https://api.example.com/data.json')).toEqual({
    host: 'api.example.com',
    port: null,
  });
  expect(parseTarget('storage.example.com:8391')).toEqual({ host: 'storage.example.com', port: 8391 });
});

test('external HTTP off → egress_disabled before anything else', async () => {
  resolvesTo('93.184.216.34');
  await expect(assertEgressAllowed('https://api.example.com', snap(false, ['api.example.com']))).rejects.toMatchObject(
    { code: 'egress_disabled' },
  );
});

test('host not on the allowlist → refused', async () => {
  resolvesTo('93.184.216.34');
  await expect(
    assertEgressAllowed('https://evil.example.com', snap(true, ['api.example.com'])),
  ).rejects.toMatchObject({ code: 'egress_host_not_allowlisted' });
});

test('allowlisted host that resolves to loopback → SSRF blocked', async () => {
  resolvesTo('127.0.0.1');
  await expect(
    assertEgressAllowed('https://api.example.com', snap(true, ['api.example.com'])),
  ).rejects.toMatchObject({ code: 'egress_ssrf_blocked' });
});

test('allowlisted host resolving to the cloud metadata IP → SSRF blocked', async () => {
  resolvesTo('169.254.169.254');
  await expect(
    assertEgressAllowed('https://api.example.com', snap(true, ['api.example.com'])),
  ).rejects.toMatchObject({ code: 'egress_ssrf_blocked' });
});

test('allowlisted host resolving to a public IP → allowed', async () => {
  resolvesTo('93.184.216.34');
  const t = await assertEgressAllowed('https://api.example.com', snap(true, ['api.example.com']));
  expect(t.host).toBe('api.example.com');
  expect(t.ips).toContain('93.184.216.34');
});

test('wildcard entry matches an in-cluster suffix (private IP allowed because allowlisted)', async () => {
  resolvesTo('10.43.1.7'); // a ClusterIP — private, but the operator allowlisted the suffix
  const t = await assertEgressAllowed(
    'http://storage-api.storage.svc.cluster.local:8391/api/files/b/k.csv',
    snap(true, ['*.svc.cluster.local']),
  );
  expect(t.host).toBe('storage-api.storage.svc.cluster.local');
});

test('port-scoped allowlist entry only matches that port', async () => {
  resolvesTo('93.184.216.34');
  await expect(
    assertEgressAllowed('postgresql://u:p@db.example.com:6543/app', snap(true, ['db.example.com:5432'])),
  ).rejects.toMatchObject({ code: 'egress_host_not_allowlisted' });
  const ok = await assertEgressAllowed('postgresql://u:p@db.example.com:5432/app', snap(true, ['db.example.com:5432']));
  expect(ok.port).toBe(5432);
});

test('EgressBlockedError carries a stable code', () => {
  const e = new EgressBlockedError('egress_disabled', 'x');
  expect(e).toBeInstanceOf(Error);
  expect(e.code).toBe('egress_disabled');
});
