// src/ai/tool-rendezvous.ts — the frontend-tool round trip, made survivable across replicas.
//
// ⛔ THE DEFECT THIS FILE EXISTS FOR. `ai/agent.ts` dispatches a FRONTEND tool (the nine
// `surface:'frontend'` tools in ai/mcp/tools.ts) by parking a promise in a module-level `Map` keyed
// `${turnId}:${callId}`, emitting a `frontend-tool-call` SSE frame, and awaiting the browser. The
// browser applies the edit on the canvas and reports it with a BRAND-NEW `fetch()` to
// `POST /api/agent/chat/:turnId/tool-result` — a different connection from the SSE stream, and
// therefore a fresh trip through the ClusterIP Service. Production runs 2 replicas (HPA min 2,
// max 4) with NO sessionAffinity and no Istio DestinationRule, so that POST lands on either pod
// with roughly even odds. Half the time it reached a pod whose Map had never heard of the key: the
// route answered 400, the browser store swallowed it, and the turn that was holding the promise
// blocked the full 30s before feeding the model `{"error":"frontend tool timed out"}`. `turnId` is a
// bare `Bun.randomUUIDv7()` and carries no pod identity, so nothing could route the POST home.
//
// It is not theoretical: prod `chat_messages` holds two `{"error":"frontend tool timed out"}` rows
// (2026-06-28 11:17:50.801 and 19:39:03.479), each EXACTLY 30.0s after its `propose_block_draft`
// parent — a tool whose driver returns synchronously with no user interaction, so the POST left the
// browser immediately and simply never arrived. `minReplicas: 2` had landed two days earlier.
//
// ---------------------------------------------------------------------------------------------
// THE SHAPE: A LOCAL HANDLE FOR THE FAST PATH, A DURABLE ROW FOR THE OTHER POD
// ---------------------------------------------------------------------------------------------
// This is `host/run-controller.ts`'s answer to the same problem, and it is deliberately the same
// answer rather than a second mechanism: that file keeps an in-process `runRegistry` handle AND
// signals across replicas through Postgres (`flow_runs.cancel_requested_at`, the `flow_run_events`
// tail). Here:
//
//   1. FAST PATH (same pod, the overwhelmingly common case, and the one that must not regress):
//      `resolveFrontendTool` resolves the promise straight out of the Map. ZERO database work — no
//      query, no connection, not even a tenant lookup. Byte-for-byte what shipped before.
//   2. SLOW PATH (wrong pod): the receiving pod writes `agent_tool_results` and NOTIFYs
//      `cp_agent_tool_result` with the KEY ONLY. The owning pod's LISTEN hook sees a key it is
//      holding and claims the row with `DELETE … RETURNING`.
//   3. FLOOR (the NOTIFY was dropped): a pod whose LISTEN session is in backoff — which
//      `startConnectorListener()` deliberately tolerates, because a LISTEN failure must never block
//      boot — would otherwise miss the doorbell forever. So a shared ticker polls for any pending
//      key, and it is what makes the fix work with the NOTIFY deleted entirely; the NOTIFY only
//      makes it instant. The ticker does not start looking until POLL_DELAY_MS, so the same-pod
//      case (which resolves in tens of milliseconds) never issues a single query.
//
// EXACTLY ONCE, held by two independent mechanisms:
//   • `DELETE … RETURNING` is atomic — four replicas can poll the same key and exactly one gets a
//     row back.
//   • `deliverLocal` removes the Map entry BEFORE it resolves, and JS is single-threaded, so the
//     second delivery (a browser retry, or a NOTIFY racing the ticker) finds nothing.
//   • `PRIMARY KEY (turn_id, call_id, user_id)` + `ON CONFLICT DO NOTHING` means a retried POST cannot
//     even queue a second copy. user_id is IN the key: without it, a token holder who learned someone
//     else's (turnId, callId) could report FIRST, take the slot, and the victim's genuine report would
//     be silently discarded by the conflict clause — a guaranteed, undetectable 30s denial. See 0070.
//
// ⛔ THE OWNERSHIP PROPERTY SURVIVES, AND THAT TOOK A COLUMN. `resolveFrontendTool` returns `false`
// for BOTH "no such call" and "wrong owner", deliberately indistinguishable so that a token holder
// who learned someone else's (turnId, callId) cannot probe for its existence. Moving the rendezvous
// into a shared table would have reopened that hole, because "wrong owner" now falls through to the
// durable path. It does not: the row carries `user_id`, the CLAIM predicate matches on it, and a row
// written under the wrong user is therefore never claimed by the waiter — it is simply never
// delivered and expires. From the caller's side both cases look identical (a 200 and silence), which
// is the same indistinguishability, preserved.
//
// ⛔ RLS: THE CLAIM RUNS ON A DETACHED TIMER WITH NO ASYNCLOCALSTORAGE STORE. That is the exact
// stack where the connector `synced` fan-out silently died under `cp_app`
// (tests/connector-listen-isolation.test.ts, WS-E): a bare `db.select()` there runs on the pool with
// no `app.current_tenant`, the policy matches nothing, and the handler takes its silent `return`.
// So every statement here runs inside `withTenantTx(pending.tenantId, …)` using the tenant captured
// when the waiter was REGISTERED (i.e. from the turn's own scope), never from the ambient stack —
// and `withTenantTx` reserves no request connection, exactly as run-controller's heartbeat does.
import { and, eq, gt, lt, or } from 'drizzle-orm';
import {
  db as defaultDb,
  agentToolResults,
  queryClient,
  withTenantTx,
} from '../db/client';
import { currentDbContext } from '../db/tenant-context';
import { log } from '../host/logger';

