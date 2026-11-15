// src/db/client.ts
// postgres-js + drizzle (mirrors fr). postgres.js is kept as drizzle's driver;
// Bun.sql has no drizzle adapter yet.
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from '../config';
// Safe: `host/logger` imports only `./request-context`, which imports only `node:async_hooks`.
// No path back to `db/client`, so this adds no import cycle at boot.
import { log } from '../host/logger';
import {
  currentDbContext,
  runWithContext,
  type RequestDbContext,
} from './tenant-context';
import {
  users,
  userRoleEnum,
  tenants,
  tenantStatusEnum,
  identityProviders,
  mcpApiKeys,
  usageEvents,
  signupApprovals,
  emailDomainTenants,
  freeEmailProviders,
  buildingBlocks,
  blockVersions,
  blockTemplates,
  flowTemplates,
  blockCategoryEnum,
  blockStatusEnum,
  blockLanguageEnum,
  flows,
  flowStatusEnum,
  flowRuns,
  flowRunStatusEnum,
  flowRunEvents,
  usageCounters,
  sandboxes,
  sandboxStatusEnum,
  challenges,
  challengeStatusEnum,
  challengeDatasets,
  challengeEntities,
  informationRequests,
  informationRequestRows,
  solutions,
  solutionStatusEnum,
  votes,
  voteTargetTypeEnum,
  comments,
  weeklyWinners,
  marketplaceCycles,
  tenantCycleCadence,
  tenantCycleCadenceChanges,
  marketplaceCyclePhaseEnum,
  policies,
  policyChanges,
  pipelineItems,
  pipelineStageEnum,
  pipelineReviews,
  auditLog,
  auditExports,
  auditExportStatusEnum,
  auditExportTriggerEnum,
  llmProviderEnum,
  chatRoleEnum,
  snapshotSourceEnum,
  tenantLlmSettings,
  agentSessions,
  mcpPrompts,
  mcpPromptVersions,
  chatSessions,
  chatMessages,
  agentToolResults,
  flowSnapshots,
  contentTranslations,
  translationJobs,
  datasets,
  datasetRows,
  datasetSourceTypeEnum,
  datasetStatusEnum,
  blockTests,
  blockTestResults,
  assertModeEnum,
  blockTestStatusEnum,
  ontologyEntities,
  ontologyAttributes,
  ontologyRelations,
  ontologyScopeEnum,
  datasetMappings,
  ontologyEntitySamples,
  mappingSourceEnum,
  deliveryTargets,
  solutionDeliveries,
  deliveryTargetKindEnum,
  deliveryStatusEnum,
  tenantLlmBudgets,
  notifications,
  notificationReads,
  schedulerTicks,
  memberEntitlements,
  meteringOutbox,
} from './schema';

const schema = {
  users,
  userRoleEnum,
  tenants,
  tenantStatusEnum,
  identityProviders,
  mcpApiKeys,
  usageEvents,
  signupApprovals,
  emailDomainTenants,
  freeEmailProviders,
  buildingBlocks,
  blockVersions,
  blockTemplates,
  blockCategoryEnum,
  blockStatusEnum,
  blockLanguageEnum,
  flows,
  flowStatusEnum,
  flowRuns,
  flowRunStatusEnum,
  flowRunEvents,
  usageCounters,
  sandboxes,
  sandboxStatusEnum,
  challenges,
  challengeStatusEnum,
  challengeDatasets,
  challengeEntities,
  informationRequests,
  informationRequestRows,
  solutions,
  solutionStatusEnum,
  votes,
  voteTargetTypeEnum,
  comments,
  weeklyWinners,
  marketplaceCycles,
  tenantCycleCadence,
  tenantCycleCadenceChanges,
  marketplaceCyclePhaseEnum,
  policies,
  policyChanges,
  pipelineItems,
  pipelineStageEnum,
  pipelineReviews,
  auditLog,
  auditExports,
  auditExportStatusEnum,
  auditExportTriggerEnum,
  llmProviderEnum,
  chatRoleEnum,
  snapshotSourceEnum,
  tenantLlmSettings,
  agentSessions,
  mcpPrompts,
  mcpPromptVersions,
  chatSessions,
  chatMessages,
  agentToolResults,
  flowSnapshots,
  contentTranslations,
  translationJobs,
  datasets,
  datasetRows,
  datasetSourceTypeEnum,
  datasetStatusEnum,
  blockTests,
  blockTestResults,
  assertModeEnum,
  blockTestStatusEnum,
  ontologyEntities,
  ontologyAttributes,
  ontologyRelations,
  ontologyScopeEnum,
  datasetMappings,
  ontologyEntitySamples,
  mappingSourceEnum,
  deliveryTargets,
  solutionDeliveries,
  deliveryTargetKindEnum,
  deliveryStatusEnum,
  tenantLlmBudgets,
  notifications,
  notificationReads,
  schedulerTicks,
  memberEntitlements,
  meteringOutbox,
} as const;

