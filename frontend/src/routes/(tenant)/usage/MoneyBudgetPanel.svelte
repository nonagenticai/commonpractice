<script lang="ts">
	// The workspace's PREPAID CREDIT (USD, billing's credit ledger) and, separately, its money-budget
	// CAP — both from GET /api/tenants/:id/budget. They replaced the retired OpenRouter welcome budget
	// (backend migration 0099). Props only, no fetching: every state is testable by handing it in.
	//
	// ⛔ "NONE" IS NOT "UNLIMITED". `none` = billing holds no money budget for the workspace; it is
	// said as such, never rendered as an empty meter or a $0 allowance. The credit needs no budget.
	import { num } from '$lib/utils/format';
	import type { MoneyBudget, MoneyBudgetState, PrepaidCredit } from '$lib/types/admin';
	import * as m from '$lib/paraglide/messages';

	let {
		loading = false,
		budget = null,
		budgetState = 'none',
		credit = null,
		creditState = 'none',
		liveRemainingUsd,
		locale,
		onTopUp,
		topupBusy = false,
		topupMessage = null,
		topupUnavailable = false
	}: {
		loading?: boolean;
		budget?: MoneyBudget | null;
		budgetState?: MoneyBudgetState;
		credit?: PrepaidCredit | null;
		creditState?: MoneyBudgetState;
		/** The invoice preview's LIVE credit remaining (incl. this month's usage so far), when known. */
		liveRemainingUsd?: number;
		locale: string;
		/** Buy prepaid credit; absent = the reader may not (not a tenant_admin). */
		onTopUp?: (amount: number) => Promise<void>;
		topupBusy?: boolean;
		topupMessage?: { kind: 'ok' | 'error'; text: string } | null;
		/** Billing answered "no money budget / not enabled" — say so instead of offering a dead button. */
		topupUnavailable?: boolean;
	} = $props();

	let amountText = $state('');
	const amount = $derived(/^\d{1,7}$/.test(amountText.trim()) ? Number(amountText.trim()) : NaN);
	const canTopUp = $derived(
		Boolean(onTopUp) && !topupUnavailable && Number.isInteger(amount) && amount >= 1 && !topupBusy
	);
	async function submitTopUp() {
		if (!canTopUp || !onTopUp) return;
		await onTopUp(amount);
		amountText = '';
	}

	const money = (n: number, currency: string) =>
		new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
	/** Credit left can never be shown below $0: a negative figure from billing is an anomaly (the
	 *  backend logs it as `billing_credit_negative`), never a debt to show the reader. */
	const left = (n: number) => money(Math.max(0, n), 'USD');
	const pct = $derived(budget && budget.amount > 0 ? Math.min(100, (budget.consumed / budget.amount) * 100) : 0);
</script>

<div class="card money-budget" data-testid="money-budget">
	<div class="title">{m.usage_credit_title()}</div>
	{#if loading}
		<p class="hint">{m.billing_loading()}</p>
	{:else if credit && creditState === 'ok'}
		<!-- ⛔ THE LIVE FIGURE FIRST. The ledger's `remainingUsd` counts CLOSED months only; the invoice
		     preview's figure includes this month's usage so far, which is what the reader can spend. -->
		{#if liveRemainingUsd !== undefined}
			<p class="figures" data-testid="money-credit-live">
				{m.usage_credit_remaining_live({ remaining: left(liveRemainingUsd) })}
			</p>
		{:else}
			<p class="figures" data-testid="money-credit-remaining">
				{m.usage_credit_remaining({ remaining: left(credit.remainingUsd) })}
			</p>
		{/if}
		<p class="hint" data-testid="money-credit-detail">
			{m.usage_credit_detail({ granted: money(credit.grantedUsd, 'USD'), drawn: money(credit.drawnUsd, 'USD') })}
		</p>
	{:else if creditState === 'none'}
		<p class="hint" data-testid="money-credit-none">{m.usage_credit_none()}</p>
	{:else}
		<p class="hint" data-testid="money-credit-unavailable">{m.usage_budget_unavailable()}</p>
	{/if}

	<div class="subtitle cap-title">{m.usage_budget_title()}</div>
	{#if loading}
		<p class="hint">{m.billing_loading()}</p>
	{:else if budget && budgetState === 'ok'}
		<p class="figures" data-testid="money-budget-figures">
			{m.usage_budget_figures({
				consumed: money(budget.consumed, budget.currency),
				amount: money(budget.amount, budget.currency)
			})}
		</p>
		<div class="meter" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin="0" aria-valuemax="100"
			aria-label={m.usage_budget_title()}>
			<div class="meter-fill" style:width="{pct}%"></div>
		</div>
		<p class="hint" data-testid="money-budget-remaining">
			{m.usage_budget_remaining({ remaining: money(budget.remaining, budget.currency), pct: num(Math.round(pct), locale) })}
		</p>
	{:else if budgetState === 'none'}
		<p class="hint" data-testid="money-budget-none">{m.usage_budget_none()}</p>
	{:else}
		<p class="hint" data-testid="money-budget-unavailable">{m.usage_budget_unavailable()}</p>
	{/if}
	{#if onTopUp}
		<div class="topup" data-testid="money-topup">
			<div class="subtitle">{m.usage_topup_title()}</div>
			<p class="hint">{m.usage_topup_help()}</p>
			{#if topupUnavailable}
				<p class="hint" data-testid="money-topup-unavailable">{m.usage_topup_unavailable()}</p>
			{:else}
				<form class="topup-row" onsubmit={(e) => { e.preventDefault(); submitTopUp(); }}>
					<label for="topup-amount">{m.usage_topup_amount_label({ currency: 'USD' })}</label>
					<input id="topup-amount" data-testid="money-topup-amount" inputmode="numeric" bind:value={amountText}
						disabled={topupBusy} placeholder="100" />
					<button class="btn-primary" type="submit" data-testid="money-topup-submit" disabled={!canTopUp}>
						{m.usage_topup_submit()}
					</button>
				</form>
			{/if}
			{#if topupMessage}
				<p class="topup-msg {topupMessage.kind}" data-testid="money-topup-message">{topupMessage.text}</p>
			{/if}
		</div>
	{:else}
		<p class="hint">{m.usage_budget_topup_help()}</p>
	{/if}
</div>

<style>
	.money-budget { margin-bottom: 16px; }
	.title { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 6px; }
	.figures { font-size: 13px; margin: 0; font-variant-numeric: tabular-nums; }
	.meter { height: 6px; border-radius: 999px; background: var(--c-surface); overflow: hidden; margin: 8px 0; }
	.meter-fill { height: 100%; background: var(--c-teal); }
	.hint { font-size: 12px; color: var(--c-muted); margin: 4px 0 0; line-height: 1.5; }
	.topup { margin-top: 12px; border-top: 1px solid var(--c-border); padding-top: 10px; }
	.subtitle { font-size: 12px; font-weight: 600; }
	.cap-title { margin-top: 10px; }
	.topup-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
	.topup-row label { font-size: 12px; }
	.topup-row input { width: 110px; }
	.topup-msg { font-size: 12px; margin: 6px 0 0; }
	.topup-msg.error { color: var(--c-coral-dark); }
	.topup-msg.ok { color: var(--c-teal); }
</style>
