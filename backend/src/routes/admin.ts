// src/routes/admin.ts — the Enterprise admin API (Phase 4 / C.1). Platform tenant
// lifecycle (super_admin), a tenant member ROSTER (read-only), MCP API-key
// issuance/revocation, and usage/spend aggregates. Tenancy is CP-owned: `users.tenant_id` +
// `users.tenant_role` (Keycloak only authenticates). Platform operations are super_admin-only;
// tenant-scoped operations go through `requireTenantAdmin` (home tenant + super_admin
// scope-switch). Member/role MUTATION lives in routes/tenant-users.ts (invites).
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import { db, runAsSystem, tenants, users, withTenantTransaction } from '../db/client';
import { tenantInvites } from '../db/schema';
import { resolveTenant } from '../middleware/tenant';
import {
  requireSuperAdmin,
  requireTenantAdmin,
} from '../middleware/admin-guards';
import {
  mintKey,
  listKeys,
  revokeKey,
  DEFAULT_SCOPES,
} from '../services/mcp-api-key';
import { getTenantUsage } from '../host/usage-metrics';
import {
  ensureTenantLicense,
  revokeTenantLicense,
  reissueTenantLicense,
  ensureMemberEntitlement,
  revokeMemberEntitlement,
  licenseSubjectFor,
  changeTenantLicence,
  isSystemTenant,
  type LicenceChangeResult,
} from '../services/license-provisioning';
import {
  licensesAdmin,
  adminMethod,
  licencesAdminConfigured,
  isTenantLicenceSubject,
} from '../services/licenses-admin';
import { assertPlanAssignable, licencesUnavailable, readTenantByoMode } from '../services/tenant-service';
import { licenseStatesForTenants } from '../lib/license-status';
import { BUNDLE_LIST, bundlesView, readLicenceBundles } from '../services/tenant-licence-bundles';
import {
  ensureLicenceBundlesNow,
  isProvisioningStep,
  readProvisioning,
  retryProvisioningStep,
  toView,
  writeTermsFromEdit,
} from '../services/tenant-provisioning';
import { tenantTermsSchema, readTenantTerms, writeTenantTerms } from '../services/tenant-terms';
import { ensureTenantInference, revokeTenantInference } from '../services/tenant-inference';
import { LOCAL_LLM_PLAN, NEW_TENANT_PLAN, planByoMode } from '../services/plan-posture';
import {
  billingAdmin,
  billingAdminConfigured,
  billingMethod,
  BillingTopupConflictError,
  BillingTopupForbiddenError,
  BillingTopupUnavailableError,
  type MoneyBudgetStatus,
  type PrepaidCredit,
} from '../services/billing-admin';
import { getSeatUsage, type SeatTx } from '../services/seat-limit';
import { assertOffboardConfirmed, loadOffboardTarget, offboardTenantFully } from '../services/offboarding';
import { recordAudit } from '../host/audit-service';
import { createTenant as createTenantService } from '../services/tenant-service';
import { currentRequestContext } from '../host/request-context';
import {
  jsonResponse,
  readJson,
  route,
  notFound,
  badRequest,
  conflict,
  unprocessable,
  HttpError,
} from '../utils/http';
import { log } from '../host/logger';
import type { Router } from '../utils/router';
import { MCP_SCOPE_VALUES } from '../ai/mcp/scopes';

const RANGE_DAYS = [7, 30, 90] as const;
// ⛔ DERIVED, never duplicated. This list feeds the zod enum on the mint route below, so a
// hardcoded copy here silently makes any scope added to scopes.ts UNMINTABLE — the enum
// rejects it, the mint 400s, and the enforcement shipped against it is dead on arrival.
// That is exactly what the literal ['tools','resources','prompts'] that used to be here did
// to `tools:read` / `tools:write`.
const SCOPE_VALUES = MCP_SCOPE_VALUES;

// ---- authz ----
//
// Platform operations (create/list-all/lifecycle of ANY tenant) are super_admin-only;
// tenant-scoped operations go through `requireTenantAdmin`, which authorizes a
// tenant_admin of their CP home tenant (users.tenant_id) and lets a super_admin scope-switch into
// any tenant (`X-Active-Tenant-Id`, audited).

// ---- tenants ----

/** A licences plan code (licences constrains codes no further; this keeps them URL/slug-safe). */
const PLAN_CODE = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
/** An ISO-8601 instant WITH an offset — licences 422s a naive one, so it is refused here first. */
const ISO_DATE = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

