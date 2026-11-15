// src/lib/types/admin.ts — shared types for the Enterprise admin screens.
// Mirror the backend shapes (routes/admin.ts, host/usage-metrics.ts).
export type TenantStatus = 'active' | 'suspended';
export type TenantRole = 'tenant_admin' | 'developer' | 'member';

/** A tenant row (create/patch return; GET /api/tenant). */
export interface TenantSummary {
	id: string;
	name: string;
	slug: string;
	status: TenantStatus;
	industry?: string | null;
	/** Present on the create response (POST /api/tenants). */
	centralLink?: CentralLink | null;
}

/** GET /api/tenant — the caller's own single tenant (Phase 4 / C.1, claim-derived). */
export interface CurrentTenantResponse {
	tenant: TenantSummary;
}

/** A row of the platform all-tenants view (GET /api/admin/tenants, super_admin). */
export interface PlatformTenant {
	id: string;
	name: string;
	slug: string;
	status: TenantStatus;
	createdAt: string;
	/** PEOPLE: live members whose home tenant this is. Not the seat count — see `seatsUsed`. */
	memberCount: number;
	/** Pending, unexpired invites — each reserves a seat. Absent from an older backend. */
	pendingInviteCount?: number;
	/** Seats in use = members + pending invites (how the cap is enforced). Absent from an older
	 *  backend — read it through `seatsUsedOf`. */
	seatsUsed?: number;
	/** Seat cap; null = unlimited. */
	maxMembers: number | null;
	/** Whether the tenant holds its own inference-router credential (local-llm, 0099). Absent from
	 *  an older backend. */
	inferenceProvisioned?: boolean;
	/** Whether a Common Practice licence token is stored for this tenant. FALSE means the fail-
	 *  closed Gate 2 answers 402 on every screen for anyone who reaches it — the tenant exists but
	 *  nobody can use it. Until this field existed the only way to find such a tenant was to query
	 *  the database; `Better Results Group` sat unusable in prod because nothing surfaced it.
	 *
	 *  ⚠️ This only means "a token was written into the row ONCE" — never "the token works". Prefer
	 *  `licenseState` below; this field is kept byte-identical so an old frontend keeps working. */
	licensed: boolean;
	/** The REAL licence state, introspected against the licences service per page load
	 *  (backend lib/license-status.ts `licenseStatesForTenants`). OPTIONAL on purpose: absent from
	 *  an older backend AND from any deployment with the licence gate disabled, and the chip falls
	 *  back to `licensed` in that case (see lib/admin/license-chip.ts). `unknown` = the licences
	 *  service could not be reached — this read fails SOFT, so `unknown` never means "unlicensed". */
	licenseState?: 'none' | 'active' | 'expired' | 'unknown';
	/** Whether a token blob is stored. `licenseState:'none'` WITH `licenseHasToken:true` is a tenant
	 *  holding a token the licences service does not honour — the case that needs a FORCE re-issue,
	 *  because the plain issue call reports `alreadyLicensed` and repairs nothing. */
	licenseHasToken?: boolean;
	/** ISO expiry of the introspected licence, when the service reports one. */
	licenseExpiresAt?: string | null;
	licenseDaysRemaining?: number | null;
	licensePlanCode?: string | null;
	/** ISO stamp of the tenant's offboarding, null while the tenant is live (POST
	 *  /api/tenants/:id/offboard). NON-NULL IS TERMINAL: the members' Keycloak identities and MCP
	 *  keys are gone, and `PATCH /api/tenants/:id {status:'active'}` answers 409 `tenant_offboarded`
	 *  by design. Any control that would reactivate this tenant must be disabled on a non-null
	 *  value — a reactivate button here is a button that only ever 409s. */
	offboardedAt: string | null;
	/** Link to the central licences registry; absent from a backend older than 0093. */
	centralLink?: CentralLink | null;
	/** Licence terms CP holds for the tenant (0095) — what the NEXT mint uses. Absent before 0095. */
	planCode?: string;
	licenceStartsAt?: string | null;
	licenceExpiresAt?: string | null;
	/** The tenant's name in the licences registry — the slug, or `<slug>-cp…` when the slug was
	 *  held by another licences tenant. null when the tenant is not linked centrally. */
	licencesName?: string | null;
	/** The nil-UUID seed/dev tenant (backend `isSystemTenant`). Not a customer workspace: PATCH and
	 *  offboard answer 409 `system_tenant`, so the screen shows it read-only. Absent from an older
	 *  backend — the frontend then falls back to comparing the id with `SYSTEM_TENANT_ID`. */
	isSystemTenant?: boolean;
}

