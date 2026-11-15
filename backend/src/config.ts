// src/config.ts
// Nested env config (mirrors fr/backend/src/config.ts shape, trimmed to what
// Common Practice needs in Session 0). Bun auto-loads .env.
//
// Importing the logger here is safe in ONE direction only: `host/logger.ts` reads `LOG_LEVEL`
// straight from `process.env` precisely so it never imports this module back. Keep it that way —
// a cycle here makes the failure mode "the logger cannot log why the config failed".
import { readFileSync } from 'node:fs';
import { log } from './host/logger';

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) ? n : fallback;
}

const keycloakUrl = (process.env.KEYCLOAK_URL || '').replace(/\/+$/, '');
// Realm-per-app P7 ("realm portal = staff only"): CP's own realm is the default; production sets
// KEYCLOAK_REALM / KEYCLOAK_ISSUER explicitly (gitops services/commonpractice/deployment.yaml).
const keycloakRealm = process.env.KEYCLOAK_REALM || 'commonpractice';
const keycloakIssuer = (process.env.KEYCLOAK_ISSUER || `${keycloakUrl}/realms/${keycloakRealm}`).replace(
  /\/+$/,
  '',
);
// Realm-per-app P0 (~/.claude/plans/program/realm-per-app-design.md): the realm CP's USERS live in —
// the realm the admin API creates / looks up / emails CP users in, the realm CP's tenant IdPs are
// brokered through, and the `subject_realm` CP states to licences. Defaults to KEYCLOAK_REALM, so
// nothing moves until gitops sets it; the CP cutover flips it in exactly this one place.
const keycloakUserRealm = (process.env.KEYCLOAK_USER_REALM || '').trim() || keycloakRealm;

/**
 * The realm named by a Keycloak issuer URL (`https://host/realms/<realm>` → `<realm>`), or undefined
 * when the URL carries no `/realms/<name>` suffix.
 */
export function realmOfIssuer(issuer: string): string | undefined {
  const m = /\/realms\/([^/]+)\/?$/.exec(issuer);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

/** `issuer` with its realm segment swapped for `realm` (same public host). */
function issuerForRealm(issuer: string, realm: string): string {
  if (realmOfIssuer(issuer) === realm) return issuer;
  return issuer.replace(/\/realms\/[^/]+\/?$/, `/realms/${encodeURIComponent(realm)}`);
}

/**
 * KEYCLOAK_TRUSTED_ISSUERS — comma list of FULL issuer URLs whose tokens CP verifies (each against its
 * own realm JWKS, with `iss` pinned to that exact value). Default: `[KEYCLOAK_ISSUER]`, i.e. exactly
 * today's single-issuer behaviour. Read live so tests (and a future hot-reload) see the current env.
 * Trailing slashes are stripped — Keycloak's `iss` never carries one, and a stray slash in an env
 * value must not silently 401 a whole realm.
 */
export function keycloakTrustedIssuers(): string[] {
  return parseList(process.env.KEYCLOAK_TRUSTED_ISSUERS, [keycloakIssuer]).map((s) =>
    s.replace(/\/+$/, ''),
  );
}

/**
 * KEYCLOAK_SERVICE_ONLY_REALMS — realms whose tokens are accepted ONLY on the S2S doors (each of which
 * also pins azp + aud + role + its own issuer). Default `secure-apps`. ⛔ secure-apps is NOT an SA-only
 * realm: it holds human accounts (billing-dashboard users with license-admin), so a secure-apps token
 * must never be honoured as a CP user session even once it is in the trusted list for P1.
 */
export function keycloakServiceOnlyRealms(): string[] {
  return parseList(process.env.KEYCLOAK_SERVICE_ONLY_REALMS, ['secure-apps']);
}

/**
 * The runner's per-node budget, and the HOST's silence watchdog that supervises it.
 *
 * ⛔ THE ORDERING BETWEEN THESE TWO IS LOAD-BEARING, and it used to be backwards.
 * `idleMs` armed a flat 10 000 while `maxNodeMs` was 15 000, i.e. the host gave up 5 s BEFORE the
 * runner's own per-node timeout could fire. Two consequences, both bad:
 *
 *   1. A node that legitimately ran for 10-15 s was killed by the host mid-execution. On abort the
 *      k8s channel's `lines` iterator ends NORMALLY (tearDown kills `kubectl attach`, stdout hits
 *      EOF), so `spawnAndPump`'s catch never runs, no `node_error` is pushed, and the user got a
 *      bare `run failed · 0ms · $0.00` with no cause — while still being billed for the LLM call.
 *   2. `exec/flow-executor.ts`'s own node-timeout racer, which emits a proper
 *      `node_error{kind:'timeout'}` naming the node, became DEAD CODE in production: the host
 *      always won the race. The one component that could explain the failure could never speak.
 *
 * So the ladder is DERIVED, not three independently-configured numbers. Each rung must exceed the
 * one it supervises, with slack for the inner one to serialise and flush its own timeout event:
 *
 *     maxNodeMs  <  idleMs  <  maxRunMs
 *     (runner's own    (host's silence   (host's wall-clock kill; also drives the run pod's
 *      per-node cap)    watchdog)         activeDeadlineSeconds in run-backend.ts)
 *
 * ⛔ DERIVING ONLY THE MIDDLE RUNG IS NOT ENOUGH — that was the first version of this change and
 * it was WRONG. Chaining `idleMs` to `maxNodeMs` while leaving `maxRunMs` independent means a
 * single env var re-breaks the invariant: `RUN_MAX_NODE_MS=300000` gave node=300000, idle=305000,
 * maxRunMs=30000, i.e. the outermost kill fires FIRST and the watchdog is disabled again — the
 * very failure this file exists to prevent, and the ordering test in tests/runs.test.ts went red
 * on it. All three rungs are now floored against the one below.
 *
 * `Math.max` is a FLOOR, not a clamp on intent: a deliberately larger RUN_IDLE_MS or RUN_MAX_MS is
 * honoured exactly as given. It only ever raises a value that would otherwise invert the ordering,
 * and when it does it says so at startup (`logRunBudgetOverrides`) rather than silently
 * contradicting the operator — an override nobody is told about is how these three drifted apart
 * in the first place.
 *
 * NOTE the watchdog is about SILENCE, not about slow LLM calls. A brokered call may legitimately
 * take up to `llm.callTimeoutMs` (120 s) while the pump is blocked awaiting it; `onLine` PAUSES
 * the clock across that await, so the host does not count provider latency as silence.
 */
const RUN_IDLE_SLACK_MS = 5000;
// Floor the innermost rung too: `RUN_MAX_NODE_MS=-5000` used to produce `idleMs = 0`, i.e.
// `setTimeout(abort, 0)` on the first frame — every run killed instantly. Nonsense input should
// degrade to the default posture, not to a total outage.
const runMaxNodeMs = Math.max(1000, int(process.env.RUN_MAX_NODE_MS, 15000));
const runIdleMs = Math.max(
  int(process.env.RUN_IDLE_MS, runMaxNodeMs + RUN_IDLE_SLACK_MS),
  runMaxNodeMs + 1000,
);
const runMaxRunMs = Math.max(int(process.env.RUN_MAX_MS, 30000), runIdleMs + 1000);

/** Say so when an explicitly-set budget had to be raised to keep the ladder ordered. Called once
 *  from server.ts at boot. Silence here means every env value was honoured verbatim. */
export function logRunBudgetOverrides(): void {
  const asked = {
    maxNodeMs: int(process.env.RUN_MAX_NODE_MS, runMaxNodeMs),
    idleMs: int(process.env.RUN_IDLE_MS, runIdleMs),
    maxRunMs: int(process.env.RUN_MAX_MS, runMaxRunMs),
  };
  const got = { maxNodeMs: runMaxNodeMs, idleMs: runIdleMs, maxRunMs: runMaxRunMs };
  for (const k of ['maxNodeMs', 'idleMs', 'maxRunMs'] as const) {
    if (asked[k] !== got[k]) {
      log.warn('run_budget_raised', {
        component: 'config',
        budget: `run.${k}`,
        askedMs: asked[k],
        appliedMs: got[k],
        maxNodeMs: got.maxNodeMs,
        idleMs: got.idleMs,
        maxRunMs: got.maxRunMs,
        reason:
          'raised to keep the run budgets ordered (maxNodeMs < idleMs < maxRunMs). A watchdog ' +
          'that fires before the budget it supervises cannot report what it killed.',
      });
    }
  }
}

/** The seeded demo/primary tenant id. Fixed so dev-bypass and tests resolve to the same tenant.
 *  Seed creates the demo tenant with this id; AUTH_BYPASS defaults to it. */
/** Default `LICENCE_BUNDLE_PLANS`: an ORDERED plan-code preference (see `license.bundlePlans`). */
export const DEFAULT_LICENCE_BUNDLE_PLANS: readonly string[] = ['tenant-pooled', 'standard'];

/**
 * `LICENCE_BUNDLE_PLANS` → the ordered, de-duplicated plan list CP sends on a licences bundle
 * ensure. Unset, blank or only commas → the default (licences 422s an empty or duplicated list, so
 * neither ever reaches the wire). Order is kept: licences takes the FIRST that exists per app.
 */
export function parseLicenceBundlePlans(raw: string | undefined): string[] {
  const codes = [...new Set(parseList(raw, []))];
  return codes.length > 0 ? codes : [...DEFAULT_LICENCE_BUNDLE_PLANS];
}

export const DEMO_TENANT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * THE ONE reading of AUTH_BYPASS. Two independent copies of this expression used to exist —
 * `middleware/auth.ts`'s own `process.env.AUTH_BYPASS === 'true'` (which decides whether an
 * anonymous request becomes a synthetic super_admin) and `config.authBypass` below (which is what
 * `validateProductionConfig` refuses to boot on). They were free to disagree, and a one-token
 * widening of the middleware's copy — `!== 'false'` — made them: production, where the var is
 * simply UNSET, would have answered every anonymous caller as super_admin in the demo tenant while
 * the prod gate still computed `false` and let the boot through. Both now call this.
 *
 * Read at CALL time by the middleware and snapshotted at boot by `config.authBypass`; that split is
 * deliberate and pre-existing (the middleware has always been live), but they can no longer differ
 * on what the flag MEANS. Exactly `'true'` — never a truthy string, never a negated compare: an
 * operator who typed `AUTH_BYPASS=1` gets a closed door, not an open one.
 */
