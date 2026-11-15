// src/routes/agent.ts — the agent endpoints (SPEC §5A):
//   POST /api/agent/session/issue    — Keycloak login → {accessToken, refreshToken}
//   POST /api/agent/session/refresh  — rotate the refresh token
//   POST /api/agent/chat             — SSE: run the agent loop for one user message
//   POST /api/agent/chat/:turnId/tool-result — the browser reports a frontend edit
// Session endpoints authenticate with the Keycloak user (resolveTenant → validateAuth); chat +
// tool-result authenticate with the short-lived agent token (verifyAgentToken), which since the
// `tid` claim CARRIES the workspace it was minted in — see the `issue` route below.
import { z } from 'zod';
import { resolveTenant } from '../middleware/tenant';
import { assertTenantNotSuspended } from '../middleware/tenant-status-gate';
import {
  issueAgentSession,
  refreshAgentSession,
  verifyAgentToken,
} from '../services/agent-session';
import {
  runAgentChatScoped,
  ensureChatSession,
  getOwnedChatSession,
  deliverFrontendToolResult,
  type AgentEvent,
} from '../ai/agent';
import { jsonResponse, readJson, route, notFound, HttpError } from '../utils/http';
import { log } from '../host/logger';
import { and, eq } from 'drizzle-orm';
import { db, flows, withTenantDb } from '../db/client';
import { SUPPORTED_LOCALES, negotiateLocale } from '../utils/locale';
import type { Router } from '../utils/router';
import { canSeeRunCostRoles } from '../host/run-cost-visibility';

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

const refreshSchema = z.object({ refreshToken: z.string().min(1) }).strict();
const chatSchema = z
  .object({
    message: z.string().min(1).max(4000),
    flowId: z.string().uuid().optional(),
    // Phase 3.4: the challenge being worked, used to auto-resolve the ontology
    // (industry × department) cell. Optional — populated once "open challenge in
    // build" (3.1) wires the ?challenge param; explicit tool args work without it.
    challengeId: z.string().uuid().optional(),
    // Block-authoring copilot: 'block' selects the block-authoring persona (default 'flow').
    mode: z.enum(['flow', 'block', 'fix']).optional(),
    // Block mode has no flow to key the chat session on, so the browser threads back the
    // sessionId (from turn-start) for multi-turn continuity within an authoring sitting.
    sessionId: z.string().uuid().optional(),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
  })
  .strict();