/** The NOTIFY channel. Registered in datasets/connector-listener.ts's ONE registration statement. */
export const CHANNEL_AGENT_TOOL_RESULT = 'cp_agent_tool_result';

/** How long a turn waits for the browser before giving up on a frontend tool. */
export const FRONTEND_TOOL_TIMEOUT_MS = 30_000;

/**
 * How long a queued result stays claimable. Comfortably past FRONTEND_TOOL_TIMEOUT_MS so a slow
 * claim still wins, and short enough that a result can never be delivered into a LATER turn.
 */
const ROW_TTL_MS = 120_000;

/**
 * The ticker does not look at the database for this long after a waiter is registered.
 *
 * ⛔ THIS IS THE "DO NOT REGRESS THE FAST PATH" GUARD, NOT A TUNING NICETY. A frontend tool that
 * lands on its own pod resolves in tens of milliseconds (`propose_block_draft`'s driver is
 * synchronous). With no delay, every single copilot edit in the product would pay for a database
 * round trip it never needed. With it, the ticker's first fire finds the Map already empty, stops
 * itself, and issues no query at all.
 */
const POLL_DELAY_MS = 750;

/** The floor on a DROPPED NOTIFY: worst case, a cross-pod result is delivered this late. */
const POLL_INTERVAL_MS = 1_000;

export interface ToolResultPayload {
  ok: boolean;
  output?: unknown;
  error?: string;
}

interface PendingTool {
  turnId: string;
  callId: string;
  resolve: (r: ToolResultPayload) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Who owns this turn. Any valid agent token could otherwise resolve ANY pending call, injecting
   *  arbitrary tool output into another user's in-flight turn. The sibling run registry
   *  (host/sse-stream.ts) already binds ownership the same way. */
  userId: string;
  /** The turn's tenant, captured at REGISTRATION so the claim never depends on the ambient stack
   *  (which has none). `null` for in-process callers that established no tenant — those are
   *  local-delivery only, exactly as before this file existed. */
  tenantId: string | null;
  registeredAt: number;
}

const pendingTools = new Map<string, PendingTool>();
const keyOf = (turnId: string, callId: string) => `${turnId}:${callId}`;

let ticker: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------------------------
// Registration + local (same-pod) delivery — no database on this path, by design.
// ---------------------------------------------------------------------------------------------

/**
 * Park a promise for one frontend tool call and return it. The caller MUST register before emitting
 * the SSE frame, so a fast browser cannot beat the listener into existence.
 *
 * `timeoutMs` is a parameter rather than a module constant read so that a test can prove the
 * genuine-no-answer release without sitting through 30 seconds; production never passes it.
 */