const createTenantSchema = z
  .object({
    name: z.string().min(1).max(120),
    // Optional: the tenant can be created empty and its first admin invited later.
    firstAdminEmail: z.string().trim().toLowerCase().email().max(320).optional(),
    // REQUIRED with `firstAdminEmail` (refine below): the portal realm requires both names, and an
    // identity created without them is stopped at Keycloak's VERIFY_PROFILE form on first sign-in.
    firstAdminFirstName: z.string().trim().min(1).max(80).optional(),
    firstAdminLastName: z.string().trim().min(1).max(80).optional(),
    // Stated centrally at create (licences per-app BYO posture). No default: an unset posture
    // fails closed (`byo_required`), so the super_admin chooses — unless the plan FIXES it
    // (`local-llm` → local_allowed, `byo` → byo_required; services/plan-posture.ts).
    byoMode: z.enum(['byo_required', 'local_allowed', 'platform_only']).optional(),
    // Billing terms: platform fee, seat fee (USD / month) and markup % (any may be 0).
    terms: tenantTermsSchema.optional(),
    // Seat cap (0044). Omitted / null = unlimited.
    maxMembers: z.number().int().positive().max(100_000).nullish(),
    industry: z.string().trim().min(1).max(120).nullish(),
    // Per-tenant licence terms (0095). Omitted planCode (and no byoMode) = `NEW_TENANT_PLAN`
    // (local-llm, services/plan-posture.ts) — NOT `LICENSE_PLAN_CODE`, which stays the fallback for
    // existing NULL rows and for a create that states a byoMode. Omitted/null dates = from mint /
    // perpetual.
    planCode: PLAN_CODE.optional(),
    startsAt: ISO_DATE.nullish(),
    expiresAt: ISO_DATE.nullish(),
    // Licences bundle keys CP ensures on the new tenant after its own licence (0104). Shape only
    // (kebab, unique, <= 20): licences decides which keys exist, so there is no list here.
    licenceBundles: BUNDLE_LIST.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (!b.firstAdminEmail) return;
    for (const key of ['firstAdminFirstName', 'firstAdminLastName'] as const) {
      if (!b[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required with firstAdminEmail` });
      }
    }
  });
const patchTenantSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    maxMembers: z.number().int().positive().max(100_000).nullish(),
    planCode: PLAN_CODE.optional(),
    // `null` CLEARS (start = from mint, expiry = perpetual); omitted = unchanged.
    startsAt: ISO_DATE.nullable().optional(),
    expiresAt: ISO_DATE.nullable().optional(),
    byoMode: z.enum(['byo_required', 'local_allowed', 'platform_only']).optional(),
    terms: tenantTermsSchema.optional(),
  })
  .strict();

/** GET /api/tenant — the caller's own tenant (from the claim). Available to ANY
 *  authenticated member (not just admins) — replaces the switcher's job of telling the
 *  UI which single tenant the session is in. */
const getCurrentTenant = route(async (req) => {
  const { tenantId } = await resolveTenant(req);
  const [t] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      industry: tenants.industry,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!t) throw notFound('tenant_not_found', 'Your tenant is not provisioned');
  return jsonResponse({ tenant: t });
});

// Safety bounds for the all-tenants query so it can never return an unbounded result set
// as the platform grows. The default page (500) comfortably exceeds any realistic live
// tenant count, so the current single-screen UI keeps showing every tenant; `total` lets a
// future paginated UI detect truncation. `?limit`/`?offset` allow explicit paging.
const TENANTS_DEFAULT_LIMIT = 500;
const TENANTS_MAX_LIMIT = 1000;

/** GET /api/admin/tenants — ALL tenants (platform / super_admin only), for the
 *  super-admin all-tenants screen. memberCount = users whose home tenant is this one.
 *  Bounded by `?limit` (default 500, max 1000) + `?offset`; returns `total` for paging. */
const listAllTenants = route(async (req) => {
  await requireSuperAdmin(req);
  const url = new URL(req.url);
  const limit = Math.min(
    TENANTS_MAX_LIMIT,
    Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '', 10) || TENANTS_DEFAULT_LIMIT),
  );
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '', 10) || 0);
  // `?id=<uuid>` narrows the list to ONE tenant, for the per-tenant edit page — the same row shape
  // (budget, licence state, member count) the list renders, so the two screens cannot disagree.
  // A malformed id matches NOTHING (an empty page), never the unfiltered list — the caller asked
  // about one tenant — and never a uuid cast error from Postgres.
  const idParam = url.searchParams.get('id');
  const idFilter =
    idParam === null
      ? undefined
      : z.guid().safeParse(idParam).success
        ? eq(tenants.id, idParam)
        : sql`false`;
  const totalRows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(tenants)
    .where(idFilter);
  const total = totalRows[0]?.total ?? 0;
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      createdAt: tenants.created_at,
      // When this workspace was OFFBOARDED (0075), or null. Exposed here because `status` alone
      // cannot carry it: an offboarded tenant is `suspended`, exactly like one that has merely been
      // paused for non-payment, and the two need different words and different available actions
      // (a suspended tenant can be reactivated; an offboarded one is refused — see `patchTenant`).
      // Additive and always present, so an old frontend against this backend simply ignores it.
      offboardedAt: tenants.offboarded_at,
      // 'registered' | 'adopted' (legacy) | null (not yet linked to the licences registry).
      centralLink: tenants.central_link,
      // Licence terms CP holds for the tenant (0095) — what the NEXT mint uses. The live licence's
      // own plan/expiry is `licensePlanCode`/`licenseExpiresAt` below (introspected).
      planCode: sql<string>`coalesce(${tenants.plan_code}, ${config.license.planCode})`,
      licenceStartsAt: tenants.licence_starts_at,
      licenceExpiresAt: tenants.licence_expires_at,
      licencesName: sql<string | null>`coalesce(${tenants.licences_name}, CASE WHEN ${tenants.central_link} IS NOT NULL THEN ${tenants.slug} END)`,
      // NB: reference the outer table literally as tenants.id — interpolating
      // ${tenants.id} renders as an unqualified "id" that binds to the inner users row.
      memberCount: sql<number>`(
        SELECT COUNT(*)::int FROM users AS mu
         WHERE mu.tenant_id = tenants.id AND mu.deleted_at IS NULL
      )`,
      maxMembers: tenants.max_members,
      // Whether a licence token is STORED — never the token itself. An unlicensed tenant 402s on
      // every screen under the fail-closed Gate 2, and until now nothing in the product said so:
      // the only way to find one was to query the database. The platform tenants screen surfaces
      // it and offers the repair route.
      licensed: sql<boolean>`(${tenants.license_token_encrypted} IS NOT NULL)`,
      // Whether the tenant holds its own inference-router credential (0099) — never the token.
      inferenceProvisioned: sql<boolean>`(${tenants.inference_token_encrypted} IS NOT NULL)`,
    })
    .from(tenants)
    .where(idFilter)
    // `id` LAST — tenants provisioned by one migration/backfill share a `created_at`, and a
    // non-total ORDER BY under limit/offset lets Postgres order tied rows differently for each
    // page's query, so a tenant can be listed twice or never. See routes/challenges'
    // `orderForSort` header for the measured version.
    .orderBy(desc(tenants.created_at), asc(tenants.id))
    .limit(limit)
    .offset(offset);
  // The REAL licence state, introspected once per token for this page (lib/license-status.ts).
  // `licensed` above only ever meant "a token was written into this row once" — in prod 18 of 19
  // tenants reported true while the licences service held a licence for 5. Empty map when
  // LICENSE_GATE_2_ENABLED is off, so dev/CI do zero introspects.
  const licenseStates = await licenseStatesForTenants(rows.map((r) => r.id));
  const pendingInvites = await pendingInviteCounts(rows.map((r) => r.id));
  const shaped = rows.map((r) => {
    const ls = licenseStates.get(r.id);
    const pendingInviteCount = pendingInvites.get(r.id) ?? 0;
    return {
      ...r,
      // ⛔ SEATS ARE MEMBERS **PLUS** PENDING INVITES — the definition the cap is ENFORCED with
      // (services/seat-limit.ts `claimSeatInTx`: an unexpired pending invite reserves its seat) and
      // the one the page copy states. The screen used to render `memberCount` as "seats used", so a
      // tenant with one open tenant_admin invite showed "0 / unlimited" (prod E2E 2026-10-14).
      // `memberCount` keeps meaning PEOPLE (the offboard confirmation counts them).
      pendingInviteCount,
      seatsUsed: r.memberCount + pendingInviteCount,
      // The nil-UUID seed/dev tenant (SYSTEM_TENANT_ID). Not a customer workspace: PATCH and
      // offboard refuse it with 409 `system_tenant`, and it holds no licence of its own — so the
      // screen must show it read-only instead of offering an editor that can only fail.
      isSystemTenant: isSystemTenant(r.id),
      // ADDITIVE + optional, exactly like the inert `policy` on GET /api/pipeline: `licensed` above
      // stays BYTE-IDENTICAL so an old frontend against this backend renders precisely what it
      // renders today, and a new frontend against an OLD backend sees `licenseState === undefined`
      // and falls back to the same legacy chip. That is the whole deploy-safety story.
      ...(ls
        ? {
            licenseState: ls.state,
            licenseHasToken: ls.hasToken,
            licenseExpiresAt: ls.expiresAt,
            licenseDaysRemaining: ls.daysRemaining,
            licensePlanCode: ls.planCode,
          }
        : {}),
    };
  });
  return jsonResponse({ tenants: shaped, total, limit, offset });
});

/**
 * Pending, unexpired invites per tenant — each reserves a seat (same predicate as
 * services/seat-limit.ts `countPendingInvites`). `tenant_invites` is RLS-scoped (0094), and this is a
 * cross-tenant read behind `requireSuperAdmin`, so it runs under `runAsSystem`: under the request's
 * own scope every OTHER tenant's count would silently read 0.
 */
async function pendingInviteCounts(tenantIds: string[]): Promise<Map<string, number>> {
  if (tenantIds.length === 0) return new Map();
  const rows = await runAsSystem('platform-admin', () =>
    db
      .select({ tenantId: tenantInvites.tenant_id, n: sql<number>`count(*)::int` })
      .from(tenantInvites)
      .where(
        and(
          inArray(tenantInvites.tenant_id, tenantIds),
          eq(tenantInvites.status, 'pending'),
          sql`${tenantInvites.expires_at} > now()`,
        ),
      )
      .groupBy(tenantInvites.tenant_id),
  );
  return new Map(rows.map((r) => [r.tenantId, Number(r.n)]));
}

/** POST /api/tenants — create a tenant (platform / super_admin only). Thin wrapper over
 *  `services/tenant-service.ts createTenant`, which owns the order (licences first, CP row second,
 *  licence, first-admin invite) and every error code. */
const createTenant = route(async (req) => {
  const user = await requireSuperAdmin(req);
  const body = createTenantSchema.parse(await readJson(req));
  const result = await createTenantService({
    name: body.name,
    firstAdminEmail: body.firstAdminEmail,
    firstAdminFirstName: body.firstAdminFirstName,
    firstAdminLastName: body.firstAdminLastName,
    byoMode: body.byoMode,
    terms: body.terms,
    maxMembers: body.maxMembers ?? null,
    industry: body.industry ?? null,
    // A workspace created here with NOTHING chosen about LLM access (no plan, no posture) gets the
    // platform's local model (early access: usable on day one). A caller that names a `byoMode`
    // without a plan is choosing the posture by hand, which only a plan that does not fix it allows,
    // so that keeps the deployment default as before. The signup-approval path
    // (routes/onboarding.ts) defaults the same way via `newTenantPlanFor` (plan-posture.ts), which
    // also maps an explicit `local_allowed` to local-llm.
    planCode: body.planCode ?? (body.byoMode === undefined ? NEW_TENANT_PLAN : undefined),
    startsAt: body.startsAt ?? null,
    expiresAt: body.expiresAt ?? null,
    licenceBundles: body.licenceBundles,
    actor: { id: user.id, email: user.email },
    reqId: currentRequestContext()?.requestId,
  });
  return jsonResponse(result, 201);
});

/**
 * ⛔ AN OFFBOARDED WORKSPACE IS READ-ONLY. `POST /api/tenants/:id/offboard` tombstoned every member and
 * revoked their seats, keys and sessions; nothing un-tombstones them. Every licence- or state-changing
 * route refuses it with 409 `tenant_offboarded` — the same code `patchTenant` answers a reactivation
 * with — instead of minting a live licence, buying credit or issuing a key for a workspace that not
 * one human being can work in. The bare-id read is deliberate: it runs before any write, under no
 * tenant transaction, exactly like the existence check each caller already does.
 */
async function assertNotOffboarded(tenantId: string): Promise<void> {
  const [t] = await db
    .select({ offboardedAt: tenants.offboarded_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (t?.offboardedAt) {
    throw conflict('tenant_offboarded', 'This workspace has been offboarded; it is read-only.');
  }
}

/**
 * POST /api/tenants/:id/license — issue (or repair) a tenant's Common Practice licence (super_admin).
 *
 * The recovery path for every tenant that predates licence-at-create: they exist with
 * `license_token_encrypted IS NULL` and 402 on every screen, and nothing else will ever fix them —
 * `scripts/backfill-licenses.ts` SKIPS tenants with no users, and the onboarding routes only issue
 * for users onboarded through CP. Idempotent (a licensed tenant reports `alreadyLicensed`), binds to
 * the tenant's oldest LIVE member when it has one, otherwise to the acting super-admin.
 *
 * `?force=1` re-mints over an existing stored token, for a licence revoked upstream or a blob left
 * undecryptable by a key rotation — states in which the tenant 402s but the default call reports
 * `alreadyLicensed`. Exempt from Gate 2 (middleware/license-gate.ts), or an admin scoped into the
 * broken tenant would be 402'd by the very gate this route lifts.
 */
const issueTenantLicense = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  const [t] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      token: tenants.license_token_encrypted,
      offboardedAt: tenants.offboarded_at,
    })
    .from(tenants)
    .where(eq(tenants.id, id!));
  if (!t) throw notFound('tenant_not_found', `No tenant '${id}'`);
  // ⛔ Before the issuance flag and before the `alreadyLicensed` short-circuit: a licence minted for
  // an offboarded tenant binds to a tombstoned member (or the acting operator) and passes Gate 2 for
  // a workspace nobody can use — see `assertNotOffboarded`.
  if (t.offboardedAt) {
    throw conflict('tenant_offboarded', 'This workspace has been offboarded; no licence can be issued.');
  }
  // Fail loud rather than reporting success for a no-op: with issuance off `ensureTenantLicense`
  // returns immediately, so a "repaired" tenant would still 402 (same guard as backfill-licenses.ts).
  if (!config.license.issuanceEnabled) {
    throw conflict(
      'license_issuance_disabled',
      'LICENSE_ISSUANCE_ENABLED is off — no licence can be issued from this deployment',
    );
  }
  // A stored token is treated as proof of a working licence — but it is only proof that a token
  // was stored ONCE. A licence revoked upstream, or a token left undecryptable by a secret-box key
  // rotation, still 402s the tenant on every screen while this route cheerfully reports
  // `alreadyLicensed: true`, which is precisely the "repaired but still broken" trap the fail-loud
  // guard above exists to avoid. `?force=1` re-mints over the stored token for that case. It is
  // opt-in rather than the default because minting is an external write against the licences
  // service, and the common call really is a no-op.
  const force = new URL(req.url).searchParams.get('force');
  const forced = force === '1' || force === 'true';
  if (t.token && !forced) {
    return jsonResponse({ tenantId: t.id, licensed: true, alreadyLicensed: true });
  }

  const { subjectId, boundToActor } = await licenseSubjectFor(t.id, actor.id);
  await ensureTenantLicense(t.id, subjectId, { force: forced });
  await recordAudit({
    actorId: actor.id,
    // The TARGET tenant, not the request context's: a super_admin acting from their own workspace
    // would otherwise file this row under it, invisible in the target tenant's /audit.
    tenantId: t.id,
    action: 'tenant.license_issue',
    category: 'tenant',
    targetType: 'tenant',
    targetId: t.id,
    result: t.name,
    resultTone: 'ok',
    // `forced` is recorded because a re-mint REPLACES a token that was already there — the one
    // case where this route is not a pure repair-the-missing operation. `boundToActor` is recorded
    // because `licenseSubjectFor`'s actor-fallback (no live member on the tenant) used to write the
    // exact same `boundTo` shape as a normal member bind — making a licence bound to a non-member
    // invisible after the fact. This is queryable now: `metadata->>'boundToActor' = 'true'` finds
    // every tenant licensed this way (Better Results Group / Nonagentic are the two known today).
    metadata: { boundTo: subjectId, boundToActor, forced },
  });
  return jsonResponse({
    tenantId: t.id,
    licensed: true,
    alreadyLicensed: false,
    boundTo: subjectId,
    reminted: forced && Boolean(t.token),
  });
});

// ---- money budget (tenant_admin read) · billing terms (super_admin read) ----
//
// ⛔ THE OPENROUTER WELCOME BUDGET IS RETIRED (0099). `POST /api/tenants/:id/budget` (a super_admin
// granting a dollar-capped OpenRouter key) is gone; the tenant's money budget is billing-service's
// (`/api/budget/money/*`), and so is its balance. CP keeps no copy of either.

/** Why a billing read has no answer — the same two reasons routes/billing-view.ts distinguishes. */
type BudgetState = 'ok' | 'none' | 'not_configured' | 'upstream_error';

/** GET /api/tenants/:id/budget — the tenant's PREPAID CREDIT (USD) and money-budget CAP, both from
 *  billing, plus seat usage (tenant_admin or super_admin). Each null with a state saying why:
 *  `none` = billing holds none (or its money routes are off), never "unlimited". The credit needs no
 *  money budget (billing PR #267): the two are read and shown separately. */
const getBudget = route(async (req, id) => {
  const { effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  const seats = await getSeatUsage(effectiveTenantId);
  let budget: MoneyBudgetStatus | null = null;
  let budgetState: BudgetState = 'not_configured';
  let credit: PrepaidCredit | null = null;
  let creditState: BudgetState = 'not_configured';
  if (billingAdminConfigured()) {
    const client = billingAdmin();
    try {
      budget = await billingMethod(client, 'moneyBudgetStatus')(effectiveTenantId);
      budgetState = budget ? 'ok' : 'none';
    } catch (err) {
      budgetState = 'upstream_error';
      log.warn('money_budget_read_failed', { tenantId: effectiveTenantId, err });
    }
    try {
      credit = await billingMethod(client, 'prepaidCredit')(effectiveTenantId);
      creditState = credit ? 'ok' : 'none';
    } catch (err) {
      creditState = 'upstream_error';
      log.warn('prepaid_credit_read_failed', { tenantId: effectiveTenantId, err });
    }
  }
  return jsonResponse({ budget, budgetState, credit, creditState, seats });
});

const topupSchema = z
  .object({
    // Whole US DOLLARS — the credit ledger is USD, and billing's `amount` is a strict int.
    amount: z.number().int().min(1).max(1_000_000),
    // One key per top-up INTENT (the browser reuses it on every retry of the same amount), so a
    // retried or double-submitted request buys the credit once.
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict();

/** The currency CP buys credit in: the prepaid-credit ledger is USD (billing PR #267). */
const TOPUP_CURRENCY = 'USD';

/**
 * POST /api/tenants/:id/budget/topup — the tenant_admin buys PREPAID CREDIT (billing PR #267, 286a8b2).
 *
 * Invoiced ONCE by billing (a one-time access charge); LLM usage is then drawn from the credit and is
 * not billed again; unused credit carries over. Needs NO money budget. Errors:
 *   409 `billing_topup_unavailable` — billing's top-up route answered 404 (the feature flag is off);
 *   409 `billing_topup_conflict`    — the same idempotency key with a different amount/currency;
 *   502 `billing_unavailable`       — billing is not reachable / not configured, or refused (non-2xx).
 * ⛔ A billing 2xx is ALWAYS a success here — even when its body cannot be read (`credit: null`,
 *   audited as succeeded-with-unknown-balance): the credit exists and the charge is invoiced.
 */
const topUpBudget = route(async (req, id) => {
  const { user, effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  const body = topupSchema.parse(await readJson(req));
  // Credit bought for an offboarded workspace is invoiced and can never be drawn down.
  await assertNotOffboarded(effectiveTenantId);
  if (!billingAdminConfigured()) {
    throw new HttpError(502, 'billing_unavailable', 'No billing service is configured in this deployment.');
  }
  let out;
  try {
    out = await billingMethod(billingAdmin(), 'moneyTopup')(effectiveTenantId, {
      amount: body.amount,
      currency: TOPUP_CURRENCY,
      idempotencyKey: body.idempotencyKey,
    });
  } catch (err) {
    if (err instanceof BillingTopupUnavailableError) {
      throw conflict('billing_topup_unavailable', 'Top-up is not available for this workspace yet.');
    }
    if (err instanceof BillingTopupConflictError) {
      throw conflict('billing_topup_conflict', 'Billing refused this top-up.', { reason: err.reason });
    }
    if (err instanceof BillingTopupForbiddenError) {
      // ⛔ Not an outage and not the reader's fault: CP's service account lacks the top-up role.
      log.error('billing_topup_forbidden', { tenantId: effectiveTenantId, err });
      throw conflict(
        'billing_topup_forbidden',
        'Top-up is not permitted for this service account — contact support.',
      );
    }
    // ⛔ No raw upstream text in the message the reader sees; the cause is in the log.
    log.error('billing_topup_failed', { tenantId: effectiveTenantId, err });
    throw new HttpError(502, 'billing_unavailable', 'The top-up could not be completed. Try again shortly.');
  }
  const balanceKnown = out.credit !== null;
  await recordAudit({
    actorId: user.id,
    action: 'tenant.budget_topup',
    category: 'tenant',
    targetType: 'tenant',
    targetId: effectiveTenantId,
    tenantId: effectiveTenantId,
    result: `${body.amount} ${out.currency}`,
    // `warn` = it SUCCEEDED (billing said 2xx) but the balance afterwards is unknown.
    resultTone: balanceKnown ? 'ok' : 'warn',
    metadata: {
      amount: body.amount,
      currency: out.currency,
      idempotencyKey: body.idempotencyKey,
      replayed: out.replayed,
      balanceKnown,
      creditRemainingUsd: out.credit?.remainingUsd ?? null,
    },
  });
  return jsonResponse({ credit: out.credit, replayed: out.replayed, balanceKnown });
});

/** GET /api/platform/rate-card — billing's STANDARD rate card, to prefill the terms forms
 *  (super_admin). `rateCard` null = billing has no rate card route yet / no billing configured. */
const getRateCard = route(async (req) => {
  await requireSuperAdmin(req);
  if (!billingAdminConfigured()) return jsonResponse({ rateCard: null });
  try {
    return jsonResponse({ rateCard: await billingMethod(billingAdmin(), 'rateCard')() });
  } catch (err) {
    log.warn('rate_card_read_failed', { err });
    return jsonResponse({ rateCard: null });
  }
});

/** GET /api/tenants/:id/terms — the tenant's billing terms as BILLING holds them (super_admin).
 *  `terms` null = no billing service configured in this deployment. */
const getTenantTerms = route(async (req, id) => {
  await requireSuperAdmin(req);
  const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id!));
  if (!t) throw notFound('tenant_not_found', `No tenant '${id}'`);
  const terms = await readTenantTerms(id!);
  return jsonResponse({ tenantId: id, terms, configured: terms !== null });
});

/** GET /api/tenants/:id/provisioning — what each creation step did (0101), super_admin only.
 *  `recorded: false` = a workspace created before the record existed. */
const getTenantProvisioning = route(async (req, id) => {
  await requireSuperAdmin(req);
  const rec = await readProvisioning(id!);
  if (rec === null) throw notFound('tenant_not_found', `No tenant '${id}'`);
  const bundles = await readLicenceBundles(id!);
  return jsonResponse({ tenantId: id, provisioning: toView(rec), licenceBundles: bundlesView(bundles) });
});

const ensureLicenceBundlesSchema = z.object({ bundles: BUNDLE_LIST }).strict();

/** POST /api/tenants/:id/licence-bundles {bundles} — the super_admin REPAIR for licences bundles
 *  (0104): adds the keys to what the tenant holds and ensures each now, idempotently (licences answers
 *  `exists` for an app already licensed). 200 with per-bundle results whatever licences said — a
 *  refused bundle is a result (`status: 'failed'`, `code` = licences' `detail.error`), not an HTTP
 *  error. 404 `tenant_not_found`; 409 `tenant_offboarded` / `provisioning_step_busy`. */
const ensureTenantLicenceBundles = route(async (req, id) => {
  const user = await requireSuperAdmin(req);
  const body = ensureLicenceBundlesSchema.parse(await readJson(req));
  const out = await ensureLicenceBundlesNow(id!, body.bundles);
  const results = out.bundles ?? [];
  await recordAudit({
    actorId: user.id,
    action: 'tenant.licence_bundles.ensure',
    category: 'tenant',
    targetType: 'tenant',
    targetId: id!,
    result: results.map((r) => `${r.bundle}: ${r.status}`).join(', '),
    resultTone: results.every((r) => r.status !== 'failed') ? 'ok' : 'warn',
    tenantId: id!,
    metadata: { results: results.map((r) => ({ bundle: r.bundle, status: r.status, code: r.code, refused: r.refused })) },
  });
  return jsonResponse({
    tenantId: id,
    results,
    licenceBundles: bundlesView(await readLicenceBundles(id!)),
    provisioning: toView(await readProvisioning(id!)),
  });
});

/** POST /api/tenants/:id/provisioning/:step/retry — re-run ONE creation step now, idempotently,
 *  under its per-(tenant, step) claim (services/tenant-provisioning.ts). The billing terms and the
 *  first admin are the ones held since create — nothing is re-entered. 409 `provisioning_step_busy`
 *  / `tenant_offboarded`; 404 `provisioning_step_unknown`. */
const retryTenantProvisioning = route(async (req, id, step) => {
  const user = await requireSuperAdmin(req);
  if (!step || !isProvisioningStep(step)) {
    throw notFound('provisioning_step_unknown', `No provisioning step '${step}'`);
  }
  const reqId = currentRequestContext()?.requestId;
  const out = await retryProvisioningStep(id!, step, { actorId: user.id, reqId });
  await recordAudit({
    actorId: user.id,
    action: 'tenant.provisioning.retry',
    category: 'tenant',
    targetType: 'tenant',
    targetId: id!,
    result: `${step}: ${out.record.status}`,
    resultTone: out.record.status === 'ok' || out.record.status === 'skipped' ? 'ok' : 'warn',
    tenantId: id!,
    metadata: { step, status: out.record.status, code: out.record.code, attempts: out.record.attempts },
  });
  const rec = await readProvisioning(id!);
  return jsonResponse({
    tenantId: id,
    step,
    record: out.record,
    ...(out.invite ? { invite: out.invite } : {}),
    ...(out.bundles ? { bundles: out.bundles } : {}),
    provisioning: toView(rec),
  });
});

// ---- suspend / reactivate: the MEMBER SEATS, not just the legacy tenant licence ----

/** One member whose seat could not be moved. Same shape the offboard route reports, deliberately:
 *  an operator reconciling a suspend against an offboard should not have to learn two formats. */
interface SeatFailure {
  userId: string;
  email: string;
  message: string;
}

/** Every LIVE member of a tenant, with the two fields the seat calls need.
 *
 *  Live only (`deleted_at IS NULL`): a tombstoned member's seat was already released by their own
 *  offboard, and if THAT failed the row is sitting at `revoking` where `releaseStuckSeats`
 *  (host/onboarding-integrity.ts) retries it — re-driving it from here would duplicate that queue
 *  without adding coverage. This differs from the OFFBOARD route, which sweeps the whole membership
 *  including tombstones, and the difference is load-bearing: offboard tombstones everyone as part of
 *  the same operation, so a retry that looked only at live rows would see an empty list and report
 *  success having tried nobody. Suspend tombstones nobody, so its live set is stable across retries
 *  and already IS the complete set. */
async function liveMembersOf(tenantId: string) {
  return db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      keycloakSub: users.keycloak_sub,
    })
    .from(users)
    .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at)));
}

/**
 * SUSPEND RELEASES THE SEATS. ⛔ THE COMMERCIAL DECISION, STATED EXPLICITLY BECAUSE IT IS A
 * DECISION AND NOT A CLEANUP: **A SUSPENDED TENANT DOES NOT PAY FOR SEATS.**
 *
 * Suspension is the state in which nobody in the workspace can work — every runtime gate denies a
 * `suspended` tenant. Until now `patchTenant` revoked only the LEGACY tenant-level licence, so every
 * member's own central licence stayed `active`, kept counting toward licences-service
 * `human_subjects`, and the customer kept being invoiced their full headcount for a workspace they
 * were locked out of. That is the worst possible pairing of the two facts: no service, full price.
 *
 * The inverse — leaving seats active so a reactivation is instant — is NOT a trade-off we are free
 * to make on the customer's behalf. Reactivation re-ensures them (`restoreSeatsForReactivate`), and
 * `createLicense` is idempotent per (subject, tenant, app), so the cost of re-seating is a few HTTP
 * calls; the cost of not releasing is real money charged for nothing.
 *
 * NON-FATAL PER MEMBER, copied from the offboard route's `seatFailures` loop and for its reason: one
 * member's licences hiccup must not abort the release for the rest of the workspace.
 * `revokeMemberEntitlement` moves the row to `revoking` BEFORE it calls the service, so even a total
 * outage leaves every seat in the honest "still billable, not yet released" state that
 * `releaseStuckSeats` retries — which is precisely why this runs BEFORE the fail-loud
 * `revokeTenantLicense` and not after it. Ordered the other way, a licences outage 502s out of the
 * tenant-licence revoke and the seats are never even queued.
 */
async function releaseSeatsForSuspend(
  tenantId: string,
  members: Awaited<ReturnType<typeof liveMembersOf>>,
): Promise<SeatFailure[]> {
  const failures: SeatFailure[] = [];
  for (const member of members) {
    try {
      await revokeMemberEntitlement(tenantId, member.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('tenant_suspend_seat_revoke_deferred', {
        tenantId,
        userId: member.id,
        remediation:
          'the workspace is suspended but this member\'s licence is still ACTIVE upstream and ' +
          'BILLABLE; the entitlement row is left at `revoking` for the reconciler — or re-send the ' +
          'same PATCH',
        err,
      });
      failures.push({ userId: member.id, email: member.email, message });
    }
  }
  return failures;
}

/**
 * REACTIVATION RE-SEATS EVERY LIVE MEMBER — the other half of the decision above.
 *
 * ⛔ WITHOUT THIS, SUSPEND IS A ONE-WAY DOOR. Once `perMemberGate` is on, Gate 2 checks the
 * CALLER'S OWN entitlement: a reactivated workspace whose seats were released but never re-ensured
 * answers `license_seat_required` to every single member, i.e. the reactivation appears to succeed
 * and nobody can get in. The tenant-level `reissueTenantLicense` does not help — it binds ONE
 * licence to the oldest member and the per-member gate does not read it.
 *
 * ⚠️ TWO EXCLUSIONS, both copied from `repairUnseatedMembers` (host/onboarding-integrity.ts) rather
 * than re-derived, because getting either wrong spends the customer's money:
 *   • `role = 'platform'` — a seat is a licences-service `human_subjects` entry, i.e. a line on the
 *     customer's invoice. Minting one for a platform operator bills the customer for our staff.
 *   • `keycloak_sub IS NULL` — the proof that somebody has actually authenticated as this row.
 *     `db/seed-tenant-showcase.ts` inserts `role:'employee'` users with no id, so `users.id` is a
 *     `uuidv7()` that can never authenticate; minting against it registers a Subject that is billable
 *     and unusable. Absence of the sub means "nobody has ever been this person", which is exactly
 *     when an identity must not be invented.
 *
 * A `pending` outcome is NOT counted as a failure: it means another caller owns the in-flight mint,
 * or the row is mid-offboard. Both are states the reconciler resolves, and reporting them here would
 * make a healthy concurrent onboard look like a broken reactivation.
 */
async function restoreSeatsForReactivate(
  tenantId: string,
  members: Awaited<ReturnType<typeof liveMembersOf>>,
): Promise<SeatFailure[]> {
  const failures: SeatFailure[] = [];
  for (const member of members) {
    if (member.role === 'platform') continue;
    if (!member.keycloakSub) continue;
    try {
      await ensureMemberEntitlement(tenantId, member.id, member.keycloakSub);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('tenant_reactivate_seat_ensure_failed', {
        tenantId,
        userId: member.id,
        remediation:
          'the workspace is active again but this member holds no seat and will be denied ' +
          '`license_seat_required` once the per-member gate is on; the onboarding-integrity sweep ' +
          'retries unseated members every 5 minutes, or re-send the same PATCH',
        err,
      });
      failures.push({ userId: member.id, email: member.email, message });
    }
  }
  return failures;
}

/** The tenant fields the platform screens edit and read back — never the token blob. */
async function tenantView(id: string) {
  const [row] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      industry: tenants.industry,
      maxMembers: tenants.max_members,
      offboardedAt: tenants.offboarded_at,
      centralLink: tenants.central_link,
      licencesName: tenants.licences_name,
      planCode: sql<string>`coalesce(${tenants.plan_code}, ${config.license.planCode})`,
      licenceId: tenants.licence_id,
      licenceHolder: tenants.licence_subject_sub,
      licenceStartsAt: tenants.licence_starts_at,
      licenceExpiresAt: tenants.licence_expires_at,
      licensed: sql<boolean>`(${tenants.license_token_encrypted} IS NOT NULL)`,
    })
    .from(tenants)
    .where(eq(tenants.id, id));
  return row;
}

/**
 * PATCH /api/tenants/:id — the super_admin licence editor (platform only — tenant lifecycle and
 * commercial terms are platform operations, spec 3.3). Every field optional; at least one required:
 *
 *   name       CP DISPLAY name only. The slug and the licences name do NOT move — see the ⛔ block
 *              at step (2) for why both are immutable identifiers.
 *   maxMembers seat cap; refused below live members + pending invites (409 `seats_below_usage`),
 *              checked under the tenant row lock. `null` = unlimited.
 *   planCode / startsAt / expiresAt
 *              the licence terms — `changeTenantLicence` (mint new → swap → revoke old → re-issue
 *              member seats). Dates: `null` clears. 422 `plan_unknown` / `plan_retired`.
 *   byoMode    the tenant's BYO posture for this app in the licences registry.
 *   status     suspend → seats + licence revoked; reactivate → re-issued (on the tenant's terms).
 *
 * Everything is VALIDATED before anything is written (window, plan, seats ≥ usage, a free licences
 * name), then applied licence → name → seats → BYO → status, and each change type's audit row
 * (`tenant.licence_change`, `tenant.rename`, `tenant.seats`, `tenant.byo_mode`, `tenant.update`,
 * each with `before` / `after`) is written the moment that step lands — so a later failure never
 * leaves an earlier change unaudited.
 */
const patchTenant = route(async (req, id) => {
  const user = await requireSuperAdmin(req);
  const [t] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      offboardedAt: tenants.offboarded_at,
      maxMembers: tenants.max_members,
      centralLink: tenants.central_link,
      licencesName: tenants.licences_name,
      planCode: sql<string>`coalesce(${tenants.plan_code}, ${config.license.planCode})`,
      startsAt: tenants.licence_starts_at,
      expiresAt: tenants.licence_expires_at,
    })
    .from(tenants)
    .where(eq(tenants.id, id!));
  if (!t) throw notFound('tenant_not_found', `No tenant '${id}'`);
  // The nil-UUID seed/dev tenant is not a customer workspace (see SYSTEM_TENANT_ID): its licence,
  // name, seats and status are not edited from here.
  if (isSystemTenant(t.id)) {
    throw conflict('system_tenant', 'This is the platform system tenant; it cannot be edited here.');
  }
  const body = patchTenantSchema.parse(await readJson(req));
  const termsRequested =
    body.planCode !== undefined || body.startsAt !== undefined || body.expiresAt !== undefined;
  if (
    body.name === undefined &&
    body.status === undefined &&
    body.maxMembers === undefined &&
    body.byoMode === undefined &&
    body.terms === undefined &&
    !termsRequested
  ) {
    throw badRequest(
      'no_changes',
      'Provide name, status, maxMembers, planCode, startsAt, expiresAt, byoMode and/or terms',
    );
  }
  // ⛔ AN OFFBOARDED WORKSPACE CANNOT BE REACTIVATED (0075). This is not tidiness — reactivation
  // here would call `reissueTenantLicense` below, which mints a LIVE Gate-2 licence bound to the
  // tenant's oldest member. `POST /api/tenants/:id/offboard` has already TOMBSTONED every member,
  // and nothing un-tombstones them. The result is a workspace that passes Gate 2 on every request
  // and that not one human being can work in: a licence CP is
  // (potentially) billed for, an `active` row on the platform screen, and no way to notice from
  // either side. A rename is still allowed — bookkeeping on a dead row. Everything else is refused:
  // licence terms, BYO posture and billing terms are commercial terms of a live customer, the seat
  // cap is part of the licence, and a status write in EITHER direction re-drives the seat calls
  // (`releaseSeatsForSuspend` / `restoreSeatsForReactivate`) against members who no longer exist.
  //
  // The repair is deliberately NOT "flip a column": bringing a workspace back means re-inviting its
  // people through the onboarding chain, which re-creates the identities and re-issues the licence
  // as a side effect of somebody actually being able to log in.
  if (
    t.offboardedAt &&
    (body.status !== undefined ||
      body.maxMembers !== undefined ||
      termsRequested ||
      body.byoMode !== undefined ||
      body.terms !== undefined)
  ) {
    throw conflict(
      'tenant_offboarded',
      'This workspace has been offboarded: it is read-only — it cannot be reactivated and its licence, seats and terms cannot be edited.',
    );
  }
  // ── VALIDATE EVERYTHING BEFORE ANY WRITE ───────────────────────────────────────────────────────
  // ⛔ A refusal must leave NOTHING changed. The first version wrote seats and the rename (CP AND
  // licences) and only then validated the licence window, so `{name, maxMembers, expiresAt <
  // stored start}` answered 422 having renamed the tenant and moved its seats — with no audit row,
  // because every audit row was written at the very end.
  //
  // Only a CHANGE of plan is checked: a tenant may stay on a plan that has since been retired.
  if (body.planCode !== undefined && body.planCode !== t.planCode) {
    await assertPlanAssignable(body.planCode);
  }
  if (termsRequested) {
    const startsAt = body.startsAt !== undefined ? body.startsAt : t.startsAt;
    const expiresAt = body.expiresAt !== undefined ? body.expiresAt : t.expiresAt;
    if (startsAt && expiresAt && expiresAt <= startsAt) {
      throw unprocessable('licence_window_invalid', 'The expiry must be after the start.');
    }
  }
  if (body.byoMode !== undefined && !licencesAdminConfigured()) {
    throw conflict(
      'licences_not_configured',
      'No licences service is configured in this deployment, so there is no BYO posture to set.',
    );
  }
  // ⛔ THE PLAN FIXES THE POSTURE for `local-llm` (local_allowed) and `byo` (byo_required) —
  // services/plan-posture.ts. A contradicting byoMode is refused; a plan CHANGE brings its posture
  // with it, so a tenant moved onto `byo` cannot keep spending on the platform under a stale posture.
  const nextPlan = body.planCode ?? t.planCode;
  const planChanged = body.planCode !== undefined && body.planCode !== t.planCode;
  const fixedByo = planByoMode(nextPlan);
  if (fixedByo && body.byoMode !== undefined && body.byoMode !== fixedByo) {
    throw unprocessable(
      'byo_mode_fixed_by_plan',
      `Plan '${nextPlan}' fixes the BYO posture to '${fixedByo}'.`,
    );
  }
  const byoMode =
    body.byoMode ?? (fixedByo && planChanged && licencesAdminConfigured() ? fixedByo : undefined);
  const nextSeats = body.maxMembers === undefined ? undefined : (body.maxMembers ?? null);
  if (nextSeats !== undefined && nextSeats !== null) {
    await withTenantTransaction(id!, (tx) => assertSeatsCover(tx, id!, nextSeats));
  }
  const renaming = body.name !== undefined && body.name !== t.name;

  // ── APPLY: most failure-prone first, each step AUDITED THE MOMENT IT LANDS ──────────────────────
  // A later step failing therefore never leaves an earlier, committed change without its row.
  const audit = (a: {
    action: string;
    result: string;
    resultTone: 'ok' | 'warn';
    metadata: Record<string, unknown>;
  }) =>
    recordAudit({
      actorId: user.id,
      action: a.action,
      category: 'tenant',
      targetType: 'tenant',
      targetId: id,
      result: a.result,
      resultTone: a.resultTone,
      tenantId: id,
      metadata: a.metadata,
    });

  // (1) LICENCE TERMS — external mints. Not minted when this same PATCH suspends (the suspend below
  // would revoke it at once); a suspended tenant holds no token, so only its terms are written and
  // reactivation mints on them.
  // (0) A plan change ONTO local-llm provisions the tenant's own inference-router credential FIRST:
  // the moment the plan flips, keyless calls carry that token — or fail closed without one. A
  // failure here refuses the whole PATCH before anything changed.
  if (planChanged && nextPlan === LOCAL_LLM_PLAN && body.status !== 'suspended') {
    const inf = await ensureTenantInference(id!);
    if (inf.status === 'provisioned') {
      await audit({
        action: 'tenant.inference_provision',
        result: inf.licenceId,
        resultTone: 'ok',
        metadata: { change: 'inference', licenceId: inf.licenceId },
      });
    }
  }

  let licence: LicenceChangeResult | null = null;
  if (termsRequested) {
    licence = await changeTenantLicence(
      id!,
      { planCode: body.planCode, startsAt: body.startsAt, expiresAt: body.expiresAt },
      { actorId: user.id, mint: body.status !== 'suspended' },
    );
    if (licence.changed) {
      const warn = licence.oldLicenceRevoked === false || licence.memberFailures.length > 0;
      await audit({
        action: 'tenant.licence_change',
        result: licence.after.planCode,
        resultTone: warn ? 'warn' : 'ok',
        metadata: {
          change: 'licence',
          before: licence.before,
          after: licence.after,
          reminted: licence.reminted,
          oldLicenceRevoked: licence.oldLicenceRevoked,
          oldLicenceKeptAsSeat: licence.oldLicenceKeptAsSeat,
          membersReissued: licence.membersReissued,
          memberReissueFailed: licence.memberFailures.length,
        },
      });
    }
  }

  // (2) NAME — the DISPLAY name only.
  //
  // ⛔ THE SLUG AND THE LICENCES NAME ARE IMMUTABLE, AND THEY ARE ONE NAME (cb4dd0f: CP registers
  // its slug as the licences name). This step used to rename the licences tenant to `slugify(name)`
  // while leaving the slug alone — so the first rename split the pair that create had just made
  // equal. Renaming BOTH was considered and refused, because the slug is an identifier other systems
  // hold, not a label:
  //   • the tenant's Entra IdP alias is `entra-<slug>` (services/sso-service.ts `aliasForSlug`),
  //     stored in Keycloak and in `identity_providers.alias`; a Keycloak IdP alias cannot be
  //     renamed, so a new slug would make `?tenant=<slug>` sign-in hints (frontend keycloak.ts
  //     `idpHintFromQuery`) derive an alias that does not exist, and break links already handed out;
  //   • the offboard confirmation is typed against the slug;
  //   • the licences name is how the onboarding-integrity repair re-registers a tenant.
  // So a rename is bookkeeping on the human-facing name; every machine-facing name stays put, and
  // the "one name on both sides" invariant holds for the tenant's whole life.
  if (renaming) {
    await db.update(tenants).set({ name: body.name!, updated_at: new Date() }).where(eq(tenants.id, id!));
    await audit({
      action: 'tenant.rename',
      result: body.name!,
      resultTone: 'ok',
      metadata: {
        change: 'name',
        before: { name: t.name },
        after: { name: body.name },
        // Unchanged by design (see above) — recorded so the audit row answers "what did it NOT move".
        slug: t.slug,
        licencesName: t.licencesName,
      },
    });
  }

  // (3) SEATS — re-checked under the same row lock the invite path takes (the pre-check above holds
  // no lock). tenant_invites is RLS-scoped: counted under THIS tenant's scope, or a cp_app connection
  // sees zero pending invites for every tenant (the owner role tests run as would hide that).
  if (nextSeats !== undefined) {
    await withTenantTransaction(id!, async (tx) => {
      await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id!)).for('update');
      if (nextSeats !== null) await assertSeatsCover(tx, id!, nextSeats);
      await tx.update(tenants).set({ max_members: nextSeats, updated_at: new Date() }).where(eq(tenants.id, id!));
    });
    if (nextSeats !== t.maxMembers) {
      await audit({
        action: 'tenant.seats',
        result: nextSeats === null ? 'unlimited' : String(nextSeats),
        resultTone: 'ok',
        metadata: { change: 'seats', before: t.maxMembers, after: nextSeats },
      });
    }
  }

  // (3b) Moved OFF local-llm: its inference-router licence is revoked. Not fatal — the plan change
  // has landed; a failure is reported (and audited) for a re-try rather than undoing the change.
  let inferenceRevokeError: string | null = null;
  if (planChanged && t.planCode === LOCAL_LLM_PLAN && nextPlan !== LOCAL_LLM_PLAN) {
    try {
      const r = await revokeTenantInference(id!);
      if (r.revoked) {
        await audit({
          action: 'tenant.inference_revoke',
          result: 'revoked',
          resultTone: 'ok',
          metadata: { change: 'inference', reason: 'plan_change', after: nextPlan },
        });
      }
    } catch (err) {
      inferenceRevokeError = err instanceof Error ? err.message : String(err);
      log.error('tenant_inference_revoke_failed', { tenantId: id, err });
    }
  }

  // (4) BYO posture — the licences registry owns it; CP keeps no copy.
  if (byoMode !== undefined) {
    const before = await readTenantByoMode(id!);
    try {
      await adminMethod(licensesAdmin(), 'setTenantByoMode')(id!, byoMode);
    } catch (err) {
      throw licencesUnavailable(err, `setting the BYO posture of ${id} failed`);
    }
    await audit({
      action: 'tenant.byo_mode',
      result: byoMode,
      resultTone: 'ok',
      metadata: { change: 'byo_mode', before, after: byoMode, fixedByPlan: body.byoMode === undefined },
    });
  }

  // (4b) BILLING TERMS — billing is the system of record; one idempotent PUT, skipped when billing
  // already states exactly these terms (services/tenant-terms.ts).
  let termsStatus: string | null = null;
  if (body.terms !== undefined) {
    const before = await readTenantTerms(id!).catch(() => null);
    const terms = body.terms;
    const out = await writeTermsFromEdit(id!, () => writeTenantTerms(id!, terms));
    termsStatus = out.status;
    if (out.status === 'written') {
      await audit({
        action: 'tenant.terms',
        result: `platform ${body.terms.platformFeeUsd} / seat ${body.terms.seatFeeUsd} / markup ${body.terms.markupPct} pct`,
        resultTone: 'ok',
        metadata: {
          change: 'terms',
          before: before
            ? { platformFeeUsd: before.platformFeeUsd, seatFeeUsd: before.seatFeeUsd, markupPct: before.markupPct }
            : null,
          after: body.terms,
          changed: out.terms.changed,
        },
      });
    }
  }

  // (5) STATUS. Phase 4 / F.2: suspend = revoke the license; reactivate = re-issue it (Spec §9.3).
  // Both are no-ops while issuance is off, and fail-loud (502) when on so a suspend can't silently
  // leave an active license. Done after the status write; an idempotent ensure/revoke keeps
  // redundant same-status PATCHes safe.
  //
  // ⛔ AND THE MEMBER SEATS, WHICH IS THE PART THAT WAS MISSING AND THE PART THAT COSTS MONEY.
  // The two calls below are the LEGACY tenant-level entitlement. Since per-member licensing (0089)
  // each employee ALSO holds their own central licence, and THAT is what licences-service counts as
  // a billable seat. Suspending revoked only the tenant licence, so a suspended workspace — one in
  // which every runtime gate already denies every request — went on being invoiced for its entire
  // headcount. See `releaseSeatsForSuspend` for the commercial decision in full: **a suspended
  // tenant does not pay seats.**
  //
  // SEATS FIRST, tenant licence second. `revokeTenantLicense` / `reissueTenantLicense` are fail-loud
  // (502), so running them first means a licences outage aborts the handler before a single seat is
  // touched. Run the seats first and even a total outage leaves every row at `revoking`/`error` —
  // the honest, reconciler-visible state — instead of untouched and invisibly billable.
  // ⚠️ `licence_busy` (409): the tenant licence step takes the per-tenant licence lease, so a suspend
  // or reactivation racing another licence op answers 409 AFTER the status column and the seats have
  // moved. That is recoverable by design — every step here is idempotent, so RE-SENDING THE SAME PATCH
  // finishes it (the audit row below records the attempt either way).
  let seatFailures: SeatFailure[] = [];
  if (body.status !== undefined) {
    await db
      .update(tenants)
      .set({ status: body.status, updated_at: new Date() })
      .where(eq(tenants.id, id!));
    try {
      if (body.status === 'suspended') {
        seatFailures = await releaseSeatsForSuspend(id!, await liveMembersOf(id!));
        await revokeTenantLicense(id!);
      } else {
        seatFailures = await restoreSeatsForReactivate(id!, await liveMembersOf(id!));
        await reissueTenantLicense(id!);
      }
    } finally {
      // The status column moved either way: its row is written even when the licence step 502s.
      await audit({
        action: 'tenant.update',
        result: body.status,
        // 'warn' whenever a seat could not be moved: on a suspend that means the customer is still
        // being charged for somebody who cannot work, and on a reactivation it means somebody is
        // locked out of a workspace that is live again. Both are outcomes an operator has to be able
        // to find later.
        resultTone: seatFailures.length > 0 ? 'warn' : 'ok',
        metadata: {
          change: 'status',
          before: t.status,
          after: body.status,
          status: body.status,
          seatsAttempted: true,
          seatFailed: seatFailures.length,
        },
      });
    }
  }

  return jsonResponse({
    tenant: await tenantView(id!),
    seatFailures,
    termsStatus,
    inferenceRevokeError,
    licence: licence
      ? {
          changed: licence.changed,
          before: licence.before,
          after: licence.after,
          reminted: licence.reminted,
          oldLicenceRevoked: licence.oldLicenceRevoked,
          oldLicenceKeptAsSeat: licence.oldLicenceKeptAsSeat,
          membersReissued: licence.membersReissued,
          memberFailures: licence.memberFailures,
        }
      : null,
  });
});

