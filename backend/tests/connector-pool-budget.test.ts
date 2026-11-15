// tests/connector-pool-budget.test.ts — the request-pool budget of a connector sync.
//
// A connector sync used to hold THREE of the six `poolMax` request connections at once: the
// request's own (server.ts), one reserved purely to carry the `pg_try_advisory_lock` session, and
// a third from the nested `withTenantDb`. postgres-js `reserve()` queues on an unbounded promise
// with NO timeout, so once concurrent syncs claimed every slot nothing could ever release one:
// every authenticated request on the pod hung until restart, invisibly (the liveness probe hits
// the unauthenticated /health). Measured on this exact harness before the fix: 0 of 2 concurrent
// refreshes completed.
//
// The connection COUNT is asserted directly, not just liveness, because that is the invariant —
// a deadlock only shows up once concurrency happens to reach the pool ceiling, whereas a nested
// reserve is wrong the moment it is written. Anything above one reserve per sync fails here.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import { invalidatePolicyCache } from '../src/host/policy-store';
import {
  snapshotPolicies,
  restorePolicies,
  CONNECTOR_POLICY_KEYS,
} from './helpers/policy-snapshot';
import {
  db,
  datasets,
  datasetRows,
  users,
  policies,
  auditLog,
  queryClient,
  withTenantDb,
} from '../src/db/client';
import { createConnector } from '../src/datasets/connector-service';
import { refreshConnector } from '../src/datasets/connector-refresh';
import { config } from '../src/config';

const TENANT = '00000000-0000-0000-0000-000000000001';
// ⛔ Fixture ids that this file DELETEs must be unique to it — bun runs test files
// concurrently against one database, so a shared owned id means one file tears down
// another's in-flight fixtures (see tests/fixture-id-collisions.test.ts).
const OWNER_ID = '00000000-0000-0000-0000-0000c0b00002';
const CONCURRENCY = 3;
// Same trick as connectors-routes.test.ts: reach the DB by NAME so the SSRF guard's injected
// lookup (→ a public IP) passes, while postgres.js still dials the real local instance.
const PG_CONNECTOR_URL = config.database.url.replace('127.0.0.1', 'localhost');

/** Count `queryClient.reserve()` calls — every request-pool connection this test's work takes. */
let reserves = 0;
const originalReserve = queryClient.reserve.bind(queryClient);

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
  await db.delete(auditLog).where(eq(auditLog.actor_id, OWNER_ID));
  await db.delete(users).where(eq(users.id, OWNER_ID));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see license-provisioning.test.ts).
/** A gate the injected connector fetch blocks on, so a sync can be pinned mid-flight while a
 *  second sync of the same connector races it. `undefined` = no gating (the default). */
let fetchGate: Promise<void> | undefined;
/** Resolves once the gated fetch has actually been entered — i.e. the first sync holds the lock. */
let fetchEntered: (() => void) | undefined;

/** Captured in `beforeAll`, put back verbatim in `afterAll` — never a literal. See
 *  `helpers/policy-snapshot.ts` for the 22→3 truncation this shape used to cause. */
let POLICY_SNAPSHOT: Map<string, unknown>;

beforeAll(async () => {
  POLICY_SNAPSHOT = await snapshotPolicies(CONNECTOR_POLICY_KEYS);
  await cleanup();
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async () => {
      fetchEntered?.();
      if (fetchGate) await fetchGate;
      return new Response('a,b\n1,2\n', { headers: { 'content-type': 'text/csv' } });
    },
  });
  await setAllowlist(['localhost']);
  await db.insert(users).values({
    id: OWNER_ID,
    email: 'poolbudget@test',
    name: 'Pool Budget',
    role: 'platform',
    tenant_id: TENANT,
  });
  (queryClient as { reserve: typeof originalReserve }).reserve = async () => {
    reserves++;
    return originalReserve();
  };
}, 30_000);

afterAll(async () => {
  (queryClient as { reserve: typeof originalReserve }).reserve = originalReserve;
  await cleanup();
  await restorePolicies(POLICY_SNAPSHOT);
  __setEgressHooksForTests(undefined);
}, 30_000);

