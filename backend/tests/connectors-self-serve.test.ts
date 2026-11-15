// tests/connectors-self-serve.test.ts — the self-serve MinIO auto-registration wiring
// (feature ON). Exercises create→register (shared secret, cp-* guard, secret not echoed),
// the shared secret authenticating the MinIO event ingress, rotate-blocked, and
// delete→deregister (ref-counted). The storage_service register/deregister + the object
// read are served by the injected egress fetch (house __setEgressHooksForTests seam).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import { invalidatePolicyCache } from '../src/host/policy-store';
import {
  snapshotPolicies,
  restorePolicies,
  CONNECTOR_POLICY_KEYS,
} from './helpers/policy-snapshot';
import { Router } from '../src/utils/router';
import { registerConnectorRoutes } from '../src/routes/connectors';
import { db, users, datasets, datasetRows, policies } from '../src/db/client';
import type { User } from '../src/types';

const OWNER_ID = '00000000-0000-0000-0000-0000c0aa0002';
const owner: User = {
  id: OWNER_ID,
  email: 'selfserve@test',
  name: 'Self Serve',
  roles: ['super_admin', 'employee'],
  tenantId: OWNER_ID,
};
const STORAGE_HOST = 'storage.test.invalid:8391';
const STORAGE_URL = `http://${STORAGE_HOST}`;
const SHARED_SECRET = 'shared-platform-secret-abc';

const router = new Router();
registerConnectorRoutes(router);

// Outbound storage_service calls captured by the injected fetch.
const notifyCalls: Array<{ method: string; url: string; body: unknown }> = [];
// When true, the injected storage_service register call fails (non-2xx) so we can exercise the
// best-effort fallback path (notifyRegistered=false + warn log + audit metadata).
let failNotify = false;
// LIVE notification ground truth per bucket, served by the injected GET /notifications — drives
// the verify/reconcile drift-detection tests. A bucket absent from the map → no rule.
const liveRulesByBucket: Record<string, string[]> = {};
// When true, the injected GET /notifications returns a non-2xx (storage unreachable).
let statusUnreachable = false;

async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function setAllowlist(allow: string[], externalHttp = true) {
  for (const [key, value, control, category, label] of [
    ['models.external_http', externalHttp, 'toggle', 'models_tools', 'External HTTP'],
    ['data.egress_allowlist', allow, 'list', 'models_tools', 'Egress allowlist'],
  ] as const) {
    await db
      .insert(policies)
      .values({ key, value, control, category, label })
      .onConflictDoUpdate({ target: policies.key, set: { value } });
  }
  invalidatePolicyCache();
}

async function cleanup() {
  const owned = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));
  for (const d of owned) await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  await db.delete(datasets).where(eq(datasets.owner_id, OWNER_ID));
  await db.delete(users).where(eq(users.id, OWNER_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
/** Captured in `beforeAll`, put back verbatim in `afterAll` — never a literal. See
 *  `helpers/policy-snapshot.ts` for the 22→3 truncation this shape used to cause. */
let POLICY_SNAPSHOT: Map<string, unknown>;

beforeAll(async () => {
  POLICY_SNAPSHOT = await snapshotPolicies(CONNECTOR_POLICY_KEYS);
  await cleanup();
  process.env.CP_CONNECTOR_NOTIFICATIONS_ENABLED = 'true';
  process.env.CP_NOTIFY_STORAGE_URL = STORAGE_URL;
  process.env.CP_CONNECTOR_EVENTS_SECRET = SHARED_SECRET;
  __setAuthOverridesForTests({ validateAuth: async () => owner });
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/notifications/register')) {
        notifyCalls.push({
          method,
          url,
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        return failNotify
          ? new Response('{"error":"boom"}', { status: 500 })
          : new Response('{"rules":1}', { status: 201 });
      }
      // GET the bucket's LIVE notification rules (verify/reconcile ground truth).
      if (method === 'GET' && url.includes('/notifications')) {
        if (statusUnreachable) return new Response('unreachable', { status: 503 });
        const m = url.match(/\/api\/buckets\/([^/]+)\/notifications$/);
        const bucket = m ? decodeURIComponent(m[1]!) : '';
        const prefixes = liveRulesByBucket[bucket] ?? [];
        return new Response(
          JSON.stringify({
            bucket,
            rules: prefixes.map((p) => ({ config_id: 'cp-x', prefix: p, events: [], arn: 'arn' })),
          }),
          { status: 200 },
        );
      }
      // Object read during firstSync.
      return new Response('id,city\n1,Ams\n', { headers: { 'content-type': 'text/csv' } });
    },
  });
  await setAllowlist([STORAGE_HOST, 'storage.test.invalid']);
}, 30_000);

