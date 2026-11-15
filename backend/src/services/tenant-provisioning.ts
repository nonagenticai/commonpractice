// src/services/tenant-provisioning.ts — the per-tenant record of what workspace creation did, and
// the retry of any step that did not land (migration 0101, `tenants.provisioning`).
//
// ⛔ WHY THIS EXISTS (prod 2026-10-13, workspace "Netcare"). The licence landed; billing then refused
// the terms write; the create still answered 201 and the screen said "Billing did not accept its
// terms" — and the terms the super_admin typed were GONE: nothing recorded them, nothing retried
// them, and the only repair was to notice and re-type them. Every step after the licence (billing
// terms, the local-llm inference-router licence, the first-admin invite) had the same shape.
//
// So every step now leaves a record — ok | failed | pending | skipped, the error code + message, the
// attempt count and times — and the input a retry needs (the terms, the first admin's name/email)
// is kept beside it until that step lands, then dropped (billing stays the system of record for
// terms; CP keeps no lasting copy of them).
//
// ⛔ RETENTION OF THE HELD INPUTS (`terms`, `firstAdmin` — the first admin's email + name are PII).
// They live on the row for exactly as long as something can still USE them, and no longer:
//   • the step that needs them reaches `ok`/`skipped` → `writeStep(…, drop)` removes that input
//     (billing_terms drops `terms`, first_invite drops `firstAdmin`; an edit of the terms drops
//     `terms` too, `writeTermsFromEdit`);
//   • `signupAdmin` (the early-access requester seated at approve: sub, email, name, invite id,
//     language) is dropped when `invite_email` lands;
//   • the workspace is OFFBOARDED → `services/offboarding.ts offboardTenantWrites` removes ALL in
//     the same UPDATE that stamps `offboarded_at` (Retry then 409s and the tick skips the tenant, so
//     nothing could ever send them again).
// A step that is `failed` keeps its input ON PURPOSE — the Retry button re-sends it with no
// re-entry, which is the whole point of holding it. Nothing else may read these keys: the API view
// (`toView`) reports only `termsHeld` / `firstAdminHeld`, never the values.
//
//   • `pending` — a TRANSIENT failure (billing 5xx/transport, billing not yet knowing the tenant).
//     The onboarding-integrity tick retries it with bounded exponential backoff.
//   • `failed`  — a refusal that will fail identically next time (a real 4xx), or a step the tick
//     does not own. The super_admin's Retry button re-runs it; the tick also re-tries a failed
//     BILLING step on the same bounded backoff, since a billing fix can land without CP noticing.
//
// ⛔ THE CLAIM IS PER WORK ITEM — (tenant, step) — NOT PER TICK. A super_admin's Retry and the tick
// on another replica can reach the same step at once; `claimStep` is one conditional UPDATE on the
// step's own `leaseUntil`, so exactly one of them runs it. Every step action is idempotent besides
// (billing read-compare-put, the leased IR mint, the invite renew-or-create, licences' own keys), so
// a lease that expires under a slow call costs a duplicate no-op, never a duplicate effect.
import { desc, eq, sql } from 'drizzle-orm';
import { db, signupApprovals, tenants } from '../db/client';
import { log } from '../host/logger';
import { incCounter } from '../host/metrics';
import { HttpError, conflict, notFound } from '../utils/http';
import type { TenantTerms } from './billing-admin';
import { writeTenantTerms, type TermsWriteOutcome } from './tenant-terms';
import { ensureTenantInference } from './tenant-inference';
import { createInvite, type CreatedInvite } from './invite-service';
import {
  ensureMemberEntitlement,
  ensureTenantLicense,
  revokeMemberEntitlement,
  tenantLicenceStored,
  type EnsureTenantLicenceOutcome,
} from './license-provisioning';
import { claimSeat } from './seat-limit';
import { upsertLocalUserTx } from './provisioning';
import { sendSignupSetupEmail } from './signup-email';
import type { TenantRole } from '../types';
import {
  licensesAdmin,
  licencesAdminConfigured,
  LicencesAccessRefusedError,
  LicencesNameConflictError,
  LicencesTenantOwnedByOtherAppError,
} from './licenses-admin';
import {
  bundleEnsureWorstCaseMs,
  ensureTenantBundles,
  readLicenceBundles,
  requestedBundleRecord,
  summariseBundles,
  writeLicenceBundles,
  type BundleResult,
  type LicenceBundlesRecord,
} from './tenant-licence-bundles';

export const PROVISIONING_STEPS = [
  'licences_tenant',
  'licence',
  'billing_terms',
  'ir_licence',
  'licence_bundles',
  'first_invite',
  // Early-access approval (George 2026-10-19, "licence at approval"): the requester CP minted an
  // identity for is seated at approve (`member_seat`), their member licence minted
  // (`member_licence`), and only THEN is the set-password email sent (`invite_email`). See
  // `recordSignupAdminSeated` and routes/onboarding.ts `approveApprovalRow`.
  'member_seat',
  'member_licence',
  'invite_email',
] as const;
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];
export type StepStatus = 'ok' | 'failed' | 'pending' | 'skipped';

export function isProvisioningStep(s: string): s is ProvisioningStep {
  return (PROVISIONING_STEPS as readonly string[]).includes(s);
}

export interface StepRecord {
  status: StepStatus;
  /** Machine code of the last failure (`billing_unavailable`, `billing_refused`, …); null when ok. */
  code: string | null;
  /** Human detail of the last failure, truncated. Super_admin-only surface. */
  message: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  /** When the tick may next retry it; null = the tick will not (ok/skipped, or it gave up). */
  nextAttemptAt: string | null;
  /** The per-(tenant, step) claim. Present only while somebody is running the step. */
  leaseUntil?: string | null;
}

export interface FirstAdminInput {
  email: string;
  firstName?: string;
  lastName?: string;
}

/**
 * The early-access requester seated at approve — kept ONLY until `invite_email` lands (PII: email +
 * name), like `firstAdmin`. `inviteId` is the accepted invite whose link the email carries.
 */
export interface SignupAdminInput {
  sub: string;
  email: string;
  name: string | null;
  role: TenantRole;
  inviteId: string;
  /** 0121 — the requester's language; null = en. */
  locale: string | null;
}

export interface ProvisioningRecord {
  steps: Partial<Record<ProvisioningStep, StepRecord>>;
  /** The early-access requester — kept ONLY until `invite_email` lands. */
  signupAdmin?: SignupAdminInput;
  /** The signup approval that FOUNDED this workspace (no PII) — lets a retried approve resume it
   *  instead of founding a second one (`markFoundedByApproval`). */
  signupApprovalId?: string;
  /** The terms entered at create — kept ONLY until `billing_terms` lands, so a retry needs no re-entry. */
  terms?: TenantTerms;
  /** The first admin as entered at create — kept ONLY until `first_invite` lands. */
  firstAdmin?: FirstAdminInput;
}

