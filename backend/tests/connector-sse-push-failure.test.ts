// tests/connector-sse-push-failure.test.ts — the connector SSE stream's FAILURE path.
//
// ⛔ WHY THIS FILE EXISTS. `routes/connectors.ts`'s `onSynced` continuation used to end in a bare
// `} catch { /* drop a single failed push */ }` around BOTH the row lookup and the
// `controller.enqueue`. That is a DETACHED async continuation: it runs on the NOTIFY handler's
// stack, long after the SSE response headers went out, so nothing upstream — the route wrapper,
// the access log, the request's own error handling — can ever observe the throw. A swallowed
// failure there produced no log line, no metric and no frame, and the page's optimistic "Syncing"
// pill (routes/connectors/+page.svelte's `syncNow`) only ever leaves that state on a frame. The
// row therefore span forever and the server-side record of why was nothing at all.
//
// `routes/blocks.ts:961` already does this correctly and carries the reasoning; this is the same
// shape on the connector stream.
//
// ⛔ THE FAILURE IS INDUCED THROUGH THE REAL SPINE, NOT A MOCK. `connector-listener.ts`'s
// `fanoutSynced` hands the NOTIFY payload to every subscriber verbatim — it does not validate it —
// so a payload that is not a UUID reaches `eq(datasets.id, payload)` and Postgres rejects the cast
// (`invalid input syntax for type uuid`). That is a genuine database error raised by the real
// query inside the real handler, which is exactly the class of failure (db blip, pool exhaustion,
// a bad payload from another replica) the swallow was hiding.
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
const TENANT = '00000000-0000-0000-0000-0000c5c7f001';
const USER = '00000000-0000-0000-0000-0000c5c7f002';
const CONNECTOR = '00000000-0000-0000-0000-0000c5c7f003';

const user: User = { id: USER, email: 'sse-fail@test', name: 'SSE Fail', roles: ['member'], tenantId: TENANT };

const router = new Router();
registerConnectorRoutes(router);

async function cleanup() {
  await db.delete(datasets).where(eq(datasets.id, CONNECTOR));
  await db.delete(users).where(eq(users.id, USER));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS.
beforeAll(async () => {
  await cleanup();
  __setAuthOverridesForTests({ validateAuth: async () => user });
  await db.insert(tenants).values({ id: TENANT, name: 'SSE Push Failure', slug: 'sse-push-failure' });
  await db.insert(users).values({ id: USER, email: user.email, name: user.name, role: 'employee', tenant_id: TENANT });
  await db.insert(datasets).values({
    id: CONNECTOR,
    owner_id: USER,
    tenant_id: TENANT,
    name: 'Push Failure Connector',
    slug: 'sse-push-failure-connector',
    source_type: 'postgres',
    event_source: 'none',
  });
  await startConnectorListener();
}, 30_000);

afterAll(async () => {
  await releaseConnectorListener();
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

async function openStream() {
  const abort = new AbortController();
  const matched = router.match('GET', '/api/connectors/stream')!;
  const res = await matched.handler(
    new Request('http://localhost/api/connectors/stream', { signal: abort.signal }),
    ...matched.params,
  );
  expect(res.status).toBe(200);
  return { abort, reader: res.body!.getReader() };
}

test('a failed connector push logs AND pushes an `error` frame the client can act on', async () => {
  const s = await openStream();
  const dec = new TextDecoder();
  let buf = '';

  type Stream = Awaited<ReturnType<typeof openStream>>;
  async function pump(stream: Stream): Promise<string> {
    const next = await Promise.race([
      stream.reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), 100)),
    ]);
    return next && !next.done && next.value ? dec.decode(next.value, { stream: true }) : '';
  }

  const logged: string[] = [];
  const realError = console.error;

  try {
    // ── NON-VACUITY FIRST. A real connector id must produce a real `synced` frame, or the negative
    // half below would pass just as well against a stream that delivers nothing to anyone.
    await queryClient.notify(CHANNEL_SYNCED, CONNECTOR);
    for (let i = 0; i < 30 && !buf.includes('event: synced'); i++) buf += await pump(s);
    expect(buf).toContain('event: synced');

    // ── THE FAILURE. Not a UUID → the lookup's cast throws inside the detached continuation.
    buf = '';
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    };
    await queryClient.notify(CHANNEL_SYNCED, 'not-a-uuid');
    for (let i = 0; i < 30 && !buf.includes('event: error'); i++) buf += await pump(s);
  } finally {
    console.error = realError;
    void s.reader.cancel();
    s.abort.abort(); // releases the handler's 15s heartbeat interval
  }

  // (a) the client is told, on a frame `lib/api/connectors.ts`'s `streamConnectors` handles, so the
  //     optimistic "Syncing" pill can leave that state instead of spinning forever.
  expect(buf).toContain('event: error');
  const dataLine = buf.split('\n').find((l) => l.startsWith('data: ') && l.includes('code'));
  expect(dataLine).toBeDefined();
  const payload = JSON.parse(dataLine!.slice('data: '.length)) as { code?: string };
  expect(payload.code).toBe('push_failed');

  // (a2) …and it carries NOTHING ELSE. One NOTIFY reaches every subscribed stream on the pod, so
  //      this frame lands in tenants that have no business knowing the connector exists. The
  //      offending payload must not ride out on it — neither directly nor inside a Postgres error
  //      string, which quotes the value it choked on. Same boundary as
  //      tests/connector-sse-cross-tenant.test.ts, on the error path it did not cover.
  expect(buf).not.toContain('not-a-uuid');
  expect(buf).not.toContain('invalid input syntax');

  // (b) …and the server keeps its own record. This is the ONLY server-side trace of the failure:
  //     the continuation is detached, so no access log or route wrapper ever sees the throw.
  const line = logged.find((l) => l.includes('connector_sync_push_failed'));
  expect(line).toBeDefined();
  expect(line).toContain('not-a-uuid');
}, 30_000);
