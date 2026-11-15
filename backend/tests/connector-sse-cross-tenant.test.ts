// tests/connector-sse-cross-tenant.test.ts — the SSE fan-out's tenant boundary, which only became
// load-bearing when the fan-out started bypassing RLS.
//
// A single `cp_connector_synced` NOTIFY is delivered to EVERY subscribed stream on the pod — the
// listener has one registration per process, not one per tenant. So each stream must decide for
// itself whether the connector that synced is any of its business.
//
// ⛔ WHY THIS FILE HAD TO EXIST. Before the RLS-bypass fix in routes/connectors.ts, the tenant scope
// was enforced twice by accident: the handler compared `d.tenant_id` AND the query ran on the
// `cp_app` pool with no `app.current_tenant`, so RLS returned nothing anyway. Deleting the
// comparison leaked nothing, because the database was still saying no. Resolving the row under
// `runAsSystem` binds the OWNER pool, which BYPASSES RLS — from that point the route's own scoping
// is the ONLY thing standing between tenant A's connector payload and tenant B's open stream. That
// change shipped with no cross-tenant assertion anywhere in the suite; an adversarial review then
// deleted the scope and watched tenant B receive tenant A's connector with all 1188 tests green.
//
// The boundary is now two layers (see the comment at the lookup): the WHERE scopes the query, and
// the `!d` guard turns a miss into a silent return. Because they are layered ON PURPOSE, removing
// EITHER ONE alone leaves this test green — that is defence in depth working, not a weak test.
// Removing the scoping entirely (both layers, i.e. the pre-fix shape) is what reds it, and that is
// the revert this file is written against.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, datasets, users, tenants, queryClient } from '../src/db/client';
import { startConnectorListener } from '../src/datasets/connector-listener';
import { releaseConnectorListener } from './connector-listen-lease';
import { CHANNEL_SYNCED } from '../src/datasets/connector-refresh';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { registerConnectorRoutes } from '../src/routes/connectors';
import { Router } from '../src/utils/router';
import type { User } from '../src/types';

// Ids owned by THIS file only — see tests/fixture-id-collisions.test.ts.
const TENANT_A = '00000000-0000-0000-0000-0000c5c70a01';
const TENANT_B = '00000000-0000-0000-0000-0000c5c70b01';
const USER_A = '00000000-0000-0000-0000-0000c5c70a02';
const USER_B = '00000000-0000-0000-0000-0000c5c70b02';
const CONNECTOR_A = '00000000-0000-0000-0000-0000c5c70a03';

const userA: User = { id: USER_A, email: 'sse-xt-a@test', name: 'Tenant A', roles: ['member'], tenantId: TENANT_A };
const userB: User = { id: USER_B, email: 'sse-xt-b@test', name: 'Tenant B', roles: ['member'], tenantId: TENANT_B };

const router = new Router();
registerConnectorRoutes(router);

async function cleanup() {
  await db.delete(datasets).where(eq(datasets.id, CONNECTOR_A));
  await db.delete(users).where(eq(users.id, USER_A));
  await db.delete(users).where(eq(users.id, USER_B));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS (see license-provisioning).
beforeAll(async () => {
  await cleanup();
  // One override, two identities: the stream under test is chosen per request by a header, so both
  // tenants can hold an open stream in the same process at the same time.
  __setAuthOverridesForTests({
    validateAuth: async (req) => (req.headers.get('x-test-tenant') === 'B' ? userB : userA),
  });
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'SSE Cross-Tenant A', slug: 'sse-cross-tenant-a' },
    { id: TENANT_B, name: 'SSE Cross-Tenant B', slug: 'sse-cross-tenant-b' },
  ]);
  await db.insert(users).values([
    { id: USER_A, email: userA.email, name: userA.name, role: 'employee', tenant_id: TENANT_A },
    { id: USER_B, email: userB.email, name: userB.name, role: 'employee', tenant_id: TENANT_B },
  ]);
  await db.insert(datasets).values({
    id: CONNECTOR_A,
    owner_id: USER_A,
    tenant_id: TENANT_A,
    name: 'Tenant A Connector',
    slug: 'sse-cross-tenant-a-connector',
    source_type: 'postgres',
    event_source: 'none',
  });
  await startConnectorListener();
}, 30_000);

afterAll(async () => {
  // Shared singleton — see tests/connector-listen-lease.ts for why this is NOT `listenClient.end()`.
  await releaseConnectorListener();
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

async function openStream(who: 'A' | 'B') {
  const abort = new AbortController();
  const matched = router.match('GET', '/api/connectors/stream')!;
  const res = await matched.handler(
    new Request('http://localhost/api/connectors/stream', {
      signal: abort.signal,
      headers: { 'x-test-tenant': who },
    }),
    ...matched.params,
  );
  expect(res.status).toBe(200);
  return { abort, reader: res.body!.getReader() };
}

test("tenant B's open stream never receives tenant A's connector", async () => {
  const a = await openStream('A');
  const b = await openStream('B');
  const dec = new TextDecoder();
  let bufA = '';
  let bufB = '';

  // Type inferred from openStream: bun's ReadableStreamDefaultReader carries an extra `readMany`,
  // so a hand-written annotation here does not match what `getReader()` actually returns.
  type Stream = Awaited<ReturnType<typeof openStream>>;
  async function pump(s: Stream): Promise<string> {
    const next = await Promise.race([
      s.reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), 100)),
    ]);
    return next && !next.done && next.value ? dec.decode(next.value, { stream: true }) : '';
  }

  try {
    // The real spine: NOTIFY → listenClient → supervisor → fanoutSynced → BOTH subscribed streams.
    await queryClient.notify(CHANNEL_SYNCED, CONNECTOR_A);
    for (let i = 0; i < 30 && !bufA.includes('event: synced'); i++) {
      const [ra, rb] = await Promise.all([pump(a), pump(b)]);
      bufA += ra;
      bufB += rb;
    }

    // The owning tenant MUST get it — otherwise the negative below is vacuous and would pass just
    // as well against a fan-out that delivers nothing to anyone (which is the bug WS-E fixed).
    expect(bufA).toContain('event: synced');

    // …and B gets a generous extra window in which to be wrong.
    for (let i = 0; i < 10; i++) bufB += await pump(b);
    expect(bufB).not.toContain('event: synced');
    expect(bufB).not.toContain(CONNECTOR_A);
  } finally {
    void a.reader.cancel();
    void b.reader.cancel();
    a.abort.abort(); // releases each handler's 15s heartbeat interval
    b.abort.abort();
  }
}, 30_000);