// Resilience options shared by both pools. A DB connection that dies out from under
// postgres-js — laptop sleep/wake dropping the docker bridge, the flaky dev :5433
// crash-recovering, a pgbouncer reload / failover in prod — used to wedge or kill the
// backend: postgres-js writes to the now-dead socket from an internal `setImmediate`
// timer (`socket.write` on null → uncaught TypeError) and reserved per-request
// connections that were mid-flight never released. These options bound that surface:
//   • idle_timeout  — close idle connections so a stale socket is dropped, never written to.
//   • max_lifetime  — proactively recycle long-lived connections.
//   • connect_timeout — fail a connect attempt fast instead of hanging a request (and the
//     shared pool) forever when the DB is unreachable.
// Pair with the uncaughtException guard in server.ts (recoverable DB socket errors no
// longer exit the process) so a transient blip self-heals instead of becoming a permanent
// outage. See the 2026-06-17 500-cascade root-cause.
const resilientOptions = {
  onnotice: () => {},
  idle_timeout: 20, // seconds
  max_lifetime: 60 * 30, // 30 minutes
  connect_timeout: 10, // seconds
} as const;

// ---- EVERY client declares an `application_name`. This is diagnostics, not decoration. ----
//
// It used to be set on `listenClient` ONLY (the argument for it is written out on that client
// below), which meant the three pools that actually consume the pgbouncer budget were the three
// that could not be told apart. A saturation event was therefore UNATTRIBUTABLE: `pg_stat_activity`
// and `SHOW POOLS` showed N connections from `commonpractice` with no way to say whether they were
// request traffic, in-request transactions, a scheduler storm on the owner pool, or a migration
// runner that failed to exit — which are four different bugs with four different fixes. The names
// are `cp-query`, `cp-tx`, `cp-owner`, `cp-listen`, `cp-probe`, `cp-metrics` and `cp-migrate`
// (the last in db/migration-runner.ts). tests/pool-application-name.test.ts round-trips them.
//
// ✅ VERIFIED THROUGH PGBOUNCER, not assumed. Reproduced against the pinned pooler image
// (edoburu/pgbouncer:v1.25.1-p0) in BOTH `pool_mode=session` and `pool_mode=transaction`, using
// this repo's exact `ignore_startup_parameters` line: the client-supplied name reaches
// `pg_stat_activity`, and in transaction mode pgbouncer re-`SET`s it per client on a shared server
// connection (one backend pid reported `cp-owner`, then a second client's name, then `cp-owner`
// again — correct each time). Neither pooler sets `server_reset_query`, so nothing wipes it.
//
// ONE precise limitation, which is not the same as "treat it as a hint": the name is exact WHILE a
// client owns the server connection. An IDLE server connection in transaction mode still carries
// the LAST client's name, so a snapshot that includes idle backends can misattribute those rows.
// Filter on `state <> 'idle'` when attributing saturation. There is no fallback if this ever
// regresses — `SHOW POOLS`/`SHOW CLIENTS` report per-(database, user) counts only, and all three
// pooled clients share one user — which is the argument for setting these names at all.
export const queryClient = postgres(config.database.url, {
  ...resilientOptions,
  max: config.database.poolMax,
  connection: { application_name: 'cp-query' },
});
const poolDb = drizzle(queryClient, { schema });
type Db = typeof poolDb;

// Phase D deadlock fix (2026-06-17): a DEDICATED pool for in-request transactions.
// A request holds a RESERVED connection from `queryClient` for its whole lifetime (withTenantDb,
// to carry the session `app.current_tenant` GUC). The Proxy below routes `db.transaction(...)` to
// a SECOND connection (a reserved postgres-js connection has no `.begin()`). If that second
// connection also came from `queryClient`, then under concurrency every request holds its reserved
// conn AND waits for a transaction conn from the SAME exhausted pool → permanent deadlock (e.g.
// concurrent routes calling resolveTenant→ensureUser, which opens a transaction). Drawing the
// transaction connection from an INDEPENDENT pool makes that impossible: the reserved-conn pool and
// the transaction pool can never starve each other. RLS is still enforced via the per-transaction
// `SET LOCAL app.current_tenant` below.
// Exported for tests only (tests/pool-application-name.test.ts round-trips its `application_name`
// against pg_stat_activity). Application code must reach this pool through `db.transaction(...)`,
// which the Proxy below routes here — never by importing this client.
export const txClient = postgres(config.database.url, {
  ...resilientOptions,
  max: config.database.txPoolMax,
  connection: { application_name: 'cp-tx' },
});
const txPoolDb = drizzle(txClient, { schema });

