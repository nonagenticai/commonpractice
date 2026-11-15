// src/middleware/tenant-status-gate.ts — enforcement for `tenants.status`.
//
// `tenants.status` has been in the schema since Phase 2-D (`tenant_status` = active | suspended,
// db/schema.ts) and the operator console has shipped an "Opschorten" button against it for as long.
// Until this module existed the column was PURELY DECORATIVE: suspending a tenant flipped a pill in
// the SPA, wrote `status='suspended'`, returned a green banner — and every user of that tenant kept
// their full session, their full API surface, their copilot and their MCP key. Nothing anywhere in
// `backend/src` read the column for an authorization decision. This module is that read.
//
// TWO ENTRY POINTS, because the product has two kinds of caller:
//   • `assertTenantActive(req, user)` — the request-scoped gate, entered from `validateAuth`
//     (middleware/auth.ts) alongside Gate 2. Resolves the caller's effective tenant exactly as
//     `licenseCallerTenant` does, and memoises per Request.
//   • `assertTenantNotSuspended(tenantId)` — the bare tenant-id form, for the paths that hold a
//     tenant id and NO Keycloak JWT and so never reach `validateAuth` at all: `routes/agent.ts`
//     (the copilot's agent-session token) and `routes/mcp.ts` (API key / agent JWT / AUTH_BYPASS).
//     Those two were the whole hole: without them a suspended tenant keeps full copilot and full
//     MCP tool access while every browser route 403s, which is worse than not shipping the gate.
//
// THE MATCH IS THE LITERAL `'suspended'`, NEVER `!== 'active'` AND NEVER A TRUTHINESS TEST.
// `tenant_status` is a pgEnum and enums grow: the next value added to it (`pending`, `trialing`,
// `archived`, …) must be a deliberate decision about whether it denies, not a state this gate
// silently starts locking every user out of because someone widened an enum in a migration.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ DECISION 1 — THE LOOKUP FAILING DENIES (503), IT DOES NOT PASS THROUGH.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The rejected argument, stated fairly and at full strength, because it is the one the next reader
// will arrive with: this gate runs on 100% of tenant-facing requests to enforce a state that ~0% of
// rows carry. Its failure blast radius is therefore the entire fleet, in exchange for a control
// that almost never fires. Failing open would bound the damage to "a suspended tenant gets a few
// extra minutes" instead of "nobody can use the product".
//
// It is still wrong, for two reasons that are specific to WHERE this gate sits.
//
// (a) FAILING OPEN DOES NOT BUY THE AVAILABILITY IT PROMISES, because a TOTAL Postgres outage
//     already 500s every tenant request UPSTREAM of here. `server.ts`'s fetch wrapper runs
//     `peekEffectiveTenant` and then `withTenantDb(tenantId, handler)` before any handler — and
//     `withTenantDb` RESERVES a connection and issues `set_config('app.current_tenant', …)` on it
//     (db/client.ts) — and `resolveTenant` then calls `ensureUser`, which opens a transaction. If
//     the database is unreachable, none of that survives. So in the scenario people picture when
//     they say "fail open", this gate failing open converts a clean 403 into a 500 and protects
//     nothing at all.
//
// (b) WHAT ACTUALLY REMAINS IS **PARTIAL** FAILURE — POOL EXHAUSTION — AND THAT IS ATTACKER-
//     INDUCIBLE. db/client.ts records the measurement twice over: `DB_POOL_MAX` is 6, a request
//     holds its reserved slot for its whole lifetime, and SIX CONCURRENT REQUESTS are enough to
//     park all six (the `/health` A/B on a hung licences service, and the `/metrics` reproduction
//     that parked `cp-query` non-idle = 1,2,3,4,5,6). postgres-js QUEUES rather than failing fast.
//     A gate that fails open under pool pressure is therefore a bypass that any suspended tenant
//     can trigger on demand by opening six tabs — a load-triggered authorization hole, which is the
//     worst shape a control can have because it opens exactly when the system is least watched.
//
// The honest cost of choosing DENY is real, so it is paid explicitly rather than hidden:
//   • a DISTINCT wire code — `tenant_status_unavailable` (503), never `tenant_suspended` (403). An
//     operator, a support conversation and a dashboard can all tell "we suspended this workspace"
//     apart from "we could not find out". Collapsing them would tell a paying customer they had
//     been suspended because a connection pool was busy.
//   • 503, not 403, so `route()`/`server.ts`'s `status >= 500` branch logs it (utils/http.ts) — the
//     repo has already been burned by 4xx refusals leaving no server-side trace whatsoever.
//   • a counter, `tenant_status_lookup_failures_total`, because nobody reads response bodies in a
//     dashboard. These are MANDATORY, not decorative: they are the entire mitigation for (b)'s
//     blast radius, and deleting either one re-creates a fleet-wide failure nobody can see.
//
// ⚠️ ONE KNOWN IMPRECISION IN THE CATCH, recorded so it is not rediscovered as a bug: a tenant id
// that is not a valid uuid raises Postgres 22P02 from this SELECT and is reported here as a 503
// rather than a 400. The home tenant comes from a `uuid` column, so only a bypass/test identity can
// carry a malformed one. It is left as-is deliberately — `middleware/license-gate.ts` has exactly
// the same behaviour (a 22P02 out of `tenantLicenseToken` becomes `license_unavailable`) and a
// garbage id is fail-closed either way. Do not "fix" it by skipping the gate for non-uuid ids; that
// turns a malformed id into a bypass.
//
// ⚠️ `tenant_status_lookup_failures_total` is deliberately NOT in `PRESEEDED_COUNTERS`
// (host/metrics.ts). That list's membership rule is "fixed literal AND a gitops rule consumes it
// through increase()/rate()" — no rule reads this one yet, and seeding a series on every pod to
// feed an alert that does not exist is the thing that list's docblock argues against. The
// consequence is the documented first-failure blind spot: the series appears already holding 1, so
// `increase()` cannot see the 0 → 1 rise. TODO(gitops-production): when a
// `CommonPracticeTenantStatusLookupFailures` rule is written, this counter must move into
// `PRESEEDED_COUNTERS` in the same change or the rule cannot fire for a pod's first failure.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ DECISION 2 — A PER-REQUEST MEMO, AND DELIBERATELY NO PROCESS-LEVEL TTL CACHE.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The obvious "optimisation" is a module-level `Map<tenantId, {status, expiresAt}>` with a short
// TTL, the way `services/license-client.ts` caches introspections. It is wrong HERE, and the reason
// is a deployment fact rather than a taste: CP runs 2–4 replicas (recorded in
// middleware/license-gate.ts around the rolling-deploy note). Suspension is written by ONE pod —
// the one that served the operator's PATCH. A TTL cache invalidated in-process therefore reaches
// that pod only; every peer would keep serving the SUSPENDED tenant from its own warm entry for the
// remainder of the TTL, with no way to tell which pod a user's request landed on. A control whose
// enforcement is "eventually, on most pods, probably" is not an enforcement control, and the bug it
// produces is unreproducible by hand.
//
// The cost of not caching is one primary-key SELECT on an indexed `uuid` column. A tenant-facing
// request in this codebase already costs at least five round trips before it reaches a handler
// (peekEffectiveTenant's token validation, the withTenantDb reserve + set_config, ensureUser's
// transaction, refreshTenantGuc, Gate 2's own `tenants` read) — this is noise against that, and the
// memo below already collapses the repeat within a single request.
import { eq } from 'drizzle-orm';
import { db, tenants, runAsSystem } from '../db/client';
import { forbidden, serviceUnavailable } from '../utils/http';
import { incCounter } from '../host/metrics';
import { log } from '../host/logger';
import { isSuperAdmin } from './admin-guards';
import type { User } from '../types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ONE status literal that denies. See the "match the literal" note above. */
const SUSPENDED = 'suspended';

