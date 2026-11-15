// src/services/tenant-service.ts — create a CP tenant. Shared by POST /api/tenants (super_admin),
// signup-approval's `new_tenant` mode and the future website signup.
//
// INVARIANT: CP tenant id == the id of the licences tenant CP REGISTERED for it. CP always owns its
// own licences tenant (owner decision 2026-10-12): there is no adoption. Since licences migration 050
// tenant names are unique PER OWNING APP (the owner is derived from CP's Keycloak client), so fr's
// `netcare` and CP's `netcare` coexist: CP registers `slugify(name)` directly. A 409 now only means
// CP itself already has a workspace with that name. The registry name is stored as
// `tenants.licences_name`, and it IS the CP slug: one name, both sides (see `claimCentralName`).
//
// Order:
//   1. a fresh CP id
//   2. claim ONE name free in BOTH CP (slug) and licences, register it + BYO posture — failure →
//      nothing in CP. A super_admin create gets exactly `slugify(name)` or a 409; a self-signup
//      approval (`autoSuffixName`) walks `<name>-2`, `<name>-3`, … to a bound.
//   3. insert the CP row (`central_link` 'registered', `licences_name`, plan + expiry)
//   4. tenant licence on the tenant's plan — failure → the row is deleted again, 502
//   (any failure after step 2 VOIDS the registration — rename to `<name>-void-<id8>` + archive — so a
//   retry gets the same name back instead of a 409)
//   4d. ensure the requested licences BUNDLES (0104) — failure does NOT roll the tenant back
//       (`licenceBundlesError`; each bundle recorded, retried from the workspace page)
//   5. invite the first tenant_admin — failure does NOT roll the tenant back (`inviteError`)
//   6. audit `tenant.create`
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db, tenants } from '../db/client';
import { slugify } from '../datasets/dataset-service';
import { recordAudit } from '../host/audit-service';
import { log } from '../host/logger';
import { incCounter } from '../host/metrics';
import { HttpError, conflict, unprocessable } from '../utils/http';
import { ensureTenantLicense, type EnsureTenantLicenceOutcome } from './license-provisioning';
import {
  licensesAdmin,
  adminMethod,
  licencesAdminConfigured,
  LicencesNameConflictError,
  LicencesTenantOwnedByOtherAppError,
  LicensesAdminError,
  type ByoMode,
  type LicensesAdminClient,
  type LicencesPlan,
} from './licenses-admin';
import type { CreatedInvite } from './invite-service';
import { planByoMode, LOCAL_LLM_PLAN } from './plan-posture';
import type { TermsWriteOutcome } from './tenant-terms';
import {
  initialProvisioningRecord,
  readProvisioning,
  releaseClaim,
  runStep,
  stepRecord,
  licenceStepAfter,
  toView,
  writeStep,
  type ProvisioningStep,
  type ProvisioningView,
  type StepRunResult,
} from './tenant-provisioning';
import type { TenantTerms } from './billing-admin';
import { requestedBundleRecord, type BundleResult, type LicenceBundlesRecord } from './tenant-licence-bundles';

export interface CreateTenantInput {
  name: string;
  firstAdminEmail?: string;
  /** The first admin's names — the route requires both with `firstAdminEmail`. They seed the realm
   *  identity so Keycloak does not stop the invitee at its VERIFY_PROFILE form. */
  firstAdminFirstName?: string;
  firstAdminLastName?: string;
  /** Required unless the plan fixes the posture (`local-llm` / `byo`, services/plan-posture.ts). */
  byoMode?: ByoMode;
  /** Billing terms stated at create (platform fee, seat fee, markup %). Omitted = none written. */
  terms?: TenantTerms;
  maxMembers?: number | null;
  /** The licences plan code (of THIS app). Omitted → `config.license.planCode`. */
  planCode?: string;
  /** Licence start; omitted/null = from the mint. */
  startsAt?: Date | null;
  /** Licence expiry; omitted/null = perpetual. */
  expiresAt?: Date | null;
  industry?: string | null;
  /** Licences bundle keys CP (the tenant's owner) ensures after its own licence (0104). Validated
   *  for shape by the route; licences decides which keys exist. */
  licenceBundles?: string[];
  actor: { id: string; email?: string };
  reqId?: string;
  /**
   * SELF-SIGNUP APPROVAL ONLY (routes/onboarding.ts). When the name is taken — in CP or in CP's own
   * licences namespace (`licences_name_unavailable`) — try `<slug>-2` … `<slug>-<maxAttempts>`
   * instead of refusing. ⛔ Never set by POST /api/tenants: a super_admin naming a workspace gets the
   * name they typed or a 409 telling them to choose another, not a silently different one.
   */
  autoSuffixName?: { maxAttempts: number };
  /**
   * SELF-SIGNUP APPROVAL ONLY: the approval founding this workspace. Written into the provisioning
   * record IN THE TENANT ROW'S OWN INSERT (`signupApprovalId`), so an approve that dies at any point
   * after the row exists is RESUMED into it by the next approve, never founding a second workspace.
   */
  signupApprovalId?: string;
}