/** A tenant's money budget as BILLING holds it (GET /api/tenants/:id/budget). The OpenRouter
 *  welcome budget is retired (backend migration 0099). Amounts are in `currency`. */
export interface MoneyBudget {
	amount: number;
	currency: string;
	consumed: number;
	remaining: number;
	thresholdsCrossed: number[];
}

/** The workspace's PREPAID CREDIT, in USD (billing's credit ledger; needs no money budget). */
export interface PrepaidCredit {
	grantedUsd: number;
	drawnUsd: number;
	remainingUsd: number;
	settledThrough: string | null;
}

/** POST /api/tenants/:id/budget/topup — the credit after a prepaid-credit top-up. */
export interface MoneyTopupResponse {
	/** null when billing confirmed the top-up but its balance could not be read (`balanceKnown`). */
	credit: PrepaidCredit | null;
	/** true = this intent's idempotency key was already applied; nothing was charged again. */
	replayed: boolean;
	balanceKnown: boolean;
}

/** GET /api/platform/rate-card — billing's STANDARD rate card (prefills the terms forms). */
export interface RateCard {
	currency: string;
	platformFeeUsd: number;
	seatFeeUsd: number;
	markupPct: number;
	/** CP's markup term (billing_mode byo_markup_only). */
	byoMarkupPct: number;
	source: string;
}

/** Why `budget` is null: billing holds none / is not wired here / did not answer. */
export type MoneyBudgetState = 'ok' | 'none' | 'not_configured' | 'upstream_error';

/** A tenant's billing terms (billing-service is the system of record). USD; markup in percent. */
export interface TenantTerms {
	platformFeeUsd: number;
	seatFeeUsd: number;
	markupPct: number;
}

/** GET /api/tenants/:id/terms. `terms` null = no billing service in this deployment. */
export interface TenantTermsResponse {
	tenantId: string;
	terms: (TenantTerms & { billingMode: string; fullyConfigured: boolean }) | null;
	configured: boolean;
}

/** Seat usage for a tenant. `max`/`remaining` are null when the tenant is uncapped. */
export interface SeatUsage {
	used: number;
	max: number | null;
	remaining: number | null;
}

export interface TenantBudgetResponse {
	/** The money-budget CAP (spend guard) — separate from the credit. */
	budget: MoneyBudget | null;
	/** Absent from an older backend. */
	budgetState?: MoneyBudgetState;
	/** The prepaid credit (USD). Absent from an older backend. */
	credit?: PrepaidCredit | null;
	creditState?: MoneyBudgetState;
	seats: SeatUsage;
}

/** A tenant's LLM posture, set at creation (licences `byo_mode`). */
export type ByoMode = 'byo_required' | 'local_allowed' | 'platform_only';

/** How the tenant is linked to the central licences registry. */
export type CentralLink = 'registered' | 'adopted';

/** POST /api/tenants (super_admin). CP always registers its OWN licences tenant — there is no
 *  adopt path any more (A2). */
export interface CreateTenantBody {
	name: string;
	/** Invited as the workspace's first tenant_admin. */
	firstAdminEmail?: string;
	/** Both REQUIRED with `firstAdminEmail` (422 otherwise): the realm requires first + last name. */
	firstAdminFirstName?: string;
	firstAdminLastName?: string;
	/** Omitted when the plan fixes it (`local-llm` / `byo`) — the backend refuses a contradiction. */
	byoMode?: ByoMode;
	/** Billing terms (platform fee, seat fee, markup %); omitted = none written. */
	terms?: TenantTerms;
	maxMembers?: number | null;
	industry?: string | null;
	/** A plan code of this app's licences catalogue; omitted = the deployment default. */
	planCode?: string;
	/** ISO-8601 WITH an offset; omitted/null = from mint / perpetual. */
	startsAt?: string | null;
	expiresAt?: string | null;
	/** Licences bundle keys CP ensures on the new tenant (kebab-case, unique, <= 20). Licences decides
	 *  which keys exist; a failed bundle does not stop the create. */
	licenceBundles?: string[];
}

