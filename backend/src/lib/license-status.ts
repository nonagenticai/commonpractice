// src/lib/license-status.ts
//
// Rich, app-scoped license STATUS for the SPA (backs `GET /api/license/status`).
//
// The per-request ENFORCEMENT gate (`middleware/license-gate.ts assertTenantLicensed`) is the real
// enforcer — it 402/403s every non-exempt request when the tenant is not validly licensed. This
// module adds the detail the frontend needs to render an ACCURATE experience instead of a broken
// shell or raw 402 toasts: distinguish active / expiring_soon / expired / none and surface the
// expiry date, so an expired tenant sees a clear "renew" block.
//
// Shape vs fr: fr derives the state from the licenses service's two-call API (`/licenses/active`
// then the subject inventory) so it can tell `expired` from `revoked` from `none`. CP has only the
// INTROSPECTION call (`POST /license/introspect` on the tenant's stored opaque token — the same call
// Gate 2 uses), which cannot distinguish a `revoked` token from an `expired`/`never-had` one. So CP
// maps to the smaller set {active, expiring_soon, expired, none, unknown}: a revoked license that
// introspects `active:false` with no passed expiry collapses to `none` (documented limitation —
// either way the SPA hard-blocks with a renew CTA, which is the correct UX).
//
// Fail-soft: on ANY upstream error (DB read or introspect throw) this returns `state:'unknown'`
// (NOT a hard block) — the per-request 402 gate is the real-time enforcer, so a transient licenses /
// DB blip never hard-blocks an entitled user.
//
// Test seam: deps are injected via `__setLicenseStatusDepsForTests` (the repo's sanctioned pattern;
// no process-wide module mocks), so the pure derivation + every state is unit-tested without a live
// licenses service or DB.
import { and, eq, inArray } from 'drizzle-orm';
import { db, tenants, memberEntitlements, runAsSystem, withTenantDb } from '../db/client';
import { config } from '../config';
import { incCounter } from '../host/metrics';
import { decryptSecret } from '../host/secret-box';
import { licenseClient, type LicenseIntrospectResponse } from '../services/license-client';
import { licencesAdminConfigured } from '../services/licenses-admin';
import {
  fetchTenantLevelLicence,
  isValidTenantLevelLicence,
} from '../services/tenant-level-licence';
import { log } from '../host/logger';

export type LicenseStatusState =
  | 'active'
  | 'expiring_soon'
  | 'expired'
  | 'none'
  /**
   * The WORKSPACE is licensed; THIS CALLER has no seat (migration 0089, per-member gate).
   *
   * ⛔ A DISTINCT STATE, NOT `'none'`, AND THE REASON IS A MEASURED UI DEFECT RATHER THAN TASTE.
   * `'none'` means "this workspace was never licensed" and the SPA renders it as the terminal
   * billing wall — wrong copy, wrong CTA, and aimed at the wrong party. Worse, reusing `'none'`
   * would make this endpoint and the gate AGREE on blocking but DISAGREE on why, and the store
   * relabels any blocked state as `terminal`, silently overwriting the seat reason.
   *
   * ⚠️ It must also be a BLOCKED state on the SPA side. If this endpoint answered anything entitled
   * for a seatless member, `licenseGate.svelte.ts` `load()` would clear the block one round-trip
   * after the gate raised it, and the next gated request would raise it again — the exact flap the
   * `unknown` guard in that file already documents.
   */
  | 'no_seat'
  /**
   * The request resolved NO tenant — the caller is signed in but CP has seated them nowhere (yet).
   *
   * ⛔ NOT `'none'`, AND THE DIFFERENCE LOCKED OUT A BRAND-NEW TENANT ADMIN (2026-10-13). `'none'` is
   * a BLOCKED state on the SPA and the store caches it: an invitee whose status was read in the
   * moment before their invite was accepted kept the "No active license" wall after accepting, on
   * a workspace whose licence and seat were both active. "You have no workspace" is not a statement
   * about any licence, so it must not render as one. It is NON-blocking on the SPA side; the
   * no-workspace screen (`auth.needsWorkspace`) is what explains that state, and Gate 2 still
   * enforces every request regardless of what this endpoint says.
   */
  | 'no_workspace'
  /**
   * The workspace is licensed and this caller IS a member, but their seat is still being set up: an
   * entitlement row exists in `pending` or `error` (an accept whose licence call failed AFTER the
   * seat was committed — invite-service.ts `finishLicenceSetup` — or a mint the tick is retrying).
   *
   * ⛔ NOT `no_seat`. `no_seat` tells the reader to ask an administrator for a seat they already
   * hold; the onboarding-integrity tick finishes this one by itself. Still BLOCKED on the SPA side —
   * the gate denies every request until the mint lands — but the copy says "being set up".
   */
  | 'seat_pending'
  | 'unknown';