export interface CreateTenantResult {
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
    central_link: 'registered' | 'adopted' | null;
    licences_name: string | null;
    plan_code: string | null;
    licence_starts_at: Date | null;
    licence_expires_at: Date | null;
  };
  /** What each creation step did (0101) — the workspace page's "Setup" section shows the same. */
  provisioning: ProvisioningView;
  invite: CreatedInvite | null;
  /** Set when `firstAdminEmail` was given and the invite failed; the tenant itself stands. */
  inviteError?: string;
  /** What happened to the billing terms (absent = none were given). */
  terms?: TermsWriteOutcome['status'];
  /** Set when writing the terms failed; the tenant stands, the terms can be re-saved from its page. */
  termsError?: string;
  /** Set when provisioning a local-llm tenant's inference credential failed (re-run from its page). */
  inferenceError?: string;
  /** Per-bundle results when `licenceBundles` were requested. */
  licenceBundles?: BundleResult[];
  /** Set when at least one bundle failed; the tenant stands, the bundles are retried from its page. */
  licenceBundlesError?: string;
}

/**
 * The BYO posture a tenant gets: the one its plan FIXES, or the one the super_admin chose. A choice
 * that contradicts the plan is refused rather than silently overridden (422 `byo_mode_fixed_by_plan`).
 */
export function resolveByoForPlan(planCode: string, requested: ByoMode | undefined): ByoMode {
  const fixed = planByoMode(planCode);
  if (fixed) {
    if (requested && requested !== fixed) {
      throw unprocessable(
        'byo_mode_fixed_by_plan',
        `Plan '${planCode}' fixes the BYO posture to '${fixed}'.`,
      );
    }
    return fixed;
  }
  if (!requested) throw unprocessable('byo_mode_required', 'Choose a BYO posture for this plan.');
  return requested;
}

/** Is `slug` already a CP tenant's slug? */
async function cpSlugTaken(slug: string): Promise<boolean> {
  const [hit] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return Boolean(hit);
}

/** `<base>`, then `<base>-2`, `<base>-3`, … — the candidate names for attempt `i` (1-based). */
function suffixedName(base: string, i: number): string {
  return i === 1 ? base : `${base}-${i}`;
}

/**
 * Claim ONE name that is free in CP (slug) AND in CP's licences namespace, and register `tenantId`
 * under it. Returns the name — which the caller uses as BOTH `tenants.slug` and
 * `tenants.licences_name`.
 *
 * ⛔ THIS REPLACED A SPLIT-BRAIN. CP used to suffix its own slug on a CP collision (`uniqueSlug`,
 * random 4 chars) while registering the UNSUFFIXED base in licences — so the two names for one
 * workspace could differ, and the licences 409 that followed was about a name CP was not even going
 * to use. Now one candidate is checked on both sides and only a name both accept is used.
 *
 * `attempts` = 1 (super_admin create): exactly `base`, or a 409 `licences_name_unavailable`.
 * `attempts` > 1 (self-signup approval): walk `base`, `base-2`, … skipping CP-taken slugs and
 * licences 409s; any other licences failure stops at once. Exhausted → 409 for the last candidate.
 */
async function claimCentralName(
  client: LicensesAdminClient,
  tenantId: string,
  base: string,
  attempts: number,
): Promise<string> {
  const max = Math.max(1, Math.floor(attempts));
  let last = base;
  for (let i = 1; i <= max; i++) {
    const candidate = suffixedName(base, i);
    last = candidate;
    if (await cpSlugTaken(candidate)) continue;
    try {
      return await registerOwnLicencesTenant(client, tenantId, candidate);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'licences_name_unavailable' && i < max) continue;
      throw err;
    }
  }
  throw nameTaken(last);
}