export function authBypassEnabled(): boolean {
  return process.env.AUTH_BYPASS === 'true';
}

/**
 * The metering-outbox drain PERIOD (`config.metering.outboxIntervalMs`).
 *
 * It was a bare `METERING_OUTBOX_INTERVAL_MS = 30_000` literal in
 * `host/metering-outbox-drainer.ts` — the one knob that decides how long already-committed LLM spend
 * sits undelivered to billing, and the only way to change it was a code deploy. Every other
 * scheduler's cadence in this file is env-settable; this one was not, for no reason.
 *
 * ⛔ THE CLAMP IS NOT DEFENSIVE PADDING — IT IS A PRECONDITION ANOTHER MODULE ASKED FOR BY NAME.
 * The drainer runs under `claimTick`, whose claim window must be strictly SHORTER than the fire
 * period or one pod's early tick suppresses every other pod's legitimate drain (silently: the
 * scheduled path passes `refusal:'expected'`, so refusals log at `info` and read exactly like
 * leader election). `host/tick-locks.ts tickClaimWindowMs` derives that window, and its docblock
 * states that its "strictly below the period" property does NOT hold for `periodMs <= 0` or `NaN`,
 * ending: "⇒ A THIRD CALLER MUST CLAMP ITS OWN PERIOD." Making this configurable is what creates
 * that third caller, so the clamp ships in the same change as the knob, not after the first
 * incident. `int()` accepts "0" and "-1" verbatim — only unparseable garbage falls back to the
 * default — so without it `METERING_OUTBOX_INTERVAL_MS=0` really does reach `setTimeout(fn, 0)`:
 * an unbounded re-arm loop firing two DB queries per event-loop turn, on every replica, forever.
 *
 * ⚠️ THE FLOOR IS A FLOOR, NOT AN OPINION about how often draining is sensible. 1 s is well below
 * anything an operator would choose and exists only to keep the two properties above true; a
 * deliberate `METERING_OUTBOX_INTERVAL_MS=5000` is honoured exactly as given. Deliberately NOT
 * floored at `TICK_MIN_INTERVAL_MS.meteringOutbox` (25 s): that constant is a CEILING on the claim
 * window, and `tickClaimWindowMs` already collapses the window below any shorter period — importing
 * `host/tick-locks.ts` here to read it would also be a cycle (tick-locks reaches this module through
 * db/client).
 *
 * Exported as a pure function of its input so `tests/config-validation.test.ts` can exercise the
 * clamp without a frozen module-load-time `config` and without mutating `process.env`.
 */
export const METERING_OUTBOX_DEFAULT_INTERVAL_MS = 30_000;
export const METERING_OUTBOX_MIN_INTERVAL_MS = 1_000;

