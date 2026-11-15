// tests/connectors-routes.test.ts — the live data-connector API (Phase 2-A) over a
// real PG. Exercises: a Postgres connector that SELECTs from the test DB itself and
// materializes rows; an HTTP connector served by an injected fetch (DNS injected to a
// public IP so the SSRF guard passes); an egress-blocked create; and the token-authed
// event ingress. The full NOTIFY→listener→refresh chain is validated in the live drive
// (the listener only runs in the booted server), so here we assert ingress auth + that
// a direct refresh materializes.
import { createHash } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
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
import { db, users, datasets, datasetRows, policies, auditLog } from '../src/db/client';
import { config } from '../src/config';
import type { User } from '../src/types';

const OWNER_ID = '00000000-0000-0000-0000-0000c0aa0001';
const owner: User = { id: OWNER_ID, email: 'conn@test', name: 'Conn Owner', roles: ['super_admin', 'employee'], tenantId: OWNER_ID };
// The egress guard hard-blocks a literal loopback IP even when allowlisted (CI sets
// DATABASE_URL host to 127.0.0.1). Point the connector at the DB via the `localhost`
// NAME so the injected lookup hook (→ public IP) lets the SSRF check pass; postgres.js
// still connects to the same DB. Locally the host is already `localhost`.
const PG_CONNECTOR_URL = config.database.url.replace('127.0.0.1', 'localhost');

const router = new Router();
registerConnectorRoutes(router);

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
  // audit_log.actor_id is ON DELETE SET NULL, not cascade — deleting the user first would leave
  // orphaned (actor_id: null) rows behind rather than removing them, so clear these explicitly.
  await db.delete(auditLog).where(eq(auditLog.actor_id, OWNER_ID));
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
  __setAuthOverridesForTests({ validateAuth: async () => owner });
  // Resolve every host to a public IP so the SSRF guard never blocks the test target;
  // the allowlist is what we actually exercise. Postgres still connects to the real URL.
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async (input) => {
      const url = String(input);
      if (url.includes('rows.json')) {
        return new Response(JSON.stringify([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('id,city\n1,Ams\n', { headers: { 'content-type': 'text/csv' } });
    },
  });
  await setAllowlist(['localhost', 'data.test.invalid']);
}, 30_000);

afterAll(async () => {
  await cleanup();
  // Restore exactly what `beforeAll` found — never a literal.
  await restorePolicies(POLICY_SNAPSHOT);
  __setAuthOverridesForTests(undefined);
  __setEgressHooksForTests(undefined);
}, 30_000);

test('POST postgres connector SELECTs the live DB and materializes typed rows', async () => {
  const r = await call('POST', '/api/connectors', {
    name: 'Live Numbers',
    sourceType: 'postgres',
    config: { url: PG_CONNECTOR_URL, query: "SELECT 1 AS n, 'alpha' AS label UNION ALL SELECT 2, 'beta'" },
  });
  expect(r.status).toBe(201);
  expect(r.json.status).toBe('ready');
  expect(r.json.rowCount).toBe(2);
  expect(r.json.meta.kind).toBe('postgres');
  expect(r.json.meta.host).toBe('localhost');
  // rows are persisted + readable like any dataset
  const detail = await call('GET', `/api/connectors/${r.json.slug}`);
  expect(detail.json.rows).toHaveLength(2);
  expect(detail.json.rows[0]).toHaveProperty('label');
});

test('POST /api/connectors/test probes a reachable postgres source without persisting (ok:true)', async () => {
  const before = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));
  const r = await call('POST', '/api/connectors/test', {
    sourceType: 'postgres',
    config: { url: PG_CONNECTOR_URL, query: 'SELECT 1 AS n' },
  });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(typeof r.json.detail).toBe('string');
  // non-persisting: no new connector row was created by the test.
  const after = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));
  expect(after.length).toBe(before.length);
});

