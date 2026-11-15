// src/host/onboarding-integrity.ts — the reconciler for the two failure modes controlled
// onboarding can silently leave behind: a TENANT with no licence, and a PERSON with no tenant.
//
// WHY THIS EXISTS. F.2 licence issuance (services/license-provisioning.ts) and controlled
// onboarding (routes/admin.ts, `signup_approvals`) both have KNOWN windows where a step can fail
// after the row that names it as "done" is already committed — a licences-service 502 between
// tenant-create and token-write, an approval whose Keycloak/tenant-assignment step never
// completed. Nothing watched either window. One tenant sat unlicensed (every screen 402ing) and
// one signup sat `pending` for 83 DAYS before anyone noticed, and the only reason either surfaced
// was a support ticket, not a metric. This file is the census + repair pass that makes both
// visible, and fixes the one of the two that is safe to fix without a human.
//
// TWO CENSUSES, ONE REPAIR. Deliberately asymmetric:
//   • Unlicensed tenants — REPAIRED. `ensureTenantLicense` is already idempotent and
//     side-effect-safe to retry (license-provisioning.ts's own docblock), and a stuck tenant is
//     pure loss (every member 402s) with no ambiguity about what "fixed" means.
//   • Stranded signups — READ ONLY, FOREVER. A merged PR (#350) deliberately made tenant
//     assignment a HUMAN decision: auto-assigning a pending signup to a tenant is a data-placement
//     call (which company does this person work for) that the platform cannot safely guess, and
//     getting it wrong leaks one tenant's data to a stranger's user row. See the guard comment on
//     `censusSignupStrand` below before "fixing" this into a repair — that removes #350's intent,
//     not restores it.
import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  db,
  tenants,
  users,
  signupApprovals,
  memberEntitlements,
  metricsClient,
} from '../db/client';
import { config } from '../config';
import {
  ensureTenantLicense,
  ensureMemberEntitlement,
  tenantHoldsTenantLevelLicence,
  revokeMemberEntitlement,
  rehomeTenantLicence,
  settlePendingRevokes,
  SYSTEM_TENANT_ID,
  MEMBER_CLAIM_LEASE_MS,
  isLicenceBusy,
} from '../services/license-provisioning';
import { ensurePlatformInference } from '../services/tenant-inference';
import {
  licensesAdmin,
  adminMethod,
  licencesAdminConfigured,
  NEW_TENANT_BYO_MODE,
} from '../services/licenses-admin';
import { registerOwnLicencesTenant } from '../services/tenant-service';
import { HttpError } from '../utils/http';
import { expireInvites } from '../services/invite-service';
import { reconcileProvisioning } from '../services/tenant-provisioning';
import { repairRejectedSignups } from '../services/signup-reject-repair';
import { claimTick, TICK_LOCK, TICK_MIN_INTERVAL_MS } from './tick-locks';
import { incCounter } from './metrics';
import { log } from './logger';

export interface OnboardingIntegrityCensus {
  readonly tenantsUnlicensedResolvable: number;
  readonly tenantsUnlicensedUnresolvable: number;
  readonly signupStrandPending: number;
  readonly signupStrandOldestAgeSeconds: number;
  /**
   * ⚠️ WHY THESE TWO EXIST AND `signupStrandPending` IS NOT ENOUGH. Measured in production
   * 2026-09-04: **3** live users hold `tenant_id IS NULL`, but only **1** `signup_approvals` row is
   * pending. The other two have NO approval row at all, so they are invisible to the super_admin
   * onboarding queue — the very queue PR #350 added to make stranding visible. #350's
   * `recordSignupStrand` only fires inside `ensureUser`, so anyone who was already stranded when it
   * merged was never enqueued and never will be.
   *
   * That makes `queued=false` a STRICTLY WORSE state than `queued=true`: a queued person is visible
   * and ignored; an unqueued one cannot be seen at all. It is therefore the alertable quantity, and
   * counting `signup_approvals` alone would have under-reported the real population by 2 of 3.
   */
  readonly usersWithoutTenantQueued: number;
  readonly usersWithoutTenantUnqueued: number;
}

// ---------------------------------------------------------------------------------------------
// Read side: a TTL-cached census, for whatever renders /metrics. Deliberately its own DB path,
// NOT the `db` import the repair tick below uses.
//
// ⛔ WHY `metricsClient` AND NOT `db`. `db` (db/client.ts) is a Proxy that, with NO ambient
// request/system context — which is exactly the case for a bare metrics-scrape call — falls back
// to `poolDb`, i.e. `queryClient`: the pod's SIX REQUEST connections. scheduler-freshness.ts
// documents the incident that made this the wrong choice for anything /metrics reads: six stalled
// scrapes on that pool exhausted every request connection in the pod and turned the observability
// endpoint into a second casualty of the outage it exists to report. `metricsClient` is the same
// dedicated `max: 1` client scheduler-freshness.ts uses for the identical reason; this read shares
// it rather than opening a second one, since both are TTL-cached and scrape-driven, so contention
// is at most one queued query.
//
// The cache/timeout SHAPE below is copied from scheduler-freshness.ts's `getSchedulerFreshness`
// intentionally — 60s TTL, an outer JS race, an inner `SET LOCAL statement_timeout`, and on
// failure: NEVER rethrow, NEVER clear the cache, serve the last known numbers. Full reasoning for
// every one of those choices is written there; it is not re-derived here.

/** 60s, same value and same justification as scheduler-freshness.ts: the only thing this feeds is
 *  an alert measured in HOURS/DAYS (the 83-day case), so a minute of cache age cannot change the
 *  verdict, and halving it would double the query rate to buy precision nobody reads. */
export const ONBOARDING_INTEGRITY_TTL_MS = 60_000;

/** Outer JS-level bound — covers a stall BEFORE the statement runs (connect/TLS/pooler), which
 *  `statement_timeout` cannot see. `Promise.race` only abandons the promise, not the query. */
export const ONBOARDING_INTEGRITY_READ_TIMEOUT_MS = 2_000;

/** Inner Postgres-level bound, strictly below the outer one so Postgres — not the JS race — ends
 *  the statement and returns the connection. Via `SET LOCAL`, not a connection param: both prod
 *  poolers drop `statement_timeout` from the startup packet (see db/client.ts on `metricsClient`). */
