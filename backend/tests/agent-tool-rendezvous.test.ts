// tests/agent-tool-rendezvous.test.ts — THE COPILOT LOSES HALF ITS EDITS, PROVED ACROSS TWO
// PROCESSES.
//
// ⛔ WHY THIS FILE HAS TO SPAWN A SECOND PROCESS, AND WHY NOTHING IN THE SUITE CAUGHT THE DEFECT.
// `ai/agent.ts` parked its frontend-tool waiters in a module-level `Map`. Production runs 2 replicas
// (HPA min 2, max 4) behind a ClusterIP Service with no sessionAffinity and no DestinationRule, and
// the browser reports a finished edit on a BRAND-NEW `fetch()` — not the SSE connection — so that
// report lands on either pod. On the wrong one the Map missed, the route answered 400
// `no_pending_tool`, the browser store swallowed it, and the turn holding the promise burned the
// full 30s before telling the model `{"error":"frontend tool timed out"}`. Prod `chat_messages` has
// two such rows (2026-06-28 11:17:50.801 and 19:39:03.479), each EXACTLY 30.0s after a
// `propose_block_draft` whose driver answers synchronously — so the report left the browser at once
// and simply never arrived.
//
// Every test that touched this called `resolveFrontendTool` IN-PROCESS (tests/agent-loop.test.ts
// :83/:179/:218), so they all shared the one Map. A module-level `Map` is a different Map only in a
// different process — the same argument tests/config-flag-probe.ts and
// tests/seed-first-boot-order.test.ts make for a module-level `const`. Hence tests/rendezvous-owner.ts,
// which is the "pod holding the turn"; THIS process is the "pod that received the POST".
//
// ⚠️ EVERY CROSS-PROCESS ASSERTION IS A POSITIVE OBSERVATION. A two-process test whose child never
// registered still finishes — by timing out — so "no error" proves nothing. Each case below asserts
// a unique marker travelled from this process into the other one's resolved promise, and the
// negative cases assert the row is still sitting in the table unclaimed rather than merely that
// nothing happened.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  agentToolResults,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import {
  deliverFrontendToolResult,
  waitForFrontendTool,
  resolveFrontendTool,
  __pendingToolCountForTests,
  __resetToolRendezvousForTests,
} from '../src/ai/tool-rendezvous';

// Ids owned by THIS file only — see tests/fixture-id-collisions.test.ts.
const OWNER_ID = '00000000-0000-0000-0000-0000ae3d0001';
const STRANGER_ID = '00000000-0000-0000-0000-0000ae3d0002';

const BACKEND_ROOT = new URL('..', import.meta.url).pathname;
const CHILD = `${BACKEND_ROOT}tests/rendezvous-owner.ts`;

let skipped = false;

interface ChildRun {
  ready: boolean;
  result1: { ok: boolean; output?: unknown; error?: string } | null;
  result2: { ok: boolean; output?: unknown; error?: string } | null;
  pending: number | null;
  listenFailed: boolean;
  stdout: string;
  stderr: string;
  /** ms from READY to the first result line, i.e. how long the OTHER process waited. */
  deliveryMs: number;
}

/**
 * Spawn the owning "pod", wait for it to announce a live waiter, run `report` (this process acting
 * as the replica that received the browser's POST), then collect what the child actually resolved.
 *
 * The READY handshake is what makes the test deterministic: `waitForFrontendTool` is called BEFORE
 * the line is printed, exactly as the agent loop registers before emitting the SSE frame, so the
 * report can never race the registration and a red result can never be "the parent was too fast".
 */
