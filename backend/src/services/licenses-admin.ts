// src/services/licenses-admin.ts — Phase 4 / F.2: the licenses-service ADMIN (write) client.
//
// Spec: SPEC-PHASE4-admin-tenant-isolation.md Part 9 (§9.3). F.1 shipped the READ side
// (services/license-client.ts → public `POST /license/introspect`, no auth). F.2 adds the WRITE
// side: per-tenant license PROVISIONING against the licenses service's admin API, which is role-
// gated behind the `secure-apps` Keycloak realm (a service account holding `license-admin`). This
// is a DIFFERENT auth boundary from CP's `portal` user realm (Spec §9.4 — don't conflate them).
//
// Mirrors the keycloak-admin client's seams (services/keycloak-admin.ts): an injectable `fetchImpl`
// + `now()` clock, a 60s service-token cache, an `authed()` Bearer helper, a `LicensesAdminClient`
// interface the provisioning layer + tests program against, and a module accessor +
// `__setLicensesAdminForTests` override (no process-wide mocks). The ONE structural difference: the
// grant is `client_credentials` (a confidential SA), not keycloak-admin's `password` grant.
//
// FAIL-LOUD CONTRACT: every method THROWS LicensesAdminError on a non-2xx / transport failure. The
// provisioning layer (services/license-provisioning.ts) maps that to a 502 — a licenses-service
// outage must BLOCK tenant onboarding / suspension, never silently succeed (Spec §9.3, mirrors the
// Keycloak-502 posture). `POST /apps` stays one-time OPS/runbook work. PLANS of this app are
// managed from CP since A2 (routes/platform-plans.ts → list/create/update/delete below, app pinned
// to `appKey`), and issuance resolves the tenant's plan code to its UUID per call
// (`GET /apps/{key}` + `/plans`), because the UUID-keyed `LicenseCreate` takes no codes.
import { config } from '../config';
import type { LicenseIntrospectResponse } from './license-client';

/** Thrown by any licenses admin-API failure (token / create-license / mint-token / revoke). */
export class LicensesAdminError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `licenses admin request failed: HTTP ${status}`);
    this.name = 'LicensesAdminError';
  }
}

/**
 * The licences registry refused a register (`PUT /tenants/{id}`) or rename (`PATCH /tenants/{id}`)
 * with 409 `tenant_name_taken`. Since licences migration 050 tenant names are unique PER OWNING APP,
 * so this means CP ITSELF already holds a licences tenant with that name — another app's tenant of
 * the same name is no longer a conflict. Extends `LicensesAdminError` (status 409) so existing
 * `instanceof LicensesAdminError` mappings keep working.
 */
export class LicencesNameConflictError extends LicensesAdminError {
  /** The contested registry name (the CP slug). Not `name` — that is `Error.name`. */
  readonly tenantName: string;
  constructor(tenantName: string, message?: string) {
    super(409, message ?? `CP already holds a licences tenant named '${tenantName}'`);
    this.name = 'LicencesNameConflictError';
    this.tenantName = tenantName;
  }
}

/**
 * The licences registry refused `PUT /tenants/{id}` with 409 `tenant_owned_by_other_app`: the id is
 * registered to a DIFFERENT owning app. CP mints its tenant ids itself (UUIDv7), so for a tenant CP
 * created this cannot happen by accident — it means the id is shared with another app's tenant (a
 * pre-050 platform tenant CP adopted) or a bug. Never retried, never renamed around: surfaced loudly.
 */
export class LicencesTenantOwnedByOtherAppError extends LicensesAdminError {
  readonly tenantId: string;
  constructor(tenantId: string, message?: string) {
    super(409, message ?? `licences tenant ${tenantId} is owned by a different app`);
    this.name = 'LicencesTenantOwnedByOtherAppError';
    this.tenantId = tenantId;
  }
}

/** The 403 refusal codes licences' ownership rules (migration 050) answer a write with. */
export type LicencesAccessRefusalCode =
  | 'unknown_api_client'
  | 'tenant_not_accessible'
  | 'app_not_issuable_by_caller';

const ACCESS_REFUSAL_CODES: ReadonlySet<string> = new Set<LicencesAccessRefusalCode>([
  'unknown_api_client',
  'tenant_not_accessible',
  'app_not_issuable_by_caller',
]);

/**
 * licences refused a write with 403 under its ownership rules: CP's client is not registered as an
 * owning app (`unknown_api_client`), the tenant is neither CP's nor granted to CP
 * (`tenant_not_accessible`), or CP may not issue this app's licences (`app_not_issuable_by_caller`).
 * Permanent until licences' data changes — never retried, never answered with a fallback.
 */
export class LicencesAccessRefusedError extends LicensesAdminError {
  readonly code: LicencesAccessRefusalCode;
  constructor(code: LicencesAccessRefusalCode, message: string) {
    super(403, message);
    this.name = 'LicencesAccessRefusedError';
    this.code = code;
  }
}

/** One app of a bundle as licences ensured it (`BundleEnsureApp`, licences main.py). */
export interface BundleEnsuredApp {
  decision: 'exists' | 'adopt' | 'insert';
  licenseId: string | null;
  plan: string | null;
}

/** An app licences REFUSED inside a bundle ensure; nothing was written for it. */
export interface BundleRefusedApp {
  app: string;
  reason: string;
}

/**
 * What `POST /internal/tenants/{id}/bundles/{bundle}/ensure` answered with a body CP can read: 200
 * (every app ensured) or 409 with the SAME body (some apps refused, the others still ensured).
 */
export interface BundleEnsureOutcome {
  bundle: string;
  apps: Record<string, BundleEnsuredApp>;
  refused: BundleRefusedApp[];
}

/**
 * licences refused a bundle ensure as a whole: `{"detail": {"error", "message"}}` with
 * 403 `tenant_owner_only` / `tenant_not_accessible` / `unknown_api_client` /
 * `bundle_not_ensurable_by_caller` (the bundle holds an app CP may not ensure), 404 `bundle_not_found` /
 * `bundle_empty` / `tenant_not_found`, 409 `tenant_archived`, 422 …. `code` is licences' own
 * `detail.error`; a 403 whose detail is a bare string (a missing realm role) is `licences_forbidden`.
 */
export class LicencesBundleError extends LicensesAdminError {
  readonly code: string;
  readonly bundle: string;
  constructor(status: number, code: string, bundle: string, message: string) {
    super(status, message);
    this.name = 'LicencesBundleError';
    this.code = code;
    this.bundle = bundle;
  }
}

/** A licences registry tenant, as `GET /tenants/{name_or_id}` returns it (only the fields CP reads). */
export interface LicencesTenant {
  id: string;
  name: string;
  /**
   * The app that OWNS this tenant in the registry (licences migration 050: `tenants.owner_key`,
   * e.g. 'commonpractice', 'platform', 'fr'). `null` when the response carried no usable value (a
   * pre-050 service, or a test fake that predates the field) — callers that gate a destructive
   * step on ownership must treat `null`/absent as UNKNOWN and refuse, never as "ours".
   */
  ownerKey?: string | null;
}

/**
 * CP's owner key in the licences registry — what licences derives from CP's SA client
 * (`api_client` row `secure-apps/commonpractice-licenses-admin -> commonpractice`, migration 050).
 * NOT `config.license.appKey`: that is the APP CP mints licences for; this is the OWNER CP acts as.
 * They are the same string today, and that coincidence is exactly why they must not be conflated.
 */
export const CP_LICENCES_OWNER_KEY = 'commonpractice';

export interface LicensesAdminOptions {
  /** Admin API base, e.g. https://licenses.example.com (per-tenant issue/token/revoke). */
  adminBaseUrl?: string;
  /** The `secure-apps` realm token endpoint (client_credentials grant). */
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** The licenses `App.key` to bind issued licenses to (defaults to config.license.appKey). */
  appKey?: string;
  /** The plan tier code to issue (defaults to config.license.planCode). */
  planCode?: string;
  /** Injectable for tests (no live licenses service). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms). Defaults to Date.now — only used for the service-token cache. */
  now?: () => number;
}