export function meteringOutboxIntervalMs(
  raw: string | undefined = process.env.METERING_OUTBOX_INTERVAL_MS,
): number {
  return Math.max(
    METERING_OUTBOX_MIN_INTERVAL_MS,
    int(raw, METERING_OUTBOX_DEFAULT_INTERVAL_MS),
  );
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number.parseInt(process.env.PORT || '8790', 10),
  host: process.env.HOST || '0.0.0.0',

  database: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://commonpractice:commonpractice@localhost:5433/commonpractice',
    // Phase 4 / D.1.1 (RLS cutover prep): the OWNER connection used for schema
    // migrations and for genuine cross-tenant SYSTEM work (runAsSystem — schedulers,
    // seed, platform cross-tenant reads). Defaults to DATABASE_URL, so today (and until
    // the D.1.2 gitops flip points DATABASE_URL at the non-owner `cp_app` role) the two
    // are identical and behaviour is unchanged. D.1.2 sets MIGRATE_DATABASE_URL to the
    // owner DSN and DATABASE_URL to the cp_app DSN, at which point RLS binds the runtime.
    migrateUrl:
      process.env.MIGRATE_DATABASE_URL ||
      process.env.DATABASE_URL ||
      'postgresql://commonpractice:commonpractice@localhost:5433/commonpractice',
    // Whether MIGRATE_DATABASE_URL was set EXPLICITLY (vs. falling back to DATABASE_URL).
    // In a post-D.1.2 prod, DATABASE_URL points at the non-owner `cp_app` role, which lacks
    // DDL — so an unset MIGRATE_DATABASE_URL would make migrations + runAsSystem run as cp_app
    // and crash at boot with a cryptic permission error. validateProductionConfig turns that
    // into a clear config failure instead. (dev/CI: the two DSNs are the owner, so unset is fine.)
    migrateUrlExplicit: !!process.env.MIGRATE_DATABASE_URL,
    // The DIRECT (non-pooler) DSN for the one PINNED LISTEN session (db/client.ts `listenClient`,
    // datasets/connector-listener.ts). A LISTEN connection is a session-lifetime registration: it
    // must not be handed to another client, recycled, or timed out, which is exactly what the
    // poolers and the server's idle reaper do to it.
    //   • DATABASE_URL points at the SESSION pooler. postgres-js does not serve LISTEN from a pool
    //     — it opens its own `max:1` client on whatever DSN it was given — so the LISTEN session
    //     was a pgbouncer client connection, permanently occupying one of `pool_size`.
    //   • Worse, the server sets `idle_session_timeout = '10min'` cluster-wide (worker4
    //     conf.d/main/91-conn-mgmt.conf, verified live). A LISTEN-only session sits idle outside a
    //     transaction, so Postgres killed it every ten minutes and every NOTIFY arriving in the
    //     kill→re-LISTEN gap was lost silently and forever. The listener now clears that GUC as a
    //     statement on its own connection (see connector-listener.ts for why not a startup param).
    // UNSET = falls back to DATABASE_URL, which is the correct behaviour everywhere the pooler does
    // not exist (dev, CI's ephemeral postgres). Deliberately NOT in validateProductionConfig: Flux's
    // image-policy bump and the gitops env merge are not atomic, and a required var turns that
    // window into a CrashLoopBackOff of the whole backend over a feature that only degrades the
    // Datasets screen. Boot warns instead (server.ts), and rollback is one env-var deletion with no
    // code deploy.
    listenUrl:
      process.env.LISTEN_DATABASE_URL ||
      process.env.DATABASE_URL ||
      'postgresql://commonpractice:commonpractice@localhost:5433/commonpractice',
    listenUrlExplicit: !!process.env.LISTEN_DATABASE_URL,
    // ---- THE COMPLETE CONNECTION BUDGET: THREE pools, TWO poolers ----
    //
    // db/client.ts builds FOUR postgres-js clients. Three of them are pools sized from here, and
    // they do NOT all land on the same pgbouncer — which is why a budget stated as one number has
    // been wrong every time it has been written down:
    //
    //   client        DSN                    pooler                     ceiling here
    //   queryClient   DATABASE_URL           pgbouncer-session (SESSION) poolMax       6
    //   txClient      DATABASE_URL           pgbouncer-session (SESSION) txPoolMax     4
    //   ownerClient   MIGRATE_DATABASE_URL   pgbouncer (TRANSACTION)     ownerPoolMax  4
    //   listenClient  LISTEN_DATABASE_URL    none — DIRECT to postgres   fixed at 1
    //
    // `poolMax` and `txPoolMax` must stay INDEPENDENT pools: a request holds a RESERVED connection
    // from `queryClient` for its whole lifetime (withTenantDb, to carry the `app.current_tenant`
    // GUC) and then asks for a second connection to run `db.transaction(...)`. Drawn from one pool
    // that is a guaranteed deadlock under concurrency; see the long note in db/client.ts.
    //
    // ⛔ pgbouncer `pool_size` is per (database, user) and SHARED BY EVERY REPLICA — it is not per
    // pod. This is a Deployment with HPA minReplicas 2 / maxReplicas 4, so every number below is
    // multiplied by the replica count. The old claim here — "their SUM must not exceed the backing
    // pool ceiling … 6+4=10 fit it exactly" — was single-pod arithmetic applied to a fleet, and
    // wrong in the direction that hides the problem.
    //
    // ⚠️ AND THE HPA REACHES 4 ROUTINELY, so 4 is the design point, not a rare burst. Its target is
    // computed against the container's CPU *request*, and those requests were right-sized down to
    // 25m backend / 20m frontend — at a 70% target that fired at ~17.5m, i.e. below idle (measured
    // 26%/70% with essentially zero traffic). The gitops change that lands with this one raises the
    // HPA target to 300% so it means "this pod is working"; budget for 4 regardless.
    //
    // SESSION pooler (pgbouncer-session, `commonpractice` pool_size):
    //     per pod  poolMax 6 + txPoolMax 4 = 10      2 replicas = 20      4 replicas = 40
    //
    // TRANSACTION pooler (pgbouncer, `commonpractice` pool_size) — the WORSE ratio, and the one
    // that has already produced a live `08P01 server conn crashed?` FATAL out of runSystemTick:
    //     per pod  ownerPoolMax 4                    2 replicas = 8       4 replicas = 16
    //     …plus ONE transient `max: 1` migration-runner client per pod at boot (db/migration-
    //     runner.ts, application_name `cp-migrate`), so a rolling deploy peaks at 4 replicas x 5.
    //     At the steady 2 replicas the old pool_size=8 sat at exactly 8/8 with zero headroom —
    //     the boot runner needed a 9th and there was none.
    //
    // ⚠️ There is NO "+1 pinned LISTEN" on either pooler any more. That connection used to inherit
    // DATABASE_URL and sit on the session pooler pinned forever (2 of 10 parked waiting for a
    // NOTIFY); it is now `listenClient` on `listenUrl`, the DIRECT DSN, counting against postgres's
    // `max_connections` and not against any `pool_size`. Session demand is 10/pod, not 11. (Leave
    // LISTEN_DATABASE_URL unset and the 11-per-pod shape is back — the fallback is safe, but it is
    // not the intended prod shape.)
    //
    // ⛔ THESE ARE ONE INVARIANT SPLIT ACROSS TWO REPOS (gitops clusters/strato/services/
    // pgbouncer-session/pgbouncer.ini and .../pgbouncer/pgbouncer.ini). Raising a value here alone
    // just moves the queue to the other side, where it surfaces as `pooler error: server conn
    // crashed?` instead of as backpressure. All three are pinned explicitly in the Deployment env
    // so the arithmetic is reviewable in whichever diff changes either side. The gitops repo is NOT
    // in this repo's CI, so nothing mechanically enforces the pairing — tests/pool-budget.test.ts
    // is a tripwire on THIS side only, and says so in its own comment.
    poolMax: int(process.env.DB_POOL_MAX, 6),
    txPoolMax: int(process.env.DB_TX_POOL_MAX, 4),
    // The owner pool (`ownerClient`: startup migrations + every `runAsSystem` / `runSystemTick`
    // scheduler). Was a bare `max: 4` LITERAL in db/client.ts with no env var at all, so the one
    // pool on the more oversubscribed pooler was the only one that could not be tuned without a
    // code deploy. Default 4 == that literal, so introducing this changes no behaviour anywhere.
    // ⛔ CLAMPED TO >= 1. `int()` accepts "0" and "-1" verbatim, and `postgres(url, { max: 0 })`
    // NEVER RESOLVES AND NEVER THROWS — a plain `SELECT 1` hangs with no error and no timeout. That
    // would wedge every `runAsSystem` / `runSystemTick` and every super_admin cross-tenant read
    // forever, while the pod stays Ready and boot still succeeds (the migration runner hard-codes
    // `max: 1`), so the failure would be completely silent. The bare literal this replaced was
    // immune to that, so the clamp is what keeps the swap behaviour-preserving in every input.
    ownerPoolMax: Math.max(1, int(process.env.DB_OWNER_POOL_MAX, 4)),
  },

  keycloak: {
    url: keycloakUrl,
    realm: keycloakRealm,
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'commonpractice-backend',
    // Explicit issuer string, decoupled from the JWKS fetch URL (matches fr):
    // lets KEYCLOAK_URL point at an in-cluster service without breaking `iss`.
    issuer: keycloakIssuer,
    // Realm-per-app P0: see `keycloakUserRealm` above. `userRealmIssuer` is the PUBLIC issuer of that
    // realm (same host as KEYCLOAK_ISSUER) — the base of the IdP broker redirect URI.
    userRealm: keycloakUserRealm,
    userRealmIssuer: issuerForRealm(keycloakIssuer, keycloakUserRealm),
    // ---- Keycloak admin-API client (services/keycloak-admin.ts) ----
    // A confidential service-account client IN the user realm (KEYCLOAK_USER_REALM; prod
    // `commonpractice`), authenticated with client_credentials. CP only creates identities, sends
    // action emails, ends sessions and manages its tenants' IdPs; it never writes realm roles or the
    // `tenant_id` attribute. Empty = admin client unconfigured (dev/CI; tests inject a fake).
    // Realm-per-app P7: the former `portal`-realm admin SA (KEYCLOAK_ADMIN_CLIENT_ID/SECRET) is gone —
    // CP's users left portal, so there is no second credential and no fallback realm.
    userRealmAdminClientId: (process.env.KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID || '').trim(),
    userRealmAdminClientSecret: (process.env.KEYCLOAK_USER_REALM_ADMIN_CLIENT_SECRET || '').trim(),
    // Per-call ceiling on every Keycloak admin request. Nothing bounded these before, so an
    // unresponsive Keycloak — or the SMTP send inside `execute-actions-email` — could hold an
    // onboarding request open until an upstream proxy turned it into a gateway 502/504.
    // 10s is comfortably above a healthy call (~250ms observed in-cluster) and well under
    // Istio's 15s route default.
    adminTimeoutMs: int(process.env.KEYCLOAK_ADMIN_TIMEOUT_MS, 10_000),
  },

  cors: {
    origins: parseList(process.env.CORS_ORIGINS, ['http://localhost:5174']),
  },

  authBypass: authBypassEnabled(),

  // Auto-seed the demo catalogue (blocks + marketplace + ops + platform + ai) on
  // boot, after migrations. Idempotent (slug/email-matched) so a cold prod DB
  // self-heals its showcase data on the next roll. Default off — dev/CI seed
  // explicitly and must stay deterministic.
  // ⛔ CORRECTED 2026-08-14 — this line used to read "gitops sets SEED_DEMO_DATA=true in prod".
  // It does not: `gitops-production/clusters/strato/services/commonpractice/deployment.yaml` sets
  // SEED_DEMO_DATA="false" (verified in-tree). Reading the old comment as fact means believing prod
  // self-heals its showcase catalogue on every roll, and reaching for the wrong explanation when a
  // demo screen is empty there.
  seedDemoData: process.env.SEED_DEMO_DATA === 'true',

  // Additive-only boot self-heal for the `models.allowlist` governance policy (see
  // host/allowlist-reconcile.ts for the full reasoning). Unlike seedDemoData/reconcileOnBoot
  // above, this defaults ON: it only ever ADDS catalog ids to a row an operator has never
  // edited (updated_by IS NULL), never removes/reorders, is fully audited (policy_changes +
  // audit_log), and is wrapped in try/catch so a failure warns and continues rather than
  // blocking boot. The bug it closes — a catalog model silently unselectable-but-offered — is
  // strictly worse than the (nonexistent, by construction) risk of running it. Opt out with
  // CP_ALLOWLIST_RECONCILE_ON_BOOT=false if that reasoning is ever wrong for a given deploy.
  reconcileAllowlistOnBoot: process.env.CP_ALLOWLIST_RECONCILE_ON_BOOT !== 'false',

  // Additionally populate ONE tenant with a full single-tenant showcase (members +
  // challenges + solutions + votes + weekly winner + runnable flows + IT-ops runs/usage
  // + datasets) so a demo user whose JWT `tenant_id` claim is that tenant sees every
  // RLS-scoped screen populated. Kept SEPARATE from seedDemoData (and OFF in CI) because
  // it adds rows to the demo tenant that the deterministic count-asserting route tests
  // must not see. Defaults the target to DEMO_TENANT_ID (the demo user's home tenant).
  // ⛔ CORRECTED 2026-08-14 — this line used to read "gitops sets SEED_TENANT_SHOWCASE=true in
  // prod". It does not: the strato deployment sets SEED_TENANT_SHOWCASE="false" (same file as
  // above). Runs only when seedDemoData also runs — which, per the correction above, prod also does
  // not do.
  seedTenantShowcase: process.env.SEED_TENANT_SHOWCASE === 'true',
  tenantShowcaseId: process.env.TENANT_SHOWCASE_ID || DEMO_TENANT_ID,

  // ⛔ May a seeder fabricate TELEMETRY or HISTORY — a measurement nobody took, or a record of
  // an event that never happened? Separate from seedDemoData/seedTenantShowcase above, and fails
  // closed in production, because those two flags do not distinguish "invent a catalogue" from
  // "invent the meter" or "invent the audit trail".
  //
  // THE LINE THIS FLAG DRAWS. A seed write is gated when it ASSERTS AN EVENT OCCURRED (who did
  // what, when, with what result) or INVENTS A MEASUREMENT. It stays ungated when it DECLARES
  // CURRENT CONFIGURATION the runtime reads. `policies` rows are the live broker cap / model
  // allowlist / promotion gate — configuration, ungated. An `audit_log` row saying Tom approved
  // a block 9 minutes ago is a claim about the past — gated.
  //
  // What went wrong, part 1 (telemetry, #208): both seeders write `usage_counters` for
  // `current_date` with hard-coded llm_calls/spend on EVERY boot, and seed-ops.ts does it as
  // `ON CONFLICT … DO UPDATE`, so it OVERWRITES real metering rather than skipping them. Prod
  // therefore read an identical 15 rows / 1049 calls / $2.50 for six consecutive days, with eight
  // seeded users sitting above the daily cap of 50 that 0058/0059 exist to enforce. The meter, the
  // IT dashboard and the 14-day spend chart were fiction, rewritten on every rollout.
  //
  // What went wrong, part 2 (history): seed-platform.ts wrote 12 `audit_log` rows, 3
  // `policy_changes` attributed by name to Tom Kemper, and 18 `pipeline_items` carrying invented
  // titles, reviewer counts and `live:true` — on prod. The compliance screen, the governance
  // change log and the production pipeline each showed a past that did not happen, attributed to
  // a real person. An audit trail that contains invented entries is not a weaker audit trail, it
  // is not an audit trail.
  //
  // What went wrong, part 3 (an invented measurement inside CONTENT): both marketplace seeders
  // INSERT a hard-coded `votes_count` — 312, 316, 271, 241, 203 … — while writing no `votes` row
  // to match. Prod displayed 4,760 votes across 25 rows against **18 `votes` rows on the
  // entire platform**. This one is listed third because it is the case the flag's own line above
  // is easiest to read as EXCLUDING: a challenge is content, the seeder is idempotent, and the
  // column sits on the same INSERT as the title. But `votes_count` is not a property of the
  // challenge; it is a COUNT OF OTHER ROWS — "316 colleagues upvoted this" is a measurement, and
  // nobody took it. The flag's own rule ("INVENTS A MEASUREMENT") already covers it; only the
  // habit of reading the row as content hid that.
  //
  // It is also the one with teeth beyond a wrong screen: `WINNER_ORDER`
  // (host/cycle-eligibility.ts:71) ranks on this column, so a seeded 316 outranks every genuine
  // vote that will ever be cast and the SEEDER decides who wins the week. Compare part 1, which
  // "only" overwrote the meter. Fixed by clamping the INSERT to 0 under this same flag (0 is not
  // a placeholder — at INSERT time the row does not exist, so its real vote count is provably 0),
  // plus an UN-GATED `recountVotes` after the showcase seeder's own GENUINE `votes` inserts, which
  // bypass castVote and therefore bump nothing. Migration 0064 reconciled the rows already there.
  //
  // ⛔ AND NOT A SECOND FLAG. The obvious-looking `CP_SEED_FABRICATED_VOTES` was rejected: it
  // would let a deployment be half-honest (a truthful meter beside an invented leaderboard), and
  // it would duplicate the `NODE_ENV=production` fail-closed logic that config-validation.test.ts
  // and seed-fabrication-guard.test.ts already pin here. One line, one meaning.
  //
  // Content seeding stays on — it is genuinely idempotent and its rows are real. Only the
  // invented telemetry, invented history and invented measurements are gated. The env flags being
  // off in gitops is the first guard; this is the one that survives someone flipping them back.
  //
  // The escape hatch exists for a throwaway demo database that legitimately runs with
  // NODE_ENV=production. Setting it on a database anyone reads a real number — or a real audit
  // trail — off is a mistake.
  seedFabricatedTelemetry:
    (process.env.NODE_ENV || 'development') !== 'production' ||
    process.env.CP_SEED_FABRICATED_TELEMETRY === 'true',

  // ---- Session 3: flow execution ----
  // Resource backstops for the spawned runner. memMb is enforced via RLIMIT_AS
  // (prlimit) on Linux ONLY — on macOS dev the only backstop is the wall-clock
  // maxRunMs + SIGKILL (see host/run-controller.ts). prod must be Linux.
  run: {
    maxRunMs: runMaxRunMs,
    maxNodeMs: runMaxNodeMs,
    memMb: int(process.env.RUN_MEM_MB, 512),
    idleMs: runIdleMs,
    // ---- Phase 5: bounded foreach loops ----
    // Hard cap on iterations per foreach (excess rows skipped + a foreach_aborted event) and a cap
    // on trace events a single foreach may emit (protects the SSE pump / console from a runaway loop).
    maxIterations: int(process.env.RUN_MAX_ITERATIONS, 1000),
    maxForeachEvents: int(process.env.RUN_MAX_FOREACH_EVENTS, 5000),
    // ---- Phase 2-C: pluggable run backend (per-session isolation) ----
    // 'subprocess' (default) = a Bun.spawn child INSIDE the backend pod — the
    // only enforceable boundary in Bun, used on macOS dev + CI + single-node.
    // 'k8s' = ONE Kata-isolated Pod per run (host attaches over the API server,
    // pod has zero network egress + no secrets) — the hard per-session boundary
    // for multi-tenant clusters. The runner code + stdio protocol are identical.
    backend: (process.env.RUN_BACKEND as 'subprocess' | 'k8s') || 'subprocess',
    // k8s backend knobs (ignored for 'subprocess'). runtimeClass empty → the
    // cluster default runtime (weaker, documented degrade); 'kata' in prod.
    // image = the runner image ref (= this backend image; runs runner-entry.ts).
    k8s: {
      namespace: process.env.RUN_NAMESPACE || 'commonpractice-runs',
      runtimeClass: process.env.RUN_RUNTIME_CLASS || '',
      image: process.env.RUN_IMAGE || '',
      cpuLimit: process.env.RUN_CPU_LIMIT || '1',
      // Scheduling request is independent of the execution limit (RUN_MEM_MB).
      // Strato's tiny on-demand tools use 64Mi; retain the portable default.
      memoryRequestMb: Math.max(1, int(process.env.RUN_MEMORY_REQUEST_MB, 256)),
      // imagePullSecret name in the runs namespace (e.g. a private registry).
      // Empty = none (public image / pre-pulled). Node scheduling (which nodes
      // are Kata-capable + any taints) is owned by the RuntimeClass, not here,
      // so buildRunPod stays cluster-agnostic / portable.
      imagePullSecret: process.env.RUN_IMAGE_PULL_SECRET || '',
    },
  },

  // The runner has NO provider key; ctx.llm() brokers through host/llm-broker.ts.
  // 'mock' (default: dev/CI) = a deterministic mock so cost/cap logic is exercised with no
  // external dependency. 'openai_compatible' brokers the runner's ctx.llm() to the in-cluster
  // inference-router (OPENAI_BASE_URL) with a router token.
  //
  // ⛔ CP HOLDS NO COMMERCIAL PROVIDER KEY (owner rule 2026-10-13: "commonpractice SIMPLY does NOT
  // CONTAIN any api tokens in its gitops files"). There is no OPENAI_API_KEY / ANTHROPIC_API_KEY and
  // no `anthropic` mode: a commercial model is reached only with the TENANT's own key, and the
  // platform's own inference is the router. tests/config-no-provider-keys.test.ts keeps it that way.
  llm: {
    // Anything but 'openai_compatible' (including a stale LLM_MODE=anthropic) is the mock.
    mode: (process.env.LLM_MODE === 'openai_compatible' ? 'openai_compatible' : 'mock') as
      | 'mock'
      | 'openai_compatible',
    // The in-cluster inference-router (OpenAI-compatible, metered), e.g.
    // http://inference-router.inference-router.svc.cluster.local:8150/api — the adapter appends
    // /chat/completions. Empty = no router (dev/CI): keyless calls resolve to the stub.
    openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
    // Hard wall-clock ceiling on any single LLM provider call, applied centrally in
    // ai/llm/select.ts buildAdapter so no call site can forget it. Before this, five of six
    // callers passed a signal that could never fire, so a hung provider hung the caller — and on
    // the metering path that meant holding a DB transaction (and its usage_counters row lock) open
    // indefinitely, which exhausts the transaction pool and deadlocks the process.
    // 120s is above any legitimate completion (long agent turns included) and far below the
    // point at which a stuck call does real damage.
    callTimeoutMs: int(process.env.LLM_CALL_TIMEOUT_MS, 120_000),
    // The FLAT tier: USD per TOKEN, the price `ai/llm/pricing.ts` charges a call that neither the
    // provider nor the price table can price. Stamped `price_source='flat'` so every screen keeps
    // presenting it as the estimate it is.
    //
    // These defaults changed 2026-08-12, from 0.000003/0.000015 ($3/$15 per Mtok) whose comment
    // read "Mock pricing … Claude-Sonnet-ish so totals look real". Both the numbers and that
    // rationale are obsolete, because WHAT REACHES THIS TIER CHANGED. It used to be a stand-in for
    // unknown third-party models; it is now the notional rate for the in-cluster `local-llm`
    // (see the CORRECTION block in ai/llm/pricing.ts), which is 100% of this deployment's metered
    // traffic. So the default is now the same $10/$25 per Mtok the gitops configmap sets in prod
    // (`LLM_IN_RATE_USD: "0.00001"` / `LLM_OUT_RATE_USD: "0.000025"`, "chosen so the cost screens
    // show meaningful, non-zero spend") — dev, CI and prod now agree on one number instead of dev
    // quietly pricing our own hardware at Anthropic's list price, which is the exact class of
    // fiction this work removes.
    //
    // ⛔ Do not raise these casually. They are the only thing standing between local-only traffic
    // and the `spend.weekly_spend_ceiling` that REFUSES SERVICE. The headroom is measured, not
    // assumed: August prod metered 60,907 in + 19,094 out tokens = $1.09 for the month at these
    // rates, against $15 per user per week. Redo that sum before changing them.
    inRateUsd: num(process.env.LLM_IN_RATE_USD, 0.00001),
    outRateUsd: num(process.env.LLM_OUT_RATE_USD, 0.000025),
  },

  // ---- Fleet cost-correlation: OPTIONAL emit to the shared metering bus ----
  // CP's local `usage_events` ledger stays the source of truth for its own /usage.
  // This block ADDITIONALLY mirrors each metered LLM call onto the shared
  // `metering:costs` Redis stream so billing-service's fleet-wide cost rollup +
  // per-correlation read include CommonPractice (see billing_service/docs/
  // EMITTER_GUIDE.md + COST_CORRELATION.md). DEFAULT OFF and a clean no-op without
  // a Redis URL — the emit is best-effort (a Redis failure never affects the LLM
  // call or the local ledger). gitops flips METERING_EMIT_ENABLED on (with the
  // Redis URL wired) to join the fleet rollup; nothing here is enabled by default.
  //   enabled     → METERING_EMIT_ENABLED; master switch for the whole feature.
  //   redisUrl    → METERING_REDIS_URL; the metering cost-bus Redis (e.g.
  //                 redis://metering-redis.metering.svc.cluster.local:6379/0). Empty = no-op.
  //   costsStream → METERING_COSTS_STREAM; the stream name. The canonical fleet stream the
  //                 billing-service consumer reads is `billing:costs` (every other producer +
  //                 the Prometheus rules use it); `metering:costs` is a dead stream nothing consumes.
  //   outboxIntervalMs → METERING_OUTBOX_INTERVAL_MS; how often host/metering-outbox-drainer.ts
  //                 fires. Default 30 000 = the literal it replaced, so this changes no behaviour
  //                 anywhere it is unset. See `meteringOutboxIntervalMs` above for the clamp and
  //                 why it is a precondition rather than padding.
  metering: {
    emitEnabled: process.env.METERING_EMIT_ENABLED === 'true',
    redisUrl: process.env.METERING_REDIS_URL || '',
    costsStream: process.env.METERING_COSTS_STREAM || 'billing:costs',
    outboxIntervalMs: meteringOutboxIntervalMs(),
    // reconcileHourUtc → METERING_RECONCILE_HOUR_UTC; the UTC hour the daily
    // CP-vs-billing reconciliation fires. It MUST be a fixed hour, not a
    // boot-relative 24 h timer: a deploy shifts a boot-relative tick, and the gap
    // from the previous claim to the next one then exceeds the 30 h freshness
    // alert. Measured 2026-11-10: a 19:40Z roll pushed the gap to ~33 h and paged
    // CommonPracticeDailySchedulerStale while the scheduler was healthy. cycle
    // (CYCLE_TICK_HOUR_UTC) and audit-export (AUDIT_EXPORT_HOUR_UTC) are fixed-hour
    // for exactly this reason.
    // 03 — the SAME hour as cycle, and early on purpose: the freshness alert's
    // worst legitimate gap is 24h + the tick hour (a boot catch-up between 00:00
    // and the hour stamps the day, the hour tick is then refused inside the 12h
    // window). At hour 3 that is 27h, inside the 30h threshold it already
    // documents; a later hour (e.g. the historical 11) would make the worst case
    // 35h and require loosening the rule. The comparison has no billing-day-close
    // dependency: SETTLED_ONLY is "outbox row status='sent'", not a settlement
    // sweep, so 03:00 UTC loses nothing.
    reconcileHourUtc: int(process.env.METERING_RECONCILE_HOUR_UTC, 3),
  },

  // Session 7: the master key that encrypts per-tenant BYO provider keys at rest
  // (tenant_llm_settings.api_key_encrypted, AES-256-GCM via host/secret-box.ts).
  // Accepts a 32-byte base64/hex value or any passphrase (scrypt-derived). The dev
  // default is rejected in production by validateProductionConfig.
  secrets: {
    masterKey: process.env.CP_SECRET_KEY || 'dev-secret-key-change-me',
  },

  // ---- Phase 2-F: nightly audit-log compliance export ----
  // A boot-only in-process scheduler archives the append-only audit_log as a
  // tamper-evident NDJSON bundle (+ sha256) to object storage via storage_service.
  // ALL optional, DEFAULT OFF — dev/CI/tests never schedule; prod opts in via gitops.
  // Target is operator-config (storage_service in-cluster, or any S3-compatible proxy
  // on-prem). In-cluster, trusted-network pass-through needs no token (and sends no tenant header).
  auditExport: {
    enabled: process.env.AUDIT_EXPORT_ENABLED === 'true',
    hourUtc: int(process.env.AUDIT_EXPORT_HOUR_UTC, 2), // nightly 02:00 UTC
    storageUrl: process.env.AUDIT_EXPORT_STORAGE_URL || '',
    bucket: process.env.AUDIT_EXPORT_BUCKET || 'artifacts',
    keyPrefix: process.env.AUDIT_EXPORT_KEY_PREFIX || 'audit',
    token: process.env.AUDIT_EXPORT_TOKEN || '',
  },

  // ---- Phase 2-E: marketplace cycle engine ----
  // A boot-only in-process scheduler runs tickCycles once a day (host/cycle-scheduler.ts): opens the
  // current PERIOD, advances voting → solution_phase → closed at its boundaries, and announces the
  // period's winners onto the production pipeline.
  //
  // 0107: the cadence (off | week | month | quarter | year) is the governance policy `cycle.cadence`, edited on
  // /governance. CYCLE_ENABLED only BOOTSTRAPS that row ('week' when true, else 'off' —
  // host/cycle-cadence.ts `ensureCadencePolicy`). Phase lengths are per kind (host/period.ts
  // `phaseBoundaries`: week 4+3 days, month days 1–21 + rest, year Jan–Nov + December), so the old
  // CYCLE_VOTING_DAYS / CYCLE_SOLUTION_DAYS pair is gone — a close always lands on the next period's
  // start, which is what lets one tick close a period and open the next.
  cycle: {
    enabled: process.env.CYCLE_ENABLED === 'true',
    tickHourUtc: int(process.env.CYCLE_TICK_HOUR_UTC, 3), // daily 03:00 UTC
  },

  // ---- Phase 2-G: deep i18n content pipeline ----
  // A boot-only in-process drainer (host/translation-scheduler.ts) translates queued
  // user-generated content (challenges/solutions/block docs) into the 7 non-en locales
  // via the metered LLM broker, UPSERTing results into content_translations. INTERVAL-
  // based (not a daily tick) so new content localizes within minutes. DEFAULT OFF —
  // dev/CI/tests never schedule; prod opts in via gitops (TRANSLATION_ENABLED=true,
  // with the inference-router already wired as the broker's openai-compatible backend).
  // batchSize bounds each drain; the per-actor daily LLM cap throttles further and a
  // cap-reject simply DEFERS (jobs stay pending) — never fails content creation.
  translation: {
    enabled: process.env.TRANSLATION_ENABLED === 'true',
    intervalMinutes: int(process.env.TRANSLATION_INTERVAL_MIN, 5),
    batchSize: int(process.env.TRANSLATION_BATCH_SIZE, 20),
    maxAttempts: int(process.env.TRANSLATION_MAX_ATTEMPTS, 3),
    /** Backstop ceiling on one drain so a stuck tick can never hold the advisory lock forever
     *  (which would stop translation fleet-wide, un-loggably). Generous: a full batch of LLM
     *  calls at the per-call ceiling still fits. */
    drainTimeoutMs: int(process.env.TRANSLATION_DRAIN_TIMEOUT_MS, 10 * 60_000),
  },

  // ---- Outbound mail (host/mailer.ts) ----
  // CP had no mailer at all: the only email in the system was Keycloak's own magic-link action
  // email, which cannot carry arbitrary transactional mail. The budget alerts need one. DEFAULT
  // OFF — with `enabled` false, alerts are still raised in-app and the email is skipped, so a
  // missing SMTP config degrades a notification channel rather than breaking the scheduler.
  mail: {
    enabled: process.env.SMTP_ENABLED === 'true',
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || '',
    fromName: process.env.SMTP_FROM_NAME || 'Common Practice',
    /** STARTTLS on a plaintext connection (587). Set false only for an implicit-TLS relay (465). */
    starttls: process.env.SMTP_STARTTLS !== 'false',
    timeoutMs: int(process.env.SMTP_TIMEOUT_MS, 15_000),
  },

  // Governance ceilings the broker enforces (S6 will move these to the policies
  // table; the broker reads them behind getGovernanceLimits() so that swap is local).
  // autoSuspendIdleMinutes is the sandbox idle-sweep threshold (host/sandbox-service.ts,
  // read behind getSandboxLimits()). Default 7 days matches the demo governance screen;
  // set GOV_AUTOSUSPEND_IDLE_MIN low (e.g. 1) to observe the sweep live or in docker.
  governance: {
    dailyLlmCap: int(process.env.GOV_DAILY_LLM_CAP, 200),
    weeklySpendUsd: num(process.env.GOV_WEEKLY_SPEND_USD, 50),
    autoSuspendIdleMinutes: int(process.env.GOV_AUTOSUSPEND_IDLE_MIN, 10080),
  },

  // ---- AI substrate: the agent two-token session (Retrofit, SPEC §5A) ----
  // The chat endpoint authenticates with a short-lived HS256 agent token minted
  // from a Keycloak login (mirror fr's two-token model). jwtSecret signs that token;
  // it MUST be set in production (the dev default is rejected by validateProductionConfig).
  // `model` is the chat model passed to the broker (allowlisted); the stub ignores it.
  agent: {
    jwtSecret: process.env.AGENT_JWT_SECRET || 'dev-agent-secret-change-me',
    accessTtlSec: int(process.env.AGENT_ACCESS_TTL_SEC, 900), // 15 min
    refreshTtlSec: int(process.env.AGENT_REFRESH_TTL_SEC, 60 * 60 * 24 * 30), // 30 days
    // The chat model passed to the broker when a tenant pins none. Sourced from gitops
    // (AGENT_MODEL); the honest default is the in-cluster inference-router alias `local-llm`,
    // NOT a hosted Claude model — CP brokers to the local pgx vLLM unless a tenant BYOs a key.
    model: process.env.AGENT_MODEL || 'local-llm',
  },

  // ---- Phase 4 / F.1: license dual-gate (Spec Part 9) ----
  // Gate 2 — after Keycloak identity (Gate 1) resolves the tenant, confirm that tenant holds an
  // active `commonpractice` license in the central licenses service by introspecting the tenant's
  // stored token (middleware/license-gate.ts + services/license-client.ts). DEFAULT OFF: F.1 ships
  // the machinery dormant; F.2 issues per-tenant tokens into onboarding and flips enforceGate2 on
  // (Spec 9.5 Phase C→F) — enabling enforcement before tokens exist would 402 every tenant.
  //   introspectUrl → the public `POST /license/introspect` (in-cluster
  //     http://licenses.licenses.svc.cluster.local:8544/license/introspect).
  //   appKey        → the license app key the introspected token MUST carry ('commonpractice').
  //   cacheTtlSec   → introspection cache window (worker_management parity; ≤ this = revocation lag).
  license: {
    enforceGate2: process.env.LICENSE_GATE_2_ENABLED === 'true',
    introspectUrl: process.env.LICENSE_INTROSPECT_URL || '',
    appKey: process.env.LICENSE_APP_KEY || 'commonpractice',
    cacheTtlSec: int(process.env.LICENSE_CACHE_TTL_SEC, 300), // 5 min, like worker_management
    // Wall budget for the BATCHED licence read behind the platform /tenants screen
    // (lib/license-status.ts licenseStatesForTenants). Per-call introspects are already bounded by
    // adminTimeoutMs (10 s), but 19 tenants at concurrency 6 is ~40 s of worst case — this deadline
    // is the load-bearing bound. Whatever has not answered by then reports `unknown`, never `none`.
    statusBatchMs: int(process.env.LICENSE_STATUS_BATCH_MS, 3_000),

    // ---- Phase 4 / F.2: license ISSUANCE (the write side, Spec §9.3) ----
    // The read side above (introspect/enforceGate2) checks a stored token; F.2 is how that token
    // gets there. `issuanceEnabled` gates the licenses-admin SA client + the onboarding/offboarding
    // hooks (services/license-provisioning.ts). DEFAULT OFF: F.2 ships the machinery dormant — with
    // the flag off the SA client is never constructed/called, so onboarding behaves exactly as
    // today. Ops registers the app+plan in licenses.example.com, sets the SA creds below, flips this
    // on (issuance), THEN flips enforceGate2 (§9.5 C→F — enabling the gate before tokens exist 402s
    // every tenant).
    //   adminBaseUrl → the licenses admin API base (per-tenant issue/token/revoke), e.g.
    //     https://licenses.example.com (out-of-cluster) or the in-cluster service base.
    //   planCode     → the plan tier each tenant's license is issued on (`POST /apps`/`/plans` ops).
    //   sa.*         → a `secure-apps` realm confidential service account (client_credentials →
    //                  `license-admin`). A DIFFERENT realm from CP's `portal` users (Spec §9.4).
    issuanceEnabled: process.env.LICENSE_ISSUANCE_ENABLED === 'true',
    /**
     * Gate 2 checks the CALLER'S OWN entitlement (migration 0089) instead of the tenant-level token.
     *
     * ⛔ SEPARATE FROM `issuanceEnabled` ON PURPOSE, AND THE ORDER IS NOT OPTIONAL. Issuance must run
     * FIRST and long enough to have minted an entitlement for every live member; flipping this while
     * anyone is unlicensed locks those people out of a workspace that is paying for them. The
     * documented rollout is: issuance on -> backfill -> CP live members vs licences `human_subjects`
     * drift is ZERO -> only then flip this.
     *
     * ⚠️ IT ALSO HAS A FRONTEND PRECONDITION. Turning this on can emit `license_seat_required`, a 402
     * code an older SPA bundle does not know — and an unknown 402 code renders NO block screen at
     * all, papering every screen with "your workspace doesn't have an active licence" instead (the
     * measured old-SPA/new-API failure recorded in middleware/license-gate.ts). The flag is what lets
     * both halves merge together and still deploy safely: the SPA ships inert, and this is flipped
     * only once that bundle is confirmed live.
     */
    perMemberGate: process.env.LICENSE_GATE_PER_MEMBER === 'true',
    adminBaseUrl: process.env.LICENSE_ADMIN_BASE_URL || '',
    planCode: process.env.LICENSE_PLAN_CODE || 'standard',
    /**
     * `LICENCE_BUNDLE_PLANS` (comma list, default `tenant-pooled,standard`): the ordered plan-code
     * preference CP sends as `plans` on `POST /internal/tenants/{id}/bundles/{bundle}/ensure`
     * (services/tenant-licence-bundles.ts). Licences gives each INSERTED app licence the first code
     * that exists, non-revoked, on that app; an app with none of them is refused `no_plan`.
     *
     * ⚠️ Sending `{}` is NOT neutral: licences then defaults to `["standard"]`, and the n8n-nodes apps
     * have ONLY a `tenant-pooled` plan (licences migration 051), so every one of them was refused
     * `no_plan`. `tenant-pooled` first is the plan tenant-level licences are on (netcare);
     * `standard` is the fallback for apps that never got a pooled plan.
     */
    bundlePlans: parseLicenceBundlePlans(process.env.LICENCE_BUNDLE_PLANS),
    /** Per-call ceiling on licenses admin-API requests — same rationale as keycloak.adminTimeoutMs. */
    adminTimeoutMs: int(process.env.LICENSE_ADMIN_TIMEOUT_MS, 10_000),
    sa: {
      tokenUrl: process.env.LICENSE_SA_TOKEN_URL || '',
      clientId: process.env.LICENSE_SA_CLIENT_ID || '',
      clientSecret: process.env.LICENSE_SA_CLIENT_SECRET || '',
    },
  },

  // ---- billing-service reads (services/billing-admin.ts, routes/billing-view.ts) ----
  //
  // What the tenant-admin billing panel and the daily reconciliation tick read: the invoice, the
  // current-period preview and the per-actor costs. READS ONLY — CP never writes commercial terms.
  //
  // ⛔ NO SA BLOCK OF ITS OWN, deliberately. Billing's service endpoints sit behind the SAME
  // `secure-apps` realm as licences', so `license.sa` is the credential, and minting a second
  // client for the same realm would double the number of secrets to rotate for no boundary gained.
  // If billing ever moves to its own realm this grows an `sa` block and the client stops reusing
  // that one.
  //
  // ⚠️ EMPTY IS A SUPPORTED STATE AND MUST STAY ONE — it is not in `validateProductionConfig`. With
  // no base URL the panel answers `status:'unavailable', reason:'not_configured'` and the reconcile
  // tick counts the tenant as UNAVAILABLE rather than as agreeing. A boot refusal here would take
  // the whole product down over a reporting screen; the honest unavailable state is the trade.
  billing: {
    baseUrl: (process.env.BILLING_ADMIN_BASE_URL || '').replace(/\/+$/, ''),
  },

  // ---- per-tenant inference-router credential (services/tenant-inference.ts, migration 0099) ----
  // A `local-llm` tenant calls the in-cluster inference-router (`llm.openaiBaseUrl`) with its OWN
  // `inference-router` licence token. The licence is minted through the licences admin API with the
  // same `license-admin` SA as CP's own licences (`POST /licenses/user/{sub}` + `POST
  // /licenses/{id}/tokens`): licences' bundle routes (`ensure_bundle`, `bundle-token`) need the
  // `bundle-provisioner` / `bundle-token-minter` roles, which CP's SA does not hold.
  inference: {
    appKey: process.env.INFERENCE_LICENCE_APP_KEY || 'inference-router',
    planCode: process.env.INFERENCE_LICENCE_PLAN_CODE || 'standard',
    /** The model the provisioning smoke call asks for (the router's local alias). */
    smokeModel: process.env.INFERENCE_SMOKE_MODEL || 'local-llm',
    /**
     * The licences SERVICE tenant that holds the PLATFORM's router licence (platform background work,
     * tenant-less calls): `svc-commonpractice`, created by licences' `scripts/provision_service_token.py
     * --subject svc-commonpractice --app-key inference-router` (kind=service, a real uuid). NOT the nil
     * system tenant: in licences that is `default-anon`, whose cost events inference-router drops.
     * Empty = not configured: platform LLM work fails closed (503 llm_inference_not_provisioned).
     */
    platformTenantId: (process.env.INFERENCE_PLATFORM_TENANT_ID || '').trim().toLowerCase(),
  },

  // ---- Phase 5 / 5D: the fr internal-bridge delivery target (Target B, Spec Parts 5/6) ----
  // CP forwards a solution to fr as a DRAFT project_request a human approves before fr/n8n/kanban
  // act. This block is the CP-side wiring for that path. It is LIVE ('fr' ∈ SUPPORTED_FORWARD_KINDS,
  // routes/delivery.ts) now that the fr-side receiver + the `commonpractice-bridge` portal-realm SA
  // exist; validateProductionConfig requires the sa.* creds + a Gate-2 introspect URL in prod.
  //   baseUrl            → UNUSED at runtime — the adapter posts to the per-connector target.base_url,
  //     not this. Kept only as documentation of the intended fr ingress base; not prod-validated.
  //   licenseIntrospectUrl → optional override; '' = reuse license.introspectUrl (the introspect
  //     endpoint validates ANY app's token — app.key comes back in the response — so one URL serves
  //     both gates; only set this if fr ever fronts a distinct licenses service).
  //   licenseAppKeys     → Gate 2 accepts an fr license token only if its introspected app.key is in
  //     this set (the tenant's fr/kanban/n8n entitlement).
  //   sa.*               → the `commonpractice-bridge` portal-realm confidential service account
  //     (client_credentials). Its JWT is the caller identity (project-request-writer) on the POST;
  //     X-Tenant-Id carries the resolved tenant uuid (CP asserts it, trusted via the SA), NOT the
  //     license token — see host/delivery/fr.ts (PLAN-PHASE5.D go-live, Design A).
  fr: {
    baseUrl: process.env.FR_BASE_URL || '',
    licenseIntrospectUrl: process.env.FR_LICENSE_INTROSPECT_URL || '',
    licenseAppKeys: parseList(process.env.FR_LICENSE_APP_KEYS, ['fr', 'kanban', 'n8n']),
    sa: {
      tokenUrl: process.env.FR_BRIDGE_TOKEN_URL || '',
      clientId: process.env.FR_BRIDGE_CLIENT_ID || 'commonpractice-bridge',
      clientSecret: process.env.FR_BRIDGE_CLIENT_SECRET || '',
    },
  },

  // ---- Phase 5.1: fr→CP promotion feedback (the inbound half of the loop) ----
  // When fr promotes a CP-originated project_request, fr POSTs the new fr_project_id
  // to POST /api/delivery/fr-feedback. That call is authed by fr's portal SA
  // (fr-backend) carrying this realm role; CP validates the JWT with the SAME portal
  // JWKS it uses for user tokens (services/keycloak.ts) — so no new secret/config is
  // prod-required. writerRole is the realm role the inbound JWT must carry.
  frFeedback: {
    writerRole: process.env.FR_FEEDBACK_WRITER_ROLE || 'delivery-feedback-writer',
  },
} as const;