// Phase 4 / D.1.1 (RLS cutover prep): a SECOND pool on the OWNER connection
// (config.database.migrateUrl). Today migrateUrl === url, so this is the same role as
// `queryClient` and is behaviourally identical; once D.1.2 points DATABASE_URL at the
// non-owner `cp_app` role, this owner pool is what `runAsSystem` uses to perform genuine
// cross-tenant SYSTEM work (schedulers, seed, platform cross-tenant reads) that a single
// per-request tenant GUC cannot express. The owner BYPASSES RLS (it owns the tables), so
// SYSTEM work needs no GUC.
//
// ⛔ ITS CEILING IS THE ONE THAT BITES, AND IT USED TO BE A LITERAL. `migrateUrl` points at the
// TRANSACTION pooler (pgbouncer), whose `commonpractice` pool_size is far tighter than the session
// pooler's: at 4 per pod x 4 HPA replicas this pool alone wants 16, and every `runSystemTick`
// scheduler plus the boot migration runner draws from it. It was written as a bare `max: 4` with no
// env var, so the only pool on the more oversubscribed pooler was also the only one that could not
// be retuned without a code deploy — see the full three-pool budget in config.ts. `ownerPoolMax`
// defaults to 4, so this line is behaviourally identical to what it replaces.
// Exported for tests only (tests/pool-budget.test.ts asserts its effective `max` tracks
// `ownerPoolMax` rather than a literal, and tests/pool-application-name.test.ts round-trips its
// `application_name`). Application code reaches this pool through `runAsSystem` / `runSystemTick`.
export const ownerClient = postgres(config.database.migrateUrl, {
  ...resilientOptions,
  max: config.database.ownerPoolMax,
  connection: { application_name: 'cp-owner' },
});
const ownerDb = drizzle(ownerClient, { schema });

// The FOURTH client: the single PINNED session that holds the connector LISTEN registrations
// (datasets/connector-listener.ts). It exists because a LISTEN registration is session state, and
// every one of `resilientOptions`' defences against a stale pooled socket is actively hostile to it:
//   • idle_timeout: null   — a LISTEN session is idle BY DESIGN between NOTIFYs. Reaping it drops
//                            the registration; postgres-js would re-LISTEN, but every NOTIFY in the
//                            gap is lost forever, unlogged. (Postgres' own `idle_session_timeout`
//                            = 10min does exactly this today; the listener clears it per-session.)
//   • max_lifetime: null   — recycling the connection out from under a live registration is the
//                            same data loss on a 30-minute timer.
//   • max: 1               — a registration lives on ONE physical connection; a pool of them would
//                            mean NOTIFYs arriving on whichever connection happened to LISTEN.
//   • fetch_types: false   — no type introspection round-trip; this client runs LISTEN and SET only.
// It is deliberately NOT a drizzle instance: nothing should be tempted to run queries here and
// block the event spine behind an application query.
//
// ⛔ Do NOT reach LISTEN through `queryClient.listen()`. postgres-js does not serve LISTEN from a
// pool — it lazily MEMOISES a hidden client of exactly this shape (node_modules/postgres/src/
// index.js:150-165) inheriting the parent's DSN, i.e. the session POOLER, budgeted nowhere. And its
// `onclose` re-LISTEN path swallows every rejection (`.catch(() => {})`), so a failed re-LISTEN is
// permanently silent. Naming the client here makes it visible, countable, and supervisable.
//
// `connection.application_name` is load-bearing, not decoration: it is the only way to tell this
// session apart in `pg_stat_activity` — for an operator asking "is the listener actually connected",
// and for tests asserting there is EXACTLY ONE of it (a second would mean someone re-introduced the
// memoised hidden client on top of this one).
//
// The channel semantics live in datasets/connector-listener.ts, which owns the supervisor; only the
// CLIENT is built here, so `closeConnection()` can close it. The two hooks are wired through the
// mutable `listenHandlers` below rather than imported directly, because importing the listener from
// the DB client would be a cycle — and because of the postgres-js detail documented on it.
export const listenClient = postgres(config.database.listenUrl, {
  ...resilientOptions,
  // Two DECLARATION gaps in postgres-js's shipped .d.ts, asserted away in one contained spread so
  // that nothing else in this options object loses its type-checking. Both values are what
  // postgres-js passes to its OWN hidden listen client (index.js:150-165), so they are the
  // supported, exercised shape — the types just do not say so:
  //   • `onnotify` is absent entirely from BaseOptions (which declares `onclose` but not this),
  //     though parseOptions carries it (index.js:492) and NotificationResponse dispatches it
  //     (connection.js:828).
  //   • `idle_timeout` is typed `number | undefined` while `max_lifetime` is `number | null`; only
  //     `null` disables the reaper, and `undefined` would fall back to the 20s default and close
  //     this connection between NOTIFYs. Must come AFTER `...resilientOptions`, which sets 20.
  ...({
    onnotify: (channel: string, payload: string) => listenHandlers.onNotify?.(channel, payload),
    idle_timeout: null,
  } as Record<never, never>),
  max: 1,
  max_lifetime: null,
  fetch_types: false,
  connection: { application_name: 'cp-listen' },
  onclose: () => listenHandlers.onClose?.(),
});

/**
 * Supervisor hooks for `listenClient`, set by datasets/connector-listener.ts at boot.
 *
 * WHY AN INDIRECTION AND NOT `listenClient.options.onnotify = fn` LATER: postgres-js DESTRUCTURES
 * `onnotify` out of the options when it CONSTRUCTS each Connection (connection.js:52-70), and it
 * constructs them eagerly inside `postgres()` (index.js:65). A later assignment to `.options` is
 * therefore read by nobody — it would silently never fire, which is precisely the class of failure
 * this workstream exists to remove. `onclose` happens to be read at call time (index.js:425), but
 * both go through the same registry so neither depends on that asymmetry.
 */
export const listenHandlers: {
  onNotify?: (channel: string, payload: string) => void;
  onClose?: () => void;
} = {};