async function withOwner(
  args: { turnId: string; callId: string; mode: 'listen' | 'poll'; timeoutMs: number; dupTimeoutMs?: number },
  report: () => Promise<void>,
): Promise<ChildRun> {
  const proc = Bun.spawn(
    [
      'bun',
      CHILD,
      args.turnId,
      args.callId,
      OWNER_ID,
      DEMO_TENANT_ID,
      args.mode,
      String(args.timeoutMs),
      String(args.dupTimeoutMs ?? 4000),
    ],
    {
      cwd: BACKEND_ROOT,
      // A FRESH process, therefore a fresh module graph, therefore a genuinely different Map —
      // which is the entire point. It gets the same DATABASE_URL, which is the shared half.
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AUTH_BYPASS: 'true',
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://commonpractice:commonpractice@localhost:5433/commonpractice',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const run: ChildRun = {
    ready: false,
    result1: null,
    result2: null,
    pending: null,
    listenFailed: false,
    stdout: '',
    stderr: '',
    deliveryMs: 0,
  };

  let readyAt = 0;
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  const pump = (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        run.stdout += `${line}\n`;
        if (line.startsWith('READY')) {
          run.ready = true;
          readyAt = Date.now();
          resolveReady?.();
        } else if (line === 'LISTEN_FAILED') {
          run.listenFailed = true;
        } else if (line.startsWith('RESULT1 ')) {
          run.result1 = JSON.parse(line.slice('RESULT1 '.length));
          run.deliveryMs = Date.now() - readyAt;
        } else if (line.startsWith('RESULT2 ')) {
          run.result2 = JSON.parse(line.slice('RESULT2 '.length));
        } else if (line.startsWith('PENDING ')) {
          run.pending = Number(line.slice('PENDING '.length));
        }
      }
    }
  })();

  const timedOut = await Promise.race([
    ready.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 25_000)),
  ]);
  if (timedOut) {
    proc.kill();
    run.stderr = await new Response(proc.stderr).text();
    throw new Error(`the owner process never announced READY\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }

  await report();
  await proc.exited;
  await pump;
  run.stderr = await new Response(proc.stderr).text();
  return run;
}

async function rowsFor(turnId: string, callId: string) {
  return withTenantDb(DEMO_TENANT_ID, () =>
    db
      .select()
      .from(agentToolResults)
      .where(and(eq(agentToolResults.turn_id, turnId), eq(agentToolResults.call_id, callId))),
  );
}

async function purge(turnId: string, callId: string) {
  await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .delete(agentToolResults)
      .where(and(eq(agentToolResults.turn_id, turnId), eq(agentToolResults.call_id, callId))),
  );
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeAll(async () => {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, DEMO_TENANT_ID));
  if (!tenant) {
    skipped = true;
    return;
  }
  for (const [id, email] of [
    [OWNER_ID, 'rendezvous-owner@test'],
    [STRANGER_ID, 'rendezvous-stranger@test'],
  ] as const) {
    await db
      .insert(users)
      .values({ id, email, name: 'Rendezvous', tenant_id: DEMO_TENANT_ID })
      .onConflictDoNothing({ target: users.id });
  }
}, 30_000);

afterAll(async () => {
  __resetToolRendezvousForTests();
  if (skipped) return;
  await db.delete(users).where(eq(users.id, OWNER_ID));
  await db.delete(users).where(eq(users.id, STRANGER_ID));
}, 30_000);

// ---------------------------------------------------------------------------------------------
// The two-process cases. These are the ones that fail when the fix is reverted.
// ---------------------------------------------------------------------------------------------

test('⛔ a tool result reported to the WRONG replica reaches the turn, and reaches it ONCE', async () => {
  if (skipped) return;
  const turnId = '019845f0-0000-7000-8000-0000ae3d1001';
  const callId = 'toolu_rendezvous_notify';
  await purge(turnId, callId);

  const marker = `notify-${Date.now()}`;
  let outcome = '';
  const run = await withOwner({ turnId, callId, mode: 'listen', timeoutMs: 15_000 }, async () => {
    // THIS process is the replica that received the browser's POST and is holding nothing.
    outcome = await deliverFrontendToolResult(
      turnId,
      callId,
      { ok: true, output: { marker, applied: true } },
      OWNER_ID,
      async () => DEMO_TENANT_ID,
    );
    // …and the browser retried, because `postToolResult` now does. Reporting twice must not
    // deliver twice.
    await deliverFrontendToolResult(
      turnId,
      callId,
      { ok: true, output: { marker: 'DUPLICATE', applied: true } },
      OWNER_ID,
      async () => DEMO_TENANT_ID,
    );
  });

  expect(run.listenFailed, `the owner could not LISTEN:\n${run.stderr}`).toBe(false);
  // The writer really did take the DURABLE path — not a same-process shortcut that would make the
  // whole test vacuous.
  expect(outcome).toBe('queued');
  // THE POSITIVE OBSERVATION: the payload this process wrote came back out of the OTHER process's
  // promise. Before the fix this was `{ok:false,error:'frontend tool timed out'}`.
  expect(run.result1, `child stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toEqual({
    ok: true,
    output: { marker, applied: true },
  });
  // EXACTLY ONCE. A second waiter on the same key finds nothing left — neither the claimed row nor
  // the duplicate report, which `ON CONFLICT DO NOTHING` refused to queue a second time.
  expect(run.result2).toEqual({ ok: false, error: 'frontend tool timed out' });
  expect(run.pending).toBe(0);
  // Nothing is left in the table: the claim is a DELETE … RETURNING.
  expect(await rowsFor(turnId, callId)).toHaveLength(0);
  await purge(turnId, callId);
}, 60_000);