/** Without a licences service (dev/CI): the first `<base>`, `<base>-2`, … free in CP. */
async function firstFreeSlug(base: string, attempts: number): Promise<string> {
  const max = Math.max(1, Math.floor(attempts));
  for (let i = 1; i <= max; i++) {
    const candidate = suffixedName(base, i);
    if (!(await cpSlugTaken(candidate))) return candidate;
  }
  throw nameTaken(suffixedName(base, max));
}

/** A slug free in CP, suffixed on collision. Only for a deployment WITHOUT a licences service (there
 *  is no registry name to keep in step); with one, `claimCentralName` picks the name. */
async function uniqueSlug(base: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const [hit] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, candidate));
    if (!hit) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function licencesUnavailable(err: unknown, what: string): HttpError {
  const message = err instanceof Error ? err.message : String(err);
  return new HttpError(502, 'licences_unavailable', `${what}: ${message}`, {
    ...(err instanceof LicensesAdminError ? { upstreamStatus: err.status } : {}),
  });
}

// ---- CP's own licences-registry name ----------------------------------------------------------

/** 409 — CP already holds a licences tenant with this name (names are unique per owning app). */
function nameTaken(name: string): HttpError {
  return conflict(
    'licences_name_unavailable',
    `You already have a workspace registered as '${name}'. Choose a different workspace name.`,
    { name },
  );
}

/**
 * 502 — licences says this tenant id belongs to ANOTHER app. CP mints its tenant ids itself, so this
 * is never a naming problem to retry around: it is a shared/foreign id or a bug, and it is logged
 * loudly for an operator.
 */
function ownedByOtherApp(tenantId: string, err: LicencesTenantOwnedByOtherAppError): HttpError {
  log.error('licences_tenant_owned_by_other_app', { component: 'tenant-service', tenantId, err });
  return new HttpError(502, 'licences_tenant_owned_by_other_app', err.message, { upstreamStatus: 409 });
}

/** Map a registry write failure: name clash → 409, foreign id → 502 (loud), anything else → 502. */
function registryWriteFailure(err: unknown, tenantId: string, name: string, what: string): HttpError {
  if (err instanceof LicencesNameConflictError) return nameTaken(name);
  if (err instanceof LicencesTenantOwnedByOtherAppError) return ownedByOtherApp(tenantId, err);
  return licencesUnavailable(err, what);
}

/**
 * Register `tenantId` in the licences registry under `name` (the CP slug). ONE attempt: since
 * licences migration 050 names are unique per OWNING APP, so another app's tenant with the same name
 * is no longer a clash and there is no suffix to fall back to. A 409 `tenant_name_taken` means CP
 * itself already holds that name → 409 `licences_name_unavailable`; a foreign id → 502
 * `licences_tenant_owned_by_other_app`; any other failure → 502 `licences_unavailable`.
 */
export async function registerOwnLicencesTenant(
  client: LicensesAdminClient,
  tenantId: string,
  name: string,
): Promise<string> {
  try {
    await client.ensureTenantRegistered(tenantId, name);
    return name;
  } catch (err) {
    throw registryWriteFailure(err, tenantId, name, `licences registration of '${name}' (${tenantId}) failed`);
  }
}

/**
 * The tenant's BYO posture as the licences registry holds it — best effort, `null` = unknown. Read
 * straight from the registry (`getTenantByoMode`), NOT via byo-posture.ts's cached resolver: that one
 * is issuance-gated and fails CLOSED to `byo_required`, so on an outage it would show the operator a
 * posture the tenant does not have. The method is not on the client interface (only
 * `LicensesAdminService` has it), hence the duck-typed probe.
 */
export async function readTenantByoMode(tenantId: string): Promise<ByoMode | null> {
  if (!licencesAdminConfigured()) return null;
  const client = licensesAdmin() as LicensesAdminClient & {
    getTenantByoMode?: (id: string) => Promise<ByoMode>;
  };
  if (typeof client.getTenantByoMode !== 'function') return null;
  try {
    return await client.getTenantByoMode(tenantId);
  } catch (err) {
    log.warn('tenant_byo_mode_unknown', { component: 'tenant-service', tenantId, err });
    return null;
  }
}