/** The view the API returns: the steps, and whether the retry inputs are held — never the PII itself. */
export interface ProvisioningView {
  recorded: boolean;
  steps: Partial<Record<ProvisioningStep, Omit<StepRecord, 'leaseUntil'>>>;
  termsHeld: boolean;
  firstAdminHeld: boolean;
}

// ---- policy -------------------------------------------------------------------------------------

/** Quick in-request attempts for billing's "tenant not registered yet" 422 (first call included).
 *  Billing learns new tenants by polling licences (~300 s); a few seconds catches a refresh that is
 *  already due, and anything longer belongs to the tick, not to a super_admin's open request. */
export const BILLING_UNREGISTERED_QUICK_ATTEMPTS = 3;
export const BILLING_UNREGISTERED_QUICK_BACKOFF_MS = 1_000;
/** The tick's bounded backoff for a billing step: 1, 2, 4 … min, capped at 6 h, at most 10 attempts. */
export const PROVISIONING_BACKOFF_BASE_MS = 60_000;
export const PROVISIONING_BACKOFF_CAP_MS = 6 * 60 * 60_000;
export const PROVISIONING_MAX_ATTEMPTS = 10;
/** The claim. Longer than any single step's calls (billing 2 × 10 s, the IR mint + smoke). */
export const PROVISIONING_LEASE_MS = 2 * 60_000;

/**
 * THE `licence_bundles` CLAIM. One claim per step (the same one Retry and the repair route take), so
 * a create and a Retry can never ensure bundles side by side. Its window is not a single fixed lease:
 * a bundle list (up to 20 per request, more over time) can take `count × bundleEnsureWorstCaseMs()`
 * — 20 × (3 attempts × 2 calls × 10 s + 0.8 s) ≈ 20 min at the default timeout, ten times the 2-min
 * lease. Rather than claim that whole worst case up front (a crashed request would then lock Retry
 * out for 20 min), the holder REFRESHES the claim before every bundle to one bundle's worst case plus
 * the ordinary lease as margin for the DB writes around it. The claim therefore outlives the loop
 * however long the list is, and a crash locks the step for at most ~3 min.
 */
export function licenceBundlesLeaseMs(): number {
  return bundleEnsureWorstCaseMs() + PROVISIONING_LEASE_MS;
}

/**
 * The `licence_bundles` claim a create is BORN with (it is written in the tenant row's own INSERT, so
 * no Retry can slip in between the row appearing and the bundles running). It must cover the steps
 * the create runs before the bundles — licence, billing terms, IR licence, each bounded by one
 * PROVISIONING_LEASE_MS — plus the first bundle; from there the per-bundle refresh takes over.
 */
export function createLicenceBundlesLeaseMs(): number {
  return 3 * PROVISIONING_LEASE_MS + licenceBundlesLeaseMs();
}
/** Steps the tick retries on its own. The others are retried from the workspace page.
 *  `licence`: a create or Retry that met the per-tenant licence lease (`licence_busy`) stored NO
 *  token and records `pending` — the tick must come back for it, or it reads "waiting" forever. */
export const RECONCILED_STEPS: readonly ProvisioningStep[] = [
  'billing_terms',
  'licence',
  // ⛔ ORDER IS LOAD-BEARING: `member_licence` before `invite_email`. A licence that lands in this
  // tick makes the email due NOW (`runMemberLicence`), and the sweep reaches `invite_email` after it,
  // so the email goes out in the same tick instead of five minutes later.
  'member_licence',
  'invite_email',
];

export const PROVISIONING_RETRY_COUNTER = 'tenant_provisioning_step_retry_total';
export const PROVISIONING_GAVE_UP_COUNTER = 'tenant_provisioning_step_gave_up_total';

let sleep = (ms: number): Promise<void> => Bun.sleep(ms);
/** Make the quick-retry sleep instant in tests (paired with `(undefined)` teardown). */
export function __setProvisioningSleepForTests(fake: ((ms: number) => Promise<void>) | undefined): void {
  sleep = fake ?? ((ms: number) => Bun.sleep(ms));
}

export function backoffMs(attempts: number): number {
  return Math.min(PROVISIONING_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), PROVISIONING_BACKOFF_CAP_MS);
}

// ---- the record ---------------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

export function stepRecord(status: StepStatus, patch: Partial<StepRecord> = {}): StepRecord {
  return {
    status,
    code: null,
    message: null,
    attempts: status === 'skipped' ? 0 : 1,
    lastAttemptAt: status === 'skipped' ? null : nowIso(),
    nextAttemptAt: null,
    ...patch,
  };
}

/** The record a create starts with, written in the SAME insert as the tenant row. A step still to
 *  run is `pending` with its `nextAttemptAt` a lease away, so the tick leaves it to the create that
 *  is running it — and picks it up if that create dies mid-flight. */
export function initialProvisioningRecord(input: {
  central: boolean;
  terms?: TenantTerms;
  needsIr: boolean;
  firstAdmin?: FirstAdminInput;
  /** Licences bundles were requested at create (0104) — their keys live in `tenants.licence_bundles`. */
  bundles?: boolean;
}): ProvisioningRecord {
  const later = new Date(Date.now() + PROVISIONING_LEASE_MS).toISOString();
  const pending = (): StepRecord => stepRecord('pending', { attempts: 0, lastAttemptAt: null, nextAttemptAt: later });
  return {
    steps: {
      licences_tenant: input.central ? stepRecord('ok') : stepRecord('skipped', { code: 'licences_not_configured' }),
      licence: pending(),
      billing_terms: input.terms ? pending() : stepRecord('skipped', { code: 'no_terms_given' }),
      ir_licence: input.needsIr ? pending() : stepRecord('skipped', { code: 'plan_needs_none' }),
      licence_bundles: input.bundles
        ? { ...pending(), leaseUntil: new Date(Date.now() + createLicenceBundlesLeaseMs()).toISOString() }
        : stepRecord('skipped', { code: 'no_bundles_requested' }),
      first_invite: input.firstAdmin ? pending() : stepRecord('skipped', { code: 'no_first_admin_given' }),
    },
    ...(input.terms ? { terms: input.terms } : {}),
    ...(input.firstAdmin ? { firstAdmin: input.firstAdmin } : {}),
  };
}

/** The code a read presents for an orphaned `pending` step (see `isInterrupted`). */
export const INTERRUPTED_CODE = 'interrupted';