// ---- Self-serve storage connectors: MinIO bucket-notification auto-registration ----
// When a user creates a `storage` + `webhook` connector on a `cp-*` bucket, CP calls
// storage_service to auto-provision the bucket's MinIO notification rule (no operator step).
// Unlike the frozen `config` above this is a FUNCTION read live from env, because the feature
// is staged (ships dark; goes live only when gitops sets the env + SOPS secret) and tests
// toggle it per-case. DEFAULT OFF — with `enabled` false, storage+webhook connectors keep the
// legacy per-connector-secret behaviour and nothing auto-registers.
//   enabled   → CP_CONNECTOR_NOTIFICATIONS_ENABLED; master switch for the whole feature.
//   storageUrl→ CP_NOTIFY_STORAGE_URL, e.g. http://storage-api.storage.svc.cluster.local:8391
//               (storage_service — the only in-cluster MinIO-cred holder). SSRF-guarded.
//   secret    → CP_CONNECTOR_EVENTS_SECRET; the SHARED platform events secret == the MinIO
//               `cpdatasets` target's auth_token. Stored as each storage connector's
//               event_secret so the MinIO-presented bearer verifies. Refresh-trigger only —
//               NOT data access (which stays tenant + egress gated).
//   perTenantIsolation → CP_BUCKET_PER_TENANT_ISOLATION; when true, a storage+webhook
//               connector's requested bucket is rewritten to `cp-<tenantToken>-<name>` on
//               create so a tenant can never name (or auto-register against) another
//               tenant's bucket. DEFAULT OFF (flat `cp-*`). Reversible — flip to false.
//   legacyBuckets → CP_BUCKET_LEGACY_ALLOW (comma list, default `cp-datasets`); buckets
//               grandfathered out of the per-tenant rewrite (the pre-existing demo connector).
export interface ConnectorNotificationsConfig {
  enabled: boolean;
  storageUrl: string;
  secret: string;
  perTenantIsolation: boolean;
  legacyBuckets: string[];
  /** When true, re-assert every storage+webhook connector's MinIO rule once at boot (SYSTEM,
   *  cross-tenant) — recovery after a MinIO restart/data-loss. Default OFF (opt-in via gitops). */
  reconcileOnBoot: boolean;
}