/**
 * A plan code a super_admin may put a tenant on: it exists for THIS app and is not retired. Only
 * checked when a licences service is configured (dev/CI have none, and there nothing is minted).
 * 422 `plan_unknown` / `plan_retired`; a licences outage is a 502.
 */
export async function assertPlanAssignable(planCode: string): Promise<LicencesPlan | null> {
  if (!licencesAdminConfigured()) return null;
  let plans: LicencesPlan[];
  try {
    plans = await adminMethod(licensesAdmin(), 'listPlans')({ includeRevoked: true });
  } catch (err) {
    throw licencesUnavailable(err, 'reading the plan catalogue failed');
  }
  const plan = plans.find((p) => p.code === planCode);
  if (!plan) throw unprocessable('plan_unknown', `There is no plan '${planCode}' for this app.`);
  if (plan.revoked) {
    throw unprocessable('plan_retired', `Plan '${planCode}' is retired and cannot be assigned.`);
  }
  return plan;
}

/** 422 `plan_retired` when the deployment default plan has been retired in the catalogue. */
async function assertDefaultPlanNotRetired(planCode: string): Promise<void> {
  if (!licencesAdminConfigured()) return;
  const client = licensesAdmin();
  // A client with no catalogue read (a test fake predating it) cannot know; the mint still fails
  // loudly on an unknown plan. The real LicensesAdminService implements it.
  if (typeof client.listPlans !== 'function') return;
  let plans: LicencesPlan[];
  try {
    plans = await adminMethod(client, 'listPlans')({ includeRevoked: true });
  } catch (err) {
    throw licencesUnavailable(err, 'reading the plan catalogue failed');
  }
  if (plans.find((p) => p.code === planCode)?.revoked) {
    throw unprocessable(
      'plan_retired',
      `The deployment's default plan '${planCode}' (LICENSE_PLAN_CODE) is retired — choose a plan ` +
        `explicitly, and change LICENSE_PLAN_CODE to a live plan.`,
    );
  }
}

// ---- licence (step 4), with the retry policy that used to live in routes/admin.ts ----

/** Attempts for a transient `ensureTenantLicense` failure (the first call + up to 2 retries). */
const LICENSE_RETRY_ATTEMPTS = 3;
/** Backoff before retry N (ms) — this runs inside a super_admin's synchronous request. */
const LICENSE_RETRY_BACKOFF_MS = [100, 300];

/** `as502` (license-provisioning.ts) flattens upstream failures to 502 but keeps
 *  `details.upstreamStatus`: retry only an upstream >= 500 (or a bare >= 500 HttpError). A 4xx fails
 *  identically on every attempt; a non-HttpError is a bug, not a blip. */
function isTransientLicenseError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  const upstreamStatus = err.details?.upstreamStatus;
  if (typeof upstreamStatus === 'number') return upstreamStatus >= 500;
  return err.status >= 500;
}

/** Licence the new tenant, bound to the creating super_admin (a fresh tenant has no members; CP's
 *  licence is tenant-level, so the subject is provenance). Idempotent and retry-safe; a no-op while
 *  `LICENSE_ISSUANCE_ENABLED` is off. */
async function licenseNewTenant(tenantId: string, subjectId: string): Promise<EnsureTenantLicenceOutcome> {
  let err: unknown;
  for (let attempt = 1; attempt <= LICENSE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await ensureTenantLicense(tenantId, subjectId);
    } catch (thrown) {
      err = thrown;
      if (attempt === LICENSE_RETRY_ATTEMPTS || !isTransientLicenseError(thrown)) break;
      await Bun.sleep(LICENSE_RETRY_BACKOFF_MS[attempt - 1] ?? LICENSE_RETRY_BACKOFF_MS.at(-1)!);
    }
  }
  throw err;
}

/** A create's compensation could not free its registry name (see `voidRegistration`). */
export const TENANT_CREATE_VOID_FAILED_COUNTER = 'tenant_create_licences_void_failed_total';

