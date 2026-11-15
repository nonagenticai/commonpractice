-- 0070_agent_tool_rendezvous.sql — THE COPILOT LOSES HALF ITS EDITS, BECAUSE THE RENDEZVOUS IS A
-- MAP IN ONE POD'S HEAP.
--
-- THE DEFECT, AND IT IS LIVE. `ai/agent.ts` dispatches a FRONTEND tool (the nine `surface:'frontend'`
-- tools in ai/mcp/tools.ts — propose_block_draft, add_node, connect_nodes, …) by registering an
-- in-memory waiter in a module-level `Map` keyed `${turnId}:${callId}`, emitting a
-- `frontend-tool-call` SSE frame, and awaiting the browser. The browser applies the edit and reports
-- it with a BRAND-NEW `fetch()` to `POST /api/agent/chat/:turnId/tool-result` — a different TCP
-- connection from the SSE stream, therefore a fresh trip through the ClusterIP Service.
--
-- Production runs 2 replicas (HPA min 2, max 4) behind a ClusterIP Service with NO sessionAffinity
-- and no Istio DestinationRule, so that POST lands on either pod with roughly even odds. When it
-- lands on the pod that is NOT holding the waiter, `resolveFrontendTool` misses, the route answers
-- 400 `no_pending_tool`, the browser store swallows it, and the turn that is holding the promise
-- blocks the full `FRONTEND_TOOL_TIMEOUT_MS` (30s) before feeding the model
-- `{"error":"frontend tool timed out"}`. `turnId` is a bare `Bun.randomUUIDv7()`; it carries no pod
-- identity, so nothing can route the POST back to the owner.
--
-- MEASURED, NOT THEORISED. Prod `chat_messages` holds exactly two
-- `{"error":"frontend tool timed out"}` rows — 2026-06-28 11:17:50.801 and 2026-06-28 19:39:03.479 —
-- each EXACTLY 30.0s after its `propose_block_draft` tool_use parent. That tool's driver
-- (frontend/src/lib/agent/block-author-driver.ts) returns SYNCHRONOUSLY with no user interaction, so
-- the POST left the browser within milliseconds and simply never reached the pod holding the waiter.
-- An `add_node` round trip DID succeed on 2026-06-07, while the Deployment was still single-replica;
-- `minReplicas: 2` landed 2026-06-26; both failures are two days later.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A TABLE, AND WHY NOT THE TWO ALTERNATIVES
-- ---------------------------------------------------------------------------------------------
--   • "Put the pod identity in the turnId and route the POST." This needs pod-addressable networking
--     that this deployment does not have and should not grow for one round trip: a headless Service
--     or StatefulSet, plus a hop from the receiving pod to the owner, plus a story for the case
--     where the owner has since been rescheduled (HPA scales this Deployment 2→4 and back). It also
--     leaks a scheduling detail into a value the browser echoes back. Rejected.
--   • "NOTIFY the result and be done." `pg_notify` is fire-and-forget — no ack, no replay — so a pod
--     whose LISTEN session is in backoff (datasets/connector-listener.ts supervises exactly that,
--     and `startConnectorListener()` is deliberately `void`-ed so a LISTEN failure never blocks boot)
--     would drop the result silently and the turn would time out anyway. Its payload is also capped
--     at 8000 bytes, and a `propose_block_draft` result is a whole block draft. Rejected AS THE
--     CARRIER; it is kept as the LATENCY mechanism, with only the KEY on the wire.
--
-- So: the durable row is the rendezvous and the NOTIFY is the doorbell — exactly the shape
-- `host/run-controller.ts` already uses for cross-replica run signalling (a local `runRegistry`
-- handle for the fast path, `flow_runs.cancel_requested_at` + a `flow_run_events` tail for the
-- replica that is not holding it). The SAME-POD path is unchanged and still touches no database at
-- all: `resolveFrontendTool` is tried first, in memory, and only its MISS reaches this table.
--
-- ---------------------------------------------------------------------------------------------
-- THE PRIMARY KEY IS THE EXACTLY-ONCE GUARANTEE
-- ---------------------------------------------------------------------------------------------
-- A tool result must reach the model once. Two mechanisms hold that jointly and neither is advisory:
--   1. The owning pod claims with `DELETE … RETURNING`, which is atomic — if four replicas poll the
--      same key concurrently, exactly one gets a row back and the other three get zero.
--   2. `PRIMARY KEY (turn_id, call_id, user_id)` + `ON CONFLICT DO NOTHING` on the write, so a browser
--      that retries (frontend/src/lib/api/agent.ts now retries a failed report rather than swallowing
--      it) cannot queue the same result twice.
--
-- A PK OF (turn_id, call_id) IS A FREE DENIAL, WHICH IS WHY user_id IS IN IT.
-- The threat model below is a token holder who learned someone else's (turnId, callId). With user_id
-- OUT of the key, that attacker simply reports FIRST: their row takes the slot, and the victim's
-- genuine report hits `ON CONFLICT DO NOTHING` and is SILENTLY DISCARDED - so the victim's waiter
-- runs the full timeout and the model is told the tool timed out. Measured end-to-end against a
-- production-shaped `cp_app` role: cross-tenant AND same-tenant-different-user both reproduced, and
-- RLS cannot see it (the attacker's row is invisible to the victim), so nothing anywhere detects it.
-- Before this table existed that attacker got a 400 and changed nothing; the naive key would have
-- turned that into a guaranteed, undetectable 30-second denial of any tool call whose ids leak.
-- With user_id in the key the attacker's row is a DIFFERENT row: it is never claimed (the claim
-- predicate binds user_id) and it expires. Note a guarded `DO UPDATE ... WHERE user_id = excluded.
-- user_id` does NOT fix this - the attacker's stored user_id differs, so the guard declines and the
-- victim still loses.
-- Local delivery is guarded the same way one layer up: `deliverLocal` deletes from the Map before it
-- resolves, and JS is single-threaded, so the second delivery finds nothing.
--
-- WHY user_id IS A COLUMN AND IS IN THE CLAIM PREDICATE. `resolveFrontendTool` binds the answering
-- token to the turn's owner, and returns `false` for BOTH "no such call" and "wrong owner" —
-- deliberately indistinguishable, so a token holder who learned someone else's (turnId, callId)
-- cannot probe for it. That property has to survive the move to a shared table or the fix reopens
-- the hole it inherits: the claim matches on `(turn_id, call_id, user_id)`, so a row written under
-- the wrong user is never claimed by the waiter — it is simply never delivered, and expires. RLS
-- cannot do this job: `app.current_tenant` is the only identity Postgres has (0028 §1), and both
-- users are in the same tenant. The tenant policy is the tenant boundary; it was never the per-user
-- one.
--
-- WHY tenant_id IS HERE AT ALL. The claim runs on a detached timer with NO AsyncLocalStorage store,
-- which is the exact stack where 0028's RLS silently ate the connector `synced` fan-out
-- (tests/connector-listen-isolation.test.ts, WS-E). Carrying the tenant lets the claim run under an
-- explicit `withTenantTx(tenantId, …)` — the same pattern run-controller's heartbeat uses — instead
-- of a bare pooled statement that matches nothing under `cp_app`. It also puts this table inside
-- tests/rls-coverage.test.ts's enumeration, which only sees tables that CARRY a tenant_id column.
--
-- ---------------------------------------------------------------------------------------------
-- RETENTION: expires_at, NOT A SCHEDULER
-- ---------------------------------------------------------------------------------------------
-- A row here is a 30-second handoff. `expires_at` is set by the writer to well past
-- FRONTEND_TOOL_TIMEOUT_MS (2 minutes), for two reasons: the claim ignores expired rows, so a result
-- can never be delivered into a LATER turn that happened to reuse an id; and it gives the reaper an
-- unambiguous predicate. The reaping happens on the WRITE path (ai/tool-rendezvous.ts persists and
-- reaps in one transaction) rather than in a new scheduler, because the write path is the only thing
-- that makes this table grow and it is already paying for a round trip. No new timer, no new tick
-- family, nothing to forget to arm.
--
-- ---------------------------------------------------------------------------------------------
-- ROLLING DEPLOY: EVERY OLD/NEW COMBINATION DEGRADES TO TODAY, NONE IS NEW BREAKAGE
-- ---------------------------------------------------------------------------------------------
-- Migrations apply at pod startup with 2-4 replicas live, so all four combinations happen.
-- (writer = the pod that receives the POST; reader = the pod holding the waiter)
--   same pod, any versions   → in-memory fast path, byte-for-byte today's behaviour.
--   NEW writer / NEW reader  → FIXED: row + NOTIFY, claimed in milliseconds (or ≤1s on the poll
--                              floor if the NOTIFY was dropped).
--   NEW writer / OLD reader  → the row is written and never claimed; the old waiter times out at 30s,
--                              which is exactly today's failure. The row expires. The browser now
--                              gets 200 instead of 400, which changes nothing client-side — the old
--                              store swallowed the 400 anyway.
--   OLD writer / NEW reader  → the old pod 400s and writes nothing; the new waiter times out at 30s,
--                              again today's failure. The NEW frontend retries the POST, and because
--                              there is no sessionAffinity each retry is an independent draw across
--                              the replicas, so this case is strictly BETTER than today.
-- This file is EXPAND-ONLY (a new table, nothing altered), so no old replica can 42P01 on it.

SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM. `SET LOCAL` is TRANSACTION-scoped and the runner (db/migration-runner.ts)
-- applies every pending file inside ONE outer transaction with a savepoint per file — `RELEASE
-- SAVEPOINT` does not undo it. Without the reset this 5s ceiling silently governs 0071 and onwards
-- on a fresh-cluster first boot. 0066/0067/0068 establish the pairing; 0059/0060 are the trap it is
-- not repeating. `MIGRATION_RESET_GUCS` is the belt to this file's braces.
--
-- The ceiling is not ceremony: `CREATE TABLE … REFERENCES users/tenants` takes a SHARE ROW EXCLUSIVE
-- lock on each parent while every other pod's boot migration waits on the runner's advisory lock.
-- A retried migration beats a wedged fleet.

CREATE TABLE IF NOT EXISTS agent_tool_results (
  -- The turn that is waiting. `ai/agent.ts` mints it with Bun.randomUUIDv7(); it is NOT a foreign
  -- key to anything — a turn is an in-flight thing with no row of its own (chat_messages records
  -- the transcript, not the turn), and that is fine: this table is a 30-second mailbox, not a record.
  turn_id    uuid        NOT NULL,
  -- The provider's tool_use id. TEXT, not uuid: it is whatever the model's API emits
  -- (`toolu_01…` from Anthropic-shape providers, `call_…` from OpenAI-compatible ones).
  call_id    text        NOT NULL,
  -- The owner of the turn. In the claim predicate, NOT merely stored — see the header.
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  uuid        NOT NULL DEFAULT app_current_tenant_uuid()
                           REFERENCES tenants(id) ON DELETE CASCADE,
  -- The {ok, output?, error?} the browser reported, verbatim. jsonb because a propose_block_draft
  -- result is a whole block draft and this is the reason the payload could not ride the NOTIFY.
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set explicitly by the writer (now() + a couple of minutes). The claim ignores anything past it,
  -- so a stale row can never be delivered into a later turn.
  expires_at timestamptz NOT NULL,
  -- THE PK IS THE IDEMPOTENCE (see the header): one result per (turn, call, USER), forever.
  -- user_id is IN the key deliberately - see "A PK OF (turn_id, call_id) IS A FREE DENIAL" above.
  PRIMARY KEY (turn_id, call_id, user_id)
);