/** 409 `seats_below_usage` when `max` is below live members + pending, unexpired invites. */
async function assertSeatsCover(tx: SeatTx, tenantId: string, max: number): Promise<void> {
  const [m] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at)));
  const [p] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tenantInvites)
    .where(
      and(
        eq(tenantInvites.tenant_id, tenantId),
        eq(tenantInvites.status, 'pending'),
        sql`${tenantInvites.expires_at} > now()`,
      ),
    );
  const members = Number(m?.n ?? 0);
  const pending = Number(p?.n ?? 0);
  if (max < members + pending) {
    throw conflict(
      'seats_below_usage',
      `This workspace already uses ${members + pending} seats (${members} members, ${pending} ` +
        `pending invites); the limit cannot go below that. Remove members or revoke invites first.`,
      { members, pending, used: members + pending, requested: max },
    );
  }
}

/**
 * GET /api/tenants/:id/licence — the tenant's licence as CP holds it AND as licences holds it
 * (super_admin). The two can drift (a licence revoked or edited centrally, an old licence the
 * change could not revoke), so both are returned side by side and nothing is reconciled here.
 *
 * `live` is `GET /licenses/active` for (tenant, app): `null` = licences says there is none;
 * `liveError` = it could not be asked (never read as "none"). Not configured → both null.
 */