export const ONBOARDING_INTEGRITY_STATEMENT_TIMEOUT_MS = 1_500;

/** Bumped on a failed/timed-out read. Not in `host/metrics.ts`'s `PRESEEDED_COUNTERS` — this file
 *  cannot edit that list — so it is lazily created like most counters; whoever wires the gitops
 *  alert for it should pre-seed it there first (see the note on that list for why). */
export const ONBOARDING_INTEGRITY_READ_FAILURE_COUNTER = 'onboarding_integrity_read_failures_total';

/**
 * ⛔ THE UNDELIVERABLE-DOMAIN EXCLUSION FOR CENSUS C. Read this before widening or deleting it.
 *
 * THE PRINCIPLE: an alert must name something a human can act on. RFC 6762 §3 reserves `.local`
 * for link-local mDNS and RFC 2606 §2 reserves `.invalid` for names guaranteed never to resolve.
 * Neither is in the global DNS, neither has an MX record and neither can ever be given one, so an
 * address inside them CANNOT RECEIVE MAIL. Every step past the onboarding queue needs that mail to
 * work: an approval provisions a realm identity the person must confirm, and consumes a seat
 * against `tenants.max_members`. Such an account therefore can never complete onboarding no matter
 * what a super_admin decides — approve and reject are equally meaningless — so counting it in
 * `commonpractice_users_without_tenant{queued="false"}` makes `CommonPracticeSignupStrandedUnqueued`
 * fire FOREVER on a row nobody can ever action. An alert that cannot be answered is not a signal;
 * it is a permanent red light that trains its readers to ignore the panel it lives on. Census C
 * measures the GENUINELY-ACTIONABLE stranded population, and this clause is what makes that true.
 *
 * ⛔ THE ALTERNATIVE NOT TAKEN, stated so nobody has to rediscover it: the rows this excludes are
 * demo seed fixtures (`src/db/seed-*.ts`) that arguably SHOULD NOT EXIST IN THE PRODUCTION DATABASE
 * AT ALL. Deleting them, or gating the demo seeds out of prod, would empty this predicate's
 * population rather than filter it, and is very likely the better fix. It is also a much larger
 * question — what the demo tenants are for, who depends on them, what a prod seed run is allowed to
 * write — and it is NOT settled here. This clause fixes the metric; it does not bless the data.
 *
 * ⛔ WHY THESE TWO LABELS AND NOT THE REST OF RFC 2606. `.test` and `.example` are reserved too,
 * but THIS REPO USES `.test` AS ITS STAND-IN FOR A DELIVERABLE ADDRESS — `@m0088.test`,
 * `@onboarding-integrity.test`, `@stranded.test` are the fixtures that prove a real person IS
 * counted. Excluding `.test` would make every one of those assertions vacuously true, which is the
 * exact failure mode this clause exists to prevent, one level up. Only the two labels that are
 * genuinely unroutable AND never used here as a proxy for a real address are excluded.
 *
 * ⛔ NEVER REPLACE THIS WITH A LIST OF EMAIL ADDRESSES. A name-based exclusion covers the addresses
 * that exist today and admits the next one silently. The predicate is on the DOMAIN and nothing
 * else.
 *
 * ⚠️ THIS PATTERN MUST STAY CHARACTER-FOR-CHARACTER IDENTICAL TO THE ONE IN
 * `migrations/0088_backfill_pre_0027_signup_approvals.sql`. 0088 backfills exactly the rows this
 * census counts; if the two predicates select different sets, the backfill either leaves the alert
 * firing (census wider) or writes queue rows nobody is counting (census narrower) — the very bug
 * this clause is fixing. `tests/migration-0088-signup-backfill.test.ts` pins the equality.
 *
 * Shape: `@` then an optional single sub-label group, then the reserved TLD, anchored to the END of
 * the address — so `@local`, `@commonpractice.local` and `@example.invalid` match, while a LOCAL
 * PART like `a.local@example.com` does not. Applied with `!~*` (case-insensitive) because
 * `users.email` is not normalised on write. Bound as a query PARAMETER rather than inlined, so the
 * backslash is a real backslash and not a template-literal escape silently eaten by JS.
 */
export const UNDELIVERABLE_EMAIL_DOMAIN_PATTERN = '@([^@]+\\.)?(local|invalid)$';