test('POST /api/connectors/test returns ok:false for a malformed config (no throw)', async () => {
  const r = await call('POST', '/api/connectors/test', {
    sourceType: 'postgres',
    config: { query: 'SELECT 1' }, // missing required `url`
  });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(false);
  expect(typeof r.json.detail).toBe('string');
});

// ── adversarial hunt: POST /api/connectors/test runs a REAL outbound fetch against a
// caller-supplied, never-persisted config and used to record NOTHING — no audit_log row at
// all. That let a bad actor tune a payload (e.g. a storage path-traversal attempt, #170)
// against the live fetcher repeatedly with zero trace, only auditing once they committed to
// a real connector.create. This is the regression test: it fails on main because no
// audit_log row for 'connector.test' is ever written. ──────────────────────────────────────
test('POST /api/connectors/test on success records an audit_log row (kind + host, not the URL/secret)', async () => {
  const before = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, OWNER_ID), eq(auditLog.action, 'connector.test')));
  const r = await call('POST', '/api/connectors/test', {
    sourceType: 'postgres',
    config: { url: PG_CONNECTOR_URL, query: 'SELECT 1 AS n' },
  });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);

  const after = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, OWNER_ID), eq(auditLog.action, 'connector.test')))
    .orderBy(desc(auditLog.created_at));
  expect(after.length).toBe(before.length + 1);
  const row = after[0]!;
  expect(row.category).toBe('data');
  expect(row.metadata).toMatchObject({ kind: 'postgres', host: 'localhost' });
  // the config (which may carry credentials, e.g. the connection string's userinfo) must
  // never land in the audit row.
  expect(JSON.stringify(row.metadata)).not.toContain(PG_CONNECTOR_URL);
});

test('POST /api/connectors/test on a storage source audits bucket+key (never the token)', async () => {
  const r = await call('POST', '/api/connectors/test', {
    sourceType: 'storage',
    config: {
      baseUrl: 'http://storage.test.invalid:8391',
      bucket: 'cp-test-bucket',
      key: 'x.csv',
      token: 'super-secret-token',
      format: 'csv',
    },
  });
  // storage.test.invalid isn't allowlisted in this suite (setAllowlist only covers
  // localhost/data.test.invalid) — the probe fails with ok:false, but the FAILED probe is
  // exactly the forensically-interesting case (it's what an attacker's tuning loop looks
  // like), so it must be audited too.
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(false);

  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, OWNER_ID), eq(auditLog.action, 'connector.test')))
    .orderBy(desc(auditLog.created_at))
    .limit(1);
  expect(row).toBeTruthy();
  expect(row!.metadata).toMatchObject({ kind: 'storage', bucket: 'cp-test-bucket', key: 'x.csv' });
  expect(JSON.stringify(row!.metadata)).not.toContain('super-secret-token');
});

test('POST http connector fetches + parses JSON through the egress guard', async () => {
  const r = await call('POST', '/api/connectors', {
    name: 'Remote Rows',
    sourceType: 'http',
    config: { url: 'https://data.test.invalid/rows.json' },
  });
  expect(r.status).toBe(201);
  expect(r.json.status).toBe('ready');
  expect(r.json.rowCount).toBe(2);
  expect(r.json.columns.map((c: { name: string }) => c.name)).toEqual(['a', 'b']);
});