export interface LicenseStatusResult {
  state: LicenseStatusState;
  /** Whether the tenant holds a currently-usable license (active or expiring_soon). */
  hasLicense: boolean;
  /** ISO expiry of the relevant license, or null (perpetual / unknown). */
  expiresAt: string | null;
  /** Whole days until expiry (negative = days since expiry), or null. */
  daysRemaining: number | null;
  /** Plan code of the relevant license, when known. */
  planCode: string | null;
}

/** Days before expiry at which an active license is flagged expiring-soon. */
export const EXPIRING_SOON_DAYS = 30;

const ACTIVE: LicenseStatusResult = {
  state: 'active',
  hasLicense: true,
  expiresAt: null,
  daysRemaining: null,
  planCode: null,
};
const NONE: LicenseStatusResult = {
  state: 'none',
  hasLicense: false,
  expiresAt: null,
  daysRemaining: null,
  planCode: null,
};
/** The workspace is licensed; this caller holds no seat. See `LicenseStatusState['no_seat']`. */
const NO_SEAT: LicenseStatusResult = {
  state: 'no_seat',
  hasLicense: false,
  expiresAt: null,
  daysRemaining: null,
  planCode: null,
};
/** This caller's seat exists but is not minted yet. See `LicenseStatusState['seat_pending']`. */
const SEAT_PENDING: LicenseStatusResult = {
  state: 'seat_pending',
  hasLicense: false,
  expiresAt: null,
  daysRemaining: null,
  planCode: null,
};
/** No tenant resolved for this caller. See `LicenseStatusState['no_workspace']`. */
const NO_WORKSPACE: LicenseStatusResult = {
  state: 'no_workspace',
  hasLicense: false,
  expiresAt: null,
  daysRemaining: null,
  planCode: null,
};
const UNKNOWN: LicenseStatusResult = {
  state: 'unknown',
  hasLicense: false,
  expiresAt: null,
  daysRemaining: null,
  planCode: null,
};

function daysUntil(iso: string, now: Date): number {
  const ms = new Date(iso).getTime() - now.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

/**
 * Pure: derive the SPA status from a single introspection response.
 *
 * - active + no expiry                  → active (perpetual)
 * - active + expiry already passed      → expired (defends a stale 200 / clock skew: a negative
 *                                          countdown must hard-block, NOT show a dismissible banner)
 * - active + expiry within the window   → expiring_soon
 * - active + expiry beyond the window   → active
 * - !active + expiry already passed     → expired
 * - !active otherwise (revoked/pending/never) → none (CP cannot tell these apart by introspection)
 */
export function deriveStatusFromIntrospect(
  resp: LicenseIntrospectResponse,
  now: Date,
  expiringSoonDays: number = EXPIRING_SOON_DAYS,
): LicenseStatusResult {
  const expiresAt = resp.expires_at ?? null;
  const planCode = resp.plan?.code ?? null;
  const daysRemaining = expiresAt ? daysUntil(expiresAt, now) : null;
  const expiredByDate =
    expiresAt != null &&
    Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) <= now.getTime();

  if (resp.active === true) {
    if (expiredByDate) {
      return { state: 'expired', hasLicense: false, expiresAt, daysRemaining, planCode };
    }
    const state: LicenseStatusState =
      daysRemaining != null && daysRemaining <= expiringSoonDays ? 'expiring_soon' : 'active';
    return { state, hasLicense: true, expiresAt, daysRemaining, planCode };
  }

  // Not active. A passed expiry is unambiguously `expired`; anything else (revoked / pending /
  // never-licensed) collapses to `none` — introspection alone can't distinguish them in CP.
  if (expiredByDate) {
    return { state: 'expired', hasLicense: false, expiresAt, daysRemaining, planCode };
  }
  return NONE;
}

interface LicenseStatusDeps {
  /** Load the tenant's decrypted licence token. null = NO blob; THROWS if a blob exists but will not decrypt. */
  loadToken: (tenantId: string) => Promise<string | null>;
  /** Load MANY tenants' decrypted tokens in ONE query (the platform /tenants screen). */
  loadTokens: (tenantIds: string[]) => Promise<Map<string, BatchToken>>;
  /** Introspect an opaque token against the central licenses service. */
  introspect: (token: string) => Promise<LicenseIntrospectResponse>;
  /**
   * The tenant's ACTIVE licence for this app, whoever holds it (licences `GET /licenses/active`).
   * `null` = the service says there is none, OR there is no licences admin API to ask (dev/CI), OR
   * the configured client cannot do the lookup. THROWS on an outage. See `tenantLevelLicense`.
   */
  loadActiveTenantLicense: (tenantId: string) => Promise<LicenseIntrospectResponse | null>;
  now: () => Date;
}