async function readOnboardingIntegrityCensusFromDb(): Promise<OnboardingIntegrityCensus> {
  const { tenantRow, strandRow, orphanRow } = await metricsClient.begin(async (tx) => {
    await tx.unsafe(
      `SET LOCAL statement_timeout = ${ONBOARDING_INTEGRITY_STATEMENT_TIMEOUT_MS}`,
    );
    // Resolvable/unresolvable in ONE round trip via LATERAL, rather than the per-tenant N+1 the
    // repair pass below uses — this path only needs the COUNTS, never the actual subject id, so
    // there is no reason to pay per-tenant queries against the `max: 1` metrics connection.
    const [tenantRow] = await tx<Record<string, unknown>[]>`
      SELECT
        count(*) FILTER (WHERE m.subject_id IS NOT NULL)::int AS resolvable,
        count(*) FILTER (WHERE m.subject_id IS NULL)::int     AS unresolvable
      FROM tenants t
      LEFT JOIN LATERAL (
        SELECT u.id AS subject_id
        FROM users u
        WHERE u.tenant_id = t.id AND u.deleted_at IS NULL
        ORDER BY u.created_at ASC
        LIMIT 1
      ) m ON true
      WHERE t.status = 'active' AND t.offboarded_at IS NULL AND t.license_token_encrypted IS NULL
    `;
    const [strandRow] = await tx<Record<string, unknown>[]>`
      SELECT
        count(*)::int AS pending,
        extract(epoch FROM (now() - min(created_at))) AS oldest_age_seconds
      FROM signup_approvals
      WHERE status = 'pending'
    `;
    // Census C — the REAL stranded population, split by whether the onboarding queue can see them.
    // Platform staff (`role = 'platform'`, which `ensureUser` sets on a workspace-less super_admin)
    // are excluded: they are never queued by design, so counting them is an unanswerable alert.
    // Joined on lower(email) because that is the key `signup_approvals`' own partial unique index
    // uses (`lower(email) WHERE status='pending'`, migration 0027); `keycloak_sub` is nullable on
    // that table and NULL on the live pending row, so it cannot be the join key.
    //
    // ⛔ The `!~*` clause excludes addresses in the reserved, unroutable `.local` / `.invalid` TLDs,
    // so BOTH buckets count only genuinely-actionable strandings. Full reasoning — including the
    // larger question this deliberately does NOT settle — on
    // UNDELIVERABLE_EMAIL_DOMAIN_PATTERN above. It is the SAME predicate migration 0088 backfills
    // on; changing one without the other re-opens the bug both exist to close.
    const [orphanRow] = await tx<Record<string, unknown>[]>`
      SELECT
        count(*) FILTER (WHERE s.id IS NOT NULL)::int AS queued,
        count(*) FILTER (WHERE s.id IS NULL)::int     AS unqueued
      FROM users u
      LEFT JOIN LATERAL (
        SELECT sa.id FROM signup_approvals sa WHERE lower(sa.email) = lower(u.email) LIMIT 1
      ) s ON true
      WHERE u.tenant_id IS NULL
        AND u.deleted_at IS NULL
        AND u.role <> 'platform'
        AND u.email !~* ${UNDELIVERABLE_EMAIL_DOMAIN_PATTERN}
    `;
    return { tenantRow, strandRow, orphanRow };
  });
  return {
    tenantsUnlicensedResolvable: Number(tenantRow?.resolvable ?? 0),
    tenantsUnlicensedUnresolvable: Number(tenantRow?.unresolvable ?? 0),
    signupStrandPending: Number(strandRow?.pending ?? 0),
    // `extract(epoch …)` is numeric → postgres-js hands it back as a STRING (precision, same note
    // as scheduler-freshness.ts). `min()` over zero pending rows is NULL, not 0 — that IS "0 when
    // none", handled by `??` rather than by the SQL, so a genuine 0-second-old row and an empty
    // table are never confused upstream of this line.
    signupStrandOldestAgeSeconds: Number(strandRow?.oldest_age_seconds ?? 0),
    usersWithoutTenantQueued: Number(orphanRow?.queued ?? 0),
    usersWithoutTenantUnqueued: Number(orphanRow?.unqueued ?? 0),
  };
}

type Reader = () => Promise<OnboardingIntegrityCensus>;

let reader: Reader = readOnboardingIntegrityCensusFromDb;
/** Last SUCCESSFUL read. `undefined` until one succeeds — never a fabricated zero, which would
 *  read as "everything is fine" on a cold pod that has not checked yet. */
let cached: OnboardingIntegrityCensus | undefined;
/** When a read was last ATTEMPTED (success or failure) — this, not `cached`, drives the TTL. */
let lastAttemptAt = -Infinity;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`onboarding integrity read exceeded ${ms}ms`)), ms);
  });
  return Promise.race([p, bomb]).finally(() => clearTimeout(timer));
}

async function refresh(): Promise<void> {
  try {
    cached = await withTimeout(reader(), ONBOARDING_INTEGRITY_READ_TIMEOUT_MS);
  } catch (err) {
    // ⛔ NEVER RETHROW, NEVER CLEAR `cached` — see scheduler-freshness.ts's identical guard. A
    // failed read serves the last known numbers (still true — they describe tenants/signups that
    // really were in that state) rather than turning /metrics into a second outage symptom.
    incCounter(ONBOARDING_INTEGRITY_READ_FAILURE_COUNTER);
    log.warn('onboarding_integrity_read_failed', { component: 'onboarding-integrity', err });
  }
}

/**
 * The cached census. NEVER throws, NEVER blocks past `ONBOARDING_INTEGRITY_READ_TIMEOUT_MS`,
 * queries at most once per `ONBOARDING_INTEGRITY_TTL_MS`. `undefined` = no successful read yet;
 * the caller (the metrics renderer) must render nothing rather than a fabricated gauge — same
 * contract as `getSchedulerFreshness`, same reason.
 */
export async function readOnboardingCensus(
  now: number = Date.now(),
): Promise<OnboardingIntegrityCensus | undefined> {
  if (now - lastAttemptAt < ONBOARDING_INTEGRITY_TTL_MS) return cached;
  lastAttemptAt = now; // stamped BEFORE the await — bounds the rate even against a reliably-failing read
  await refresh();
  return cached;
}

/** Test seam: swap the DB read for a fake (call with no argument to restore the real one). */
export function __setOnboardingIntegrityReaderForTests(fake?: Reader): void {
  reader = fake ?? readOnboardingIntegrityCensusFromDb;
}

/** Test seam: forget the cache and the TTL clock. */
export function __resetOnboardingIntegrityCacheForTests(): void {
  cached = undefined;
  lastAttemptAt = -Infinity;
}

// ---------------------------------------------------------------------------------------------
// Write side: the claimed tick. Runs on the OWNER pool (via `claimTick` → `runSystemTick` →
// `runAsSystem` — see tick-locks.ts), so every query below uses the plain `db` import: inside
// that ambient SYSTEM context the `db` Proxy binds to `ownerDb` with no RLS to route around, and
// both `tenants` and `users` are platform/global tables outside RLS entirely (migration 0028
// §COVERAGE) — same reason `admin.ts`'s `licenseSubjectFor` needs no `runAsSystem` of its own.

/**
 * The subject to bind a repaired tenant's licence to: its oldest LIVE member.
 *
 * Copied from `routes/admin.ts:279-287` (`licenseSubjectFor`) — SAME predicate
 * (`eq(tenant_id)` + `isNull(deleted_at)` + `orderBy(asc(created_at))` + `limit(1)`) — but
 * ⛔ WITHOUT its `?? actorId` fallback. That fallback exists because `licenseSubjectFor` runs
 * inside an authenticated super_admin request, where "nobody else, so bind it to the admin who
 * asked" is a defensible last resort. A background job has no actor to fall back to — inventing
 * one would bind a workspace's licence to whichever pod happened to run the tick, which is not a
 * person and cannot legitimately be the licence's named subject. A tenant with no live member is
 * therefore UNRESOLVABLE here, full stop: counted, never guessed.
 */
