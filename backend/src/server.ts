// src/server.ts — Bun.serve entrypoint. Mirrors fr ordering: process error
// handlers → config validation → DB connect + migrate → router → serve.
// A dropped DB connection (laptop sleep/wake, the flaky dev :5433 crash-recovering, a
// pgbouncer reload / failover in prod) makes postgres-js throw from its internal write
// timer — `socket.write` on a null socket → an uncaught TypeError surfacing here, or a
// CONNECTION_* / CONNECT_TIMEOUT / ECONNRESET / EPIPE rejection. ONCE THE SERVER IS UP these
// do NOT corrupt app state: postgres-js reconnects on the next query, so we log and keep
// serving (exiting turned every transient blip into a permanent outage — dev `bun run dev`
// does not auto-restart → 500s until manual restart; prod → needless churn). But BEFORE the
// server is listening, the same error means the DB is unreachable at boot: there is nothing to
// "keep serving", so swallowing it just made the process drift to a confusing exit-0. In that
// phase we FAIL FAST with a clear message + exit(1) so the supervisor (k8s / the dev shell)
// retries cleanly. See the 2026-06-17 500-cascade root-cause.
let serverReady = false;
function isRecoverableDbError(err: unknown): boolean {
  // postgres-js connection errors often carry the kind in `.code`/`.errno` with an EMPTY message
  // and a `node:net` stack (e.g. await-rejected ECONNREFUSED), so match all of code/errno/message/stack.
  const e = err as { message?: unknown; stack?: unknown; code?: unknown; errno?: unknown } | null;
  const text = [e?.code, e?.errno, e?.message, e?.stack].map((v) => String(v ?? '')).join('\n');
  return /postgres\/src\/connection|socket\.write|CONNECTION_(CLOSED|ENDED|DESTROYED)|CONNECT_TIMEOUT|ECONNRESET|ECONNREFUSED|EPIPE/i.test(
    text,
  );
}
function handleAsyncError(label: string, err: unknown, fatal: boolean): void {
  if (isRecoverableDbError(err)) {
    if (serverReady) {
      log.error('db_connection_error_recoverable', { component: 'server', label, err });
      return;
    }
    // Pre-listen: the DB is unreachable at startup. Fail fast and let the supervisor retry.
    log.error('db_unreachable_during_startup', {
      component: 'server',
      label,
      reason: 'DB unreachable before listen — exiting for supervisor restart',
      err,
    });
    process.exit(1);
  }
  log.error('unhandled_async_error', { component: 'server', label, err });
  if (fatal) process.exit(1);
}
process.on('unhandledRejection', (reason) => handleAsyncError('unhandledRejection', reason, false));
process.on('uncaughtException', (err) => handleAsyncError('uncaughtException', err, true));