/**
 * Per-REQUEST memo, same shape and same rationale as `middleware/license-gate.ts`'s: one handler
 * routinely passes through two guards (`resolveTenant` then `requireDeveloper`), each of which
 * calls `validateAuth`, so without this the same `tenants` SELECT runs twice per request. Keyed on
 * the Request object itself (weak: nothing is retained past the request).
 *
 * Deliberately a SECOND WeakMap rather than a shared one — the two gates memoise different verdicts
 * and must be able to fail independently.
 */
const memo = new WeakMap<Request, Promise<void>>();

/**
 * The request-scoped gate, entered from `validateAuth` — i.e. from a guard that has already decided
 * this request operates on a tenant's data.
 *
 * ⛔ THE SUPER_ADMIN EXEMPTION IS FIRST, BEFORE ANY QUERY, AND IT IS LOAD-BEARING RATHER THAN A
 * SHORTCUT. Suspension has to be UNDOABLE. `PATCH /api/tenants/:id {status:'active'}` and the whole
 * operator console are reached by a super_admin who may well be scope-switched INTO the suspended
 * tenant via `X-Active-Tenant-Id` — gating them would make the button that suspends a workspace a
 * one-way trap that locks out the only person who can reverse it. (`requireSuperAdmin` itself never
 * reaches this function at all: it calls `authenticateWithoutLicense`, deliberately — see its
 * docblock in admin-guards.ts. This early return is what covers the super_admin who arrives through
 * a TENANT-scoped guard, e.g. `requireTenantAdmin`.) The cost is stated plainly: a super_admin is
 * never blocked by a suspension. That is the intended blast radius; every other role is gated.
 *
 * The tenant resolution below is a verbatim copy IN SHAPE of `licenseCallerTenant` — a super_admin's
 * valid `X-Active-Tenant-Id` beats the home tenant — and NOT a new resolution invented here.
 * The two gates run back-to-back on the same request and MUST agree about which tenant is being
 * judged; a second, subtly different resolution is how you get a request that is licence-checked
 * against one tenant and suspension-checked against another.
 *
 * ⚠️ The header branch is unreachable while the `isSuperAdmin` early return above stands (only a
 * super_admin's header is ever honoured). It is kept, not simplified away, precisely so that
 * narrowing that exemption later — say, to exempt only the platform routes — does not silently
 * leave this function resolving the wrong tenant.
 */