async function oldestLiveMemberId(tenantId: string): Promise<string | undefined> {
  const [oldest] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at)))
    .orderBy(asc(users.created_at))
    .limit(1);
  return oldest?.id;
}

/**
 * Census A + repair. Predicate: `status='active' AND offboarded_at IS NULL AND
 * license_token_encrypted IS NULL` — a live, non-offboarded tenant with no stored token, i.e.
 * F.2 issuance started (or should have) and never finished.
 *
 * Each tenant is repaired INDIVIDUALLY, in its own try/catch: `ensureTenantLicense` calls an
 * external licences service per tenant, and one tenant's outage must not abort the sweep for
 * every other tenant behind it in the loop — same isolation `checkTenantBudgets` (budget-service)
 * uses for its per-budget OpenRouter calls.
 */
async function repairUnlicensedTenants(): Promise<{
  resolvable: number;
  unresolvable: number;
  failed: number;
}> {
  const unlicensed = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(
      and(
        eq(tenants.status, 'active'),
        isNull(tenants.offboarded_at),
        isNull(tenants.license_token_encrypted),
      ),
    );

  let resolvable = 0;
  let unresolvable = 0;
  let failed = 0;

  for (const { id: tenantId } of unlicensed) {
    const subjectId = await oldestLiveMemberId(tenantId);
    if (!subjectId) {
      unresolvable++;
      incCounter('license_repair_declined_unresolvable_total');
      continue;
    }
    resolvable++;
    incCounter('license_repair_attempted_total');
    try {
      await ensureTenantLicense(tenantId, subjectId);
      incCounter('license_repair_succeeded_total');
    } catch (err) {
      failed++;
      incCounter('license_repair_failed_total');
      log.warn('onboarding_integrity_repair_failed', {
        component: 'onboarding-integrity',
        tenantId,
        err,
      });
    }
  }

  return { resolvable, unresolvable, failed };
}

/**
 * Census B. ⛔ READ ONLY — DELIBERATELY, PERMANENTLY. Counts `signup_approvals` rows still
 * `status='pending'` and the age in seconds of the oldest one (0 when there are none).
 *
 * This function must NEVER:
 *   • write anything (no UPDATE, no INSERT),
 *   • touch `users.tenant_id`,
 *   • call Keycloak.
 * PR #350 deliberately made tenant assignment on a signup a HUMAN decision (routes/admin.ts's
 * approve flow) — auto-picking a tenant for a stranger is a data-placement guess the platform
 * cannot make safely, and getting it wrong hands one company's workspace to another company's
 * employee. The 83-day stranded case this file exists to surface is a REASON TO ALERT A HUMAN
 * FASTER, not licence to make this job decide for them. If a future change makes this "repair"
 * anything, it has silently reverted #350 — check that PR before ever adding a write here.
 */
async function censusSignupStrand(): Promise<{ pending: number; oldestAgeSeconds: number }> {
  const [row] = await db
    .select({
      pending: sql<number>`count(*)::int`,
      oldestAgeSeconds: sql<number | null>`extract(epoch FROM (now() - min(${signupApprovals.created_at})))`,
    })
    .from(signupApprovals)
    .where(eq(signupApprovals.status, 'pending'));
  // Same numeric-as-string caution as the metrics-side query above — `Number()` regardless of the
  // declared `sql<...>` type, which is a compile-time label only and does not coerce the runtime value.
  const raw = row?.oldestAgeSeconds;
  return { pending: Number(row?.pending ?? 0), oldestAgeSeconds: raw == null ? 0 : Number(raw) };
}

/**
 * Census A2 + repair: LIVE MEMBERS WITH NO SEAT (migration 0089).
 *
 * Predicate: a live (`deleted_at IS NULL`) member of an active, non-offboarded tenant with no
 * `member_entitlements` row in `active` or `pending`. `ensureMemberEntitlement` is idempotent and
 * claim-leased, so re-running this is free and two replicas cannot both mint.
 *
 * ⭐ THIS IS THREE JOBS IN ONE SWEEP, WHICH IS WHY IT LIVES HERE RATHER THAN IN A ONE-SHOT SCRIPT:
 *   • the BACKFILL — every member who predates 0089 gets their entitlement without a migration
 *     needing to make external HTTP calls;
 *   • the JIT/SSO completion — `ensureUser` deliberately does NOT mint (it runs inside a
 *     per-request transaction on EVERY authenticated request, and minting there would hold a DB
 *     transaction open across three external round trips). So a JIT arrival is denied by the gate
 *     (`license_seat_required`) and seated here instead — an unknown SSO user never gets in on
 *     credit, which is the documented posture;
 *   • the RETRY for a mint that failed mid-saga and parked the row at `error`.
 *
 * ⚠️ IT DOES NOT SEAT PLATFORM STAFF. `users.role = 'platform'` is excluded because billing counts
 * a seat as a licences-service `human_subjects` entry — minting for an operator would put platform
 * staff on the customer's invoice. A super_admin scoped into a tenant is excluded by the same rule
 * in the gate.
 *
 * Per-member try/catch for the same reason `repairUnlicensedTenants` uses one: an external call per
 * member, and one tenant's licences outage must not abort the sweep for everyone behind it.
 */
