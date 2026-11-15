// src/lib/admin/billing-terms.ts — the plan → BYO-posture rule and the billing-terms form parser.
// Pure, so vitest can pin them without a component (the backend twin is services/plan-posture.ts
// and services/tenant-terms.ts).
import type { ByoMode, TenantTerms } from '$lib/types/admin';
import * as m from '$lib/paraglide/messages';

export const LOCAL_LLM_PLAN = 'local-llm';
export const BYO_PLAN = 'byo';
/** The plan a workspace created from Platform → Tenants gets when none is chosen (backend twin:
 *  `NEW_TENANT_PLAN`, services/plan-posture.ts): the platform's local model, so a new organisation
 *  can use the product on day one. Not the deployment default (`defaultPlanCode`), which only
 *  describes existing workspaces with no stored plan. */
export const NEW_TENANT_PLAN = LOCAL_LLM_PLAN;

/** The posture a plan FIXES (the backend refuses a contradiction), or null when it is free. */
export function planFixedByo(planCode: string | null | undefined): ByoMode | null {
	if (planCode === LOCAL_LLM_PLAN) return 'local_allowed';
	if (planCode === BYO_PLAN) return 'byo_required';
	return null;
}

/**
 * The posture the BYO select should show for `planCode`: the one the plan FIXES, else the one the
 * operator last chose THEMSELVES. ⛔ Not "whatever the select last held": switching standard → byo →
 * standard used to leave `byo_required` behind, so the next save sent a posture nobody chose.
 */
export function postureFor<T extends ByoMode | ''>(planCode: string | null | undefined, chosen: T): ByoMode | T {
	return planFixedByo(planCode) ?? chosen;
}

/** What the selected plan MEANS, in plain words; `null` for a plan with no specific help. */
export function planHelp(planCode: string | null | undefined): string | null {
	if (planCode === LOCAL_LLM_PLAN) return m.admin_plan_help_local_llm();
	if (planCode === BYO_PLAN) return m.admin_plan_help_byo();
	return null;
}

/** The three fields as typed (strings, so an empty box is distinguishable from 0). */
export interface TermsDraft {
	platformFee: string;
	seatFee: string;
	markup: string;
}

export const EMPTY_TERMS_DRAFT: TermsDraft = { platformFee: '', seatFee: '', markup: '' };

/** The standard rate card as a draft (CP's markup term is billing's BYO markup). */
export function rateCardToDraft(r: { platformFeeUsd: number; seatFeeUsd: number; byoMarkupPct: number }): TermsDraft {
	return { platformFee: String(r.platformFeeUsd), seatFee: String(r.seatFeeUsd), markup: String(r.byoMarkupPct) };
}

export function termsToDraft(t: TenantTerms | null | undefined): TermsDraft {
	if (!t) return { ...EMPTY_TERMS_DRAFT };
	return { platformFee: String(t.platformFeeUsd), seatFee: String(t.seatFeeUsd), markup: String(t.markupPct) };
}

export type TermsParse =
	| { ok: true; terms: TenantTerms | null }
	| { ok: false };

/**
 * All three empty → `terms: null` (none stated). Otherwise ALL three must parse to a number ≥ 0 —
 * a half-filled form is refused rather than sending a 0 the operator never typed (any of the three
 * may legitimately BE 0, so "blank means 0" would hide a forgotten field as a free one).
 */
export function parseTermsDraft(d: TermsDraft): TermsParse {
	const vals = [d.platformFee, d.seatFee, d.markup];
	if (vals.every((v) => v.trim() === '')) return { ok: true, terms: null };
	// Deliberately STRICTER than parseMoney: no thousands separators at all (a fee or a percentage
	// typed as `1.234` is ambiguous between conventions and is refused, never guessed), and 0 is legal.
	const nums = vals.map((v) => {
		const t = v.trim().replace(/[%$\s\u00a0\u202f]/g, '');
		if (!/^\d+([.,]\d{1,2})?$/.test(t)) return null;
		return Number(t.replace(',', '.'));
	});
	if (nums.some((n) => n === null || !Number.isFinite(n) || n < 0)) return { ok: false };
	const [platformFeeUsd, seatFeeUsd, markupPct] = nums as number[];
	const cents = (n: number) => Math.round(n * 100) / 100;
	return {
		ok: true,
		terms: { platformFeeUsd: cents(platformFeeUsd!), seatFeeUsd: cents(seatFeeUsd!), markupPct: cents(markupPct!) }
	};
}