/**
 * Thrown when a tenant HAS a stored license blob that cannot be decrypted. That is an
 * infrastructure fault (wrong/rotated `CP_SECRET_KEY`, corrupt row) — NOT a commercial state.
 */
export class LicenseTokenUnreadableError extends Error {
  constructor(tenantId: string, cause: unknown) {
    super(`license token for tenant ${tenantId} could not be decrypted`);
    this.name = 'LicenseTokenUnreadableError';
    this.cause = cause;
  }
}

/**
 * Load the tenant's decrypted license token. `null` means the tenant genuinely has NO stored blob.
 *
 * ⛔ AN UNREADABLE BLOB IS NOT AN ABSENT ONE, AND CONFLATING THEM TOLD PAYING CUSTOMERS THEY HAD
 * NOT PAID. This used to return `tryDecryptSecret(...)`, which swallows the decrypt failure and
 * returns `null` — so "no licence was ever issued" and "we hold a licence we cannot read" arrived
 * at the gate as the same value. The gate maps `null` to `402 license_required`, which the SPA
 * renders as the terminal "your workspace has no active licence, contact your administrator" wall
 * with a Renew CTA. A wrong or rotated `CP_SECRET_KEY` therefore de-licenses EVERY TENANT AT ONCE
 * behind that false message, and no amount of renewing fixes it.
 *
 * ⚠️ `tryDecryptSecret`'s own docblock says it exists so the BROKER degrades a corrupt BYO-key row
 * to the stub rather than failing a chat turn. That is the right call for a chat turn and the wrong
 * one for an entitlement check; this caller simply inherited a helper written for someone else.
 *
 * Both callers already have the correct branch for a throw, which is why this is the whole fix:
 *   - `middleware/license-gate.ts` catches → `402 license_unreadable`, the TERMINAL code: the SPA
 *     renders "an operator must repair this" with no Renew/Retry CTA, because this condition is
 *     standing and no retry clears it. It also bumps `license_token_unreadable_total` — that counter
 *     predates the wire code (it was the operator's ONLY discriminator while the gate still answered
 *     `license_unavailable` for both faults) and is kept because a dashboard reads metrics, not
 *     response bodies. ⚠️ The two halves shipped one deploy apart on purpose — SPA first (#255),
 *     this emission second — see the rolling-deploy reasoning in middleware/license-gate.ts.
 *   - `getLicenseStatus` catches → `state:'unknown'` (non-blocking, and after #250 `unknown`
 *     preserves an outage block rather than clearing it)
 *
 * `tenants` is a PLATFORM/GLOBAL table (not under RLS) — read via runAsSystem (the platform-read
 * escape hatch) on the owner pool, so the lookup works regardless of the request's tenant GUC. This
 * is the single source of the decrypt logic; the enforcement gate imports it rather than
 * duplicating it.
 */
export async function tenantLicenseToken(tenantId: string): Promise<string | null> {
  const [row] = await runAsSystem('non-rls-table', () =>
    db
      .select({ token: tenants.license_token_encrypted })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
  );
  const blob = row?.token ?? null;
  // No blob at all — a genuine "this tenant was never licensed". `license_required` is TRUE here.
  if (!blob) return null;
  try {
    return decryptSecret(blob);
  } catch (err) {
    throw new LicenseTokenUnreadableError(tenantId, err);
  }
}

/**
 * A member's OWN entitlement (migration 0089): their decrypted token plus the central Subject UUID
 * that token must introspect to.
 *
 * `null` means this member holds no usable entitlement — never issued, still `pending`, mid-offboard
 * (`revoking`), or tombstoned. All of those are the SAME answer to the gate ("no seat") and a
 * different answer from the tenant-level `license_required` ("this workspace was never licensed"),
 * which is why the gate emits its own code for it.
 *
 * ⛔ AN UNREADABLE BLOB THROWS, EXACTLY AS THE TENANT LOADER DOES, and for the same measured reason:
 * `tryDecryptSecret` would collapse "we hold a token we cannot read" into "no seat was ever issued",
 * and the gate would then tell a licensed employee to go and ask for a seat they already have. A
 * rotated `CP_SECRET_KEY` must read as an operator fault for members too, not as a commercial state.
 *
 * ⚠️ `subjectId` is returned ALONGSIDE the token rather than re-derived at the gate, because the
 * gate's job is to check that the presented token belongs to THIS member — comparing the
 * introspected `subject_id` against a value fetched from somewhere else would be comparing two
 * lookups rather than binding one row.
 */