export function connectorNotificationsConfig(): ConnectorNotificationsConfig {
  return {
    enabled: process.env.CP_CONNECTOR_NOTIFICATIONS_ENABLED === 'true',
    storageUrl: (process.env.CP_NOTIFY_STORAGE_URL || '').replace(/\/+$/, ''),
    secret: process.env.CP_CONNECTOR_EVENTS_SECRET || '',
    perTenantIsolation: (process.env.CP_BUCKET_PER_TENANT_ISOLATION || '').toLowerCase() === 'true',
    legacyBuckets: (process.env.CP_BUCKET_LEGACY_ALLOW || 'cp-datasets')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    reconcileOnBoot: process.env.CP_CONNECTOR_NOTIFY_RECONCILE_ON_BOOT === 'true',
  };
}

// ---- Early-access self-signup: server-to-server intake, Turnstile, Telegram (George 2026-10-14) ----
// All three are FUNCTIONS read live from env (like `connectorNotificationsConfig`): each ships dark and
// goes live only when gitops sets its env + secret, and tests toggle them per case.
//
// Intake (POST /api/signup-approvals/intake): a Keycloak client-credentials token from a dedicated
// portal-realm client. BOTH must hold: the token's `azp` is in `allowedAzp` AND it carries the realm
// role `role`. A token carrying `super_admin` is refused outright — this door is for a narrow service
// account, never for a human operator's session. Empty `allowedAzp` = the intake route is closed (403).
export interface SignupIntakeConfig {
  /** CP_SIGNUP_INTAKE_AZP — comma list of client ids allowed to call intake. */
  allowedAzp: string[];
  /** CP_SIGNUP_INTAKE_ROLE — the realm role the intake token must carry. */
  role: string;
  /** CP_SIGNUP_INTAKE_ISSUER — the ONE issuer the intake token must come from (default KEYCLOAK_ISSUER).
   *  Realm-per-app P1 flips this to secure-apps per client; it must also be in KEYCLOAK_TRUSTED_ISSUERS. */
  issuer: string;
}