import { config, validateProductionConfig, logRunBudgetOverrides } from './config';
import { checkKeycloakReachable } from './services/keycloak';
import { recordHttp } from './host/metrics';
import { registerMetricsRoutes } from './routes/metrics';
import { registerLivenessRoutes } from './routes/health';
import { Router } from './utils/router';
import { validateConnection, withTenantDb, runAsSystem } from './db/client';
import { peekEffectiveTenant } from './middleware/tenant';
import { HttpError, jsonResponse } from './utils/http';
import {
  runWithRequestContext,
  sanitizeInboundRequestId,
  type RequestContext,
} from './host/request-context';
import { log } from './host/logger';
import { checkRateLimit, rateLimitError } from './middleware/rate-limit';
import { authenticateWithoutLicense } from './middleware/auth';
import { applyMigrations } from './db/migration-runner';
import { seedAll } from './db/seed';
import { runBootSeeds } from './db/boot-seeds';
import { getSnapshot } from './host/policy-store';
import { bootReconcileModelsAllowlist } from './host/allowlist-reconcile';
import {
  findUnpricedAllowlistedModels,
  findUnallowlistedCatalogModels,
} from './ai/llm/pricing';
import { registerMeRoutes } from './routes/me';
import { registerLicenseRoutes } from './routes/license';
import { registerBlockRoutes } from './routes/blocks';
import { registerFlowRoutes } from './routes/flows';
import { registerSandboxRoutes } from './routes/sandboxes';
import { registerDatasetRoutes } from './routes/datasets';
import { registerOntologyRoutes } from './routes/ontology';
import { registerTemplateRoutes } from './routes/templates';
import { registerFlowTemplateRoutes } from './routes/flow-templates';
import {
  registerConnectorRoutes,
  bootReconcileConnectorNotifications,
} from './routes/connectors';
import { registerOpsRoutes } from './routes/ops';
import { registerChallengeRoutes } from './routes/challenges';
import { registerInformationRequestRoutes } from './routes/information-requests';
import { registerSolutionRoutes } from './routes/solutions';
import { registerSearchRoutes } from './routes/search';
import { registerMarketplaceSummaryRoutes } from './routes/marketplace-summary';
import { registerGovernanceRoutes } from './routes/governance';
import { registerPipelineRoutes } from './routes/pipeline';
import { registerCycleRoutes } from './routes/cycle';
import { registerAuditRoutes } from './routes/audit';
import { registerRunRoutes, startRunReconciler } from './host/run-controller';
import { registerRunStream } from './host/sse-stream';
import { registerAgentRoutes } from './routes/agent';
import { registerMcpRoutes } from './routes/mcp';
import { registerLlmSettingsRoutes } from './routes/llm-settings';
import { registerTenantCycleCadenceRoutes } from './routes/tenant-cycle-cadence';
import { registerNotificationRoutes } from './routes/notifications';
import { registerAdminRoutes } from './routes/admin';
import { registerPlatformPlanRoutes } from './routes/platform-plans';
import { registerOnboardingRoutes } from './routes/onboarding';
import { registerTenantUserRoutes } from './routes/tenant-users';
import { registerSsoRoutes } from './routes/sso';
import { registerDeliveryRoutes } from './routes/delivery';
import { registerTranslationRoutes } from './routes/translations';
import { registerBillingViewRoutes } from './routes/billing-view';
import { startSandboxWatchdog } from './host/sandbox-service';
import { startConnectorListener } from './datasets/connector-listener';
import { startAuditExportScheduler } from './host/audit-export-scheduler';
import { startCycleScheduler } from './host/cycle-scheduler';
import { ensureCadencePolicy } from './host/cycle-cadence';
import { startTranslationScheduler } from './host/translation-scheduler';
import { startOnboardingIntegrity } from './host/onboarding-integrity';
import { startSignupDigest } from './host/signup-digest-scheduler';
import { startMeteringOutboxDrainer } from './host/metering-outbox-drainer';
import { startMeteringReconciler } from './host/metering-reconcile';
import { UnauthorizedError } from './types';
import { logSignupTelegramStatus } from './services/signup-telegram';
import { logTurnstileStatus } from './services/turnstile';

validateProductionConfig();

await validateConnection();
// Schema migrations run as the OWNER (DDL / CREATE ROLE / RLS) — config.database.migrateUrl.
// Today that equals DATABASE_URL; D.1.2 sets it to the owner DSN while DATABASE_URL becomes cp_app.
await applyMigrations(config.database.migrateUrl);

// The `cycle.cadence` governance row (off | week | month | quarter | year). Written ONCE, from CYCLE_ENABLED
// ('week' when true, else 'off'); ON CONFLICT DO NOTHING, so an edit on /governance survives every
// restart. Not part of the demo seed on purpose: the platform clock must exist whether or not demo
// data is seeded. Owner pool — `policies` is a platform table.
try {
  await runAsSystem('non-rls-table', () => ensureCadencePolicy());
} catch (err) {
  log.error('cycle_cadence_policy_ensure_failed', { component: 'server', err });
}