/** The name a voided registration is moved to: `<name>-void-<8 hex of the id>`. The id's LAST 8
 *  hex (random) rather than its first: a UUIDv7's leading 32 bits are its millisecond clock, so two
 *  creates voided within ~65 s would share a "first 8" and the second rename would 409. */
export function voidedLicencesName(name: string, tenantId: string): string {
  return `${name}-void-${tenantId.replace(/-/g, '').slice(-8).toLowerCase()}`;
}

/**
 * COMPENSATION for a create that failed AFTER `registerOwnLicencesTenant` (posture write, CP insert,
 * licence mint): rename the licences tenant THIS call registered out of the way and archive it.
 *
 * ⛔ WITHOUT IT A NAME BURNS. The registered tenant would keep the name, so every retry of the
 * create would be refused with `licences_name_unavailable` (CP already holds that name). Licences
 * tenants cannot be deleted, so rename + archive is the undo.
 *
 * Only ever called for an id this create minted (so the registration is necessarily its own), and
 * NEVER fatal: a failure is logged and counted, and the caller surfaces its ORIGINAL error.
 */
async function voidRegistration(tenantId: string, name: string, reqId?: string): Promise<void> {
  const client = licensesAdmin();
  try {
    await adminMethod(client, 'renameTenant')(tenantId, voidedLicencesName(name, tenantId));
  } catch (err) {
    incCounter(TENANT_CREATE_VOID_FAILED_COUNTER);
    log.error('tenant_create_licences_void_failed', {
      tenantId,
      name,
      reqId,
      step: 'rename',
      remediation: `licences tenant ${tenantId} still holds '${name}' unused; rename + archive it by hand`,
      err,
    });
  }
  try {
    await adminMethod(client, 'archiveTenant')(tenantId);
  } catch (err) {
    incCounter(TENANT_CREATE_VOID_FAILED_COUNTER);
    log.error('tenant_create_licences_void_failed', { tenantId, name, reqId, step: 'archive', err });
  }
}