/**
 * The fr -> CP promotion-feedback door (POST /api/delivery/fr-feedback, middleware/fr-feedback-auth.ts).
 * Realm-per-app P7 chain C: fr's service token moves portal -> secure-apps, so the door pins a LIST of
 * issuers (FR_FEEDBACK_ISSUER, CSV, default [KEYCLOAK_ISSUER]) — both while fr flips, then the old one
 * is dropped — and the client (FR_FEEDBACK_AZP, default fr-backend) so a role mis-mapped onto some
 * other client of a listed realm still cannot post. Read live (tests toggle it).
 */
export function frFeedbackDoorConfig(): { issuers: string[]; allowedAzp: string[]; role: string } {
  return {
    issuers: parseList(process.env.FR_FEEDBACK_ISSUER, [keycloakIssuer]).map((s) => s.replace(/\/+$/, '')),
    allowedAzp: parseList(process.env.FR_FEEDBACK_AZP, ['fr-backend']),
    role: (process.env.FR_FEEDBACK_WRITER_ROLE || 'delivery-feedback-writer').trim(),
  };
}

export function signupIntakeConfig(): SignupIntakeConfig {
  return {
    allowedAzp: parseList(process.env.CP_SIGNUP_INTAKE_AZP, ['cp-signup-intake']),
    role: (process.env.CP_SIGNUP_INTAKE_ROLE || 'cp-signup-intake').trim(),
    issuer: (process.env.CP_SIGNUP_INTAKE_ISSUER || '').trim().replace(/\/+$/, '') || keycloakIssuer,
  };
}