export async function memberEntitlementToken(
  tenantId: string,
  userId: string,
): Promise<{ token: string; subjectId: string | null } | null> {
  const [row] = await withTenantDb(tenantId, () =>
    db
      .select({
        blob: memberEntitlements.token_encrypted,
        subjectId: memberEntitlements.license_subject_id,
      })
      .from(memberEntitlements)
      .where(
        and(
          eq(memberEntitlements.tenant_id, tenantId),
          eq(memberEntitlements.user_id, userId),
          eq(memberEntitlements.app_key, config.license.appKey),
          eq(memberEntitlements.status, 'active'),
        ),
      )
      .limit(1),
  );
  if (!row?.blob) return null;
  try {
    return { token: decryptSecret(row.blob), subjectId: row.subjectId };
  } catch (err) {
    throw new LicenseTokenUnreadableError(tenantId, err);
  }
}

/**
 * Injection seam for the member loader, mirroring the `deps` seam the tenant path already uses.
 * Lets `getLicenseStatus`'s per-member branch be exercised without a live database, which is the
 * repo's sanctioned pattern for this file (see `__setLicenseStatusDepsForTests`).
 */
type MemberLoader = (
  tenantId: string,
  userId: string,
) => Promise<{ token: string; subjectId: string | null } | null>;
let memberLoader: MemberLoader = memberEntitlementToken;

export function __setMemberEntitlementLoaderForTests(fake: MemberLoader): void {
  memberLoader = fake;
}
export function __resetMemberEntitlementLoaderForTests(): void {
  memberLoader = memberEntitlementToken;
  pendingLoader = memberSeatPending;
}

/** Does this member hold a seat that is still being set up (`pending` / `error`, not `revoking`)? */
export async function memberSeatPending(tenantId: string, userId: string): Promise<boolean> {
  const [row] = await withTenantDb(tenantId, () =>
    db
      .select({ id: memberEntitlements.id })
      .from(memberEntitlements)
      .where(
        and(
          eq(memberEntitlements.tenant_id, tenantId),
          eq(memberEntitlements.user_id, userId),
          eq(memberEntitlements.app_key, config.license.appKey),
          inArray(memberEntitlements.status, ['pending', 'error']),
        ),
      )
      .limit(1),
  );
  return Boolean(row);
}
type PendingLoader = (tenantId: string, userId: string) => Promise<boolean>;
let pendingLoader: PendingLoader = memberSeatPending;
export function __setMemberSeatPendingLoaderForTests(fake: PendingLoader): void {
  pendingLoader = fake;
}

/** A member with no usable entitlement: `seat_pending` when one is being set up, else `no_seat`. */
async function seatlessAnswer(tenantId: string, userId: string): Promise<LicenseStatusResult> {
  try {
    return (await pendingLoader(tenantId, userId)) ? SEAT_PENDING : NO_SEAT;
  } catch {
    return NO_SEAT;
  }
}

/**
 * A tenant whose stored blob exists but will not decrypt. Distinct from `null` (no blob at all).
 *
 * ⚠️ THE BATCH SIGNALS RATHER THAN THROWS, DELIBERATELY. The single-tenant loader throws because
 * its callers are per-tenant and an outage answer is the right one. This one backs the platform
 * `/tenants` list, so throwing would let ONE corrupt row blank the entire page for every other
 * tenant — trading a wrong label for a dead screen. Per-row degradation keeps the page, and the
 * affected rows read `unknown` instead of the equally false `none`.
 */
export const LICENSE_TOKEN_UNREADABLE = Symbol('license_token_unreadable');
export type BatchToken = string | null | typeof LICENSE_TOKEN_UNREADABLE;

/**
 * Tenants already reported as unreadable in this process. The condition is a STANDING one (a wrong
 * master key does not fix itself), and this runs on every `/tenants` load — so an unbounded
 * `log.error` with a stack would turn a fleet-wide bad key into a continuous stack-trace
 * stream, drowning the very log an operator is reading to diagnose it. Once per tenant per process
 * still surfaces it on every pod, and a restart re-arms it.
 *
 * ⚠️ NOT a cache of the VERDICT — only of whether we have already complained. Every request still
 * attempts the decrypt, so a repaired key takes effect immediately with no restart.
 */
const warnedUnreadable = new Set<string>();