-- The reaper's index. The claim itself is a PK probe and needs nothing; the `DELETE … WHERE
-- expires_at < now()` that runs alongside every durable write is the only scan, and on a table this
-- small it is cheap either way — but the index keeps it from degrading if a pod ever queues a burst.
CREATE INDEX IF NOT EXISTS agent_tool_results_expires_idx ON agent_tool_results (expires_at);

COMMENT ON TABLE agent_tool_results IS
  'Cross-replica rendezvous for frontend (canvas/block edit) tool results. The browser reports a '
  'finished edit on a NEW connection, which the ClusterIP Service may route to a pod that is not '
  'holding the turn; that pod writes the result here and NOTIFYs cp_agent_tool_result with the KEY '
  'only, and the owning pod claims it with DELETE … RETURNING (atomic = exactly once). The same-pod '
  'case never touches this table. Rows live ~2 minutes and are reaped by the next durable write; '
  'nothing reads this table for history.';

-- ---- RLS: the strict 0028 §4a shape ----------------------------------------------------------
-- Same predicate in USING and WITH CHECK so the INSERT is bound too — a result cannot be queued
-- into another tenant, and cannot be claimed out of one. Note again that this is the TENANT
-- boundary only; the per-USER binding is the `user_id` term in the application's claim predicate
-- (ai/tool-rendezvous.ts), because RLS has no notion of the current user.
ALTER TABLE agent_tool_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_tool_results_tenant ON agent_tool_results;
CREATE POLICY agent_tool_results_tenant ON agent_tool_results
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

-- ---- GRANTs to cp_app (role-existence-guarded, like 0068 / 0044 / 0028 §5) --------------------
-- Production connects as the non-owner, NOBYPASSRLS `cp_app`. 0028 set DEFAULT PRIVILEGES, which
-- cover a table created by the same owner — but every table migration since has ALSO issued the
-- explicit table-level grant, because a cluster whose owner role differs from the one that ran 0028
-- gets nothing from those defaults and the failure mode is a 500 on a green test suite.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_tool_results TO cp_app;
    RAISE NOTICE '[0070] granted cp_app DML on agent_tool_results';
  ELSE
    RAISE NOTICE '[0070] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
