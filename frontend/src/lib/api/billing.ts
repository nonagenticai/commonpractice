// src/lib/api/billing.ts — the READ client for what the customer is actually BILLED.
//
// ⛔ THIS IS NOT THE USAGE LEDGER AND THE TWO MUST NEVER BE RENDERED AS ONE FIGURE. CP's own
// `usage_events.cost_usd` (served by `adminApi.usage`) is a PRICED ESTIMATE of what the LLM calls
// cost against the tenant's own provider key. The numbers here are an INVOICE: platform fee +
// seats + BYO markup %, computed by billing-service, and the amount the customer pays. See the
// header of `backend/src/services/billing-admin.ts` for why presenting one as the other is a
// fabrication even when the arithmetic happens to agree.
//
// ⛔ A BILLING OUTAGE IS A 200 CARRYING `status: 'unavailable'`, NOT AN HTTP ERROR, AND THE FAILURE
// ARM CARRIES NO MONEY FIELDS AT ALL. `backend/src/routes/billing-view.ts` chose that shape
// deliberately over a 503 (no error copy exists for a new 503 code in any of the 8 locales) and
// over `{ totalUsd: 0 }` (a $0.00 bill is legitimate for a tenant on a free trial, so the outage
// would be indistinguishable from a real answer). The cost of the 200 is that a generic HTTP client
// reads it as success — which is exactly why callers MUST go through `billingUnavailable()` below
// rather than reaching for `.totalUsd` and hoping.
//
// ⛔ NARROW ON `payload.status === 'unavailable'`, NEVER ON `'status' in payload`. That mistake was
// already written and caught once on the backend: `BillingInvoice` HAS ITS OWN `status` field
// (paid / open / void — billing's word, not ours), so an `in` check reports every successfully-read
// invoice as an outage. Here the envelope and the invoice are at different depths, so the hazard is
// one careless refactor away rather than present — `billingUnavailable()` exists so there is one
// place to get it right.
//
// ⛔ NO `tenantId` PARAMETER ON ANY CALL, AND THAT IS THE BACKEND'S SAFETY PROPERTY RATHER THAN AN
// OVERSIGHT. Every sibling admin route in this app is `/api/tenants/:id/...`; these four are not.
// The only tenant id that exists in those handlers is the one `requireTenantAdmin` resolved, so
// there is no caller-supplied id to forget to compare. Adding a `?tenant_id=` here would not widen
// access (the backend does not read it) but it would advertise a parameter that does nothing, which
// is how the next person comes to believe the id is load-bearing.
//
// ⚠️ `GET /api/billing/invoices/:invoiceId` AND `GET /api/billing/my-usage` EXIST AND ARE
// DELIBERATELY NOT WRAPPED HERE. No screen reads them yet, and an exported method with no caller is
// a contract nobody is checking. Add each one with the screen that needs it.
import { authFetch } from './auth-fetch';
import { unwrap } from './admin';

/**
 * Why a billing read could not be answered, carried so the two are distinguishable WITHOUT reading
 * a log: `not_configured` is a gitops omission (this deployment was never wired to billing, and no
 * amount of waiting fixes it), `upstream_error` is an incident (billing is there and unwell, and
 * retrying is the right action). The screen words them differently because they send the reader to
 * two different places.
 */
/** `not_available` = billing answered 404 (backend `billing_not_available`): it has no such data /
 *  route for this workspace yet — an answer, not an outage, and never a $0 bill. */
export type BillingUnavailableReason = 'not_configured' | 'upstream_error' | 'not_available';

/**
 * A line on an invoice or a preview.
 *
 * ⛔ NOT THREE FIXED FIELDS (platform fee / seats / markup), AND A RENDERER MUST NOT ASSUME THREE.
 * Billing owns the price book and may issue a line this repo has never heard of; a screen that only
 * understood three kinds would silently DROP a fourth from a total the customer is being charged.
 * `kind` is advisory; `label` is billing's own wording and is rendered as-is — CP does not re-word
 * an invoice into its own catalog.
 */
