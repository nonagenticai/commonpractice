// tests/tenant-suspension-bypass-paths.test.ts — the tenant-suspension gate on the paths that do
// NOT reach it through `validateAuth`.
//
// ⛔ WHAT THIS SUITE EXISTS TO STOP COMING BACK. `middleware/tenant-status-gate.ts` is entered from
// `validateAuth`, so "the route is authenticated" was taken as "the route is gated". An adversarial
// pass found three counter-examples, each measured live with the tenant suspended and every browser
// route answering 403:
//
//   1. `POST /api/connectors/events` — authed by a per-connector webhook SECRET, so it never calls
//      `validateAuth` at all. Returned `{accepted:true,triggered:1}` and issued the refresh NOTIFY:
//      a suspended workspace kept ingesting live data from its source.
//   2. `GET /api/connectors/stream` and `GET /api/runs/:id/stream` — gated only at CONNECT. The gate
//      is PER-REQUEST and an SSE response is one request that never ends, so a stream opened while
//      the tenant was active went on delivering frames 10s and 25s after the suspension.
//   3. `POST /api/delivery/fr-feedback` — DOES call `validateAuth`, and the gate there is a
//      STRUCTURAL NO-OP: the fr service-account JWT carries no `tenant_id` claim, so the gate takes
//      its documented null-tenant branch and checks nothing, while the route writes against the
//      tenant id in the request BODY.
//
// Harness copied from tests/tenant-suspension-gate.test.ts (real rows against the live test DB,
// `__setAuthOverridesForTests` for identity, explicit 30_000 hook timeouts) and from
// tests/connector-sse-cross-tenant.test.ts (driving the real router, reading the SSE body through a
// reader). Ids are owned by THIS file only — see tests/fixture-id-collisions.test.ts.
//
// EVERY REFUSAL CASE ASSERTS THE ERROR CODE OR THE OBSERVABLE EFFECT, NEVER A BARE STATUS: several
// other guards on these same paths answer 403/404, so `toBe(403)` alone would go green while the
// gate did nothing.
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  datasets,
  users,
  tenants,
  challenges,
  solutions,
  solutionDeliveries,
  flows,
  flowRuns,
  auditLog,
} from '../src/db/client';
import { runRegistry, type RunHandle } from '../src/host/run-controller';
import { encryptSecret } from '../src/host/secret-box';
import { __setAuthOverridesForTests, validateAuth } from '../src/middleware/auth';
import {
  registerConnectorRoutes,
  __setSseHeartbeatMsForTests,
} from '../src/routes/connectors';
import { registerDeliveryRoutes } from '../src/routes/delivery';
import {
  registerRunStream,
  __setRunStreamHeartbeatMsForTests,
} from '../src/host/sse-stream';
import { Router } from '../src/utils/router';
import type { User } from '../src/types';
import { config } from '../src/config';

// v4-format uuids throughout: `frFeedbackSchema.tenant_id` is a zod `.uuid()`, which enforces the
// version/variant nibbles, so a v0-shaped fixture would fail validation before reaching the gate
// and the test would pass for the wrong reason.
const T_SUSPENDED = '00000000-0000-4000-8000-00005b7a0001';
const T_ACTIVE = '00000000-0000-4000-8000-00005b7a0002';
const U_SUSPENDED = '00000000-0000-4000-8000-00005b7a0011';
const U_ACTIVE = '00000000-0000-4000-8000-00005b7a0012';
const CONN_SUSPENDED = '00000000-0000-4000-8000-00005b7a0021';
const CONN_ACTIVE = '00000000-0000-4000-8000-00005b7a0022';
const CH_SUSPENDED = '00000000-0000-4000-8000-00005b7a0031';
const SOL_SUSPENDED = '00000000-0000-4000-8000-00005b7a0041';
const CH_ACTIVE = '00000000-0000-4000-8000-00005b7a0032';
const SOL_ACTIVE = '00000000-0000-4000-8000-00005b7a0042';
const FLOW_ACTIVE = '00000000-0000-4000-8000-00005b7a0061';
/** A `flow_runs` row in status 'running' that is NOT in this pod's `runRegistry` — the
 *  cross-replica TAIL branch of `streamRun`. */