async function repairUnseatedMembers(): Promise<{
  seated: number;
  failed: number;
  skippedTenantLicensed: number;
}> {
  const unseated = await db
    .select({ tenantId: users.tenant_id, userId: users.id, keycloakSub: users.keycloak_sub })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenant_id))
    .where(
      and(
        isNull(users.deleted_at),
        ne(users.role, 'platform'),
        // ⛔ FAIL CLOSED ON AN UNPROVEN IDENTITY. This sweep sees a PREDICATE, not provenance, and
        // `db/seed-tenant-showcase.ts` inserts `role:'employee'` rows with NO id — so `users.id`
        // defaults to `uuidv7()` and is not a realm subject at all. Minting for one registers a
        // licences-service Subject keyed on a value that can never authenticate AND counts it as a
        // billable seat. `keycloak_sub` is written by `upsertLocalUserTx` (the onboarding paths) and
        // backfilled by `ensureUser` on the next authenticated request, so its PRESENCE is the proof
        // this sweep needs; its absence means "nobody has ever authenticated as this row", which is
        // precisely when we must not invent an identity for it.
        isNotNull(users.keycloak_sub),
        eq(tenants.status, 'active'),
        isNull(tenants.offboarded_at),
        // ⛔ A `pending` row counts as seated ONLY while its claim lease is live. `pending` is written
        // BEFORE the central mint, so a crash between the two leaves one behind forever — and when this
        // predicate excluded every `pending` row, the sweep never handed it back to
        // `ensureMemberEntitlement` (which DOES reclaim an expired lease). The member stayed denied
        // (`license_seat_required`) until a human re-ran onboarding. Past the lease, re-offer it.
        sql`not exists (
          select 1 from member_entitlements me
           where me.tenant_id = ${users.tenant_id}
             and me.user_id = ${users.id}
             and (me.status = 'active'
                  or (me.status = 'pending'
                      and me.updated_at >= now() - make_interval(secs => ${MEMBER_CLAIM_LEASE_MS / 1000})))
        )`,
      ),
    );

  let seated = 0;
  let failed = 0;
  let skippedTenantLicensed = 0;
  // ⭐ TENANT-LEVEL LICENCE, ASKED ONCE PER TENANT PER SWEEP. Since the tenant-level ruling
  // (2026-09-28, #415) a member of a tenant holding its svc-held bundle licence gets NO
  // `member_entitlements` row — `ensureMemberEntitlement` returns `tenant_licensed` and writes
  // nothing. So the predicate above re-selects every such member on every tick, forever. Without
  // this map each of them cost one licences lookup and one `attempted` bump per tick (a counter
  // that then read as a standing repair backlog that can never drain). With it: one lookup per
  // tenant, and those members are counted as SKIPPED, not attempted.
  //
  // Only REAL answers are cached. `true` → skip. `false` → mint exactly as before — and that
  // includes the helper's "cannot look it up" `false` (a client without `getActiveLicense`), which
  // is "not known to hold one", never "licensed". A THROW (licences outage) is not an answer: that
  // tenant's members are failed once, logged once, and retried next sweep.
  // Gated on issuance exactly like `ensureMemberEntitlement` step 0 — with issuance off the sweep
  // must not start making licences calls it never made before.
  const tenantLicensed = new Map<string, boolean>();
  const lookupFailed = new Set<string>();
  for (const row of unseated) {
    if (!row.tenantId) continue; // a user with no home tenant has no seat to hold
    if (!row.keycloakSub) continue; // belt to the predicate's braces — never mint an unproven subject
    if (config.license.issuanceEnabled) {
      if (lookupFailed.has(row.tenantId)) {
        failed++;
        incCounter('member_seat_repair_failed_total');
        continue;
      }
      let holds = tenantLicensed.get(row.tenantId);
      if (holds === undefined) {
        try {
          holds = await tenantHoldsTenantLevelLicence(row.tenantId);
          tenantLicensed.set(row.tenantId, holds);
        } catch (err) {
          lookupFailed.add(row.tenantId);
          failed++;
          incCounter('member_seat_repair_failed_total');
          log.warn('onboarding_integrity_seat_repair_tenant_lookup_failed', {
            component: 'onboarding-integrity',
            tenantId: row.tenantId,
            err,
          });
          continue;
        }
      }
      if (holds) {
        skippedTenantLicensed++;
        incCounter('member_seat_repair_skipped_tenant_level_total');
        continue;
      }
    }
    incCounter('member_seat_repair_attempted_total');
    try {
      const out = await ensureMemberEntitlement(row.tenantId, row.userId, row.keycloakSub);
      if (out.state === 'active') {
        seated++;
        incCounter('member_seat_repair_succeeded_total');
      } else if (out.state === 'tenant_licensed') {
        // The licence appeared between our lookup and this call. Nothing was minted; remember it so
        // the tenant's remaining members this sweep skip without another round trip.
        tenantLicensed.set(row.tenantId, true);
        skippedTenantLicensed++;
        incCounter('member_seat_repair_skipped_tenant_level_total');
      }
    } catch (err) {
      failed++;
      incCounter('member_seat_repair_failed_total');
      log.warn('onboarding_integrity_seat_repair_failed', {
        component: 'onboarding-integrity',
        tenantId: row.tenantId,
        userId: row.userId,
        err,
      });
    }
  }
  return { seated, failed, skippedTenantLicensed };
}

/**
 * Census A3 + repair: SEATS STUCK MID-RELEASE.
 *
 * ⛔ EVERY ROW THIS FINDS IS COSTING THE CUSTOMER MONEY. `revoking` means an offboard denied access
 * but the licences service did not acknowledge the revoke — deliberately left that way rather than
 * tombstoned, because an unreleased seat must never be indistinguishable from a released one. Until
 * this sweep clears it, the member is gone and the tenant is still billed for their
 * `human_subjects` entry. That is why the failure counter here is worth an alert and the seat-repair
 * one above mostly is not.
 */
async function releaseStuckSeats(): Promise<{ released: number; failed: number }> {
  const stuck = await db
    .select({ tenantId: memberEntitlements.tenant_id, userId: memberEntitlements.user_id })
    .from(memberEntitlements)
    .where(eq(memberEntitlements.status, 'revoking'));

  let released = 0;
  let failed = 0;
  for (const row of stuck) {
    try {
      await revokeMemberEntitlement(row.tenantId, row.userId);
      released++;
      incCounter('member_seat_release_retry_succeeded_total');
    } catch (err) {
      failed++;
      incCounter('member_seat_release_retry_failed_total');
      log.warn('onboarding_integrity_seat_release_failed', {
        component: 'onboarding-integrity',
        tenantId: row.tenantId,
        userId: row.userId,
        hint: 'the seat is still ACTIVE upstream and the tenant is still being billed for it',
        err,
      });
    }
  }
  return { released, failed };
}

/** Tenants whose name conflict was already logged by this process — logged once, then counted. */
const loggedNameConflicts = new Set<string>();