/** The tenant on the POST /api/tenants response. ⚠️ snake_case: it is the inserted row as
 *  `services/tenant-service.ts createTenant` returns it, not the camelCase list view. */
export interface CreatedTenant {
	id: string;
	name: string;
	slug: string;
	status: TenantStatus;
	central_link: CentralLink | null;
	licences_name: string | null;
	plan_code: string | null;
	licence_starts_at: string | null;
	licence_expires_at: string | null;
}

/** How an invitation reached the invitee. `keycloak_actions`: the person has no password yet, so
 *  Keycloak sent its set-password email (which continues to the invite link). `failed`: no email
 *  went out — `inviteUrl` is the only way in. `deferred` (early-access approve only): the person is
 *  already seated; the set-password email goes out once their licence exists (retried by the backend). */
export type InviteDelivery = 'sent' | 'keycloak_actions' | 'failed' | 'deferred';

/** An invitation as returned by every create/resend route. `inviteUrl` is the one link that
 *  works when `emailDelivery` is 'failed' — the operator hands it over by hand. */
export interface CreatedInvite {
	id: string;
	tenantId: string;
	email: string;
	role: TenantRole;
	expiresAt: string;
	emailDelivery: InviteDelivery;
	inviteUrl: string;
}

/** PATCH /api/tenants/:id (super_admin licence editor). Send only what changed; a `null` date
 *  CLEARS it (start = from mint, expiry = perpetual), a `null` maxMembers = unlimited. */
export interface PatchTenantBody {
	name?: string;
	status?: TenantStatus;
	maxMembers?: number | null;
	planCode?: string;
	startsAt?: string | null;
	expiresAt?: string | null;
	byoMode?: ByoMode;
	/** Billing terms — written to billing (one idempotent PUT; nothing when unchanged). */
	terms?: TenantTerms;
}

/** The tenant as PATCH /api/tenants/:id reads it back (backend routes/admin.ts `tenantView`). */
export interface TenantLicenceView {
	id: string;
	name: string;
	slug: string;
	status: TenantStatus;
	industry: string | null;
	maxMembers: number | null;
	offboardedAt: string | null;
	centralLink: CentralLink | null;
	licencesName: string | null;
	planCode: string;
	licenceId: string | null;
	licenceStartsAt: string | null;
	licenceExpiresAt: string | null;
	licensed: boolean;
}

export interface LicenceTermsView {
	planCode: string | null;
	startsAt: string | null;
	expiresAt: string | null;
	licenceId?: string | null;
}

export interface SeatFailure {
	userId: string;
	email: string;
	message: string;
}

export interface PatchTenantResult {
	tenant: TenantLicenceView;
	seatFailures: SeatFailure[];
	/** 'written' | 'unchanged' | 'skipped_unconfigured'; null when no terms were sent. */
	termsStatus?: string | null;
	/** Set when moving OFF local-llm could not revoke the inference licence (retry the save). */
	inferenceRevokeError?: string | null;
	/** null when no licence term changed. */
	licence: null | {
		changed: boolean;
		before: LicenceTermsView;
		after: LicenceTermsView;
		reminted: boolean;
		/** true/false = the old licence was / was not revoked; null = there was nothing to revoke. */
		oldLicenceRevoked: boolean | null;
		membersReissued: number;
		memberFailures: SeatFailure[];
	};
}

export type TenantLicenceStatus = 'active' | 'expired' | 'suspended' | 'offboarded' | 'unlicensed';

