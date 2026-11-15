// src/services/license-provisioning.ts — Phase 4 / F.2: per-tenant license issue/revoke policy.
//
// Spec: SPEC-PHASE4-admin-tenant-isolation.md Part 9 (§9.3 / §9.5 Phase C). The thin layer the
// onboarding + tenant-lifecycle routes call so they stay clean: it carries the F.2 flag, the
// idempotency, the at-rest encryption, and the fail-loud mapping. It composes the licenses-admin
// SA client (services/licenses-admin.ts) with the tenant row's `license_token_encrypted` column
// (F.1 / migration 0031) and secret-box (host/secret-box.ts).
//
// CP's license is TENANT-LEVEL: one token per tenant, stored once, reused for every member's Gate-2
// check (Gate 2 asserts the introspected `tenant_id`, not `subject_id` — middleware/license-gate.ts).
// So issuance binds the license to the FIRST onboarded subject and is idempotent thereafter; a 2nd+
// member of the tenant is a no-op.
//
// FLAG-GATED: with `config.license.issuanceEnabled` off (the F.2 ship state) every function returns
// immediately — the SA client is never touched, so onboarding/suspend behave exactly as before F.2.
// FAIL-LOUD when on: a licenses-service outage throws HttpError(502) and BLOCKS the onboard/suspend
// (Spec §9.3), mirroring the Keycloak-502 posture (services/provisioning.ts).
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { config } from '../config';
import { db, tenants, users, memberEntitlements, runAsSystem, withTenantDb } from '../db/client';
import { encryptSecret, decryptSecret, tryDecryptSecret } from '../host/secret-box';
import {
  licensesAdmin,
  LicensesAdminError,
  LicencesAccessRefusedError,
  LicencesNameConflictError,
  LicencesTenantOwnedByOtherAppError,
  isTenantLicenceSubject,
  licencesAdminConfigured,
  tenantLicenceSubjects,
  type CreatedLicence,
  type LicenceTerms,
} from './licenses-admin';
import { licenseClient } from './license-client';
import {
  fetchTenantLevelLicence,
  isValidTenantLevelLicence,
  tenantServiceSubject,
} from './tenant-level-licence';
import { HttpError, conflict, unprocessable } from '../utils/http';
import { log } from '../host/logger';
import { incCounter } from '../host/metrics';

/**
 * The NIL-UUID tenant (`00000000-0000-0000-0000-000000000000`, slug `u-0000…`) is NOT a customer.
 * It is the personal tenant migration 0014 backfilled (`id = users.id`, slug `'u-' || id`) for the
 * seed's "Dev User" `00000000-…` — the AUTH_BYPASS default user (middleware/auth.ts:55-57), the
 * boot seed's metering actor and owner of the example datasets/flows (db/seed-example-blocks.ts:42,
 * :634-646, :736-741), and the MCP bypass user (routes/mcp.ts:26, ai/mcp-sdk-server.ts:21). Its
 * stored licence is read only by Gate 2 for a request homed there (license-gate.ts:254); no
 * background path presents it. CP's tenant-licence machinery leaves it alone: no re-home, no
 * revoke, and the licence editor refuses it (409 `system_tenant`).
 */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export function isSystemTenant(tenantId: string | null | undefined): boolean {
  return typeof tenantId === 'string' && tenantId.toLowerCase() === SYSTEM_TENANT_ID;
}

/** A tenant licence change whose OLD licence could not be revoked (see host/metrics.ts). */
export const LICENCE_CHANGE_OLD_UNREVOKED_COUNTER = 'licence_change_old_unrevoked_total';

/**
 * Bumped when two concurrent first-time `ensureTenantLicense` callers race for the same tenant
 * (see the CONCURRENCY GUARD note in that function) AND the loser's own revoke of its now-orphaned
 * licence ALSO fails. Not in `PRESEEDED_COUNTERS` (host/metrics.ts) yet — that file is owned by
 * another agent concurrently; wire it into that list (and a gitops `increase(...) > 0` alert) as a
 * follow-up, or the first occurrence is invisible to `increase()`/`rate()` (see that list's own
 * docblock for why).
 */
export const LICENSE_PROVISION_ORPHAN_UNREVOKED_COUNTER = 'license_provision_orphan_unrevoked_total';

/**
 * Map a licenses-admin failure to a 502 (fail-loud); re-throw anything else unchanged.
 *
 * The RESPONSE stays a flat 502 — callers of this module always saw that and still do. But
 * `LicensesAdminError` already carries the real upstream HTTP status (licenses-admin.ts), and this
 * used to discard it: every cause — a genuine 5xx blip AND a real upstream 4xx (e.g. the `409` slug
 * collision on `ensureTenantRegistered`) — came out as an indistinguishable `HttpError(502, ...)`.
 * `admin.ts`'s retry predicate needs that distinction (a 4xx fails identically on every attempt, so
 * retrying it only triples latency), so the upstream status is threaded through in `details` — an
 * ADDITIVE field on the existing 502 `HttpError`, not a new status.
 */
function as502(err: unknown, what: string): never {
  // ⛔ An OWNERSHIP refusal (licences migration 050) is not an outage: CP may mint only apps it
  // issues, on tenants it owns or holds a grant on. It gets its own code naming licences' reason
  // (`tenant_not_accessible` / `app_not_issuable_by_caller` / `unknown_api_client`) so the operator
  // sees WHY, and `upstreamStatus: 403` keeps every retry predicate from retrying it. No fallback.
  if (err instanceof LicencesAccessRefusedError) {
    log.error('licences_access_refused', { component: 'license-provisioning', what, code: err.code });
    throw new HttpError(502, 'licences_access_refused', `${what}: ${err.message}`, {
      upstreamStatus: err.status,
      licencesError: err.code,
    });
  }
  if (err instanceof LicensesAdminError) {
    throw new HttpError(502, 'license_provisioning_failed', `${what}: ${err.message}`, {
      upstreamStatus: err.status,
    });
  }
  throw err;
}

/**
 * The idempotent registration every mint path runs first (licences refuses to mint for an
 * UNREGISTERED tenant). Licences answers `PUT /tenants/{id}` with 200 unchanged when CP owns the
 * tenant OR holds an active grant on it, so a 409 `tenant_owned_by_other_app` here means CP is
 * neither owner nor grantee: a real misconfiguration (a foreign id, or a missing grant). It FAILS
 * LOUDLY like every other path: error log + 502 `licences_tenant_owned_by_other_app` with
 * `upstreamStatus: 409` (so no retry predicate retries it). No tolerance, no fallback. Every other
 * failure propagates unchanged.
 */
export async function ensureRegisteredBeforeMint(tenantId: string, registryName: string): Promise<void> {
  try {
    await licensesAdmin().ensureTenantRegistered(tenantId, registryName);
  } catch (err) {
    if (!(err instanceof LicencesTenantOwnedByOtherAppError)) throw err;
    log.error('licences_tenant_owned_by_other_app', {
      component: 'license-provisioning',
      tenantId,
      registryName,
      err,
    });
    throw new HttpError(502, 'licences_tenant_owned_by_other_app', err.message, { upstreamStatus: 409 });
  }
}

/** Read a tenant's stored encrypted-token blob (platform-global table → runAsSystem). */
async function storedTokenBlob(tenantId: string): Promise<string | null> {
  const [row] = await runAsSystem('tenant-parameterised', () =>
    db
      .select({ token: tenants.license_token_encrypted })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
  );
  return row?.token ?? null;
}

/**
 * What a licence for this tenant is minted WITH, and the registry name it is registered under.
 *
 * ⛔ THE TENANT ROW, NOT `config.license.planCode`. Every mint path — the tenant licence, each member
 * seat, the onboarding-integrity seat repair, SSO first login, the admin repair route — resolves its
 * terms here, so a plan change on the tenant is what the NEXT mint on any of those paths uses. Before
 * 0095 they all minted on the one global plan, whatever the tenant had bought.
 */
export interface TenantLicenceState {
  terms: LicenceTerms;
  /** CP's own licences-registry name (`licences_name`, else the slug). null = no tenant row. */
  registryName: string | null;
  /** The stored tenant licence's holder (`licence_subject_sub`), or null. */
  holder: string | null;
}