const getTenantLicence = route(async (req, id) => {
  await requireSuperAdmin(req);
  const view = await tenantView(id!);
  if (!view) throw notFound('tenant_not_found', `No tenant '${id}'`);
  const central = licencesAdminConfigured();
  let live: Awaited<ReturnType<NonNullable<ReturnType<typeof licensesAdmin>['getActiveLicense']>>> = null;
  let liveError: string | null = null;
  // The tenant licence's HOLDER: CP's cp-tenant subject, or — for a workspace licensed before A2
  // and not yet re-homed by the onboarding-integrity sweep — a member's seat, which is reported as
  // such rather than shown as if it were the tenant's own licence.
  const holder = isTenantLicenceSubject(view.licenceHolder)
    ? view.licenceHolder
    : view.licensed
      ? 'legacy_member_seat'
      : null;
  if (central && isTenantLicenceSubject(holder)) {
    try {
      // ALWAYS with the holder as selector: without one licences answers with whichever licence of
      // the tenant it picks — a member's seat. A pick that is not the holder's is not shown.
      const resp = await adminMethod(licensesAdmin(), 'getActiveLicense')(id!, { subjectId: holder! });
      live = resp && resp.subject_match !== false ? resp : null;
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }
  }
  const byoMode = await readTenantByoMode(id!);
  const now = Date.now();
  const expiresAt = view.licenceExpiresAt;
  const status =
    view.offboardedAt !== null
      ? 'offboarded'
      : view.status === 'suspended'
        ? 'suspended'
        : expiresAt && expiresAt.getTime() <= now
          ? 'expired'
          : view.licensed
            ? 'active'
            : 'unlicensed';
  return jsonResponse({
    tenantId: view.id,
    // See listAllTenants: the system tenant is read-only (PATCH/offboard answer 409 `system_tenant`).
    isSystemTenant: isSystemTenant(view.id),
    planCode: view.planCode,
    startsAt: view.licenceStartsAt?.toISOString() ?? null,
    expiresAt: expiresAt?.toISOString() ?? null,
    status,
    tenantStatus: view.status,
    licensed: view.licensed,
    licenceId: view.licenceId,
    holder,
    byoMode,
    licencesName: view.licencesName ?? (view.centralLink ? view.slug : null),
    centralLink: view.centralLink,
    centralConfigured: central,
    live: live
      ? {
          active: live.active,
          licenceId: live.license_id ?? null,
          planCode: live.plan?.code ?? null,
          expiresAt: live.expires_at ?? null,
          status: live.status ?? null,
          subjectId: live.subject_id ?? null,
          candidateCount: live.candidate_count ?? null,
          subjectMatch: live.subject_match ?? null,
        }
      : null,
    liveError,
  });
});