// Product content seeded at every boot, independent of SEED_DEMO_DATA (false in prod), like the
// cadence row above: the starter flow templates and the platform blocks' port labels. Best-effort
// per step (db/boot-seeds.ts). ⛔ tests/boot-seeds.test.ts asserts this call exists — CI seeds via
// `bun run seed`, never through this file, so nothing else would notice it going missing.
await runBootSeeds();

// Auto-seed the demo catalogue on boot (idempotent). Off by default; prod opts in
// via SEED_DEMO_DATA=true so a cold DB self-heals its showcase data on the next roll.
// Seed is a SYSTEM operation (creates the tenants/users + global-scope catalogue rows, then the
// demo tenant's scoped rows) so it runs on the owner pool, bypassing RLS — runAsSystem.
if (config.seedDemoData) {
  try {
    await runAsSystem('boot-seed', () => seedAll());
  } catch (err) {
    // Seeding is best-effort showcase data — never block the server from coming up.
    log.error('auto_seed_failed', {
      component: 'server',
      reason: 'seed is best-effort showcase data — continuing without it',
      err,
    });
  }
}

// Additive-only self-heal for `models.allowlist` (see host/allowlist-reconcile.ts for the full
// reasoning: only ADDS catalog ids to a row an operator has never edited, never removes/reorders,
// fully audited, never throws). Runs BEFORE the drift check below so that check's WARN reflects
// what's left after self-heal — only the gaps a human actually owns (an edited row) stay visible.
if (config.reconcileAllowlistOnBoot) {
  await bootReconcileModelsAllowlist();
}

// Allowlist ⇄ pricing drift check (see `pricing.ts findUnpricedAllowlistedModels`). WARN, not
// fail-boot: `models.allowlist` and `models.pricing` are BOTH operator-editable governance rows
// with no FK or schema tying them together, so this is a data-quality check on a value the
// operator can (and, per this bug, did) edit live — hard-failing boot on that would let a routine
// Governance-screen allowlist edit take the whole platform down, which is a worse outage than the
// under-billing it would be "protecting" against (priceCall already fails safe to the flat
// estimate, so a drifted model still gets billed something, just not the exact published rate).
try {
  const snapshot = await getSnapshot();
  const unpriced = findUnpricedAllowlistedModels(snapshot);
  if (unpriced.length > 0) {
    log.warn('pricing_allowlisted_models_unpriced', {
      component: 'pricing',
      reason:
        'allowlisted model(s) have no price-table entry and are not on the accepted-unpriced ' +
        'list — they bill at the flat estimate until priced',
      count: unpriced.length,
      models: unpriced,
    });
  }
  // The INVERSE drift, and the more damaging one: a catalog model the allowlist omits is offered
  // in the tenant LLM-settings dropdown, saves cleanly, and is then refused by the broker on EVERY
  // call (`model_not_allowed`). `models.allowlist` is seeded once from the catalog and never
  // reconciled, so this grows silently every time the catalog gains or renames a model.
  const unallowlisted = findUnallowlistedCatalogModels(snapshot);
  if (unallowlisted.length > 0) {
    log.warn('models_catalog_not_allowlisted', {
      component: 'models',
      reason:
        'catalog model(s) are NOT on models.allowlist — a tenant can select and save them, then ' +
        'every LLM call is refused with model_not_allowed. Allowlist them on the Governance ' +
        'screen or remove them from the catalog',
      count: unallowlisted.length,
      models: unallowlisted,
    });
  }
} catch (err) {
  log.error('pricing_drift_check_failed', {
    component: 'pricing',
    reason: 'allowlist/pricing drift check failed — continuing boot',
    err,
  });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = config.cors.origins.includes(origin)
    ? origin
    : config.cors.origins[0] ?? '';
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-credentials': 'true',
  };
}

const router = new Router();

// GET /health/live — LIVENESS. A literal 200: no await, no dependency, no DB. Registered from
// routes/health.ts (a route defined in THIS file is unreachable to tests — see the /metrics note
// below), which carries the full rationale for commonpractice#308.
registerLivenessRoutes(router);