const toolResultSchema = z
  .object({
    callId: z.string().min(1),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict();


// POST /api/agent/session/issue — exchange a Keycloak login for an agent session.
//
// ⛔ `resolveTenant` RATHER THAN `validateAuth` + `ensureUser`, AND RATHER THAN READING THE CLAIM
// DIRECTLY. This is the ONE request in the copilot's whole life that holds a Keycloak token, so it
// is the only place the workspace can be established truthfully; every later request presents the
// minted token and nothing more. `resolveTenant` does the same three things this route used to do
// by hand (validateAuth, ensureUser) plus the two that made the difference:
//   • the super_admin `X-Active-Tenant-Id` scope-switch, with the same precedence the browser's
//     content routes use — so "acting as tenant B" mints a copilot for B, not for the admin's home
//     tenant, which is what a home-tenant-only read (`effectiveHomeTenant`) would have given;
//   • `refreshTenantGuc`, which binds that SAME tenant as this request's RLS scope.
// The second is not a nicety. `agent_sessions` is RLS-protected with a `WITH CHECK` on
// `app_current_tenant_uuid()` (0028_rls.sql §4a), so an explicit `tenant_id` that disagreed with
// the GUC would be REFUSED by Postgres on the insert. Going through resolveTenant makes
// token ≡ GUC ≡ row true by construction instead of by three separate derivations agreeing.
const issue = route(async (req) => {
  const ctx = await resolveTenant(req);
  // Bake the user's realm roles into the access token so the agent's developer-gated MCP authoring
  // tools can authorize this caller (the chat token carries no Keycloak claims otherwise), and the
  // TENANT so no later request has to guess it from `users.tenant_id`.
  const session = await issueAgentSession(ctx.user.id, ctx.user.roles, ctx.tenantId);
  return jsonResponse({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
  });
});

// POST /api/agent/session/refresh — rotate the refresh token.
const refresh = route(async (req) => {
  const { refreshToken } = refreshSchema.parse(await readJson(req));
  const session = await refreshAgentSession(refreshToken);
  return jsonResponse({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
  });
});

// POST /api/agent/chat — SSE stream of the agent loop for one user message.
const chat = route(async (req) => {
  const { userId, roles, tenantId } = await verifyAgentToken(req);
  const body = chatSchema.parse(await readJson(req));
  const flowId = body.flowId ?? null;
  // Phase 3.6 / D.1: the agent browses the org's shared test data — scope its MCP dataset tools to
  // the workspace the token was minted in (the dataset reads filter on tenant_id). It ALSO binds
  // the RLS GUC for every write below: the agent token is not a Keycloak JWT, so server.ts's
  // peekEffectiveTenant→withTenantDb resolves to null and sets no tenant GUC. Without an explicit
  // context here, the `chat_sessions`/`chat_messages` inserts (whose tenant_id defaults to
  // app_current_tenant_uuid()) violate RLS under the cp_app role (500).
  //
  // ⛔ THIS USED TO BE `await homeTenantOf(userId)` AND THAT IS WHY THE COPILOT ANSWERED ABOUT THE
  // WRONG WORKSPACE. `users.tenant_id` is written ONCE on first touch and never reconciled against
  // a later Keycloak `tenant_id` claim, while the browser resolves the claim on every request
  // (`middleware/tenant.ts resolveTenant`). The two therefore diverge silently and permanently:
  // measured in prod, `george@nonagentic.ai` had `users.tenant_id = …0001` while the claim resolved
  // to `0195f48b-…-0099`, and one user's 17 `agent_sessions` rows carried THREE different tenants
  // with their `chat_sessions`/`chat_messages` split across two. The tenant now rides in the token,
  // put there by `/session/issue` — the one request that holds a claim.
  //
  // ⚠️ NO `homeTenantOf` FALLBACK WHEN `tid` IS ABSENT, deliberately. The fallback IS the drift; and
  // it would not rescue anyone anyway — three prod users have `users.tenant_id IS NULL`, which is
  // what made this route 400 `no_home_tenant` at them and break their copilot outright. A token
  // minted before `tid` existed is refused, the SPA re-issues one (it already re-issues per turn),
  // and the second attempt carries a tenant. See `verifyAgentToken`'s docstring.
  if (!tenantId) {
    throw new HttpError(
      401,
      'agent_token_no_tenant',
      'This copilot session predates workspace-scoped tokens. Reload to start a new one.',
    );
  }
  // ⛔ THE COPILOT DOES NOT REACH `validateAuth`, SO NOTHING ELSE ENFORCES SUSPENSION HERE.
  // `verifyAgentToken` above validates an HS256 agent-session token, not a Keycloak JWT — the whole
  // reason this route reads `users.tenant_id` instead of a claim. So the browser gate in
  // middleware/auth.ts never runs on this request, and without this line a suspended workspace keeps
  // the full build copilot: flow edits, dataset reads, block authoring, LLM spend against the
  // tenant's budget. The check goes HERE, immediately after the tenant is resolved and BEFORE it
  // reaches `withTenantDb` below, so no RLS scope is ever bound for a suspended tenant.
  // A 403 `tenant_suspended` surfaces through route() exactly like the `flow_not_found` 404 below.
  await assertTenantNotSuspended(tenantId);
  // Resolve the chat session: prefer a caller-supplied sessionId the user owns (block mode
  // continuity), else key on the flow (canvas), else open a fresh (flow-less) session.
  //
  // ⛔ `flowId` IS CLIENT-SUPPLIED AND WAS TAKEN ON TRUST. Nothing here checked that the caller
  // could touch that flow, while every other flow-reaching surface in this codebase does:
  // `routes/flows.ts` loadOwnedFlow, `ai/flow-edit-service.ts` loadOwnedFlow and `ai/mcp/tools.ts`
  // loadOwnedFlowGraph all filter on `flows.owner_id` and all answer 404 (not 403) when they miss.
  // Combined with `ensureChatSession` keying on the flow alone, one POST with a borrowed flow id —
  // exactly what "Open in Build" on a published solution puts in the browser's hands — joined the
  // author's private thread. The session lookup is fixed too; this is the outer door.
  //
  // 404 rather than 403 follows loadOwnedFlow's documented choice, and rather than "ignore the
  // flowId and open a flow-less session", which would silently strand the caller with a copilot
  // whose every flow tool 404s on its own ownership check one layer down.
  //
  // ⚠️ THIS MAKES THE COPILOT REFUSE A READ-ONLY VIEWER, WHICH IS THE POINT. `getFlow` deliberately
  // serves a published solution's graph read-only to non-owners, and the build page renders the
  // chat panel with no read-only branch — so a viewer who types now gets a clean refusal instead of
  // someone else's transcript. Hiding the panel in that state is a frontend change, not this one.
  if (flowId) {
    const [owned] = await withTenantDb(tenantId, () =>
      db
        .select({ id: flows.id })
        .from(flows)
        .where(and(eq(flows.id, flowId), eq(flows.owner_id, userId))),
    );
    if (!owned) throw notFound('flow_not_found', `No flow '${flowId}'`);
  }
  const sessionId = await withTenantDb(tenantId, async () => {
    if (body.sessionId) {
      const owned = await getOwnedChatSession(userId, body.sessionId);
      if (owned) return owned;
    }
    return ensureChatSession(userId, flowId);
  });

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // The turn's spend is tenant_admin+ on the wire (run-cost-visibility.ts): the browser already
      // hides it from everyone else, so it is not sent to them at all.
      const showCost = canSeeRunCostRoles(roles);
      const emit = (ev: AgentEvent) => {
        if (closed) return;
        if (ev.type === 'cost' && !showCost) return;
        controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.enqueue(enc.encode('event: end\ndata: {}\n\n'));
          controller.close();
        } catch {
          /* already closed */
        }
      };
      // The turn runs AFTER this Response is returned, so server.ts's per-request withTenantDb
      // has already unwound and the tenant context must be re-established here. It is NOT
      // re-established with withTenantDb: that RESERVES one of only 6 request connections for
      // the callback, and a turn spans up to 8 provider iterations plus 30s browser round-trips
      // — six open AI panels would pin the whole request pool and starve every other
      // authenticated request on the pod. `runAgentChatScoped` uses withTenantTx (reserves
      // nothing) and takes short-lived withTenantDb reservations only around the plain-statement
      // regions, exactly as host/run-controller.ts's detached run pump does. tenantId is
      // guaranteed non-null (guarded above).
      runAgentChatScoped({
        userId,
        roles,
        tenantId,
        sessionId,
        flowId,
        mode: body.mode ?? 'flow',
        challengeId: body.challengeId ?? null,
        userMessage: body.message,
        locale: body.locale ?? negotiateLocale(req),
        emit,
        signal: req.signal,
      })
        .catch((err) => {
          // The SSE client is the ONLY place this ever surfaced: the turn is detached from the
          // request (the Response has already been returned), so nothing here reaches route()'s
          // 5xx logging. A provider outage, an RLS 42501 on chat_messages, or a broker rejection
          // was therefore visible solely as a red bubble in one user's browser — server-side the
          // pod logs showed a clean 200 for the /api/agent/chat POST.
          log.error('agent_chat_turn_failed', { sessionId, err });
          emit({
            type: 'turn-end',
            turnId: 'unknown',
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(close);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
});

// POST /api/agent/chat/:turnId/tool-result — the browser finished a frontend edit.
//
// ⛔ THIS USED TO 400 WHENEVER IT LANDED ON THE WRONG REPLICA, WHICH IS HALF THE TIME. The waiter
// lived in one pod's heap and this POST is a NEW `fetch()` (not the SSE connection), so the
// ClusterIP Service — 2-4 replicas, no sessionAffinity, no DestinationRule — routed it wherever it
// liked. A miss threw `no_pending_tool`, the browser store swallowed the 400 without a trace, and
// the turn holding the promise burned the full 30s timeout before telling the model the tool had
// failed. Two such turns exhaust the 60s wall clock. Prod has the receipts: two
// `{"error":"frontend tool timed out"}` rows in `chat_messages`, each exactly 30.0s after a
// `propose_block_draft` whose driver answers synchronously.
//
// `deliverFrontendToolResult` tries this pod's Map first (zero database work — the same-pod fast
// path is untouched) and, on a miss, persists the result for whichever pod IS holding the turn.
// A miss is therefore no longer an error, and there is deliberately no way to tell "another replica
// has it" from "nobody has it" from "you do not own it": all three queue and answer 200. See
// ai/tool-rendezvous.ts for why distinguishing them would either need cross-pod chatter or hand a
// token holder an existence oracle for someone else's turn.
const toolResult = route(async (req, turnId) => {
  // The token identifies WHO is answering — the rendezvous checks it against the turn's owner, both
  // in the local Map and in the durable claim predicate. Discarding the userId here let any valid
  // agent-token holder who learned another user's (turnId, callId) inject arbitrary tool output
  // into that user's in-flight turn.
  const { userId, tenantId } = await verifyAgentToken(req);
  if (!tenantId) {
    throw new HttpError(
      401,
      'agent_token_no_tenant',
      'This copilot session predates workspace-scoped tokens. Reload to start a new one.',
    );
  }
  const body = toolResultSchema.parse(await readJson(req));
  const delivery = await deliverFrontendToolResult(
    turnId!,
    body.callId,
    { ok: body.ok, output: body.output, error: body.error },
    userId,
    // Lazy on purpose: this suspension read must not run on the same-pod path. See the thunk's
    // docstring. Mirrors the chat route, which scopes the whole turn to the token's tenant.
    // (The tenant itself is no longer a `users` SELECT — it rides in the token — but
    // `assertTenantNotSuspended` is still a database read, so the laziness still buys what it
    // was written to buy.)
    //
    // The suspension gate rides INSIDE the thunk, deliberately, and the consequence is written out
    // here rather than left to be discovered:
    //   • The thunk fires on the CROSS-POD path — the one that persists a tool result into the
    //     database for another replica to pick up. That write is gated: a suspended tenant cannot
    //     durably inject anything.
    //   • The thunk does NOT fire on the same-pod fast path, so a turn whose promise is already
    //     held in THIS pod's heap can still be completed. Hoisting the check out of the thunk would
    //     mean an unconditional `users` SELECT on a path whose entire design goal (see
    //     ai/tool-rendezvous.ts) is zero database work — trading a real latency regression for a
    //     window that is already closed at both ends: `POST /api/agent/chat` above refuses a
    //     suspended tenant outright, so no NEW turn can exist, and an in-flight one is bounded by
    //     the 60s turn wall clock. If that trade ever stops being acceptable, the fix is to gate in
    //     `deliverFrontendToolResult` once it knows which path it took — not to make this eager.
    async () => {
      await assertTenantNotSuspended(tenantId);
      return tenantId;
    },
  );
  return jsonResponse({ resolved: true, delivery });
});

export function registerAgentRoutes(router: Router): void {
  router.add('POST', '/api/agent/session/issue', issue);
  router.add('POST', '/api/agent/session/refresh', refresh);
  router.add('POST', '/api/agent/chat', chat);
  router.add('POST', '/api/agent/chat/:turnId/tool-result', toolResult);
}