function warnUnreadableOnce(tenantId: string, err: unknown): void {
  if (warnedUnreadable.has(tenantId)) return;
  warnedUnreadable.add(tenantId);
  log.error('license_token_unreadable', {
    component: 'license-status',
    tenantId,
    reportedState: 'unknown',
    reason:
      "token is stored but UNREADABLE (wrong/rotated CP_SECRET_KEY, or a corrupt row); reporting " +
      "state:'unknown', NOT 'none'. Further occurrences for this tenant are suppressed in this " +
      'process.',
    err,
  });
}

/**
 * Load MANY tenants' decrypted license tokens in ONE query, keyed by tenant id.
 *   - `string`                       → a readable token
 *   - `null`                         → NO stored blob (genuinely unlicensed)
 *   - `LICENSE_TOKEN_UNREADABLE`     → a blob we hold but cannot decrypt (infrastructure fault)
 *
 * ⛔ The third case used to be `null` too, so the platform `/tenants` screen labelled a tenant
 * whose token we simply could not read as having NO licence — the same false claim the per-request
 * gate was making, on the screen an operator uses to decide whether to chase a customer.
 *
 * Shaped on host/budget-service.ts `getBudgetsForTenants`: same `runAsSystem` + `inArray` idiom,
 * one query for the page's ids rather than N. `tenants` is a PLATFORM table (outside RLS), so the
 * owner-pool read works regardless of the request's tenant GUC.
 */
export async function tenantLicenseTokens(
  tenantIds: string[],
): Promise<Map<string, BatchToken>> {
  const out = new Map<string, BatchToken>();
  if (!tenantIds.length) return out;
  const rows = await runAsSystem('non-rls-table', () =>
    db
      .select({ id: tenants.id, token: tenants.license_token_encrypted })
      .from(tenants)
      .where(inArray(tenants.id, tenantIds)),
  );
  for (const row of rows) {
    const blob = row.token ?? null;
    if (!blob) {
      out.set(row.id, null);
      continue;
    }
    try {
      out.set(row.id, decryptSecret(blob));
    } catch (err) {
      warnUnreadableOnce(row.id, err);
      out.set(row.id, LICENSE_TOKEN_UNREADABLE);
    }
  }
  return out;
}

/**
 * The real `loadActiveTenantLicense`. `null` without a call when there is no licences admin API to
 * talk to (dev, CI, `bun test` — `licencesAdminConfigured()` is false there), which keeps the
 * tenant-level fallback inert exactly where the stored-token path is the only one that can answer.
 * A configured client that does not implement the lookup (a test fake predating it) is also `null`:
 * here "cannot tell" must fall back to the stored-token verdict, never invent an entitlement.
 */
async function loadActiveTenantLicenseReal(
  tenantId: string,
): Promise<LicenseIntrospectResponse | null> {
  if (!licencesAdminConfigured()) return null;
  return fetchTenantLevelLicence(tenantId);
}

const realDeps: LicenseStatusDeps = {
  loadToken: (tenantId) => tenantLicenseToken(tenantId),
  loadTokens: (tenantIds) => tenantLicenseTokens(tenantIds),
  introspect: (token) => licenseClient().introspect(token),
  loadActiveTenantLicense: loadActiveTenantLicenseReal,
  now: () => new Date(),
};

let deps: LicenseStatusDeps = realDeps;

export function __setLicenseStatusDepsForTests(overrides: Partial<LicenseStatusDeps>): void {
  deps = { ...realDeps, ...overrides };
  tenantLicenceCache.clear();
}