/**
 * Body of `POST /api/tenants/:id/offboard`.
 *
 * `confirmSlug` is required and must equal the tenant's own slug. This is the only destructive,
 * whole-workspace, IRREVERSIBLE operation in the product — it tombstones every member and revokes
 * every seat, and `patchTenant` then refuses to reactivate the tenant — so it must not be reachable by
 * a mis-aimed click or a stale tenant id in a script. The slug (not the uuid) because the operator
 * has to have READ the workspace's name to type it.
 */
const offboardTenantSchema = z
  .object({
    confirmSlug: z.string().min(1).max(200),
    /** Free-text note for the audit trail — why this workspace was offboarded. */
    reason: z.string().max(2000).optional(),
  })
  .strict();

/**
 * POST /api/tenants/:id/offboard — offboard an ENTIRE workspace (platform / super_admin only).
 *
 * THE GAP THIS CLOSES. Member offboarding has existed since C.2b.1 (`DELETE /api/tenants/:id/users/
 * :userId`), but there was no tenant-level equivalent: emptying a workspace meant clicking every
 * member one at a time, and the last-admin guard (`tenantAdminIds`, routes/tenant-users.ts) means
 * the FINAL administrator can never be removed through that route at all. So every departed customer
 * left behind live memberships and live, working `mcp_api_keys` — credentials that outlast
 * the commercial relationship, with nothing in the product able to revoke them.
 *
 * ⛔ `requireSuperAdmin` ONLY, never `requireTenantAdmin`. A tenant must not be able to offboard
 * itself: the operation is irreversible (see `patchTenant`'s reactivation bar), and it is a commercial decision about a customer relationship rather than an
 * administrative one inside a workspace. `requireTenantAdmin` would also let a super_admin reach it
 * with a scope-switch header, which audits as `scope_switch` and hides what actually happened.
 *
 * ⛔ THE LAST-ADMIN GUARD IS NOT RELAXED HERE — THIS ROUTE SIMPLY NEVER ASKS. `tenantAdminIds`
 * protects a LIVE tenant's ability to administer ITSELF without platform intervention: it exists so
 * that removing people one at a time can never strand a workspace with nobody who can add anybody.
 * An offboarded workspace has no such property to protect — nobody is left in it by construction,
 * and that is the intent, not an accident to be guarded against. Calling the guard here would mean
 * the sole-admin tenants (which is most small customers) were precisely the ones that could never be
 * offboarded, which is the defect, not the safety feature. `tests/tenant-offboard.test.ts` pairs the
 * sole-admin case with a control proving the MEMBER route still 409s `last_admin`.
 *
 * THE WORK IS `services/offboarding.ts offboardTenantFully` — shared with `scripts/offboard-tenant.ts`
 * so the two cannot drift; its docblock holds the sequence (DB writes in one transaction → invites +
 * IdPs → tenant licence → member seats → inference credential → central archive → audit) and why it
 * is in that order. Keycloak identities are never touched: the portal realm is shared with fr.
 *
 * A SEAT-REVOKE FAILURE IS A 200 WITH A NON-EMPTY `seatFailures`, NOT A 502: the workspace IS
 * offboarded by then, and re-running the route retries what remains.
 *
 * A LICENCE-SERVICE FAILURE *IS* FATAL (502, from `revokeTenantLicense`), and deliberately so: the
 * licence is the thing that would keep answering "this workspace is entitled" long after everyone
 * has gone. The DB writes are already committed and idempotent, so the retry costs nothing.
 *
 * IDEMPOTENT BY CONSTRUCTION, not by a status check: every write carries an `IS NULL` predicate and
 * the timestamp is `COALESCE(offboarded_at, now())`, so a second call returns 200 with
 * `alreadyOffboarded: true`, the ORIGINAL timestamp, and every WRITE count at zero; the seat loop
 * re-runs over the whole membership (already-revoked rows no-op).
 */