const RUN_TAILED = '00000000-0000-4000-8000-00005b7a0051';
/** A run served from `runRegistry` — the LIVE branch of `streamRun`. Registry lookup is by id
 *  only, so this one needs no database row. */
const RUN_LIVE = '00000000-0000-4000-8000-00005b7a0052';
const EMPTY_GRAPH = { nodes: [], edges: [] } as never;
/** A syntactically valid uuid with no `datasets` row — the "unknown connector" control the
 *  suspended answer must be indistinguishable from. */
const CONN_MISSING = '00000000-0000-4000-8000-00005b7a00ff';
/** The fr-backend service-account subject. Claim-only auth: no CP `users` row, NO TENANT CLAIM. */
const SA_ID = '00000000-0000-4000-8000-00005b7a0f5a';

const EVENT_SECRET = 'suspension-bypass-event-secret-aaaa';
/** Long enough to differ from EVENT_SECRET; `verifyEventSecret` length-checks before comparing. */
const WRONG_SECRET = 'suspension-bypass-event-secret-bbbb';

/** Fast enough that a heartbeat-driven re-check is observable inside a test, instead of 15s.
 *  The interval under test is the PRODUCTION keepalive — this only shortens its period. */
const TICK_MS = 40;

const memberOf = (tenantId: string, id: string): User => ({
  id,
  email: `${id}@suspension-bypass-test`,
  name: 'Member',
  roles: ['member'],
  tenantId,
});

/** The fr SA identity: roles carry the writer role, and `tenantId` is deliberately undefined —
 *  that absence is precisely what makes `assertTenantActive` a no-op on this route. */
const frWriter: User = {
  id: SA_ID,
  email: '',
  name: '',
  roles: ['delivery-feedback-writer'],
  tenantId: undefined,
  // The door pins issuer + client (realm-per-app P7, middleware/fr-feedback-auth.ts).
  issuer: config.keycloak.issuer,
  azp: 'fr-backend',
};