// ⛔ DO NOT wire the connector LISTEN client into /health or /ready. Both probe the request pool via
// validateConnection(), and that is the whole point: these two answer "can this pod SERVE", and a
// pod that cannot LISTEN is serving every request perfectly. Reporting "this pod cannot LISTEN" here
// would depool it — turning a degraded, self-healing background feature (the Datasets screen falls
// back to a manual refresh) into an unnecessary depool. (Before gitops #3372 this would also have
// RESTARTED the pod, because livenessProbe pointed at /health; it now points at /health/live, so the
// blast radius of a mistake here is depooling, not a CrashLoopBackOff.) The listener's own health is exported as
// `connector_listen_connects_total` / `_disconnects_total` on /metrics, where it belongs: an alert,
// not a kill switch. That guidance is unchanged and still right.
//
// ⚠️ WHAT CHANGED, AND WHY THE OLD VERSION OF THIS COMMENT MISLED (commonpractice#308). It used to
// justify itself with "/health is BOTH the readiness AND the liveness probe". That premise was the
// DEFECT ITSELF, not a constraint to design around — and it applies with equal force to POSTGRES,
// which this very handler gates on: /health 503s when the DB is down, so at `failureThreshold: 3` ×
// `periodSeconds: 20` a ~60s Postgres blip SIGTERMs BOTH replicas at once, and restarting a pod
// cannot make an unreachable database reachable. The right conclusion was never "keep dependencies
// out of the one endpoint doing both jobs" — one endpoint cannot do both jobs, because they want
// opposite answers when a dependency is down. It was "LIVENESS NEEDS ITS OWN ENDPOINT". It now has
// one: GET /health/live (routes/health.ts). So do NOT re-derive the old conclusion, and do NOT make
// /health or /ready shallower to protect the pod from a restart — /health stays readiness-shaped
// (deep, DB-gated) on purpose: depooling a pod whose database is gone is correct; killing it is not.
//
// ✅ THE MANIFEST HALF IS DONE — gitops #3372 (2026-09-04). livenessProbe AND startupProbe both point
// at /health/live; readinessProbe stays on /health. /health is NO LONGER a kill probe: a 503 from it
// depools the pod, it does not restart it. ⚠️ This paragraph used to say the repoint was NOT done and
// that /health was "STILL the live kill probe in the cluster" — do not re-inherit that. The unblock
// sequence it described was followed to the letter: /health/live was proven 200 in the RUNNING pod
// (not merely present in this repo) before the manifest moved. That ordering mattered — #354 merged
// at 05:48Z but its CI was cancelled by a node cordon, so the cluster served the pre-#354 image and
// /health/live 404'd for ~45 min AFTER the merge looked done.
router.add('GET', '/health', async () => {
  let dbUp = true;
  try {
    await validateConnection();
  } catch {
    dbUp = false;
  }
  return json({ ok: dbUp, db: dbUp ? 'up' : 'down' }, { status: dbUp ? 200 : 503 });
});

// Deep readiness — DB + Keycloak JWKS reachability. `/health` (DB-only) can report healthy on a
// pod that can validate NO token (misconfigured Keycloak URL/realm); `/ready` catches that. Wired
// to NO probe as of gitops #3372 — startupProbe moved to /health/live — so a transient Keycloak blip
// can no longer depool OR restart an already-serving pod, and `/ready` is now a diagnostic endpoint
// only. ⚠️ That is a deliberate trade, not an oversight: NOTHING gates on Keycloak any more, so a pod
// that can validate no token will still take traffic. Accepted because a dependency-gated STARTUP
// probe does not depool a bad pod, it KILLS it (30 × 10s), so a Keycloak blip during a rolling deploy
// could brick every replica and leave nothing serving. Full reasoning is in the manifest itself.
router.add('GET', '/ready', async () => {
  let dbUp = true;
  try {
    await validateConnection();
  } catch {
    dbUp = false;
  }
  // Keycloak is irrelevant when auth is bypassed (dev/CI only — blocked in prod by config check).
  const kcUp = config.authBypass ? true : await checkKeycloakReachable();
  const ok = dbUp && kcUp;
  return json(
    {
      ok,
      db: dbUp ? 'up' : 'down',
      keycloak: kcUp ? 'up' : 'down',
      isolation: {
        backend: config.run.backend,
        runtimeClass: config.run.backend === 'k8s' ? config.run.k8s.runtimeClass : null,
      },
    },
    { status: ok ? 200 : 503 },
  );
});