/** GET /api/tenants/:id/licence — CP's terms beside what licences itself holds (never reconciled). */
export interface TenantLicence {
	tenantId: string;
	/** See `PlatformTenant.isSystemTenant`. */
	isSystemTenant?: boolean;
	planCode: string;
	startsAt: string | null;
	expiresAt: string | null;
	status: TenantLicenceStatus;
	tenantStatus: TenantStatus;
	licensed: boolean;
	licenceId: string | null;
	/** null = licences could not be read (or is not configured). */
	byoMode: ByoMode | null;
	licencesName: string | null;
	centralLink: CentralLink | null;
	centralConfigured: boolean;
	/** licences' active licence for (tenant, app). null = none, or licences was not asked. */
	live: null | {
		active: boolean;
		licenceId: string | null;
		planCode: string | null;
		expiresAt: string | null;
		status: string | null;
		subjectId: string | null;
		candidateCount: number | null;
	};
	/** Set when licences could not be asked — never read as "no licence". */
	liveError: string | null;
}

/** A plan of this app's licences catalogue (GET /api/platform/plans). */
export interface LicencePlan {
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
	createdAt?: string | null;
	/** CP tenants (not offboarded) on this plan code. */
	tenantCount: number;
	/** The deployment default (`LICENSE_PLAN_CODE`) — what a tenant without a plan gets. */
	isDefault: boolean;
}

export interface PlansResponse {
	app: string;
	defaultPlanCode: string;
	plans: LicencePlan[];
	/** null = not tried yet in this backend process; false = licences refused `revoked` (501). */
	capabilities: { canRetire: boolean | null };
}

/** The editable fields of a plan. `null` clears a limit / description. */
export interface PlanFields {
	name?: string;
	description?: string | null;
	durationDays?: number | null;
	rateLimitRpm?: number | null;
	rateLimitBurst?: number | null;
	quotaMonthly?: number | null;
	tokenBudgetMonthly?: number | null;
}

/** POST /api/platform/plans. `code` is set once, here, and never edited. */
export interface CreatePlanBody extends PlanFields {
	code: string;
	name: string;
}

/** PATCH /api/platform/plans/:id. `revoked` = retire / un-retire (501 `retire_unsupported`). */
export interface PatchPlanBody extends PlanFields {
	revoked?: boolean;
}

/** GET /api/tenants/:id/invites row. */
export interface InviteView {
	id: string;
	email: string;
	role: TenantRole;
	status: 'pending' | 'accepted' | 'revoked' | 'expired';
	expiresAt: string;
	createdAt: string;
	invitedBy: string | null;
}

/** An invitation waiting for the signed-in user (GET /api/me, GET /api/me/invites). */
export interface PendingInviteView {
	id: string;
	tenantId: string;
	tenantName: string;
	role: TenantRole;
	expiresAt: string;
}

/** POST /api/signup-approvals/:id/approve — a new workspace for the requester, or a seat in an
 *  existing one. */
export type ApproveSignupBody =
	// Both optional on a new workspace: no name → the server's default (`suggested_tenant_name`,
	// auto-suffixed if taken); no posture → the one the plan fixes.
	| { mode: 'new_tenant'; tenantName?: string; byoMode?: ByoMode }
	| { mode: 'existing'; tenantId: string; role: TenantRole };

/** POST /api/signup-approvals/invite — the super_admin's pre-approved early-access invite. */
/** The languages a signup / its set-password email can carry (backend 0121). */
export const SIGNUP_LOCALES = ['ar', 'de', 'en', 'es', 'fr', 'he', 'nl', 'pl'] as const;
export type SignupLocale = (typeof SIGNUP_LOCALES)[number];

export interface InviteEarlyAccessBody {
	email: string;
	name: string;
	company?: string;
	/** The set-password email's language (backend 0121). Omitted → English. */
	locale?: SignupLocale;
	/** Omitted → the server's default (company, else the email's organisation, else the name). */
	tenantName?: string;
}

/** The approve payload for the new workspace (backend routes/onboarding.ts `approveApprovalRow`). */
export interface InviteEarlyAccessResponse {
	approval: SignupApproval;
	tenantId: string;
	role: TenantRole;
	invite: CreatedInvite | null;
	seated: boolean;
	tenant?: { id: string; name: string; slug: string; licencesName: string | null };
}