/**
 * Census A4 + repair: TENANTS CP KNOWS ABOUT AND THE LICENCES REGISTRY DOES NOT.
 *
 * Only tenants with `central_link IS NULL` — created before CP registered centrally at create, or in
 * a deployment without a licences service. `services/tenant-service.ts createTenant` registers CP's
 * own licences tenant BEFORE inserting the CP row and stamps `central_link`, so new tenants never
 * reach here. This sweep registers the tenant under its CP SLUG — no suffix, the same single name
 * createTenant uses on both sides — and stores it as `licences_name`.
 * A tenant found registered (or registered by this sweep) is stamped `registered` and not probed
 * again.
 *
 * ⛔ THE POSTURE IS ONLY EVER SET FOR A TENANT THAT WAS NOT THERE. Re-asserting
 * `NEW_TENANT_BYO_MODE` on an existing registry tenant would revert an operator's deliberate
 * `byo_required`, moving that customer's spend onto the platform credential.
 *
 * ⚠️ `isTenantRegistered` THROWS on anything but a 2xx or the registry's own
 * `tenant_not_found_in_registry` 404, so a licences outage counts as `failed`, never "unregistered".
 *
 * A slug CP already holds on another of its OWN registry tenants (`licences_name_unavailable`;
 * names are unique per owning app since licences migration 050) cannot be fixed by retrying: it is
 * logged ONCE per tenant per process (`tenant_central_name_conflict`) and counted, not error-logged
 * every five minutes.
 */
async function repairUnregisteredTenants(): Promise<{
  checked: number;
  registered: number;
  failed: number;
  nameConflicts: number;
}> {
  // Not `config.license.issuanceEnabled` — registering a tenant is not minting a licence. See
  // `licencesAdminConfigured`. Dev/CI/tests configure neither, so this sweep is a clean no-op there.
  if (!licencesAdminConfigured()) return { checked: 0, registered: 0, failed: 0, nameConflicts: 0 };

  const live = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(
      and(
        eq(tenants.status, 'active'),
        isNull(tenants.offboarded_at),
        isNull(tenants.central_link),
      ),
    );
  const markRegistered = (id: string, licencesName: string) =>
    db
      .update(tenants)
      .set({
        central_link: 'registered',
        central_linked_at: new Date(),
        licences_name: sql`coalesce(${tenants.licences_name}, ${licencesName})`,
      })
      .where(and(eq(tenants.id, id), isNull(tenants.central_link)));

  const client = licensesAdmin();
  let checked = 0;
  let registered = 0;
  let failed = 0;
  let nameConflicts = 0;
  for (const t of live) {
    checked++;
    try {
      if (await adminMethod(client, 'isTenantRegistered')(t.id)) {
        // The name the registry ACTUALLY holds for this id — not the slug (a pre-050 registration
        // may sit under a `-cp` suffix). A client without `getTenant` (test fakes) keeps the slug.
        const held = client.getTenant ? await client.getTenant(t.id) : null;
        await markRegistered(t.id, held?.name ?? t.slug);
        continue;
      }
      incCounter('tenant_registration_repair_attempted_total');
      // The SLUG, never the display name: the registry constrains it to `^[a-z0-9][a-z0-9-]*$`.
      // CP owns its licences tenant; names are unique per owning app, so there is no suffix.
      const name = await registerOwnLicencesTenant(client, t.id, t.slug);
      await adminMethod(client, 'setTenantByoMode')(t.id, NEW_TENANT_BYO_MODE);
      await markRegistered(t.id, name);
      registered++;
      incCounter('tenant_registration_repair_succeeded_total');
    } catch (err) {
      if (err instanceof HttpError && err.code === 'licences_name_unavailable') {
        nameConflicts++;
        incCounter('tenant_central_name_conflict_total');
        if (!loggedNameConflicts.has(t.id)) {
          loggedNameConflicts.add(t.id);
          log.warn('tenant_central_name_conflict', {
            component: 'onboarding-integrity',
            tenantId: t.id,
            slug: t.slug,
            hint:
              'CP already holds another licences tenant with this slug — rename this workspace; ' +
              'retrying cannot resolve it (logged once per process)',
          });
        }
        continue;
      }
      failed++;
      incCounter('tenant_registration_repair_failed_total');
      log.warn('onboarding_integrity_tenant_registration_failed', {
        component: 'onboarding-integrity',
        tenantId: t.id,
        slug: t.slug,
        hint:
          'this workspace is unknown to the licences registry: byo-posture fails closed for it ' +
          '(no platform credential) and its next member onboard will 502 on the mint guard',
        err,
      });
    }
  }
  return { checked, registered, failed, nameConflicts };
}

/** Expire pending invites past `expires_at`. Guarded: a failure is counted, never fatal to the tick. */
async function expirePendingInvites(): Promise<number> {
  try {
    return await expireInvites();
  } catch (err) {
    incCounter('tenant_invite_expire_failed_total');
    log.warn('onboarding_integrity_invite_expiry_failed', { component: 'onboarding-integrity', err });
    return 0;
  }
}

/**
 * Test seam for the two seat sweeps.
 *
 * ⛔ THEY ARE EXPORTED BECAUSE THE PREDICATE IS THE RISK, AND IT CANNOT BE PROVEN ANY OTHER WAY.
 * `repairUnseatedMembers` selects with a drizzle-composed `NOT EXISTS` over interpolated column
 * references — a shape the TYPE CHECKER CANNOT VALIDATE (it is a `sql` template) and that is not
 * the same text as the equivalent hand-written query. Validating hand-written SQL in psql and then
 * shipping the drizzle version is checking a different tree than the one that runs.
 */
/**
 * Re-home every pre-A2 tenant licence onto CP's own cp-tenant holder (`rehomeTenantLicence`).
 *
 * Selects active, licensed workspaces whose holder is NOT a `cp-tenant:` subject (or unknown —
 * pre-0095 rows record none). Each is handled in its own try/catch; once re-homed a tenant no longer
 * matches, so the steady-state tick selects nothing. Gated on issuance like every mint.
 */
/** Tenants whose re-home hit a licences NAME conflict — logged + counted once per process, then
 *  not retried every tick (the same once-per-conflict pattern as `loggedNameConflicts`). */
const rehomeNameConflicts = new Set<string>();
/** Test seam. */
export function __resetRehomeNameConflictsForTests(): void {
  rehomeNameConflicts.clear();
}

