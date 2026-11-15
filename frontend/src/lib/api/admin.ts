// src/lib/api/admin.ts — typed client for the Enterprise admin API (Phase 2-D) over
// authFetch. Tenants + membership + active-tenant switch + usage aggregates. Every
// endpoint is tenant-admin gated server-side; 401/403 surface as ApiError for the
// screens to render a denied state. ApiError/unwrap are re-exported for mcpKeys.ts.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, isUnparseable, detailsFrom } from './parse';
import type {
	CurrentTenantResponse,
	TenantRole,
	AllTenantsResponse,
	PlatformTenant,
	Member,
	TenantUsage,
	SignupApprovalsResponse,
	SignupApproval,
	SignupStats,
	EmailDomainsResponse,
	EmailDomainMapping,
	IdpProvider,
	CreateIdpBody,
	UpdateIdpBody,
	TenantTermsResponse,
	MoneyTopupResponse,
	RateCard,
	TenantBudgetResponse,
	CreateTenantBody,
	CreatedTenant,
	PatchTenantBody,
	PatchTenantResult,
	TenantLicence,
	PlansResponse,
	LicencePlan,
	CreatePlanBody,
	PatchPlanBody,
	CreatedInvite,
	InviteView,
	PendingInviteView,
	ApproveSignupBody,
	InviteEarlyAccessBody,
	InviteEarlyAccessResponse,
	LicenceBundleResult,
	ProvisioningStep,
	ProvisioningStepRecord,
	ProvisioningView
} from '$lib/types/admin';

/** Phase B scope-switch: a super_admin acting INTO another tenant sets the
 *  `X-Active-Tenant-Id` header (silently ignored by the backend for non-super_admin
 *  callers, spec 6.1). Returns init with the header merged when a tenant is given. */
function withActiveTenant(init: RequestInit, activeTenantId?: string): RequestInit {
	if (!activeTenantId) return init;
	const headers = new Headers(init.headers);
	headers.set('X-Active-Tenant-Id', activeTenantId);
	return { ...init, headers };
}

/**
 * ⛔ A SECOND COPY OF `ApiError` (./blocks holds the canonical one and the full ⛔ block; ./llm-settings
 * and ./delivery hold two more). `details` carries the offender's name off the wire to the localized
 * refusal catalog; without it ~20 `VALIDATION_MESSAGES` entries decline and the reader gets English.
 * READ THE BLOCK ON ./blocks BEFORE CHANGING THIS SHAPE — the four copies must keep `details` at
 * position 4, because the twenty `unwrap`s that construct them are copy-paste siblings.
 */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'ApiError';
	}
}

export async function unwrap<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = parseBody(text);
	if (!res.ok) {
		// `detailsFrom` forwards the offender's name to the localized catalog — see the ⛔ block on
		// `ApiError` (./blocks). Every sibling `unwrap` in this directory carries the same line.
		throw new ApiError(
			res.status,
			body?.error ?? 'error',
			body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
			detailsFrom(body)
		);
	}
	if (isUnparseable(text)) {
		// 2xx with an unparseable body — surface it rather than handing back a bogus `null as T`.
		// A body that is literally `null` is valid JSON and passes through untouched.
		// ⚠️ NO `details` HERE, AND THAT IS NOT AN OVERSIGHT: this branch fires precisely BECAUSE the
		// body did not parse, so there is no bag to lift. `invalid_json` is minted here, not by the
		// backend, and its catalog entry takes no parameter.
		throw new ApiError(res.status, 'invalid_json', nonJsonErrorMessage(res, text));
	}
	return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