// ── adversarial hunt (round 1, PR #180): an http connector URL can carry a credential in its
// userinfo or a "known secret" query param. Blocklist-fixed then, but a FOLLOW-UP adversarial
// review (this round) ran the real function against a path-embedded secret, a GCS presigned URL,
// and a JWT under an innocuous param name — all three survived, because a name-based blocklist
// can never be complete (see the design comment on `httpMetaOut` in
// src/datasets/connectors/index.ts). The fix is not a bigger list: `http` meta now stores ONLY
// `host` (+ `format`), the same "keep only known-safe" shape `postgres` (host/database) and
// `storage` (host/bucket/key) already used — there is no `url` field left to leak from at all. ──
test('an http connector meta never carries the URL — host+format only, regardless of what the URL contained', async () => {
  const r = await call('POST', '/api/connectors', {
    name: 'Credentialed Source',
    sourceType: 'http',
    // Path-embedded secret + userinfo + a "known secret" query param + a GCS-style presigned
    // param + a JWT-shaped value under an innocuous name — none of these are on ANY blocklist
    // position, on purpose: the assertion below is "there is no url field", not "url is clean".
    config: {
      url:
        'https://user:pass@example.com/v1/sk_live_51H8xyzSECRETTOKEN/export.csv' +
        '?api_key=SECRET&X-Goog-Signature=GOOGSIG&export=eyJhbGciOiJIUzI1NiJ9.payload.sig',
    },
  });
  expect(r.status).toBe(201);
  expect(r.json.meta).toEqual({ kind: 'http', host: 'example.com', format: undefined });
  expect(r.json.meta.url).toBeUndefined();
  const bodyStr = JSON.stringify(r.json);
  for (const secret of ['pass', 'sk_live_51H8xyzSECRETTOKEN', 'SECRET', 'GOOGSIG', 'eyJhbGciOiJIUzI1NiJ9']) {
    expect(bodyStr).not.toContain(secret);
  }

  // The DB row itself — not just the API response shape — must never have carried the secret
  // (or a url key at all): meta is built from `metaFromConfig`, never `cfg.url` directly.
  const [row] = await db.select().from(datasets).where(eq(datasets.slug, r.json.slug));
  const storedMeta = row!.connection_meta as Record<string, unknown>;
  expect(storedMeta).toEqual({ kind: 'http', host: 'example.com', format: undefined });
  expect('url' in storedMeta).toBe(false);

  // GET /api/connectors/:slug — reachable by a plain tenant member, not just the creator — must
  // also come back clean.
  const detail = await call('GET', `/api/connectors/${r.json.slug}`);
  expect(detail.status).toBe(200);
  expect(detail.json.meta.url).toBeUndefined();
  expect(JSON.stringify(detail.json)).not.toContain('SECRET');

  // GET /api/connectors (list) too.
  const list = await call('GET', '/api/connectors');
  const listed = list.json.items.find((i: { slug: string }) => i.slug === r.json.slug);
  expect(listed.meta.url).toBeUndefined();
  expect(JSON.stringify(listed)).not.toContain('SECRET');
});

// ── a row written by pre-redesign code (or the blocklist-era fix in between) still has a `url`
// key sitting in its `connection_meta` column. `redactMeta` in routes/connectors.ts must strip it
// on every read regardless — this is the "existing rows keep their stored meta, but reads are
// still safe" belt-and-braces path. ────────────────────────────────────────────────────────────
test('a legacy row with a raw URL still in connection_meta comes back host-only on GET', async () => {
  const created = await call('POST', '/api/connectors', {
    name: 'Legacy Shaped Row',
    sourceType: 'http',
    config: { url: 'https://data.test.invalid/rows.json' },
  });
  expect(created.status).toBe(201);

  // Simulate a pre-redesign row: write the OLD meta shape directly into the DB, bypassing
  // metaFromConfig entirely, the way a row created before this fix actually looks on disk.
  await db
    .update(datasets)
    .set({
      connection_meta: {
        kind: 'http',
        host: 'legacy.example.com',
        url: 'https://user:pass@legacy.example.com/x?api_key=STILLSECRET',
        format: 'json',
      } as unknown as typeof datasets.$inferInsert.connection_meta,
    })
    .where(eq(datasets.slug, created.json.slug));

  const detail = await call('GET', `/api/connectors/${created.json.slug}`);
  expect(detail.status).toBe(200);
  expect(detail.json.meta).toEqual({ kind: 'http', host: 'legacy.example.com', format: 'json' });
  expect(JSON.stringify(detail.json)).not.toContain('STILLSECRET');
  expect(JSON.stringify(detail.json)).not.toContain('pass');

  const list = await call('GET', '/api/connectors');
  const listed = list.json.items.find((i: { slug: string }) => i.slug === created.json.slug);
  expect(listed.meta).toEqual({ kind: 'http', host: 'legacy.example.com', format: 'json' });
  expect(JSON.stringify(listed)).not.toContain('STILLSECRET');
});