async function rehomeLegacyTenantLicences(): Promise<{ rehomed: number; failed: number; nameConflicts: number }> {
  if (!config.license.issuanceEnabled) return { rehomed: 0, failed: 0, nameConflicts: 0 };
  const legacy = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(
      and(
        eq(tenants.status, 'active'),
        isNull(tenants.offboarded_at),
        isNotNull(tenants.license_token_encrypted),
        ne(tenants.id, SYSTEM_TENANT_ID),
        sql`(${tenants.licence_subject_sub} IS NULL OR ${tenants.licence_subject_sub} NOT LIKE 'cp-tenant:%')`,
      ),
    );
  let rehomed = 0;
  let failed = 0;
  let nameConflicts = 0;
  for (const t of legacy) {
    if (rehomeNameConflicts.has(t.id)) continue;
    try {
      const outcome = await rehomeTenantLicence(t.id);
      if (outcome === 'rehomed') {
        rehomed++;
        incCounter('tenant_licence_rehomed_total');
      } else if (outcome === 'name_conflict') {
        nameConflicts++;
        rehomeNameConflicts.add(t.id);
        incCounter('tenant_central_name_conflict_total');
        log.warn('tenant_licence_rehome_name_conflict', {
          component: 'onboarding-integrity',
          tenantId: t.id,
          hint:
            "the licences registry holds this tenant's licences name under another tenant id; it is not " +
            're-homed (its licence stays a person\'s) and not retried this process — rename the workspace',
        });
      }
    } catch (err) {
      failed++;
      incCounter('tenant_licence_rehome_failed_total');
      log.warn('onboarding_integrity_tenant_licence_rehome_failed', {
        component: 'onboarding-integrity',
        tenantId: t.id,
        hint:
          "this workspace's licence is still a member's seat: offboarding that member 402s it. " +
          'Retried every tick.',
        err,
      });
    }
  }
  return { rehomed, failed, nameConflicts };
}
/**
 * Settle every tenant's revoke-pending SET (`tenants.licence_revoke_pending`, 0097). Without this a
 * failed revoke after a swap was permanent: the tenant is on its cp-tenant holder and nothing
 * selected it again.
 *
 * ⛔ UNDER THE PER-TENANT LICENCE LEASE (`settlePendingRevokes`), and never revoking the licence the
 * tenant currently STORES or a live member's seat — those ids are dropped instead. Unleased, a
 * sweep racing a change back to the old terms (licences hands back the queued licence, which the
 * change then stores) revoked the workspace's live licence: a permanent 402. A busy tenant is left
 * for the next tick.
 */
async function retryPendingLicenceRevokes(): Promise<{
  revoked: number;
  dropped: number;
  failed: number;
  busy: number;
}> {
  const out = { revoked: 0, dropped: 0, failed: 0, busy: 0 };
  if (!config.license.issuanceEnabled) return out;
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(sql`cardinality(${tenants.licence_revoke_pending}) > 0`);
  for (const r of rows) {
    try {
      const settled = await settlePendingRevokes(r.id);
      if (!settled) {
        out.busy++;
        continue;
      }
      out.revoked += settled.revoked;
      out.dropped += settled.dropped;
      out.failed += settled.failed;
    } catch (err) {
      out.failed++;
      log.warn('onboarding_integrity_pending_revoke_failed', { component: 'onboarding-integrity', tenantId: r.id, err });
    }
  }
  return out;
}

/**
 * Keep the PLATFORM's own inference-router credential minted (services/tenant-inference.ts
 * `ensurePlatformInference`): platform background work and tenant-less calls carry it instead of the
 * `EMPTY` placeholder the router refuses. Idempotent (a readable token = nothing to do), under the
 * system tenant's licence lease. Returns null when there was nothing to say (already provisioned /
 * skipped), else the outcome, so only real activity reaches the tick log.
 */
async function repairPlatformInference(): Promise<string | null> {
  if (!config.license.issuanceEnabled) return null;
  try {
    // `backoff` / `busy` / already provisioned / skipped: nothing to say this tick.
    const out = await ensurePlatformInference();
    return out.status === 'provisioned' ? 'provisioned' : null;
  } catch (err) {
    if (isLicenceBusy(err)) return null;
    log.error('onboarding_integrity_platform_inference_failed', {
      component: 'onboarding-integrity',
      hint: "platform background LLM work (translation) fails closed until the platform's router licence exists",
      err,
    });
    return 'failed';
  }
}

export const __seatSweepsForTests = {
  reconcileProvisioning,
  repairPlatformInference,
  retryPendingLicenceRevokes,
  repairUnseatedMembers,
  releaseStuckSeats,
  repairUnregisteredTenants,
  rehomeLegacyTenantLicences,
};