// Prometheus metrics — moved to routes/metrics.ts so it can be dispatched by tests (a route
// defined here is unreachable: importing server.ts serves, migrates and arms every scheduler).
registerMetricsRoutes(router);

registerMeRoutes(router);
registerLicenseRoutes(router);

registerBlockRoutes(router);
registerFlowRoutes(router);
registerSandboxRoutes(router);
registerDatasetRoutes(router);
registerOntologyRoutes(router);
registerTemplateRoutes(router);
registerFlowTemplateRoutes(router);
registerConnectorRoutes(router);
registerOpsRoutes(router);
registerChallengeRoutes(router);
registerInformationRequestRoutes(router);
registerSolutionRoutes(router);
registerSearchRoutes(router);
registerMarketplaceSummaryRoutes(router);
registerGovernanceRoutes(router);
registerPipelineRoutes(router);
registerCycleRoutes(router);
registerAuditRoutes(router);
registerRunRoutes(router);
registerRunStream(router);
registerAgentRoutes(router);
registerMcpRoutes(router);
registerLlmSettingsRoutes(router);
registerTenantCycleCadenceRoutes(router);
registerNotificationRoutes(router);
registerAdminRoutes(router);
registerPlatformPlanRoutes(router);
registerOnboardingRoutes(router);
registerTenantUserRoutes(router);
registerSsoRoutes(router);
registerDeliveryRoutes(router);
registerTranslationRoutes(router);
// What the customer is actually BILLED (routes/billing-view.ts) — a read-only proxy over
// billing-service for the tenant_admin, plus the member-facing "my usage" read served from CP's
// own ledger. No figure on these routes is computed here; see that file's header for why.
registerBillingViewRoutes(router);

// Periodic idle-sweep: auto-suspend idle/error sandboxes past the threshold.
// Started here (boot only) so `bun test` never spins the interval.
startSandboxWatchdog();
startRunReconciler();

// LISTEN on the connector channels so an upstream event (via /api/connectors/events)
// drives a refresh + an SSE status push — no polling. Boot-only (never in tests).
//
// WARN, do not throw, when prod has no explicit LISTEN DSN: the fallback (DATABASE_URL, i.e. the
// session pooler) still WORKS, it just puts the pinned LISTEN session back inside pool_size and
// back under the server's 10-minute idle reaper. Making it a validateProductionConfig requirement
// would mean the window between Flux's image-policy bump and the gitops env merge — which are not
// atomic — CrashLoopBackOffs the entire backend over a background feature. Optional also makes
// rollback one env-var deletion with no code deploy.
if (config.env === 'production' && !config.database.listenUrlExplicit) {
  log.warn('connector_listen_url_unset', {
    component: 'connector',
    reason:
      'LISTEN_DATABASE_URL is unset — the connector LISTEN session falls back to DATABASE_URL ' +
      '(the session pooler). It will occupy one pgbouncer pool_size slot and be reaped by ' +
      'idle_session_timeout, dropping any NOTIFY in the reconnect gap. Set it to the DIRECT ' +
      'postgres DSN.',
  });
}
void startConnectorListener();

// Opt-in boot pass (CP_CONNECTOR_NOTIFY_RECONCILE_ON_BOOT): re-assert every storage+webhook
// connector's MinIO notification rule once, recovering rules lost after a MinIO restart.
// Default OFF + best-effort (never blocks boot, never throws). Boot-only (never in tests).
void bootReconcileConnectorNotifications();

