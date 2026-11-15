// tests/connector-listen-isolation.test.ts — the connector event spine's two silent defects.
//
// WS-D. The LISTEN registration used to ride `queryClient.listen(...)`, which READS like "reuse the
// pool" and is not what postgres-js does: it memoises a SEPARATE hidden `max:1` client
// (node_modules/postgres/src/index.js:150-165) inheriting only the parent DSN — the session POOLER.
// One per pod, in nobody's budget (6 + 4 + 1 = 11 against pool_size=24, and the HPA reaches 4
// replicas). And because the server sets `idle_session_timeout = '10min'` cluster-wide while a
// LISTEN-only session is idle outside a transaction BY DEFINITION, Postgres killed that session
// every ten minutes. postgres-js re-LISTENed quietly, so the connection count never moved and
// nothing was logged — but every NOTIFY in the kill→re-LISTEN gap was lost forever.
//
// WS-E. The SSE `synced` fan-out resolved its dataset with a bare `db.select()`. That runs on the
// NOTIFY handler's stack, which carries NO AsyncLocalStorage store, so `db` fell back to the pool:
// role `cp_app`, NOBYPASSRLS, no `app.current_tenant`. `datasets` has RLS enabled, so the policy
// matched nothing and the handler took its silent `return`. `event: synced` cannot have reached a
// browser in production since the RLS cutover.
//
// ⚠️ THE THINGS THAT MAKE THIS FILE SAFE, all learned the hard way (connector-pool-budget.test.ts
// and fixture-id-collisions.test.ts):
//   • `pg_stat_activity` is CLUSTER-GLOBAL and the suite shares one database, so every count here
//     is scoped by `datname = current_database()` AND `backend_start > SINCE`.
//   • `afterAll` MUST release the LISTEN client — it is `max:1, idle_timeout:null,
//     max_lifetime:null`, so nothing else will ever close it. Via the shared lease, NOT
//     `listenClient.end()`: the client is a module singleton and `end()` is terminal, so ending it
//     here would break every later file that needs a listener. See connector-listen-lease.ts.
//   • The `queryClient.unsafe` patch that forces real RLS is scoped to THIS file's connector id.
//     Test files share one process, so a blanket re-route would silently run another file's
//     queries as `cp_app`.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import {
  db,
  datasets,
  users,
  tenants,
  queryClient,
  listenClient,
} from '../src/db/client';
import { currentDbContext } from '../src/db/tenant-context';
import {
  startConnectorListener,
  stopConnectorListener,
  subscribeConnectorSynced,
  LISTEN_CHANNELS,
} from '../src/datasets/connector-listener';
import { CHANNEL_REFRESH, CHANNEL_SYNCED } from '../src/datasets/connector-refresh';
import { releaseConnectorListener } from './connector-listen-lease';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { registerConnectorRoutes } from '../src/routes/connectors';
import { Router } from '../src/utils/router';
import { renderMetrics } from '../src/host/metrics';
import { config } from '../src/config';
import type { User } from '../src/types';

// Ids owned by THIS file only — see tests/fixture-id-collisions.test.ts.
const OWNER_ID = '00000000-0000-0000-0000-0000c115e001';
const TENANT_ID = '00000000-0000-0000-0000-0000c115e002';
const CONNECTOR_ID = '00000000-0000-0000-0000-0000c115e003';
const owner: User = {
  id: OWNER_ID,
  email: 'listen-isolation@test',
  name: 'Listen Isolation',
  roles: ['super_admin', 'employee'],
  tenantId: TENANT_ID,
};

/** Captured before anything connects, so every pg_stat_activity count excludes pre-existing
 *  sessions — this database is shared with the rest of the suite (and with `psql`). */
const SINCE = new Date().toISOString();

const router = new Router();
registerConnectorRoutes(router);

/**
 * A connection pinned to the PRODUCTION runtime role. `cp_app` has NOLOGIN, so it cannot be a DSN
 * of its own; `-c role=cp_app` in the startup packet is the connection-lifetime equivalent of the
 * `SET ROLE cp_app` that `withTenantDbAsRuntimeRoleForTests` (db/client.ts:277) uses to make
 * route-level tests face real RLS instead of the owner's bypass. Deliberately sets NO
 * `app.current_tenant`: that absence IS the production condition on the NOTIFY stack.
 */