async function tick(): Promise<void> {
  // ⭐ REGISTRATION FIRST, AND THE ORDER IS LOAD-BEARING. The licences service refuses to MINT for an
  // unregistered tenant (its FK-backed mint guard), so `repairUnlicensedTenants` and
  // `repairUnseatedMembers` below both 502 for exactly the tenants this sweep fixes. Running it last
  // would mean every tick repaired the registration and then waited five minutes to use it.
  const registrations = await repairUnregisteredTenants();
  const { resolvable, unresolvable, failed } = await repairUnlicensedTenants();
  const rehome = await rehomeLegacyTenantLicences();
  const pendingRevokes = await retryPendingLicenceRevokes();
  const seats = await repairUnseatedMembers();
  const released = await releaseStuckSeats();
  const strand = await censusSignupStrand();
  const invitesExpired = await expirePendingInvites();
  const platformInference = await repairPlatformInference();
  // Creation steps left `pending`/`failed` (0101) — billing terms that billing refused or could not
  // take yet. Per-(tenant, step) claimed and bounded-backoff, so a stuck one costs ≤ 10 attempts.
  const provisioning = await reconcileProvisioning().catch((err) => {
    log.warn('onboarding_integrity_provisioning_sweep_failed', { component: 'onboarding-integrity', err });
    return { attempted: 0, landed: 0, failed: 0, busy: 0 };
  });
  // Rejected signups whose cleanup (offboard the workspace an aborted approve founded, revoke its
  // licence + seats, retire the minted identity, revoke an existing-mode seat/invite) has not finished
  // — services/signup-reject-repair.ts. Never past a blocker: a workspace in use goes `blocked` and
  // waits for a super_admin (the onboarding screen lists it).
  const rejectRepairs = await repairRejectedSignups().catch((err) => {
    log.warn('onboarding_integrity_reject_repair_sweep_failed', { component: 'onboarding-integrity', err });
    return { adopted: 0, attempted: 0, done: 0, failed: 0, blocked: 0 };
  });

  // Only log when there is something to say — an empty, healthy tick every 5 minutes forever is
  // exactly the noise budget-scheduler.ts's `budget_scheduled_check_completed` avoids for the same
  // reason. The strand COUNT is informational read-side state (some pending queue is normal); it is
  // reported here only alongside actual repair activity, and independently via `readOnboardingCensus`
  // for the gauge an alert would actually fire on (the OLDEST age, in hours/days).
  if (
    resolvable > 0 ||
    unresolvable > 0 ||
    failed > 0 ||
    seats.seated > 0 ||
    seats.failed > 0 ||
    released.released > 0 ||
    released.failed > 0 ||
    // ⚠️ `registrations.checked` is NOT in this condition. It is non-zero on every tick of a
    // licences-configured deployment (it counts tenants PROBED, not tenants repaired), so including
    // it would turn this deliberately-quiet log into one line every five minutes forever — the exact
    // noise the comment above rejects. Only the two ACTIVITY counts speak.
    registrations.registered > 0 ||
    registrations.failed > 0 ||
    rehome.rehomed > 0 ||
    rehome.failed > 0 ||
    pendingRevokes.revoked > 0 ||
    pendingRevokes.failed > 0 ||
    invitesExpired > 0 ||
    platformInference !== null ||
    provisioning.attempted > 0 ||
    rejectRepairs.adopted > 0 ||
    rejectRepairs.attempted > 0
  ) {
    log.info('onboarding_integrity_tick_completed', {
      component: 'onboarding-integrity',
      tenantsCentralRegistrationChecked: registrations.checked,
      tenantsCentrallyRegistered: registrations.registered,
      tenantsCentralRegistrationFailed: registrations.failed,
      tenantsCentralNameConflicts: registrations.nameConflicts,
      invitesExpired,
      tenantsUnlicensedResolvable: resolvable,
      tenantsUnlicensedUnresolvable: unresolvable,
      tenantsLicenseRepairFailed: failed,
      tenantLicencesRehomed: rehome.rehomed,
      tenantLicenceRehomeFailed: rehome.failed,
      platformInference,
      rejectedSignupsAdopted: rejectRepairs.adopted,
      rejectedSignupRepairsAttempted: rejectRepairs.attempted,
      rejectedSignupRepairsDone: rejectRepairs.done,
      rejectedSignupRepairsFailed: rejectRepairs.failed,
      rejectedSignupRepairsBlocked: rejectRepairs.blocked,
      oldLicencesRevoked: pendingRevokes.revoked,
      oldLicenceRevokesPending: pendingRevokes.failed,
      membersSeated: seats.seated,
      membersSeatRepairFailed: seats.failed,
      seatsReleased: released.released,
      seatsReleaseFailed: released.failed,
      signupStrandPending: strand.pending,
      signupStrandOldestAgeSeconds: strand.oldestAgeSeconds,
      provisioningStepsAttempted: provisioning.attempted,
      provisioningStepsLanded: provisioning.landed,
      provisioningStepsFailed: provisioning.failed,
    });
  }
}

/** Tests only: ONE whole reconciler tick (every sweep, in order), unclaimed — exactly what the
 *  scheduled path runs once it wins `claimTick`. */
export const __runOnboardingIntegrityTickForTests = (): Promise<void> => tick();

/** ms between ticks. Fixed, not config-driven — the task this scheduler does has no tenant-facing
 *  tuning knob the way `budget.intervalMinutes` does, so there is nothing an operator would set it
 *  to that isn't just "however often the claim window in tick-locks.ts allows". */
const ONBOARDING_INTEGRITY_INTERVAL_MS = 5 * 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;

/** Start the reconciler. Boot-only — call once from server.ts, mirroring every other in-process
 *  scheduler here so `bun test` never spins the interval. */
export function startOnboardingIntegrity(): void {
  // Boot check: a pod that restarts should not wait up to 5 minutes to repair a tenant that has
  // been 402ing since before the restart, or to notice a signup that crossed an alerting
  // threshold overnight — same rationale as budget-scheduler.ts's boot check.
  void claimTick({
    key: TICK_LOCK.onboardingIntegrity,
    minIntervalMs: TICK_MIN_INTERVAL_MS.onboardingIntegrity,
    label: '[onboarding-integrity] boot check',
    // NULL, not counted: a second replica booting inside the 2-minute claim window during a
    // rolling deploy is refused by the first one's boot check on EVERY deploy — that is leader
    // election working, not a fault. Same asymmetry, same reasoning, as budget-scheduler.ts.
    skipCounter: null,
    run: tick,
  }).catch((err) => {
    log.error('onboarding_integrity_boot_check_failed', { component: 'onboarding-integrity', err });
  });

  const arm = (): void => {
    timer = setTimeout(() => {
      void claimTick({
        key: TICK_LOCK.onboardingIntegrity,
        minIntervalMs: TICK_MIN_INTERVAL_MS.onboardingIntegrity,
        label: '[onboarding-integrity] scheduled tick',
        skipCounter: 'onboarding_integrity_tick_skipped_total',
        // Fires every 5 minutes on every replica forever, same shape as translation/budget's
        // scheduled path — the loser of the claim is refused every single cycle by design, so a
        // `warn` on every refusal would just say "there is more than one pod" forever.
        refusal: 'expected',
        run: tick,
      })
        .catch((err) =>
          log.error('onboarding_integrity_tick_failed', { component: 'onboarding-integrity', err }),
        )
        .finally(arm);
    }, ONBOARDING_INTEGRITY_INTERVAL_MS);
  };
  log.info('onboarding_integrity_armed', { component: 'onboarding-integrity' });
  arm();
}

/** Stop the loop (tests / graceful shutdown). */
export function stopOnboardingIntegrity(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