// Telegram decision (POST /api/signup-approvals/:id/telegram-decision, early-access v2 C3): chat-bridge
// relays George's Approve/Reject tap with a client-credentials token from its own portal-realm client.
// Same shape as the intake door — `azp` pinned, `aud` naming that azp, a narrow realm role, never
// super_admin — but a DIFFERENT client and role: the intake SA can queue signups, only the decider SA
// can approve them, and neither can do the other's job.
export interface SignupDeciderConfig {
  /** CP_SIGNUP_DECIDER_AZP — comma list of client ids allowed to decide. */
  allowedAzp: string[];
  /** CP_SIGNUP_DECIDER_ROLE — the realm role the decider token must carry. */
  role: string;
  /** CP_SIGNUP_DECIDER_ISSUER — the ONE issuer the decider token must come from (default KEYCLOAK_ISSUER).
   *  Must also be in KEYCLOAK_TRUSTED_ISSUERS. */
  issuer: string;
}

export function signupDeciderConfig(): SignupDeciderConfig {
  return {
    allowedAzp: parseList(process.env.CP_SIGNUP_DECIDER_AZP, ['chat-bridge-signup-decider']),
    role: (process.env.CP_SIGNUP_DECIDER_ROLE || 'cp-signup-decide').trim(),
    issuer: (process.env.CP_SIGNUP_DECIDER_ISSUER || '').trim().replace(/\/+$/, '') || keycloakIssuer,
  };
}

// book-fulfillment's internal download-link mint (early-access v2 C4): on approve CP asks for the
// requester's epub link and hands it to Keycloak's email template (`signup_book_url`). Optional and
// non-blocking — unset (no URL / client / secret) = the email goes out without a book block.
export interface BookLinksConfig {
  /** BOOK_FULFILLMENT_URL — in-cluster base URL, e.g. http://book-fulfillment.<ns>.svc.cluster.local:<port>. */
  baseUrl: string;
  /** BOOK_LINKS_TOKEN_URL — S2S token endpoint (realm-per-app P1 points it at secure-apps); default `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`. */
  tokenUrl: string;
  /** BOOK_LINKS_CLIENT_ID (default `commonpractice-book-links`). */
  clientId: string;
  /** BOOK_LINKS_CLIENT_SECRET (secret), or the contents of BOOK_LINKS_SECRET_FILE. */
  clientSecret: string;
  /** BOOK_LINKS_TIMEOUT_MS (default 5000) — per call; the email waits for at most two of these. */
  timeoutMs: number;
  enabled: boolean;
}

export function bookLinksConfig(): BookLinksConfig {
  const baseUrl = (process.env.BOOK_FULFILLMENT_URL || '').trim().replace(/\/+$/, '');
  const tokenUrl =
    (process.env.BOOK_LINKS_TOKEN_URL || '').trim() ||
    (keycloakUrl ? `${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/token` : '');
  const clientId = (process.env.BOOK_LINKS_CLIENT_ID || '').trim() || 'commonpractice-book-links';
  let clientSecret = (process.env.BOOK_LINKS_CLIENT_SECRET || '').trim();
  const secretFile = (process.env.BOOK_LINKS_SECRET_FILE || '').trim();
  if (!clientSecret && secretFile) {
    try {
      clientSecret = readFileSync(secretFile, 'utf8').trim();
    } catch {
      clientSecret = '';
    }
  }
  const timeout = Number(process.env.BOOK_LINKS_TIMEOUT_MS);
  return {
    baseUrl,
    tokenUrl,
    clientId,
    clientSecret,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5_000,
    enabled: Boolean(baseUrl && tokenUrl && clientId && clientSecret),
  };
}

// Cloudflare Turnstile. With `secret` set, a submission that CARRIES a token is verified with
// siteverify (a failed verification is refused). With `required` true, an ANONYMOUS notify-self
// (no CP identity — a browser form) must carry one. `required` without `secret` fails CLOSED (503):
// the operator asked for a check that cannot run, so nothing is admitted unchecked.
export interface TurnstileConfig {
  /** TURNSTILE_SECRET */
  secret: string;
  /** TURNSTILE_REQUIRED=true */
  required: boolean;
  /** TURNSTILE_VERIFY_URL — overridable for tests/self-hosted proxies only. */
  verifyUrl: string;
  /** TURNSTILE_TIMEOUT_MS */
  timeoutMs: number;
}

export function turnstileConfig(): TurnstileConfig {
  return {
    secret: (process.env.TURNSTILE_SECRET || '').trim(),
    required: (process.env.TURNSTILE_REQUIRED || '').trim().toLowerCase() === 'true',
    verifyUrl:
      (process.env.TURNSTILE_VERIFY_URL || '').trim() ||
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    timeoutMs: int(process.env.TURNSTILE_TIMEOUT_MS, 5_000),
  };
}

// Telegram notification of new / decided signups (services/signup-telegram.ts). Sends ONLY — CP never
// calls setWebhook / getUpdates (the bot has another webhook owner). Disabled unless ALL THREE of the
// token, chat id and forum-topic thread id are set.
export interface SignupTelegramConfig {
  /** TELEGRAM_BOT_TOKEN (secret) */
  botToken: string;
  /** TELEGRAM_SIGNUP_CHAT_ID, e.g. -1003934173351 */
  chatId: string;
  /** TELEGRAM_SIGNUP_THREAD_ID — the "CP signups" forum topic (NOT 167, the external-probe topic). */
  threadId: string;
  /** TELEGRAM_API_BASE — overridable for tests only. */
  apiBase: string;
  enabled: boolean;
}

export function signupTelegramConfig(): SignupTelegramConfig {
  const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_SIGNUP_CHAT_ID || '').trim();
  const threadId = (process.env.TELEGRAM_SIGNUP_THREAD_ID || '').trim();
  return {
    botToken,
    chatId,
    threadId,
    apiBase: ((process.env.TELEGRAM_API_BASE || '').trim() || 'https://api.telegram.org').replace(/\/+$/, ''),
    enabled: Boolean(botToken && chatId && threadId),
  };
}

// The unverified-signup digest (host/signup-digest-scheduler.ts): untrusted signups (anonymous
// notify-self without Turnstile) are never announced one by one; at most one Telegram message per
// `intervalHours` says how many wait. `0` disables the digest. Only armed when Telegram is enabled.
export interface SignupDigestConfig {
  /** SIGNUP_DIGEST_INTERVAL_HOURS (default 6; 0 = off; fractions allowed, floored at 0.25 h). */
  intervalHours: number;
}

export function signupDigestConfig(): SignupDigestConfig {
  const raw = Number((process.env.SIGNUP_DIGEST_INTERVAL_HOURS ?? '').trim() || '6');
  const hours = Number.isFinite(raw) ? raw : 6;
  return { intervalHours: hours <= 0 ? 0 : Math.max(0.25, hours) };
}

const DEV_AGENT_SECRET = 'dev-agent-secret-change-me';
const DEV_SECRET_KEY = 'dev-secret-key-change-me';
// A real signing/encryption secret is a 32-byte hex (64 chars) or base64 (~44 chars)
// value. Reject anything shorter in production: a weak passphrase is silently
// scrypt-derived (secret-box.ts) into a low-entropy key, so length is the only
// pre-flight signal we have that an operator set a real secret, not 'changeme'.
const MIN_SECRET_LEN = 16;

