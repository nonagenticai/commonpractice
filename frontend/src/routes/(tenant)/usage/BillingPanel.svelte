<script lang="ts">
	// The BILL — what Common Practice charges this workspace — as opposed to the usage ledger on the
	// rest of /usage, which is CP's own ESTIMATE of provider cost. See `$lib/api/billing.ts`.
	//
	// ⛔ THE WHOLE REASON THIS IS A SEPARATE COMPONENT WITH NO FETCHING IN IT. The one property that
	// matters here — "a zero bill and an unknown bill never render the same" — is a property of the
	// MARKUP, and it is only testable if the markup can be handed each state directly. Every state
	// arrives as a prop; the page owns the requests.
	//
	// ⛔ `usd()`, NEVER `usdMaybe()`. The tilde on the rest of this page means "priced by CP's flat
	// fallback, so this is approximate". An invoice is not approximate — it is the amount charged —
	// and hedging it would say the opposite of what this section exists to say.
	import { usd, num, pct, fullDate } from '$lib/utils/format';
	import {
		billingUnavailable,
		type BillingPreviewResponse,
		type BillingInvoicesResponse,
		type BillingLine
	} from '$lib/api/billing';
	import * as m from '$lib/paraglide/messages';

	let {
		loading = false,
		preview = null,
		invoices = null,
		/** The APP's locale, passed in — this module must not import the locale store (format.ts). */
		locale
	}: {
		loading?: boolean;
		preview?: BillingPreviewResponse | null;
		invoices?: BillingInvoicesResponse | null;
		locale: string;
	} = $props();

	const previewOut = $derived(billingUnavailable(preview));
	const invoicesOut = $derived(billingUnavailable(invoices));
	// ⛔ NARROWED OFF THE ENVELOPE'S `status`, NOT OFF THE PRESENCE OF `totalUsd`. A presence check
	// would read a mid-rollout payload that happens to omit the field as an outage, and — worse —
	// would read one that happens to carry a stray zero as a real bill.
	const previewOk = $derived(preview?.status === 'ok' ? preview : null);
	const invoiceRows = $derived(invoices?.status === 'ok' ? invoices.invoices : null);

	/** The reason sentence. Two states, two sentences: one is a config gap an operator fixes, the
	 *  other is an incident that retrying will clear. Sending the reader to the wrong one wastes
	 *  their afternoon, which is why the backend carries `reason` at all. */
	const unknownWhy = (reason: string) =>
		reason === 'not_configured'
			? m.billing_unknown_not_configured()
			: reason === 'not_available'
				? m.billing_unknown_not_available()
				: m.billing_unknown_upstream();

	/** A line's label in the reader's language. CP itemises billing's money fields into these kinds
	 *  (backend services/billing-admin.ts `itemise`); an unknown kind keeps the label it came with. */
	const LINE_LABEL: Record<string, () => string> = {
		access_charge: m.billing_line_access_charge,
		platform_fee: m.billing_line_platform_fee,
		seats: m.billing_line_seats,
		llm_usage: m.billing_line_llm_usage,
		llm_markup: m.billing_line_llm_markup,
		app_usage: m.billing_line_app_usage,
		app_markup: m.billing_line_app_markup,
		usage_other: m.billing_line_usage_other
	};
	const lineLabel = (line: BillingLine): string => LINE_LABEL[line.kind]?.() ?? line.label;

	/** Billing's own status word, localized where CP knows it and passed through where it does not.
	 *  ⚠️ The fallback renders billing's raw string rather than "unknown": a status CP has not seen
	 *  before is still a fact about the invoice, and blanking it would hide it. */
	function statusLabel(status: string): string {
		if (status === 'paid') return m.billing_invoice_status_paid();
		if (status === 'open') return m.billing_invoice_status_open();
		if (status === 'void') return m.billing_invoice_status_void();
		return status;
	}

	/** Seats, or units of whatever a line meters — and `ratePct` for the BYO markup. Rendered only
	 *  when billing sent them, so a flat line does not grow a phantom "Quantity —". */
	const lineDetail = (line: BillingLine): string[] => {
		const out: string[] = [];
		if (line.quantity != null) out.push(m.billing_line_quantity({ quantity: num(line.quantity, locale) }));
		// `pct` takes a FRACTION and multiplies by 100 itself — `ratePct` is already a percentage,
		// so it is divided back down here rather than concatenated with a hard-coded '%' (which is
		// on the wrong side of the figure in Arabic; see format.ts's `pct` block).
		if (line.ratePct != null) out.push(m.billing_line_rate({ rate: pct(line.ratePct / 100, locale) }));
		return out;
	};
</script>

<div class="section-title">{m.billing_section_title()}</div>
<p class="lede">{m.billing_section_lede()}</p>