// Phase D (RLS): `db` is a Proxy over the pool drizzle. During an authenticated request
// (withTenantDb established an AsyncLocalStorage context), plain statements run on the
// request's RESERVED connection — which has `app.current_tenant` set — so Postgres RLS scopes
// them. Outside a request (seed / migrations / schedulers / unauthenticated paths) there is no
// context and everything falls back to the pool. The 56 `import { db }` call sites are untouched.
//
// Transactions are special-cased: a reserved postgres-js connection has no `.begin()`, so a
// `db.transaction()` inside a request runs on the DEDICATED `txClient` pool (NOT the reserved-conn
// `queryClient` pool — see the deadlock note above) with `SET LOCAL app.current_tenant` (via
// set_config(...,true) — transaction-scoped, auto-clears at COMMIT), preserving drizzle's native
// nested-savepoint path (used by llm-broker / vote-service).
export const db: Db = new Proxy(poolDb, {
  get(target, prop, receiver) {
    const ctx = currentDbContext();
    // A SYSTEM (runAsSystem) context carries no tenant GUC — its transactions run natively
    // on the owner pool (ctx.boundDb = ownerDb) with NO `SET LOCAL`. Only a per-request TENANT
    // context gets the GUC-injecting transaction wrapper below.
    if (prop === 'transaction' && ctx && !ctx.system) {
      const tenantId = ctx.tenantId;
      const txFn = ((fn: Parameters<Db['transaction']>[0], cfg?: unknown) =>
        txPoolDb.transaction(async (tx) => {
          if (ctx.enforceRuntimeRole) await tx.execute(sql.raw('SET LOCAL ROLE cp_app'));
          await tx.execute(
            sql`select set_config('app.current_tenant', ${tenantId}, true)`,
          );
          return fn(tx as never);
        }, cfg as never)) as Db['transaction'];
      return txFn;
    }
    const active = (ctx?.boundDb as Db | undefined) ?? target;
    const value = Reflect.get(active, prop, active);
    return typeof value === 'function' ? value.bind(active) : value;
  },
}) as Db;

/**
 * Run `fn` with a request-scoped DB connection bound to `tenantId` (sets `app.current_tenant`).
 * `tenantId === null` (health / login / unauthenticated) runs on the pool with no GUC. The reserved
 * connection is ALWAYS reset (postgres-js `release()` does NOT reset session state — a leftover GUC
 * would bleed to the next request on that physical connection) and released in `finally`.
 */
export async function withTenantDb<T>(
  tenantId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return withTenantDbInternal(tenantId, fn, false);
}

/** Test boundary for route-level RLS regressions. Production gets cp_app from DATABASE_URL; local
 * integration tests use an owner DSN, so this explicitly SET ROLEs both the reserved request
 * connection and transaction-pool connections for the callback. */
export async function withTenantDbAsRuntimeRoleForTests<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withTenantDbInternal(tenantId, fn, true);
}

async function withTenantDbInternal<T>(
  tenantId: string | null,
  fn: () => Promise<T>,
  enforceRuntimeRole: boolean,
): Promise<T> {
  if (!tenantId) return fn();
  const reserved = await queryClient.reserve();
  try {
    await reserved.unsafe(
      "select set_config('app.current_tenant', $1, false)",
      [tenantId],
    );
    if (enforceRuntimeRole) await reserved.unsafe('SET ROLE cp_app');
    // A reserve()d connection lacks `.options` (and `.begin`/`.savepoint`); drizzle's postgres-js
    // driver reads `.options.parsers`, so lend it the pool's (already date-transparent) options.
    // Transactions are routed to poolDb by the Proxy, so the missing `.begin` here is fine.
    (reserved as unknown as { options: unknown }).options =
      (queryClient as unknown as { options: unknown }).options;
    const ctx: RequestDbContext = {
      tenantId,
      reserved,
      boundDb: drizzle(reserved as never, { schema }),
      enforceRuntimeRole,
    };
    return await runWithContext(ctx, fn);
  } finally {
    try {
      if (enforceRuntimeRole) await reserved.unsafe('RESET ROLE');
      await reserved.unsafe("select set_config('app.current_tenant', '', false)");
    } catch {
      /* connection already dead; release drops it */
    }
    reserved.release();
  }
}

/**
 * Like `withTenantDb` but WITHOUT reserving a connection — establishes a tenant ALS context whose
 * `boundDb` is the pool. Use this for work that runs ENTIRELY inside `db.transaction(...)`: the Proxy's
 * transaction path issues `SET LOCAL app.current_tenant` on the pool connection (transaction-scoped),
 * so RLS is enforced without holding a reserved connection for the operation's whole (possibly slow)
 * duration. The run pump's broker metering uses this — it must not pin a connection across the LLM call.
 * Plain (non-transaction) statements under this context run on the pool with NO GUC, so only use it for
 * transaction-only work. `tenantId === null` runs `fn` with no context.
 */
export async function withTenantTx<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  if (!tenantId) return fn();
  const ctx: RequestDbContext = { tenantId, boundDb: poolDb };
  return runWithContext(ctx, fn);
}