/**
 * ⛔ AN ORPHANED `pending` STEP THAT NOTHING WILL EVER RUN. The create writes every outstanding step
 * `pending` (with `nextAttemptAt` one lease away) and then runs them in order. If the create dies
 * mid-flight (pod killed, OOM, deploy), a step the tick does NOT own (`licence`, `ir_licence`,
 * `first_invite` — everything outside RECONCILED_STEPS) stays `pending` forever, reading "Waiting to
 * retry" with no automatic retry coming. Once its claim has lapsed (no live `leaseUntil`, and the
 * create's own window — `nextAttemptAt` — is past) nobody is running it, so a READ presents it as
 * `failed` / `interrupted` and the Retry button tells the truth. Computed at read time, not written:
 * the stored record is left alone, so a create that is merely slow is never relabelled in storage.
 */
export function isInterrupted(step: ProvisioningStep, st: StepRecord, now: number = Date.now()): boolean {
  if (st.status !== 'pending' || RECONCILED_STEPS.includes(step)) return false;
  const until = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);
  return Math.max(until(st.leaseUntil), until(st.nextAttemptAt)) < now;
}

export function toView(
  rec: ProvisioningRecord | Record<string, never> | null | undefined,
  now: number = Date.now(),
): ProvisioningView {
  const r = (rec ?? {}) as Partial<ProvisioningRecord>;
  const steps: ProvisioningView['steps'] = {};
  for (const s of PROVISIONING_STEPS) {
    const st = r.steps?.[s];
    if (!st) continue;
    const { leaseUntil: _lease, ...rest } = st;
    steps[s] = isInterrupted(s, st, now)
      ? {
          ...rest,
          status: 'failed',
          code: INTERRUPTED_CODE,
          message: 'Workspace creation stopped before this step finished; retry it.',
          nextAttemptAt: null,
        }
      : rest;
  }
  return {
    recorded: Object.keys(steps).length > 0,
    steps,
    termsHeld: Boolean(r.terms),
    firstAdminHeld: Boolean(r.firstAdmin),
  };
}

export async function readProvisioning(tenantId: string): Promise<ProvisioningRecord | null> {
  const [row] = await db
    .select({ p: tenants.provisioning })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row ? ((row.p ?? {}) as ProvisioningRecord) : null;
}

/** `provisioning` with a guaranteed `steps` object, as SQL. */
const withSteps = sql`(coalesce(${tenants.provisioning}, '{}'::jsonb) || jsonb_build_object('steps', coalesce(${tenants.provisioning}->'steps', '{}'::jsonb)))`;

/**
 * Write one step's record (which also RELEASES its claim — the record has no `leaseUntil`). `drop`
 * removes a held input once its step has landed.
 */
export async function writeStep(
  tenantId: string,
  step: ProvisioningStep,
  rec: StepRecord,
  drop: Array<'terms' | 'firstAdmin' | 'signupAdmin'> = [],
): Promise<void> {
  const { leaseUntil: _l, ...clean } = rec;
  let expr = sql`jsonb_set(${withSteps}, ARRAY['steps', ${step}::text], ${JSON.stringify(clean)}::jsonb, true)`;
  for (const key of drop) expr = sql`(${expr} - ${key}::text)`;
  await db.update(tenants).set({ provisioning: expr }).where(eq(tenants.id, tenantId));
}

/**
 * Claim (tenant, step) for `leaseMs`. Returns the record as it stood at the claim, or `null` when
 * somebody else holds a live claim on that step. One statement: two claimers cannot both win.
 */
export async function claimStep(
  tenantId: string,
  step: ProvisioningStep,
  leaseMs = PROVISIONING_LEASE_MS,
): Promise<ProvisioningRecord | null> {
  const rows = await db
    .update(tenants)
    .set({
      provisioning: sql`jsonb_set(${withSteps}, ARRAY['steps', ${step}::text],
        coalesce(${tenants.provisioning} #> ARRAY['steps', ${step}::text], '{}'::jsonb)
          || jsonb_build_object('leaseUntil', to_jsonb(now() + make_interval(secs => ${leaseMs / 1000}))), true)`,
    })
    .where(
      sql`${tenants.id} = ${tenantId}
        and coalesce((${tenants.provisioning} #>> ARRAY['steps', ${step}::text, 'leaseUntil'])::timestamptz, '-infinity'::timestamptz) < now()`,
    )
    .returning({ p: tenants.provisioning });
  return rows[0] ? (rows[0].p as ProvisioningRecord) : null;
}

// ---- billing classification ---------------------------------------------------------------------

export type BillingFailureKind = 'unregistered' | 'transient' | 'refused';

/**
 * What a billing failure means for the saga.
 *   • `unregistered` — billing's 422 `…unregistered_tenant`: it has not learnt this tenant from
 *     licences yet (it polls). Will clear by itself.
 *   • `transient`    — 5xx, a transport error, a token failure, 408/429: will likely clear.
 *   • `refused`      — any other 4xx: billing understood and said no. Retrying sends the same no.
 */
export function classifyBillingFailure(err: unknown): BillingFailureKind {
  const details = err instanceof HttpError ? err.details : undefined;
  const status = typeof details?.upstreamStatus === 'number' ? details.upstreamStatus : undefined;
  const detail = typeof details?.upstreamDetail === 'string' ? details.upstreamDetail : '';
  if (status === 422 && /unregistered_tenant/.test(detail)) return 'unregistered';
  if (status === undefined || status >= 500 || status === 408 || status === 429) return 'transient';
  return 'refused';
}

function errMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

function errCode(err: unknown, fallback: string): string {
  if (err instanceof HttpError) return err.code;
  // licences' ownership refusals (migration 050) keep their own codes on the step record, so the
  // workspace page names the real reason instead of a generic `licences_unavailable`.
  if (err instanceof LicencesNameConflictError) return 'licences_name_unavailable';
  if (err instanceof LicencesTenantOwnedByOtherAppError) return 'licences_tenant_owned_by_other_app';
  if (err instanceof LicencesAccessRefusedError) return 'licences_access_refused';
  return fallback;
}

// ---- the steps ----------------------------------------------------------------------------------

export interface StepRunContext {
  /** Who is running it: the create, a super_admin's Retry, or the tick. */
  source: 'create' | 'retry' | 'reconciler';
  /** For the steps that need an actor (the licence's provenance subject, the invite's inviter). */
  actorId?: string | null;
  reqId?: string;
}

export interface StepRunResult {
  record: StepRecord;
  /** The invite the `first_invite` step created or renewed. */
  invite?: CreatedInvite;
  /** What billing did with the terms, when the `billing_terms` step reached it. */
  termsOutcome?: TermsWriteOutcome['status'];
  /** Per-bundle results, when the `licence_bundles` step ran. */
  bundles?: BundleResult[];
}