/**
 * One in-app notification (GET /api/notifications).
 *
 * ⛔ `title` / `body` ARE NOT DEAD FIELDS AND ARE REQUIRED ON PURPOSE. They are the backend's
 * ENGLISH prose, composed by `backend/src/host/budget-service.ts` `alertCopy` at insert time.
 * `$lib/i18n/notification-label` is what a reader sees now — but these two are the ONLY thing it
 * can return for a row that carries no `data`, and unlike `types/ops.ts` that is NOT a
 * one-deploy transitional state: every notification row written before migration 0066 has
 * `data IS NULL` for as long as the row exists. Declaring them optional would let a call site drop
 * the fallback and still typecheck.
 *
 * ⛔ `data` AND EVERY FIELD INSIDE IT IS OPTIONAL, also on purpose. It is a jsonb column with no
 * database-level shape, written by one producer today and by others later; and the browser reaches
 * the API through the k8s Service, which load-balances across old and new pods for the length of a
 * rolling deploy, so a NEW frontend really is answered by an OLD pod. `types/governance.ts`
 * declaring `key`/`statusKey` REQUIRED is precisely how tsc came to assert a field the old wire
 * does not send, and /governance blanked (PR #233, second commit).
 */
interface AppNotificationBase {
	id: string;
	severity: 'info' | 'warn' | 'critical';
	/** @deprecated backend English — the fallback. Render via `notificationTitle`. */
	title: string;
	/** @deprecated backend English — the fallback. Render via `notificationBody`. */
	body: string | null;
	href: string | null;
	read: boolean;
	createdAt: string;
}

/**
 * The tenant welcome-budget alerts (75 / 90 / 100 % of the grant).
 *
 * ⚠️ ONE `kind` COVERS ALL THREE RUNGS — `kind` alone does not tell you which sentence this is.
 * `data.threshold` does, and `notification-label.ts` re-runs the backend's own
 * `>= 100 / >= 90 / else` ladder on it. `remainingUsd` is legally `0` at the top rung.
 */
export interface BudgetThresholdNotification extends AppNotificationBase {
	kind: 'budget.threshold';
	data?: {
		threshold?: number;
		tenantName?: string;
		limitUsd?: number;
		remainingUsd?: number;
	};
}

export type AppNotification = BudgetThresholdNotification;

/** The shape every notification shares — the widening target for an unrecognised `kind`. */
export type AppNotificationProse = AppNotificationBase & {
	kind?: string;
	data?: Record<string, unknown>;
};

export interface AllTenantsResponse {
	tenants: PlatformTenant[];
	/** Total tenant count (independent of the page). Present so a future paginated UI can
	 *  detect truncation; the default page size (500) returns every tenant today. */
	total?: number;
	limit?: number;
	offset?: number;
}

/** A row of the tenant's member roster (GET /api/tenants/:id/members). `role` is the
 *  Keycloak realm-role fact attached server-side (Phase 4 / C.2b), null when the user has
 *  neither tenant-scoped role. Role promote/demote + in-tenant create go through
 *  PATCH/POST /api/tenants/:id/users. */
export interface Member {
	userId: string;
	name: string;
	email: string;
	joinedAt: string;
	role: TenantRole | null;
}

// ---- Per-tenant Entra OIDC SSO (Phase 4 / E.1) ----
// Mirror sso-service.ts `PublicIdp`. The Entra client_secret is NEVER carried here
// (`hasSecret` only flags whether one is stored). `tenantId` is present on the platform
// overview rows so the super_admin view can group by tenant.

export interface IdpOidcConfig {
	discovery_url: string;
	client_id: string;
	scopes: string;
	trust_email: boolean;
}