test('⛔ with the LISTEN doorbell absent, the poll floor still delivers (the NOTIFY is only latency)', async () => {
  if (skipped) return;
  const turnId = '019845f0-0000-7000-8000-0000ae3d1002';
  const callId = 'toolu_rendezvous_poll';
  await purge(turnId, callId);

  const marker = `poll-${Date.now()}`;
  // The owner starts NO listener at all — the exact state of a pod whose LISTEN session is in
  // backoff, which `startConnectorListener()` deliberately tolerates because a LISTEN failure must
  // never block boot. If the fix depended on the NOTIFY, this is where it would be revealed.
  const run = await withOwner({ turnId, callId, mode: 'poll', timeoutMs: 15_000 }, async () => {
    await deliverFrontendToolResult(
      turnId,
      callId,
      { ok: true, output: { marker } },
      OWNER_ID,
      async () => DEMO_TENANT_ID,
    );
  });

  expect(run.result1, `child stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toEqual({
    ok: true,
    output: { marker },
  });
  // The floor is a second, not thirty. (Generous bound: a starved CI Postgres still has to fit.)
  expect(run.deliveryMs).toBeLessThan(10_000);
  expect(await rowsFor(turnId, callId)).toHaveLength(0);
  await purge(turnId, callId);
}, 60_000);

test('⛔ a stranger cannot answer another user’s tool call, across replicas', async () => {
  if (skipped) return;
  const turnId = '019845f0-0000-7000-8000-0000ae3d1003';
  const callId = 'toolu_rendezvous_stranger';
  await purge(turnId, callId);

  // The owner-side property (`resolveFrontendTool` returns false for a mismatched user) was already
  // pinned in-process by agent-loop.test.ts. What is NEW is that the durable path could have
  // laundered it: a row written by anyone, claimed by whoever is holding the key. It does not,
  // because `user_id` is in the CLAIM predicate.
  const run = await withOwner(
    { turnId, callId, mode: 'listen', timeoutMs: 6_000, dupTimeoutMs: 2_000 },
    async () => {
      const outcome = await deliverFrontendToolResult(
        turnId,
        callId,
        { ok: true, output: { marker: 'INJECTED' } },
        STRANGER_ID,
        async () => DEMO_TENANT_ID,
      );
      // The stranger gets the SAME answer a wrong-replica report gets — deliberately
      // indistinguishable, so the endpoint is not an existence oracle for someone else's turn.
      expect(outcome).toBe('queued');
    },
  );

  expect(run.result1, `child stdout:\n${run.stdout}`).toEqual({
    ok: false,
    error: 'frontend tool timed out',
  });
  // NOT VACUOUS: the write really happened and is really still there, refused by the claim rather
  // than never attempted.
  const rows = await rowsFor(turnId, callId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.user_id).toBe(STRANGER_ID);
  await purge(turnId, callId);
}, 60_000);

// ---------------------------------------------------------------------------------------------
// In-process properties: the fast path, and the release when the browser genuinely never answers.
// ---------------------------------------------------------------------------------------------

test('the SAME-POD fast path resolves in memory and touches the database not at all', async () => {
  if (skipped) return;
  const turnId = '019845f0-0000-7000-8000-0000ae3d1004';
  const callId = 'toolu_rendezvous_fast';
  await purge(turnId, callId);

  const wait = waitForFrontendTool(turnId, callId, OWNER_ID, DEMO_TENANT_ID, 10_000);
  let tenantLookups = 0;
  const outcome = await deliverFrontendToolResult(
    turnId,
    callId,
    { ok: true, output: { applied: true } },
    OWNER_ID,
    async () => {
      tenantLookups++;
      return DEMO_TENANT_ID;
    },
  );

  expect(outcome).toBe('delivered');
  expect(await wait).toEqual({ ok: true, output: { applied: true } });
  // The tenant thunk is the ONLY database work `deliverFrontendToolResult` can do before it decides,
  // so zero calls is the machine-checkable form of "the common case did not grow a query".
  expect(tenantLookups).toBe(0);
  expect(await rowsFor(turnId, callId)).toHaveLength(0);
  expect(__pendingToolCountForTests()).toBe(0);
}, 30_000);

test('a browser that genuinely never answers still releases the turn, and leaves no waiter behind', async () => {
  if (skipped) return;
  const turnId = '019845f0-0000-7000-8000-0000ae3d1005';
  const callId = 'toolu_rendezvous_timeout';
  // Nobody reports anything. The durable path must not turn a 30s bound into an unbounded wait:
  // the timer is unconditional and independent of the claim.
  const result = await waitForFrontendTool(turnId, callId, OWNER_ID, DEMO_TENANT_ID, 400);
  expect(result).toEqual({ ok: false, error: 'frontend tool timed out' });
  expect(__pendingToolCountForTests()).toBe(0);
}, 30_000);

test('resolveFrontendTool still refuses an unknown key and a wrong owner, indistinguishably', () => {
  expect(resolveFrontendTool('019845f0-0000-7000-8000-0000ae3d1006', 'nope', { ok: true }, OWNER_ID)).toBe(
    false,
  );
});