const router = new Router();
registerConnectorRoutes(router);
registerDeliveryRoutes(router);
registerRunStream(router);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const m = router.match(method, path)!;
  expect(m).not.toBeNull();
  return m.handler(
    new Request(`http://t${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    ...m.params,
  );
}

async function cleanup(): Promise<void> {
  runRegistry.delete(RUN_LIVE);
  await db.delete(flowRuns).where(inArray(flowRuns.id, [RUN_TAILED]));
  await db.delete(flows).where(inArray(flows.id, [FLOW_ACTIVE]));
  await db
    .delete(solutionDeliveries)
    .where(inArray(solutionDeliveries.tenant_id, [T_SUSPENDED, T_ACTIVE]));
  await db.delete(solutions).where(inArray(solutions.id, [SOL_SUSPENDED, SOL_ACTIVE]));
  await db.delete(challenges).where(inArray(challenges.id, [CH_SUSPENDED, CH_ACTIVE]));
  await db.delete(datasets).where(inArray(datasets.id, [CONN_SUSPENDED, CONN_ACTIVE]));
  await db.delete(auditLog).where(inArray(auditLog.actor_id, [U_SUSPENDED, U_ACTIVE]));
  await db.delete(users).where(inArray(users.id, [U_SUSPENDED, U_ACTIVE]));
  await db.delete(tenants).where(inArray(tenants.id, [T_SUSPENDED, T_ACTIVE]));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS (see the long note in
// tests/license-provisioning.test.ts), so a slow one fails as "(unnamed) [5003ms]" with no cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: T_SUSPENDED, name: 'Bypass Suspended Co', slug: 'suspension-bypass-suspended' },
    { id: T_ACTIVE, name: 'Bypass Active Co', slug: 'suspension-bypass-active' },
  ]);
  await db.insert(users).values([
    {
      id: U_SUSPENDED,
      email: `${U_SUSPENDED}@suspension-bypass-test`,
      name: 'Member',
      tenant_id: T_SUSPENDED,
    },
    {
      id: U_ACTIVE,
      email: `${U_ACTIVE}@suspension-bypass-test`,
      name: 'Member',
      tenant_id: T_ACTIVE,
    },
  ]);
  // Two webhook connectors carrying the SAME event secret, one per tenant. Same secret on purpose:
  // it makes the suspended/active pair differ in EXACTLY ONE variable — the tenant's status.
  await db.insert(datasets).values([
    {
      id: CONN_SUSPENDED,
      owner_id: U_SUSPENDED,
      tenant_id: T_SUSPENDED,
      name: 'Bypass Suspended Connector',
      slug: 'suspension-bypass-suspended-connector',
      source_type: 'storage' as const,
      event_source: 'webhook' as const,
      event_secret_encrypted: encryptSecret(EVENT_SECRET),
      connection_meta: {
        kind: 'storage' as const,
        host: 'minio.example.com',
        bucket: 'cp-suspension-bypass',
        key: 'inbox/claims.csv',
      },
    },
    {
      id: CONN_ACTIVE,
      owner_id: U_ACTIVE,
      tenant_id: T_ACTIVE,
      name: 'Bypass Active Connector',
      slug: 'suspension-bypass-active-connector',
      source_type: 'storage' as const,
      event_source: 'webhook' as const,
      event_secret_encrypted: encryptSecret(EVENT_SECRET),
      connection_meta: {
        kind: 'storage' as const,
        host: 'minio.example.com',
        bucket: 'cp-suspension-bypass',
        key: 'inbox/claims.csv',
      },
    },
  ]);
  await db.insert(challenges).values([
    {
      id: CH_SUSPENDED,
      title: 'Bypass CH suspended',
      description: 'd',
      business_impact: 'b',
      work_area: 'w',
      metrics: {},
      tags: [],
      submitter_id: U_SUSPENDED,
      tenant_id: T_SUSPENDED,
    },
    {
      id: CH_ACTIVE,
      title: 'Bypass CH active',
      description: 'd',
      business_impact: 'b',
      work_area: 'w',
      metrics: {},
      tags: [],
      submitter_id: U_ACTIVE,
      tenant_id: T_ACTIVE,
    },
  ]);
  await db.insert(solutions).values([
    {
      id: SOL_SUSPENDED,
      challenge_id: CH_SUSPENDED,
      title: 'Bypass SOL suspended',
      author_id: U_SUSPENDED,
      blocks_used: [],
      tenant_id: T_SUSPENDED,
    },
    {
      id: SOL_ACTIVE,
      challenge_id: CH_ACTIVE,
      title: 'Bypass SOL active',
      author_id: U_ACTIVE,
      blocks_used: [],
      tenant_id: T_ACTIVE,
    },
  ]);
  // A run that is genuinely 'running' and NOT in this pod's registry, so `streamRun` takes its
  // cross-replica tail branch and the stream stays open indefinitely — which is exactly the
  // long-lived response the connect-time gate could not reach.
  await db
    .insert(flows)
    .values({ id: FLOW_ACTIVE, name: 'bypass flow', owner_id: U_ACTIVE, graph: EMPTY_GRAPH, tenant_id: T_ACTIVE });
  await db.insert(flowRuns).values({
    id: RUN_TAILED,
    flow_id: FLOW_ACTIVE,
    tenant_id: T_ACTIVE,
    triggered_by: U_ACTIVE,
    status: 'running',
  });
}, 30_000);

beforeEach(async () => {
  // Re-assert the statuses every time: several cases below flip T_SUSPENDED back to 'active' to
  // prove a control, and every other case depends on it being suspended.
  await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, T_SUSPENDED));
  await db.update(tenants).set({ status: 'active' }).where(eq(tenants.id, T_ACTIVE));
  await db
    .delete(solutionDeliveries)
    .where(inArray(solutionDeliveries.tenant_id, [T_SUSPENDED, T_ACTIVE]));
  __setAuthOverridesForTests(undefined);
  __setSseHeartbeatMsForTests(TICK_MS);
  __setRunStreamHeartbeatMsForTests(TICK_MS);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setSseHeartbeatMsForTests(undefined);
  __setRunStreamHeartbeatMsForTests(undefined);
  await cleanup();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HOLE 1 — POST /api/connectors/events (webhook secret, never reaches validateAuth).
// ─────────────────────────────────────────────────────────────────────────────────────────────

const EVENTS = '/api/connectors/events';

async function postEvent(connector: string, secret: string) {
  const res = await call('POST', EVENTS, { connector, secret });
  return { status: res.status, body: (await res.json()) as { accepted: boolean; triggered: number } };
}

test('⛔ HOLE 1: a webhook event for a SUSPENDED tenant triggers NOTHING', async () => {
  // Before the gate: this returned triggered:1 and issued the refresh NOTIFY while every browser
  // route for the same workspace answered 403.
  const { status, body } = await postEvent(CONN_SUSPENDED, EVENT_SECRET);
  expect(body.triggered).toBe(0);
  expect(status).toBe(202);
});

test('HOLE 1 NEGATIVE CONTROL: the identical event on an ACTIVE tenant DOES trigger', async () => {
  // Without this, the case above is green against a handler that triggers nothing ever — i.e. it
  // would pass just as well if the whole ingress were broken. Same secret, same body shape, same
  // route; the ONLY difference is `tenants.status`.
  const { status, body } = await postEvent(CONN_ACTIVE, EVENT_SECRET);
  expect(body.triggered).toBe(1);
  expect(status).toBe(202);
});

test('HOLE 1 NEGATIVE CONTROL: reactivating the workspace restores the ingress immediately', async () => {
  // No process-level cache to expire (the gate's Decision 2) — the very next event must land.
  await db.update(tenants).set({ status: 'active' }).where(eq(tenants.id, T_SUSPENDED));
  const { body } = await postEvent(CONN_SUSPENDED, EVENT_SECRET);
  expect(body.triggered).toBe(1);
});

test('⛔ HOLE 1: the refusal is INDISTINGUISHABLE from an unknown connector or a bad secret', async () => {
  // The response-shape decision, pinned. This ingress answers a CONSTANT 202 for every outcome so
  // it is not an oracle for valid connector ids/secrets. A 403 would fire ONLY after BOTH a real id
  // AND a matching secret — confirming both to a prober — and would tell an external storage
  // provider a commercial fact about our customer. Byte-identical answers, deliberately.
  const suspended = await postEvent(CONN_SUSPENDED, EVENT_SECRET);
  const unknown = await postEvent(CONN_MISSING, EVENT_SECRET);
  const badSecret = await postEvent(CONN_ACTIVE, WRONG_SECRET);
  expect(suspended).toEqual(unknown);
  expect(suspended).toEqual(badSecret);
});

test('⛔ HOLE 1: the wire carries no suspension detail at all', async () => {
  const res = await call('POST', EVENTS, { connector: CONN_SUSPENDED, secret: EVENT_SECRET });
  const text = await res.text();
  expect(text).not.toContain('tenant_suspended');
  expect(text).not.toContain('suspend');
});

test('⛔ HOLE 1: one suspended tenant does not suppress another tenant on the SAME bucket', async () => {
  // The bucket-notification branch resolves connectors ACROSS tenants (RLS-bypassing lookup), so
  // the check has to be per-connector. A per-request short-circuit would silently stop a paying
  // customer's ingest because a neighbour was suspended.
  const res = await call('POST', EVENTS, {
    secret: EVENT_SECRET,
    Records: [{ s3: { bucket: { name: 'cp-suspension-bypass' } } }],
  });
  const body = (await res.json()) as { triggered: number };
  expect(body.triggered).toBe(1); // the ACTIVE tenant's connector only
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HOLE 2 — the SSE streams. THE GATE IS PER-REQUEST; A STREAM IS ONE REQUEST THAT NEVER ENDS.
//
// ⛔ EVERY CASE HERE OPENS WHILE THE TENANT IS ACTIVE AND SUSPENDS AFTERWARDS. A test that merely
//    asserts "connect is refused when already suspended" does NOT cover this defect — connect was
//    ALWAYS gated (`resolveTenant`/`validateAuth` run the gate once). The hole is the stream that
//    already exists at the moment of suspension, which nothing terminated.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function asMember(tenantId: string, userId: string): void {
  __setAuthOverridesForTests({ validateAuth: async () => memberOf(tenantId, userId) });
}

async function openStream(path: string) {
  const abort = new AbortController();
  const m = router.match('GET', path)!;
  expect(m).not.toBeNull();
  const res = await m.handler(
    new Request(`http://t${path}`, { signal: abort.signal }),
    ...m.params,
  );
  expect(res.status).toBe(200);
  return { abort, reader: res.body!.getReader() };
}

