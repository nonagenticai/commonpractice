// src/lib/admin/tenant-labels.ts — the copy shared by the platform tenant list
// ((platform)/tenants) and the per-tenant edit page ((platform)/tenants/[id]).
//
// Kept apart from license-chip.ts / licence-terms.ts on purpose: those decide WHAT HAPPENS and stay
// free of paraglide so they run under vitest's node env without a mock; this module only maps
// those decisions to words, so both screens say the same thing for the same state.
import * as m from '$lib/paraglide/messages';
import type { LicenseChipLabel } from '$lib/admin/license-chip';
import type { ByoMode, LicencePlan, TenantLicenceStatus } from '$lib/types/admin';
import { num } from '$lib/utils/format';

export const LICENSE_CHIP_LABEL: Record<LicenseChipLabel, () => string> = {
	ok: m.admin_tenants_license_ok,
	missing: m.admin_tenants_license_missing,
	not_active: m.admin_tenants_license_not_active,
	cannot_verify: m.admin_tenants_license_unknown
};

export const LICENSE_CHIP_HINT: Record<LicenseChipLabel, () => string> = {
	ok: m.admin_tenants_license_reissue_hint,
	missing: m.admin_tenants_license_hint,
	not_active: m.admin_tenants_license_not_active_hint,
	cannot_verify: m.admin_tenants_license_unknown_hint
};

export const LICENCE_STATUS_LABEL: Record<TenantLicenceStatus, () => string> = {
	active: m.admin_licence_status_active,
	expired: m.admin_licence_status_expired,
	suspended: m.admin_licence_status_suspended,
	offboarded: m.admin_licence_status_offboarded,
	unlicensed: m.admin_licence_status_unlicensed
};

/** The BYO / LLM-access postures, in the order the selects list them. */
export const BYO_MODES: readonly ByoMode[] = ['byo_required', 'local_allowed', 'platform_only'];

export const BYO_MODE_LABEL: Record<ByoMode, () => string> = {
	byo_required: m.admin_tenants_byo_required,
	local_allowed: m.admin_tenants_byo_local_allowed,
	platform_only: m.admin_tenants_byo_platform_only
};

/**
 * What each posture MEANS, in plain words — which LLMs the workspace may call, who pays, and
 * whether it must bring its own key. Derived from the code, not from the labels:
 *  · byo_required — `services/byo-posture.ts assertPlatformCredentialAllowed` refuses every
 *    platform credential (403 `llm_byo_key_required`); the customer pays the provider and is
 *    invoiced only a markup on that spend.
 *  · local_allowed — the licences default for a new tenant (licences migration 042, CP
 *    `NEW_TENANT_BYO_MODE`): the platform model/key may be used; a key of the tenant's own, when
 *    configured, is used instead (`ai/llm/select.ts resolveChatProvider`).
 *  · platform_only — licences migration 007 (demo/trial): locked to platform inference.
 *    worker_management ignores a stored external provider row and refuses to save one; CP does
 *    the same (`ai/llm/select.ts` ignores a `tenant_byo` row, `routes/llm-settings.ts` refuses to
 *    store a key with 403 `llm_byo_disabled`). A platform-funded welcome budget is still used.
 * `''` = licences could not be read; the editor sends nothing for it.
 */
export function byoModeHelp(mode: ByoMode | ''): string {
	switch (mode) {
		case 'byo_required':
			return m.admin_tenants_byo_help_byo_required();
		case 'local_allowed':
			return m.admin_tenants_byo_help_local_allowed();
		case 'platform_only':
			return m.admin_tenants_byo_help_platform_only();
		default:
			return m.admin_tenants_byo_help_unknown();
	}
}

/** The selected plan's limits as one line ("Requests per minute: 60 · …"), from the plans list. */
export function planLimitsText(plan: LicencePlan, locale: string): string {
	const val = (n: number | null, days = false) =>
		n === null ? m.admin_plans_unlimited() : days ? m.admin_plans_days({ count: num(n, locale) }) : num(n, locale);
	const items: [string, string][] = [
		[m.admin_plans_duration(), val(plan.durationDays, true)],
		[m.admin_plans_rpm(), val(plan.rateLimitRpm)],
		[m.admin_plans_burst(), val(plan.rateLimitBurst)],
		[m.admin_plans_quota(), val(plan.quotaMonthly)],
		[m.admin_plans_tokens(), val(plan.tokenBudgetMonthly)]
	];
	return m.admin_tenants_plan_limits({
		limits: items.map(([label, value]) => m.admin_tenants_plan_limit_item({ label, value })).join(' · ')
	});
}

/** The tenant's name in licences, when it is NOT simply its slug (`<slug>-cp…`). */
export function licencesAlias(slug: string, licencesName: string | null | undefined): string | null {
	return licencesName && licencesName !== slug ? licencesName : null;
}

/** Per-user auto-provisioned tenants carry an opaque `u-<32hex>` slug that means nothing to a human. */
export const isAutoSlug = (slug: string): boolean => /^u-[0-9a-f]{16,}$/i.test(slug);

/** The nil-UUID seed/dev tenant (backend `SYSTEM_TENANT_ID`). */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Whether a row is the platform's system tenant. The backend's flag wins; the id comparison is the
 * fallback for a backend that predates the flag (a new frontend talking to an old pod mid-roll),
 * where the editor would otherwise open and every save would 409 `system_tenant`.
 */
export function isSystemTenantRow(t: { id: string; isSystemTenant?: boolean }): boolean {
	return t.isSystemTenant ?? t.id.toLowerCase() === SYSTEM_TENANT_ID;
}