export interface BillingLine {
	/** 'platform_fee' | 'seats' | 'byo_markup' | anything else billing issues. */
	kind: string;
	/** Billing's own human label. Rendered verbatim, never translated. */
	label: string;
	amountUsd: number;
	/** Seats, or units of whatever the line meters. Absent when the line is a flat charge. */
	quantity?: number;
	/** For a percentage line (the BYO markup), the rate applied. Absent otherwise. */
	ratePct?: number;
}

/**
 * The failure arm. ⛔ NOTE WHAT IS MISSING: no `totalUsd`, no `lines`, no `invoices`. A naive
 * consumer that ignored `status` would read `undefined` and render blank or NaN — visibly wrong —
 * rather than `0`, which renders as a number the customer will believe.
 */
export interface BillingUnavailable {
	status: 'unavailable';
	reason: BillingUnavailableReason;
	/** Upstream HTTP status when there was one, for an operator reading a HAR. */
	upstreamStatus?: number;
	message: string;
	/** Echoed by `/preview` on BOTH arms: a reader told the bill is unknown still needs the month. */
	period?: string;
}

export interface BillingPreviewOk {
	status: 'ok';
	tenantId: string;
	/** `YYYY-MM`, the CURRENT UTC month. Not caller-selectable — past periods are `invoices()`. */
	period: string;
	currency: string;
	totalUsd: number;
	lines: BillingLine[];
	/** Billing's own statement of how far through the period this preview is measured. */
	asOf?: string;
	/** Prepaid credit applied this period so far (USD) — ALREADY deducted from `totalUsd`. */
	prepaidCreditAppliedUsd?: number;
	/** LIVE credit remaining (USD) incl. this month's usage so far — provisional until the month closes. */
	prepaidCreditRemainingUsd?: number;
}

export interface BillingInvoice {
	id: string;
	tenantId: string;
	period: string;
	/** ⚠️ BILLING'S WORD, NOT THE ENVELOPE'S — see the ⛔ narrowing block at the top of this file. */
	status: string;
	currency: string;
	totalUsd: number;
	lines: BillingLine[];
	issuedAt?: string;
	dueAt?: string;
	/** Prepaid credit applied to this invoice (USD) — ALREADY deducted from `totalUsd`. */
	prepaidCreditAppliedUsd?: number;
	/** The statement exists but billing's row could not be read: shown WITHOUT an amount
	 *  (`totalUsd` arrives as null — never render it). */
	detailsUnavailable?: true;
}

export interface BillingInvoicesOk {
	status: 'ok';
	/** ⚠️ ABSENT on the unavailable arm, never `[]`. An empty list renders as "you have never been
	 *  invoiced", which is the list-shaped spelling of the $0.00 bill this contract refuses. */
	invoices: BillingInvoice[];
}

export type BillingPreviewResponse = BillingPreviewOk | BillingUnavailable;
export type BillingInvoicesResponse = BillingInvoicesOk | BillingUnavailable;

/**
 * The ONE narrowing. Use it everywhere; do not re-spell it at a call site.
 *
 * Written against `status === 'unavailable'` rather than `!== 'ok'` on purpose: a response from a
 * pod older than this contract carries no `status` at all, and treating "I do not recognise this"
 * as an outage would caption a working screen with an incident that is not happening. An
 * unrecognised shape falls through to the ok-arm and renders `undefined` — blank, visibly wrong,
 * and never a fabricated zero.
 */
export function billingUnavailable(
	payload: BillingPreviewResponse | BillingInvoicesResponse | null
): BillingUnavailable | null {
	return payload != null && payload.status === 'unavailable' ? payload : null;
}

export const billingApi = {
	/** `GET /api/billing/preview` — this period's platform fee + seats + BYO markup, from billing. */
	async preview(): Promise<BillingPreviewResponse> {
		return unwrap(await authFetch('/api/billing/preview'));
	},
	/** `GET /api/billing/invoices` — this tenant's ISSUED invoices, newest first. */
	async invoices(): Promise<BillingInvoicesResponse> {
		return unwrap(await authFetch('/api/billing/invoices'));
	}
};