/** The minimal write surface the provisioning layer + tests depend on (real + fake both satisfy). */
export interface LicensesAdminClient {
  /**
   * Register CP's tenant id in the licenses service's canonical tenant registry, idempotently.
   *
   * The licenses service enforces a mint guard — "a NEW license may only be minted for a REGISTERED
   * tenant" (its `license.tenant_id → tenants.id` FK). CP owns its own tenants table and never
   * registered them there, so `createLicense` was refused for every tenant created in CP and the
   * onboarding approve/invite returned 502. This closes that gap.
   *
   * Uses `PUT /tenants/{id}`, which registers with the CALLER-supplied id. `POST /tenants` would mint
   * a *different* UUIDv7 from the name, leaving CP and the platform with two ids for one tenant and
   * mis-keying billing — so it is deliberately not used here.
   */
  ensureTenantRegistered(tenantId: string, name: string): Promise<void>;
  /**
   * Create a `commonpractice` License for (subject, tenant).
   *
   * ⚠️ TWO DIFFERENT IDENTIFIERS, AND CONFLATING THEM IS THE DEFECT THIS RETURN TYPE EXISTS TO
   * CLOSE. The `subjectId` ARGUMENT is the **Keycloak `sub`** — the licenses service takes it in the
   * path and does `create_or_get_subject(keycloak_sub=…)`. The returned `subjectId` is the
   * service's own **Subject UUID (`subject.id`)**, a different value, and it is what every
   * downstream consumer means by `subject_id`: billing prices and attributes a cost event on it.
   *
   * This method used to return `{licenseId}` alone and DISCARD the response's `subject_id`. With no
   * central subject to hand, `host/metering-emit.ts` sent CP's own `users.id` instead — which is
   * why 100% of this service's central spend landed `attribution_status='unlicensed'` (six
   * `billing_cost_daily` rows, 696 requests, $1.0008, the same `users.id` repeated across two
   * different tenants). Store what comes back; do not re-derive it.
   */
  createLicense(
    subjectId: string,
    tenantId: string,
    terms?: LicenceTerms,
  ): Promise<CreatedLicence>;
  /**
   * Mint a raw token for a license. The licenses service returns it ONCE — capture + store it.
   * `tenantId` is REQUIRED: the service resolves the request tenant from `X-Tenant-Id` and rejects
   * (404) if it doesn't own the license (licenses `get_tenant_id` → ownership check).
   */
  createToken(licenseId: string, tenantId: string): Promise<{ token: string }>;
  /**
   * Revoke a license by its token (offboarding / suspend). Idempotent at the service.
   * `tenantId` is REQUIRED for the same ownership check — omitting it makes revoke a silent no-op.
   */
  revokeByToken(token: string, tenantId: string): Promise<void>;
  /**
   * Revoke a license by its LICENSE ID, for per-member offboarding.
   *
   * ⛔ WHY THIS EXISTS ALONGSIDE `revokeByToken`. Offboarding must release the SEAT, and a seat is a
   * licence — not a token. Revoking a token leaves the licence `status='active'`, so licences-service
   * `human_subjects` keeps counting it and the tenant keeps paying for a member who left. The
   * entitlement row also may not hold a usable token at all (a `pending`/`error` saga never stored
   * one, and a decrypt can fail), whereas `license_id` is written the moment the remote call returns.
   *
   * ⚠️ It applies the SAME `revoked === true` confirmation as `revokeByToken`, because the licences
   * service answers **200** with `{"revoked": false, "message": "License not found"}` for an unknown
   * or foreign licence. `revokeByToken`'s own comment flagged this arm as an unfixed sibling hole
   * "if one appears" — this is that caller, so the treatment comes with it rather than after it.
   */
  revokeByLicenseId(licenseId: string, tenantId: string): Promise<void>;

  // -------------------------------------------------------------------------------------------
  // TENANT-REGISTRY LIFECYCLE (archive / registration probe / BYO posture)
  //
  // ⚠️ THESE THREE ARE OPTIONAL IN THE TYPE AND MANDATORY IN BEHAVIOUR, AND THAT IS NOT A
  // HEDGE — READ WHY BEFORE "TIDYING" THE `?` AWAY.
  //
  // `LicensesAdminClient` is the shape every TEST FAKE is declared against, and those fakes are
  // object literals scattered across several test files owned by different people. Making a new
  // method REQUIRED breaks every one of them at compile time — including files this change is not
  // allowed to touch — so the choice is between an optional member here and a typecheck failure in
  // somebody else's suite. `LicensesAdminService` (the only client that ever runs in production)
  // implements all three unconditionally.
  //
  // ⛔ AND THE OPTIONALITY IS NOT ALLOWED TO BECOME A SILENT NO-OP, which is the whole hazard of
  // `await client.archiveTenant?.(id)`: that expression succeeds by doing nothing, and a caller who
  // reads `await` as "it happened" gets a tenant that was never archived and no evidence of it.
  // Every call site therefore goes through `adminMethod()` below, which THROWS
  // `LicensesAdminError(501)` when the method is missing. An absent implementation is reported like
  // any other licences failure rather than passing as success.
  // -------------------------------------------------------------------------------------------

  /**
   * Archive the tenant in the licences registry — the CENTRAL counterpart of CP's own
   * `tenants.offboarded_at`.
   *
   * ⛔ REVOKING THE SEATS IS NOT ARCHIVING THE TENANT. Per-member revoke (`revokeByLicenseId`)
   * releases what the customer is billed for; the tenant ROW in the licences registry survives it,
   * still `active`, still mintable, and still countable by anything that enumerates tenants rather
   * than licences. A departed customer that is invisible in CP and present-and-active centrally is
   * exactly the asymmetry that makes a central reconciliation report CP as the source of drift.
   *
   * ⛔ ARCHIVING REVOKES NOTHING, AND THE ORDER IS THEREFORE NOT INTERCHANGEABLE. Licences'
   * `set_tenant_archived` flips a flag: an archived tenant's licences stop AUTHORIZING
   * (`/license/introspect` answers `active:false, reason:"tenant_archived"`) but they are not
   * revoked, so they keep counting as seats. Un-archiving is a true restore, which is exactly why it
   * cannot stand in for a revoke. The offboard route must revoke every member seat FIRST and archive
   * LAST; archiving first would look like it had released the headcount and would not have.
   *
   * Path measured against the licences source rather than inferred: `PATCH /tenants/{name_or_id}/
   * archive` with a `TenantArchiveUpdate` body, role `license-admin` (licenses/main.py
   * `set_tenant_archived`). The SA this client authenticates as already holds that role.
   */
  archiveTenant?(tenantId: string): Promise<void>;

  /**
   * Is this tenant id known to the licences registry at all?
   *
   * The reconciler's probe. CP has NO local column recording central registration — adding one
   * would be a migration — so "unregistered" can only be answered by asking. A
   * `GET /tenants/{id}/byo-mode` 404 is that answer — the same `tenant_not_found_in_registry`
   * literal `getTenantByoMode` already branches on (NOT `GET /tenants/{id}`, whose 404 is generic and
   * also covers a foreign tenant; see the implementation). ⚠️ Branch on the LITERAL, never on the bare 404: an unmatched ROUTE is also
   * a 404, and reading that as "no tenant is registered anywhere" would make the repair sweep
   * re-register the entire fleet on every tick.
   */
  isTenantRegistered?(tenantId: string): Promise<boolean>;

  /**
   * Declare the tenant's BYO posture centrally, for THIS app.
   *
   * ⛔ AN UNSET POSTURE IS NOT A NEUTRAL POSTURE. `services/byo-posture.ts` fails CLOSED when it
   * cannot resolve one (`byo_required`), and `getTenantByoMode` answers an unregistered tenant
   * `byo_required` by the same rule. So a tenant nobody ever set a posture for is refused the
   * platform credential on every LLM call — a brand-new workspace that was just granted a welcome
   * budget it is then forbidden to spend. Stating the posture at create is what stops "we never
   * said" from being read as "the customer pays their own provider".
   */
  setTenantByoMode?(tenantId: string, mode: ByoMode): Promise<void>;

  /**
   * Resolve the ACTIVE `commonpractice` licence the tenant holds, whoever the holder is.
   *
   * ⭐ WHY THIS EXISTS: LICENCES ARE TENANT-LEVEL (ruling 2026-09-28). A tenant's bundle carries ONE
   * licence per (tenant, app), held by the service subject `svc:<tenant-uuid>:<app>` — a licence CP
   * never minted and therefore holds no token for. `tenants.license_token_encrypted` and
   * `member_entitlements` are only ever written by CP's own onboarding, so a tenant licensed through
   * its bundle alone read as unlicensed everywhere in CP. This is the lookup that sees it.
   *
   * `GET /licenses/active?tenant_id=&app_key=` (licences `get_active_license`). Role gate:
   * `require_internal_or_reader`, and the cross-tenant read is admitted only for the
   * INTERNAL_SERVICE_ROLES (`service-internal` / `onboarding-internal` / `license-admin`); CP's SA
   * holds `license-admin`, so it may name any tenant. The response is the introspect shape.
   *
   * `opts.subjectId` is the service's OPTIONAL seat selector (a Keycloak sub such as
   * `svc:<tenant>:<app>`, or a Subject UUID). It never causes a denial: when it resolves, that exact
   * licence comes back with `subject_match: true`; otherwise the tenant-level pick comes back with
   * `subject_match: false`. So "does THIS holder have a licence" is `subject_match === true`, never a
   * non-null result alone.
   *
   * Returns `null` ONLY for the service's own `no_active_license` 404. Every other non-2xx (including
   * an unmatched-route 404) THROWS — reading an outage or a wrong path as "no licence" is how a gate
   * stops being able to fail. Same literal-not-status discrimination as `isTenantRegistered`.
   *
   * Optional in the TYPE for the reason the block above gives (dozens of test fakes). Unlike the
   * three writes, a caller MAY treat its absence as "cannot tell" — see the callers.
   */
  getActiveLicense?(
    tenantId: string,
    opts?: { subjectId?: string },
  ): Promise<LicenseIntrospectResponse | null>;