test('a non-allowlisted host fails the refresh with an egress error (not a 500)', async () => {
  const r = await call('POST', '/api/connectors', {
    name: 'Blocked Source',
    sourceType: 'http',
    config: { url: 'https://not-allowed.example.com/rows.json' },
  });
  expect(r.status).toBe(201); // the connector is created…
  expect(r.json.status).toBe('error'); // …but the first sync is refused
  expect(r.json.firstSync.ok).toBe(false);
  expect(r.json.syncError).toContain('egress_host_not_allowlisted');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WS-2 — a failed sync PERSISTS a machine-readable code, not only English prose.
//
// ⛔ THE DEFECT. `connector-refresh.ts` wrote `` `${code}: ${err.message}` `` into
// `datasets.sync_error` and nothing else. /connectors rendered that column verbatim — beside a
// localized label and in the status badge's `title=` — so a Dutch admin read an English sentence
// and a bare machine token in the middle of a Dutch page, and because it is a COLUMN and not a
// response it stayed there across reloads until the connector next synced successfully. The fix is
// migration 0074: the row now carries `sync_error_code` + `sync_error_detail` and the BROWSER
// composes the sentence (frontend/src/lib/api/error-message.ts `syncErrorText`).
//
// ⚠️ THE ASSERTION HAS TO BE ON THE PERSISTED ROW, NOT ON THE CREATE RESPONSE. Shipping the code
// on the live response alone would localize the notice the instant the sync fails and REVERT TO
// ENGLISH ON THE NEXT PAGE LOAD — silently, with every frontend render test still green. So this
// reads the dataset row out of the database AND re-reads it through GET /api/connectors.
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('a refused refresh persists the wire code + detail beside the English sentence', async () => {
  const r = await call('POST', '/api/connectors', {
    name: 'Blocked Source Coded',
    sourceType: 'http',
    config: { url: 'https://also-not-allowed.example.com/rows.json' },
  });
  expect(r.status).toBe(201);
  expect(r.json.status).toBe('error');

  // 1. THE ROW. This is the half that survives a reload.
  const [row] = await db
    .select({
      sync_error: datasets.sync_error,
      sync_error_code: datasets.sync_error_code,
      sync_error_detail: datasets.sync_error_detail,
    })
    .from(datasets)
    .where(eq(datasets.slug, r.json.slug));
  expect(row).toBeTruthy();
  // The code is the MACHINE half — exactly `EgressBlockedError.code`, never the prose.
  expect(row!.sync_error_code).toBe('egress_host_not_allowlisted');
  // The bag the browser interpolates. `host` is what the reader has to add to the allowlist, so a
  // sentence without it says strictly less than the English it replaces.
  expect(row!.sync_error_detail?.host).toBe('also-not-allowed.example.com');
  expect(row!.sync_error_detail?.reason).toContain('not on the connector egress allowlist');
  // ⛔ AND THE ENGLISH COLUMN IS STILL THERE. It is the MCP reader's output and the permanent
  // fallback for every pre-0074 row; a fix that deleted it would blank those rows in 8 locales.
  expect(row!.sync_error).toContain('egress_host_not_allowlisted');

  // 2. THE WIRE. The page reads the list endpoint, not the create response.
  const list = await call('GET', '/api/connectors');
  const listed = list.json.items.find((i: { slug: string }) => i.slug === r.json.slug);
  expect(listed.syncErrorCode).toBe('egress_host_not_allowlisted');
  expect(listed.syncErrorDetail.host).toBe('also-not-allowed.example.com');
  expect(listed.syncError).toContain('egress_host_not_allowlisted');
});

test('a SUCCESSFUL sync clears the code and the detail, not just the English', async () => {
  // The other direction, and the one an additive change forgets: a stale `sync_error_code` beside
  // a green "ready" badge would render last week's refusal as the current state. All three columns
  // are cleared in the same UPDATE precisely so they cannot disagree.
  const r = await call('POST', '/api/connectors', {
    name: 'Recovers Coded',
    sourceType: 'postgres',
    config: { url: PG_CONNECTOR_URL, query: 'SELECT 1 AS n' },
  });
  expect(r.status).toBe(201);
  expect(r.json.status).toBe('ready');
  const [row] = await db
    .select({
      sync_error: datasets.sync_error,
      sync_error_code: datasets.sync_error_code,
      sync_error_detail: datasets.sync_error_detail,
    })
    .from(datasets)
    .where(eq(datasets.slug, r.json.slug));
  expect(row!.sync_error).toBeNull();
  expect(row!.sync_error_code).toBeNull();
  expect(row!.sync_error_detail).toBeNull();
});

test('a bad query is rejected at create time (400), before any connection', async () => {
  const r = await call('POST', '/api/connectors', {
    name: 'Evil',
    sourceType: 'postgres',
    config: { url: PG_CONNECTOR_URL, query: 'DROP TABLE users' },
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('not_select');
});

test('webhook connector mints an event secret; the ingress verifies it', async () => {
  const created = await call('POST', '/api/connectors', {
    name: 'Pushed Source',
    sourceType: 'http',
    config: { url: 'https://data.test.invalid/rows.json' },
    eventSource: 'webhook',
  });
  expect(created.status).toBe(201);
  const secret: string = created.json.eventSecret;
  const id: string = created.json.id;
  expect(secret).toBeTruthy();
  expect(created.json.ingestUrl).toContain(`connector=${id}`);

  // Correct secret → accepted + triggered.
  const ok = await call('POST', `/api/connectors/events?connector=${id}`, {}, { authorization: `Bearer ${secret}` });
  expect(ok.status).toBe(202);
  expect(ok.json.triggered).toBe(1);

  // Wrong secret → accepted shape (no oracle) but nothing triggered.
  const bad = await call('POST', `/api/connectors/events?connector=${id}`, {}, { authorization: 'Bearer nope' });
  expect(bad.status).toBe(202);
  expect(bad.json.triggered).toBe(0);

  // The list view never leaks a secret.
  const list = await call('GET', '/api/connectors');
  const row = list.json.items.find((i: { id: string }) => i.id === id);
  expect(row).toBeTruthy();
  expect(JSON.stringify(row)).not.toContain(secret);
});

test('a MinIO bucket-notification triggers refresh of the matching storage connector', async () => {
  // The storage connector firstSync fails (storage host unreachable in tests) but the row is
  // created with connection_meta.bucket set — enough to exercise the bucket-notification ingress.
  const created = await call('POST', '/api/connectors', {
    name: 'Bucket Source',
    sourceType: 'storage',
    config: { baseUrl: 'http://storage.test.invalid:8391', bucket: 'cp-test-bucket', key: 'x.csv', format: 'csv' },
    eventSource: 'webhook',
  });
  expect(created.status).toBe(201);
  const secret: string = created.json.eventSecret;

  // MinIO posts { Records:[{ s3:{ bucket:{ name } } }] } with the per-connector secret as Bearer.
  // The lookup runs as SYSTEM (no tenant context on the webhook path) → it must still find the
  // connector by bucket and verify the secret.
  const ok = await call('POST', '/api/connectors/events',
    { Records: [{ s3: { bucket: { name: 'cp-test-bucket' } } }] },
    { authorization: `Bearer ${secret}` });
  expect(ok.status).toBe(202);
  expect(ok.json.triggered).toBe(1);

  // A different bucket name matches no connector.
  const noMatch = await call('POST', '/api/connectors/events',
    { Records: [{ s3: { bucket: { name: 'some-other-bucket' } } }] },
    { authorization: `Bearer ${secret}` });
  expect(noMatch.status).toBe(202);
  expect(noMatch.json.triggered).toBe(0);
});

// ── adversarial hunt: after a successful exploit of #170's storage path-traversal, the
// connector.create (and connector.sync) audit row said only {kind, host} — never WHAT was
// read. An incident could not be reconstructed from the audit trail alone. These are the
// regression tests: they fail on main because bucket/key are absent from the metadata. ────
test('connector.create audit metadata records bucket+key for a storage connector', async () => {
  const r = await call('POST', '/api/connectors', {
    name: 'Bucket Audit Source',
    sourceType: 'storage',
    config: { baseUrl: 'http://storage.test.invalid:8391', bucket: 'cp-audit-bucket', key: 'nested/x.csv', format: 'csv' },
  });
  expect(r.status).toBe(201);

  const [row] = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actor_id, OWNER_ID),
        eq(auditLog.action, 'connector.create'),
        eq(auditLog.target_id, r.json.slug),
      ),
    );
  expect(row).toBeTruthy();
  expect(row!.metadata).toMatchObject({ kind: 'storage', bucket: 'cp-audit-bucket', key: 'nested/x.csv' });
});

test('connector.sync (refresh) audit metadata records bucket+key, even on a failed sync', async () => {
  const r = await call('POST', '/api/connectors', {
    name: 'Bucket Sync Audit',
    sourceType: 'storage',
    config: { baseUrl: 'http://storage.test.invalid:8391', bucket: 'cp-sync-audit-bucket', key: 'y.csv', format: 'csv' },
  });
  expect(r.status).toBe(201);
  // storage.test.invalid isn't allowlisted -> firstSync fails -> the failure branch of
  // doRefresh's audit call is the one under test here.
  expect(r.json.status).toBe('error');

  const [row] = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actor_id, OWNER_ID),
        eq(auditLog.action, 'connector.sync'),
        eq(auditLog.target_id, r.json.slug),
      ),
    );
  expect(row).toBeTruthy();
  expect(row!.metadata).toMatchObject({ kind: 'storage', bucket: 'cp-sync-audit-bucket', key: 'y.csv' });
});