type Stream = Awaited<ReturnType<typeof openStream>>;

/**
 * Read until `needle` appears, the stream ends, or `maxMs` elapses.
 *
 * ⚠️ THE PENDING `read()` IS HELD ACROSS TIMEOUTS ON PURPOSE. The obvious shape — racing a fresh
 * `reader.read()` against a timer each iteration — abandons a read that has not settled yet, and
 * the chunk it later resolves with is delivered to a promise nobody awaits: silently LOST. On a
 * stream whose whole point is one terminal frame, losing that frame makes this helper report a
 * missing `event: error` for a gate that fired correctly.
 */
async function readUntil(
  s: Stream,
  needle: string,
  maxMs = 4000,
): Promise<{ text: string; ended: boolean }> {
  const dec = new TextDecoder();
  let text = '';
  let ended = false;
  const deadline = Date.now() + maxMs;
  let pending: ReturnType<Stream['reader']['read']> | null = null;
  while (Date.now() < deadline && !text.includes(needle)) {
    if (!pending) pending = s.reader.read();
    const settled = await Promise.race([
      pending.then((r) => ({ r })),
      new Promise<null>((res) => setTimeout(() => res(null), 25)),
    ]);
    if (!settled) continue; // not yet — keep the SAME read promise, see the note above
    pending = null;
    if (settled.r.done) {
      ended = true;
      break;
    }
    if (settled.r.value) text += dec.decode(settled.r.value, { stream: true });
  }
  return { text, ended };
}