/**
 * ONE transaction under `tenantId`'s RLS scope (`SET LOCAL app.current_tenant`), callable from ANY
 * context — a request bound to another tenant (super_admin acting on a workspace), a request with
 * no tenant, or a SYSTEM scope. It is the tenant-scoped alternative to
 * `runAsSystem('tenant-parameterised', () => db.transaction(…))`: the database, not the caller's
 * WHERE clause, confines every statement in `fn` to `tenantId`'s rows of the RLS-policed tables.
 *
 * Reserves NOTHING (the transaction pool's per-transaction connection only), so it is safe inside
 * a request that already holds its reserved connection — a nested `withTenantDb` would take a
 * SECOND reserved slot from the same pool, which is how concurrent requests wedge it. Inherits the
 * outer context's test-only `enforceRuntimeRole`, so route-level RLS tests still run `fn` as cp_app.
 */
export async function withTenantTransaction<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!tenantId) throw new Error('withTenantTransaction: a tenant id is required');
  const outer = currentDbContext();
  const ctx: RequestDbContext = {
    tenantId,
    boundDb: poolDb,
    enforceRuntimeRole: outer?.enforceRuntimeRole === true,
  };
  return runWithContext(ctx, () => db.transaction(fn));
}

/**
 * Re-point the request's `app.current_tenant` to the AUTHORITATIVE effective tenant once the guards
 * have resolved it (path tenant / super_admin scope-switch may differ from the bare claim that
 * withTenantDb pre-set). No-op outside a request context.
 */
export async function refreshTenantGuc(tenantId: string): Promise<void> {
  const ctx = currentDbContext();
  // No-op outside a request, in a SYSTEM context (no reserved conn / no tenant GUC), or when the
  // tenant is already current.
  if (!ctx || ctx.system || !ctx.reserved || ctx.tenantId === tenantId) return;
  await ctx.reserved.unsafe(
    "select set_config('app.current_tenant', $1, false)",
    [tenantId],
  );
  ctx.tenantId = tenantId;
}

/**
 * Run `fn` as a SYSTEM (owner) operation: plain statements + transactions bind the owner pool
 * (`ownerDb`), which BYPASSES RLS, and NO `app.current_tenant` GUC is set. This is the escape-hatch
 * for genuine cross-tenant work that a single per-request tenant scope cannot express:
 *   • the marketplace cycle scheduler (advances every tenant's challenges/solutions in a week),
 *   • the nightly audit export (archives all tenants' audit_log),
 *   • the boot/CLI seed (creates the tenants/users themselves, plus global-scope catalogue rows),
 *   • super_admin cross-tenant platform reads.
 * Today owner === the runtime role, so this is behaviourally identical to running on the pool; once
 * D.1.2 flips the runtime to the non-owner `cp_app` role, runAsSystem is how these paths keep working.
 * NESTING: a `withTenantDb` inside runAsSystem (or vice-versa) simply re-binds the context for its
 * scope and restores the outer one on return (AsyncLocalStorage semantics).
 *
 * ⛔ THE `reason` ARGUMENT IS NOT DECORATION. An RLS bypass whose justification lives only in the
 * reviewer's head is a bypass nobody can audit: before this argument existed there were ~60 of them
 * in the tree, indistinguishable from each other, and the only record of WHY each was safe was
 * convention. Naming the reason makes the safety argument reviewable at the call site and makes the
 * bypass greppable (`rls_bypass` in the logs) during an incident. Pick the reason that describes
 * WHY THE BYPASS IS SAFE, not what the query happens to do:
 *
 *   • `boot-seed`            — boot/CLI seed. Creates the tenants/users themselves; there is no
 *                              request and no tenant to scope to. Safe because nothing is serving.
 *   • `scheduler-tick`       — a periodic cross-tenant tick (cycle / audit-export / translation /
 *                              budget). Cross-tenant IS the job; there is no requesting tenant.
 *   • `platform-admin`       — super_admin cross-tenant read/write. Safe ONLY because an upstream
 *                              `requireSuperAdmin` has already run. If that guard is ever removed
 *                              from the route, this bypass becomes the vulnerability.
 *   • `credential-auth`      — a presented secret (API key, webhook signature, session token) IS
 *                              the authorization. The lookup that resolves the secret to a tenant
 *                              cannot itself be tenant-scoped, because no tenant is known yet.
 *   • `non-rls-table`        — the target table is outside RLS altogether (e.g. `tenants`). This
 *                              bypasses nothing; it exists so the owner pool is used consistently.
 *   • `tenant-parameterised` — a helper that trusts a `tenantId`/`userId` its caller passed in, and
 *                              filters on it explicitly in SQL. This is the HONEST label for
 *                              "safe only because the caller passed the right id": the database
 *                              enforces nothing here, so the real gate lives somewhere upstream in
 *                              a different file. ⚠️ THIS IS THE BUCKET TO SHRINK. Every entry is a
 *                              place where a future caller passing an attacker-influenced id turns
 *                              a correct helper into a cross-tenant read or write, with no error.
 *                              Prefer converting these to a tenant-scoped context (`withTenantDb`)
 *                              over adding new ones; when you must add one, the caller-side gate is
 *                              part of the change, not a follow-up.
 */