/** Next record for a failure: bounded backoff for a step the tick owns, else no next attempt. */
function failureRecord(
  step: ProvisioningStep,
  status: 'pending' | 'failed',
  prev: StepRecord | undefined,
  code: string,
  message: string,
): StepRecord {
  const attempts = (prev?.attempts ?? 0) + 1;
  const reconciled = RECONCILED_STEPS.includes(step);
  const gaveUp = reconciled && attempts >= PROVISIONING_MAX_ATTEMPTS;
  if (gaveUp) incCounter(PROVISIONING_GAVE_UP_COUNTER);
  return {
    // A transient failure the tick has stopped retrying is no longer "will retry automatically".
    status: gaveUp ? 'failed' : status,
    code,
    message,
    attempts,
    lastAttemptAt: nowIso(),
    nextAttemptAt:
      reconciled && !gaveUp ? new Date(Date.now() + backoffMs(attempts)).toISOString() : null,
  };
}

function okRecord(prev: StepRecord | undefined, status: 'ok' | 'skipped' = 'ok', code: string | null = null): StepRecord {
  return {
    status,
    code,
    message: null,
    attempts: (prev?.attempts ?? 0) + 1,
    lastAttemptAt: nowIso(),
    nextAttemptAt: null,
  };
}

async function runBillingTerms(
  tenantId: string,
  rec: ProvisioningRecord,
  ctx: StepRunContext,
): Promise<StepRunResult> {
  const prev = rec.steps?.billing_terms;
  const terms = rec.terms;
  if (!terms) {
    // Nothing to send. Not a success either when the step was outstanding — say so.
    if (prev && (prev.status === 'ok' || prev.status === 'skipped')) return { record: prev };
    const record = failureRecord('billing_terms', 'failed', prev, 'terms_not_held', 'No terms are held for this workspace; set them in its Terms section.');
    record.nextAttemptAt = null;
    await writeStep(tenantId, 'billing_terms', record);
    return { record };
  }
  // Only the create gets the quick in-request retries: the tick and the Retry button come back later
  // anyway, and a super_admin's request is not the place to wait out billing's registry poll.
  const attempts = ctx.source === 'create' ? BILLING_UNREGISTERED_QUICK_ATTEMPTS : 1;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const out = await writeTenantTerms(tenantId, terms);
      const record =
        out.status === 'skipped_unconfigured'
          ? okRecord(prev, 'skipped', 'billing_not_configured')
          : okRecord(prev);
      await writeStep(tenantId, 'billing_terms', record, ['terms']);
      return { record, termsOutcome: out.status };
    } catch (err) {
      lastErr = err;
      if (classifyBillingFailure(err) !== 'unregistered' || i === attempts) break;
      await sleep(BILLING_UNREGISTERED_QUICK_BACKOFF_MS);
    }
  }
  const kind = classifyBillingFailure(lastErr);
  const record =
    kind === 'refused'
      ? failureRecord('billing_terms', 'failed', prev, 'billing_refused', errMessage(lastErr))
      : failureRecord(
          'billing_terms',
          'pending',
          prev,
          kind === 'unregistered' ? 'billing_tenant_not_registered' : 'billing_unavailable',
          errMessage(lastErr),
        );
  log.warn('tenant_provisioning_billing_terms_failed', {
    tenantId,
    source: ctx.source,
    kind,
    status: record.status,
    attempts: record.attempts,
    reqId: ctx.reqId,
    err: lastErr,
  });
  await writeStep(tenantId, 'billing_terms', record);
  return { record };
}

async function runIrLicence(tenantId: string, rec: ProvisioningRecord, ctx: StepRunContext): Promise<StepRunResult> {
  const prev = rec.steps?.ir_licence;
  try {
    const out = await ensureTenantInference(tenantId);
    const record =
      out.status === 'skipped_unconfigured' ? okRecord(prev, 'skipped', 'inference_not_configured') : okRecord(prev);
    await writeStep(tenantId, 'ir_licence', record);
    return { record };
  } catch (err) {
    const record = failureRecord('ir_licence', 'failed', prev, errCode(err, 'inference_provision_failed'), errMessage(err));
    log.error('tenant_provisioning_ir_licence_failed', { tenantId, source: ctx.source, reqId: ctx.reqId, err });
    await writeStep(tenantId, 'ir_licence', record);
    return { record };
  }
}

async function runFirstInvite(tenantId: string, rec: ProvisioningRecord, ctx: StepRunContext): Promise<StepRunResult> {
  const prev = rec.steps?.first_invite;
  const who = rec.firstAdmin;
  if (!who) {
    if (prev && (prev.status === 'ok' || prev.status === 'skipped')) return { record: prev };
    const record = failureRecord('first_invite', 'failed', prev, 'first_admin_not_held', 'No first admin is held for this workspace; invite one from its members page.');
    await writeStep(tenantId, 'first_invite', record);
    return { record };
  }
  try {
    const invite = await createInvite({
      tenantId,
      email: who.email,
      firstName: who.firstName,
      lastName: who.lastName,
      role: 'tenant_admin',
      invitedBy: ctx.actorId ?? null,
      reqId: ctx.reqId,
    });
    const record = okRecord(prev);
    await writeStep(tenantId, 'first_invite', record, ['firstAdmin']);
    return { record, invite };
  } catch (err) {
    const record = failureRecord('first_invite', 'failed', prev, errCode(err, 'invite_failed'), errMessage(err));
    log.error('tenant_provisioning_first_invite_failed', {
      tenantId,
      source: ctx.source,
      reqId: ctx.reqId,
      code: record.code,
      err,
    });
    await writeStep(tenantId, 'first_invite', record);
    return { record };
  }
}

/** The provenance subject the tick passes to `ensureTenantLicense`. Logged only: the licence's HOLDER
 *  is always the tenant's synthetic `cp-tenant:<id>:a|b` subject, never this value. */
export const RECONCILER_LICENCE_PROVENANCE = 'system:provisioning-reconciler';

/**
 * The `licence` step's record after an `ensureTenantLicense` call that did not throw.
 *
 * ⛔ "DID NOT THROW" IS NOT "LICENSED". `ensureTenantLicense` returns WITHOUT a token when another
 * licence op holds the tenant's lease (`busy`), when a tenant-level (bundle) licence already admits
 * the tenant (`tenant_level`), and when issuance is off. Recording `ok` for those said "licence: ok"
 * on a workspace with no stored token, and nothing ever came back for it. So: `ok` only when a token
 * IS stored now; `skipped` for the two cases where CP rightly mints nothing; anything else is
 * `pending`, which the tick retries (`licence` is in RECONCILED_STEPS).
 */