export interface IdpProvider {
	id: string;
	tenantId: string;
	alias: string;
	displayName: string;
	providerType: string;
	enabled: boolean;
	config: IdpOidcConfig;
	linkOnly: boolean;
	hasSecret: boolean;
	redirectUri: string;
	/** The owning tenant's display name. Present ONLY on the platform overview
	 *  (`GET /api/admin/sso/providers` → `listAllIdps`), which server-side joins `tenants`.
	 *  Undefined on the per-tenant read — that screen already knows its own tenant — and
	 *  undefined for an orphaned row, so a reader must fall back to `tenantId`. */
	tenantName?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateIdpBody {
	entraTenantGuid: string;
	clientId: string;
	clientSecret: string;
	scopes?: string;
	trustEmail?: boolean;
	linkOnly?: boolean;
}

export interface UpdateIdpBody {
	enabled?: boolean;
	scopes?: string;
	trustEmail?: boolean;
	linkOnly?: boolean;
	clientSecret?: string;
}

// ---- Controlled onboarding (Phase 4 / C.2a — super_admin) ----
// Mirror routes/onboarding.ts. Identity is born in Keycloak; the queue/invite/email-domain
// surface is super_admin-gated.

export type SignupStatus = 'pending' | 'approved' | 'rejected';

export interface SignupApproval {
	id: string;
	keycloak_sub: string | null;
	email: string;
	name: string | null;
	status: SignupStatus;
	matched_tenant_id: string | null;
	assigned_tenant_id: string | null;
	requested_role: string;
	note: string | null;
	/** The company the requester named (early-access intake). */
	company?: string | null;
	/** Where the signup came from: website, chat, the CP app itself, or a super_admin's direct
	 *  invite (POST /api/signup-approvals/invite); null = another writer. */
	source?: 'web' | 'chat' | 'app' | 'invite' | null;
	/** The applicant's free-text message (early-access intake). Absent from an older backend. */
	message?: string | null;
	/** The requester's language (backend 0121); null = not told (English). */
	locale?: SignupLocale | null;
	/** The workspace name approve defaults to when no `tenantName` is sent. */
	suggested_tenant_name?: string;
	/** A REJECTED signup's cleanup (backend 0122): what an aborted approve left behind and how far
	 *  undoing it got. null = nothing to undo. Absent from an older backend. */
	reject_repair?: SignupRejectRepair | null;
	/** ⛔ Resolving this row's cleanup by hand would leave the rejected requester's access LIVE
	 *  (blocked: the offboard never ran; failed on a seat / licence / IdP / identity / offboard cause).
	 *  The screen warns and requires a confirmation; the backend requires `acknowledgeLiveAccess`.
	 *  Set on `?status=needs_repair` rows. */
	reject_repair_leaves_live_access?: boolean;
	/** What an `existing`-mode approve did in a customer workspace before it aborted (backend 0122). */
	approve_effects?: Array<{ tenantId: string }> | null;
	created_at: string;
	decided_at: string | null;
	decided_by: string | null;
}

export interface SignupRejectRepair {
	/** pending = retried automatically · blocked = the workspace is in use (a super_admin decides) ·
	 *  failed = the automatic retries gave up (only Retry runs it again) · done ·
	 *  resolved_manually = a super_admin closed it with a note (terminal, not listed) */
	state: 'pending' | 'blocked' | 'failed' | 'done' | 'resolved_manually';
	tenantId: string | null;
	attempts: number;
	lastAttemptAt: string | null;
	nextAttemptAt: string | null;
	lastError: string | null;
	/** Machine codes of `lastError` (backend REJECT_REPAIR_ERROR_CODES); the screen shows guidance per code. */
	lastErrorCodes?: string[];
	resolution?: {
		note: string;
		actorSub: string;
		at: string;
		priorState: 'failed' | 'blocked';
		lastError: string | null;
		lastErrorCodes: string[];
		/** The close left the requester's access live (acknowledged explicitly). */
		leavesLiveAccess?: boolean;
	} | null;
	blockers?: string[];
	keycloakIdentity?: string | null;
}

export interface SignupApprovalsResponse {
	approvals: SignupApproval[];
}

export interface SignupStats {
	pending: number;
	approved: number;
	rejected: number;
	total: number;
}

/** A corporate-domain → tenant routing rule (GET /api/email-domains). */
export interface EmailDomainMapping {
	domain: string;
	tenant_id: string;
	auto_assign: boolean;
	created_at: string;
}

export interface EmailDomainsResponse {
	domains: EmailDomainMapping[];
}

export interface McpKeyRow {
	id: string;
	name: string;
	keyPrefix: string;
	scopes: string[];
	lastUsedAt: string | null;
	expiresAt: string | null;
	revokedAt: string | null;
	createdAt: string;
}

/** The issue response — the raw `key` is shown exactly once. */
export interface IssuedKey {
	id: string;
	name: string;
	key: string;
	keyPrefix: string;
}

/**
 * How the spend in this period was priced (`usage_events.price_source`, migration 0053).
 *
 * `provider` = the vendor's own reported charge (an invoice, not an estimate); `table` = a
 * published per-model rate from the `models.pricing` governance row; `flat` = the legacy
 * two-constant guess, used only where nothing prices the model; `legacy` = rows written before
 * price_source existed, which cannot be reconstructed and so are never backfilled.
 */
export interface PricingProvenance {
	provider: number;
	table: number;
	flat: number;
	legacy: number;
}

export interface UsageStats {
	spendUsd: number;
	calls: number;
	models: number;
	members: number;
	pricing: PricingProvenance;
}
export interface ModelUsage {
	model: string;
	provider: string;
	calls: number;
	spendUsd: number;
	/** Any call in this row was flat-estimated or predates price_source. */
	estimated: boolean;
}
export interface DayUsage {
	day: string;
	calls: number;
	spendUsd: number;
}
export interface MemberUsage {
	userId: string;
	name: string;
	calls: number;
	spendUsd: number;
}
export interface TenantUsage {
	rangeDays: number;
	stats: UsageStats;
	byModel: ModelUsage[];
	byDay: DayUsage[];
	byMember: MemberUsage[];
}

// ---- Workspace creation record (backend 0101, services/tenant-provisioning.ts) ----

export const PROVISIONING_STEPS = [
	'licences_tenant',
	'licence',
	'billing_terms',
	'ir_licence',
	'licence_bundles',
	'first_invite',
	// Early-access approval (backend 2026-10-19): the requester is seated at approve, their licence
	// minted, and only then the set-password email sent.
	'member_seat',
	'member_licence',
	'invite_email'
] as const;
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];
/** `pending` = a transient failure the backend retries by itself; `failed` = needs a Retry. */
export type ProvisioningStepStatus = 'ok' | 'failed' | 'pending' | 'skipped';