/**
 * Config that is INTERNALLY INCONSISTENT — a flag switched on without the settings it needs. These
 * are checked in EVERY environment, before the production short-circuit below.
 *
 * ⛔ WHY THESE CANNOT LIVE IN `validateProductionConfig`'s prod-only block.
 * `LICENSE_GATE_2_ENABLED=true` with no `LICENSE_INTROSPECT_URL` is not "a prod deployment missing
 * a prod setting" — it is a statement that contradicts itself, and it breaks IDENTICALLY wherever
 * it is set. Gate 2 runs on every non-exempt request; with the flag on and no URL,
 * `services/license-client.ts` throws `LicenseClientError(500, 'license introspect URL not
 * configured')` per request, and `middleware/license-gate.ts` cannot tell that apart from the 503
 * transport case — so EVERY tenant gets `402 license_unavailable`, whose SPA copy is "we can't
 * complete the licence check right now; access resumes automatically as soon as it succeeds".
 * Which it never does. A one-line misconfiguration therefore bricks a whole staging or preview
 * environment behind a message that tells everyone to wait, and the pod boots cleanly and reports
 * healthy throughout.
 *
 * Failing fast at boot converts that into a crash-loop naming the missing variable — noisy, and
 * diagnosable in seconds. Fail-fast is only ever a downgrade when the environment could function
 * without the setting, and here it demonstrably cannot: every request already fails.
 *
 * Kept a SEPARATE function (rather than a few lines hoisted above the early return) so the two
 * categories stay legible: "prod needs a real secret" is not the same kind of claim as "this flag
 * combination cannot work anywhere".
 */
export function validateConfigInvariants(cfg = config): void {
  const inconsistent: string[] = [];
  // Phase 4 / F.1: when the license dual-gate is ENFORCED, Gate 2 introspects every request's token
  // — without the introspect URL + app key it cannot evaluate and fails closed on every request.
  // Checked only when the flag is ON, so a flag-OFF deployment of any kind stays valid.
  if (cfg.license.enforceGate2) {
    if (!cfg.license.introspectUrl) {
      inconsistent.push('LICENSE_INTROSPECT_URL (LICENSE_GATE_2_ENABLED=true)');
    }
    if (!cfg.license.appKey) inconsistent.push('LICENSE_APP_KEY (LICENSE_GATE_2_ENABLED=true)');
  }
  if (inconsistent.length > 0) {
    throw new Error(
      `[config] inconsistent configuration (a flag is enabled without the settings it requires): ${inconsistent.join(', ')}`,
    );
  }
}

/**
 * Fail-fast on missing prod-critical config. In dev with AUTH_BYPASS the
 * Keycloak URL is allowed to be a placeholder; in production it is required.
 *
 * Always runs `validateConfigInvariants` first — those checks are environment-independent.
 */
export function validateProductionConfig(cfg = config): void {
  validateConfigInvariants(cfg);
  if (cfg.env !== 'production') return;
  const missing: string[] = [];
  if (!cfg.database.url) missing.push('DATABASE_URL');
  // Phase 4 / D.1.2: prod runs the runtime as the non-owner `cp_app` role (DATABASE_URL),
  // which cannot run DDL. Migrations + runAsSystem use the OWNER DSN (MIGRATE_DATABASE_URL);
  // if it's left to fall back to DATABASE_URL, boot migrations fail. Require it explicitly.
  if (!cfg.database.migrateUrlExplicit) {
    missing.push('MIGRATE_DATABASE_URL (owner DSN for migrations + runAsSystem; must be set explicitly in prod)');
  }
  if (cfg.authBypass) missing.push('AUTH_BYPASS must NOT be true in production');
  if (!cfg.keycloak.url) missing.push('KEYCLOAK_URL');
  // Invites and SSO setup go through the Keycloak admin client (create identity / action email /
  // IdP CRUD) in the user realm. Without its service-account credentials every invite would 502, so
  // require them in production (dev/CI leave them empty and never call the live KC; tests inject a
  // fake client).
  if (!cfg.keycloak.userRealmAdminClientId) {
    missing.push('KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID (Keycloak user-realm admin client — invites)');
  }
  if (!cfg.keycloak.userRealmAdminClientSecret) {
    missing.push('KEYCLOAK_USER_REALM_ADMIN_CLIENT_SECRET (Keycloak user-realm admin client — invites)');
  }
  // Realm-per-app P0: a pinned S2S issuer outside the trusted list could never verify, so that door
  // would 401 forever. A config mistake — fail at boot, naming the variable.
  {
    const trusted = keycloakTrustedIssuers();
    if (trusted.length === 0) missing.push('KEYCLOAK_TRUSTED_ISSUERS (empty list — no token could ever verify)');
    for (const [name, iss] of [
      ['CP_SIGNUP_INTAKE_ISSUER', signupIntakeConfig().issuer],
      ['CP_SIGNUP_DECIDER_ISSUER', signupDeciderConfig().issuer],
      ...frFeedbackDoorConfig().issuers.map((i) => ['FR_FEEDBACK_ISSUER', i] as const),
    ] as const) {
      if (!trusted.includes(iss)) missing.push(`${name} (${iss} is not in KEYCLOAK_TRUSTED_ISSUERS)`);
    }
  }
  if (cfg.agent.jwtSecret === DEV_AGENT_SECRET || cfg.agent.jwtSecret.length < MIN_SECRET_LEN) {
    missing.push('AGENT_JWT_SECRET (set a strong secret, ≥16 chars)');
  }
  if (cfg.secrets.masterKey === DEV_SECRET_KEY || cfg.secrets.masterKey.length < MIN_SECRET_LEN) {
    missing.push('CP_SECRET_KEY (set a 32-byte hex/base64 key, not a weak passphrase)');
  }
  // NB the "gate 2 on ⇒ introspect URL + app key" pair is NOT here — it is an ENVIRONMENT-
  // INDEPENDENT invariant and lives in `validateConfigInvariants`, called above. See its docblock.
  //
  // Phase 4 / F.2: when license ISSUANCE is enabled, onboarding mints per-tenant tokens against the
  // licenses admin API via a `secure-apps` service account — without the base URL + SA creds every
  // onboard/suspend would 502. Required only when the flag is on, so a flag-OFF prod (the F.2 ship
  // state) stays valid and deployable; ops sets these when flipping issuance on.
  if (cfg.license.issuanceEnabled) {
    if (!cfg.license.adminBaseUrl) missing.push('LICENSE_ADMIN_BASE_URL (license issuance enabled)');
    if (!cfg.license.sa.tokenUrl) missing.push('LICENSE_SA_TOKEN_URL (license issuance enabled)');
    if (!cfg.license.sa.clientId) missing.push('LICENSE_SA_CLIENT_ID (license issuance enabled)');
    if (!cfg.license.sa.clientSecret) {
      missing.push('LICENSE_SA_CLIENT_SECRET (license issuance enabled)');
    }
  }
  // Phase 5 / 5D: the fr-bridge is LIVE ('fr' ∈ SUPPORTED_FORWARD_KINDS, routes/delivery.ts). Every fr
  // forward mints the commonpractice-bridge SA JWT (the project-request-writer caller identity) and runs
  // Gate 2 against the connector's stored fr license token. Without the SA creds the forward can't
  // authenticate; without an introspect URL Gate 2 fails-closed (402) on every fr forward. Required in
  // prod. NB: NOT FR_BASE_URL — the adapter posts to the per-connector target.base_url, not config.fr.baseUrl.
  if (!cfg.fr.sa.tokenUrl) missing.push('FR_BRIDGE_TOKEN_URL (fr bridge live)');
  if (!cfg.fr.sa.clientId) missing.push('FR_BRIDGE_CLIENT_ID (fr bridge live)');
  if (!cfg.fr.sa.clientSecret) missing.push('FR_BRIDGE_CLIENT_SECRET (fr bridge live)');
  if (!cfg.fr.licenseIntrospectUrl && !cfg.license.introspectUrl) {
    missing.push('FR_LICENSE_INTROSPECT_URL or LICENSE_INTROSPECT_URL (fr Gate 2)');
  }
  // ⛔ PRODUCTION NEVER RUNS ON THE MOCK LLM. `llm.mode` falls back to 'mock' for ANY value but
  // 'openai_compatible' (a typo, a stale `LLM_MODE=anthropic`, an unset var), and the mock answers
  // every flow run and agent turn with canned text and HTTP 200 — prod would look healthy while no
  // real inference happened. Refuse to boot instead. The router URL is required with it: an empty
  // OPENAI_BASE_URL in openai_compatible mode resolves keyless calls to the stub just the same.
  if (cfg.llm.mode !== 'openai_compatible') {
    missing.push(
      'LLM_MODE=openai_compatible (production must broker to the inference-router, never the mock LLM)',
    );
  }
  if (!cfg.llm.openaiBaseUrl.trim()) {
    missing.push('OPENAI_BASE_URL (the in-cluster inference-router; required in production)');
  }
  // Multi-tenant production executes user-authored code. The same-pod subprocess and a Kubernetes
  // pod on the cluster's default runtime are not security boundaries, so production fails closed.
  if (cfg.run.backend !== 'k8s') {
    missing.push('RUN_BACKEND=k8s (required for production user-code isolation)');
  } else {
    if (!cfg.run.k8s.image) missing.push('RUN_IMAGE (required for RUN_BACKEND=k8s)');
    if (!/(kata|gvisor)/i.test(cfg.run.k8s.runtimeClass)) {
      missing.push('RUN_RUNTIME_CLASS (must name a verified Kata or gVisor runtime class)');
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[config] invalid production configuration: ${missing.join(', ')}`,
    );
  }
}

// ---- Support contact (SUPPORT_EMAIL) ----
// The address behind the app shell's "Feedback" link (a `mailto:`), carried to the SPA on /api/me
// as `supportEmail`. UNSET IS A SUPPORTED STATE: the field is `null` and the SPA renders no link —
// never a guessed address. A value that is not a plain `local@domain` address is treated as unset
// rather than put into a `mailto:` (it is concatenated into an href). A FUNCTION, read live like
// connectorNotificationsConfig above, so tests can toggle it per case.
const SUPPORT_EMAIL_RE = /^[^\s@<>()"',;:\\?#&%/]+@[^\s@<>()"',;:\\?#&%/]+\.[^\s@<>()"',;:\\?#&%/]+$/;
export function supportEmail(): string | null {
  const v = (process.env.SUPPORT_EMAIL || '').trim();
  return v && v.length <= 254 && SUPPORT_EMAIL_RE.test(v) ? v : null;
}