export type SystemReason =
  | 'boot-seed'            // boot/CLI seed: creates tenants/users themselves; no request exists
  | 'scheduler-tick'       // periodic cross-tenant tick (cycle / audit-export / translation / budget)
  | 'platform-admin'       // super_admin cross-tenant read/write, behind requireSuperAdmin
  | 'credential-auth'      // a presented secret IS the authz; no tenant context can exist yet
  | 'non-rls-table'        // target table is outside RLS (e.g. `tenants`) — bypasses nothing
  | 'tenant-parameterised' // helper trusting a caller-passed tenantId/userId; gate lives upstream
  // Reads ACROSS tenants deliberately, but only an AGGREGATE crosses back to the caller — no row,
  // field or id from another tenant is returned. Distinct from `platform-admin` because the gate is
  // NOT `requireSuperAdmin`: labelling such a site `platform-admin` would overstate its gate, which
  // is the precise failure this union exists to prevent.
  | 'cross-tenant-aggregate'

export async function runAsSystem<T>(reason: SystemReason, fn: () => Promise<T>): Promise<T> {
  // One greppable line per bypass. `outer_tenant` is the tenant scope this bypass is escaping from
  // (empty at boot / on a scheduler tick / when already inside another SYSTEM scope) — during an
  // incident that is the field that says whose request opened the hole.
  const outer = currentDbContext();
  log.debug('rls_bypass', {
    reason,
    outer_tenant: outer?.tenantId || null,
    nested: outer?.system === true,
  });
  const ctx: RequestDbContext = { tenantId: '', boundDb: ownerDb, system: true };
  return runWithContext(ctx, fn);
}

/**
 * Run a periodic SYSTEM tick exactly once across all replicas.
 *
 * Each boot scheduler (cycle / audit-export / translation / budget) arms its own in-process timer
 * in EVERY pod, so without a guard a daily cycle tick would double-advance phases, the audit export
 * would write twice, and the translation drainer would double-spend LLM budget.
 *
 * WHY THIS IS NOT AN ADVISORY LOCK ANY MORE. It used to take a SESSION-level
 * `pg_try_advisory_lock` on a reserved owner connection. That silently never worked in prod: the
 * owner pool points at `pgbouncer:6432`, the TRANSACTION pooler (the session pooler is the separate
 * `pgbouncer-session` host, used only by `cp_app`). Under transaction pooling a server connection
 * belongs to a client only for the length of a transaction, so two single-statement
 * `pg_try_advisory_lock` calls from two different PODS can land on the SAME server connection — and
 * Postgres guarantees that a session already holding an advisory lock re-acquires it successfully.
 * The second pod got `true` and ran the tick too. The audit trail shows the result: `audit.export`
 * wrote two rows ~200 ms apart on four separate nights. The paired unlock had the mirror problem —
 * it landed on some other connection, returned false, and leaked the lock.
 *
 * The claim below depends on no connection identity whatsoever. `ON CONFLICT DO UPDATE … WHERE`
 * evaluates its predicate while holding the row lock, so exactly one caller can observe a stale
 * `last_run_at` and win — the same self-serializing shape the sandbox-watchdog already relies on.
 *
 * `minIntervalMs` is the debounce window: a tick is claimable only if the last claim is older than
 * this. Set it BELOW the scheduler's period (so the next legitimate tick is never suppressed) and
 * comfortably above the spread between replicas firing the same tick (milliseconds). The claim is
 * recorded when the tick STARTS, deliberately: a crashed pod then blocks the tick for at most one
 * window rather than forever, which is the failure direction to prefer for idempotent work.
 *
 * IT ALSO NO LONGER RESERVES A CONNECTION, which was a second, independent bug. The old version
 * held one reserved connection from the owner pool (`max: 4`) for the WHOLE tick — and there are
 * exactly FOUR schedulers, all of which fire a boot tick at startup. Four simultaneous ticks
 * reserved all four connections, and then the work inside them could never get a connection of its
 * own: prod logged `translation drain exceeded 600000ms` at boot with ZERO pending jobs, which is
 * that deadlock, not a slow translation. The claim below is one statement on the pool and holds
 * nothing while `fn` runs.
 *
 * ⚠️ `fn` ITSELF MUST HOLD AT MOST ONE OWNER CONNECTION AT A TIME. The cycle tick runs entirely in ONE
 * transaction (its `FOR SHARE` on the cadence policy row AND all its work — cycle-service
 * `tickCycles`); it used to hold the lock on one connection while doing the work on a second, which
 * is two of the four slots for one tick.
 *
 * Returns `undefined` when another pod owns this tick.
 */
export async function runSystemTick<T>(
  key: string,
  minIntervalMs: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const claimedBy = process.env.HOSTNAME ?? 'unknown';
  const won = await ownerClient`
    INSERT INTO scheduler_ticks (key, last_run_at, claimed_by, updated_at)
         VALUES (${key}, now(), ${claimedBy}, now())
    ON CONFLICT (key) DO UPDATE
            SET last_run_at = now(), claimed_by = ${claimedBy}, updated_at = now()
          WHERE scheduler_ticks.last_run_at < now() - ${`${Math.round(minIntervalMs / 1000)} seconds`}::interval
      RETURNING key`;
  if (won.length === 0) return undefined; // another pod owns this tick — skip
  return runAsSystem('scheduler-tick', fn);
}