export function waitForFrontendTool(
  turnId: string,
  callId: string,
  userId: string,
  tenantId: string | null = null,
  timeoutMs: number = FRONTEND_TOOL_TIMEOUT_MS,
): Promise<ToolResultPayload> {
  const key = keyOf(turnId, callId);
  return new Promise<ToolResultPayload>((resolve) => {
    const timer = setTimeout(() => {
      // The browser genuinely never answered (it closed the tab, the driver threw, the network
      // ate every retry). Release the turn with the error the model has always seen, drop the
      // waiter, and let the ticker notice the Map is empty and stop itself.
      pendingTools.delete(key);
      stopTickerIfIdle();
      resolve({ ok: false, error: 'frontend tool timed out' });
    }, timeoutMs);
    timer.unref?.();
    pendingTools.set(key, {
      turnId,
      callId,
      resolve,
      timer,
      userId,
      tenantId,
      registeredAt: Date.now(),
    });
    startTicker();
  });
}

/** Hand a payload to a waiter THIS pod is holding. Returns false if there is none, or if the
 *  answering user does not own it — the two cases are deliberately indistinguishable. */
function deliverLocal(key: string, userId: string, payload: ToolResultPayload): boolean {
  const pending = pendingTools.get(key);
  if (!pending || pending.userId !== userId) return false;
  clearTimeout(pending.timer);
  // Delete BEFORE resolving: this is the single-threaded half of the exactly-once guarantee.
  pendingTools.delete(key);
  pending.resolve(payload);
  stopTickerIfIdle();
  return true;
}

/**
 * Called by POST /api/agent/chat/:turnId/tool-result when the browser finishes an edit AND this pod
 * happens to be the one holding the turn. Returns false if no call is awaiting that key on THIS pod
 * (already resolved / unknown / wrong owner).
 *
 * Kept exported and unchanged in shape because it is the in-process seam the agent-loop tests drive,
 * and because it is the fast path: `deliverFrontendToolResult` tries it first and only its miss
 * reaches Postgres.
 */
export function resolveFrontendTool(
  turnId: string,
  callId: string,
  payload: ToolResultPayload,
  userId: string,
): boolean {
  return deliverLocal(keyOf(turnId, callId), userId, payload);
}

// ---------------------------------------------------------------------------------------------
// Cross-replica delivery.
// ---------------------------------------------------------------------------------------------

export type DeliveryOutcome =
  /** Handed straight to the waiting turn on this pod. */
  | 'delivered'
  /** This pod is not holding the turn — the result is durable and the owner will claim it. */
  | 'queued';

/**
 * The route's entry point. Try the local Map first (zero database work); on a miss, persist the
 * result where whichever pod IS holding the turn can find it, and ring the doorbell.
 *
 * ⚠️ A MISS IS NOT AN ERROR AND MUST NOT BE REPORTED AS ONE. Before this, the miss threw
 * `badRequest('no_pending_tool')` — a 400 for the entirely normal event of a load balancer doing its
 * job. There is no way, and there must be no way, for this pod to tell "another replica is holding
 * it" apart from "nobody is holding it" or "you do not own it": distinguishing them would either
 * require cross-pod chatter or hand an attacker an oracle. So all three queue and answer 200. The
 * cost of the genuinely-bogus case is one small row that expires in two minutes.
 */
export async function deliverFrontendToolResult(
  turnId: string,
  callId: string,
  payload: ToolResultPayload,
  userId: string,
  /**
   * The answering user's tenant, resolved LAZILY. It is a thunk and not a value because resolving it
   * is a `users` SELECT, and the same-pod path must cost no database work whatsoever — putting the
   * lookup in the signature would have quietly reintroduced a query on the hot path for every
   * copilot edit in the product.
   */
  resolveTenantId: () => Promise<string | null>,
): Promise<DeliveryOutcome> {
  if (resolveFrontendTool(turnId, callId, payload, userId)) return 'delivered';
  const tenantId = await resolveTenantId();
  if (tenantId) await persistToolResult(turnId, callId, payload, userId, tenantId);
  return 'queued';
}