test('concurrent connector syncs take ONE request-pool connection each and never wedge', async () => {
  const ids: string[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const { dataset } = await createConnector({
      ownerId: OWNER_ID,
      tenantId: TENANT,
      name: `pool budget ${i}`,
      kind: 'postgres',
      config: { kind: 'postgres', url: PG_CONNECTOR_URL, query: `SELECT ${i} AS n, 'x' AS label` },
      meta: { kind: 'postgres', host: 'localhost', queryPreview: 'SELECT …' },
      eventSource: 'none',
    });
    ids.push(dataset.id);
  }

  reserves = 0;
  const outcomes = await Promise.all(
    // Exactly the request path: server.ts reserves a tenant-bound connection for the request, and
    // the handler (routes/connectors.ts create-then-sync / manual sync) awaits refreshConnector
    // inside it. Before the fix this never resolved.
    ids.map((id) => withTenantDb(TENANT, () => refreshConnector(id, { actorId: OWNER_ID }))),
  );

  for (const o of outcomes) expect(o).toMatchObject({ ok: true, rowCount: 1 });
  // One per request — the sync itself adds NONE. The advisory lock rides the session's existing
  // connection and the completion NOTIFY goes out on it too, instead of asking the pool for more.
  expect(reserves).toBe(CONCURRENCY);
}, 30_000);

test('a detached (listener-path) sync with no request context reserves exactly one', async () => {
  const { dataset } = await createConnector({
    ownerId: OWNER_ID,
    tenantId: TENANT,
    name: 'pool budget listener',
    kind: 'postgres',
    config: { kind: 'postgres', url: PG_CONNECTOR_URL, query: "SELECT 1 AS n, 'y' AS label" },
    meta: { kind: 'postgres', host: 'localhost', queryPreview: 'SELECT …' },
    eventSource: 'none',
  });

  reserves = 0;
  // connector-listener.ts's pump: no request, so no connection to inherit — the refresh opens its
  // own tenant session. It must still be ONE, and it must hold nothing else, so the bounded pump
  // (MAX_CONCURRENT=2) can never starve the pool it is drawing from.
  const outcome = await refreshConnector(dataset.id, { actorId: OWNER_ID });
  expect(outcome).toMatchObject({ ok: true, rowCount: 1 });
  expect(reserves).toBe(1);
}, 30_000);

// The point of the advisory lock, unchanged by the pool fix: moving it onto the tenant session's
// connection must not weaken it. Two sessions racing the SAME connector — an event-driven refresh
// against a manual sync, or two replicas — must still produce exactly one fetch.
test('a second sync racing an in-flight one is still refused by the advisory lock', async () => {
  const { dataset } = await createConnector({
    ownerId: OWNER_ID,
    tenantId: TENANT,
    name: 'pool budget race',
    kind: 'http',
    config: { kind: 'http', url: 'https://data.test.invalid/rows.csv', format: 'csv' },
    meta: { kind: 'http', host: 'data.test.invalid', format: 'csv' },
    eventSource: 'none',
  });
  await setAllowlist(['localhost', 'data.test.invalid']);

  let openGate!: () => void;
  const entered = new Promise<void>((r) => { fetchEntered = r; });
  fetchGate = new Promise<void>((r) => { openGate = r; });

  // First sync: runs until it is parked inside the (gated) source fetch, holding the lock.
  const first = withTenantDb(TENANT, () => refreshConnector(dataset.id, { actorId: OWNER_ID }));
  await entered;

  // Second sync, a DIFFERENT session — must be refused rather than double-fetching.
  const second = await withTenantDb(TENANT, () => refreshConnector(dataset.id, { actorId: OWNER_ID }));
  expect(second).toMatchObject({ ok: false, skipped: true, reason: 'locked' });

  openGate();
  expect(await first).toMatchObject({ ok: true, rowCount: 1 });

  // …and the lock is released, so the next sync proceeds normally.
  fetchGate = undefined;
  fetchEntered = undefined;
  const third = await withTenantDb(TENANT, () => refreshConnector(dataset.id, { actorId: OWNER_ID }));
  expect(third).toMatchObject({ ok: true, rowCount: 1 });
}, 30_000);