export interface ProvisioningStepRecord {
	status: ProvisioningStepStatus;
	code: string | null;
	message: string | null;
	attempts: number;
	lastAttemptAt: string | null;
	nextAttemptAt: string | null;
}

/** One licences bundle CP ensured (or tried to) on a tenant (backend 0104). */
export interface LicenceBundleResult {
	bundle: string;
	/** `skipped` = no licences service configured (dev). */
	status: 'ok' | 'failed' | 'skipped';
	/** licences' own refusal (`tenant_owner_only`, `bundle_not_ensurable_by_caller`, `bundle_not_found`, …) or `bundle_apps_refused`. */
	code: string | null;
	message: string | null;
	/** app key → licences' decision (`exists` | `adopt` | `insert`). */
	apps: Record<string, string>;
	/** Real per-app refusals (any reason but `other_bundle`): any one fails the bundle. */
	refused: { app: string; reason: string }[];
	/** Apps licences answered `other_bundle` for — licensed through ANOTHER bundle; not a failure. */
	coveredByOtherBundle?: string[];
	attempts: number;
	lastAttemptAt: string | null;
	ensuredAt: string | null;
}

export interface ProvisioningView {
	/** false = a workspace created before steps were recorded. */
	recorded: boolean;
	steps: Partial<Record<ProvisioningStep, ProvisioningStepRecord>>;
	/** The terms entered at create are saved for a retry. */
	termsHeld: boolean;
	firstAdminHeld: boolean;
}

/** Seats a tenant is using: members PLUS pending invites — the definition the backend enforces the
 *  cap with and the tenant screens' copy promises. Falls back to `memberCount` for an older backend
 *  that does not send `seatsUsed`. (Showing `memberCount` here read "0 / unlimited" for a tenant
 *  with an open tenant_admin invite, prod E2E 2026-10-14.) */
export function seatsUsedOf(t: Pick<PlatformTenant, 'memberCount' | 'seatsUsed'>): number {
	return t.seatsUsed ?? t.memberCount;
}