test('a manual sync re-materializes and clears a prior error', async () => {
  const slug = 'remote-rows';
  const r = await call('POST', `/api/connectors/${slug}/sync`);
  expect(r.status).toBe(200);
  expect(r.json.sync.ok).toBe(true);
  expect(r.json.status).toBe('ready');
});

// ── The storage bucket is a TENANT BOUNDARY, and the default path did not enforce it ───────────
test('POST /api/connectors REFUSES a foreign tenant\'s bucket on the DEFAULT (non-webhook) path', async () => {
  // ⛔ THE LIVE LEAK. Bucket ownership used to be checked only inside `autoRegister`, which needs
  // `eventSource === 'webhook'` — but `eventSource` DEFAULTS to 'none'. So a create that simply
  // omits it (the normal case) took `config.bucket` verbatim, and `refreshConnector` runs
  // synchronously on create, materialising another tenant's object into the caller's own rows.
  //
  // This test deliberately OMITS `eventSource`, because that is precisely the path that was open.
  //
  // It runs with per-tenant isolation OFF (the suite sets no CP_BUCKET_PER_TENANT_ISOLATION), which
  // is the configuration that MATTERS here: with isolation ON, `deriveTenantBucket` already strips a
  // foreign `cp-<token>-` prefix and re-keys under the caller's own token, so they land in their own
  // bucket — safe, deliberate, and covered by connectors-self-serve's "strips a foreign prefix".
  // With isolation OFF there is no re-keying and the literal bucket string would go straight to
  // storage_service, so the hard 403 is the only thing standing there. Asserting the outcome in BOTH
  // configurations is the point: the caller must never end up reading someone else's bucket, whether
  // that is achieved by rejection or by re-keying.
  // Proven against the live cluster: storage_service does not authorise per-tenant in-cluster (an
  // unauthenticated GET for a real namespaced object returned 200 with content), so CP is the sole
  // enforcement point.
  const foreignTenant = '00000000-0000-4000-8000-0000000fffff';
  const foreignBucket = `cp-${createHash('sha256').update(foreignTenant).digest('hex').slice(0, 12)}-datasets`;
  const r = await call('POST', '/api/connectors', {
    name: 'ZCONN foreign bucket probe',
    sourceType: 'storage',
    config: { baseUrl: 'http://storage.test.invalid:8391', bucket: foreignBucket, key: 'x.csv', format: 'csv' },
  });
  expect(r.status).toBe(403);
  expect((r.json as { error: string }).error).toBe('foreign_bucket');
});