/** A needle that can never occur in an SSE frame — used to drain until the stream ends. */
const NEVER = 'this-token-never-appears-on-the-wire';

function closeStream(s: Stream): void {
  void s.reader.cancel().catch(() => {});
  s.abort.abort(); // releases the handler's keepalive interval
}

test('⛔ HOLE 2a: an OPEN /api/connectors/stream is terminated when the tenant is suspended MID-STREAM', async () => {
  asMember(T_ACTIVE, U_ACTIVE);
  const s = await openStream('/api/connectors/stream');
  try {
    // It is genuinely alive first — otherwise "it stopped" proves nothing.
    const warm = await readUntil(s, ': ping', 2000);
    expect(warm.text).toContain(': ping');
    expect(warm.ended).toBe(false);

    // The event the connect-time gate can never see.
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, T_ACTIVE));

    const refused = await readUntil(s, 'tenant_suspended', 4000);
    expect(refused.text).toContain('event: error');
    expect(refused.text).toContain('tenant_suspended');

    // …and the stream is CLOSED, not merely annotated: a frame with no close leaves the client
    // subscribed and still receiving `synced` pushes.
    const drained = await readUntil(s, NEVER, 2000);
    expect(drained.ended).toBe(true);
  } finally {
    closeStream(s);
  }
}, 30_000);