export async function licenceStepAfter(
  tenantId: string,
  outcome: EnsureTenantLicenceOutcome,
  prev: StepRecord | undefined,
): Promise<StepRecord> {
  if (outcome === 'issuance_disabled') return okRecord(prev, 'skipped', 'licence_issuance_disabled');
  if (await tenantLicenceStored(tenantId)) return okRecord(prev);
  if (outcome === 'tenant_level') return okRecord(prev, 'skipped', 'tenant_level_licence');
  return outcome === 'busy'
    ? failureRecord('licence', 'pending', prev, 'licence_busy', 'Another licence operation held this workspace; the tick retries it.')
    : failureRecord('licence', 'pending', prev, 'licence_not_stored', `ensureTenantLicense returned '${outcome}' but no token is stored`);
}

async function runLicence(tenantId: string, rec: ProvisioningRecord, ctx: StepRunContext): Promise<StepRunResult> {
  const prev = rec.steps?.licence;
  try {
    const subject = ctx.actorId ?? (ctx.source === 'reconciler' ? RECONCILER_LICENCE_PROVENANCE : null);
    if (!subject) throw new HttpError(500, 'licence_actor_required', 'A licence retry needs an actor');
    const outcome = await ensureTenantLicense(tenantId, subject);
    const record = await licenceStepAfter(tenantId, outcome, prev);
    await writeStep(tenantId, 'licence', record);
    return { record };
  } catch (err) {
    const record = failureRecord('licence', 'failed', prev, errCode(err, 'licences_unavailable'), errMessage(err));
    await writeStep(tenantId, 'licence', record);
    return { record };
  }
}

async function runLicencesTenant(tenantId: string, rec: ProvisioningRecord): Promise<StepRunResult> {
  const prev = rec.steps?.licences_tenant;
  if (!licencesAdminConfigured()) {
    const record = okRecord(prev, 'skipped', 'licences_not_configured');
    await writeStep(tenantId, 'licences_tenant', record);
    return { record };
  }
  try {
    const [t] = await db
      .select({ slug: tenants.slug, licencesName: tenants.licences_name })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    await licensesAdmin().ensureTenantRegistered(tenantId, t?.licencesName ?? t?.slug ?? tenantId);
    const record = okRecord(prev);
    await writeStep(tenantId, 'licences_tenant', record);
    return { record };
  } catch (err) {
    const record = failureRecord('licences_tenant', 'failed', prev, errCode(err, 'licences_unavailable'), errMessage(err));
    await writeStep(tenantId, 'licences_tenant', record);
    return { record };
  }
}

/**
 * The `licence_bundles` step (0104): (re-)ensure `bundles` — default EVERY bundle the tenant has —
 * and record the summary over all of them. A failure is `failed` (the tick does not own this step;
 * Retry and `POST /api/tenants/:id/licence-bundles` re-run it). See services/tenant-licence-bundles.ts
 * for why a failed bundle never voids the tenant and why a 4xx is never retried.
 */
async function runLicenceBundles(
  tenantId: string,
  rec: ProvisioningRecord,
  bundles?: string[],
): Promise<StepRunResult> {
  const prev = rec.steps?.licence_bundles;
  const stored = (await readLicenceBundles(tenantId)) ?? {};
  const keys = bundles ?? Object.keys(stored).sort();
  // Refresh the claim before every bundle (see licenceBundlesLeaseMs): the caller holds it.
  const results =
    keys.length > 0
      ? await ensureTenantBundles(tenantId, keys, () => extendClaim(tenantId, 'licence_bundles', licenceBundlesLeaseMs()))
      : [];
  const all: LicenceBundlesRecord = { ...stored };
  for (const r of results) {
    const { bundle, ...record } = r;
    all[bundle] = record;
  }
  const sum = summariseBundles(all);
  const record =
    sum.status === 'failed'
      ? failureRecord('licence_bundles', 'failed', prev, sum.code ?? 'licence_bundles_failed', sum.message ?? '')
      : okRecord(prev, sum.status, sum.code);
  await writeStep(tenantId, 'licence_bundles', record);
  return { record, bundles: results };
}

/**
 * `POST /api/tenants/:id/licence-bundles` — add `bundles` to what the tenant holds and ensure THEM
 * now, under the `licence_bundles` step claim. Idempotent: licences answers `exists` for an app it
 * already licensed, and a bundle already recorded is simply re-ensured. 404 `tenant_not_found`,
 * 409 `tenant_offboarded` / `provisioning_step_busy`.
 */