test('POST /api/connectors/test cannot probe another tenant\'s bucket — the #179 sibling-route bypass', async () => {
  // ⛔ #179 closed the foreign-bucket hole in `createConnectorRoute` and LEFT THIS ROUTE OPEN.
  // It takes the same caller-supplied config, runs the same real `governedFetch` against
  // storage_service (legitimately egress-allowlisted, and NOT per-tenant authorised in-cluster),
  // and answered `Connected — read N columns, M rows` for another tenant's object: a working
  // read-oracle over foreign data, reachable by any tenant_admin, independent of every flag.
  //
  // "It persists nothing" is not a defence — the fetch is real and its result is returned.
  //
  // This suite runs with per-tenant isolation OFF, so the resolver's hard-refusal branch applies
  // and the probe must be REFUSED outright rather than silently re-pointed.
  const foreignTenant = '00000000-0000-4000-8000-0000000fffff';
  const foreignBucket = `cp-${createHash('sha256').update(foreignTenant).digest('hex').slice(0, 12)}-datasets`;
  const r = await call('POST', '/api/connectors/test', {
    sourceType: 'storage',
    config: { baseUrl: 'http://storage.test.invalid:8391', bucket: foreignBucket, key: 'revenue.csv', format: 'csv' },
  });
  // ⚠️ Precision about what this proves. With the guard removed, this suite's egress allowlist
  // ALSO refuses the probe (`storage.test.invalid` is not allowlisted here), so the test would go
  // red either way — but for the WRONG reason. In prod the storage host IS legitimately
  // allowlisted, which is exactly why the bypass was exploitable there. So the assertion below
  // deliberately matches the OWNERSHIP message, not merely `ok:false`: it fails both when the
  // guard is absent (wrong message: "not on the connector egress allowlist") and if the guard
  // ever stops firing first. Asserting only `ok:false` would pass on the vulnerable code.
  expect(r.status).toBe(200);
  const body = r.json as { ok: boolean; detail?: string };
  expect(body.ok).toBe(false);
  expect(String(body.detail)).toMatch(/another workspace|foreign/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/connectors?q= — WHAT THE SEARCH BOX CAN ACTUALLY FIND
//
// ⛔ THE DEFECT THIS PINS. /connectors used to filter `q` in the BROWSER, over the twelve rows
// page one had already fetched, across four fields: name, slug, the source label and the host. The
// page now sends `q` to this route instead (it has to — a client-side filter cannot see the
// thirteenth connector), and the route matched only `name` and `slug`. So moving the filter to the
// server, on its own, would have DELETED host search and source search from the product: a demo
// that searched a connector by its hostname worked before the fix and returned nothing after it.
// The `where` is widened here so the server matches everything the browser used to.
//
// ⛔ AND THE TERM IS ESCAPED. The old predicate interpolated the raw query straight into an ILIKE
// pattern (`%${q}%`), so a user's `%` and `_` were WILDCARDS: searching `100%` silently matched
// `100X`, `100 percent` and every other connector whose name contained `100`. `likeTerm()` (now
// src/utils/search.ts) escapes them. A connector genuinely named `Discount 100% off` must be
// findable by its own name, and the `Discount 100X off` decoy below is what reds an unescaped
// build — asserting only "the 100% row is found" would pass on the broken code too.
const SEARCH_TENANT = OWNER_ID;
const SEARCH_FIXTURES = [
  // Findable ONLY by host: 'telemetry-egress' appears in neither the name nor the slug.
  { name: 'Ledger feed', slug: 'q-ledger-feed', source_type: 'http' as const,
    connection_meta: { kind: 'http' as const, host: 'telemetry-egress.demo.example.com' } },
  // Findable ONLY by source type: 'storage' appears in neither the name, the slug, nor the host.
  { name: 'Claims drop', slug: 'q-claims-drop', source_type: 'storage' as const,
    connection_meta: { kind: 'storage' as const, host: 'objects.demo.example.com', bucket: 'claims', key: 'c.csv' } },
  // The escaping pair — identical but for the character under test.
  { name: 'Discount 100% off', slug: 'q-discount-pct', source_type: 'http' as const,
    connection_meta: { kind: 'http' as const, host: 'promo.demo.example.com' } },
  { name: 'Discount 100X off', slug: 'q-discount-decoy', source_type: 'http' as const,
    connection_meta: { kind: 'http' as const, host: 'promo.demo.example.com' } },
];

/** The connector NAMES this query matched. */
async function searchNames(q: string): Promise<string[]> {
  const res = await call('GET', `/api/connectors?q=${encodeURIComponent(q)}`);
  expect(res.status).toBe(200);
  return (res.json as { items: Array<{ name: string }> }).items.map((i) => i.name);
}

/** Idempotent — every case below seeds, so no case depends on another having run first.
 *  `cleanup()` in afterAll removes the user and everything owned by it. */
async function seedSearchFixtures() {
  await db.insert(users).values({ id: OWNER_ID, email: 'conn@test', name: 'Conn Owner' })
    .onConflictDoNothing();
  for (const f of SEARCH_FIXTURES) {
    await db.insert(datasets).values({ owner_id: OWNER_ID, tenant_id: SEARCH_TENANT, ...f })
      .onConflictDoNothing();
  }
}

test('?q= still matches NAME and SLUG — the two arms the widening must not drop', async () => {
  await seedSearchFixtures();
  expect(await searchNames('Ledger feed')).toContain('Ledger feed');
  expect(await searchNames('q-claims-drop')).toContain('Claims drop');
});

test('?q= matches the HOST the connector reads from', async () => {
  // ⛔ The old browser filter matched `c.meta?.host`; nothing on the server did. `host` is a key
  // inside the `connection_meta` jsonb, present on all three ConnectorMeta variants.
  await seedSearchFixtures();
  expect(
    await searchNames('telemetry-egress'),
    'a connector is no longer findable by the host it reads from',
  ).toContain('Ledger feed');
});

test('?q= matches the SOURCE TYPE', async () => {
  // ⛔ The old browser filter matched the rendered source label. 'storage' appears in this
  // connector's name, slug and host nowhere — only `source_type` can match it.
  await seedSearchFixtures();
  expect(
    await searchNames('storage'),
    'a connector is no longer findable by what kind of source it is',
  ).toContain('Claims drop');
});

test('?q= treats % and _ as LITERAL characters, not ILIKE wildcards', async () => {
  await seedSearchFixtures();
  const pct = await searchNames('100%');
  // The positive half first: without it, an implementation that matched nothing at all would
  // satisfy the decoy assertion below forever.
  expect(pct, 'the connector actually named "100%" was not found by its own name').toContain(
    'Discount 100% off',
  );
  expect(
    pct,
    'the % reached the ILIKE pattern as a WILDCARD and matched an unrelated connector',
  ).not.toContain('Discount 100X off');
  // `_` is the other ILIKE metacharacter and rides the same escape.
  expect(await searchNames('100_'), 'the _ acted as a single-character wildcard').not.toContain(
    'Discount 100X off',
  );
});