const rlsRuntime = postgres(config.database.url, {
  max: 1,
  // `idle_timeout: null` is what postgres-js itself passes for a pinned client; the shipped .d.ts
  // just types it `number | undefined` (unlike `max_lifetime`). Cast covers the declaration only.
  ...({ idle_timeout: null } as Record<never, never>),
  max_lifetime: null,
  fetch_types: false,
  onnotice: () => {},
  connection: { application_name: 'cp-rls-probe', options: '-c role=cp_app' },
});

async function cleanup() {
  await db.delete(datasets).where(eq(datasets.owner_id, OWNER_ID));
  await db.delete(users).where(eq(users.id, OWNER_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS (see license-provisioning).
beforeAll(async () => {
  await cleanup();
  __setAuthOverridesForTests({ validateAuth: async () => owner });
  await db.insert(tenants).values({
    id: TENANT_ID,
    name: 'Listen Isolation Tenant',
    slug: 'listen-isolation-tenant',
  });
  await db.insert(users).values({
    id: OWNER_ID,
    email: owner.email,
    name: owner.name,
    role: 'platform',
    tenant_id: TENANT_ID,
  });
  await db.insert(datasets).values({
    id: CONNECTOR_ID,
    owner_id: OWNER_ID,
    tenant_id: TENANT_ID,
    name: 'Listen Isolation Connector',
    slug: 'listen-isolation-connector',
    source_type: 'postgres',
    event_source: 'none',
  });
}, 30_000);

afterAll(async () => {
  // Shared singleton — see tests/connector-listen-lease.ts for why this is NOT `listenClient.end()`.
  await releaseConnectorListener();
  await rlsRuntime.end({ timeout: 5 });
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

function counter(name: string): number {
  const m = new RegExp(`^commonpractice_${name} (\\d+)$`, 'm').exec(renderMetrics());
  return m ? Number(m[1]) : 0;
}

async function listenBackends(): Promise<{ n: number; pid: number | null }> {
  const [row] = await queryClient<{ n: number; pid: number | null }[]>`
    SELECT count(*)::int AS n, min(pid) AS pid
      FROM pg_stat_activity
     WHERE application_name = 'cp-listen'
       AND datname = current_database()
       AND backend_start > ${SINCE}::timestamptz`;
  return row!;
}

// ---------------------------------------------------------------------------------------------
// WS-D
// ---------------------------------------------------------------------------------------------

// MUST run first: startConnectorListener is idempotent, so a later call would short-circuit and
// this sabotage would prove nothing.
test('the LISTEN registration never reaches the request pool', async () => {
  // Sabotage the request pool. If the listener still registers, it demonstrably did not go through
  // `queryClient` — a structural claim that needs no server state to be true.
  const original = queryClient.listen.bind(queryClient);
  (queryClient as { listen: typeof original }).listen = (() => {
    throw new Error('LISTEN must not run on queryClient');
  }) as unknown as typeof original;
  try {
    expect(await startConnectorListener()).toBe(true);
  } finally {
    (queryClient as { listen: typeof original }).listen = original;
  }
}, 30_000);

test('the listener holds EXACTLY ONE labelled connection, not a base client plus a hidden one', async () => {
  // The subtler regression this catches: "simplifying" back to `listenClient.listen(...)` still
  // works and still looks correct, but postgres-js would memoise a SECOND client on top of ours
  // (index.js:150-165) — two pinned connections where the budget says one. The
  // `application_name` label is what makes that countable, so it is load-bearing, not decoration.
  expect((await listenBackends()).n).toBe(1);
}, 30_000);

test("the listener disarms the server's idle_session_timeout on its OWN session", async () => {
  // The 10-minute reaper is a DATABASE-level default in production, and a LISTEN-only session is
  // idle by design. `source` is the assertion that matters: it proves the value came from a SET we
  // issued in-session, not from a server that happened to be configured harmlessly. `setting = 0`
  // alone would pass on any stock Postgres and prove nothing.
  const [g] = await listenClient<{ setting: string; source: string }[]>`
    SELECT setting, source FROM pg_settings WHERE name = 'idle_session_timeout'`;
  expect(g!.setting).toBe('0');
  expect(g!.source).toBe('session');
}, 30_000);

test('a disconnect DURING registration cannot leave a half-registered session', async () => {
  // THE WINDOW: registration used to be three separate statements, and `started` was only set once
  // all three had returned — while `onClose` began `if (stopped || !started) return`. So a close
  // BETWEEN statements was swallowed: no reconnect, no disconnect counter, no log. postgres-js then
  // opened a fresh connection for the next statement, `register()` resolved, and the listener
  // logged `listening on cp_connector_refresh + cp_connector_synced` about a session that was
  // listening to neither. Depending on where the kill landed the pod ended up permanently missing
  // one channel, both channels, or — subtlest — with both channels but `idle_session_timeout` back
  // at the server default, i.e. the headline 10-minute defect silently restored.
  //
  // The window is small, but it is WIDEST exactly during the events that cause disconnects (the
  // reaper firing, a pgbouncer reload, a failover), when re-registration happens in a storm.
  stopConnectorListener();

  // Kill the backend the instant the first registration statement lands, before `register()` can
  // continue — an arbitrary instant, chosen adversarially.
  const original = listenClient.unsafe.bind(listenClient);
  let armed = true;
  (listenClient as { unsafe: typeof original }).unsafe = ((...args: unknown[]) => {
    const q = (original as unknown as (...a: unknown[]) => unknown)(...args);
    if (!armed) return q;
    armed = false;
    return (async () => {
      const result = await q;
      const { pid } = await listenBackends();
      if (pid) await queryClient`SELECT pg_terminate_backend(${pid})`;
      await new Promise((r) => setTimeout(r, 150)); // let the socket close actually land
      return result;
    })();
  }) as unknown as typeof original;

  try {
    await startConnectorListener();
  } finally {
    (listenClient as { unsafe: typeof original }).unsafe = original;
  }

  // Whatever happened mid-flight, the session the pod is left holding must be FULLY configured.
  // Polled, because a correct implementation reaches this state by re-registering asynchronously.
  // string_agg, not array_agg: `listenClient` runs with `fetch_types: false`, so postgres-js has no
  // array parser loaded and would hand back the raw literal `{cp_connector_synced}` as a string.
  // Derived from the registry, NOT a hand-written pair. This assertion used to name
  // `[CHANNEL_REFRESH, CHANNEL_SYNCED]` literally, so adding a third channel to the pod's single
  // pinned LISTEN session (the copilot's cross-replica tool-result rendezvous, WS-3) would have
  // failed here as if the registration were broken. It is an EXACT-SET assertion and must stay one
  // — a channel that is registered but never dispatched, or dispatched but never registered, is a
  // NOTIFY nobody hears — so it now tracks `LISTEN_CHANNELS`, which `register()` also builds from.
  const want = [...LISTEN_CHANNELS].sort().join(',');
  let channels = '';
  let guc = '';
  for (let i = 0; i < 40; i++) {
    const [row] = await listenClient<{ chans: string | null; guc: string }[]>`
      SELECT (SELECT string_agg(c, ',' ORDER BY c) FROM pg_listening_channels() c) AS chans,
             current_setting('idle_session_timeout') AS guc`;
    channels = row?.chans ?? '';
    guc = row?.guc ?? '';
    if (channels === want && guc === '0') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(channels).toBe(want);
  expect(guc).toBe('0');

  // …and it is a real registration, not merely a correctly-configured connection.
  let delivered: string | undefined;
  const unsub = subscribeConnectorSynced((id) => { delivered = id; });
  try {
    await queryClient.notify(CHANNEL_SYNCED, CONNECTOR_ID);
    for (let i = 0; i < 50 && !delivered; i++) await new Promise((r) => setTimeout(r, 100));
  } finally {
    unsub();
  }
  expect(delivered).toBe(CONNECTOR_ID);
}, 30_000);

test('a server-killed LISTEN session is re-registered, and delivery resumes', async () => {
  const before = await listenBackends();
  const disconnectsBefore = counter('connector_listen_disconnects_total');
  const connectsBefore = counter('connector_listen_connects_total');

  // Exactly what `idle_session_timeout` does to this session every ten minutes in production.
  await queryClient`SELECT pg_terminate_backend(${before.pid})`;

  let after = before;
  for (let i = 0; i < 60 && (after.n !== 1 || after.pid === before.pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
    after = await listenBackends();
  }
  expect(after.n).toBe(1);
  expect(after.pid).not.toBe(before.pid); // a genuinely new backend, not the old one still open

  // The observability that would have made the original ten-minute kill a graph instead of an
  // archaeology exercise in a postgres conf file.
  expect(counter('connector_listen_disconnects_total')).toBe(disconnectsBefore + 1);
  expect(counter('connector_listen_connects_total')).toBe(connectsBefore + 1);

  // And the registration is REAL after the reconnect, not merely a connection that exists.
  let delivered: string | undefined;
  const unsub = subscribeConnectorSynced((id) => { delivered = id; });
  try {
    await queryClient.notify(CHANNEL_SYNCED, CONNECTOR_ID);
    for (let i = 0; i < 50 && !delivered; i++) await new Promise((r) => setTimeout(r, 100));
  } finally {
    unsub();
  }
  expect(delivered).toBe(CONNECTOR_ID);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// WS-E
// ---------------------------------------------------------------------------------------------

test('the NOTIFY fan-out really does run with no ambient tenant context (the premise)', async () => {
  let ctxSeen: unknown = 'never-called';
  const unsub = subscribeConnectorSynced(() => { ctxSeen = currentDbContext(); });
  try {
    await queryClient.notify(CHANNEL_SYNCED, CONNECTOR_ID);
    for (let i = 0; i < 50 && ctxSeen === 'never-called'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    unsub();
  }
  expect(ctxSeen).not.toBe('never-called'); // guards against a vacuous pass
  expect(ctxSeen).toBeUndefined();
}, 30_000);

test('the production runtime role genuinely cannot see the connector (the mechanism)', async () => {
  // Not decoration: without this the RLS harness below could be silently inert and the SSE test
  // would pass for the wrong reason.
  const [owned] = await db.select().from(datasets).where(eq(datasets.id, CONNECTOR_ID));
  expect(owned?.id).toBe(CONNECTOR_ID);

  const blind = await rlsRuntime<{ id: string }[]>`SELECT id FROM datasets WHERE id = ${CONNECTOR_ID}`;
  expect(blind.length).toBe(0);
}, 30_000);

test('the SSE synced fan-out resolves its dataset under the RLS runtime role', async () => {
  // Force the real production condition on the ONE lookup under test: a `datasets` read carrying
  // this file's connector id is re-routed to the `cp_app` connection (NOBYPASSRLS, no tenant GUC).
  // Anything else in the process — including another test file's queries — passes straight through.
  //
  // Only the UNFIXED path is affected: a bare `db.select()` with no AsyncLocalStorage store runs on
  // `poolDb`, i.e. `queryClient`. The fix's `runAsSystem` binds `ownerDb`/`ownerClient`, which this
  // patch never touches — which is precisely the difference the test exists to detect.
  type UnsafeParams = Parameters<typeof queryClient.unsafe>[1];
  const original = queryClient.unsafe.bind(queryClient);
  // ⚠️ FORWARD EVERY ARGUMENT, not the two the .d.ts declares. postgres-js's own `begin()` calls
  // `sql.unsafe('begin', [], { onexecute })` — that undeclared third argument is what marks the
  // connection reserved for the transaction. Dropping it makes every `db.transaction(...)` in the
  // request path (here: resolveTenant → ensureUser) die with `UNSAFE_TRANSACTION`.
  (queryClient as { unsafe: typeof original }).unsafe = ((...args: unknown[]) => {
    const [q, params] = args as [string, UnsafeParams];
    const targeted =
      typeof q === 'string' &&
      /\bdatasets\b/.test(q) &&
      Array.isArray(params) &&
      params.includes(CONNECTOR_ID);
    return targeted
      ? rlsRuntime.unsafe(q, params)
      : (original as unknown as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof original;

  const abort = new AbortController();
  try {
    const matched = router.match('GET', '/api/connectors/stream')!;
    const res = await matched.handler(
      new Request('http://localhost/api/connectors/stream', { signal: abort.signal }),
      ...matched.params,
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    // The real spine, end to end: NOTIFY → listenClient → supervisor → fanoutSynced → this handler.
    await queryClient.notify(CHANNEL_SYNCED, CONNECTOR_ID);
    for (let i = 0; i < 50 && !buf.includes('event: synced'); i++) {
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), 100)),
      ]);
      if (next && !next.done && next.value) buf += dec.decode(next.value, { stream: true });
    }

    expect(buf).toContain('event: synced');
    const payload = JSON.parse(buf.slice(buf.indexOf('data: ') + 6, buf.indexOf('\n\n', buf.indexOf('data: '))));
    expect(payload.id).toBe(CONNECTOR_ID);
    void reader.cancel();
  } finally {
    (queryClient as { unsafe: typeof original }).unsafe = original;
    abort.abort(); // releases the handler's 15s heartbeat interval
  }
}, 30_000);