export async function ensureLicenceBundlesNow(tenantId: string, bundles: string[]): Promise<StepRunResult> {
  const [t] = await db
    .select({ id: tenants.id, offboardedAt: tenants.offboarded_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!t) throw notFound('tenant_not_found', `No tenant '${tenantId}'`);
  if (t.offboardedAt) throw conflict('tenant_offboarded', 'This workspace has been offboarded; it is read-only.');
  const rec = await claimStep(tenantId, 'licence_bundles');
  if (!rec) {
    throw conflict('provisioning_step_busy', "Step 'licence_bundles' is being run right now; try again in a minute.");
  }
  try {
    const stored = (await readLicenceBundles(tenantId)) ?? {};
    const added: LicenceBundlesRecord = {};
    for (const b of bundles) if (!stored[b]) added[b] = requestedBundleRecord();
    if (Object.keys(added).length > 0) await writeLicenceBundles(tenantId, added);
    return await runLicenceBundles(tenantId, rec, bundles);
  } catch (err) {
    await releaseClaim(tenantId, 'licence_bundles').catch(() => {});
    throw err;
  }
}

// ---- the early-access requester's steps (member_seat → member_licence → invite_email) ----------

/**
 * Record a requester seated at approve (`createInvite({seatIfMinted})` → `seatedSub`): `member_seat`
 * ok, `member_licence` and `invite_email` pending one lease away (the approve request runs them now;
 * if it dies, the tick picks them up), and the held input both need. One UPDATE.
 */
export async function recordSignupAdminSeated(tenantId: string, who: SignupAdminInput): Promise<void> {
  const later = new Date(Date.now() + PROVISIONING_LEASE_MS).toISOString();
  const pending = (): StepRecord => stepRecord('pending', { attempts: 0, lastAttemptAt: null, nextAttemptAt: later });
  const steps = { member_seat: stepRecord('ok'), member_licence: pending(), invite_email: pending() };
  await db
    .update(tenants)
    .set({
      provisioning: sql`(${withSteps} || jsonb_build_object('signupAdmin', ${JSON.stringify(who)}::jsonb))
        || jsonb_build_object('steps', (${withSteps})->'steps' || ${JSON.stringify(steps)}::jsonb)`,
    })
    .where(eq(tenants.id, tenantId));
}

/**
 * The live workspace signup approval `approvalId` founded (createTenant's `signupApprovalId`, written
 * in the tenant row's own INSERT), or null. Platform-level `tenants` (no RLS).
 *
 * `includeOffboarded`: also a workspace that has since been offboarded — the reject's cleanup
 * (services/signup-reject-repair.ts `repairRejectedSignup`) needs it, because `offboarded_at` commits BEFORE the
 * fatal licence revoke, so a reject whose revoke failed leaves exactly such a workspace behind.
 */
export async function tenantFoundedByApproval(
  approvalId: string,
  opts: { includeOffboarded?: boolean } = {},
): Promise<string | null> {
  const live = opts.includeOffboarded ? sql`` : sql` and ${tenants.offboarded_at} is null`;
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(sql`${tenants.provisioning}->>'signupApprovalId' = ${approvalId}${live}`)
    // NEWEST founding first: with `includeOffboarded`, an earlier workspace of the same approval
    // (founded, then offboarded, then a later approve founded another) must never be the one a
    // reject repairs — the newest is the one the rejected decision left behind.
    .orderBy(desc(tenants.created_at), desc(tenants.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The approve request's own run of `member_licence` then `invite_email` — each UNDER ITS CLAIM, so
 * the onboarding-integrity tick (which `runMemberLicence` wakes for the email the moment the licence
 * lands) can never run the same step at the same time: exactly one of them sends the email. A step
 * already landed is not re-run (no second email); a step somebody else holds is left to them.
 * Returns whether the email has been sent.
 */
export async function runSignupAdminSteps(
  tenantId: string,
  ctx: StepRunContext,
  opts: {
    /**
     * The approve's claim check (routes/onboarding.ts `HeldApprovalClaim.assertHeld`), awaited before
     * each step it would run and BEFORE that step's claim is taken: a throw stops here, leaving the
     * step as recorded (`pending`) for the next approve or the tick.
     */
    beforeStep?: (step: 'member_licence' | 'invite_email') => Promise<void>;
  } = {},
): Promise<{ emailSent: boolean }> {
  for (const step of ['member_licence', 'invite_email'] as const) {
    const now = await readProvisioning(tenantId);
    if (!now?.signupAdmin || landed(now.steps?.[step])) continue;
    await opts.beforeStep?.(step);
    const rec = await claimStep(tenantId, step);
    if (!rec) continue; // the tick (or a Retry) is running it right now
    try {
      await runStep(tenantId, step, rec, ctx);
    } catch (err) {
      await releaseClaim(tenantId, step).catch(() => {});
      throw err;
    }
  }
  const after = await readProvisioning(tenantId);
  return { emailSent: after?.steps?.invite_email?.status === 'ok' };
}

/** The record as stored now (a step that follows another must see that one's fresh outcome). */
async function freshRecord(tenantId: string, fallback: ProvisioningRecord): Promise<ProvisioningRecord> {
  return (await readProvisioning(tenantId)) ?? fallback;
}

/** Done = `ok` or `skipped`. */
function landed(st: StepRecord | undefined): boolean {
  return st?.status === 'ok' || st?.status === 'skipped';
}

async function signupAdminNotHeld(
  tenantId: string,
  step: 'member_seat' | 'member_licence' | 'invite_email',
  prev: StepRecord | undefined,
): Promise<StepRunResult> {
  if (prev && landed(prev)) return { record: prev };
  const record = failureRecord(step, 'failed', prev, 'signup_admin_not_held', 'No early-access requester is held for this workspace; invite them from its members page.');
  record.nextAttemptAt = null;
  await writeStep(tenantId, step, record);
  return { record };
}

/** `member_seat` (Retry only — the approve seats in its own transaction): re-seat, idempotently. */
async function runMemberSeat(tenantId: string, rec: ProvisioningRecord): Promise<StepRunResult> {
  const prev = rec.steps?.member_seat;
  const who = rec.signupAdmin;
  if (!who) return signupAdminNotHeld(tenantId, 'member_seat', prev);
  try {
    await claimSeat(tenantId, { existingEmail: who.email }, (tx) =>
      upsertLocalUserTx(tx, who.sub, who.email, who.name, tenantId, who.role, { onlyIfHomelessOrIn: tenantId }),
    );
    const record = okRecord(prev);
    await writeStep(tenantId, 'member_seat', record);
    return { record };
  } catch (err) {
    const record = failureRecord('member_seat', 'failed', prev, errCode(err, 'member_seat_failed'), errMessage(err));
    await writeStep(tenantId, 'member_seat', record);
    return { record };
  }
}

/**
 * `member_licence`: the tenant licence (idempotent) and the requester's own member entitlement.
 * `ok` only for an ACTIVE entitlement; `skipped` when CP rightly mints none (issuance off, or a
 * tenant-level licence admits the tenant); anything else is `pending` and the tick comes back. On
 * landing, `invite_email` is made due now — the email was waiting for exactly this.
 */
async function runMemberLicence(tenantId: string, rec: ProvisioningRecord, ctx: StepRunContext): Promise<StepRunResult> {
  const prev = rec.steps?.member_licence;
  const who = rec.signupAdmin;
  if (!who) return signupAdminNotHeld(tenantId, 'member_licence', prev);
  // ⛔ No licence for a signup nobody has approved (see `signupDecisionGate`).
  const gate = await signupDecisionGate(rec);
  if (gate === 'defer') return deferForDecision(tenantId, 'member_licence', prev);
  if (gate === 'rejected') return refuseRejectedSignup(tenantId, 'member_licence', prev);
  let record: StepRecord;
  let minted = false;
  try {
    await ensureTenantLicense(tenantId, who.sub);
    const out = await ensureMemberEntitlement(tenantId, who.sub, who.sub);
    minted = out.state === 'active';
    record =
      out.state === 'active'
        ? okRecord(prev)
        : out.state === 'tenant_licensed'
          ? okRecord(prev, 'skipped', 'tenant_level_licence')
          : out.state === 'disabled'
            ? okRecord(prev, 'skipped', 'licence_issuance_disabled')
            : failureRecord(
                'member_licence',
                'pending',
                prev,
                out.reason === 'revoking' ? 'member_licence_revoking' : 'member_licence_busy',
                `The member licence is ${out.reason}; the tick retries it.`,
              );
  } catch (err) {
    record = failureRecord('member_licence', 'pending', prev, errCode(err, 'licences_unavailable'), errMessage(err));
    log.warn('tenant_provisioning_member_licence_failed', {
      tenantId,
      source: ctx.source,
      reqId: ctx.reqId,
      status: record.status,
      attempts: record.attempts,
      err,
    });
  }
  // ⛔ A reject can land WHILE the mint is in flight (the approve's claim lapsed under a slow
  // licences call). Its offboard revokes the seats it can see; a mint that landed after that is
  // revoked here, and the step is refused for good either way — a rejected signup never keeps a
  // live licence nor a step that reads "the tick retries it".
  if ((await signupDecisionGate(rec)) === 'rejected') {
    if (minted) await revokeMemberEntitlement(tenantId, who.sub);
    return refuseRejectedSignup(tenantId, 'member_licence', prev);
  }
  await writeStep(tenantId, 'member_licence', record);
  if (landed(record)) {
    // Wake the waiting email (no-op when it already landed or is being run).
    await db
      .update(tenants)
      .set({
        provisioning: sql`jsonb_set(${tenants.provisioning}, ARRAY['steps', 'invite_email', 'nextAttemptAt'], to_jsonb(now()), true)`,
      })
      .where(
        sql`${tenants.id} = ${tenantId}
          and (${tenants.provisioning} #>> ARRAY['steps', 'invite_email', 'status']) in ('pending', 'failed')`,
      );
  }
  return { record };
}

/**
 * `invite_email`: the set-password email (services/signup-email.ts) — ONLY once `member_licence` has
 * landed, so the link lands in a licensed app. While the licence is outstanding the step waits
 * (`pending` / `waiting_for_member_licence`, following the licence's own retry time; no attempt is
 * counted). Sent → `ok`, and the held requester (PII) is dropped.
 */
async function runInviteEmail(tenantId: string, rec: ProvisioningRecord, ctx: StepRunContext): Promise<StepRunResult> {
  const fresh = await freshRecord(tenantId, rec);
  const prev = fresh.steps?.invite_email;
  const who = fresh.signupAdmin;
  if (!who) return signupAdminNotHeld(tenantId, 'invite_email', prev);
  // ⛔ Never email the requester of a signup nobody has approved (see `signupDecisionGate`): an
  // approve that aborted after the seat leaves the row pending — the tick waits; a rejected signup
  // is refused for good.
  const gate = await signupDecisionGate(fresh);
  if (gate === 'defer') return deferForDecision(tenantId, 'invite_email', prev);
  if (gate === 'rejected') return refuseRejectedSignup(tenantId, 'invite_email', prev);
  const lic = fresh.steps?.member_licence;
  if (!landed(lic)) {
    const record: StepRecord = {
      status: lic?.nextAttemptAt ? 'pending' : 'failed',
      code: lic?.nextAttemptAt ? 'waiting_for_member_licence' : 'member_licence_not_ready',
      message: 'The set-password email is sent once the member licence exists.',
      attempts: prev?.attempts ?? 0,
      lastAttemptAt: prev?.lastAttemptAt ?? null,
      // Follow the licence: due again when it is (and woken at once when it lands).
      nextAttemptAt: lic?.nextAttemptAt ?? null,
    };
    await writeStep(tenantId, 'invite_email', record);
    return { record };
  }
  try {
    await sendSignupSetupEmail({
      tenantId,
      inviteId: who.inviteId,
      sub: who.sub,
      email: who.email,
      locale: who.locale,
    });
    const record = okRecord(prev);
    await writeStep(tenantId, 'invite_email', record, ['signupAdmin']);
    return { record };
  } catch (err) {
    const record = failureRecord('invite_email', 'pending', prev, errCode(err, 'invite_email_failed'), errMessage(err));
    log.warn('tenant_provisioning_invite_email_failed', {
      tenantId,
      source: ctx.source,
      reqId: ctx.reqId,
      status: record.status,
      attempts: record.attempts,
      err,
    });
    await writeStep(tenantId, 'invite_email', record);
    return { record };
  }
}

/**
 * ⛔ THE DECISION GATE for `member_licence` and `invite_email`. Both act on the requester of a SIGNUP
 * (`signupApprovalId`), and both are irreversible-ish (a billable licence; an email that hands the
 * requester a working account) — so neither may run for a signup nobody has approved:
 *   • `go`       — the founding approval is `approved`, or `pending` UNDER A LIVE APPROVE CLAIM
 *                  (`approving_until > now()`: an approve run is inside `runSignupAdminSteps`,
 *                  having just re-confirmed that claim). A workspace no approval founded → `go`.
 *   • `defer`    — `pending` with no live claim: an approve that ABORTED after the seat
 *                  (`approval_claim_lost`) leaves exactly this. Nobody has decided yet, so the tick
 *                  must not decide for them: the step stays `pending`, no attempt is counted, and
 *                  the next approve (which resumes into this workspace) runs it. Also an approval row
 *                  that cannot be found — fail SAFE.
 *   • `rejected` — permanent: no licence, no email, no retry (routes/onboarding.ts reject then
 *                  offboards the workspace).
 */
export type SignupDecisionGate = 'go' | 'defer' | 'rejected';

export async function signupDecisionGate(rec: Pick<ProvisioningRecord, 'signupApprovalId'>): Promise<SignupDecisionGate> {
  if (!rec.signupApprovalId) return 'go';
  const [row] = await db
    .select({
      status: signupApprovals.status,
      claimLive: sql<boolean>`coalesce(${signupApprovals.approving_until} > now(), false)`,
    })
    .from(signupApprovals)
    .where(eq(signupApprovals.id, rec.signupApprovalId))
    .limit(1);
  if (!row) return 'defer';
  if (row.status === 'approved') return 'go';
  if (row.status === 'rejected') return 'rejected';
  return row.status === 'pending' && row.claimLive ? 'go' : 'defer';
}

/** How long a deferred step waits before the tick looks at its approval again. */
export const SIGNUP_DECISION_RECHECK_MS = 5 * 60_000;

/** `defer`: unchanged attempts, still `pending`, due again later — the tick does not spin on it. */
async function deferForDecision(
  tenantId: string,
  step: 'member_licence' | 'invite_email',
  prev: StepRecord | undefined,
): Promise<StepRunResult> {
  const record: StepRecord = {
    status: 'pending',
    code: 'waiting_for_approval',
    message: 'The signup that founded this workspace is not approved yet; this step runs once it is.',
    attempts: prev?.attempts ?? 0,
    lastAttemptAt: prev?.lastAttemptAt ?? null,
    nextAttemptAt: new Date(Date.now() + SIGNUP_DECISION_RECHECK_MS).toISOString(),
  };
  await writeStep(tenantId, step, record);
  return { record };
}

/** `rejected`: permanent failure — no attempt counted, no retry (`nextAttemptAt: null`). */
async function refuseRejectedSignup(
  tenantId: string,
  step: 'member_licence' | 'invite_email',
  prev: StepRecord | undefined,
): Promise<StepRunResult> {
  const record: StepRecord = {
    status: 'failed',
    code: 'signup_rejected',
    message:
      step === 'invite_email'
        ? 'The signup that founded this workspace was rejected; the set-password email is not sent.'
        : 'The signup that founded this workspace was rejected; no member licence is issued.',
    attempts: prev?.attempts ?? 0,
    lastAttemptAt: prev?.lastAttemptAt ?? null,
    nextAttemptAt: null,
  };
  await writeStep(tenantId, step, record);
  return { record };
}

/** Run one step against `rec` (the caller holds the claim, or is the create that owns the row). */
export async function runStep(
  tenantId: string,
  step: ProvisioningStep,
  rec: ProvisioningRecord,
  ctx: StepRunContext,
): Promise<StepRunResult> {
  switch (step) {
    case 'billing_terms':
      return runBillingTerms(tenantId, rec, ctx);
    case 'ir_licence':
      return runIrLicence(tenantId, rec, ctx);
    case 'first_invite':
      return runFirstInvite(tenantId, rec, ctx);
    case 'licence':
      return runLicence(tenantId, rec, ctx);
    case 'licences_tenant':
      return runLicencesTenant(tenantId, rec);
    case 'licence_bundles':
      return runLicenceBundles(tenantId, rec);
    case 'member_seat':
      return runMemberSeat(tenantId, rec);
    case 'member_licence':
      return runMemberLicence(tenantId, rec, ctx);
    case 'invite_email':
      return runInviteEmail(tenantId, rec, ctx);
  }
}

/**
 * `POST /api/tenants/:id/provisioning/:step/retry` — re-run one step NOW, under its claim. An `ok`
 * step is re-run too (every action is idempotent), so a super_admin who doubts a green tick can
 * check it. 409 `provisioning_step_busy` while another caller holds the claim.
 */
export async function retryProvisioningStep(
  tenantId: string,
  step: ProvisioningStep,
  ctx: Omit<StepRunContext, 'source'>,
): Promise<StepRunResult> {
  const [t] = await db
    .select({ id: tenants.id, offboardedAt: tenants.offboarded_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!t) throw notFound('tenant_not_found', `No tenant '${tenantId}'`);
  if (t.offboardedAt) throw conflict('tenant_offboarded', 'This workspace has been offboarded; it is read-only.');
  const rec = await claimStep(tenantId, step);
  if (!rec) {
    throw conflict('provisioning_step_busy', `Step '${step}' is being run right now; try again in a minute.`);
  }
  incCounter(PROVISIONING_RETRY_COUNTER);
  try {
    return await runStep(tenantId, step, rec, { ...ctx, source: 'retry' });
  } catch (err) {
    // A step function writes its own record; reaching here means the WRITE failed. Release the
    // claim so the next attempt is not refused for two minutes, and surface the error.
    await releaseClaim(tenantId, step).catch(() => {});
    throw err;
  }
}

/**
 * Terms set by the EDIT form (PATCH /api/tenants/:id) supersede the ones held since create. Without
 * this the tick would later re-send the OLD held terms over the new ones. Runs `write` under the
 * step's claim (409 `provisioning_step_busy` if the tick is mid-retry), then records the step `ok`
 * and drops the held terms; a failed write releases the claim and leaves the record alone.
 */
export async function writeTermsFromEdit<T>(tenantId: string, write: () => Promise<T>): Promise<T> {
  const rec = await claimStep(tenantId, 'billing_terms');
  if (!rec) {
    throw conflict('provisioning_step_busy', 'The billing terms are being retried right now; try again in a minute.');
  }
  let out: T;
  try {
    out = await write();
  } catch (err) {
    await releaseClaim(tenantId, 'billing_terms').catch(() => {});
    throw err;
  }
  await writeStep(tenantId, 'billing_terms', okRecord(rec.steps?.billing_terms), ['terms']);
  return out;
}

/** Push the claim the caller HOLDS on (tenant, step) to `leaseMs` from now. Unconditional — only the
 *  holder calls it, and always while its own claim is still live: the previous window was sized to
 *  cover the work done since the previous refresh (one bundle, or the create's earlier steps). */
export async function extendClaim(tenantId: string, step: ProvisioningStep, leaseMs: number): Promise<void> {
  await db
    .update(tenants)
    .set({
      provisioning: sql`jsonb_set(${withSteps}, ARRAY['steps', ${step}::text, 'leaseUntil'],
        to_jsonb(now() + make_interval(secs => ${leaseMs / 1000})), true)`,
    })
    .where(sql`${tenants.id} = ${tenantId} and (${tenants.provisioning} #> ARRAY['steps', ${step}::text]) is not null`);
}

/** Drop the claim on (tenant, step). Harmless when there is none (writeStep already released it). */
export async function releaseClaim(tenantId: string, step: ProvisioningStep): Promise<void> {
  await db
    .update(tenants)
    .set({ provisioning: sql`${tenants.provisioning} #- ARRAY['steps', ${step}::text, 'leaseUntil']` })
    .where(eq(tenants.id, tenantId));
}

/**
 * The tick's sweep: every live tenant with a RECONCILED step that is pending/failed and due, each
 * claimed per (tenant, step) before it runs. Never throws; one tenant's failure is logged and the
 * sweep goes on.
 */
export async function reconcileProvisioning(): Promise<{ attempted: number; landed: number; failed: number; busy: number }> {
  const out = { attempted: 0, landed: 0, failed: 0, busy: 0 };
  for (const step of RECONCILED_STEPS) {
    const due = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(
        sql`${tenants.offboarded_at} is null
          and ${tenants.status} = 'active'
          and (${tenants.provisioning} #>> ARRAY['steps', ${step}::text, 'status']) in ('pending', 'failed')
          and (${tenants.provisioning} #>> ARRAY['steps', ${step}::text, 'nextAttemptAt']) is not null
          and (${tenants.provisioning} #>> ARRAY['steps', ${step}::text, 'nextAttemptAt'])::timestamptz <= now()`,
      );
    for (const { id } of due) {
      try {
        const rec = await claimStep(id, step);
        if (!rec) {
          out.busy++;
          continue;
        }
        out.attempted++;
        const { record } = await runStep(id, step, rec, { source: 'reconciler' });
        if (record.status === 'ok' || record.status === 'skipped') out.landed++;
        else out.failed++;
      } catch (err) {
        out.failed++;
        log.warn('tenant_provisioning_reconcile_failed', { component: 'onboarding-integrity', tenantId: id, step, err });
      }
    }
  }
  return out;
}