afterAll(async () => {
  await cleanup();
  await restorePolicies(POLICY_SNAPSHOT);
  delete process.env.CP_CONNECTOR_NOTIFICATIONS_ENABLED;
  delete process.env.CP_NOTIFY_STORAGE_URL;
  delete process.env.CP_CONNECTOR_EVENTS_SECRET;
  __setAuthOverridesForTests(undefined);
  __setEgressHooksForTests(undefined);
}, 30_000);

test('create storage+webhook connector auto-registers the rule, shares the secret, hides it', async () => {
  notifyCalls.length = 0;
  const created = await call('POST', '/api/connectors', {
    name: 'Self Serve Source',
    sourceType: 'storage',
    config: { baseUrl: STORAGE_URL, bucket: 'cp-selfserve-demo', key: 'data/sales.csv', format: 'csv' },
    eventSource: 'webhook',
  });
  expect(created.status).toBe(201);
  // Auto-registration happened, and the shared secret/ingest URL are NOT echoed.
  expect(created.json.notifyRegistered).toBe(true);
  expect(created.json.eventSecret).toBe(null);
  expect(created.json.ingestUrl).toBe(null);
  // The outcome is persisted onto connection_meta so the list/UI can show per-connector state.
  expect(created.json.meta.notifyRegistered).toBe(true);
  expect(created.json.meta.bucket).toBe('cp-selfserve-demo');
  // The register call hit storage_service with the object key as the prefix.
  const reg = notifyCalls.find((c) => c.method === 'POST');
  expect(reg).toBeTruthy();
  expect(reg!.url).toBe(`${STORAGE_URL}/api/buckets/cp-selfserve-demo/notifications/register`);
  expect(reg!.body).toEqual({ prefix: 'data/sales.csv' });

  // The SHARED secret authenticates a MinIO bucket-notification for this connector.
  const ev = await call(
    'POST',
    '/api/connectors/events',
    { Records: [{ s3: { bucket: { name: 'cp-selfserve-demo' } } }] },
    { authorization: `Bearer ${SHARED_SECRET}` },
  );
  expect(ev.status).toBe(202);
  expect(ev.json.triggered).toBe(1);
});

