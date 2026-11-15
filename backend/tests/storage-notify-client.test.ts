// tests/storage-notify-client.test.ts — the self-serve MinIO notification client. No DB:
// it drives registerConnectorNotification/deregisterConnectorNotification through the egress
// guard's injected fetch (house __setEgressHooksForTests seam) and asserts the URL/method/
// body, the enabled-gate (no call when disabled), and best-effort non-2xx → false.
// It also pins that NO `X-Tenant-Id` header is sent on any storage call (register, deregister,
// status) — even while the legacy CP_NOTIFY_TENANT env is still set in the deployment.
import { test, expect, afterEach } from 'bun:test';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import {
  registerConnectorNotification,
  deregisterConnectorNotification,
  bucketNotificationStatus,
} from '../src/host/storage-notify-client';

const STORAGE = 'http://storage-api.storage.svc.cluster.local:8391';

function enableFeature(): void {
  process.env.CP_CONNECTOR_NOTIFICATIONS_ENABLED = 'true';
  process.env.CP_NOTIFY_STORAGE_URL = STORAGE;
  // Legacy env still present in gitops until removed — must have NO effect on the request.
  process.env.CP_NOTIFY_TENANT = 'commonpractice';
  process.env.CP_CONNECTOR_EVENTS_SECRET = 'shared-secret-xyz';
}

afterEach(() => {
  delete process.env.CP_CONNECTOR_NOTIFICATIONS_ENABLED;
  delete process.env.CP_NOTIFY_STORAGE_URL;
  delete process.env.CP_NOTIFY_TENANT;
  delete process.env.CP_CONNECTOR_EVENTS_SECRET;
  __setEgressHooksForTests();
});

test('register POSTs to the bucket notifications/register route with the prefix and NO tenant header', async () => {
  enableFeature();
  let captured: { url: string; method?: string; body?: string; tenant: string | null } | null = null;
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers as Record<string, string>);
      captured = {
        url: String(input),
        method: init?.method,
        body: init?.body as string,
        tenant: headers.get('x-tenant-id'),
      };
      return new Response('{"rules":1}', { status: 201 });
    },
  });

  const ok = await registerConnectorNotification('cp-tenant-demo', 'data/sales.csv');

  expect(ok).toBe(true);
  expect(captured!.url).toBe(`${STORAGE}/api/buckets/cp-tenant-demo/notifications/register`);
  expect(captured!.method).toBe('POST');
  expect(captured!.tenant).toBeNull();
  expect(JSON.parse(captured!.body!)).toEqual({ prefix: 'data/sales.csv' });
});

test('deregister sends DELETE to the same route, with NO tenant header', async () => {
  enableFeature();
  let method: string | undefined;
  let tenant: string | null = 'unset';
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async (_input, init) => {
      method = init?.method;
      tenant = new Headers(init?.headers as Record<string, string>).get('x-tenant-id');
      return new Response('{"removed":1}', { status: 200 });
    },
  });

  const ok = await deregisterConnectorNotification('cp-tenant-demo', 'data/sales.csv');
  expect(ok).toBe(true);
  expect(method).toBe('DELETE');
  expect(tenant).toBeNull();
});

test('a non-2xx is best-effort → false (never throws)', async () => {
  enableFeature();
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async () => new Response('boom', { status: 500 }),
  });
  expect(await registerConnectorNotification('cp-x', 'k.csv')).toBe(false);
});

test('status GETs the bucket notifications route (NO tenant header) and parses the rule prefixes', async () => {
  enableFeature();
  let captured: { url: string; method?: string; tenant: string | null } | null = null;
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async (input, init) => {
      captured = {
        url: String(input),
        method: init?.method,
        tenant: new Headers(init?.headers as Record<string, string> | undefined).get('x-tenant-id'),
      };
      return new Response(
        JSON.stringify({
          bucket: 'cp-tenant-demo',
          rules: [
            { config_id: 'cp-a', prefix: 'data/sales.csv', events: [], arn: 'arn' },
            { config_id: 'cp-b', prefix: 'data/costs.csv', events: [], arn: 'arn' },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const status = await bucketNotificationStatus('cp-tenant-demo');
  expect(captured!.url).toBe(`${STORAGE}/api/buckets/cp-tenant-demo/notifications`);
  expect(captured!.method).toBe('GET');
  expect(captured!.tenant).toBeNull();
  expect(status).toEqual({ prefixes: ['data/sales.csv', 'data/costs.csv'] });
});

test('status returns null on a non-2xx (unreachable — caller must not treat as "no rule")', async () => {
  enableFeature();
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async () => new Response('down', { status: 503 }),
  });
  expect(await bucketNotificationStatus('cp-x')).toBeNull();
});

test('status returns null when the feature is disabled', async () => {
  let called = false;
  __setEgressHooksForTests({
    fetch: async () => {
      called = true;
      return new Response('', { status: 200 });
    },
  });
  expect(await bucketNotificationStatus('cp-x')).toBeNull();
  expect(called).toBe(false);
});

test('disabled feature makes no call and returns false', async () => {
  // env intentionally not set → connectorNotificationsConfig().enabled is false
  let called = false;
  __setEgressHooksForTests({
    fetch: async () => {
      called = true;
      return new Response('', { status: 200 });
    },
  });
  expect(await registerConnectorNotification('cp-x', 'k.csv')).toBe(false);
  expect(called).toBe(false);
});