/** The health/readiness probe's OWN connection — deliberately NOT `queryClient`.
 *
 * ⛔ `/health` is the READINESS probe (server.ts). ⚠️ CORRECTED 2026-09-04 — this line used to
 * read "`/health` is both the readiness AND the liveness probe", which was true until gitops
 * #3372 moved liveness AND startup onto the shallow `/health/live`. `/health` is now the only
 * probe that touches this client, and a slow one DEPOOLS a replica instead of killing it. It
 * used to share
 * `queryClient`, whose `DB_POOL_MAX` slots are RESERVED for the whole of each request. That was
 * survivable while Gate 2 ran before `withTenantDb`; it stopped being survivable when the licence
 * check moved inside the guards, because an unlicensed request now holds a reserved slot for the
 * duration of an HTTP introspect (bounded at LICENSE_ADMIN_TIMEOUT_MS = 10s, and failures are not
 * cached, so a hung licences service is re-dialled on EVERY request). Measured A/B on one machine
 * with the licences service hung and an 8-request burst: `/health` answered in 0.015s before, and
 * 9.05s after. Six concurrent requests are enough to exceed the readiness probe's
 * `timeoutSeconds: 5` (gitops clusters/strato/services/commonpractice/deployment.yaml — NOT the
 * k8s default of 1s, which this deployment overrides), so a licences outage would turn "every
 * tenant request 402s" into "every replica depooled at once". Still a full outage, which is why
 * `max: 1` stays. Before gitops #3372 it was worse still — "every replica CrashLoops", strictly
 * worse than the bug being fixed, and unrollable.
 *
 * `max: 1` because a probe needs exactly one connection and must never compete for it. This also
 * retires the same hazard class the repo has already been burned by twice (the SSE 500-cascade,
 * sse-stream.ts:33-38; the four-scheduler boot deadlock, runSystemTick below): slow non-DB work
 * performed while holding a reserved connection. */
const probeClient = postgres(config.database.url, {
  ...resilientOptions,
  max: 1,
  connection: { application_name: 'cp-probe' },
});

export async function validateConnection(): Promise<void> {
  await probeClient`SELECT 1`;
}

/** The `/metrics` scheduler-freshness read's OWN connection. `max: 1` is the blast radius.
 *
 * ⛔ IT USED TO RUN ON `db` (i.e. `queryClient`, DB_POOL_MAX = 6) BOUNDED ONLY BY A JS TIMEOUT, AND
 * THAT MADE `/metrics` A FEEDBACK LOOP ON THE POOL EXHAUSTION IT EXISTS TO OBSERVE. `Promise.race`
 * abandons the PROMISE; it does not cancel the QUERY. postgres-js has no AbortSignal, the scrape
 * returned in 2s, and the connection stayed checked out for as long as the server kept running the
 * statement. Reproduced against a real `scheduler_ticks` held under ACCESS EXCLUSIVE from a second
 * session, with the exact prod `DB_POOL_MAX = 6`: six consecutive scrapes parked all six request
 * connections (`cp-query` non-idle = 1,2,3,4,5,6) and an ordinary `SELECT 1` through `db` then had
 * no connection left to take — still unresolved after 5s, and postgres-js QUEUES rather than
 * failing fast, so ordinary tenant requests hang indefinitely. Six minutes of any >2s stall is
 * enough. `connect_timeout` never applies: on `pgbouncer-session` a saturated pool HOLDS an
 * already-connected client. tests/scheduler-freshness.test.ts asserts both halves.
 *
 * `max: 1` caps that at ONE connection by construction, and it is a connection nothing else in the
 * process can ever want — this is a once-per-60s read. NOT `probeClient`: that one serves
 * `/health`, the READINESS probe (`timeoutSeconds: 5`), and lending it out for up to the read
 * timeout would depool every replica at once. ⚠️ CORRECTED 2026-09-04 — this used to say "the
 * LIVENESS probe on a 1s timeout", which was wrong on BOTH counts even before gitops #3372:
 * liveness ran `timeoutSeconds: 10`, and the 1s belonged to the startupProbe on `/ready`. Since
 * #3372, liveness and startup are on `/health/live`, which does not touch this client at all.
 *
 * ⛔ AND THE HARD BOUND IS `SET LOCAL statement_timeout`, NOT `connection: { statement_timeout }`.
 * The startup-parameter form is the obvious shape and it is a TRAP: both prod poolers carry
 * `ignore_startup_parameters = extra_float_digits,statement_timeout,…` (gitops clusters/strato/
 * services/pgbouncer{,-session}/pgbouncer.ini), and "ignore" means pgbouncer ACCEPTS the parameter
 * and DROPS it. Verified against the pinned pooler image (edoburu/pgbouncer:v1.25.1-p0) in BOTH
 * pool modes with this repo's exact config: `SHOW statement_timeout` returns `0` and
 * `SELECT pg_sleep(10)` runs the full ten seconds. On a DIRECT connection — dev, CI, and every test
 * in this repo — the same option works perfectly and kills the statement at the bound. So the
 * startup-parameter form would have been green everywhere it could be tested and inert in the only
 * place it matters. `SET LOCAL` inside an explicit transaction is a plain SQL statement, is
 * untouched by `ignore_startup_parameters`, and was verified to cancel at the bound through the
 * session pooler, the transaction pooler, and directly. host/scheduler-freshness.ts issues it.
 *
 * `fetch_types: false` for the same reason `listenClient` sets it: postgres-js otherwise runs a
 * catalogue introspection round-trip on FIRST use, which happens OUTSIDE the transaction and would
 * therefore be the one query on this client that no `SET LOCAL` bounds. This client runs exactly
 * one hand-written statement whose columns (text, numeric) the built-in parsers already handle.
 *
 * ⛔ BUDGET. pgbouncer's `pool_size` is per (database, user) — there is no per-`application_name`
 * entry to add, so nothing in gitops NAMES this client. What it does change is the arithmetic:
 * `pgbouncer-session` `commonpractice` is `pool_size = 50`, sized in that file as exactly
 * `5 pods x 10` with ZERO headroom, where 10 = poolMax 6 + txPoolMax 4. That 10 has been wrong
 * since `cp-probe` was added (11), and this client makes it 12 → 60 at a rolling deploy against a
 * ceiling of 50 (+6 reserve). RAISING IT IS A GITOPS CHANGE AND IS DELIBERATELY NOT MADE HERE; see
 * the handoff. tests/pool-budget.test.ts still asserts the env-var pair only, which is why the two
 * `max: 1` clients slipped past it.
 *
 * Lifecycle: module-level, exactly like the other five clients, so it is constructed once per
 * process and ended by `closeConnection()`. postgres-js does NOT dial on construction — it connects
 * lazily on the first query — so a test run that never scrapes opens nothing. */