// Nightly audit-log compliance export (Phase 2-F). Boot-only; a no-op unless
// AUDIT_EXPORT_ENABLED=true with a configured storage target (never spins in tests).
startAuditExportScheduler();

// Daily marketplace-cycle tick (Phase 2-E). Boot-only; always armed — each tick reads the
// `cycle.cadence` policy and does nothing while it is off and no period is running.
startCycleScheduler();

// Translation drainer (Phase 2-G). Boot-only; a no-op unless TRANSLATION_ENABLED=true
// (never spins a timer in tests). Translates queued UGC into the 7 non-en locales.
logRunBudgetOverrides();
// Early-access signup: one line each saying whether Telegram notification / Turnstile are on.
logSignupTelegramStatus();
logTurnstileStatus();
startTranslationScheduler();

// Onboarding-integrity reconciler (host/onboarding-integrity.ts). Boot-only, same convention
// as every scheduler above so `bun test` never spins it; flag-gating (if any) is internal to
// startOnboardingIntegrity itself.
startOnboardingIntegrity();

// Unverified-signup Telegram digest (host/signup-digest-scheduler.ts). Boot-only; a no-op (logged)
// unless Telegram is configured and SIGNUP_DIGEST_INTERVAL_HOURS > 0.
startSignupDigest();

// Metering outbox drainer (host/metering-outbox-drainer.ts). Boot-only; a no-op unless
// METERING_EMIT_ENABLED. Delivers the cost events settleSpend enqueues in its ledger transaction.
startMeteringOutboxDrainer();