  /**
   * `GET /tenants/{name_or_id}` → the registry tenant, or `null` when licences answers its own
   * `"Tenant not found"` 404. Since licences migration 050 the lookup is OWNER-SCOPED: a name
   * resolves only among CP's own licences tenants, and another app's tenant id answers the same 404
   * as an absent one. Any other non-2xx — including an unmatched-route `"Not Found"` 404 — throws.
   */
  getTenant?(nameOrId: string): Promise<LicencesTenant | null>;

  /**
   * `PATCH /tenants/{id}` `{name}` — rename CP's OWN licences tenant (licences `rename_tenant`, role
   * `license-admin`). Renaming to the current name is a no-op upstream. A name another of CP's OWN
   * licences tenants holds (409 `tenant_name_taken`; names are unique per owning app) throws
   * `LicencesNameConflictError`.
   *
   * The implementation also asks the (owner-scoped) `GET /tenants/{name}` FIRST and raises the
   * conflict itself when another of CP's tenants holds the name, without sending the PATCH; the 409
   * covers the race between that read and the write.
   */
  renameTenant?(tenantId: string, name: string): Promise<void>;

  /**
   * `GET /licenses/user/{sub}` — every licence (any status, any tenant) a subject holds. CP's SA
   * holds `license-admin`, the cross-tenant tier. `[]` for licences' own "Subject not found" 404;
   * any other non-2xx throws. Used ONLY for CP's own cp-tenant subjects (`sweepTenantLicences`).
   */
  listSubjectLicences?(sub: string): Promise<SubjectLicence[]>;

  /**
   * `GET /licenses?status=active` + `X-Tenant-Id: <tenant>` — every licence row on the tenant whose
   * STORED status is `active`, across ALL apps and subjects (licences `list_licenses`; role
   * `license-admin`, which CP's SA holds). Offboarding uses it to find what is still live on a
   * CP-owned tenant after CP's own licence and seats are gone — in practice the per-app licences
   * CP's bundles minted (`svc:<tenant>:<app>`), which licences lets the tenant OWNER revoke even
   * for apps CP does not issue (licenses#265, `_bundle_owner_may_revoke`).
   *
   * ⚠️ The response carries NO `bundle_id` (licences' `LicenseResponse` omits it), and
   * `metadata.bundle` is only set on licences a bundle INSERTED, not ones it ADOPTED — so `bundle`
   * below is a hint for the report, never a filter. Licences itself is the gate: a revoke of a row
   * CP neither issues nor minted through a bundle is refused 403.
   */
  listTenantLicences?(tenantId: string): Promise<TenantLicence[]>;

  /** `GET /apps/{appKey}/plans` — the plan catalogue of THIS app (never another app's). With
   *  `includeRevoked`, retired plans too (`?include_revoked=true`; an older licences ignores the
   *  param and simply returns the live ones). */
  listPlans?(opts?: { includeRevoked?: boolean }): Promise<LicencesPlan[]>;
  /** `POST /plans` for THIS app (the app id is resolved server-side from `appKey`). 409 → code taken. */
  createPlan?(input: PlanCreateInput): Promise<LicencesPlan>;
  /** `PATCH /plans/{id}` — the caller must have checked the id belongs to THIS app. */
  updatePlan?(planId: string, patch: PlanUpdateInput): Promise<LicencesPlan>;
  /** `DELETE /plans/{id}` — 409 while any licence references it. */
  deletePlan?(planId: string): Promise<void>;

  /**
   * `POST /internal/tenants/{id}/bundles/{bundle}/ensure` — the tenant OWNER (CP, for its own
   * tenants) ensures one licence per app of a licences bundle. Idempotent upstream: a second call
   * answers `exists` for every app. Returns the outcome for 200 AND for a 409 that carries the ensure
   * body (some apps refused — `refused` is then non-empty). Every other non-2xx throws
   * `LicencesBundleError` naming licences' `detail.error`; a transport failure is a 503
   * `LicensesAdminError`. Licences decides which bundle keys exist (404 `bundle_not_found`).
   *
   * `plans` is the ORDERED plan-code preference sent as the body's `plans` (config
   * `license.bundlePlans`, `LICENCE_BUNDLE_PLANS`): each INSERTED app licence gets the first code
   * that exists, non-revoked, on that app; an app with none is refused `no_plan`.
   */
  ensureTenantBundle?(tenantId: string, bundle: string, plans: readonly string[]): Promise<BundleEnsureOutcome>;
}

/** One licence of a subject, as `listSubjectLicences` reports it. */
export interface SubjectLicence {
  id: string;
  tenantId: string;
  status: string;
  appKey: string | null;
}

/** One ACTIVE licence on a tenant, as `GET /licenses?status=active` lists it (see `listTenantLicences`). */
export interface TenantLicence {
  id: string;
  tenantId: string;
  status: string;
  appKey: string | null;
  /** `metadata.bundle` — set when a bundle INSERTED this licence; `null` otherwise (incl. adopted). */
  bundle: string | null;
}

/** The commercial terms a licence is minted with. `planCode` is resolved to the app's plan id. */
export interface LicenceTerms {
  planCode: string;
  /** null/undefined = licences' default (now). */
  startsAt?: Date | null;
  /** null/undefined = perpetual. */
  expiresAt?: Date | null;
}

export interface CreatedLicence {
  licenseId: string;
  subjectId: string;
  /**
   * Whether the licence licences RETURNED carries the requested plan + dates.
   *
   * ⛔ `POST /licenses/user/{sub}` IS IDEMPOTENT PER (tenant, app, subject): with an active licence
   * already there it returns THAT licence — whatever plan and expiry it has — instead of minting.
   * So "I asked for plan X" never proves "the licence is on plan X". `false` = an existing licence
   * with different terms came back; the caller must revoke it and mint again
   * (license-provisioning.ts `mintWithTerms`). Absent (a test fake) = treated as matching.
   */
  termsMatch?: boolean;
}

/** A licences plan of THIS app, camel-cased. */
export interface LicencesPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  durationDays: number | null;
  rateLimitRpm: number | null;
  rateLimitBurst: number | null;
  quotaMonthly: number | null;
  tokenBudgetMonthly: number | null;
  revoked: boolean;
  createdAt: string | null;
}

export interface PlanUpdateInput {
  name?: string;
  description?: string | null;
  durationDays?: number | null;
  rateLimitRpm?: number | null;
  rateLimitBurst?: number | null;
  quotaMonthly?: number | null;
  tokenBudgetMonthly?: number | null;
  /** Retire / un-retire. Needs licences A2-L (`PlanUpdate.revoked`); see `PlanRetireUnsupportedError`. */
  revoked?: boolean;
}

export interface PlanCreateInput extends Omit<PlanUpdateInput, 'revoked'> {
  code: string;
  name: string;
}

/**
 * licences refused (or silently ignored) `revoked` on `PATCH /plans/{id}` — it predates A2-L.
 * A licences without `PlanUpdate.revoked` answers a `{revoked}`-only body with 400 "No fields to
 * update" (pydantic drops the unknown field) or 422; a 2xx whose body does not carry the requested
 * `revoked` value is the same verdict. Never reported as success.
 */
export class PlanRetireUnsupportedError extends LicensesAdminError {
  constructor(message = 'the licences service does not support retiring a plan (PlanUpdate.revoked)') {
    super(501, message);
    this.name = 'PlanRetireUnsupportedError';
  }
}

const PLAN_FIELD_MAP: Record<keyof PlanUpdateInput | 'code', string> = {
  code: 'code',
  name: 'name',
  description: 'description',
  durationDays: 'duration_days',
  rateLimitRpm: 'rate_limit_rpm',
  rateLimitBurst: 'rate_limit_burst',
  quotaMonthly: 'quota_monthly',
  tokenBudgetMonthly: 'token_budget_monthly',
  revoked: 'revoked',
};

function planToWire(input: PlanUpdateInput & { code?: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, wire] of Object.entries(PLAN_FIELD_MAP)) {
    const v = (input as Record<string, unknown>)[k];
    if (v !== undefined) out[wire] = v;
  }
  return out;
}

type WirePlan = {
  id?: string;
  code?: string;
  name?: string;
  description?: string | null;
  duration_days?: number | null;
  rate_limit_rpm?: number | null;
  rate_limit_burst?: number | null;
  quota_monthly?: number | null;
  token_budget_monthly?: number | null;
  revoked?: boolean;
  created_at?: string | null;
};

function planFromWire(p: WirePlan): LicencesPlan {
  return {
    id: String(p.id),
    code: String(p.code),
    name: String(p.name ?? p.code),
    description: p.description ?? null,
    durationDays: p.duration_days ?? null,
    rateLimitRpm: p.rate_limit_rpm ?? null,
    rateLimitBurst: p.rate_limit_burst ?? null,
    quotaMonthly: p.quota_monthly ?? null,
    tokenBudgetMonthly: p.token_budget_monthly ?? null,
    revoked: p.revoked === true,
    createdAt: p.created_at ?? null,
  };
}