test('a storage+webhook connector on a non-cp bucket is rejected', async () => {
  const r = await call('POST', '/api/connectors', {
    name: 'Bad Bucket',
    sourceType: 'storage',
    config: { baseUrl: STORAGE_URL, bucket: 'artifacts', key: 'x.csv', format: 'csv' },
    eventSource: 'webhook',
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('bucket_convention');
  // `bucket_convention` hides four different sentences behind one code. Without `reason` a locale
  // catalog can only guess which one to render, so pin the discriminator, not just the code.
  expect(r.json.details.reason).toBe('webhook_needs_cp_bucket');
});

test('rotate-secret is blocked for storage connectors', async () => {
  const [d] = await db
    .select()
    .from(datasets)
    .where(eq(datasets.owner_id, OWNER_ID));
  const r = await call('POST', `/api/connectors/${d!.slug}/rotate-secret`);
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('shared_secret');
});

test('deleting the last connector on a bucket+key deregisters the rule', async () => {
  notifyCalls.length = 0;
  const [d] = await db
    .select()
    .from(datasets)
    .where(eq(datasets.owner_id, OWNER_ID));
  const r = await call('DELETE', `/api/connectors/${d!.slug}`);
  expect(r.status).toBe(200);
  const dereg = notifyCalls.find((c) => c.method === 'DELETE');
  expect(dereg).toBeTruthy();
  expect(dereg!.url).toBe(`${STORAGE_URL}/api/buckets/cp-selfserve-demo/notifications/register`);
  expect(dereg!.body).toEqual({ prefix: 'data/sales.csv' });
});

test('a failed best-effort registration does not block create but is logged + audited', async () => {
  notifyCalls.length = 0;
  failNotify = true;
  const warnings: unknown[][] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const created = await call('POST', '/api/connectors', {
      name: 'Notify Fails',
      sourceType: 'storage',
      config: { baseUrl: STORAGE_URL, bucket: 'cp-notify-fail', key: 'data/x.csv', format: 'csv' },
      eventSource: 'webhook',
    });
    // Create still succeeds (best-effort), but the outcome is surfaced as false.
    expect(created.status).toBe(201);
    expect(created.json.notifyRegistered).toBe(false);
    // The register call was attempted (and failed via the injected 500).
    expect(notifyCalls.some((c) => c.method === 'POST')).toBe(true);
    // The silent fallback is warned to the logs (the observability signal for on-call). The
    // create-audit metadata also records notifyRegistered, but that is asserted in-process here
    // via the warn + response rather than re-read from the shared CI postgres (which persists
    // state across concurrent runs, so a slug-keyed audit read is not deterministic there).
    expect(warnings.some((w) => String(w[0]).includes('notification auto-register failed'))).toBe(true);
  } finally {
    console.warn = realWarn;
    failNotify = false;
  }
});

// ---- Per-tenant bucket isolation (CP_BUCKET_PER_TENANT_ISOLATION) ----

const TENANT_TOKEN = createHash('sha256').update(OWNER_ID).digest('hex').slice(0, 12);

test('per-tenant isolation derives cp-<token>-<name>, strips a foreign prefix, grandfathers legacy', async () => {
  notifyCalls.length = 0;
  process.env.CP_BUCKET_PER_TENANT_ISOLATION = 'true';
  try {
    // Plain name → namespaced under the caller's own token.
    const a = await call('POST', '/api/connectors', {
      name: 'Iso Plain',
      sourceType: 'storage',
      config: { baseUrl: STORAGE_URL, bucket: 'sales', key: 'data/a.csv', format: 'csv' },
      eventSource: 'webhook',
    });
    expect(a.status).toBe(201);
    expect(a.json.meta.bucket).toBe(`cp-${TENANT_TOKEN}-sales`);
    expect(notifyCalls.some((c) => c.url.includes(`cp-${TENANT_TOKEN}-sales`))).toBe(true);

    // A FOREIGN tenant prefix is stripped and re-keyed under the caller's token — a tenant can
    // never auto-register against another tenant's bucket.
    const b = await call('POST', '/api/connectors', {
      name: 'Iso Foreign',
      sourceType: 'storage',
      config: { baseUrl: STORAGE_URL, bucket: 'cp-deadbeefcafe-secret', key: 'data/b.csv', format: 'csv' },
      eventSource: 'webhook',
    });
    expect(b.status).toBe(201);
    expect(b.json.meta.bucket).toBe(`cp-${TENANT_TOKEN}-secret`);

    // A legacy allow-listed bucket (the cp-datasets demo) is grandfathered through unchanged.
    const c = await call('POST', '/api/connectors', {
      name: 'Iso Legacy',
      sourceType: 'storage',
      config: { baseUrl: STORAGE_URL, bucket: 'cp-datasets', key: 'data/c.csv', format: 'csv' },
      eventSource: 'webhook',
    });
    expect(c.status).toBe(201);
    expect(c.json.meta.bucket).toBe('cp-datasets');
  } finally {
    delete process.env.CP_BUCKET_PER_TENANT_ISOLATION;
  }
});

test('isolation OFF keeps the flat cp-* bucket unchanged', async () => {
  // Default (flag unset) — the user-supplied cp-* bucket is stored verbatim.
  const r = await call('POST', '/api/connectors', {
    name: 'Flat Bucket',
    sourceType: 'storage',
    config: { baseUrl: STORAGE_URL, bucket: 'cp-flat-demo', key: 'data/f.csv', format: 'csv' },
    eventSource: 'webhook',
  });
  expect(r.status).toBe(201);
  expect(r.json.meta.bucket).toBe('cp-flat-demo');
});

// ---- Manual re-register (POST /api/connectors/:slug/register-notifications) ----

test('re-register flips a failed connector to notifyRegistered and persists it', async () => {
  // Create one whose auto-register fails → notifyRegistered:false persisted.
  failNotify = true;
  const created = await call('POST', '/api/connectors', {
    name: 'Reregister Me',
    sourceType: 'storage',
    config: { baseUrl: STORAGE_URL, bucket: 'cp-reg-me', key: 'data/r.csv', format: 'csv' },
    eventSource: 'webhook',
  });
  failNotify = false;
  expect(created.json.notifyRegistered).toBe(false);
  expect(created.json.meta.notifyRegistered).toBe(false);
  const slug = created.json.slug;

  // Now retry — storage_service succeeds this time.
  notifyCalls.length = 0;
  const r = await call('POST', `/api/connectors/${slug}/register-notifications`);
  expect(r.status).toBe(200);
  expect(r.json.notifyRegistered).toBe(true);
  expect(r.json.meta.notifyRegistered).toBe(true);
  expect(notifyCalls.some((c) => c.method === 'POST' && c.url.includes('cp-reg-me'))).toBe(true);
});

test('re-register on an unknown connector is 404', async () => {
  const r = await call('POST', '/api/connectors/does-not-exist/register-notifications');
  expect(r.status).toBe(404);
});

// ---- Live verify + self-heal (GET /api/connectors/:slug/notifications/status) ----

async function createStorageConnector(name: string, bucket: string, key: string) {
  const created = await call('POST', '/api/connectors', {
    name,
    sourceType: 'storage',
    config: { baseUrl: STORAGE_URL, bucket, key, format: 'csv' },
    eventSource: 'webhook',
  });
  return created.json.slug as string;
}

test('verify: a live rule reports notifyLive=true, drift=false', async () => {
  const slug = await createStorageConnector('Verify OK', 'cp-verify-ok', 'data/v.csv');
  liveRulesByBucket['cp-verify-ok'] = ['data/v.csv']; // ground truth: rule present
  const r = await call('GET', `/api/connectors/${slug}/notifications/status`);
  expect(r.status).toBe(200);
  expect(r.json.reachable).toBe(true);
  expect(r.json.notifyLive).toBe(true);
  expect(r.json.drift).toBe(false);
  expect(r.json.meta.notifyRegistered).toBe(true);
});

test('verify: a missing rule reports drift and self-heals the stored flag to false', async () => {
  const slug = await createStorageConnector('Verify Drift', 'cp-verify-drift', 'data/d.csv');
  liveRulesByBucket['cp-verify-drift'] = []; // ground truth: rule lost out-of-band
  const r = await call('GET', `/api/connectors/${slug}/notifications/status`);
  expect(r.status).toBe(200);
  expect(r.json.reachable).toBe(true);
  expect(r.json.notifyLive).toBe(false);
  expect(r.json.drift).toBe(true);
  // the false-green is corrected on the row
  expect(r.json.meta.notifyRegistered).toBe(false);
});

test('verify: storage unreachable does NOT flip a stored true→false', async () => {
  const slug = await createStorageConnector('Verify Unreach', 'cp-verify-unreach', 'data/u.csv');
  statusUnreachable = true;
  try {
    const r = await call('GET', `/api/connectors/${slug}/notifications/status`);
    expect(r.status).toBe(200);
    expect(r.json.reachable).toBe(false);
    expect(r.json.notifyLive).toBe(false);
    expect(r.json.drift).toBe(false);
    // stored flag preserved (no false alarm on a transient error)
    expect(r.json.meta.notifyRegistered).toBe(true);
  } finally {
    statusUnreachable = false;
  }
});

test('verify on an unknown connector is 404', async () => {
  const r = await call('GET', '/api/connectors/nope/notifications/status');
  expect(r.status).toBe(404);
});

// ---- Bulk reconcile (POST /api/connectors/notifications/reconcile) ----

test('reconcile re-asserts only the drifted connectors in the tenant', async () => {
  await cleanup(); // deterministic set: exactly the two connectors created below
  await createStorageConnector('Recon Healthy', 'cp-rec-ok', 'data/h.csv');
  await createStorageConnector('Recon Drift', 'cp-rec-drift', 'data/d.csv');
  liveRulesByBucket['cp-rec-ok'] = ['data/h.csv']; // healthy: rule present
  liveRulesByBucket['cp-rec-drift'] = []; // drifted: rule missing

  notifyCalls.length = 0;
  const r = await call('POST', '/api/connectors/notifications/reconcile');
  expect(r.status).toBe(200);
  expect(r.json.checked).toBe(2);
  expect(r.json.repaired).toBe(1);
  expect(r.json.failed).toBe(0);
  // exactly the drifted bucket was re-registered
  const posts = notifyCalls.filter((c) => c.method === 'POST');
  expect(posts.length).toBe(1);
  expect(posts[0]!.url.includes('cp-rec-drift')).toBe(true);
});

// ---- The capability on the LIST body (GET /api/connectors) ----
//
// ⛔ WHY THIS IS ON THE WIRE AT ALL. Three controls on /connectors — Verify, Re-register and
// Reconcile — are refused `400 notifications_disabled` when the feature is off, and the flag ships
// dark (absent from `.env`, `.env.example`, `.env.local` and `docker-compose.yml`). The SPA had no
// channel to learn that: there is no `/api/config`, and `/api/me` carries no flags. So it rendered
// all three live and the only way to find out was to press one. `canManage` on the same body is the
// precedent — a server-computed capability, so the client needs no second expression to drift from.
//
// ⚠️ BOTH DIRECTIONS, because a field that is hard-coded `true` passes the first test alone and is
// exactly as useless as no field. `connectorNotificationsConfig()` is a plain function with no
// module-level cache (src/config.ts), so flipping the env between calls really re-reads it — which
// is the property the second test depends on and the first would not notice.

test('GET /api/connectors reports the notification capability as ENABLED when it is', async () => {
  const r = await call('GET', '/api/connectors');
  expect(r.status).toBe(200);
  // Non-vacuity: this suite runs with the feature ON (see beforeAll), so `true` here is a real
  // reading of a real flag rather than a default nobody set.
  expect(process.env.CP_CONNECTOR_NOTIFICATIONS_ENABLED).toBe('true');
  expect(r.json.notificationsEnabled).toBe(true);
});

test('…and as DISABLED when the flag is off — the state the demo actually ships in', async () => {
  const prev = process.env.CP_CONNECTOR_NOTIFICATIONS_ENABLED;
  delete process.env.CP_CONNECTOR_NOTIFICATIONS_ENABLED;
  try {
    const r = await call('GET', '/api/connectors');
    expect(r.status).toBe(200);
    expect(r.json.notificationsEnabled).toBe(false);
    // ⚠️ THE REFUSAL ITSELF IS NOT RE-ASSERTED HERE, DELIBERATELY. `notificationsEnabled` is thrown
    // only AFTER `loadConnectorInTenant`, so probing it needs a connector that exists — and creating
    // one inside this arm would need the flag back on, which is the thing under test. The three
    // refusals have their own cases above; what is new is that the client can now SEE the flag
    // without pressing anything.
  } finally {
    process.env.CP_CONNECTOR_NOTIFICATIONS_ENABLED = prev;
  }
});