// Daily CP-ledger vs billing reconciliation (host/metering-reconcile.ts). Boot-only, same
// convention as every scheduler above. A no-op unless METERING_EMIT_ENABLED *and* billing is
// configured — both refusals are logged rather than silent, because a scheduler that is silently
// absent reads exactly like one that is silently broken. It writes nothing; it measures.
startMeteringReconciler();

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  // Bun's default idleTimeout is 10s. A synchronous handler that waits on a run —
  // notably a block-test run or the publish gate (which runs the suite inline) — holds
  // the connection with no bytes flowing while a RUN_BACKEND=k8s Kata run-pod cold-starts
  // (VM boot + image pull can exceed 10s on a cold node). At 10s Bun closes the socket
  // (ECONNRESET on the client) even though the run completes server-side, so the test/
  // publish endpoints appear to fail in prod. 255s is Bun's maximum and comfortably covers
  // the run wall budget (config.run.maxRunMs, default 30s) plus pod cold-start. SSE runs are
  // unaffected (their keepalive bytes reset the idle timer).
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    // ⛔ ONE ID PER REQUEST, MINTED HERE AND NOWHERE ELSE. `route()` used to mint its own, which
    // meant a log line written outside route() carried a DIFFERENT id than the one the client was
    // handed — correlation that appears to work and silently does not join. Bound to the async call
    // chain so code any number of frames deep can read it without being passed it.
    const ctx: RequestContext = {
      requestId: sanitizeInboundRequestId(req.headers.get('x-request-id')) ?? crypto.randomUUID(),
      method: req.method,
      tenantId: null,
    };
    return runWithRequestContext(ctx, async () => {
    const matched = router.match(req.method, url.pathname);
    if (!matched) {
      // Logged too, and deliberately. This branch returns BEFORE `route` exists, so it sits
      // outside the instrumented path below — which would have left the single most common thing
      // a tester actually reports ("your link 404s") as the one failure that still produced no
      // server-side trace at all. `route: '(unmatched)'` keeps the template field low-cardinality
      // while `path` carries the URL that was actually asked for.
      // `msg: 'http'` deliberately, so this line greps alongside the per-failed-request emitter
      // in the `finally` below. `route` is passed explicitly because `ctx.route` is not assigned
      // on this branch — there is no matched template to assign.
      log.warn('http', {
        method: req.method,
        route: '(unmatched)',
        path: url.pathname,
        status: 404,
      });
      return json({ error: 'Not Found' }, { status: 404, headers: corsHeaders(req) });
    }
    // Record throughput / error-rate / latency per matched route TEMPLATE (low cardinality).
    // /metrics is excluded so a scrape never measures itself.
    const route = matched.template;
    ctx.route = route;

    // ⛔ BEFORE `peekEffectiveTenant`, WHICH IS A DATABASE ROUND TRIP. Limiting after it would let
    // an unauthenticated flood reach postgres on every request and merely change what we return
    // afterwards — the pool, not the response, is the resource worth protecting here.
    // ⛔ RESOLVE WHO BEFORE CHOOSING A TIER. Passing `null` here is what made `checkRateLimit`
    // fall back to "has an Authorization header", i.e. a tier chosen by an unvalidated string:
    // `Authorization: Bearer anything` bought the 600/min bucket instead of the 30/min one.
    //
    // `authenticateWithoutLicense` is the cheap half of `validateAuth`: it verifies the JWT with
    // `jwtVerify` against the CACHED `createRemoteJWKSet` and stops there. No database round trip,
    // so the ordering the comment above insists on — limit before we touch postgres — still holds.
    // It deliberately does NOT run `assertTenantActive`/`licenseCallerTenant`; those are DB calls
    // and a rate-limit tier has no business asserting a licence.
    //
    // Fails CLOSED to the strict tier: a malformed, expired or forged token throws here and the
    // caller is treated as anonymous, which is the safe direction. A genuine user degrades from
    // 600/min to 30/min only if token verification itself is failing, in which case their request
    // was about to 401 anyway.
    let rateLimitUserId: string | null = null;
    if (req.headers.has('authorization')) {
      try {
        rateLimitUserId = (await authenticateWithoutLicense(req)).id;
      } catch {
        rateLimitUserId = null;
      }
    }
    const decision = checkRateLimit(req, route, server?.requestIP(req)?.address ?? null, rateLimitUserId);
    if (decision && !decision.allowed) {
      const err = rateLimitError(decision);
      const res = jsonResponse({ error: err.code, message: err.message }, 429);
      res.headers.set('retry-after', String((err.details as { retryAfterSec: number }).retryAfterSec));
      res.headers.set('x-request-id', ctx.requestId);
      for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
      recordHttp(req.method, route, 429, 0);
      return res;
    }

    const startMs = performance.now();
    let status = 500;
    // Hoisted out of the `try` so the `finally` below can put them in the log line. Both are
    // already computed on the happy path; nothing new is being resolved for logging's sake.
    let tenantId: string | null = null;
    let requestId: string | null = null;
    try {
      // Phase D (RLS): pre-set app.current_tenant for the request, then run the handler with a
      // tenant-bound DB connection (the guards correct the value authoritatively via refreshTenantGuc).
      tenantId = await peekEffectiveTenant(req);
      ctx.tenantId = tenantId;
      // Gate 2 (the licence check) used to run HERE, before any route guard, against whichever
      // tenant `peekEffectiveTenant` resolved. That made the whole super_admin console hostage to
      // the tenant an operator was acting into: scope-switch into an unlicensed tenant and
      // /api/pipeline, /api/audit, /api/governance, /api/ops all answered 402. It is now
      // GUARD-DERIVED — `validateAuth` runs it, `requireSuperAdmin` does not — see
      // middleware/license-gate.ts. This wrapper keeps only the RLS pre-set.
      const res = await withTenantDb(tenantId, () =>
        matched.handler(req, ...matched.params),
      );
      for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
      status = res.status;
      // Success responses never carried this before — only `route()`'s error path set it. A support
      // conversation about a request that SUCCEEDED but did the wrong thing had no id to quote.
      if (!res.headers.has('x-request-id')) res.headers.set('x-request-id', ctx.requestId);
      requestId = ctx.requestId;
      return res;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        status = 401;
        return json({ error: err.message }, {
          status: 401,
          headers: { ...corsHeaders(req), 'x-request-id': ctx.requestId },
        });
      }
      // Handlers not wrapped in route() (and anything thrown before one) surface their HttpError
      // here. Gate 2 now throws from inside a guard, so its 402/403 normally leaves via route();
      // this stays as the backstop for the unwrapped handlers.
      if (err instanceof HttpError) {
        status = err.status;
        // Mirror route()'s 5xx logging (utils/http.ts): errors thrown BEFORE the handler —
        // peekEffectiveTenant, assertTenantLicensed — never pass through route(), so a
        // licenses.example.com outage (502 license_unavailable) or a Keycloak-side tenant lookup
        // failure returned a JSON body to the browser and left the pod logs completely empty.
        if (err.status >= 500) {
          log.error('route_http_error', {
            component: 'route',
            status: err.status,
            code: err.code,
            details: err.details ?? null,
            err,
          });
        }
        const res = jsonResponse({ error: err.code, message: err.message }, err.status);
        for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
        return res;
      }
      log.error('unhandled_handler_error', { err });
      status = 500;
      return json({ error: 'Internal Server Error' }, {
        status: 500,
        headers: { ...corsHeaders(req), 'x-request-id': ctx.requestId },
      });
    } finally {
      const durMs = performance.now() - startMs;
      if (route !== '/metrics') {
        recordHttp(req.method, route, status, durMs / 1000);
        // ONE STRUCTURED LINE PER FAILED REQUEST — and until 2026-08-10 there were none at all.
        //
        // `recordHttp` feeds an in-process Prometheus histogram: per-pod, low-cardinality, wiped on
        // restart, and invisible unless something is scraping. Nothing else on this path wrote to
        // stdout except 5xx. The result was that a production pod's logs ran to FOURTEEN LINES for
        // the container's entire life — every 400, every 401, every 402/403 licence refusal, every
        // ZodError left no trace whatsoever. "Zero errors in the backend logs" was cited as
        // evidence in three separate handoffs; it meant almost nothing, because a tester filling a
        // form in wrong or hitting a seat cap produced exactly the same silence as a healthy pod.
        //
        // Errors only, not an access log: /api/me and the SSE routes are chatty enough that full
        // access logging would drown the signal this exists to provide. 4xx is the caller's
        // problem (warn), 5xx is ours (error).
        //
        // `route` is the TEMPLATE, so it stays low-cardinality and greppable; `path` carries the
        // actual ids for correlation. `reqId` is minted by route() (utils/http.ts) and echoed to
        // the client, so a support conversation can be matched to a log line exactly.
        //
        // ⛔ DELIBERATELY NOT ROUTED THROUGH `host/logger.ts`, and this is the one site that
        // should stay on `console.*`. It is ALREADY a structured line, and it carries `reqId`
        // EXPLICITLY from `ctx`. `log.*` reads `reqId` from the AsyncLocalStorage scope instead,
        // so moving this here would make the correlation id depend on that scope still being
        // active in the `finally` of the response path — and if it ever is not, every 4xx/5xx
        // line silently loses the id, which is the one field the whole exercise exists to
        // guarantee. The logger's own docstring names this emitter as the shape it was modelled
        // on; the model does not need to be converted to its own copy.
        if (status >= 400) {
          const line = JSON.stringify({
            lvl: status >= 500 ? 'error' : 'warn',
            msg: 'http',
            method: req.method,
            route,
            path: url.pathname,
            status,
            ms: Math.round(durMs),
            reqId: ctx.requestId,
            tenant: tenantId,
          });
          if (status >= 500) console.error(line);
          else console.warn(line);
        }
      }
    }
    });
  },
});

// The server is now accepting connections. From here on, a dropped DB connection is a
// recoverable runtime blip (postgres-js reconnects), not a fatal boot failure.
serverReady = true;
log.info('server_listening', { component: 'server', host: config.host, port: server.port });