/**
 * Write the result where the owning replica can claim it, then NOTIFY the key.
 *
 * The reap rides along in the same transaction on purpose. This write is the ONLY thing that makes
 * the table grow, it is already paying for a round trip, and folding retention in here means there
 * is no new scheduler to arm, no new tick family to monitor, and nothing that can be forgotten on a
 * fresh cluster. `ON CONFLICT DO NOTHING` makes a browser retry idempotent.
 *
 * ⚠️ NO SIZE CAP ON `payload`, DELIBERATELY. The same tool output is already persisted verbatim to
 * `chat_messages` by the turn itself (agent.ts `persistMessage(… toolMsg)`), so this row adds no
 * exposure that the transcript does not already have. Capping here and not there would only produce
 * two different truths about one edit.
 */
async function persistToolResult(
  turnId: string,
  callId: string,
  payload: ToolResultPayload,
  userId: string,
  tenantId: string,
): Promise<void> {
  const now = Date.now();
  await withTenantTx(tenantId, () =>
    defaultDb.transaction(async (tx) => {
      await tx
        .insert(agentToolResults)
        .values({
          turn_id: turnId,
          call_id: callId,
          user_id: userId,
          tenant_id: tenantId,
          payload,
          expires_at: new Date(now + ROW_TTL_MS),
        })
        .onConflictDoNothing({
          // Matches the PK, which includes user_id on purpose: a stranger who learned this
          // (turnId, callId) writes a DIFFERENT row rather than taking this one's slot and
          // silently discarding the owner's genuine report. See 0070's header.
          target: [agentToolResults.turn_id, agentToolResults.call_id, agentToolResults.user_id],
        });
      await tx.delete(agentToolResults).where(lt(agentToolResults.expires_at, new Date(now)));
    }),
  );
  await notifyToolResult(keyOf(turnId, callId));
}

/**
 * Ring the doorbell. THE KEY ONLY — `pg_notify`'s payload is capped at 8000 bytes (measured against
 * the prod server: 7999 OK, 8000 ERROR) and a `propose_block_draft` result is a whole block draft.
 * The row is the carrier; this is only latency.
 *
 * Best-effort by construction: the poll floor is what makes the delivery correct, so a failed NOTIFY
 * costs at most POLL_INTERVAL_MS and must never fail the caller's POST. It reuses the request's
 * reserved connection when there is one (the same reasoning as datasets/connector-refresh.ts's
 * `pgNotify`: asking the request pool for a second connection from inside a request is how that
 * file's predecessor wedged a pod at two concurrent syncs).
 */
async function notifyToolResult(key: string): Promise<void> {
  try {
    const reserved = currentDbContext()?.reserved;
    if (reserved) {
      await reserved`SELECT pg_notify(${CHANNEL_AGENT_TOOL_RESULT}, ${key})`;
      return;
    }
    await queryClient.notify(CHANNEL_AGENT_TOOL_RESULT, key);
  } catch (err) {
    log.error('tool_result_notify_failed', { component: 'agent', err });
  }
}

/**
 * The LISTEN hook, wired into the pinned listener session by datasets/connector-listener.ts.
 *
 * ⚠️ RETURNS IMMEDIATELY WHEN THE KEY IS NOT OURS, AND THAT CHEAPNESS IS THE POINT: every replica
 * receives every NOTIFY, so with N pods this fires N times per cross-pod result. Only the pod
 * holding the waiter touches the database. (It is also why nothing here reads `db` off the NOTIFY
 * stack — see the RLS note in the file header.)
 */
export function onToolResultNotify(key: string): void {
  const pending = pendingTools.get(key);
  if (!pending || !pending.tenantId) return;
  void claim([pending]);
}

// ---------------------------------------------------------------------------------------------
// The claim: DELETE … RETURNING, which is where "exactly once" is actually enforced.
// ---------------------------------------------------------------------------------------------

/**
 * Claim any durable results for these waiters and deliver them. All waiters passed in must share a
 * tenant (the ticker groups them).
 *
 * The predicate is `(turn_id, call_id, user_id)` AND unexpired:
 *   • `user_id` preserves the ownership binding across replicas (file header).
 *   • the expiry term means a row left behind by an abandoned turn can never be delivered into a
 *     later one that reused an id.
 * Rows are matched by the OWNING pod's idea of who owns the turn, so a row written under a
 * different user is invisible here and just expires.
 */