const offboardTenant = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  // Before ANY write: 404 / 409 `system_tenant` (the nil-UUID seed tenant is never offboarded).
  const t = await loadOffboardTarget(id!);
  const body = offboardTenantSchema.parse(await readJson(req));
  // Before ANY write — the test asserts that a mismatch leaves the workspace untouched.
  assertOffboardConfirmed(t, body.confirmSlug);

  // Everything else is the shared service `scripts/offboard-tenant.ts` runs too — see its docblock.
  const out = await offboardTenantFully(t, { actorId: actor.id }, { reason: body.reason ?? null });

  return jsonResponse({
    tenantId: out.tenantId,
    offboardedAt: out.offboardedAt,
    alreadyOffboarded: out.alreadyOffboarded,
    // ⛔ `usersOffboarded` (rows this call TOMBSTONED), never the whole membership the seat loop
    // iterates: a repeat offboard tombstones nobody, and the response and the audit row must agree.
    usersOffboarded: out.usersOffboarded,
    inferenceRevokeError: out.inferenceRevokeError,
    keysRevoked: out.keysRevoked,
    sessionsRevoked: out.sessionsRevoked,
    seatFailures: out.seatFailures,
    archiveFailure: out.archiveFailure,
    archiveSkipped: out.archiveSkipped,
    residualLicencesRevoked: out.residualLicencesRevoked,
    residualLicenceFailures: out.residualLicenceFailures,
    invitesRevoked: out.invitesRevoked,
    idpDisableFailures: out.idpDisableFailures,
  });
});