export function __resetLicenseStatusDepsForTests(): void {
  deps = realDeps;
  tenantLicenceCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TENANT-LEVEL LICENCES (ruling 2026-09-28)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A tenant's bundle gives ONE licence per (tenant, app), held by the service subject
// `svc:<tenant-uuid>:<app>`. CP never minted it, so neither `tenants.license_token_encrypted` nor
// `member_entitlements` knows it exists — and both readers above answered `none`/402 for a tenant
// that is paying. The functions below ask the licences service directly, by (tenant, app), and are
// consulted ONLY when the stored-token path did not already admit the request, so a tenant whose
// stored token works is answered exactly as before and costs no extra call.

/**
 * Positive-only verdict cache, keyed by tenant, with the SAME window as the introspect cache
 * (`config.license.cacheTtlSec`, 5 min). Negatives are NOT cached: a tenant that has just bought a
 * bundle must be admitted on its next request, not five minutes later, and an unlicensed tenant is
 * already behind the SPA's block screen, so its request rate is low. The cached response is
 * re-validated on every read (`isValidTenantLicence`), so an `expires_at` passing inside the window
 * still denies.
 */
const tenantLicenceCache = new Map<string, { value: LicenseIntrospectResponse; until: number }>();

/**
 * Does this active-licence response entitle `tenantId` to THIS app right now? Delegates to the ONE
 * shared predicate (services/tenant-level-licence.ts) that onboarding also uses: active, unexpired,
 * app key, tenant — the four Gate 2 makes on a token — PLUS `subject_match === true`, so another
 * member's licence returned as the service's fallback pick can never admit a seatless user.
 */
export function isValidTenantLicence(
  resp: LicenseIntrospectResponse | null | undefined,
  tenantId: string,
  now: Date,
): resp is LicenseIntrospectResponse {
  return isValidTenantLevelLicence(resp, tenantId, now);
}

/**
 * The tenant's valid tenant-level licence for this app, or `null` when it holds none.
 * THROWS when the licences service cannot be asked (outage) — the caller decides what that means
 * (the gate denies, the status endpoint reports `unknown`).
 */
export async function tenantLevelLicense(
  tenantId: string,
): Promise<LicenseIntrospectResponse | null> {
  const now = deps.now();
  const hit = tenantLicenceCache.get(tenantId);
  if (hit && hit.until > now.getTime() && isValidTenantLicence(hit.value, tenantId, now)) {
    return hit.value;
  }
  tenantLicenceCache.delete(tenantId);
  const resp = await deps.loadActiveTenantLicense(tenantId);
  if (!isValidTenantLicence(resp, tenantId, now)) return null;
  tenantLicenceCache.set(tenantId, {
    value: resp,
    until: now.getTime() + config.license.cacheTtlSec * 1000,
  });
  return resp;
}

/**
 * The status-endpoint fallback: when the stored-token path answered anything NOT entitled, ask for a
 * tenant-level licence before reporting it. Keeps this endpoint and the gate answering the same
 * question — a gate that admits on the tenant-level licence while this said `none` would raise and
 * clear the SPA block on alternating requests (the flap `no_seat`'s docblock describes).
 * A lookup failure keeps the stored-token answer, except that `none`/`no_seat` — which would be a
 * claim we could not verify — becomes `unknown`.
 */
async function withTenantLevelFallback(
  tenantId: string,
  primary: LicenseStatusResult,
): Promise<LicenseStatusResult> {
  if (primary.hasLicense || primary.state === 'unknown') return primary;
  try {
    const resp = await tenantLevelLicense(tenantId);
    return resp ? deriveStatusFromIntrospect(resp, deps.now()) : primary;
  } catch (err) {
    log.error('license_lookup_failed', {
      component: 'license-status',
      tenantId,
      path: 'tenant-level',
      reportedState: 'unknown',
      err,
    });
    return primary.state === 'none' || primary.state === 'no_seat' ? UNKNOWN : primary;
  }
}

/**
 * Resolve the rich license status for the current request's tenant.
 *
 * - gate disabled ⇒ everyone is entitled (`state:'active'`) — NO DB read, NO introspect (mirrors the
 *   gate's F.1 no-op, so shipping the endpoint changes prod behaviour by zero until F.2).
 * - no tenant (unauthenticated / not seated in any workspace) ⇒ `no_workspace` — NOT `none`, which
 *   the SPA renders as a licence wall (see `LicenseStatusState['no_workspace']`).
 * - no stored token (or a token that is not entitled, or no seat) ⇒ the tenant-level licence
 *   (`GET /licenses/active`) decides; `none` only when that finds nothing either.
 * - any upstream error (DB read or introspect throw) ⇒ `unknown` (non-blocking; the 402 gate is the
 *   real enforcer, so a transient blip never locks out an entitled user).
 */
export async function getLicenseStatus(args: {
  appKey: string;
  tenantId: string | null | undefined;
  gateEnabled: boolean;
  /**
   * The caller, when they are a MEMBER of `tenantId`. Required for this endpoint to agree with the
   * per-member gate; omitted for a scope-switched operator (who holds no entitlement and is judged
   * on the tenant token, exactly as in `middleware/license-gate.ts`).
   */
  userId?: string | null;
}): Promise<LicenseStatusResult> {
  const { tenantId, gateEnabled, userId } = args;

  if (!gateEnabled) return ACTIVE;
  if (!tenantId) return NO_WORKSPACE;

  // ⭐ THE READ SIDE MUST ANSWER THE SAME QUESTION THE GATE ASKS. With the per-member gate on, the
  // gate checks the CALLER'S entitlement — so an endpoint that kept reporting the TENANT's token
  // would tell a seatless member "active" while every other request 402s them. The SPA's own store
  // then clears the block it just raised, and the next request re-raises it: a flap loop, not a
  // wrong label. This branch is what keeps the two sides answering about the same subject.
  if (config.license.perMemberGate && userId) {
    let ent;
    try {
      ent = await memberLoader(tenantId, userId);
    } catch (err) {
      // An unreadable blob is an infrastructure fault, not a commercial state — same posture as the
      // tenant path below, which fails soft to `unknown` so one bad row cannot render a billing wall.
      log.error('license_lookup_failed', {
        component: 'license-status',
        tenantId,
        userId,
        reportedState: 'unknown',
        err,
      });
      return UNKNOWN;
    }
    if (!ent?.token) return withTenantLevelFallback(tenantId, await seatlessAnswer(tenantId, userId));
    try {
      const resp = await deps.introspect(ent.token);
      // ⛔ THE SAME RULE AS THE GATE, INCLUDING ON NULL — and it did NOT match until this was fixed.
      // This read `if (ent.subjectId && …)`, which SKIPS the comparison when the stored subject is
      // null, while `middleware/license-gate.ts` DENIES on exactly that case ("nothing to compare"
      // must not read as "comparison passed"). A row with a token and no subject therefore got a 403
      // from the gate and an ENTITLED answer from here — reintroducing precisely the gate/endpoint
      // disagreement this endpoint was made seat-aware to close, and with it the block/clear flap.
      // Two sides of one question must not have two predicates.
      if (resp.subject_id !== ent.subjectId) return withTenantLevelFallback(tenantId, NO_SEAT);
      return withTenantLevelFallback(tenantId, deriveStatusFromIntrospect(resp, deps.now()));
    } catch (err) {
      log.error('license_lookup_failed', {
        component: 'license-status',
        tenantId,
        userId,
        reportedState: 'unknown',
        err,
      });
      return UNKNOWN;
    }
  }

  try {
    const token = await deps.loadToken(tenantId);
    if (!token) return withTenantLevelFallback(tenantId, NONE);
    const resp = await deps.introspect(token);
    return withTenantLevelFallback(tenantId, deriveStatusFromIntrospect(resp, deps.now()));
  } catch (err) {
    log.error('license_lookup_failed', {
      component: 'license-status',
      tenantId,
      reportedState: 'unknown',
      err,
    });
    return UNKNOWN;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The BATCHED, per-tenant licence truth behind the platform /tenants screen.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS: `routes/admin.ts listAllTenants` reported `licensed: (license_token_encrypted
// IS NOT NULL)` — which answers "a token was written into this row once", not "the token works".
// Live prod: 18 of 19 tenants reported licensed=true while the authoritative licences service held
// a `commonpractice` licence for only 5, and 13 token-holding tenants were not registered there at
// all. Their tokens introspect `active:false`, so Gate 2 402s them on every screen while the
// platform screen shows a calm grey "Licensed" chip. The screen was lying.
//
// ⚠️ OUTAGE POSTURE IS DELIBERATELY THE OPPOSITE OF THE GATE'S — this is not an inconsistency.
// The gate (middleware/license-gate.ts, the `catch` around introspect) fails CLOSED: an unreachable
// licences service must DENY, or an outage becomes a free-access window. This is a READ for an
// operator. It fails SOFT to `unknown` and NEVER to `none`/`expired`, because the failure mode
// there is the whole estate turning coral during a licences blip and an operator "repairing" 19
// healthy tenants by hand. `getLicenseStatus` above already sets that precedent for the SPA.

/**
 * Per-tenant licence state for the platform screen.
 *
 * `expiring_soon` from `deriveStatusFromIntrospect` collapses into `active` here: this chip answers
 * "is this workspace entitled right now", and the expiry countdown belongs to the tenant's own
 * banner (`GET /api/license/status`). `expiresAt` is still carried so a future chip can show it.
 */
export type TenantLicenseState = 'none' | 'active' | 'expired' | 'unknown';

export interface TenantLicenseStatus {
  state: TenantLicenseState;
  /**
   * Whether a token blob is stored for this tenant. Carried ALONGSIDE `state`, not folded into it,
   * because `state:'none' && hasToken:true` is exactly the 13 stranded prod tenants — and it is the
   * difference between `issueLicense(t)` (a no-op that reports `alreadyLicensed`, since a token IS
   * stored) and `issueLicense(t, force)` (the actual repair).
   */
  hasToken: boolean;
  expiresAt: string | null;
  daysRemaining: number | null;
  planCode: string | null;
}

/** Introspects in flight at once. 19 tenants × a 10 s per-call ceiling is why this is bounded. */
const INTROSPECT_CONCURRENCY = 6;

const NO_TOKEN: TenantLicenseStatus = {
  state: 'none',
  hasToken: false,
  expiresAt: null,
  daysRemaining: null,
  planCode: null,
};

/**
 * Resolve the REAL licence state of many tenants at once, for the platform all-tenants screen.
 *
 * - `config.license.enforceGate2` off ⇒ returns an EMPTY map: zero DB reads, zero introspects in
 *   dev/CI, and the route then emits no licence fields at all, so the frontend falls back to its
 *   legacy `licensed` rendering (see the `licenseState === undefined` branch there).
 * - no stored token ⇒ `none` with ZERO HTTP calls.
 * - a stored token ⇒ one `introspect` (already TTL-cached ~5 min in license-client, so this WARMS
 *   the enforcement gate's cache rather than competing with it), bounded to
 *   INTROSPECT_CONCURRENCY in flight and raced against `budgetMs`.
 * - a rejection, or the deadline passing ⇒ `unknown` (fail-soft, see the note above).
 *
 * Never throws.
 */
export async function licenseStatesForTenants(
  tenantIds: string[],
  opts: { budgetMs?: number } = {},
): Promise<Map<string, TenantLicenseStatus>> {
  const out = new Map<string, TenantLicenseStatus>();
  if (!config.license.enforceGate2 || tenantIds.length === 0) return out;

  // Deduplicate: the caller passes a page of rows, and a repeated id would double-introspect.
  const ids = [...new Set(tenantIds)];

  let tokens: Map<string, BatchToken>;
  try {
    tokens = await deps.loadTokens(ids);
  } catch (err) {
    // The DB read failed — report `unknown` for the whole page rather than inventing `none`.
    log.error('license_batch_token_read_failed', {
      component: 'license-status',
      tenantCount: ids.length,
      reportedState: 'unknown',
      err,
    });
    for (const id of ids) out.set(id, { ...NO_TOKEN, state: 'unknown' });
    return out;
  }

  const pending: { id: string; token: string }[] = [];
  for (const id of ids) {
    const token = tokens.get(id) ?? null;
    if (token === LICENSE_TOKEN_UNREADABLE) {
      // We HOLD a licence for this tenant and cannot read it. `none` would state the opposite of
      // what we know, on the very screen an operator uses to decide whether to chase a customer
      // for payment. `unknown` is the honest answer and matches what the per-request gate now says.
      //
      // ⛔ `hasToken: true`, NOT the `NO_TOKEN` default. A stored blob demonstrably EXISTS — that is
      // the one thing we are certain of here. This field decides the repair: `routes/admin.ts`
      // issueLicense is `if (t.token && !forced) → alreadyLicensed` (a no-op), so an unreadable blob
      // is repairable ONLY with `force`. Reporting `false` tells the operator the opposite of what
      // the repair path requires. Both sibling `unknown` branches in this function already set it.
      out.set(id, { ...NO_TOKEN, state: 'unknown', hasToken: true });
    } else if (!token) out.set(id, NO_TOKEN);
    else pending.push({ id, token });
  }
  if (pending.length === 0) return out;

  const now = deps.now();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = pending[cursor++];
      if (!next) return;
      try {
        const resp = await deps.introspect(next.token);
        const derived = deriveStatusFromIntrospect(resp, now);
        out.set(next.id, {
          // `expiring_soon` is still entitled → `active` (see TenantLicenseState).
          state: derived.state === 'expiring_soon' ? 'active' : (derived.state as TenantLicenseState),
          hasToken: true,
          expiresAt: derived.expiresAt,
          daysRemaining: derived.daysRemaining,
          planCode: derived.planCode,
        });
      } catch {
        // A SEPARATE counter from the gate's `license_introspect_failures_total` on purpose: that
        // one is the enforcement-outage alert signal, and an operator refreshing /tenants during an
        // outage would otherwise add one per tenant per reload straight into it.
        incCounter('license_status_introspect_failures_total');
        out.set(next.id, { ...NO_TOKEN, state: 'unknown', hasToken: true });
      }
    }
  };

  const budgetMs = opts.budgetMs ?? config.license.statusBatchMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolveDeadline) => {
    timer = setTimeout(resolveDeadline, budgetMs);
  });
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(INTROSPECT_CONCURRENCY, pending.length) }, worker)),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Anything the deadline cut off (or a worker never reached) is UNKNOWN — never `none`/`expired`.
  for (const { id } of pending) {
    if (!out.has(id)) out.set(id, { ...NO_TOKEN, state: 'unknown', hasToken: true });
  }
  return out;
}