/** Same instant, or both absent. Licences echoes timestamps in its own ISO format. */
function sameInstant(a: string | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === b.getTime();
}

/** Clock skew tolerated when deciding that a licence's start is "already reached". */
const START_SKEW_MS = 5 * 60_000;

/**
 * Does the returned licence's `starts_at` satisfy the requested start?
 *
 * A requested start is compared exactly. A requested NULL means "from mint time": licences stamps
 * `now` on a fresh mint, so any start that has ALREADY been reached satisfies it — but an existing
 * licence starting in the FUTURE (a 2031 start the operator just cleared) does not, and must be
 * re-minted. Skipping the check for a null request was the defect: clearing a future start left the
 * old future-dated licence in place while CP showed `startsAt: null`.
 */
function startMatches(returned: string | null | undefined, requested: Date | null, nowMs: number): boolean {
  if (returned === undefined) return true; // an older licences that does not echo it
  if (requested) return sameInstant(returned, requested);
  if (returned === null) return true;
  return Date.parse(returned) <= nowMs + START_SKEW_MS;
}

/**
 * The holders of a CP tenant licence: two per tenant, alternated on every terms change so the new
 * licence can be minted BESIDE the old one (licences keeps one active licence per subject).
 *
 * ⛔ NEVER A PERSON. The tenant licence used to be bound to a member's Keycloak sub — the same
 * subject as that member's seat, so licences handed back the SEAT licence as the tenant licence and
 * offboarding the member revoked the workspace's Gate-2 licence (402 for everyone). A synthetic
 * holder cannot be anyone's seat.
 *
 * ⛔ NOT `svc:`. `svc:<tenant>:<app>` is licences' tenant-level (bundle) holder: CP's
 * `tenant-level-licence.ts` treats an active licence on it as "the bundle covers this tenant" and
 * stops minting member seats, and licences' bundle ensure would adopt it. `cp-tenant:` is neither.
 */
export const TENANT_LICENCE_SUBJECT_PREFIX = 'cp-tenant:';
/**
 * The realm label stated for those holders (`LicenseCreate.subject_realm`).
 *
 * ⚠️ BILLING: licences counts `human_subjects` as every subject whose realm is not in
 * `NON_HUMAN_SUBJECT_REALMS` (= `("service",)` on licences main 0d33741), and `LicenseCreate`
 * REFUSES `subject_realm: "service"` (422). So no API caller can mint a non-human subject today, and
 * until licences adds `cp-tenant` to that tuple each CP tenant licence counts as ONE human subject —
 * exactly what a tenant licence bound to a super_admin already counted as before A2. A dedicated
 * label (not `portal`) is what makes that one-line licences change possible and the rows findable.
 */
export const TENANT_LICENCE_SUBJECT_REALM = 'cp-tenant';

export function tenantLicenceSubjects(tenantId: string): [string, string] {
  const id = tenantId.toLowerCase();
  return [`${TENANT_LICENCE_SUBJECT_PREFIX}${id}:a`, `${TENANT_LICENCE_SUBJECT_PREFIX}${id}:b`];
}

export function isTenantLicenceSubject(sub: string | null | undefined): boolean {
  return typeof sub === 'string' && sub.startsWith(TENANT_LICENCE_SUBJECT_PREFIX);
}

/**
 * The BYO posture a tenant CP creates is born with.
 *
 * `local_allowed` — this workspace may run on the platform's credential. It is the commercially
 * correct default for a tenant created through CP's own super_admin console: that flow grants a
 * welcome budget (`grantTenantBudget`) whose entire purpose is platform-paid spend, and a
 * `byo_required` tenant cannot spend it. A customer who genuinely brings their own provider is
 * moved to `byo_required` centrally, in the licences service, which is where that commercial fact
 * is owned — CP states the default, it does not own the posture.
 *
 * ⚠️ Deliberately a CONSTANT here and not an env var. It is a commercial default, not a deployment
 * knob; an operator who could set `CP_NEW_TENANT_BYO_MODE=byo_required` would silently make every
 * new workspace unable to use the budget the same request grants it.
 */
export const NEW_TENANT_BYO_MODE: ByoMode = 'local_allowed';

interface CachedToken {
  token: string;
  /** epoch ms after which the cached SA token must be refreshed. */
  expiresAt: number;
}

/** Service-token cache window, mirroring keycloak-admin's 60s. */
const TOKEN_TTL_MS = 60_000;

/**
 * Read the error literal out of a licences 404 body. licences is FastAPI, so every HTTPException
 * body is WRAPPED: `{"detail": {"error": "tenant_not_found_in_registry", …}}`. Reading a top-level
 * `body.error` never matches that envelope (commonpractice#417: registration repair threw on every
 * tick for every unregistered tenant). The flat `{"error": …}` shape is still accepted.
 *
 * Returns `undefined` for anything without a literal — `{"detail": "Tenant not found"}`, an
 * unmatched route's `{"detail": "Not Found"}`, a non-JSON body — so callers still branch on the
 * literal, never on the status alone, and those 404s keep throwing.
 */
async function notFoundLiteral(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    detail?: { error?: string } | string;
  } | null;
  if (!body || typeof body !== 'object') return undefined;
  return typeof body.detail === 'object' && body.detail !== null ? body.detail.error : body.error;
}

/**
 * The error for a non-2xx licences answer to `what`. A 403 carrying one of the ownership refusal
 * codes becomes a `LicencesAccessRefusedError` naming it; everything else a plain
 * `LicensesAdminError` with the upstream status. Consumes the body.
 */
async function licencesFailure(res: Response, what: string): Promise<LicensesAdminError> {
  if (res.status === 403) {
    const code = await notFoundLiteral(res);
    if (code && ACCESS_REFUSAL_CODES.has(code)) {
      return new LicencesAccessRefusedError(
        code as LicencesAccessRefusalCode,
        `${what} refused by licences: HTTP 403 ${code}`,
      );
    }
  }
  return new LicensesAdminError(res.status, `${what} failed: HTTP ${res.status}`);
}

export class LicensesAdminService implements LicensesAdminClient {
  private readonly adminBaseUrl: string;
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly appKey: string;
  /** The DEFAULT plan code — used only when a caller passes no terms (the pre-0095 call shape). */
  private readonly planCode: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached?: CachedToken;
  /** Resolved app id for `appKey` — stable for the process, cached on success. */
  private cachedAppId?: string;
  /**
   * Resolved plan id PER CODE (key `app:code`). This was ONE cached `planId` for the global
   * `LICENSE_PLAN_CODE`, which is why every licence CP ever minted — tenant and member — was on the
   * same plan whatever the tenant had bought. A plan id never changes for a code, so caching on
   * success is safe; a miss is not cached (a plan created a second ago resolves on the next call).
   */
  private readonly planIds = new Map<string, string>();

  constructor(opts: LicensesAdminOptions = {}) {
    this.adminBaseUrl = (opts.adminBaseUrl ?? config.license.adminBaseUrl).replace(/\/+$/, '');
    this.tokenUrl = opts.tokenUrl ?? config.license.sa.tokenUrl;
    this.clientId = opts.clientId ?? config.license.sa.clientId;
    this.clientSecret = opts.clientSecret ?? config.license.sa.clientSecret;
    this.appKey = opts.appKey ?? config.license.appKey;
    this.planCode = opts.planCode ?? config.license.planCode;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  // ---- service token (client_credentials against secure-apps, 60s cache) ----

  async getServiceToken(): Promise<string> {
    const nowMs = this.now();
    if (this.cached && this.cached.expiresAt > nowMs) {
      return this.cached.token;
    }
    if (!this.tokenUrl) {
      throw new LicensesAdminError(500, 'licenses SA token URL not configured');
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(config.license.adminTimeoutMs),
      });
    } catch (err) {
      throw new LicensesAdminError(
        503,
        `licenses SA token transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new LicensesAdminError(res.status, `licenses SA token request failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new LicensesAdminError(502, 'licenses SA token response missing access_token');
    }
    this.cached = { token: json.access_token, expiresAt: nowMs + TOKEN_TTL_MS };
    return json.access_token;
  }

  private adminUrl(path: string): string {
    return `${this.adminBaseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private async authed(
    method: string,
    path: string,
    opts: { jsonBody?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const token = await this.getServiceToken();
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
    };
    if (opts.jsonBody !== undefined) init.body = JSON.stringify(opts.jsonBody);
    init.signal = AbortSignal.timeout(config.license.adminTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.adminUrl(path), init);
    } catch (err) {
      throw new LicensesAdminError(
        503,
        `licenses admin transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return res;
  }

  // ---- app/plan resolution (the licenses API is UUID-keyed, CP configures by key) ----