export async function assertTenantActive(req: Request, user: User): Promise<void> {
  if (isSuperAdmin(user)) return;
  let pending = memo.get(req);
  if (!pending) {
    const header = req.headers.get('X-Active-Tenant-Id');
    const tenantId =
      isSuperAdmin(user) && header && UUID_RE.test(header) ? header : (user.tenantId ?? null);
    pending = assertTenantNotSuspended(tenantId);
    memo.set(req, pending);
  }
  await pending;
}

/**
 * The bare tenant-id form, for the no-JWT paths (`routes/agent.ts`, `routes/mcp.ts`) that resolve a
 * tenant from `users.tenant_id` or an MCP key rather than from a verified user, and so never pass through
 * `validateAuth`.
 *
 * Throws `403 tenant_suspended` when the tenant row says `status = 'suspended'`; throws
 * `503 tenant_status_unavailable` when the lookup itself fails (Decision 1 above); returns normally
 * otherwise.
 *
 * TWO NON-THROWING CASES, both deliberate:
 *   • `tenantId === null` — there is no tenant to gate. The caller's own auth guard is what refuses
 *     an unauthenticated request (401/403); this gate has nothing to say about it. Mirrors
 *     `assertTenantLicensed`'s `if (!tenantId) return`.
 *   • THE ROW IS MISSING — a tenant id that was never provisioned. That refusal already exists,
 *     with its own code and its own message, in `requireTenantExists`
 *     (middleware/admin-guards.ts: `403 tenant_not_provisioned`). Answering `tenant_suspended` here
 *     would be a lie about a tenant that does not exist, and would MASK the provisioning fault
 *     behind a commercial-sounding one — an operator would go looking for who suspended a workspace
 *     that was never created. One fault, one owner, one code.
 *
 * `tenants` is a PLATFORM/GLOBAL table (outside RLS), so the read goes through `runAsSystem` on the
 * owner pool — the same escape hatch and the same single-row idiom `lib/license-status.ts`'s
 * `tenantLicenseToken` uses. It works regardless of (and without disturbing) the request's tenant
 * GUC, which matters because the no-JWT callers invoke this BEFORE `withTenantDb` has bound one.
 */
export async function assertTenantNotSuspended(tenantId: string | null): Promise<void> {
  if (!tenantId) return;

  let row: { status: string } | undefined;
  try {
    [row] = await runAsSystem('non-rls-table', () =>
      db
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    );
  } catch (err) {
    // FAIL CLOSED — see Decision 1. The counter and the distinct code are the mitigation for this
    // branch's fleet-wide blast radius, not decoration.
    incCounter('tenant_status_lookup_failures_total');
    log.error('tenant_status_lookup_failed', { component: 'tenant-status-gate', tenantId, err });
    throw serviceUnavailable(
      'tenant_status_unavailable',
      'Could not verify the workspace status; access denied.',
    );
  }

  // Not this gate's error — `requireTenantExists` owns `tenant_not_provisioned`.
  if (!row) return;

  if (row.status === SUSPENDED) {
    throw forbidden('tenant_suspended', 'This workspace has been suspended.');
  }
}