test('HOLE 2a NEGATIVE CONTROL: a stream on a tenant that STAYS active is never terminated', async () => {
  // Kills the "close on every tick" mutation, which passes the case above perfectly. Several
  // re-check ticks must pass with the tenant active and the stream must still be delivering.
  asMember(T_ACTIVE, U_ACTIVE);
  const s = await openStream('/api/connectors/stream');
  try {
    const first = await readUntil(s, ': ping', 2000);
    expect(first.text).toContain(': ping');
    const later = await readUntil(s, NEVER, TICK_MS * 10);
    expect(later.ended).toBe(false);
    expect(later.text).not.toContain('event: error');
    expect(later.text).toContain(': ping'); // still ticking, so the re-check really did run
  } finally {
    closeStream(s);
  }
}, 30_000);

test('⛔ HOLE 2b: an OPEN /api/runs/:id/stream (tail branch) is terminated on mid-stream suspension', async () => {
  asMember(T_ACTIVE, U_ACTIVE);
  const s = await openStream(`/api/runs/${RUN_TAILED}/stream`);
  try {
    const warm = await readUntil(s, ': ping', 2000);
    expect(warm.text).toContain(': ping');
    expect(warm.ended).toBe(false);

    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, T_ACTIVE));

    const refused = await readUntil(s, 'tenant_suspended', 4000);
    expect(refused.text).toContain('event: error');
    expect(refused.text).toContain('tenant_suspended');
    // ⛔ NOT `event: end`. That frame means "the run finished" on this endpoint (sse-stream.ts
    // emits it on run_complete and on a terminal tail), and rendering a cut-off workspace as a
    // completed run is a lie the UI would show as success.
    expect(refused.text).not.toContain('event: end');

    const drained = await readUntil(s, NEVER, 2000);
    expect(drained.ended).toBe(true);
  } finally {
    closeStream(s);
  }
}, 30_000);

test('⛔ HOLE 2c: an OPEN /api/runs/:id/stream (LIVE registry branch) is terminated too', async () => {
  // `streamRun` has TWO heartbeats — one per branch — and fixing only the branch a test happens to
  // exercise leaves the other wide open. This is the live-run branch: the run is served from
  // `runRegistry`, never from the database.
  //
  // The handle is minimal on purpose: this branch reads exactly `userId`, `events`, `completed`
  // and `subscribers`. Building a full RunHandle would mean spawning a real runner subprocess to
  // test a timer.
  const handle = {
    runId: RUN_LIVE,
    userId: U_ACTIVE,
    tenantId: T_ACTIVE,
    events: [],
    completed: false,
    subscribers: new Set(),
  } as unknown as RunHandle;
  runRegistry.set(RUN_LIVE, handle);
  asMember(T_ACTIVE, U_ACTIVE);
  const s = await openStream(`/api/runs/${RUN_LIVE}/stream`);
  try {
    const warm = await readUntil(s, ': ping', 2000);
    expect(warm.text).toContain(': ping');

    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, T_ACTIVE));

    const refused = await readUntil(s, 'tenant_suspended', 4000);
    expect(refused.text).toContain('event: error');
    const drained = await readUntil(s, NEVER, 2000);
    expect(drained.ended).toBe(true);
  } finally {
    closeStream(s);
    runRegistry.delete(RUN_LIVE);
  }
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HOLE 3 — POST /api/delivery/fr-feedback (validateAuth runs; the gate is a structural no-op).
// ─────────────────────────────────────────────────────────────────────────────────────────────

const FEEDBACK = '/api/delivery/fr-feedback';