  /**
   * Resolve (app_id, plan_id) UUIDs for (appKey, `planCode`). The licenses `LicenseCreate` model is
   * UUID-only — it does NOT accept app_key/plan_code — so CP looks them up via `GET /apps/{key}` +
   * `GET /apps/{key}/plans` (both accept a key and need `license-admin`, which the SA holds; neither
   * requires `X-Tenant-Id`). Both are cached on success for the process lifetime; a failure does
   * NOT cache, so a not-yet-registered plan simply retries on the next issue.
   *
   * A code absent from the live list is looked up once more WITH retired plans: a tenant still on a
   * plan that has since been retired keeps onboarding members on it (retire = no NEW tenants).
   */
  private async resolveAppAndPlan(planCode: string): Promise<{ appId: string; planId: string }> {
    const appId = await this.resolveAppId();
    const key = `${this.appKey}:${planCode}`;
    const hit = this.planIds.get(key);
    if (hit) return { appId, planId: hit };

    let plan = (await this.fetchPlans(false)).find((p) => p.code === planCode);
    if (!plan) {
      const all = await this.fetchPlans(true).catch(() => [] as WirePlan[]);
      plan = all.find((p) => p.code === planCode);
    }
    if (!plan?.id) {
      throw new LicensesAdminError(502, `plan '${planCode}' not found for app '${this.appKey}'`);
    }
    this.planIds.set(key, plan.id);
    return { appId, planId: plan.id };
  }

  private async resolveAppId(): Promise<string> {
    if (this.cachedAppId) return this.cachedAppId;
    const appRes = await this.authed('GET', `apps/${encodeURIComponent(this.appKey)}`);
    if (!appRes.ok) {
      throw new LicensesAdminError(appRes.status, `resolve app '${this.appKey}' failed: HTTP ${appRes.status}`);
    }
    const app = (await appRes.json()) as { id?: string };
    if (!app.id) {
      throw new LicensesAdminError(502, `resolve app '${this.appKey}' response missing id`);
    }
    this.cachedAppId = app.id;
    return app.id;
  }

  private async fetchPlans(includeRevoked: boolean): Promise<WirePlan[]> {
    const path = `apps/${encodeURIComponent(this.appKey)}/plans${includeRevoked ? '?include_revoked=true' : ''}`;
    const res = await this.authed('GET', path);
    if (!res.ok) {
      throw new LicensesAdminError(res.status, `resolve plans for '${this.appKey}' failed: HTTP ${res.status}`);
    }
    const plans = (await res.json()) as WirePlan[];
    return Array.isArray(plans) ? plans : [];
  }

  // ---- plan catalogue (THIS app only — the app is never a caller input) ----

  async listPlans(opts: { includeRevoked?: boolean } = {}): Promise<LicencesPlan[]> {
    const plans = await this.fetchPlans(opts.includeRevoked === true);
    return plans.filter((p) => p.id && p.code).map(planFromWire);
  }

  async createPlan(input: PlanCreateInput): Promise<LicencesPlan> {
    const appId = await this.resolveAppId();
    const res = await this.authed('POST', 'plans', { jsonBody: { app_id: appId, ...planToWire(input) } });
    if (!res.ok) {
      throw new LicensesAdminError(res.status, `create plan '${input.code}' failed: HTTP ${res.status}`);
    }
    return planFromWire((await res.json()) as WirePlan);
  }

  async updatePlan(planId: string, patch: PlanUpdateInput): Promise<LicencesPlan> {
    const res = await this.authed('PATCH', `plans/${encodeURIComponent(planId)}`, {
      jsonBody: planToWire(patch),
    });
    if (!res.ok) {
      // A licences without `PlanUpdate.revoked` drops the field: a `{revoked}`-only body is then
      // 400 "No fields to update"; a strict model would 422. Either way: not supported.
      if (patch.revoked !== undefined && (res.status === 400 || res.status === 422)) {
        throw new PlanRetireUnsupportedError();
      }
      throw new LicensesAdminError(res.status, `update plan ${planId} failed: HTTP ${res.status}`);
    }
    const plan = planFromWire((await res.json()) as WirePlan);
    // A 2xx that did not apply `revoked` (the field silently ignored next to other fields) is the
    // same verdict — reporting it as done would show a plan as retired that licences still sells.
    if (patch.revoked !== undefined && plan.revoked !== patch.revoked) {
      throw new PlanRetireUnsupportedError(
        `licences answered ${res.status} but the plan's revoked flag is ${String(plan.revoked)}, not ${String(patch.revoked)}`,
      );
    }
    return plan;
  }

  async deletePlan(planId: string): Promise<void> {
    const res = await this.authed('DELETE', `plans/${encodeURIComponent(planId)}`);
    if (!res.ok) {
      throw new LicensesAdminError(res.status, `delete plan ${planId} failed: HTTP ${res.status}`);
    }
    for (const [k, v] of this.planIds) if (v === planId) this.planIds.delete(k);
  }

  // ---- writes (FATAL: throw → 502 at the provisioning call site) ----

  /**
   * PUT /tenants/{tenantId} → register CP's tenant id in the canonical registry (idempotent).
   * See the interface doc for why this is PUT-with-explicit-id and not POST /tenants.
   *
   * `name` must satisfy the registry's `^[a-z0-9][a-z0-9-]*$` constraint — pass the CP tenant SLUG,
   * which is generated in that shape (`better-results-group`, `u-<hex>`), never the display name.
   *
   * Since licences migration 050 the tenant is registered under CP's OWNING APP (derived by licences
   * from this SA's client — never sent). Two 409s, told apart by `detail.error`:
   *   - `tenant_name_taken` → `LicencesNameConflictError`: CP already has a licences tenant with this
   *     name (names are unique per owner; another app's `netcare` is not a clash).
   *   - `tenant_owned_by_other_app` → `LicencesTenantOwnedByOtherAppError`: the id belongs to another
   *     app. Never guessed around.
   * A 403 ownership refusal (`unknown_api_client`) → `LicencesAccessRefusedError`.
   */
  async ensureTenantRegistered(tenantId: string, name: string): Promise<void> {
    const res = await this.authed('PUT', `tenants/${encodeURIComponent(tenantId)}`, {
      jsonBody: { name },
    });
    if (res.status === 409) {
      const code = await notFoundLiteral(res);
      if (code === 'tenant_name_taken') {
        throw new LicencesNameConflictError(
          name,
          `register tenant '${name}' (${tenantId}) failed: HTTP 409 tenant_name_taken — CP already holds a licences tenant with this name`,
        );
      }
      if (code === 'tenant_owned_by_other_app') {
        throw new LicencesTenantOwnedByOtherAppError(
          tenantId,
          `register tenant '${name}' (${tenantId}) failed: HTTP 409 tenant_owned_by_other_app — the id is registered to a different app`,
        );
      }
      throw new LicensesAdminError(
        409,
        `register tenant '${name}' (${tenantId}) failed: HTTP 409 (${code ?? 'unrecognised body'})`,
      );
    }
    if (!res.ok) throw await licencesFailure(res, `register tenant '${name}' (${tenantId})`);
  }