export const adminApi = {
	/** The caller's own home tenant (CP's `users.tenant_id`). */
	async currentTenant(): Promise<CurrentTenantResponse> {
		return unwrap(await authFetch('/api/tenant'));
	},
	/** Platform: ALL tenants (super_admin only). Backs the (platform) all-tenants screen.
	 *  `limit`/`offset` page the result; the response carries `total` for the pager. */
	async allTenants(opts?: { limit?: number; offset?: number; id?: string }): Promise<AllTenantsResponse> {
		const qs = new URLSearchParams();
		if (opts?.limit != null) qs.set('limit', String(opts.limit));
		if (opts?.offset != null) qs.set('offset', String(opts.offset));
		if (opts?.id != null) qs.set('id', opts.id);
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/admin/tenants${suffix}`));
	},
	/** Platform: ONE tenant's row, exactly as the all-tenants list renders it (`?id=`), or null when
	 *  there is no such tenant. The row is picked BY ID from the response rather than taken as
	 *  `tenants[0]`: a backend older than `?id=` ignores the filter and answers the whole first page. */
	async platformTenant(id: string): Promise<PlatformTenant | null> {
		const res = await adminApi.allTenants({ id, limit: 1000 });
		return res.tenants.find((t) => t.id === id) ?? null;
	},
	/**
	 * Ask the backend, BEFORE switching scope, whether a super_admin may act as `tenantId`. Returns
	 * `null` when the tenant is admitted, else the refusal code (`license_required`, `tenant_suspended`,
	 * `tenant_offboarded`, …).
	 *
	 * ⛔ WHY `/api/me` AND NOT A LOCAL GUESS FROM THE LICENCE CHIP. Act-as is a full reload, and the
	 * very first thing the reloaded app does is `GET /api/me` under the new header — which drops a
	 * refused selection (`activeTenantRejected`). Asking that SAME endpoint the SAME question first
	 * means the screen can never promise a switch the backend will undo: the verdict is computed by
	 * one function (`authenticateForMe` → `validateAuth`), the one every tenant-admin route runs.
	 * A transient refusal (licences outage, 429, 5xx) is not a verdict: it surfaces as an ApiError.
	 */
	async actAsCheck(tenantId: string): Promise<string | null> {
		const res = await authFetch('/api/me', withActiveTenant({}, tenantId));
		const me = await unwrap<{ activeTenantRejected?: string | null }>(res);
		return me.activeTenantRejected ?? null;
	},
	/** Create a workspace and invite its first tenant_admin. CP registers its OWN licences tenant
	 *  under the plain slug (names are unique per owning app, so another app's tenant of the same
	 *  name is no clash) — the name is `tenant.licences_name`. There is no adopt path (A2).
	 *  Errors: 409 `licences_name_unavailable` (CP already has a workspace with that name); 422
	 *  `plan_unknown` | `plan_retired` | `licence_window_invalid` | `byo_mode_fixed_by_plan` |
	 *  `byo_mode_required`; 502 `licences_unavailable` | `licences_tenant_owned_by_other_app`. */
	async createTenant(
		body: CreateTenantBody
	): Promise<{
		tenant: CreatedTenant;
		/** What each creation step did. OPTIONAL: a backend older than 0101 does not send it. */
		provisioning?: ProvisioningView;
		invite: CreatedInvite | null;
		inviteError?: string;
		/** 'written' | 'unchanged' | 'skipped_unconfigured'; absent when no terms were sent. */
		terms?: string;
		/** The tenant stands; billing refused its terms (set them on its page). */
		termsError?: string;
		/** The tenant stands; its local-LLM access could not be provisioned yet. */
		inferenceError?: string;
		/** Per-bundle results when `licenceBundles` were sent. */
		licenceBundles?: LicenceBundleResult[];
		/** The tenant stands; at least one bundle failed (retried from its page). */
		licenceBundlesError?: string;
	}> {
		return unwrap(await authFetch('/api/tenants', json('POST', body)));
	},
	/** The super_admin licence editor. Send only the fields that changed.
	 *  Errors: 409 `seats_below_usage` (details `{members, pending, used, requested}`),
	 *  `licences_name_unavailable`, `tenant_offboarded`, `licences_not_configured`,
	 *  `licence_changed_concurrently`; 422 `plan_unknown` | `plan_retired` | `licence_window_invalid`. */
	async patchTenant(id: string, patch: PatchTenantBody): Promise<PatchTenantResult> {
		return unwrap(await authFetch(`/api/tenants/${id}`, json('PATCH', patch)));
	},
	/** A tenant's licence as CP holds it beside what licences holds (`live` / `liveError`). */
	async tenantLicence(id: string): Promise<TenantLicence> {
		return unwrap(await authFetch(`/api/tenants/${id}/licence`));
	},

	// ---- Plan catalogue (A2 §5, super_admin; the app is pinned server-side) ----

	async plans(opts?: { includeRevoked?: boolean }): Promise<PlansResponse> {
		const suffix = opts?.includeRevoked ? '?includeRevoked=1' : '';
		return unwrap(await authFetch(`/api/platform/plans${suffix}`));
	},
	/** 409 `plan_code_taken`. */
	async createPlan(body: CreatePlanBody): Promise<{ plan: LicencePlan }> {
		return unwrap(await authFetch('/api/platform/plans', json('POST', body)));
	},
	/** 404 `plan_not_found`; 501 `retire_unsupported` when licences cannot retire (`revoked`). */
	async updatePlan(id: string, body: PatchPlanBody): Promise<{ plan: LicencePlan }> {
		return unwrap(await authFetch(`/api/platform/plans/${id}`, json('PATCH', body)));
	},
	/** 409 `plan_in_use` (details `{tenantCount}`) while anything references the plan. */
	async deletePlan(id: string): Promise<{ ok: boolean }> {
		return unwrap(await authFetch(`/api/platform/plans/${id}`, { method: 'DELETE' }));
	},
	/** Offboard a departing tenant (super_admin, irreversible). Removes every member from the
	 *  workspace, revokes their MCP keys, sessions and seats, and stamps `offboardedAt`. Keycloak
	 *  identities are untouched (the realm is shared with fr).
	 *
	 *  `confirmSlug` MUST equal the tenant's slug — the backend answers 400 `confirm_mismatch`
	 *  otherwise. Do not default it from the id, or the guard stops guarding anything. */
	async offboardTenant(
		id: string,
		body: { confirmSlug: string; reason?: string }
	): Promise<{
		tenantId: string;
		offboardedAt: string;
		alreadyOffboarded: boolean;
		usersOffboarded: number;
		keysRevoked: number;
		sessionsRevoked: number;
		/** Members whose central licence (their billable SEAT) could not be revoked yet. Also a 200:
		 *  the rows stay `revoking` and the backend reconciler retries them. Non-empty means the
		 *  departed customer is still being billed for those seats until the retry lands. */
		seatFailures: Array<{ userId: string; email: string; message: string }>;
	}> {
		return unwrap(await authFetch(`/api/tenants/${id}/offboard`, json('POST', body)));
	},
	/** Issue (or repair) a tenant's Common Practice licence — the fix for a tenant that 402s on
	 *  every screen. Idempotent: an already-licensed tenant reports `alreadyLicensed`. `force`
	 *  re-mints over a stored token that no longer works (revoked upstream, or undecryptable after
	 *  a secret-box rotation), which the default call cannot tell apart from a healthy one. */
	async issueLicense(
		id: string,
		opts?: { force?: boolean }
	): Promise<{ tenantId: string; licensed: boolean; alreadyLicensed: boolean; boundTo?: string; reminted?: boolean }> {
		const suffix = opts?.force ? '?force=1' : '';
		return unwrap(await authFetch(`/api/tenants/${id}/license${suffix}`, json('POST', {})));
	},
	/** Buy PREPAID CREDIT (tenant_admin). `idempotencyKey` is ONE PER TOP-UP INTENT (reused on every
	 *  retry of the same amount, also after a reload — lib/billing/topup-intent.ts), so a retry or a
	 *  double-submit tops up once. 409 `billing_topup_unavailable` when billing has no money budget
	 *  for the workspace / the feature is off; 409 `billing_topup_conflict`. */
	async topUp(
		id: string,
		body: { amount: number; idempotencyKey: string },
		activeTenantId?: string
	): Promise<MoneyTopupResponse> {
		return unwrap(await authFetch(`/api/tenants/${id}/budget/topup`, withActiveTenant(json('POST', body), activeTenantId)));
	},
	/** Billing's standard rate card (super_admin); `rateCard` null when billing has none yet. */
	async rateCard(): Promise<{ rateCard: RateCard | null }> {
		return unwrap(await authFetch('/api/platform/rate-card'));
	},
	/** A tenant's billing terms as billing holds them (super_admin). */
	async tenantTerms(id: string): Promise<TenantTermsResponse> {
		return unwrap(await authFetch(`/api/tenants/${id}/terms`));
	},
	/** What each creation step did (super_admin). `recorded: false` = created before the record. */
	async tenantProvisioning(
		id: string
	): Promise<{ tenantId: string; provisioning: ProvisioningView; licenceBundles?: LicenceBundleResult[] }> {
		return unwrap(await authFetch(`/api/tenants/${id}/provisioning`));
	},
	/** Ensure licences bundles on an existing workspace now (super_admin), idempotently. A refused
	 *  bundle is a RESULT (`status: 'failed'`), not an error. Errors: 404 `tenant_not_found`; 409
	 *  `tenant_offboarded` | `provisioning_step_busy`; 422 validation. */
	async ensureLicenceBundles(
		id: string,
		bundles: string[]
	): Promise<{
		tenantId: string;
		results: LicenceBundleResult[];
		licenceBundles: LicenceBundleResult[];
		provisioning: ProvisioningView;
	}> {
		return unwrap(await authFetch(`/api/tenants/${id}/licence-bundles`, json('POST', { bundles })));
	},
	/** Re-run ONE creation step now (super_admin) with the inputs held since create.
	 *  Errors: 409 `provisioning_step_busy` | `tenant_offboarded`; 404 `provisioning_step_unknown`. */
	async retryProvisioning(
		id: string,
		step: ProvisioningStep
	): Promise<{
		tenantId: string;
		step: ProvisioningStep;
		record: ProvisioningStepRecord;
		invite?: CreatedInvite;
		provisioning: ProvisioningView;
	}> {
		return unwrap(await authFetch(`/api/tenants/${id}/provisioning/${step}/retry`, json('POST', {})));
	},
	/** A tenant's money budget (billing) + seat usage (tenant_admin, or super_admin acting in). */
	async tenantBudget(id: string, activeTenantId?: string): Promise<TenantBudgetResponse> {
		return unwrap(await authFetch(`/api/tenants/${id}/budget`, withActiveTenant({}, activeTenantId)));
	},
	/** The tenant's member roster with each member's CP `tenant_role`. */
	async members(
		tenantId: string,
		activeTenantId?: string
	): Promise<{ members: Member[] }> {
		return unwrap(await authFetch(`/api/tenants/${tenantId}/members`, withActiveTenant({}, activeTenantId)));
	},
	/** Tenant-admin: INVITE someone into this tenant. Nobody is seated until they accept; an
	 *  existing pending invite for the same email is resent and returned instead of a 409. */
	async inviteMember(
		tenantId: string,
		body: { email: string; role: TenantRole; name?: string; firstName?: string; lastName?: string },
		activeTenantId?: string
	): Promise<{ invite: CreatedInvite }> {
		return unwrap(
			await authFetch(`/api/tenants/${tenantId}/users`, withActiveTenant(json('POST', body), activeTenantId))
		);
	},
	/** Tenant-admin: this tenant's invitations. */
	async tenantInvites(tenantId: string, activeTenantId?: string): Promise<{ invites: InviteView[] }> {
		return unwrap(await authFetch(`/api/tenants/${tenantId}/invites`, withActiveTenant({}, activeTenantId)));
	},
	async resendInvite(tenantId: string, inviteId: string, activeTenantId?: string): Promise<{ invite: CreatedInvite }> {
		return unwrap(
			await authFetch(
				`/api/tenants/${tenantId}/invites/${inviteId}/resend`,
				withActiveTenant(json('POST', {}), activeTenantId)
			)
		);
	},
	/** Revoke a pending invite. 204 — nothing to unwrap on success. */
	async revokeInvite(tenantId: string, inviteId: string, activeTenantId?: string): Promise<void> {
		const res = await authFetch(
			`/api/tenants/${tenantId}/invites/${inviteId}`,
			withActiveTenant({ method: 'DELETE' }, activeTenantId)
		);
		if (!res.ok) await unwrap(res);
	},
	/** Tenant-admin: set a member's CP role. 409 `last_tenant_admin` when demoting the last one. */
	async setMemberRole(
		tenantId: string,
		userId: string,
		role: TenantRole,
		activeTenantId?: string
	): Promise<{ userId: string; role: string }> {
		return unwrap(
			await authFetch(
				`/api/tenants/${tenantId}/users/${userId}`,
				withActiveTenant(json('PATCH', { role }), activeTenantId)
			)
		);
	},
	/** Tenant-admin: remove a member from this workspace (tombstone + seat revoke). Their Keycloak
	 *  identity is untouched — the realm is shared with fr. Self-removal is a 409. */
	async deleteTenantUser(
		tenantId: string,
		userId: string,
		activeTenantId?: string
	): Promise<{ userId: string; offboarded: boolean; invitesRevoked?: number }> {
		return unwrap(
			await authFetch(
				`/api/tenants/${tenantId}/users/${userId}`,
				withActiveTenant({ method: 'DELETE' }, activeTenantId)
			)
		);
	},
	// ---- Per-tenant Entra OIDC SSO (Phase 4 / E.1) ----

	/** This tenant's identity providers (secret never returned). */
	async ssoProviders(tenantId: string, activeTenantId?: string): Promise<{ providers: IdpProvider[] }> {
		return unwrap(await authFetch(`/api/tenants/${tenantId}/sso/providers`, withActiveTenant({}, activeTenantId)));
	},
	/** Register the tenant's Entra IdP (KC-first server-side; force-scoped to this tenant). */
	async createSsoProvider(
		tenantId: string,
		body: CreateIdpBody,
		activeTenantId?: string
	): Promise<{ provider: IdpProvider }> {
		return unwrap(
			await authFetch(`/api/tenants/${tenantId}/sso/providers`, withActiveTenant(json('POST', body), activeTenantId))
		);
	},
	async updateSsoProvider(
		tenantId: string,
		providerId: string,
		body: UpdateIdpBody,
		activeTenantId?: string
	): Promise<{ provider: IdpProvider }> {
		return unwrap(
			await authFetch(
				`/api/tenants/${tenantId}/sso/providers/${providerId}`,
				withActiveTenant(json('PATCH', body), activeTenantId)
			)
		);
	},
	async deleteSsoProvider(tenantId: string, providerId: string, activeTenantId?: string): Promise<{ ok: boolean }> {
		return unwrap(
			await authFetch(
				`/api/tenants/${tenantId}/sso/providers/${providerId}`,
				withActiveTenant({ method: 'DELETE' }, activeTenantId)
			)
		);
	},
	/** Platform: ALL tenants' identity providers (super_admin overview). */
	async allSsoProviders(): Promise<{ providers: IdpProvider[] }> {
		return unwrap(await authFetch('/api/admin/sso/providers'));
	},

	async usage(tenantId: string, rangeDays: number, activeTenantId?: string): Promise<TenantUsage> {
		return unwrap(
			await authFetch(
				`/api/tenants/${tenantId}/usage?range=${rangeDays}`,
				withActiveTenant({}, activeTenantId)
			)
		);
	},

	// ---- Controlled onboarding (Phase 4 / C.2a, super_admin) ----

	/** The signup-approval queue. `status` filters (pending/approved/rejected). */
	async signupApprovals(status?: string): Promise<SignupApprovalsResponse> {
		const q = status ? `?status=${encodeURIComponent(status)}` : '';
		return unwrap(await authFetch(`/api/signup-approvals${q}`));
	},
	async signupStats(): Promise<{ stats: SignupStats }> {
		return unwrap(await authFetch('/api/signup-approvals/stats'));
	},
	/** Approve a signup: a new workspace for the requester, or a seat in an existing one. */
	async approveSignup(
		id: string,
		body: ApproveSignupBody
	): Promise<{ approval: SignupApproval; tenantId: string; role: TenantRole; invite: CreatedInvite | null }> {
		return unwrap(await authFetch(`/api/signup-approvals/${id}/approve`, json('POST', body)));
	},
	async rejectSignup(id: string): Promise<{ approval: SignupApproval }> {
		return unwrap(await authFetch(`/api/signup-approvals/${id}/reject`, json('POST', {})));
	},
	/** Close a rejected signup's cleanup that cannot finish (failed / blocked) with a required note (super_admin).
	 *  `acknowledgeLiveAccess` is REQUIRED (422 otherwise) when the close leaves the requester's access live. */
	async resolveSignupRepair(
		id: string,
		note: string,
		acknowledgeLiveAccess = false
	): Promise<{ approval: SignupApproval }> {
		return unwrap(
			await authFetch(
				`/api/signup-approvals/${id}/resolve-repair`,
				json('POST', acknowledgeLiveAccess ? { note, acknowledgeLiveAccess: true } : { note })
			)
		);
	},
	/** Invite a person straight into early access (super_admin): records a pre-approved signup and
	 *  approves it into a NEW workspace in one step — same outcome shape as approveSignup. */
	async inviteEarlyAccess(body: InviteEarlyAccessBody): Promise<InviteEarlyAccessResponse> {
		return unwrap(await authFetch('/api/signup-approvals/invite', json('POST', body)));
	},
	/** Invite someone straight into an existing tenant (super_admin; the bootstrap path for a
	 *  tenant's first tenant_admin). Same outcome shape as a tenant admin's invite. */
	async invite(body: {
		email: string;
		tenantId: string;
		role: TenantRole;
		firstName?: string;
		lastName?: string;
	}): Promise<{ invite: CreatedInvite }> {
		return unwrap(await authFetch('/api/invites', json('POST', body)));
	},
	/** Invitations waiting for the signed-in user. */
	async myInvites(): Promise<{ invites: PendingInviteView[] }> {
		return unwrap(await authFetch('/api/me/invites'));
	},
	/** Accept an invitation by its emailed token or, from the no-workspace screen, by id. */
	/** `setupPending`: the person IS seated, but their licence is still being set up (the backend
	 *  finishes it by itself); the licence gate then reports `seat_pending`. */
	async acceptInvite(
		by: { token: string } | { inviteId: string }
	): Promise<{ tenantId: string; role: TenantRole; setupPending?: true }> {
		return unwrap(await authFetch('/api/invites/accept', json('POST', by)));
	},
	/** Corporate email-domain → tenant routing rules. */
	async emailDomains(): Promise<EmailDomainsResponse> {
		return unwrap(await authFetch('/api/email-domains'));
	},
	async upsertEmailDomain(body: {
		domain: string;
		tenantId: string;
		autoAssign?: boolean;
	}): Promise<{ domain: EmailDomainMapping }> {
		return unwrap(await authFetch('/api/email-domains', json('POST', body)));
	},
	async deleteEmailDomain(domain: string): Promise<{ ok: boolean }> {
		return unwrap(await authFetch(`/api/email-domains/${encodeURIComponent(domain)}`, { method: 'DELETE' }));
	},

	/** Open, idempotent self-signup notify. Called after login when GET /api/me reports no
	 *  workspace — records intent for the super_admin approval queue. Returns 204 with no body,
	 *  so there is nothing to unwrap. */
	async notifySelf(body: { email: string; name?: string }): Promise<void> {
		await authFetch('/api/signup-approvals/notify-self', json('POST', body));
	}
};