export const metricsClient = postgres(config.database.url, {
  ...resilientOptions,
  max: 1,
  fetch_types: false,
  connection: { application_name: 'cp-metrics' },
});

export async function closeConnection(): Promise<void> {
  // Disarm the LISTEN supervisor FIRST. `end()` closes the connection, which fires `onclose`, which
  // the supervisor answers by re-registering — a shutdown that reopens the very connection it is
  // shutting down. Done here rather than by importing datasets/connector-listener (which imports
  // this module), so `closeConnection` is correct on its own; callers that want the pending retry
  // timer cancelled too should call `stopConnectorListener()`.
  listenHandlers.onNotify = undefined;
  listenHandlers.onClose = undefined;
  await Promise.all([
    probeClient.end({ timeout: 5 }),
    metricsClient.end({ timeout: 5 }),
    queryClient.end({ timeout: 5 }),
    txClient.end({ timeout: 5 }),
    ownerClient.end({ timeout: 5 }),
    // EXPLICIT, and it has to be: while LISTEN rode `queryClient.listen()`, the hidden listen client
    // hung off `queryClient` and postgres-js closed it for us (index.js:374 ends `listen.sql`
    // alongside the pool's connections). `listenClient` is top-level, so nothing closes it but us —
    // omit this line and shutdown hangs on a connection nobody is waiting for.
    listenClient.end({ timeout: 5 }),
  ]);
}

export {
  users,
  userRoleEnum,
  tenants,
  tenantStatusEnum,
  identityProviders,
  mcpApiKeys,
  usageEvents,
  signupApprovals,
  emailDomainTenants,
  freeEmailProviders,
  buildingBlocks,
  blockVersions,
  blockTemplates,
  flowTemplates,
  blockCategoryEnum,
  blockStatusEnum,
  blockLanguageEnum,
  flows,
  flowStatusEnum,
  flowRuns,
  flowRunStatusEnum,
  flowRunEvents,
  usageCounters,
  sandboxes,
  sandboxStatusEnum,
  challenges,
  challengeStatusEnum,
  challengeDatasets,
  challengeEntities,
  informationRequests,
  informationRequestRows,
  solutions,
  solutionStatusEnum,
  votes,
  voteTargetTypeEnum,
  comments,
  weeklyWinners,
  marketplaceCycles,
  tenantCycleCadence,
  tenantCycleCadenceChanges,
  marketplaceCyclePhaseEnum,
  policies,
  policyChanges,
  pipelineItems,
  pipelineStageEnum,
  pipelineReviews,
  auditLog,
  auditExports,
  auditExportStatusEnum,
  auditExportTriggerEnum,
  llmProviderEnum,
  chatRoleEnum,
  snapshotSourceEnum,
  tenantLlmSettings,
  agentSessions,
  mcpPrompts,
  mcpPromptVersions,
  chatSessions,
  chatMessages,
  agentToolResults,
  flowSnapshots,
  contentTranslations,
  translationJobs,
  datasets,
  datasetRows,
  datasetSourceTypeEnum,
  datasetStatusEnum,
  blockTests,
  blockTestResults,
  assertModeEnum,
  blockTestStatusEnum,
  ontologyEntities,
  ontologyAttributes,
  ontologyRelations,
  ontologyScopeEnum,
  datasetMappings,
  ontologyEntitySamples,
  mappingSourceEnum,
  deliveryTargets,
  solutionDeliveries,
  deliveryTargetKindEnum,
  deliveryStatusEnum,
  tenantLlmBudgets,
  notifications,
  notificationReads,
  schedulerTicks,
  memberEntitlements,
  meteringOutbox,
};
export type * from './schema';