<div class="billing-grid">
	<!-- ── current period ───────────────────────────────────────────────────────────────────── -->
	<div class="card">
		{#if loading && !preview}
			<p class="empty" data-testid="billing-preview-loading">{m.billing_loading()}</p>
		{:else if previewOut}
			<!-- ⛔ THE UNKNOWN STATE. No figure, no currency glyph, no total row — deliberately. The
			     requirement is not "label the zero", it is that no number appears at all, because a
			     number on this panel is a claim about what the customer owes and nothing here knows
			     it. The heading says UNKNOWN in its own words before the reason sentence explains
			     which kind of unknown it is. -->
			<div class="unknown" role="status" data-testid="billing-preview-unknown">
				<div class="unknown-head">{m.billing_unknown_heading()}</div>
				<p>{unknownWhy(previewOut.reason)}</p>
				{#if previewOut.period}
					<p class="period">{m.billing_preview_title({ period: previewOut.period })}</p>
				{/if}
			</div>
		{:else if previewOk}
			<div class="card-head">
				<span>{m.billing_preview_title({ period: previewOk.period })}</span>
				{#if previewOk.asOf}
					<span class="asof">{m.billing_preview_asof({ asOf: fullDate(previewOk.asOf, locale) })}</span>
				{/if}
			</div>
			<!-- Every line billing issued, in billing's own words. ⛔ NOT a fixed platform-fee /
			     seats / markup triple: a fourth line kind would be dropped from a total the customer
			     is charged. See the ⛔ block on `BillingLine`. -->
			{#each previewOk.lines as line, i (`${line.kind}-${i}`)}
				<div class="line">
					<span class="line-label">
						{lineLabel(line)}
						{#if lineDetail(line).length}
							<span class="line-detail">{lineDetail(line).join(' · ')}</span>
						{/if}
					</span>
					<span class="line-amount">{usd(line.amountUsd, locale)}</span>
				</div>
			{/each}
			<!-- Prepaid credit is ALREADY deducted from the total (billing #267): shown as its own line so
			     the lines above and the total below still reconcile for the reader. -->
			{#if previewOk.prepaidCreditAppliedUsd}
				<div class="line" data-testid="billing-preview-credit-applied">
					<span class="line-label">{m.billing_credit_applied()}</span>
					<span class="line-amount">−{usd(previewOk.prepaidCreditAppliedUsd, locale)}</span>
				</div>
			{/if}
			<div class="line total">
				<span class="line-label">{m.billing_total()}</span>
				<span class="line-amount" data-testid="billing-preview-total">{usd(previewOk.totalUsd, locale)}</span>
			</div>
		{/if}
	</div>

	<!-- ── issued invoices ──────────────────────────────────────────────────────────────────── -->
	<div class="col">
		<div class="section-title sub">{m.billing_invoices_title()}</div>
		<div class="card">
			{#if loading && !invoices}
				<p class="empty" data-testid="billing-invoices-loading">{m.billing_loading()}</p>
			{:else if invoicesOut}
				<!-- ⛔ DISTINCT FROM THE EMPTY STATE BELOW, WHICH IS THE ENTIRE POINT. "No invoices have
				     been issued" is an answer; "we could not ask" is not, and a list that renders empty
				     on failure tells a customer they have never been billed. -->
				<div class="unknown" role="status" data-testid="billing-invoices-unknown">
					<div class="unknown-head">{m.billing_unknown_heading()}</div>
					<p>{unknownWhy(invoicesOut.reason)}</p>
				</div>
			{:else if invoiceRows && invoiceRows.length === 0}
				<p class="empty" data-testid="billing-invoices-empty">{m.billing_invoices_empty()}</p>
			{:else if invoiceRows}
				{#each invoiceRows as inv (inv.id)}
					<div class="line">
						<span class="line-label">
							{inv.period}
							<span class="line-detail">
								{statusLabel(inv.status)}{#if inv.issuedAt} · {m.billing_invoice_issued({ date: fullDate(inv.issuedAt, locale) })}{/if}
							</span>
							{#if inv.prepaidCreditAppliedUsd}
								<span class="line-detail" data-testid="billing-invoice-credit-applied">
									{m.billing_invoice_credit_applied({ amount: usd(inv.prepaidCreditAppliedUsd, locale) })}
								</span>
							{/if}
						</span>
						{#if inv.detailsUnavailable}
							<span class="line-detail" data-testid="billing-invoice-unavailable">{m.billing_invoice_details_unavailable()}</span>
						{:else}
							<span class="line-amount">{usd(inv.totalUsd, locale)}</span>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>

<style>
	.section-title { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin: 4px 0 6px; }
	.section-title.sub { margin-top: 0; }
	.lede { color: var(--c-muted); font-size: 12.5px; margin: 0 0 12px; max-width: 720px; }
	.billing-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 22px; align-items: start; margin-bottom: 26px; }
	.col { min-width: 0; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 6px 0; }
	.card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 10px 18px; font-size: 12.5px; font-weight: 600; color: var(--c-ink); border-bottom: 1px solid var(--c-border); }
	.card-head .asof { font-weight: 400; font-size: 11.5px; color: var(--c-muted); }
	.line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--c-surface); font-size: 13px; }
	.line:last-child { border-bottom: none; }
	.line.total { border-top: 1px solid var(--c-border); border-bottom: none; font-weight: 600; color: var(--c-midnight); }
	.line-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.line-detail { font-size: 11.5px; color: var(--c-muted); }
	.line-amount { font-variant-numeric: tabular-nums; white-space: nowrap; }
	.empty { color: var(--c-muted); font-size: 12.5px; padding: 16px; text-align: center; margin: 0; }
	/* Amber rather than red: an unknown bill is not an error the reader caused, and it is not a
	   failure of this page — but it must not read as an ordinary empty state either. */
	.unknown { padding: 14px 18px; background: var(--c-amber-pale, var(--c-surface)); border-radius: var(--r); }
	.unknown-head { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 4px; }
	.unknown p { margin: 0 0 4px; font-size: 12.5px; color: var(--c-muted); }
	.unknown p:last-child { margin-bottom: 0; }
	.unknown .period { font-weight: 600; color: var(--c-ink); }
	@media (max-width: 900px) { .billing-grid { grid-template-columns: 1fr; } }
</style>