// ---- members (roster) ----
//
// A tenant's "members" are the users whose home tenant is this one (users.tenant_id), with their
// CP role (users.tenant_role). Keycloak only authenticates; it holds no tenant role. Invite, role
// change and removal live in routes/tenant-users.ts.

/** GET /api/tenants/:id/members — the tenant's live roster, each with their CP tenant role
 *  (`tenant_role`, NULL = not backfilled → 'member'). */
const listMembers = route(async (req, id) => {
  await requireTenantAdmin(req, { pathTenantId: id! });
  const roster = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      joinedAt: users.created_at,
      tenantRole: users.tenant_role,
    })
    .from(users)
    // Offboarded members (0050) are not on the roster — their row survives only to keep their
    // past work attributed.
    .where(and(eq(users.tenant_id, id!), isNull(users.deleted_at)))
    .orderBy(desc(users.created_at));
  const members = roster.map(({ tenantRole, ...rest }) => ({ ...rest, role: tenantRole ?? 'member' }));
  return jsonResponse({ members });
});

// ---- MCP API keys ----

const mintKeySchema = z
  .object({
    name: z.string().min(1).max(120),
    scopes: z.array(z.enum(SCOPE_VALUES)).min(1).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

/** GET /api/tenants/:id/mcp-keys — list (prefix + last-used; never the secret). */
const listMcpKeys = route(async (req, id) => {
  await requireTenantAdmin(req, { pathTenantId: id! });
  const keys = await listKeys(id!);
  return jsonResponse({ keys });
});

/** POST /api/tenants/:id/mcp-keys — issue a key; the raw value is returned ONCE. */
const issueMcpKey = route(async (req, id) => {
  const { user: actor } = await requireTenantAdmin(req, { pathTenantId: id! });
  const body = mintKeySchema.parse(await readJson(req));
  // The offboard revoked every key; a new one would be a live credential into a closed workspace.
  await assertNotOffboarded(id!);
  const minted = await mintKey({
    tenantId: id!,
    issuedBy: actor.id,
    name: body.name,
    scopes: body.scopes ?? [...DEFAULT_SCOPES],
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
  });
  await recordAudit({
    actorId: actor.id,
    tenantId: id!,
    action: 'tenant.mcp_key.issue',
    category: 'tenant',
    targetType: 'mcp_api_key',
    targetId: minted.id,
    result: body.name,
    resultTone: 'ok',
  });
  // The raw key is shown exactly once; the client must copy it now.
  return jsonResponse({ id: minted.id, name: body.name, key: minted.raw, keyPrefix: minted.keyPrefix }, 201);
});

/** DELETE /api/tenants/:id/mcp-keys/:keyId — revoke a key. */
const revokeMcpKey = route(async (req, id, keyId) => {
  const { user: actor } = await requireTenantAdmin(req, { pathTenantId: id! });
  const ok = await revokeKey(id!, keyId!);
  if (!ok) throw notFound('mcp_key_not_found', 'No such active key for this tenant');
  await recordAudit({
    actorId: actor.id,
    tenantId: id!,
    action: 'tenant.mcp_key.revoke',
    category: 'tenant',
    targetType: 'mcp_api_key',
    targetId: keyId,
    result: 'revoked',
    resultTone: 'warn',
  });
  return jsonResponse({ ok: true });
});

// ---- usage & spend ----

/** GET /api/tenants/:id/usage?range= — spend/usage aggregates for a tenant the caller
 *  administers (tenant_admin own claim, or super_admin scope-switch; range ∈ {7,30,90} days).
 *  ⛔ This is TENANT-FACING (backs the tenant's own Usage screen) and must stay pathed under
 *  `/api/tenants/:id/...` like its siblings (members, mcp-keys, budget) — NOT `/api/admin/*`.
 *  That prefix is license-gate-EXEMPT (Spec 9.2, the super_admin platform surface), and this
 *  route used to live there by mistake: an unlicensed/lapsed tenant's admin could still load
 *  usage/spend while every other tenant route correctly 402'd. Moved off the exempt prefix so
 *  Gate 2 (middleware/license-gate.ts) applies here exactly as it does to budget/members/etc. */
const getUsage = route(async (req, id) => {
  const { effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  const url = new URL(req.url);
  const rangeParam = Number(url.searchParams.get('range') ?? 30);
  const rangeDays = (RANGE_DAYS as readonly number[]).includes(rangeParam) ? rangeParam : 30;
  const usage = await getTenantUsage(effectiveTenantId, rangeDays);
  return jsonResponse(usage);
});

export function registerAdminRoutes(router: Router): void {
  router.add('GET', '/api/admin/tenants', listAllTenants);
  router.add('GET', '/api/tenant', getCurrentTenant);
  router.add('POST', '/api/tenants', createTenant);
  router.add('PATCH', '/api/tenants/:id', patchTenant);
  router.add('GET', '/api/tenants/:id/licence', getTenantLicence);
  router.add('POST', '/api/tenants/:id/offboard', offboardTenant);
  router.add('GET', '/api/tenants/:id/members', listMembers);
  router.add('GET', '/api/tenants/:id/mcp-keys', listMcpKeys);
  router.add('POST', '/api/tenants/:id/mcp-keys', issueMcpKey);
  router.add('DELETE', '/api/tenants/:id/mcp-keys/:keyId', revokeMcpKey);
  router.add('POST', '/api/tenants/:id/license', issueTenantLicense);
  router.add('GET', '/api/tenants/:id/budget', getBudget);
  router.add('GET', '/api/tenants/:id/terms', getTenantTerms);
  router.add('GET', '/api/tenants/:id/provisioning', getTenantProvisioning);
  router.add('POST', '/api/tenants/:id/provisioning/:step/retry', retryTenantProvisioning);
  router.add('POST', '/api/tenants/:id/licence-bundles', ensureTenantLicenceBundles);
  router.add('POST', '/api/tenants/:id/budget/topup', topUpBudget);
  router.add('GET', '/api/platform/rate-card', getRateCard);
  router.add('GET', '/api/tenants/:id/usage', getUsage);
}