async function claim(waiters: PendingTool[]): Promise<void> {
  const tenantId = waiters[0]?.tenantId;
  if (!tenantId || waiters.length === 0) return;
  const keyMatch = or(
    ...waiters.map((w) =>
      and(
        eq(agentToolResults.turn_id, w.turnId),
        eq(agentToolResults.call_id, w.callId),
        eq(agentToolResults.user_id, w.userId),
      ),
    ),
  );
  if (!keyMatch) return;
  try {
    // ⛔ `db.transaction`, NOT a bare statement — and the difference is the whole fix working or not.
    // `withTenantTx` installs `{tenantId, boundDb: poolDb}` but the `db` Proxy only injects
    // `set_config('app.current_tenant', …)` on the `transaction` property; every other property hands
    // back the bare pool. `client.ts:444` says so in as many words: "Plain (non-transaction)
    // statements under this context run on the pool with NO GUC". So a plain DELETE here runs with
    // `app.current_tenant` UNSET, `app_current_tenant_uuid()` returns NULL, the 0070 policy predicate
    // is NULL, and the claim deletes ZERO ROWS AND RAISES NOTHING.
    //
    // That is invisible to this repo's tests, which connect on the OWNER DSN and bypass RLS by
    // ownership. Measured with `DATABASE_URL` pointed at a production-shaped `cp_app`
    // (NOBYPASSRLS): this file's own suite went 6/0 → 4 pass / 2 fail, and the two failures were
    // exactly the cross-replica cases this workstream exists to fix — i.e. the fix was a no-op in
    // production while every test was green. Every precedent gets this right
    // (`run-controller.ts:324,:542`, `sse-stream.ts:70`, and `persistToolResult` above); only this
    // site omitted the transaction.
    const rows = await withTenantTx(tenantId, () =>
      defaultDb.transaction(async (tx) =>
        tx
          .delete(agentToolResults)
          .where(and(gt(agentToolResults.expires_at, new Date()), keyMatch))
          .returning({
            turn_id: agentToolResults.turn_id,
            call_id: agentToolResults.call_id,
            user_id: agentToolResults.user_id,
            payload: agentToolResults.payload,
          }),
      ),
    );
    for (const row of rows) {
      // A row that comes back is ours and nobody else's — the DELETE already took it.
      deliverLocal(keyOf(row.turn_id, row.call_id), row.user_id, row.payload);
    }
  } catch (err) {
    // NEVER let a transient database error kill the ticker or the NOTIFY hook: the waiter's own
    // 30s timeout is the backstop, and the next tick retries. Silence here would reproduce exactly
    // the class of failure this workstream exists to remove, so it logs.
    log.error('tool_result_claim_failed', { component: 'agent', err });
  }
}

// ---------------------------------------------------------------------------------------------
// The poll floor.
// ---------------------------------------------------------------------------------------------

function startTicker(): void {
  if (ticker) return;
  ticker = setInterval(tick, POLL_INTERVAL_MS);
  // A poll timer must never be the reason the process stays alive.
  ticker.unref?.();
}

function stopTickerIfIdle(): void {
  if (ticker && pendingTools.size === 0) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

function tick(): void {
  if (pendingTools.size === 0) {
    stopTickerIfIdle();
    return;
  }
  const now = Date.now();
  // Only waiters that have had their chance at the fast path, and only those that CAN be claimed
  // (an in-process caller with no tenant has no durable half). An empty list issues no query —
  // which is what every same-pod turn does.
  const eligible = [...pendingTools.values()].filter(
    (p) => p.tenantId !== null && now - p.registeredAt >= POLL_DELAY_MS,
  );
  if (eligible.length === 0) return;
  const byTenant = new Map<string, PendingTool[]>();
  for (const p of eligible) {
    const list = byTenant.get(p.tenantId!);
    if (list) list.push(p);
    else byTenant.set(p.tenantId!, [p]);
  }
  for (const group of byTenant.values()) void claim(group);
}

/** Test seam: drop every waiter and stop the ticker. Never called by application code. */
export function __resetToolRendezvousForTests(): void {
  for (const p of pendingTools.values()) clearTimeout(p.timer);
  pendingTools.clear();
  stopTickerIfIdle();
}

/** Test seam: how many waiters this process is holding. */
export function __pendingToolCountForTests(): number {
  return pendingTools.size;
}