export async function createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
  const central = licencesAdminConfigured();
  const base = slugify(input.name) || 't';
  const planCode = input.planCode ?? config.license.planCode;
  if (input.startsAt && input.expiresAt && input.expiresAt <= input.startsAt) {
    throw unprocessable('licence_window_invalid', 'The expiry must be after the start.');
  }
  // An explicitly chosen plan must exist and be live. The deployment default (`LICENSE_PLAN_CODE`)
  // is no longer trusted blindly: once Part B retires `standard`, a default still pointing at it
  // would land every new tenant on a retired plan. A RETIRED default is refused (422 plan_retired);
  // an unknown one is left to the mint, which fails loudly on its own.
  if (input.planCode) await assertPlanAssignable(input.planCode);
  else await assertDefaultPlanNotRetired(planCode);
  const byoMode = resolveByoForPlan(planCode, input.byoMode);

  // (1) CP id. Dev/CI/tests configure no licences service: every central step is skipped and the
  // tenant is born with `central_link` NULL (the repair sweep registers it later, under its slug).
  const id = Bun.randomUUIDv7();
  const suffixAttempts = input.autoSuffixName?.maxAttempts ?? 1;

  // (2) ONE name for both sides + central registration + posture, BEFORE any CP write. `id` was
  // minted a line above, so a successful registration below is always THIS call's — which is what
  // licenses the compensation.
  let slug: string;
  let licencesName: string | null = null;
  if (central) {
    const client = licensesAdmin();
    licencesName = await claimCentralName(client, id, base, suffixAttempts);
    slug = licencesName;
    try {
      await adminMethod(client, 'setTenantByoMode')(id, byoMode);
    } catch (err) {
      await voidRegistration(id, licencesName, input.reqId);
      throw licencesUnavailable(err, `setting the BYO posture of '${licencesName}' (${id}) failed`);
    }
  } else {
    slug = input.autoSuffixName ? await firstFreeSlug(base, suffixAttempts) : await uniqueSlug(base);
  }

  // (3) the CP row, born with its provisioning record (0101): every step still to run is `pending`.
  const requestedBundles = [...new Set(input.licenceBundles ?? [])];
  const initialBundles: LicenceBundlesRecord = Object.fromEntries(
    requestedBundles.map((b) => [b, requestedBundleRecord()]),
  );
  const initialRecord = initialProvisioningRecord({
    central,
    terms: input.terms,
    needsIr: planCode === LOCAL_LLM_PLAN,
    bundles: requestedBundles.length > 0,
    firstAdmin: input.firstAdminEmail
      ? { email: input.firstAdminEmail, firstName: input.firstAdminFirstName, lastName: input.firstAdminLastName }
      : undefined,
  });
  if (input.signupApprovalId) initialRecord.signupApprovalId = input.signupApprovalId;
  let tenant: CreateTenantResult['tenant'] | undefined;
  try {
    [tenant] = await db
      .insert(tenants)
      .values({
        id,
        name: input.name,
        slug,
        max_members: input.maxMembers ?? null,
        industry: input.industry ?? null,
        central_link: central ? 'registered' : null,
        central_linked_at: central ? new Date() : null,
        licences_name: licencesName,
        plan_code: planCode,
        licence_starts_at: input.startsAt ?? null,
        licence_expires_at: input.expiresAt ?? null,
        provisioning: initialRecord,
        licence_bundles: initialBundles,
      })
      .returning({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        central_link: tenants.central_link,
        licences_name: tenants.licences_name,
        plan_code: tenants.plan_code,
        licence_starts_at: tenants.licence_starts_at,
        licence_expires_at: tenants.licence_expires_at,
      });
  } catch (err) {
    if (licencesName) await voidRegistration(id, licencesName, input.reqId);
    throw err;
  }

  // (4) licence. On failure the row goes again — it has no children yet — and the licences tenant
  // this call registered is VOIDED, so a retry of the whole create gets the same name back.
  let licenceOutcome: EnsureTenantLicenceOutcome;
  try {
    licenceOutcome = await licenseNewTenant(tenant!.id, input.actor.id);
  } catch (err) {
    try {
      await db.delete(tenants).where(eq(tenants.id, tenant!.id));
    } catch (delErr) {
      log.error('tenant_create_rollback_failed', { tenantId: tenant!.id, reqId: input.reqId, err: delErr });
    }
    if (licencesName) await voidRegistration(id, licencesName, input.reqId);
    const detail = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      502,
      'licences_unavailable',
      `Licensing the new workspace '${input.name}' failed, so it was NOT created: ${detail}`,
      err instanceof HttpError && err.details?.upstreamStatus !== undefined
        ? { upstreamStatus: err.details.upstreamStatus }
        : undefined,
    );
  }

  // (4a) the licence landed — record it. From here on the tenant STANDS whatever fails, and every
  // step below leaves a record (`tenants.provisioning`, 0101) the workspace page shows and Retry /
  // the onboarding-integrity tick re-runs — the terms and the first admin are held for that retry.
  const provisioned = (step: ProvisioningStep, run: () => Promise<StepRunResult>) =>
    run().catch((err): StepRunResult => {
      // A step writes its own record; a throw here is the record write itself failing.
      log.error('tenant_create_provisioning_record_failed', { tenantId: tenant!.id, step, reqId: input.reqId, err });
      return { record: stepRecord('failed', { code: 'provisioning_record_failed', message: String(err) }) };
    });
  // ⛔ `ok` only if a token is actually STORED: a busy lease or a tenant-level licence returns
  // without one (`licenceStepAfter`), and a busy one is `pending` for the tick to finish.
  await provisioned('licence', async () => {
    const record = await licenceStepAfter(tenant!.id, licenceOutcome, undefined);
    await writeStep(tenant!.id, 'licence', record);
    return { record };
  });
  const rec = initialRecord;

  // (4b) billing terms — billing is the system of record. A transient failure (5xx, billing not yet
  // knowing the tenant) is `pending` and retried by the tick; a real refusal is `failed`. Either way
  // the terms are HELD, so nobody re-types them.
  let termsStatus: TermsWriteOutcome['status'] | undefined;
  let termsError: string | undefined;
  if (input.terms) {
    const out = await provisioned('billing_terms', () =>
      runStep(tenant!.id, 'billing_terms', rec, { source: 'create', actorId: input.actor.id, reqId: input.reqId }),
    );
    termsStatus = out.termsOutcome;
    if (out.record.status !== 'ok' && out.record.status !== 'skipped') termsError = out.record.code ?? 'billing_unavailable';
  }

  // (4c) a local-llm tenant's own inference-router credential. Same "tenant stands" rule: until it
  // exists its LLM calls fail closed (503 `llm_inference_not_provisioned`), never `Bearer EMPTY`.
  let inferenceError: string | undefined;
  if (planCode === LOCAL_LLM_PLAN) {
    const out = await provisioned('ir_licence', () =>
      runStep(tenant!.id, 'ir_licence', rec, { source: 'create', actorId: input.actor.id, reqId: input.reqId }),
    );
    if (out.record.status === 'failed' || out.record.status === 'pending') {
      inferenceError = out.record.code ?? 'inference_provision_failed';
    }
  }

  // (4d) licences bundles (0104). CP OWNS this tenant in licences, so CP ensures them — after its own
  // licence, so a tenant that could not be licensed never holds other apps. Same "tenant stands" rule
  // as the steps above: a bundle that fails (licences 403/404, an outage) is recorded per bundle and
  // re-ensured from the workspace page; it never voids a tenant that is fully usable in CP.
  let licenceBundles: BundleResult[] | undefined;
  let licenceBundlesError: string | undefined;
  if (requestedBundles.length > 0) {
    const out = await provisioned('licence_bundles', () =>
      runStep(tenant!.id, 'licence_bundles', rec, { source: 'create', actorId: input.actor.id, reqId: input.reqId }),
    );
    // The create was BORN holding the `licence_bundles` claim (initialProvisioningRecord), so a Retry
    // or repair clicked mid-create got 409 `provisioning_step_busy`. The step's record write released
    // it; release explicitly too, for the path where that write itself threw.
    await releaseClaim(tenant!.id, 'licence_bundles').catch((err) =>
      log.error('tenant_create_bundle_claim_release_failed', { tenantId: tenant!.id, reqId: input.reqId, err }),
    );
    licenceBundles = out.bundles ?? [];
    if (out.record.status === 'failed' || out.record.status === 'pending') {
      licenceBundlesError = out.record.code ?? 'licence_bundles_failed';
    }
  }

  // (5) first admin invite — the tenant stands even when this fails.
  let invite: CreatedInvite | null = null;
  let inviteError: string | undefined;
  if (input.firstAdminEmail) {
    const out = await provisioned('first_invite', () =>
      runStep(tenant!.id, 'first_invite', rec, { source: 'create', actorId: input.actor.id, reqId: input.reqId }),
    );
    invite = out.invite ?? null;
    if (!invite) inviteError = out.record.code ?? 'invite_failed';
  }

  // (6) audit.
  await recordAudit({
    actorId: input.actor.id,
    action: 'tenant.create',
    category: 'tenant',
    targetType: 'tenant',
    targetId: tenant!.id,
    result: tenant!.name,
    resultTone: inviteError || termsError || inferenceError || licenceBundlesError ? 'warn' : 'ok',
    tenantId: tenant!.id,
    metadata: {
      slug: tenant!.slug,
      central_link: tenant!.central_link,
      licencesName,
      planCode,
      startsAt: input.startsAt?.toISOString() ?? null,
      expiresAt: input.expiresAt?.toISOString() ?? null,
      // null when nothing was written: no licences service.
      byoMode: central ? byoMode : null,
      terms: input.terms ?? null,
      termsStatus: termsStatus ?? null,
      termsError: termsError ?? null,
      inferenceError: inferenceError ?? null,
      licenceBundles: licenceBundles?.map((b) => ({ bundle: b.bundle, status: b.status, code: b.code })) ?? [],
      licenceBundlesError: licenceBundlesError ?? null,
      maxMembers: input.maxMembers ?? null,
      issuanceEnabled: config.license.issuanceEnabled,
      firstAdminInvited: invite !== null,
      inviteEmailDelivery: invite?.emailDelivery ?? null,
      inviteError: inviteError ?? null,
    },
  });

  return {
    tenant: tenant!,
    provisioning: toView(await readProvisioning(tenant!.id).catch(() => null)),
    invite,
    ...(inviteError ? { inviteError } : {}),
    ...(termsStatus ? { terms: termsStatus } : {}),
    ...(termsError ? { termsError } : {}),
    ...(inferenceError ? { inferenceError } : {}),
    ...(licenceBundles ? { licenceBundles } : {}),
    ...(licenceBundlesError ? { licenceBundlesError } : {}),
  };
}