export async function tenantLicenceState(tenantId: string): Promise<TenantLicenceState> {
  const [row] = await runAsSystem('tenant-parameterised', () =>
    db
      .select({
        slug: tenants.slug,
        licencesName: tenants.licences_name,
        planCode: tenants.plan_code,
        startsAt: tenants.licence_starts_at,
        expiresAt: tenants.licence_expires_at,
        holder: tenants.licence_subject_sub,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
  );
  return {
    holder: row?.holder ?? null,
    terms: {
      planCode: row?.planCode ?? config.license.planCode,
      startsAt: row?.startsAt ?? null,
      expiresAt: row?.expiresAt ?? null,
    },
    registryName: row ? (row.licencesName ?? row.slug) : null,
  };
}

/**
 * Mint a licence for (subject, tenant) that ACTUALLY carries `terms`.
 *
 * ⛔ licences keeps AT MOST ONE ACTIVE licence per (tenant, app, subject) and `POST
 * /licenses/user/{sub}` returns the existing one instead of minting (licences main.py
 * `create_user_license`, "Idempotency"). So after a plan or expiry change, "mint on the new plan" for
 * the same subject silently hands back the OLD-plan licence. When the returned licence's terms do not
 * match (`termsMatch === false`) it is revoked BY ID and the mint repeated — the only way licences
 * offers to change a licence's plan or dates (there is no PATCH on a licence).
 *
 * Any member seat that held the replaced licence is moved to `error`, so `ensureMemberEntitlement`
 * (directly, or via the onboarding-integrity seat repair) re-claims it and stores a token for the new
 * licence — otherwise that seat would keep a token for a revoked licence and stay `active`.
 *
 * `protectLicenceId` (the tenant's stored licence) is NEVER revoked from here: a member mint racing a
 * tenant change must not kill the tenant's Gate-2 licence. The mismatching licence is then accepted
 * as-is and the change's own member re-issue corrects it.
 */
export async function mintWithTerms(
  subject: string,
  tenantId: string,
  terms: LicenceTerms,
  opts: {
    protectLicenceId?: string | null;
    /** `accept` (member seats): take the protected licence as-is. `refuse` (the tenant licence):
     *  throw `ProtectedLicenceError` so the caller picks the other holder slot. */
    protectMode?: 'accept' | 'refuse';
  } = {},
): Promise<CreatedLicence & { replacedLicenceId: string | null }> {
  const first = await licensesAdmin().createLicense(subject, tenantId, terms);
  if (opts.protectLicenceId && first.licenseId === opts.protectLicenceId) {
    // The licence licences handed back IS the tenant's stored Gate-2 licence. Never revoked from
    // here — revoking it is how a race left a workspace 402 with nothing to repair it.
    if (opts.protectMode === 'refuse') throw new ProtectedLicenceError(first.licenseId);
    if (first.termsMatch === false) {
      log.warn('licence_terms_mismatch_protected', { tenantId, licenseId: first.licenseId });
    }
    return { ...first, replacedLicenceId: null };
  }
  if (first.termsMatch !== false) return { ...first, replacedLicenceId: null };
  await licensesAdmin().revokeByLicenseId(first.licenseId, tenantId);
  await withTenantDb(tenantId, () =>
    db
      .update(memberEntitlements)
      .set({
        status: 'error',
        last_error: `licence ${first.licenseId} replaced (terms changed); re-issue pending`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(memberEntitlements.tenant_id, tenantId),
          eq(memberEntitlements.license_id, first.licenseId),
          eq(memberEntitlements.status, 'active'),
        ),
      ),
  );
  const second = await licensesAdmin().createLicense(subject, tenantId, terms);
  if (second.termsMatch === false) {
    throw new LicensesAdminError(
      502,
      `licences returned licence ${second.licenseId} with stale terms again after revoking ${first.licenseId}`,
    );
  }
  return { ...second, replacedLicenceId: first.licenseId };
}

/** `mintWithTerms` was handed the tenant's stored licence and was told not to touch it. */
export class ProtectedLicenceError extends Error {
  constructor(readonly licenceId: string) {
    super(`licence ${licenceId} is the tenant's stored licence and may not be replaced here`);
    this.name = 'ProtectedLicenceError';
  }
}

/** The tenant's stored Gate-2 licence id, read FRESH (it may have moved since the caller's read).
 *  Only while a token is stored: an id without a token is no licence anybody is admitted on. */
async function storedLicenceId(tenantId: string): Promise<string | null> {
  const [row] = await runAsSystem('non-rls-table', () =>
    db
      .select({ id: tenants.licence_id, token: tenants.license_token_encrypted })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
  );
  return row?.token ? (row.id ?? null) : null;
}

/**
 * Mint the TENANT licence on `preferred` (one of the two cp-tenant slots) — or, when licences answers
 * that slot with the licence currently STORED as the tenant licence, on the other slot. Never
 * revokes the stored licence. Returns the licence and the slot it landed on.
 */
async function mintTenantLicence(
  tenantId: string,
  preferred: string,
  terms: LicenceTerms,
): Promise<{ minted: CreatedLicence & { replacedLicenceId: string | null }; holder: string }> {
  const [a, b] = tenantLicenceSubjects(tenantId);
  const order = preferred === b ? [b, a] : [a, b];
  const protectLicenceId = await storedLicenceId(tenantId);
  let lastErr: unknown;
  for (const holder of order) {
    try {
      return { minted: await mintWithTerms(holder, tenantId, terms, { protectLicenceId, protectMode: 'refuse' }), holder };
    } catch (err) {
      if (!(err instanceof ProtectedLicenceError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---- per-tenant licence lease (0096) ----------------------------------------------------------

/**
 * How long a tenant-licence lease is good for. A tenant op makes up to ~6 licences round trips
 * (register, create ×2, revoke, token, revoke-old), each bounded by the admin timeout; the 2-minute
 * floor mirrors MEMBER_CLAIM_LEASE_MS. The TTL only matters for a holder that CRASHED — every normal
 * exit releases in `finally`.
 */
const LICENCE_LEASE_MS = Math.max(120_000, config.license.adminTimeoutMs * 8);

/** 409 `licence_busy` — another licence operation holds this tenant's lease. Built with `conflict()`
 *  (not an HttpError subclass) so the frontend's backend-contract scrape SEES the code and demands
 *  localized copy for it. */
export function licenceBusy(tenantId: string): HttpError {
  return conflict(
    'licence_busy',
    `Another licence operation is in progress for this workspace (${tenantId}). Try again in a moment.`,
  );
}

export function isLicenceBusy(err: unknown): boolean {
  return err instanceof HttpError && err.code === 'licence_busy';
}

/**
 * Run `fn` holding the tenant's licence lease, or throw 409 `licence_busy`.
 *
 * ⛔ Serialises EVERY tenant-licence mutation (change, re-home, ensure/reissue, revoke): two of them
 * interleaving their mint → CAS windows is how a workspace ended 402 with nothing to repair it. The
 * lease is ONE conditional UPDATE — no connection, transaction or advisory lock is held across the
 * licences HTTP calls (the owner pool sits on a transaction pooler; nested reserves have wedged pods).
 */
export async function withLicenceLease<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const op = Bun.randomUUIDv7();
  const got = await runAsSystem('non-rls-table', () =>
    db
      .update(tenants)
      .set({ licence_op_id: op, licence_op_until: new Date(Date.now() + LICENCE_LEASE_MS) })
      .where(
        and(
          eq(tenants.id, tenantId),
          sql`(${tenants.licence_op_until} IS NULL OR ${tenants.licence_op_until} < now())`,
        ),
      )
      .returning({ id: tenants.id }),
  );
  if (got.length === 0) {
    // Not taken because the tenant row does not exist? Then there is no row for a concurrent op
    // to race on either — run unleased (the op itself reports the missing tenant its own way).
    const [exists] = await runAsSystem('non-rls-table', () =>
      db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)),
    );
    if (!exists) return fn();
    throw licenceBusy(tenantId);
  }
  try {
    return await fn();
  } finally {
    await runAsSystem('non-rls-table', () =>
      db
        .update(tenants)
        .set({ licence_op_id: null, licence_op_until: null })
        .where(and(eq(tenants.id, tenantId), eq(tenants.licence_op_id, op))),
    ).catch((err: unknown) => log.error('licence_lease_release_failed', { tenantId, op, err }));
  }
}

/** Re-exported: the svc holder is defined once, in services/tenant-level-licence.ts. */
export { tenantServiceSubject };

/**
 * Does the tenant ALREADY hold an active tenant-level `commonpractice` licence (its bundle's, on the
 * service subject)? If so, onboarding must mint NOTHING: licences are tenant-level (ruling
 * 2026-09-28), Gate 2 admits on that licence directly (`lib/license-status.ts tenantLevelLicense`),
 * and a member licence minted beside it is a personal licence the model says must not exist — a
 * second billable seat for the same entitlement.
 *
 * ⚠️ `subject_match === true`, NOT "a licence came back". `GET /licenses/active` never denies on the
 * selector: when the service subject holds nothing it returns the tenant-level PICK instead, which
 * may be a member licence CP itself minted earlier — and treating that as the bundle would make
 * every CP-licensed tenant skip every subsequent member forever.
 *
 * A configured client that cannot do the lookup (a test fake predating it) answers `false` — "not
 * known to hold one" — which is the pre-ruling behaviour (mint), never a silent skip of the mint.
 * An outage THROWS (LicensesAdminError), and callers route it through `as502` like every other
 * licences failure on this path: onboarding already blocks on a licences outage because it mints.
 */
export async function tenantHoldsTenantLevelLicence(tenantId: string): Promise<boolean> {
  const resp = await fetchTenantLevelLicence(tenantId);
  return isValidTenantLevelLicence(resp, tenantId, new Date());
}

/**
 * What `ensureTenantLicense` did. ⛔ Only `stored` / `already_stored` mean a tenant token is on the
 * row. `busy` (another licence op held the lease) and `tenant_level` (its bundle's licence admits it;
 * nothing was minted) return WITHOUT one, and `issuance_disabled` mints nothing at all — a caller
 * that records "licence: ok" must check (`tenantLicenceStored`), not infer it from "did not throw".
 */
export type EnsureTenantLicenceOutcome = 'stored' | 'already_stored' | 'busy' | 'tenant_level' | 'issuance_disabled';

/** Is a tenant licence token stored on the row right now? */
export async function tenantLicenceStored(tenantId: string): Promise<boolean> {
  return (await storedTokenBlob(tenantId)) !== null;
}

/**
 * Issue (once) the tenant's `commonpractice` license and store the token encrypted on the tenant
 * row. Idempotent: a no-op if issuance is disabled OR the tenant already has a stored token (so the
 * 2nd+ onboarded user never re-issues). `subjectId` is the just-provisioned Keycloak sub the license
 * is bound to.
 */
export async function ensureTenantLicense(
  tenantId: string,
  subjectId: string,
  opts: {
    /** Re-mint even when a token is already stored. For the repair route's `?force=1`: a stored
     *  blob proves a token was written ONCE, not that it still works — it may have been revoked
     *  upstream or left undecryptable by a secret-box key rotation, in which case the tenant 402s
     *  while this function reports success. Note this does NOT clear the stored token first: the
     *  new blob is written only after the mint succeeds (below), so force-repairing a tenant while
     *  the licences service is down leaves the existing token exactly as it was. */
    force?: boolean;
    /** A reactivation must not report success without a licence: busy → 409 `licence_busy`. */
    failIfBusy?: boolean;
  } = {},
): Promise<EnsureTenantLicenceOutcome> {
  if (!config.license.issuanceEnabled) return 'issuance_disabled';
  if (!opts.force && (await storedTokenBlob(tenantId))) return 'already_stored'; // idempotent
  try {
    return await withLicenceLease(tenantId, () => ensureTenantLicenseLocked(tenantId, subjectId, opts));
  } catch (err) {
    // Another licence op holds the tenant: an ordinary ensure is a no-op (the other op, or the
    // onboarding-integrity unlicensed-tenant repair, settles it); an explicit force-repair says so.
    if (isLicenceBusy(err) && !opts.force && !opts.failIfBusy) {
      log.warn('license_ensure_skipped_busy', { tenantId, subjectId });
      return 'busy';
    }
    throw err;
  }
}

async function ensureTenantLicenseLocked(
  tenantId: string,
  subjectId: string,
  opts: { force?: boolean },
): Promise<EnsureTenantLicenceOutcome> {
  if (!opts.force && (await storedTokenBlob(tenantId))) return 'already_stored'; // re-checked under the lease

  try {
    // Tenant-level licence already held (its bundle's) → mint NOTHING. This function binds the
    // licence it mints to ONE member's subject, i.e. it would create exactly the personal licence
    // the tenant-level model forbids. Also applies to `force`: a repair must not re-introduce it.
    if (await tenantHoldsTenantLevelLicence(tenantId)) {
      log.info('license_mint_skipped_tenant_level', { tenantId, subjectId, path: 'tenant' });
      return 'tenant_level';
    }
    // The licenses service refuses to mint for an UNREGISTERED tenant (its FK-backed mint guard).
    // CP owns its own tenants table, so nothing had ever registered them there — every tenant
    // created in CP got a 502 here on its first onboard. Register first, idempotently.
    const { terms, registryName, holder: holderNow } = await tenantLicenceState(tenantId);
    if (!registryName) {
      throw new HttpError(
        502,
        'license_provisioning_failed',
        `issue tenant license: tenant ${tenantId} has no slug to register`,
      );
    }
    await ensureRegisteredBeforeMint(tenantId, registryName);
    // KNOWN WINDOW, and why it is tolerable rather than hidden: a failure between `createLicense`
    // and the token write leaves a licence on the licenses service that CP holds no token for, and
    // the retry calls `createLicense` again. It does NOT duplicate, because that endpoint is
    // idempotent per (subject, tenant, app) — it returns the existing licence rather than minting a
    // second (licenses `create_license` returns early on an existing row, ahead of its mint guard).
    // So the retry re-mints only the TOKEN, which is the intended repair. The guard below
    // (`storedTokenBlob`) makes the whole function a no-op once a token is stored, so this can only
    // ever re-run while genuinely unfinished.
    //
    // ⚠️ THIS IS NOT THE ONLY WINDOW. The comment above covers ONE caller retrying after its own
    // failure. It does NOT cover TWO DISTINCT first-time callers for the SAME tenant racing each
    // other — two admins approving different pending signups for a brand-new tenant, or a manual
    // approve racing email-domain auto-assignment. Both read `storedTokenBlob` as null above (no
    // lock across that read), each carries a DIFFERENT `subjectId`, so `createLicense`'s upstream
    // idempotency key — (subject, tenant, app), by the service's own contract, NOT (tenant, app) —
    // differs for each caller and BOTH mint a real, billable licence.
    //
    // CONCURRENCY GUARD. Deliberately NOT a `pg_advisory_lock` held across this mint (check→HTTP
    // mint→store): `runSystemTick` (db/client.ts) documents, with the production incident to prove
    // it, that a SESSION-level advisory lock on this same owner pool is unsound — the owner pool
    // points at the transaction pooler, where a server connection is reassigned between statements,
    // so two different callers' lock/unlock calls can land on different (or the same, already-held)
    // backend session and the lock stops meaning anything. A `pg_advisory_xact_lock` avoids that
    // only by staying on ONE connection for the transaction's life, which would mean holding a DB
    // connection open across a slow external HTTP round-trip (two of them) to the licenses service —
    // its own hazard class this codebase avoids everywhere else (see cp-probe / cp-metrics above).
    //
    // So: let both callers mint (wasteful but harmless on its own), and make the STORE a
    // compare-and-set — `WHERE license_token_encrypted IS NULL` — so only the first writer's UPDATE
    // affects a row. `ON CONFLICT ... WHERE` on `scheduler_ticks` is the same self-serializing shape
    // (db/client.ts `runSystemTick`): Postgres evaluates the predicate while holding the row lock, so
    // exactly one concurrent caller can observe "still unset" and win. The loser does NOT clobber the
    // winner's token, and does NOT leave its own licence orphaned: it revokes what it just minted.
    //
    // `force` intentionally skips the CAS predicate and always overwrites (unconditional `WHERE id =
    // tenantId`) — it is a single operator-driven repair (`?force=1`), not a race between first-time
    // callers, and its own "don't clear-then-mint" window is the KNOWN WINDOW comment above.
    // The HOLDER is CP's own synthetic tenant subject, never `subjectId` (the person whose action
    // caused this mint — provenance only). Bound to a person, the tenant licence WAS that person's
    // seat licence (licences keys one active licence per subject), and offboarding them 402'd the
    // whole workspace. See `tenantLicenceSubjects`.
    const preferred = isTenantLicenceSubject(holderNow) ? holderNow! : tenantLicenceSubjects(tenantId)[0];
    // ⛔ A FORCED re-mint REPLACES the stored licence (mintTenantLicence protects it and lands on the
    // other cp-tenant slot), so the replaced one must be QUEUED for revoke in the same CAS that stores
    // its successor — mint-before-revoke, settled by the integrity sweep under the lease. Not queuing
    // it left two active cp-tenant licences and an empty queue (prod, Netcare 2026-10-13). Read under
    // the lease, so it cannot move before the write below. Non-force runs only with no stored token.
    const replacedLicenceId = opts.force ? await storedLicenceId(tenantId) : null;
    const {
      minted: { licenseId },
      holder,
    } = await mintTenantLicence(tenantId, preferred, terms);
    const { token } = await licensesAdmin().createToken(licenseId, tenantId);
    const encrypted = encryptSecret(token);
    const won = await runAsSystem('tenant-parameterised', () =>
      db
        .update(tenants)
        .set({
          license_token_encrypted: encrypted,
          licence_id: licenseId,
          licence_revoke_pending: pendingAfter(replacedLicenceId, licenseId),
          licence_subject_sub: holder,
          updated_at: new Date(),
        })
        .where(
          opts.force
            ? eq(tenants.id, tenantId)
            : and(eq(tenants.id, tenantId), isNull(tenants.license_token_encrypted)),
        )
        .returning({ id: tenants.id }),
    );

    if (won.length === 0) {
      // Lost the race: another caller's UPDATE already landed between our check and our write. This
      // licence is a genuine orphan — it was never stored, so `revokeTenantLicense` (which only ever
      // reads the STORED column) can never find it and would happily report "nothing to revoke".
      // Revoke it ourselves rather than leaking a paid, invisible seat.
      try {
        await licensesAdmin().revokeByToken(token, tenantId);
        log.warn('license_provision_race_lost', { tenantId, licenseId, subjectId });
      } catch (revokeErr) {
        // The revoke ALSO failed — now genuinely orphaned (minted, unstored, unrevoked). Loud and
        // countable rather than silent; see LICENSE_PROVISION_ORPHAN_UNREVOKED_COUNTER above for the
        // pre-seeding follow-up this still needs.
        incCounter(LICENSE_PROVISION_ORPHAN_UNREVOKED_COUNTER);
        log.error('license_provision_orphan_unrevoked', {
          tenantId,
          licenseId,
          subjectId,
          error: revokeErr instanceof Error ? revokeErr.message : String(revokeErr),
        });
      }
      return 'already_stored'; // the race's winner stored one
    }
    return 'stored';
  } catch (err) {
    as502(err, 'issue tenant license');
  }
}

/**
 * Revoke EVERY active licence of this tenant (this app) held by one of its cp-tenant subjects.
 * Asked per subject (`GET /licenses/user/{sub}` — the one licences read that lists a subject's
 * licences); member subjects are never asked, so a seat cannot be touched. Returns how many it
 * revoked. Throws on any licences failure (the caller maps it to 502).
 *
 * A client without `listSubjectLicences` (a test fake predating it) skips the sweep — loudly in the
 * log; `LicensesAdminService` implements it.
 */
export async function sweepTenantLicences(tenantId: string): Promise<number> {
  // No licences admin API in this deployment (dev / CI / most tests): nothing can be listed — and
  // nothing was minted through it either. Not a failure.
  if (!licencesAdminConfigured()) return 0;
  const client = licensesAdmin();
  if (typeof client.listSubjectLicences !== 'function') {
    log.warn('tenant_licence_sweep_unsupported', { tenantId });
    return 0;
  }
  let revoked = 0;
  for (const sub of tenantLicenceSubjects(tenantId)) {
    const held = await client.listSubjectLicences(sub);
    for (const l of held) {
      if (l.status !== 'active' || l.tenantId.toLowerCase() !== tenantId.toLowerCase()) continue;
      // ⛔ EQUALITY, NOT "not some other app". The old `l.appKey && l.appKey !== appKey` let a
      // licence with a NULL/empty app key through, so this sweep could revoke a licence it cannot
      // prove is CP's — on an adopted/shared licences tenant, another app's. Unknown app ⇒ skip.
      if (l.appKey !== config.license.appKey) continue;
      await client.revokeByLicenseId(l.id, tenantId);
      revoked++;
    }
  }
  if (revoked > 0) log.info('tenant_licence_sweep_revoked', { tenantId, revoked });
  return revoked;
}

/**
 * Revoke the tenant's license at the licenses service and clear the stored token (offboarding /
 * suspend). No-op if issuance is disabled. Fail-loud (502) so a suspend can never silently leave an
 * active license behind.
 *
 * ⛔ THE LICENCE, NOT THE TOKEN. licences' token arm revokes the TOKEN only — the licence stays
 * `active`. That was harmless while the tenant licence was a member's seat (the seat loop released
 * it), and is not since A2: a cp-tenant licence revoked by token stayed active upstream after a
 * suspend or an offboard, and the reactivation minted a second one beside it. So a cp-tenant licence
 * is revoked BY ID, and then EVERY active licence of this tenant held by its cp-tenant subjects is
 * swept (`sweepTenantLicences`) — a strayed one (a failed old-licence revoke, a lost race) included.
 * A pre-A2 licence that is a member's seat is still revoked by token only: it stays their seat,
 * which the seat loop releases. Member seats are never touched here.
 */
export async function revokeTenantLicense(tenantId: string): Promise<void> {
  if (!config.license.issuanceEnabled) return;
  if (isSystemTenant(tenantId)) return; // see SYSTEM_TENANT_ID
  // Under the tenant's licence lease; busy → 409 `licence_busy` (a suspend must never report a
  // revoke it did not do — re-sending the same PATCH retries it).
  await withLicenceLease(tenantId, () => revokeTenantLicenseLocked(tenantId));
}

async function revokeTenantLicenseLocked(tenantId: string): Promise<void> {
  const blob = await storedTokenBlob(tenantId);
  if (!blob) {
    // No stored token (already suspended, or never licensed) — but an earlier revoke may have left a
    // cp-tenant licence active upstream. Sweep, so an offboard after a suspend still releases it.
    if ((await settlePendingRevokesLocked(tenantId)).failed > 0) {
      throw new HttpError(502, 'license_provisioning_failed', 'revoke of a pending old tenant licence failed');
    }
    try {
      await sweepTenantLicences(tenantId);
    } catch (err) {
      as502(err, 'sweep tenant licences');
    }
    return;
  }

  // ⛔ THIS IS THE CONFLATION'S FAIL-OPEN SITE, AND IT BREAKS THE PROMISE IN THE DOCBLOCK ABOVE.
  // This used to be `tryDecryptSecret(...)` with `if (!token) return`, so a blob we cannot decrypt
  // took the "nothing to revoke" path: the licence at licenses.example.com was NEVER revoked and the
  // column was never cleared — silently. Suspending or offboarding a tenant after a key rotation
  // would leave them a WORKING upstream licence while the platform believed it had revoked one.
  //
  // Everywhere else the same conflation denied access wrongly; here it GRANTS it. Fail loud, which
  // is what "a suspend can never silently leave an active license behind" already promised.
  //
  // ⚠️ Thrown DIRECTLY, not via `as502`: that helper only converts `LicensesAdminError` and
  // re-throws anything else unchanged, so a decrypt failure routed through it would surface as a
  // raw 500 — not the 502 this function's contract promises.
  let token: string;
  try {
    token = decryptSecret(blob);
  } catch (err) {
    throw new HttpError(
      502,
      'license_provisioning_failed',
      `revoke tenant license: the stored token for tenant ${tenantId} could not be decrypted, so the ` +
        `upstream license cannot be revoked. Refusing to report success — resolve CP_SECRET_KEY (or ` +
        `clear the row deliberately) and retry. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const [stored] = await runAsSystem('non-rls-table', () =>
    db
      .select({
        licenceId: tenants.licence_id,
        holder: tenants.licence_subject_sub,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
  );
  try {
    if (stored?.licenceId && isTenantLicenceSubject(stored.holder)) {
      await licensesAdmin().revokeByLicenseId(stored.licenceId, tenantId);
    } else {
      // A tenant NOT yet re-homed (pre-A2: licence bound to a person; or stuck). The token arm
      // revokes only the token, which left a super_admin-bound licence active forever. So ask
      // licences what the token is, and apply the re-home keep rule: a live member's seat in this
      // tenant keeps its licence (only the token ends); anything else is revoked BY ID.
      const old = await resolveStoredLicence(tenantId, blob, stored?.licenceId ?? null);
      if (old.kind === 'identified') {
        if (await oldLicenceIsASeat(tenantId, old.licenceId, stored?.holder ?? null, old.subjectUuid)) {
          await licensesAdmin().revokeByToken(token, tenantId);
        } else {
          await licensesAdmin().revokeByLicenseId(old.licenceId, tenantId);
        }
      } else if (old.kind === 'unknown') {
        // licences could not be asked — end at least the token (it fails loud if licences is down).
        log.warn('revoke_tenant_licence_unidentified', { tenantId });
        await licensesAdmin().revokeByToken(token, tenantId);
      }
      // 'inactive': licences answered that nothing is active behind this token — nothing to revoke.
    }
    if ((await settlePendingRevokesLocked(tenantId)).failed > 0) {
      throw new LicensesAdminError(502, 'a pending old tenant licence could not be revoked');
    }
    await sweepTenantLicences(tenantId);
  } catch (err) {
    as502(err, 'revoke tenant license');
  }
  // Only null the column AFTER a successful revoke (so a failed revoke leaves the row reconcilable).
  await runAsSystem('tenant-parameterised', () =>
    db
      .update(tenants)
      .set({
        license_token_encrypted: null,
        licence_id: null,
        licence_subject_sub: null,
        updated_at: new Date(),
      })
      .where(eq(tenants.id, tenantId)),
  );
}

/**
 * Re-issue a tenant's license on REACTIVATION (suspend revoked + nulled it). Binds the new license
 * to the tenant's oldest existing user; a no-op if issuance is disabled or the tenant has no users
 * (an empty tenant has nothing to license — its next onboard issues). Keeps suspend↔reactivate
 * symmetric so a reactivated tenant isn't permanently locked out once Gate 2 is enforced.
 */
export async function reissueTenantLicense(tenantId: string): Promise<void> {
  if (!config.license.issuanceEnabled) return;
  // The target tenant's users are read cross-tenant (a platform suspend/reactivate op) → runAsSystem.
  // Tombstones excluded (0050): a tombstone keeps its `tenant_id` and stays OLDEST by `created_at`,
  // so a tenant whose founding member has been offboarded would otherwise bind its reissued licence
  // to a subject Keycloak no longer has. Nothing downstream catches that — `create_or_get_subject`
  // upserts on the `keycloak_sub` string without ever asking Keycloak whether it exists — so the
  // licence mints happily against a dead subject. Gate 2 asserts `tenant_id`, not `subject_id`, so
  // this never 402s a tenant; it silently corrupts the licence's audit trail instead, which is
  // exactly the kind of defect that surfaces years later during a compliance review.
  // `admin.ts`'s `licenseSubjectFor` (the `?force=1` repair path) already does it this way.
  const oldest = await oldestLiveMember(tenantId);
  if (!oldest) return; // no LIVE member — nothing to license (an all-tombstone tenant is empty)
  await ensureTenantLicense(tenantId, oldest, { failIfBusy: true });
}

async function oldestLiveMember(tenantId: string): Promise<string | null> {
  const [oldest] = await runAsSystem('tenant-parameterised', () =>
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at)))
      .orderBy(asc(users.created_at))
      .limit(1),
  );
  return oldest?.id ?? null;
}

/** The subject a tenant's licence should be bound to: its oldest LIVE member if it has one (so a
 *  repaired tenant matches what a first-onboard would have produced), else the acting super-admin.
 *  Tombstoned members (0050) are skipped — binding a workspace's licence to somebody who has been
 *  offboarded from it names the wrong person as the party who requested it, and on a tenant whose
 *  founder has since left, the oldest row is exactly the one most likely to be a tombstone.
 *
 *  `boundToActor` tells the caller WHICH case fired: a fallback bind (no live member — Better
 *  Results Group / Nonagentic are in exactly this state) used to be indistinguishable from a normal
 *  member bind once written to the audit row, so these could never be found again after the fact. */
export async function licenseSubjectFor(
  tenantId: string,
  actorId: string,
): Promise<{ subjectId: string; boundToActor: boolean }> {
  const oldest = await oldestLiveMember(tenantId);
  return oldest ? { subjectId: oldest, boundToActor: false } : { subjectId: actorId, boundToActor: true };
}

// ===================================================================================================
// LICENCE TERMS CHANGE (plan / start / expiry) — A2
// ===================================================================================================

/** A requested change. `undefined` = keep; `null` dates = clear (from-mint / perpetual). */
export interface LicenceTermsChange {
  planCode?: string;
  startsAt?: Date | null;
  expiresAt?: Date | null;
}

export interface LicenceTermsView {
  planCode: string;
  startsAt: string | null;
  expiresAt: string | null;
  licenceId: string | null;
}

export interface LicenceChangeResult {
  changed: boolean;
  before: LicenceTermsView;
  after: LicenceTermsView;
  /** A new tenant licence was minted and swapped in. */
  reminted: boolean;
  /** true/false = the old licence was / was not revoked; null = there was nothing to revoke. */
  oldLicenceRevoked: boolean | null;
  /** The old licence was a member's seat (pre-A2 tenant) and was deliberately NOT revoked. */
  oldLicenceKeptAsSeat: boolean;
  /** Member seats re-issued on the new terms (live members with a recorded Keycloak sub). */
  membersReissued: number;
  memberFailures: { userId: string; email: string; message: string }[];
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Change a tenant's licence terms. Order:
 *   1. Mint a licence on the new terms for the tenant's OTHER synthetic holder (`mintWithTerms`).
 *   2. Compare-and-set the token + `licence_id` + terms on the tenant row (on the token it read).
 *   3. Revoke the OLD licence by id. A failure here is logged + counted
 *      (`licence_change_old_unrevoked_total`) and reported, never fatal: the swap already happened,
 *      the old licence is merely an orphan the operator can revoke.
 *   4. Re-issue every live member's seat on the new terms through the seat-repair path: the seat goes
 *      to `error` and `ensureMemberEntitlement` re-claims it (what the onboarding-integrity sweep
 *      does every 5 minutes, so a failure here is retried by it).
 *
 * ⚠️ THE HOLDER IS NEVER A PERSON. licences holds ONE active licence per (tenant, app, subject) and
 * hands it back instead of minting, so the new licence goes to whichever of the tenant's two
 * synthetic subjects (`cp-tenant:<id>:a|b`, `tenantLicenceSubjects`) does NOT hold the current one:
 * mint-before-revoke always holds, and no tenant licence can coincide with a member's seat. (Binding
 * it to a person did exactly that: the seat licence came back as the tenant licence, and offboarding
 * the member 402'd the workspace.) A pre-A2 tenant whose licence IS a member's seat keeps that
 * licence as the seat — it is not revoked (`oldLicenceKeptAsSeat`).
 *
 * With issuance off, or `mint: false` (a suspend in the same PATCH), or no stored token (suspended /
 * never licensed): only the row's terms are written — the next mint on any path uses them.
 */
export async function changeTenantLicence(
  tenantId: string,
  change: LicenceTermsChange,
  opts: { actorId: string; mint?: boolean },
): Promise<LicenceChangeResult> {
  // The tenant licence swap runs under the tenant's licence lease (busy → 409 `licence_busy`); the
  // member re-issue runs AFTER it is released — it touches only seats, and holding the lease across
  // a whole roster's worth of licences calls would starve every other tenant-licence op.
  const { result, reissue } = await withLicenceLease(tenantId, () =>
    changeTenantLicenceLocked(tenantId, change, opts),
  );
  if (reissue) await reissueMemberSeats(tenantId, result);
  return result;
}

async function changeTenantLicenceLocked(
  tenantId: string,
  change: LicenceTermsChange,
  opts: { actorId: string; mint?: boolean },
): Promise<{ result: LicenceChangeResult; reissue: boolean }> {
  const [row] = await runAsSystem('non-rls-table', () =>
    db
      .select({
        token: tenants.license_token_encrypted,
        licenceId: tenants.licence_id,
        subject: tenants.licence_subject_sub,
        status: tenants.status,
        offboardedAt: tenants.offboarded_at,
        planCode: tenants.plan_code,
        startsAt: tenants.licence_starts_at,
        expiresAt: tenants.licence_expires_at,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
  );
  if (!row) throw new HttpError(404, 'tenant_not_found', `No tenant '${tenantId}'`);

  const cur: LicenceTerms = {
    planCode: row.planCode ?? config.license.planCode,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
  };
  const next: LicenceTerms = {
    planCode: change.planCode ?? cur.planCode,
    startsAt: change.startsAt !== undefined ? change.startsAt : cur.startsAt,
    expiresAt: change.expiresAt !== undefined ? change.expiresAt : cur.expiresAt,
  };
  const before: LicenceTermsView = {
    planCode: cur.planCode,
    startsAt: iso(cur.startsAt),
    expiresAt: iso(cur.expiresAt),
    licenceId: row.licenceId,
  };
  const changed =
    next.planCode !== cur.planCode ||
    iso(next.startsAt) !== iso(cur.startsAt) ||
    iso(next.expiresAt) !== iso(cur.expiresAt);
  const result: LicenceChangeResult = {
    changed,
    before,
    after: { ...before },
    reminted: false,
    oldLicenceRevoked: null,
    oldLicenceKeptAsSeat: false,
    membersReissued: 0,
    memberFailures: [],
  };
  if (!changed) return { result, reissue: false };
  if (next.startsAt && next.expiresAt && next.expiresAt <= next.startsAt) {
    throw unprocessable('licence_window_invalid', 'The expiry must be after the start.');
  }

  const termsSet = {
    plan_code: next.planCode,
    licence_starts_at: next.startsAt ?? null,
    licence_expires_at: next.expiresAt ?? null,
    updated_at: new Date(),
  };
  // Nothing is minted for a workspace that is not live: a suspended tenant holds no token and its
  // seats were released, so only the terms are recorded and reactivation mints on them.
  const mint =
    config.license.issuanceEnabled &&
    opts.mint !== false &&
    row.status === 'active' &&
    row.offboardedAt === null;

  if (!mint || !row.token) {
    await runAsSystem('non-rls-table', () =>
      db.update(tenants).set(termsSet).where(eq(tenants.id, tenantId)),
    );
    result.after = { ...before, planCode: next.planCode, startsAt: iso(next.startsAt), expiresAt: iso(next.expiresAt) };
    return { result, reissue: mint };
  }

  const oldBlob: string = row.token;
  // The OLD licence: the stored id, else (minted before 0095) the id the stored token introspects to.
  const oldToken = tryDecryptSecret(oldBlob);
  let oldLicenceId = row.licenceId;
  let oldSubjectUuid: string | null = null;
  if (oldToken && (!oldLicenceId || !isTenantLicenceSubject(row.subject))) {
    try {
      const seen = await licenseClient().introspect(oldToken);
      oldLicenceId = oldLicenceId ?? seen.license_id ?? null;
      oldSubjectUuid = seen.subject_id ?? null;
    } catch (err) {
      log.warn('licence_change_old_id_unresolved', { tenantId, err });
    }
  }
  // The new holder: whichever of the tenant's two synthetic subjects does NOT hold the current
  // licence, so the new licence exists BESIDE the old one and the swap has no window (licences keeps
  // one active licence per subject). Never a person — see `tenantLicenceSubjects`. A pre-A2 tenant
  // (licence on a member or a super_admin) moves to `:a`.
  const [subjectA, subjectB] = tenantLicenceSubjects(tenantId);
  const preferred = row.subject === subjectA ? subjectB : subjectA;
  // TRANSITION (pre-A2 tenants): the old tenant licence may BE a member's seat — bound to a person,
  // licences handed that person's seat licence back as the tenant licence. Revoking it would revoke
  // the seat; it is left alone and simply stops being the tenant licence.
  const oldIsASeat = oldLicenceId
    ? await oldLicenceIsASeat(tenantId, oldLicenceId, row.subject, oldSubjectUuid)
    : false;

  let minted: Awaited<ReturnType<typeof mintWithTerms>>;
  let subject: string;
  let token: string;
  try {
    // Never the licence STORED as the tenant licence: `mintTenantLicence` takes the other slot
    // rather than revoke it.
    ({ minted, holder: subject } = await mintTenantLicence(tenantId, preferred, next));
    ({ token } = await licensesAdmin().createToken(minted.licenseId, tenantId));
  } catch (err) {
    log.error('licence_change_mint_failed', {
      tenantId,
      oldLicenceId,
      remediation:
        'the tenant still carries its OLD terms in CP; if the old licence was already revoked to make ' +
        'room (same subject), the tenant is unlicensed until this change is retried — retrying is safe',
      err,
    });
    as502(err, 'change tenant licence');
  }

  // The old licence this change will revoke is QUEUED inside the swap's own CAS (0097): a pod dying
  // between the swap and the revoke below still leaves it for the sweep. A confirmed revoke removes it.
  const queueOld =
    !oldIsASeat && oldLicenceId && oldLicenceId !== minted.licenseId && oldLicenceId !== minted.replacedLicenceId
      ? oldLicenceId
      : null;
  const swapped = await runAsSystem('non-rls-table', () =>
    db
      .update(tenants)
      .set({
        ...termsSet,
        license_token_encrypted: encryptSecret(token),
        licence_revoke_pending: pendingAfter(queueOld, minted.licenseId),
        licence_id: minted.licenseId,
        licence_subject_sub: subject,
      })
      .where(and(eq(tenants.id, tenantId), eq(tenants.license_token_encrypted, oldBlob)))
      .returning({ id: tenants.id }),
  );
  if (swapped.length === 0) {
    // Somebody else rewrote the licence while we minted (a concurrent change / suspend / repair).
    // Ours is the orphan: release it, unless it is the very licence the row now holds.
    if (minted.licenseId !== (await storedLicenceId(tenantId))) {
      await licensesAdmin()
        .revokeByLicenseId(minted.licenseId, tenantId)
        .catch((err: unknown) => {
          incCounter(LICENSE_PROVISION_ORPHAN_UNREVOKED_COUNTER);
          log.error('licence_change_orphan_unrevoked', { tenantId, licenseId: minted.licenseId, err });
        });
    }
    throw conflict(
      'licence_changed_concurrently',
      "The tenant's licence changed while this change was being applied. Reload and try again.",
    );
  }
  result.reminted = true;
  result.after = {
    planCode: next.planCode,
    startsAt: iso(next.startsAt),
    expiresAt: iso(next.expiresAt),
    licenceId: minted.licenseId,
  };

  // (3) Revoke the old licence — unless mintWithTerms already had to, or it is a member's seat
  // (transition; `result.oldLicenceKeptAsSeat`), which offboarding that member releases.
  if (oldIsASeat && oldLicenceId !== minted.licenseId) {
    result.oldLicenceKeptAsSeat = true;
    log.info('licence_change_old_kept_as_seat', { tenantId, oldLicenceId, newLicenceId: minted.licenseId });
  } else if (oldLicenceId && oldLicenceId !== minted.licenseId && oldLicenceId !== minted.replacedLicenceId) {
    try {
      await licensesAdmin().revokeByLicenseId(oldLicenceId, tenantId);
      result.oldLicenceRevoked = true;
      // Confirmed: out of the set it was queued in by the swap.
      await runAsSystem('non-rls-table', () =>
        db
          .update(tenants)
          .set({ licence_revoke_pending: pendingAfter(null, oldLicenceId) })
          .where(eq(tenants.id, tenantId)),
      );
    } catch (err) {
      // Already queued by the swap's CAS — the onboarding-integrity sweep retries it.
      result.oldLicenceRevoked = false;
      incCounter(LICENCE_CHANGE_OLD_UNREVOKED_COUNTER);
      log.error('licence_change_old_unrevoked', {
        tenantId,
        oldLicenceId,
        newLicenceId: minted.licenseId,
        remediation: 'kept in tenants.licence_revoke_pending; the onboarding-integrity sweep retries it',
        err,
      });
    }
  } else if (minted.replacedLicenceId) {
    result.oldLicenceRevoked = true;
  } else if (!oldLicenceId && oldToken) {
    // Id unknown (pre-0095 and introspect failed): revoke the TOKEN we just replaced — only the
    // token, so a licence that is also somebody's seat keeps working for them.
    try {
      await licensesAdmin().revokeByToken(oldToken, tenantId);
      result.oldLicenceRevoked = true;
    } catch (err) {
      result.oldLicenceRevoked = false;
      incCounter(LICENCE_CHANGE_OLD_UNREVOKED_COUNTER);
      log.error('licence_change_old_unrevoked', { tenantId, newLicenceId: minted.licenseId, err });
    }
  }

  return { result, reissue: true };
}

/** What one re-home attempt did. Only `rehomed` changed anything. */
export type RehomeOutcome =
  | 'rehomed'
  | 'skipped' // issuance off, no token, already on a cp-tenant holder, not an active workspace
  | 'busy' // another tenant-licence op holds the lease — next tick
  | 'tenant_level' // a bundle (svc:) licence covers the tenant — nothing to re-home
  | 'name_conflict' // the registry refused the tenant's licences name
  | 'unresolved' // the old licence could not be identified — not re-homed (next tick)
  | 'lost_race';

/**
 * RE-HOME a pre-A2 tenant licence onto CP's own holder (`cp-tenant:<id>:a`), idempotently.
 *
 * ⛔ WHY THE SWEEP RUNS THIS. Every tenant licensed before A2 holds a licence bound to a PERSON —
 * usually its oldest member, whose seat licence licences handed back as the tenant licence, or the
 * super_admin who ran the old "issue licence" route. Until a licence change happened, offboarding
 * that member revoked the workspace's Gate-2 licence (402 for everybody).
 *
 * Under the tenant's licence lease (busy → `busy`, next tick). The same preconditions
 * `ensureTenantLicense` applies: a tenant covered by a bundle (`svc:`) licence is left alone, and the
 * tenant is (re-)registered under its licences name first (a name conflict is reported, not retried
 * here). Then: identify the OLD licence by introspecting the stored token — ⚠️ PROD ROWS RECORD
 * NEITHER `licence_id` NOR A HOLDER (0095 backfills neither), so the token is the only source; if it
 * cannot be identified nothing is done. Mint the cp-tenant licence, CAS it in on the token read,
 * and then keep the old licence ONLY if it is a live member's seat in this tenant
 * (`oldLicenceIsASeat`); otherwise — a super_admin's, a departed member's — revoke it by id. A lost
 * CAS revokes what it minted (unless that IS the stored licence).
 */
export async function rehomeTenantLicence(tenantId: string): Promise<RehomeOutcome> {
  if (!config.license.issuanceEnabled || isSystemTenant(tenantId)) return 'skipped';
  try {
    return await withLicenceLease(tenantId, () => rehomeTenantLicenceLocked(tenantId));
  } catch (err) {
    if (isLicenceBusy(err)) return 'busy';
    throw err;
  }
}

async function rehomeTenantLicenceLocked(tenantId: string): Promise<RehomeOutcome> {
  const [row] = await runAsSystem('non-rls-table', () =>
    db
      .select({
        token: tenants.license_token_encrypted,
        licenceId: tenants.licence_id,
        holder: tenants.licence_subject_sub,
        status: tenants.status,
        offboardedAt: tenants.offboarded_at,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
  );
  if (!row?.token || isTenantLicenceSubject(row.holder)) return 'skipped';
  if (row.status !== 'active' || row.offboardedAt) return 'skipped';
  const oldBlob: string = row.token;

  // Same preconditions as ensureTenantLicense.
  if (await tenantHoldsTenantLevelLicence(tenantId)) return 'tenant_level';
  const { terms, registryName } = await tenantLicenceState(tenantId);
  if (!registryName) return 'skipped';
  try {
    await ensureRegisteredBeforeMint(tenantId, registryName);
  } catch (err) {
    if (err instanceof LicencesNameConflictError) return 'name_conflict';
    throw err;
  }

  // The OLD licence: what licences says the stored token is. EVERYTHING the keep-or-revoke decision
  // needs is fetched HERE, before the CAS — afterwards the tenant is on its cp-tenant holder and is
  // never selected by this sweep again, so a lookup failing after the swap would strand the decision.
  const old = await resolveStoredLicence(tenantId, oldBlob, row.licenceId);
  if (old.kind === 'unknown') {
    // licences could not be ASKED: re-homing now could orphan an active licence. Next tick.
    incCounter(REHOME_UNRESOLVED_COUNTER);
    log.warn('tenant_licence_rehome_deferred', {
      tenantId,
      reason: 'the stored licence could not be identified (introspect failed); re-homing would orphan it',
    });
    return 'unresolved';
  }
  // `inactive`: licences ANSWERED that the stored licence admits nothing — there is nothing to orphan
  // or revoke, and this workspace is 402 until it is re-homed, so re-home it.
  const revokeOld =
    old.kind === 'identified' &&
    !(await oldLicenceIsASeat(tenantId, old.licenceId, row.holder, old.subjectUuid));
  const pendingRevoke = revokeOld && old.kind === 'identified' ? old.licenceId : null;

  const [slotA] = tenantLicenceSubjects(tenantId);
  const { minted, holder } = await mintTenantLicence(tenantId, slotA, terms);
  const { token } = await licensesAdmin().createToken(minted.licenseId, tenantId);
  const swapped = await runAsSystem('non-rls-table', () =>
    db
      .update(tenants)
      .set({
        license_token_encrypted: encryptSecret(token),
        licence_id: minted.licenseId,
        licence_subject_sub: holder,
        // Recorded IN the swap: if the revoke below fails, the sweep still knows what to revoke.
        licence_revoke_pending: pendingAfter(
          pendingRevoke && pendingRevoke !== minted.licenseId ? pendingRevoke : null,
          minted.licenseId,
        ),
        updated_at: new Date(),
      })
      .where(and(eq(tenants.id, tenantId), eq(tenants.license_token_encrypted, oldBlob)))
      .returning({ id: tenants.id }),
  );
  if (swapped.length === 0) {
    // Somebody else rewrote the tenant licence meanwhile: ours is the orphan — release it, unless it
    // is the very licence the row now holds.
    if (minted.licenseId !== (await storedLicenceId(tenantId))) {
      await licensesAdmin()
        .revokeByLicenseId(minted.licenseId, tenantId)
        .catch((err: unknown) => {
          incCounter(LICENSE_PROVISION_ORPHAN_UNREVOKED_COUNTER);
          log.error('tenant_licence_rehome_orphan_unrevoked', { tenantId, licenseId: minted.licenseId, err });
        });
    }
    return 'lost_race';
  }

  // Still under the lease: settle the set now (whatever fails stays queued for the sweep).
  const oldRevoked = pendingRevoke ? (await settlePendingRevokesLocked(tenantId)).revoked > 0 : false;
  log.info('tenant_licence_rehomed', {
    tenantId,
    oldLicence: old.kind === 'identified' ? old.licenceId : old.kind,
    oldRevoked,
    newLicenceId: minted.licenseId,
    holder,
  });
  return 'rehomed';
}

/** A re-home deferred because licences could not be asked about the stored licence. */
export const REHOME_UNRESOLVED_COUNTER = 'tenant_licence_rehome_unresolved_total';

/** What licences says the tenant's stored token is. */
type StoredLicence =
  | { kind: 'identified'; licenceId: string; subjectUuid: string | null }
  /** licences ANSWERED: the token admits nothing (revoked / expired / unknown) — nothing to revoke. */
  | { kind: 'inactive' }
  /** licences could not be asked (introspect threw, token unreadable) — decide nothing. */
  | { kind: 'unknown' };

/**
 * Identify the stored licence by introspecting its token. ⚠️ Pre-0095 rows record no `licence_id`
 * and no holder, so licences is the only source of the id; an ANSWERED `active:false` carries no
 * `license_id` and is a definite "nothing active here", never an unknown.
 */
async function resolveStoredLicence(
  tenantId: string,
  blob: string,
  recordedId: string | null,
): Promise<StoredLicence> {
  const token = tryDecryptSecret(blob);
  if (!token) return { kind: 'unknown' };
  let seen;
  try {
    seen = await licenseClient().introspect(token);
  } catch (err) {
    log.warn('tenant_licence_introspect_failed', { tenantId, err });
    return { kind: 'unknown' };
  }
  if (seen.active !== true) return { kind: 'inactive' };
  const licenceId = seen.license_id ?? recordedId;
  if (!licenceId) return { kind: 'unknown' };
  return { kind: 'identified', licenceId, subjectUuid: seen.subject_id ?? null };
}

/**
 * The revoke-pending SET (0097) after a write: `add` appended (deduplicated), then `stored` — the
 * licence this write STORES as the tenant licence — removed. Every path that stores a tenant
 * licence passes it as `stored`, inside its own CAS: a licence the tenant is admitted on can never
 * sit in the set a sweep revokes from.
 */
function pendingAfter(add: string | null, stored: string | null): SQL {
  let expr: SQL = sql`${tenants.licence_revoke_pending}`;
  if (add) expr = sql`array_append(array_remove(${expr}, ${add}::uuid), ${add}::uuid)`;
  if (stored) expr = sql`array_remove(${expr}, ${stored}::uuid)`;
  return expr;
}

export interface SettleOutcome {
  revoked: number;
  /** Ids removed WITHOUT revoking: the stored tenant licence, or a live member's seat here. */
  dropped: number;
  failed: number;
}

/**
 * Settle a tenant's revoke-pending set. ⚠️ The caller MUST hold the tenant's licence lease
 * (`settlePendingRevokes` takes it): the stored licence read here must not move underneath.
 *
 * Per id: the licence currently STORED as the tenant licence, or a live member's seat in this tenant
 * (`oldLicenceIsASeat`), is DROPPED from the set, never revoked — revoking it is a 402 for the
 * workspace or a locked-out member. Anything else is revoked by id and removed once licences
 * confirms. A failure leaves the id (counted, logged) for the next sweep.
 */
async function settlePendingRevokesLocked(tenantId: string): Promise<SettleOutcome> {
  const out: SettleOutcome = { revoked: 0, dropped: 0, failed: 0 };
  const [row] = await runAsSystem('non-rls-table', () =>
    db
      .select({
        pending: tenants.licence_revoke_pending,
        licenceId: tenants.licence_id,
        token: tenants.license_token_encrypted,
        inferenceLicenceId: tenants.inference_licence_id,
        inferenceToken: tenants.inference_token_encrypted,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
  );
  if (!row || row.pending.length === 0) return out;
  const stored = row.token ? row.licenceId : null;
  // The tenant's STORED inference-router licence (0099) is protected the same way: a smoke-failed
  // IR licence is queued here (services/tenant-inference.ts), the live one must never be revoked.
  const storedInference = row.inferenceToken ? row.inferenceLicenceId : null;
  const remove = (id: string) =>
    runAsSystem('non-rls-table', () =>
      db
        .update(tenants)
        .set({ licence_revoke_pending: sql`array_remove(${tenants.licence_revoke_pending}, ${id}::uuid)` })
        .where(eq(tenants.id, tenantId)),
    );
  for (const id of row.pending) {
    try {
      if (id === stored || id === storedInference || (await oldLicenceIsASeat(tenantId, id, null, null))) {
        await remove(id);
        out.dropped++;
        log.warn('tenant_licence_pending_revoke_dropped', {
          tenantId,
          licenceId: id,
          reason: id === stored ? 'it is the stored tenant licence' : "it is a live member's seat here",
        });
        continue;
      }
      await licensesAdmin().revokeByLicenseId(id, tenantId);
      await remove(id);
      out.revoked++;
    } catch (err) {
      out.failed++;
      incCounter(LICENCE_CHANGE_OLD_UNREVOKED_COUNTER);
      log.error('tenant_licence_pending_revoke_failed', {
        tenantId,
        licenceId: id,
        remediation: 'kept in tenants.licence_revoke_pending; the onboarding-integrity sweep retries it',
        err,
      });
    }
  }
  return out;
}

/** `settlePendingRevokesLocked` under the tenant's licence lease; `null` = busy (next tick). */
export async function settlePendingRevokes(tenantId: string): Promise<SettleOutcome | null> {
  try {
    return await withLicenceLease(tenantId, () => settlePendingRevokesLocked(tenantId));
  } catch (err) {
    if (isLicenceBusy(err)) return null;
    throw err;
  }
}

/**
 * Is the outgoing tenant licence a LIVE member's seat in THIS tenant? Then it must not be revoked.
 *
 *   • a non-revoked `member_entitlements` row of this tenant holds that licence id (or that licences
 *     Subject); or
 *   • the licence's holder is a live, non-tombstoned member — known directly when a holder is
 *     recorded, else (every pre-0095 row records none) by asking licences which licences each live
 *     member's subject holds (`listSubjectLicences`).
 *
 * A client that cannot answer the second question (no `listSubjectLicences`) answers TRUE — "cannot
 * prove it is not a seat", and keeping a licence costs a seat while revoking a seat locks a person
 * out.
 */
async function oldLicenceIsASeat(
  tenantId: string,
  licenceId: string,
  holder: string | null,
  holderSubjectUuid: string | null,
): Promise<boolean> {
  if (isTenantLicenceSubject(holder)) return false;
  const seats = await withTenantDb(tenantId, () =>
    db
      .select({ id: memberEntitlements.id })
      .from(memberEntitlements)
      .where(
        and(
          eq(memberEntitlements.tenant_id, tenantId),
          sql`${memberEntitlements.status} <> 'revoked'`,
          holderSubjectUuid
            ? sql`(${memberEntitlements.license_id} = ${licenceId} OR ${memberEntitlements.license_subject_id} = ${holderSubjectUuid})`
            : eq(memberEntitlements.license_id, licenceId),
        ),
      )
      .limit(1),
  );
  if (seats.length > 0) return true;
  const members = await runAsSystem('non-rls-table', () =>
    db
      .select({ id: users.id, sub: users.keycloak_sub })
      .from(users)
      .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at))),
  );
  if (holder) return members.some((m) => m.id === holder || m.sub === holder);
  const client = licensesAdmin();
  if (typeof client.listSubjectLicences !== 'function') return members.length > 0;
  for (const m of members) {
    const sub = m.sub ?? m.id;
    const held = await client.listSubjectLicences(sub);
    if (held.some((l) => l.id === licenceId && l.status === 'active')) return true;
  }
  return false;
}

/**
 * Step 4 of `changeTenantLicence`: move every ACTIVE seat of a live, realm-backed member to `error`
 * and re-claim it with `ensureMemberEntitlement` — the exact path the onboarding-integrity seat
 * repair takes, so whatever fails here the sweep retries on the tenant's NEW terms. Platform staff
 * and rows with no `keycloak_sub` are skipped for the reasons `restoreSeatsForReactivate`
 * (routes/admin.ts) gives. NON-FATAL per member.
 */
async function reissueMemberSeats(tenantId: string, result: LicenceChangeResult): Promise<void> {
  const appKey = config.license.appKey;
  const members = await runAsSystem('non-rls-table', () =>
    db
      .select({ id: users.id, email: users.email, role: users.role, sub: users.keycloak_sub })
      .from(users)
      .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at))),
  );
  for (const m of members) {
    if (m.role === 'platform' || !m.sub) continue;
    try {
      const moved = await withTenantDb(tenantId, () =>
        db
          .update(memberEntitlements)
          .set({ status: 'error', last_error: 'licence terms changed; re-issue', updated_at: new Date() })
          .where(
            and(
              eq(memberEntitlements.tenant_id, tenantId),
              eq(memberEntitlements.user_id, m.id),
              eq(memberEntitlements.app_key, appKey),
              sql`${memberEntitlements.status} in ('active','error')`,
            ),
          )
          .returning({ id: memberEntitlements.id }),
      );
      if (moved.length === 0) continue; // unseated / mid-offboard: the sweep owns it
      await ensureMemberEntitlement(tenantId, m.id, m.sub);
      result.membersReissued++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('licence_change_member_reissue_failed', { tenantId, userId: m.id, err });
      result.memberFailures.push({ userId: m.id, email: m.email, message });
    }
  }
}

// ===================================================================================================
// PER-MEMBER ENTITLEMENTS (migration 0089)
// ===================================================================================================
//
// The tenant-level functions above bind ONE licence to the tenant's FIRST onboarded subject and
// no-op for everybody after. That is what makes a seat uncountable, unreleasable and unattributable
// (see the header of migration 0089 for the three consequences and their production numbers).
// Everything below issues one licence per MEMBER instead.
//
// ⚠️ BOTH SCHEMES RUN DURING THE MIGRATION. These functions do not touch
// `tenants.license_token_encrypted`, and the tenant functions do not touch `member_entitlements`.
// The gate decides which one is authoritative; until it flips, this is additive.

/**
 * How long a `pending` claim is respected before another caller may take it over.
 *
 * ⛔ WITHOUT THIS THE CLAIM IS NOT A CLAIM. The conflict arm below re-claims a row so a STALLED saga
 * can be retried — but `pending` is also exactly what the winner sets on its way to the network, so
 * a bare `status IN ('pending','error')` predicate lets a CONCURRENT caller take the row the winner
 * is actively minting against, and both call the licences service. That is not theoretical: it is
 * what the two-caller test measured (`createLicense` called twice) before this lease existed.
 *
 * Derived from the admin client's own timeout rather than hardcoded, so the two cannot drift apart:
 * a mint is up to three round trips (`ensureTenantRegistered`, `createLicense`, `createToken`), and
 * the lease must outlast the slowest legitimate one or a healthy mint gets stolen mid-flight. The
 * 2-minute floor covers a pathologically low configured timeout.
 */
export const MEMBER_CLAIM_LEASE_MS = Math.max(120_000, config.license.adminTimeoutMs * 6);

/** What `ensureMemberEntitlement` settled on. `pending` is NOT a failure — see the docblock. */
export type MemberEntitlementOutcome =
  | { state: 'disabled' }
  /**
   * Nothing minted: the tenant holds an active TENANT-LEVEL licence (ruling 2026-09-28), which is
   * what Gate 2 admits on. NOT a seat, and NOT a deferral — no member licence will ever be minted
   * while that licence stands. See `tenantHoldsTenantLevelLicence`.
   */
  | { state: 'tenant_licensed' }
  | { state: 'active'; licenseId: string; subjectId: string }
  | { state: 'pending'; reason: 'held-by-another-caller' | 'revoking' };

/**
 * Ensure this member holds their own `commonpractice` licence, idempotently.
 *
 * ⭐ THE CLAIM HAPPENS BEFORE THE MINT, WHICH IS WHY THIS HAS NO ORPHAN RACE.
 * `ensureTenantLicense` above cannot claim first — its uniqueness key is the tenant row, and two
 * first-time callers carry DIFFERENT subjects, so the licences service's own idempotency key
 * `(subject, tenant, app)` differs for each and BOTH mint a real, billable licence. It compensates
 * with a compare-and-set on the store plus a self-revoke by the loser.
 *
 * Per member that entire problem disappears, for two independent reasons:
 *   1. `member_entitlements_live_uq` is a PARTIAL UNIQUE INDEX on `(tenant, user, app)`, so the
 *      INSERT below is itself the mutual exclusion — Postgres evaluates it while holding the row
 *      lock and exactly one concurrent caller can win. We claim the slot, THEN call the network.
 *   2. Even if two callers somehow both minted, they would pass the SAME `keycloakSub`, so the
 *      licences service's `(subject, tenant, app)` idempotency returns the SAME licence to both.
 *      The tenant path could not rely on that; this one can.
 *
 * ⛔ NO DB CONTEXT IS HELD ACROSS THE HTTP CALLS. `withTenantDb` reserves a connection, and this
 * function makes up to three external round-trips. Holding a reserved connection across those is
 * the hazard `ensureTenantLicense`'s CONCURRENCY GUARD note rejects an advisory lock for; the same
 * reasoning forbids it here. So: short claim txn → network → short finalise txn.
 *
 * ⛔ `keycloakSub` IS A SEPARATE PARAMETER AGAIN, AND COLLAPSING IT WAS A REAL DEFECT.
 * It was briefly folded into `userId` on the grounds that `upsertLocalUserTx` writes the realm
 * subject into the primary key (`values({ id: sub, … })`), so the two are the same string for every
 * provisioned member. That reasoning is true and was answering the WRONG QUESTION: it establishes
 * the identity for the ONBOARDING paths, and says nothing about a caller that did not just mint the
 * sub. The reconciler is exactly such a caller — it selects by predicate
 * (`live AND role<>'platform' AND tenant active`), and `db/seed-tenant-showcase.ts` inserts
 * `role:'employee'` users with NO id, so `users.id` defaults to `uuidv7()`. Sweeping those would
 * register a licences-service Subject keyed on a value that can NEVER authenticate — and count it as
 * a billable seat. On production 2026-09-17 most CP users are exactly those seeded rows.
 * ⚠️ The measurement quoted here previously ("23 users … ZERO divergences") OVERSTATED itself: 22 of
 * those 23 had a NULL `keycloak_sub`, so they were UNMEASURABLE, not agreeing. n=1, not n=23.
 * So the caller must now PROVE the subject rather than have it inferred: the onboarding paths pass
 * the sub they just provisioned, and the reconciler passes the recorded `users.keycloak_sub` and
 * SKIPS any row that has none.
 *
 * Returns `pending` (not an error) when another caller owns the in-flight mint, or when the member
 * is mid-offboard. The caller must treat `pending` as NOT YET LICENSED — the gate denies it — and
 * the reconciler in `host/onboarding-integrity.ts` sweeps rows that stay that way.
 */
export async function ensureMemberEntitlement(
  tenantId: string,
  userId: string,
  keycloakSub: string,
): Promise<MemberEntitlementOutcome> {
  if (!config.license.issuanceEnabled) return { state: 'disabled' };

  // ---- 0. TENANT-LEVEL LICENCE? -----------------------------------------------------------------
  // Checked BEFORE the claim so no `pending` row is written for a member who will never be minted
  // (a stale `pending` row is what the reconciler re-offers every tick). A licences outage here is a
  // 502 like the mint below would have been.
  try {
    if (await tenantHoldsTenantLevelLicence(tenantId)) {
      log.info('license_mint_skipped_tenant_level', { tenantId, userId, path: 'member' });
      return { state: 'tenant_licensed' };
    }
  } catch (err) {
    as502(err, 'check tenant-level license');
  }

  const appKey = config.license.appKey;

  // ---- 1. CLAIM ---------------------------------------------------------------------------------
  // One statement, atomic. The `DO UPDATE ... setWhere` is what makes this a CLAIM rather than an
  // upsert: an `active` row does not match, so no row comes back and we fall through to the read
  // below and report it as already-licensed. A `revoking` row likewise does not match — re-minting a
  // licence for someone being offboarded would hand back the seat we are in the middle of releasing.
  // `revoked` is outside the partial index entirely, so a re-hire simply INSERTs a fresh row.
  //
  // ⛔ THE LEASE TERM IS LOAD-BEARING, NOT DEFENSIVE. `status IN ('pending','error')` alone LOOKS
  // like a claim and is not one: `pending` is what the WINNER writes on its way to the network, so a
  // concurrent caller matches it and both mint. Measured, not reasoned — the two-caller test saw
  // `createLicense` called twice. An `error` row is takeable immediately (nobody is working it); a
  // `pending` row only once its lease has expired, which is the difference between "this saga
  // stalled" and "somebody is mid-flight".
  const claimed = await withTenantDb(tenantId, () =>
    db
      .insert(memberEntitlements)
      .values({ tenant_id: tenantId, user_id: userId, app_key: appKey, status: 'pending' })
      .onConflictDoUpdate({
        target: [memberEntitlements.tenant_id, memberEntitlements.user_id, memberEntitlements.app_key],
        targetWhere: sql`status <> 'revoked'`,
        setWhere: sql`${memberEntitlements.status} = 'error' or (${memberEntitlements.status} = 'pending' and ${memberEntitlements.updated_at} < now() - make_interval(secs => ${MEMBER_CLAIM_LEASE_MS / 1000}))`,
        set: {
          status: 'pending',
          attempts: sql`${memberEntitlements.attempts} + 1`,
          updated_at: new Date(),
        },
      })
      .returning({ id: memberEntitlements.id }),
  );

  if (claimed.length === 0) {
    // Someone else holds this slot. Read it back to say WHICH of the two non-claimable states it is,
    // because they mean different things to the caller: `active` is success, `revoking` is a refusal.
    const [existing] = await withTenantDb(tenantId, () =>
      db
        .select({
          status: memberEntitlements.status,
          licenseId: memberEntitlements.license_id,
          subjectId: memberEntitlements.license_subject_id,
        })
        .from(memberEntitlements)
        .where(
          and(
            eq(memberEntitlements.tenant_id, tenantId),
            eq(memberEntitlements.user_id, userId),
            eq(memberEntitlements.app_key, appKey),
          ),
        )
        .limit(1),
    );
    if (existing?.status === 'active' && existing.licenseId && existing.subjectId) {
      return { state: 'active', licenseId: existing.licenseId, subjectId: existing.subjectId };
    }
    return {
      state: 'pending',
      reason: existing?.status === 'revoking' ? 'revoking' : 'held-by-another-caller',
    };
  }

  const rowId = claimed[0]!.id;

  // ---- 2. MINT (no DB context held) -------------------------------------------------------------
  try {
    // Idempotent, and required: the licences service refuses to mint for an UNREGISTERED tenant
    // (its FK-backed mint guard). A tenant created before issuance was switched on has never been
    // registered, and its first MEMBER onboard would 502 here exactly as its first tenant onboard
    // once did.
    const { terms, registryName } = await tenantLicenceState(tenantId);
    if (!registryName) {
      throw new HttpError(
        502,
        'license_provisioning_failed',
        `issue member license: tenant ${tenantId} has no slug to register`,
      );
    }
    await ensureRegisteredBeforeMint(tenantId, registryName);

    // `keycloakSub` goes in the path; `subjectId` comes BACK and is the licences-service Subject
    // UUID — a different identifier (0089). Never send `userId` here: see the docblock.
    // On the TENANT's plan and dates (0095), not the global default — and through `mintWithTerms`,
    // because licences hands back an existing old-terms licence for the same subject.
    const [tenantRow] = await runAsSystem('non-rls-table', () =>
      db.select({ licenceId: tenants.licence_id }).from(tenants).where(eq(tenants.id, tenantId)),
    );
    const { licenseId, subjectId } = await mintWithTerms(keycloakSub, tenantId, terms, {
      protectLicenceId: tenantRow?.licenceId ?? null,
    });
    const { token } = await licensesAdmin().createToken(licenseId, tenantId);
    const encrypted = encryptSecret(token);

    // ---- 3. FINALISE ----------------------------------------------------------------------------
    // `status='pending'` in the predicate, so an offboard that began while we were on the network
    // wins and we do NOT resurrect the entitlement underneath it.
    const won = await withTenantDb(tenantId, () =>
      db
        .update(memberEntitlements)
        .set({
          license_id: licenseId,
          license_subject_id: subjectId,
          token_encrypted: encrypted,
          status: 'active',
          provisioned_at: new Date(),
          last_error: null,
          updated_at: new Date(),
        })
        .where(and(eq(memberEntitlements.id, rowId), eq(memberEntitlements.status, 'pending')))
        .returning({ id: memberEntitlements.id }),
    );

    if (won.length === 0) {
      // The row moved out of `pending` while we were minting — in practice an offboard. The licence
      // we just created is a genuine orphan: nothing stored it, so no revoke path can ever find it,
      // and an unrevoked licence is a paid, invisible seat. Same failure and same remedy as
      // `ensureTenantLicense`'s lost-race arm; revoke by LICENCE ID because releasing the seat is
      // the point (revoking only the token would leave `status='active'` upstream and keep it
      // counting toward `human_subjects`).
      try {
        await licensesAdmin().revokeByLicenseId(licenseId, tenantId);
        log.warn('member_entitlement_claim_lost', { tenantId, userId, licenseId });
      } catch (revokeErr) {
        incCounter(LICENSE_PROVISION_ORPHAN_UNREVOKED_COUNTER);
        log.error('member_entitlement_orphan_unrevoked', {
          tenantId,
          userId,
          licenseId,
          error: revokeErr instanceof Error ? revokeErr.message : String(revokeErr),
        });
      }
      return { state: 'pending', reason: 'revoking' };
    }

    return { state: 'active', licenseId, subjectId };
  } catch (err) {
    // Park the failure ON THE ROW so the reconciler can see it and a later caller can retry (the
    // claim statement above re-claims an `error` row). Best-effort: if this write also fails we
    // still surface the original error, which is the one worth reporting.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await withTenantDb(tenantId, () =>
        db
          .update(memberEntitlements)
          .set({ status: 'error', last_error: message.slice(0, 500), updated_at: new Date() })
          .where(and(eq(memberEntitlements.id, rowId), eq(memberEntitlements.status, 'pending'))),
      );
    } catch {
      /* the original error below is the one that matters */
    }
    as502(err, 'issue member license');
  }
}

/**
 * Release a member's seat: revoke their licence upstream, then tombstone the local row.
 *
 * ⛔ REVOKE THE LICENCE, NOT THE TOKEN. A token revoke leaves the licence `status='active'`, so
 * licences-service `human_subjects` keeps counting it and the tenant keeps paying for someone who
 * has left. `revokeByLicenseId` also confirms `revoked === true`, because that endpoint answers
 * **200** with `{"revoked": false}` for an unknown or foreign licence (see licenses-admin.ts).
 *
 * ⚠️ THE ROW GOES TO `revoking` FIRST, AND THAT STATE IS BILLABLE. Access is denied the moment the
 * status leaves `active`, but the SEAT is not released until the licences service acknowledges. If
 * that call fails the row stays `revoking` for the reconciler to retry — and the tenant is still
 * being charged for it in the meantime. That is a revenue fact and it is why this function does not
 * swallow the failure.
 */
export async function revokeMemberEntitlement(tenantId: string, userId: string): Promise<void> {
  if (!config.license.issuanceEnabled) return;
  const appKey = config.license.appKey;

  // Claim the revoke. Only a caller that moves the row INTO `revoking` goes on to call the service,
  // so a double-offboard cannot double-revoke.
  //
  // ⛔ `revoking` IS IN THE CLAIM SET, AND LEAVING IT OUT MADE THE RETRY SWEEP INERT. The first
  // version claimed `active|pending|error` only — which reads as correct ("don't re-revoke something
  // already being revoked") and silently disabled the one caller that matters: `releaseStuckSeats`
  // selects EXACTLY the `revoking` rows, so every row it handed here matched nothing, returned
  // early, and was counted as released. A stuck seat would have stayed billable forever while the
  // sweep reported success on it. Caught by the test, not by review.
  //
  // Re-entering `revoking` is safe: the upstream revoke is idempotent (an already-revoked licence
  // answers `{"revoked": true}` BY DESIGN — see licenses-admin.ts), and `updated_at` moves, so a
  // retry is distinguishable from a row nobody has touched.
  const claimed = await withTenantDb(tenantId, () =>
    db
      .update(memberEntitlements)
      .set({ status: 'revoking', updated_at: new Date() })
      .where(
        and(
          eq(memberEntitlements.tenant_id, tenantId),
          eq(memberEntitlements.user_id, userId),
          eq(memberEntitlements.app_key, appKey),
          sql`${memberEntitlements.status} in ('active','pending','error','revoking')`,
        ),
      )
      .returning({ id: memberEntitlements.id, licenseId: memberEntitlements.license_id }),
  );
  if (claimed.length === 0) return; // already `revoked` — genuinely nothing left to release

  const { id, licenseId } = claimed[0]!;

  // A `pending`/`error` row may never have reached the mint, so there is no licence to revoke and no
  // seat was ever counted. Tombstone it and stop — calling the service with a null id would be a
  // 422, and treating that as a failure would block an offboard over a seat that does not exist.
  if (!licenseId) {
    await withTenantDb(tenantId, () =>
      db
        .update(memberEntitlements)
        .set({ status: 'revoked', revoked_at: new Date(), updated_at: new Date() })
        .where(eq(memberEntitlements.id, id)),
    );
    return;
  }

  try {
    await licensesAdmin().revokeByLicenseId(licenseId, tenantId);
  } catch (err) {
    // Leave the row `revoking` deliberately: it is the reconciler's queue AND the honest record that
    // this seat is still active upstream. Do not tombstone on failure — that would make an
    // unreleased, still-billed seat indistinguishable from a released one, which is precisely the
    // defect `revokeTenantLicense` documents at its own fail-open site.
    log.error('member_entitlement_revoke_failed', {
      tenantId,
      userId,
      licenseId,
      err,
    });
    as502(err, 'revoke member license');
  }

  await withTenantDb(tenantId, () =>
    db
      .update(memberEntitlements)
      .set({
        status: 'revoked',
        revoked_at: new Date(),
        token_encrypted: null,
        updated_at: new Date(),
      })
      .where(eq(memberEntitlements.id, id)),
  );
}