  /** GET /tenants/{name_or_id} — see the interface doc. */
  async getTenant(nameOrId: string): Promise<LicencesTenant | null> {
    const res = await this.authed('GET', `tenants/${encodeURIComponent(nameOrId)}`);
    if (res.status === 404) {
      // Only licences' own literal means "absent"; an unmatched route answers `"Not Found"`.
      const body = (await res.json().catch(() => ({}))) as { detail?: unknown } | null;
      if (body?.detail === 'Tenant not found') return null;
      throw new LicensesAdminError(404, `read licences tenant '${nameOrId}' failed: HTTP 404 (not the registry's own not-found)`);
    }
    if (!res.ok) {
      throw new LicensesAdminError(res.status, `read licences tenant '${nameOrId}' failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { id?: string; name?: string; owner_key?: unknown };
    if (!json.id || !json.name) {
      throw new LicensesAdminError(502, `licences tenant '${nameOrId}' response missing id/name`);
    }
    const ownerKey = typeof json.owner_key === 'string' && json.owner_key ? json.owner_key : null;
    return { id: json.id, name: json.name, ownerKey };
  }

  /**
   * POST /licenses/user/{keycloakSub} + `X-Tenant-Id: <tenant>` → the new License (Spec §9.3#2).
   *
   * `keycloakSub` goes in the PATH; the licenses service resolves or creates its own Subject row
   * from it and returns that row's id as `subject_id`. See the interface doc for why the two must
   * not be conflated.
   */
  async createLicense(
    keycloakSub: string,
    tenantId: string,
    terms?: LicenceTerms,
  ): Promise<CreatedLicence> {
    const t: LicenceTerms = terms ?? { planCode: this.planCode };
    const { appId, planId } = await this.resolveAppAndPlan(t.planCode);
    const res = await this.authed('POST', `licenses/user/${encodeURIComponent(keycloakSub)}`, {
      // ⛔ `subject_realm` — the realm the EMPLOYEE lives in, stated rather than inferred. Without
      // it licences stamps a NEW Subject with the CALLER's realm, and this service's SA authenticates
      // in `secure-apps`, so every CP employee became a `secure-apps` Subject. They are counted as
      // human seats only because licences' NON_HUMAN_SUBJECT_REALMS is `("service",)` today.
      // Licences ignores the field until it ships support (pydantic default), so sending it is safe
      // in either order; it only takes effect for a Subject created by this call.
      jsonBody: {
        app_id: appId,
        plan_id: planId,
        // A CP tenant-licence holder (`cp-tenant:<id>:a|b`) is not a person: it gets its own
        // realm label so licences can tell it from an employee (see TENANT_LICENCE_SUBJECT_REALM).
        subject_realm: isTenantLicenceSubject(keycloakSub)
          ? TENANT_LICENCE_SUBJECT_REALM
          : config.keycloak.userRealm,
        // Only stated when set: an absent `starts_at` is licences' "now", an absent `expires_at` is
        // perpetual. Both carry an offset (`toISOString` is UTC `Z`) — licences 422s a naive one.
        ...(t.startsAt ? { starts_at: t.startsAt.toISOString() } : {}),
        ...(t.expiresAt ? { expires_at: t.expiresAt.toISOString() } : {}),
      },
      headers: { 'X-Tenant-Id': tenantId },
    });
    // A 403 `tenant_not_accessible` / `app_not_issuable_by_caller` (licences migration 050: CP may
    // mint only apps it issues, on tenants it owns or holds a grant on) is a LicencesAccessRefusedError.
    if (!res.ok) throw await licencesFailure(res, 'create license');
    const json = (await res.json()) as {
      license_id?: string;
      id?: string;
      subject_id?: string;
      plan_id?: string;
      starts_at?: string | null;
      expires_at?: string | null;
    };
    const licenseId = json.license_id ?? json.id;
    if (!licenseId) {
      throw new LicensesAdminError(502, 'create license response missing license_id');
    }
    // ⛔ HARD FAILURE, NOT A FALLBACK TO `keycloakSub`. They are different identifiers (see the
    // interface doc), so substituting one for the other would not degrade the attribution — it
    // would silently reproduce the exact `unlicensed` defect this field was added to end, and it
    // would look like it worked. A response without it is a contract break worth a 502.
    const subject = json.subject_id;
    if (!subject) {
      throw new LicensesAdminError(502, 'create license response missing subject_id');
    }
    // See `CreatedLicence.termsMatch`: an idempotent hit returns the EXISTING licence's terms. A
    // response that omits a field (an older licences) cannot be checked on it and is taken at its word.
    const termsMatch =
      (json.plan_id === undefined || json.plan_id === planId) &&
      (json.expires_at === undefined || sameInstant(json.expires_at, t.expiresAt ?? null)) &&
      startMatches(json.starts_at, t.startsAt ?? null, this.now());
    return { licenseId, subjectId: subject, termsMatch };
  }

  /** GET /licenses/user/{sub} — see the interface doc. */
  async listSubjectLicences(sub: string): Promise<SubjectLicence[]> {
    const res = await this.authed('GET', `licenses/user/${encodeURIComponent(sub)}`);
    if (res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { detail?: unknown } | null;
      if (body?.detail === 'Subject not found') return [];
      throw new LicensesAdminError(404, `list licences of '${sub}' failed: HTTP 404 (not licences' own not-found)`);
    }
    if (!res.ok) {
      throw new LicensesAdminError(res.status, `list licences of '${sub}' failed: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as Array<{
      id?: string;
      tenant_id?: string;
      status?: string;
      app?: { key?: string } | null;
    }>;
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => r.id && r.tenant_id)
      .map((r) => ({
        id: String(r.id),
        tenantId: String(r.tenant_id),
        status: String(r.status ?? ''),
        appKey: r.app?.key ?? null,
      }));
  }

  /** GET /licenses?status=active + `X-Tenant-Id` — see the interface doc. */
  async listTenantLicences(tenantId: string): Promise<TenantLicence[]> {
    const res = await this.authed('GET', 'licenses?status=active', {
      headers: { 'X-Tenant-Id': tenantId },
    });
    if (!res.ok) throw await licencesFailure(res, `list licences of tenant ${tenantId}`);
    const rows = (await res.json().catch(() => null)) as Array<{
      id?: string;
      tenant_id?: string;
      status?: string;
      app?: { key?: string } | null;
      metadata?: { bundle?: unknown } | null;
    }> | null;
    if (!Array.isArray(rows)) {
      throw new LicensesAdminError(502, `list licences of tenant ${tenantId}: response is not a list`);
    }
    return rows
      .filter((r) => r.id && r.tenant_id)
      .map((r) => ({
        id: String(r.id),
        tenantId: String(r.tenant_id),
        status: String(r.status ?? ''),
        appKey: r.app?.key ?? null,
        bundle: typeof r.metadata?.bundle === 'string' ? r.metadata.bundle : null,
      }));
  }

  /** PATCH /tenants/{id} — see the interface doc (pre-checks the name among CP's own tenants). */
  async renameTenant(tenantId: string, name: string): Promise<void> {
    const holder = await this.getTenant(name);
    if (holder && holder.id.toLowerCase() !== tenantId.toLowerCase()) {
      throw new LicencesNameConflictError(name);
    }
    const res = await this.authed('PATCH', `tenants/${encodeURIComponent(tenantId)}`, {
      jsonBody: { name },
    });
    if (res.status === 409) {
      const code = await notFoundLiteral(res);
      if (code === 'tenant_name_taken') throw new LicencesNameConflictError(name);
      throw new LicensesAdminError(
        409,
        `rename licences tenant ${tenantId} to '${name}' failed: HTTP 409 (${code ?? 'unrecognised body'})`,
      );
    }
    if (!res.ok) throw await licencesFailure(res, `rename licences tenant ${tenantId} to '${name}'`);
  }

  /**
   * POST /licenses/{licenseId}/tokens + `X-Tenant-Id: <tenant>` → the raw token, returned ONCE
   * (Spec §9.3#3). The header is mandatory: the service verifies the request tenant owns the
   * license and 404s otherwise (licenses `create_license_token` ownership check).
   */
  async createToken(licenseId: string, tenantId: string): Promise<{ token: string }> {
    const res = await this.authed('POST', `licenses/${encodeURIComponent(licenseId)}/tokens`, {
      jsonBody: {},
      headers: { 'X-Tenant-Id': tenantId },
    });
    if (!res.ok) throw await licencesFailure(res, 'mint token');
    const json = (await res.json()) as { token?: string };
    if (!json.token) {
      throw new LicensesAdminError(502, 'mint token response missing token');
    }
    return { token: json.token };
  }

  /**
   * POST /license/revoke {token} + `X-Tenant-Id: <tenant>` → revoke the tenant's license
   * (offboarding, Spec §9.3). The header is mandatory: the service checks the token's tenant against
   * the request tenant and silently reports "not found" (revoked:false) on a mismatch — so an
   * omitted header would make suspend/offboard a no-op that leaves the license active.
   *
   * ⛔ AND A 2xx IS NOT A REVOKE — this used to check only `res.ok`, which could not see that case
   * at all. See the body check below.
   */
  async revokeByToken(token: string, tenantId: string): Promise<void> {
    return this.revokeConfirmed({ token }, tenantId, 'token');
  }

  /** POST /license/revoke with the `license_id` arm. See the interface doc for why offboarding
   *  must revoke the LICENCE (the seat) and not merely a token. */
  async revokeByLicenseId(licenseId: string, tenantId: string): Promise<void> {
    return this.revokeConfirmed({ license_id: licenseId }, tenantId, `license ${licenseId}`);
  }

  /**
   * The one revoke primitive. Both arms of `POST /license/revoke` (`token` XOR `license_id`) share
   * the SAME non-disclosing 200 response, so they must share the same confirmation — see the block
   * below, which was written for the token arm and flagged the licence arm as the sibling hole.
   */
  private async revokeConfirmed(
    jsonBody: { token: string } | { license_id: string },
    tenantId: string,
    what: string,
  ): Promise<void> {
    const res = await this.authed('POST', 'license/revoke', {
      jsonBody,
      headers: { 'X-Tenant-Id': tenantId },
    });
    if (!res.ok) throw await licencesFailure(res, 'revoke');

    // ⛔ THE SILENT-UNDER-REVOKE SITE. The docblock above has always said the service reports a
    // tenant mismatch SILENTLY; what it does not say is the status code. Measured against the
    // handler rather than inferred: `POST /license/revoke` (licenses/main.py:2930-2936) declares no
    // `status_code=`, so FastAPI answers **200**, and the wrong-tenant path (main.py:3003) returns
    //     {"revoked": false, "message": "Token not found or already invalid"}
    // — the same body an UNKNOWN token gets, collapsed on purpose for non-disclosure
    // (models.py:4515-4520). There is no 4xx arm for either. So `res.ok` is true and, before this
    // check, `revokeByToken` returned normally.
    //
    // The consequence is the one `revokeTenantLicense`'s docblock promises can never happen:
    // it proceeds to null `license_token_encrypted`, and the tenant row afterwards is
    // INDISTINGUISHABLE from a clean revoke. The platform has forgotten a token it did not revoke,
    // so nothing can reconcile it — strictly worse than the decrypt fail-open hardened in
    // license-provisioning.ts, where the blob at least survives.
    //
    // ⚠️ `revoked !== true` IS SAFE TO TREAT AS FAILURE, and this is load-bearing: "already
    // revoked" answers `{"revoked": true}` BY DESIGN (idempotent upstream), so a retried offboard
    // still succeeds. Had it answered false, a strict check would make every retry unrecoverable
    // and the fix would have had to discriminate on `message` — a check keyed on prose. Do not
    // "relax" this to a message match.
    //
    // ⚠️ An unparseable body also fails here (`revoked` undefined), deliberately: this function
    // cannot report a revoke it cannot confirm.
    //
    // ⭐ SIBLING HOLE — NOW CLOSED, AND THIS IS WHY THE FUNCTION WAS MADE SHARED. The `license_id`
    // arm of the same endpoint returns `{"revoked": false, "message": "License not found"}` at 200
    // for an unknown or foreign licence, identically to the token arm. The note here used to read
    // "NOT FIXED HERE … nothing in this repo calls that arm today; if one appears, it needs the same
    // treatment". Per-member offboarding (`revokeByLicenseId`) is that caller, so rather than adding
    // a second copy of this check that could drift, both arms now go through THIS body. A future
    // third arm should be added the same way.
    const body = (await res.json().catch(() => ({}))) as { revoked?: boolean; message?: string };
    if (body.revoked !== true) {
      // ⚠️ `res.status`, NOT a hardcoded 502. `as502` (license-provisioning.ts:48) always yields a
      // flat `HttpError(502, …)` whatever we pass, and threads THIS number into
      // `details.upstreamStatus` — the field that exists precisely to record what the upstream
      // actually said. Hardcoding 502 here would write `upstreamStatus: 502` into the one error
      // whose entire job is to report that the service answered **200** and revoked nothing.
      // Passing `res.status` keeps the response a 502 and makes the recorded cause true.
      //
      // ⚠️ THE CONSUMER IS LATENT, NOT ACTIVE — do not restate this as a live retry bug.
      // `admin.ts`'s `isTransientLicenseError` is `upstreamStatus >= 500`, so a hardcoded 502 WOULD
      // read a permanent 200/`revoked:false` as a transient blip. But that predicate has exactly one
      // call site (admin.ts:295), inside `licenseNewTenant`'s loop around `ensureTenantLicense` —
      // the ISSUANCE path. Both revoke callers are bare awaits (admin.ts:557 suspend, :667 offboard),
      // so nothing on this path reaches it today. `res.status` is correct IN ADVANCE: :557 and :667
      // are the first two sites any future "make offboard resilient" change would wrap.
      throw new LicensesAdminError(
        res.status,
        `revoke reported no-op: the licenses service returned HTTP ${res.status} with ` +
          `revoked=${String(body.revoked)} for ${what} on tenant ${tenantId}, so the upstream ` +
          `license is still ACTIVE. The service does not disclose whether this was a tenant ` +
          `mismatch or an unknown ${what}; its message was: ${body.message ?? '(none)'}`,
      );
    }
  }
  /**
   * GET /tenants/{id}/byo-mode?app=<appKey>&on_unresolved=error → the tenant's BYO posture for
   * THIS product (a per-app override if one exists, else the tenant-wide value).
   *
   * `on_unresolved=error`, not the licences default `fail_closed`: the default answers a DB fault
   * with a 200 `byo_required` it fabricated, which a cache here would then hold as a commercial
   * fact. With `error` a fault is a 503 and the caller (services/byo-posture.ts) decides what an
   * unknown posture means — it keeps the last known value, and fails closed only with none.
   *
   * A 404 `tenant_not_found_in_registry` (nested in FastAPI's `detail`; see `notFoundLiteral`) is
   * answered as `byo_required`: an unregistered tenant can
   * hold no licence, so it is never entitled to the platform's credential. That mirrors how billing
   * reads the same 404.
   */
  async getTenantByoMode(tenantId: string): Promise<ByoMode> {
    const res = await this.authed(
      'GET',
      `tenants/${encodeURIComponent(tenantId)}/byo-mode?app=${encodeURIComponent(this.appKey)}&on_unresolved=error`,
    );
    if (res.status === 404) {
      // Branch on the literal, never the status alone — an unmatched ROUTE is also a 404.
      if ((await notFoundLiteral(res)) === 'tenant_not_found_in_registry') return 'byo_required';
    }
    if (!res.ok) {
      throw new LicensesAdminError(res.status, `read byo_mode for tenant ${tenantId} failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { byo_mode?: string };
    if (body.byo_mode !== 'local_allowed' && body.byo_mode !== 'byo_required' && body.byo_mode !== 'platform_only') {
      throw new LicensesAdminError(502, `byo_mode response for tenant ${tenantId} carried '${String(body.byo_mode)}'`);
    }
    return body.byo_mode;
  }

  /** GET /licenses/active — see the interface doc (`null` only on the `no_active_license` literal). */
  async getActiveLicense(
    tenantId: string,
    opts: { subjectId?: string } = {},
  ): Promise<LicenseIntrospectResponse | null> {
    const q = new URLSearchParams({ tenant_id: tenantId, app_key: this.appKey });
    if (opts.subjectId) q.set('subject_id', opts.subjectId);
    const res = await this.authed('GET', `licenses/active?${q.toString()}`);
    if (res.status === 404) {
      // FastAPI envelope: `{"detail": {"error": "no_active_license", …}}`. Accept the flat shape too.
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: { error?: string } | string;
      };
      const literal = typeof body.detail === 'object' ? body.detail?.error : body.error;
      if (literal === 'no_active_license') return null;
    }
    if (!res.ok) {
      throw new LicensesAdminError(
        res.status,
        `read active license for tenant ${tenantId} failed: HTTP ${res.status}`,
      );
    }
    return (await res.json()) as LicenseIntrospectResponse;
  }

  /**
   * PATCH /tenants/{id}/archive `{ archived: true }` → mark the tenant archived in the canonical
   * registry (licences `set_tenant_archived`, role `license-admin`).
   *
   * ⚠️ IT DOES NOT REVOKE. See the interface doc: archiving stops licences AUTHORIZING (introspect
   * answers `active:false, reason:"tenant_archived"`) and leaves them counting as seats, so it is
   * the LAST step of an offboard, never a substitute for the per-member revokes before it.
   *
   * ⚠️ A 404 IS ONLY "NOTHING TO ARCHIVE" WHEN LICENCES SAYS SO IN THE BODY. An unmatched route is a
   * 404 too, and swallowing that would turn a wrong path into a permanently green archive step —
   * the precise shape of a gate that cannot fail. So the literal `tenant_not_found_in_registry` is
   * the ONLY 404 treated as success (a tenant created before central registration existed genuinely
   * has no registry row to archive, and that is a real, expected state for this deployment); every
   * other 404 throws like any other non-2xx. Same discrimination `getTenantByoMode` applies.
   */
  async archiveTenant(tenantId: string): Promise<void> {
    const res = await this.authed('PATCH', `tenants/${encodeURIComponent(tenantId)}/archive`, {
      jsonBody: { archived: true },
    });
    if (res.status === 404) {
      // never registered → nothing to archive
      if ((await notFoundLiteral(res)) === 'tenant_not_found_in_registry') return;
    }
    if (!res.ok) {
      throw new LicensesAdminError(res.status, `archive tenant ${tenantId} failed: HTTP ${res.status}`);
    }
  }

  /**
   * GET /tenants/{id}/byo-mode?on_unresolved=error → is this tenant in the registry?
   *
   * ⛔ WHY BYO-MODE AND NOT `GET /tenants/{id}`. The plain tenant read answers a GENERIC 404
   * `{"detail": "Tenant not found"}` both for an absent tenant AND for a foreign tenant the caller
   * cannot see, so it can never carry the registry literal and cannot tell absent from hidden —
   * probing it made every unregistered tenant throw on every tick (commonpractice#417). The
   * byo-mode read answers 404 `{"detail": {"error": "tenant_not_found_in_registry", …}}` ONLY for
   * an absent tenant (malformed id → 400 `malformed_tenant_selector`, fault → 503 with
   * `on_unresolved=error`). The literal is nested in FastAPI's `detail` envelope; see
   * `notFoundLiteral`. No `app` param: registration is tenant-level, not per-product.
   *
   * ⛔ ONLY TWO OUTCOMES ARE ALLOWED TO BE A BOOLEAN: a 2xx (registered) and the registry's own
   * `tenant_not_found_in_registry` 404 (not registered). Everything else — a transport failure, a
   * 401 from a rotated SA credential, a 503, an unmatched route, a literal-less 404 — THROWS.
   * Collapsing those into `false` would make the reconciler read a licences outage as "the whole
   * fleet is unregistered" and re-PUT every tenant on every tick, against a service that is already
   * failing.
   */
  async isTenantRegistered(tenantId: string): Promise<boolean> {
    const res = await this.authed(
      'GET',
      `tenants/${encodeURIComponent(tenantId)}/byo-mode?on_unresolved=error`,
    );
    if (res.status === 404) {
      if ((await notFoundLiteral(res)) === 'tenant_not_found_in_registry') return false;
    }
    if (!res.ok) {
      throw new LicensesAdminError(
        res.status,
        `probe tenant ${tenantId} registration failed: HTTP ${res.status}`,
      );
    }
    return true;
  }

  /** POST /internal/tenants/{id}/bundles/{bundle}/ensure — see the interface doc. */
  async ensureTenantBundle(tenantId: string, bundle: string, plans: readonly string[]): Promise<BundleEnsureOutcome> {
    const what = `ensure bundle '${bundle}' on tenant ${tenantId}`;
    // `plans` ONLY — no overrides. An omitted `plans` is not neutral: licences defaults it to
    // `["standard"]`, which the n8n-nodes apps (only a `tenant-pooled` plan, licences 051) do not
    // have, so every one of them was refused `no_plan`. The preference is deployment config.
    const res = await this.authed(
      'POST',
      `internal/tenants/${encodeURIComponent(tenantId)}/bundles/${encodeURIComponent(bundle)}/ensure`,
      { jsonBody: { plans: [...plans] } },
    );
    const body = (await res.json().catch(() => null)) as
      | {
          bundle?: string;
          apps?: Record<string, { decision?: string; license_id?: string | null; plan?: string | null }>;
          refused?: Array<{ app?: string; reason?: string }>;
          detail?: { error?: string; message?: string } | string;
        }
      | null;
    // 200, or 409 with the ensure body (some apps refused): both are an OUTCOME, not an error.
    if ((res.ok || res.status === 409) && body && typeof body.apps === 'object' && body.apps !== null) {
      const apps: Record<string, BundleEnsuredApp> = {};
      for (const [app, a] of Object.entries(body.apps)) {
        const decision = a?.decision;
        if (decision !== 'exists' && decision !== 'adopt' && decision !== 'insert') {
          throw new LicensesAdminError(502, `${what}: licences answered an unknown decision '${String(decision)}' for '${app}'`);
        }
        apps[app] = { decision, licenseId: a.license_id ?? null, plan: a.plan ?? null };
      }
      const refused = (Array.isArray(body.refused) ? body.refused : []).map((r) => ({
        app: String(r?.app ?? ''),
        reason: String(r?.reason ?? 'refused'),
      }));
      if (res.status === 409 && refused.length === 0) {
        throw new LicencesBundleError(409, 'bundle_refused', bundle, `${what} failed: HTTP 409 with nothing refused`);
      }
      return { bundle: body.bundle ?? bundle, apps, refused };
    }
    if (res.ok) {
      throw new LicensesAdminError(502, `${what}: licences answered ${res.status} without an ensure body`);
    }
    const detail = body?.detail;
    const code =
      typeof detail === 'object' && detail !== null && typeof detail.error === 'string'
        ? detail.error
        : res.status === 403
          ? 'licences_forbidden'
          : `licences_http_${res.status}`;
    const upstreamMessage =
      typeof detail === 'object' && detail !== null
        ? detail.message
        : typeof detail === 'string'
          ? detail
          : undefined;
    throw new LicencesBundleError(
      res.status,
      code,
      bundle,
      `${what} failed: HTTP ${res.status} ${code}${upstreamMessage ? ` — ${upstreamMessage}` : ''}`,
    );
  }

  /**
   * PUT /tenants/{id}/apps/{app_key}/byo-mode → state this tenant's BYO posture for THIS product.
   *
   * ⛔ THE PER-APP ROUTE, NOT THE TENANT-WIDE ONE, AND THEY ARE DIFFERENT COMMERCIAL STATEMENTS.
   * Verified against licences `main.py` (`set_tenant_app_byo_mode`, PUT
   * `/tenants/{name_or_id}/apps/{app_key}/byo-mode`, body `{byo_mode}`, role `license-admin`). The
   * tenant-wide value is a PATCH on `/tenants/{id}/byo-mode` and governs every product the customer
   * holds — writing there because CP wants its own posture would change the posture of products CP
   * knows nothing about. (An earlier draft of this method guessed `PUT /tenants/{id}/byo-mode?app=`:
   * FastAPI drops an unknown query parameter, so that call would have returned 200 having set the
   * TENANT-WIDE mode — the loudest possible wrong answer, silently.)
   */
  async setTenantByoMode(tenantId: string, mode: ByoMode): Promise<void> {
    const res = await this.authed(
      'PUT',
      `tenants/${encodeURIComponent(tenantId)}/apps/${encodeURIComponent(this.appKey)}/byo-mode`,
      { jsonBody: { byo_mode: mode } },
    );
    if (!res.ok) {
      throw new LicensesAdminError(
        res.status,
        `set byo_mode '${mode}' for tenant ${tenantId} failed: HTTP ${res.status}`,
      );
    }
  }
}

export type ByoMode = 'local_allowed' | 'byo_required' | 'platform_only';

/** The members of `LicensesAdminClient` that are optional in the type — see the block on the
 *  interface for why they are optional and why they must never be called with `?.`. */
type OptionalAdminMethod =
  | 'archiveTenant'
  | 'isTenantRegistered'
  | 'setTenantByoMode'
  | 'getActiveLicense'
  | 'getTenant'
  | 'renameTenant'
  | 'listPlans'
  | 'createPlan'
  | 'updatePlan'
  | 'deletePlan'
  | 'ensureTenantBundle'
  | 'listTenantLicences';

/**
 * Resolve one of the OPTIONAL client methods, or THROW.
 *
 * ⛔ THIS FUNCTION IS THE ENTIRE REASON THE `?` ABOVE IS SAFE. `client.archiveTenant?.(id)` is the
 * obvious spelling and it is the defect: it returns `undefined` — cleanly, awaitably, indistinguish-
 * ably from success — when the method is absent, so a client that cannot archive reports every
 * archive as done. `adminMethod(client, 'archiveTenant')(id)` cannot do that: a missing
 * implementation is a `LicensesAdminError(501)` that the caller reports exactly like a licences
 * outage.
 *
 * 501 (Not Implemented), not 502/503: `admin.ts`'s `isTransientLicenseError` retries `>= 500`, and
 * a missing method fails identically on every attempt. 501 is still >= 500 — so a retry loop WOULD
 * re-try it — which is why this is never called from inside `licenseNewTenant`'s retry loop. It is
 * called from paths that report rather than retry.
 */
export function adminMethod<K extends OptionalAdminMethod>(
  client: LicensesAdminClient,
  name: K,
): NonNullable<LicensesAdminClient[K]> {
  const fn = client[name];
  if (typeof fn !== 'function') {
    throw new LicensesAdminError(
      501,
      `the configured licenses admin client does not implement ${name}() — this is a test fake ` +
        `predating that method, not a licences outage; the real LicensesAdminService implements it`,
    );
  }
  return fn.bind(client) as NonNullable<LicensesAdminClient[K]>;
}

/**
 * Is there a licences admin API to talk to at all?
 *
 * ⛔ THIS IS NOT `config.license.issuanceEnabled`, AND CONFLATING THE TWO IS THE BUG THAT MADE
 * TENANT REGISTRATION DEPEND ON LICENCE MINTING. `issuanceEnabled` answers "may CP MINT licences" —
 * a commercial/rollout decision (Spec §9.5 C→F). Whether the service is REACHABLE is a deployment
 * fact, and registering a tenant in the registry is not minting: it is how the platform learns the
 * workspace exists at all. A deployment can legitimately be configured against licences with
 * issuance still off, and in that state a new tenant must still be registered.
 *
 * Both halves are required because `LicensesAdminService` needs both to make one call: no
 * `adminBaseUrl` makes `adminUrl()` produce a relative URL that `fetch` rejects, and no
 * `sa.tokenUrl` makes `getServiceToken()` throw before any request is built. Dev, CI and `bun test`
 * set neither, so this is false there and every central call is skipped — VISIBLY (the callers
 * report `skipped_unconfigured`), not silently.
 */
export function licencesAdminConfigured(): boolean {
  return Boolean(config.license.adminBaseUrl && config.license.sa.tokenUrl);
}

/**
 * Look a tenant up in the licences registry by name or id; `null` = not registered.
 * Throws `LicensesAdminError` on any failure (including a client that cannot do the lookup — 501).
 */
export async function getLicencesTenant(nameOrId: string): Promise<LicencesTenant | null> {
  return adminMethod(licensesAdmin(), 'getTenant')(nameOrId);
}

// ---- module accessor + test seam (mirrors keycloakAdmin / __setKeycloakAdminForTests) ----

let _instance: LicensesAdminClient | undefined;
let _testOverride: LicensesAdminClient | undefined;

/** Lazily-constructed default singleton. Dormant until LICENSE_ISSUANCE_ENABLED (F.2 flag). */
export function licensesAdmin(): LicensesAdminClient {
  if (_testOverride) return _testOverride;
  if (!_instance) _instance = new LicensesAdminService();
  return _instance;
}

/** Inject a fake SA client in tests (paired with `(undefined)` teardown). */
export function __setLicensesAdminForTests(fake: LicensesAdminClient | undefined): void {
  _testOverride = fake;
}