async function seedFrDelivery(tenantId: string, solutionId: string, ref: string, actor: string) {
  const [row] = await db
    .insert(solutionDeliveries)
    .values({
      tenant_id: tenantId,
      solution_id: solutionId,
      target_id: null,
      target_kind: 'fr',
      initiated_by: actor,
      status: 'draft_created',
      external_ref: ref,
      external_url: `https://fr.example.com/projects/requests/${ref}`,
      // The ledger's canonical payload is irrelevant to a gate that must refuse before any read;
      // `as never` keeps the fixture honest about that rather than fabricating a plausible one.
      payload: {} as never,
    })
    .returning();
  return row!;
}

function asFrWriter(): void {
  __setAuthOverridesForTests({ validateAuth: async () => frWriter });
}

test('⛔ HOLE 3 NON-VACUITY: validateAuth alone does NOT refuse the fr SA on a suspended tenant', async () => {
  // This is the whole reason hole 3 existed, asserted rather than asserted-about-in-a-comment. The
  // SA token is claim-only and carries no `tenant_id`, so `assertTenantActive` resolves a null
  // tenant and returns without reading `tenants` at all. Passing this guard is therefore NOT
  // evidence that suspension was checked — the route must check the tenant it acts on.
  asFrWriter();
  const user = await validateAuth(new Request('http://t/api/delivery/fr-feedback'));
  expect(user.tenantId).toBeUndefined();
});

test('⛔ HOLE 3: fr-feedback for a SUSPENDED tenant → 403 tenant_suspended, and the row is untouched', async () => {
  asFrWriter();
  await seedFrDelivery(T_SUSPENDED, SOL_SUSPENDED, 'pr-susp', U_SUSPENDED);
  const res = await call('POST', FEEDBACK, {
    project_request_id: 'pr-susp',
    fr_project_id: 'fr-proj-susp',
    tenant_id: T_SUSPENDED,
  });
  expect(res.status).toBe(403);
  // The CODE, not the status: `fr_feedback_forbidden`, `delivery_not_found` and
  // `delivery_solution_mismatch` are all reachable refusals on this route.
  expect(((await res.json()) as { error: string }).error).toBe('tenant_suspended');

  const [row] = await db
    .select()
    .from(solutionDeliveries)
    .where(eq(solutionDeliveries.external_ref, 'pr-susp'));
  expect(row!.status).toBe('draft_created'); // no write reached the ledger
  expect(row!.fr_project_id).toBeNull();
});

test('HOLE 3 NEGATIVE CONTROL: the identical post on an ACTIVE tenant promotes normally', async () => {
  // Kills the "refuse every fr-feedback" mutation, which passes the case above perfectly.
  asFrWriter();
  await seedFrDelivery(T_ACTIVE, SOL_ACTIVE, 'pr-active', U_ACTIVE);
  const res = await call('POST', FEEDBACK, {
    project_request_id: 'pr-active',
    fr_project_id: 'fr-proj-active',
    tenant_id: T_ACTIVE,
  });
  expect(res.status).toBe(200);
  const [row] = await db
    .select()
    .from(solutionDeliveries)
    .where(eq(solutionDeliveries.external_ref, 'pr-active'));
  expect(row!.status).toBe('promoted');
});

test('HOLE 3: the gate judges the BODY tenant, not the caller — a suspended body tenant loses', async () => {
  // The route's authority is `body.tenant_id` (it is what `withTenantDb` binds and what the WHERE
  // matches), so that is what must be judged. Nothing about the SA changes between this case and
  // the control above.
  asFrWriter();
  await seedFrDelivery(T_SUSPENDED, SOL_SUSPENDED, 'pr-body', U_SUSPENDED);
  await seedFrDelivery(T_ACTIVE, SOL_ACTIVE, 'pr-body-active', U_ACTIVE);
  const refused = await call('POST', FEEDBACK, {
    project_request_id: 'pr-body',
    fr_project_id: 'x',
    tenant_id: T_SUSPENDED,
  });
  const allowed = await call('POST', FEEDBACK, {
    project_request_id: 'pr-body-active',
    fr_project_id: 'y',
    tenant_id: T_ACTIVE,
  });
  expect(refused.status).toBe(403);
  expect(allowed.status).toBe(200);
});
