<script lang="ts">
	// Usage & spend — brokered LLM usage for the active tenant (Phase 2-D). Every number
	// is a real aggregate over the append-only usage_events ledger. Backend:
	// /api/tenants/:id/usage?range=. Tenant-admin gated server-side AND license-gated
	// (moved off the license-exempt /api/admin/* prefix — it is tenant-facing, not platform).
	import { onMount } from 'svelte';
	import { adminApi, ApiError } from '$lib/api/admin';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import type { MoneyBudget, MoneyBudgetState, PrepaidCredit, TenantUsage } from '$lib/types/admin';
	import { createTopupIntent } from '$lib/billing/topup-intent';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import BarRow from '$lib/components/ops/BarRow.svelte';
	import BillingPanel from './BillingPanel.svelte';
	import MoneyBudgetPanel from './MoneyBudgetPanel.svelte';
	import {
		billingApi,
		type BillingPreviewResponse,
		type BillingInvoicesResponse,
		type BillingUnavailable
	} from '$lib/api/billing';
	import { usdMaybe, num, dayMonth } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import { buildUsageCsv, usageCsvFilename } from '$lib/utils/usage-csv';
	import * as m from '$lib/paraglide/messages';

	const RANGES = [7, 30, 90] as const;
	const MODEL_COLORS = ['var(--c-teal)', 'var(--c-violet)', 'var(--c-amber)', 'var(--c-coral)', 'var(--c-teal-mid)'];

	let loading = $state(true);
	// ⛔ `denied` and `loadError` ARE FIRST-LOAD STATE ONLY. Both render inside the `{#if denied}
	// {:else if loading}{:else if loadError}{:else if data}` chain below, whose LAST branch holds the
	// entire body of this page — the four stat cards, the by-model bars, the calls/day sparkline and
	// the by-member table. That is correct while there is nothing to protect, and only then. See
	// `refreshError`.
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	// ⛔ A FAILURE ON A PAGE THAT IS ALREADY LOADED — the slot this page did not have. Routing a
	// failed REFRESH into `loadError` (or a mid-session 401 into `denied`) sent it into the chain
	// above, and the chain's sibling branch is the body: a transient 500 or an expired session on an
	// ordinary range click DESTROYED the numbers a tenant admin was reading in order to announce that
	// re-reading them had failed. `data` was never cleared — the figures were still in memory, the
	// chain simply refused to render them. So this renders ABOVE the chain and the body stays up.
	// Same shape, same reasoning as `audit/+page.svelte`'s `refreshError`.
	let refreshError = $state<string | null>(null);
	let range = $state<number>(30);
	// The range the figures ON SCREEN were fetched for (audit's `loadedKey`). The chips keep
	// reflecting INTENT the moment they are clicked, so without this the reader gets 90-day numbers
	// under a 7-day chip with nothing saying so — a silent body instead of a blank one, which is
	// worse. `null` until the first load lands.
	let loadedRange = $state<number | null>(null);
	let data = $state<TenantUsage | null>(null);
	let activeTenantId = $state<string | null>(null);

	// ──────────────────────────────────────────────────────────────────────────────────────────────
	// THE BILL — fetched INDEPENDENTLY of everything above it.
	//
	// ⛔ TWO SOURCES, TWO REQUESTS, TWO FATES, ON PURPOSE. Every other figure on this page is CP's
	// own PRICED ESTIMATE of provider cost, out of the `usage_events` ledger. These come from
	// billing-service and are what the customer is CHARGED. Different systems, so either can be down
	// while the other is fine: folding them into `load()` would mean a billing outage blanking the
	// usage ledger, or — worse — a failed usage query hiding the bill behind a caption about usage.
	//
	// ⛔ AND THEY DO NOT SHARE THE RANGE CHIPS. A bill has a billing PERIOD that billing owns; the
	// 7/30/90 controls above must never appear to change it, which is why `loadBilling` takes no
	// range and is not re-run by `setRange`.
	let billingLoading = $state(true);
	let preview = $state<BillingPreviewResponse | null>(null);
	let invoices = $state<BillingInvoicesResponse | null>(null);
	// ⛔ A 401/403 IS NOT AN OUTAGE AND MUST NOT RENDER AS ONE. "You may not see this workspace's
	// bill" is an ANSWER; dressing it as "billing could not be reached" sends the reader hunting for
	// an incident that is not happening. The section is withdrawn instead of being captioned.
	let billingDenied = $state(false);
	// The workspace's money budget (billing). Its own read, for the same isolation reason as above.
	let budgetLoading = $state(true);
	let moneyBudget = $state<MoneyBudget | null>(null);
	let moneyBudgetState = $state<MoneyBudgetState>('none');
	let budgetDenied = $state(false);
	let credit = $state<PrepaidCredit | null>(null);
	let creditState = $state<MoneyBudgetState>('none');
	// ONE idempotency key per top-up intent: a retry of the same amount — also after a reload —
	// reuses it, so billing replays instead of charging twice (lib/billing/topup-intent.ts).
	const topupIntent = createTopupIntent(() => budgetTenantId);

	// Prepaid-credit top-up. The control is offered to a tenant_admin; the backend is the gate
	// (requireTenantAdmin), and a member who reaches it gets its 403 as a message.
	let topupBusy = $state(false);
	let topupMessage = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let topupUnavailable = $state(false);
	let budgetTenantId = $state<string | null>(null);
	async function topUp(amount: number) {
		if (!budgetTenantId || topupBusy) return;
		topupBusy = true;
		topupMessage = null;
		const idempotencyKey = topupIntent.keyFor(amount);
		try {
			const res = await adminApi.topUp(budgetTenantId, { amount, idempotencyKey });
			topupIntent.confirmed(amount);
			if (res.credit) {
				credit = res.credit;
				creditState = 'ok';
			}
			topupMessage = {
				kind: 'ok',
				text: res.balanceKnown === false ? m.usage_topup_done_balance_unknown() : m.usage_topup_done()
			};
			// The LIVE credit figure is the invoice preview's: re-read the bill and the credit so the
			// screen does not keep showing the pre-top-up balance.
			void loadBilling();
			void loadMoneyBudget();
		} catch (e) {
			if (e instanceof ApiError && e.code === 'billing_topup_unavailable') topupUnavailable = true;
			topupMessage = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			topupBusy = false;
		}
	}

	async function loadMoneyBudget() {
		budgetLoading = true;
		try {
			const id = activeTenantId ?? (await adminApi.currentTenant()).tenant.id;
			budgetTenantId = id;
			const res = await adminApi.tenantBudget(id);
			moneyBudget = res.budget;
			moneyBudgetState = res.budgetState ?? (res.budget ? 'ok' : 'none');
			credit = res.credit ?? null;
			creditState = res.creditState ?? (res.credit ? 'ok' : 'none');
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) budgetDenied = true;
			else moneyBudgetState = 'upstream_error';
		} finally {
			budgetLoading = false;
		}
	}

	/**
	 * A failure the BACKEND could not describe for itself, mapped onto the same shape it uses.
	 *
	 * ⛔ SYNTHESISED HERE RATHER THAN GIVEN ITS OWN BRANCH, AND IT IS NOT LAZINESS. The 200-with-a-
	 * `reason` contract covers what `billing-view.ts` can see. A dropped connection, a proxy timeout,
	 * a 500 or an unparseable body are failures it cannot — and they mean exactly the same thing to
	 * the person reading this panel: THE AMOUNT DUE IS UNKNOWN. One meaning, one rendering path.
	 * ⚠️ `upstream_error` and never `not_configured`: a transport failure says nothing about whether
	 * this deployment is wired to billing, and claiming a config gap would send an operator to edit
	 * gitops over what is probably a blip.
	 */
	const upstreamUnknown = (message: string): BillingUnavailable => ({
		status: 'unavailable',
		reason: 'upstream_error',
		message
	});

	async function loadBilling() {
		billingLoading = true;
		// `allSettled`, not `all`: the preview and the invoice list are separate reads and one being
		// unavailable says nothing about the other. `all` would discard a perfectly good invoice
		// history because the current period's preview failed.
		const [p, i] = await Promise.allSettled([billingApi.preview(), billingApi.invoices()]);
		const refused = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403);
		if ((p.status === 'rejected' && refused(p.reason)) || (i.status === 'rejected' && refused(i.reason))) {
			billingDenied = true;
			billingLoading = false;
			return;
		}
		// A 404 `billing_not_available` is an ANSWER (billing has nothing for this workspace yet), not
		// an outage: it gets its own sentence instead of "billing could not be reached".
		const unknown = (e: unknown): BillingUnavailable =>
			e instanceof ApiError && e.code === 'billing_not_available'
				? { status: 'unavailable', reason: 'not_available', message: '' }
				: upstreamUnknown(errorText(e, m.error_load_failed()));
		preview = p.status === 'fulfilled' ? p.value : unknown(p.reason);
		invoices = i.status === 'fulfilled' ? i.value : unknown(i.reason);
		billingLoading = false;
	}

	const maxModelSpend = $derived(Math.max(1e-9, ...(data?.byModel ?? []).map((x) => x.spendUsd)));

	// Whether ANY spend in this range was priced by the flat fallback or predates price_source
	// (migration 0053). One such call makes every aggregate on the page approximate, so the tilde
	// is all-or-nothing per range rather than per figure. When it is false, these numbers came from
	// published per-model rates or the provider's own reported charge and should NOT be hedged.
	//
	// ⚠️ OPTIONAL-CHAINED THROUGH `stats` AND `pricing`, NOT JUST `data`. `UsageStats.pricing` is
	// non-optional in `lib/types/admin.ts`, so the compiler is satisfied by `data?.stats.pricing.flat`
	// — and a payload from an older pod during a rolling deploy (the field landed in migration 0053)
	// throws a TypeError INSIDE a `$derived`, which unmounts the whole screen rather than degrading.
	// The type says it cannot happen; the wire is not the type.
	const estimated = $derived(
		(data?.stats?.pricing?.flat ?? 0) > 0 || (data?.stats?.pricing?.legacy ?? 0) > 0
	);
	// Rows priced before migration 0053 — unreconstructable, so a range covering them mixes two
	// pricing regimes. Worth saying out loud rather than quietly averaging.
	const legacyCalls = $derived(data?.stats?.pricing?.legacy ?? 0);
	const dayMax = $derived(Math.max(1, ...(data?.byDay ?? []).map((d) => d.calls)));

	// Inline sparkline points (calls/day) over a 100×40 viewBox.
	const dayPoints = $derived.by(() => {
		const days = data?.byDay ?? [];
		if (days.length < 2) return '';
		return days
			.map((d, i) => `${(i / (days.length - 1)) * 100},${40 - (d.calls / dayMax) * 40}`)
			.join(' ');
	});

	// Hover readout for the calls/day chart.
	let dayHover = $state<number | null>(null);
	const dayCount = $derived(data?.byDay?.length ?? 0);
	const dayXPct = $derived(dayHover == null || dayCount < 2 ? 0 : (dayHover / (dayCount - 1)) * 100);
	function onDayMove(e: MouseEvent) {
		if (dayCount < 2) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		dayHover = Math.round(frac * (dayCount - 1));
	}
	// Rendered in UTC on purpose. The backend buckets on `date_trunc('day', …)` in the DB session
	// timezone (UTC) and ships `…T00:00:00.000Z`, so formatting browser-local shifted every label a
	// day earlier for anyone at a negative offset — the values were right, the dates were not.
	//
	// ⛔ THE TIMEZONE WAS PINNED AND THE LOCALE WAS NOT. `toLocaleDateString([], …)` reads `[]` as
	// the RUNTIME's locale, so this tooltip said "Aug 7" over a Dutch spend figure. The UTC half of
	// the argument was already right; only the language half was missing.
	const dayLabel = (iso: string, loc: string) => dayMonth(iso, loc, 'UTC');

	// ──────────────────────────────────────────────────────────────────────────────────────────────
	// ⛔ TWO REQUESTS CAN BE IN FLIGHT AT ONCE, AND BOTH OF THEM CAN SUCCEED.
	//
	// This is the rationale block at `audit/+page.svelte:49-68`, applied to the one other page in the
	// product that refetches from a control the reader can press twice. `load()` took no ticket and
	// assigned `data = await …` unconditionally, so two clicks — 90 while 7 is still out — render
	// whichever response happens to land LAST. Nothing fails; the reader gets 7-day figures under a
	// 90-day chip, or the reverse, and no part of the screen can say which.
	//
	//   · `reqSeq` — every request takes a ticket before its first await and checks it afterwards. A
	//     response whose ticket is no longer the newest belongs to a range the reader has LEFT and is
	//     dropped WHOLE: its figures, its error, and its `loading = false`.
	//   · `loadedRange` — the range the figures on screen were actually fetched for, as a value. The
	//     chips move on click and the fetch takes as long as it takes, so this is the only thing that
	//     can tell the reader the body under the new chip is still the old range's.
	//
	// ⛔ DISABLING THE CHIPS IS NOT THE GUARD, and they are deliberately left enabled. `onMount(load)`
	// can already be overlapped by a first click, a disabled attribute latches only after a flush, and
	// a control the reader cannot press is a worse answer than one whose result is correctly ordered.
	// ──────────────────────────────────────────────────────────────────────────────────────────────
	let reqSeq = 0;

	async function load() {
		const generation = ++reqSeq;
		// The range THIS request is for — read before the await, so the assignment below cannot
		// attribute a response to whatever chip the reader pressed while it was in flight.
		const requested = range;
		loading = true;
		try {
			if (!activeTenantId) {
				activeTenantId = (await adminApi.currentTenant()).tenant.id;
			}
			const resp = await adminApi.usage(activeTenantId, requested);
			if (generation !== reqSeq) return; // superseded — this is somebody else's screen now
			data = resp;
			loadedRange = requested;
			// ⛔ NOTHING IS CLEARED BEFORE THE AWAIT. These used to be reset on entry, which meant a
			// retry showed the previous range's numbers with no caveat at all while it was out. Each
			// of these stops being true only when a load SUCCEEDS, so success is where they clear.
			denied = false;
			loadError = null;
			refreshError = null;
		} catch (e) {
			if (generation !== reqSeq) return; // a range nobody is on cannot caption this screen
			const refused = e instanceof ApiError && (e.status === 401 || e.status === 403);
			if (data) {
				// ⛔ INCLUDING A 401/403. A session expiring during a range click is the likeliest way
				// this is ever reached, and `denied` replaces the whole body with one sentence. A
				// refusal over numbers that are already on screen is still just a failed refresh, so it
				// is reported like one — worded as STALENESS, because the chip has already moved and a
				// bare "that failed" would leave the reader assuming the body matches it.
				refreshError = m.admin_usage_refresh_failed({
					error: refused ? m.admin_denied() : errorText(e, m.error_load_failed())
				});
			} else if (refused) {
				// Nothing has ever loaded, so the whole-page sentence IS the whole truth here.
				denied = true;
			} else loadError = errorText(e, m.error_load_failed());
		} finally {
			if (generation === reqSeq) loading = false;
		}
	}
	onMount(() => {
		void load();
		// Not awaited after `load()` — the two are independent (see the block above), and chaining
		// them would put the bill behind however long the usage aggregates take.
		void loadBilling();
		void loadMoneyBudget();
	});

	function setRange(r: number) {
		// ⛔⛔ RE-CLICKING THE ACTIVE CHIP IS A RETRY, AND IT USED TO BE INERT.
		//
		// The bare `if (r === range) return` is correct for the case it was written for — the reader
		// clicking the chip they are already reading — and wrong for every other. Measured: 30 loaded
		// → click "7" → the request rejects → `refreshError` + the stale caveat. The 7 chip is now
		// `.active` and `.disabled === false`, so it LOOKS like the retry control, and clicking it did
		// nothing at all: usage() calls expected 3, received 2. The page sat permanently on "Refresh
		// failed…", and there was no other control on the screen that would re-issue that range.
		//
		// The early return is pre-existing; what turned it into a trap is this branch's own fix. Before
		// it, a failed refresh blanked the body and `data` stayed stale but invisible — a transient
		// wrong-looking screen. Now the body survives, so the stuck state survives with it, visibly,
		// with no exit.
		//
		// THE RULE: skip the refetch only when the screen ALREADY SHOWS this range's figures and the
		// last attempt succeeded. `loadedRange === r` is the fact half (audit's `loadedKey`); the two
		// error flags are the "and it worked" half. Anything else — a failed refresh, a first load
		// that never landed, a response still in flight — makes the click a genuine request.
		//
		// ⚠️ A CLICK DURING AN IN-FLIGHT FETCH THEREFORE ISSUES A SECOND REQUEST, on purpose.
		// `reqSeq` already discards the superseded one whole, and this is the same trade the block
		// above makes for the chips themselves: a control the reader cannot press is a worse answer
		// than one whose result is correctly ordered.
		if (r === range && loadedRange === r && !refreshError && !loadError && !denied) return;
		range = r;
		load();
	}

	// Client-side sort of the by-member table (full list, no pagination).
	type MemberSort = 'name' | 'calls' | 'spend';
	let memSortKey = $state<MemberSort>('spend');
	let memSortDir = $state<'asc' | 'desc'>('desc');
	const sortedMembers = $derived.by(() => {
		const rows = [...(data?.byMember ?? [])];
		const dir = memSortDir === 'asc' ? 1 : -1;
		return rows.sort((a, b) => {
			let c = 0;
			if (memSortKey === 'name') c = a.name.localeCompare(b.name);
			else if (memSortKey === 'calls') c = a.calls - b.calls;
			else c = a.spendUsd - b.spendUsd;
			return c * dir;
		});
	});
	function toggleMemberSort(key: MemberSort) {
		if (memSortKey === key) memSortDir = memSortDir === 'asc' ? 'desc' : 'asc';
		else { memSortKey = key; memSortDir = key === 'name' ? 'asc' : 'desc'; }
	}
	function memIndicator(key: MemberSort): string {
		if (memSortKey !== key) return '';
		return memSortDir === 'asc' ? ' ↑' : ' ↓';
	}

	// Export the current range's usage (summary + by-model + by-member) as CSV.
	// The ROWS are built by $lib/utils/usage-csv — a pure function with its own test — because this
	// file is the one artefact on the page that leaves the product, and it was previously inline
	// and untestable (it also silently discarded every model's call count). What stays here is the
	// browser plumbing only: blob → anchor → click.
	function exportCsv() {
		if (!data) return;
		// ⛔⛔ `data.rangeDays`, NEVER `range`. THIS IS THE SAME INTENT-VS-FACT SPLIT `loadedRange`
		// EXISTS FOR, ON THE ONE ARTEFACT THAT LEAVES THE BUILDING — and no failure is involved.
		//
		// `range` is what the reader last CLICKED; the chips move on click and the fetch takes as long
		// as it takes. In the ordinary in-flight window this page now renders a caveat for
		// (30-day data loaded → click "7" → screen says "showing the previous 30 days"), Export was
		// still enabled — deliberately, and a test pins that — and wrote:
		//     "summary","Total (7d)","555555","12.5000"     ← 555555 is the THIRTY-day figure
		//     commonpractice-usage-7d-2026-08-16.csv
		// A file a tenant admin forwards to finance, mislabelled, with nothing on screen wrong. The
		// caveat the page renders is precisely the admission that `range` is not what the numbers are.
		//
		// `data.rangeDays` rather than `loadedRange`: it is the server's own statement of the window it
		// aggregated, shipped WITH the figures, so it cannot drift from them even in principle. It is
		// also strictly more truthful than what was requested — `routes/admin.ts:611` CLAMPS an
		// out-of-set `range` to 30 and reports 30 back, so a request for a range the backend rejects
		// would still have been labelled with the rejected number.
		//
		// ⚠️ The contrast is `audit/+page.svelte`'s export, which re-fetches server-side and therefore
		// cannot diverge. This one serialises what is already in the browser, so it must read the
		// payload's own label.
		const exportedRange = data.rangeDays;
		const blob = new Blob([buildUsageCsv(data, sortedMembers, exportedRange)], {
			type: 'text/csv'
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = usageCsvFilename(exportedRange);
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.admin_usage_eyebrow()}</div>
			<h1>{m.admin_usage_title()}</h1>
			<p>{m.admin_usage_lede()}</p>
		</div>
		<div class="ranges">
			{#each RANGES as r (r)}
				<button class:active={range === r} onclick={() => setRange(r)}>
					{r === 7 ? m.admin_usage_range_7() : r === 30 ? m.admin_usage_range_30() : m.admin_usage_range_90()}
				</button>
			{/each}
			<button class="export-btn" onclick={exportCsv} disabled={!data}>{m.audit_export_csv()}</button>
		</div>
	</header>

	<!-- ⛔ ABOVE THE CHAIN, DELIBERATELY, and not one branch of it. Inside the chain this message
	     would be mutually exclusive with the very figures it is a caveat ON — which is the defect:
	     the reader would lose the stats, the bars and the table in order to be told that re-reading
	     them failed. `role="alert"` because it appears without the reader moving focus. -->
	{#if refreshError}
		<div class="notice error" role="alert" data-testid="usage-refresh-error">{refreshError}</div>
	{/if}

	<!-- ⛔ ABOVE THE `{#if denied}…{:else if data}` CHAIN, like `refreshError` and for the same
	     reason — plus one of its own. Inside the chain, a failure to load the USAGE aggregates would
	     take the BILL off screen with it, and a tenant admin would learn nothing about what they owe
	     because an unrelated aggregate query failed. The two come from different systems and neither
	     may caption the other. -->
	{#if !budgetDenied}
		<MoneyBudgetPanel loading={budgetLoading} budget={moneyBudget} budgetState={moneyBudgetState}
			{credit} {creditState} locale={locale.current}
			liveRemainingUsd={preview?.status === 'ok' ? preview.prepaidCreditRemainingUsd : undefined}
			onTopUp={topUp} {topupBusy} {topupMessage} {topupUnavailable} />
	{/if}
	{#if !billingDenied}
		<BillingPanel loading={billingLoading} {preview} {invoices} locale={locale.current} />
	{/if}

	<!-- ⛔ `&& !data` ON ALL THREE. `data` is never cleared, so every one of these branches was
	     hiding a body that was still in memory: `loading` on every range click (the ordinary case,
	     no error anywhere), `loadError` on a failed refresh, `denied` on a session expiring
	     mid-click. The pattern is `pipeline/+page.svelte`'s.

	     ⚠️ EXACTLY ONE OF THE THREE IS LOAD-BEARING, AND IT IS `loading && !data`. Re-measured on
	     review, deliberately KEPT, and recorded here so nobody has to measure it a third time:
	       · `loading  && !data` — drop it and the ordinary range click blanks the body again. 1 red.
	       · `loadError && !data` — UNREACHABLE. 0 red.
	       · `denied   && !data` — UNREACHABLE. 0 red.
	     The two unreachable ones are unreachable because of the CATCH forty lines above, not because
	     of anything here: it routes any failure that happens while `data` is truthy into
	     `refreshError`, so `loadError`/`denied` are first-load-only by construction.

	     KEPT, in one line: the invariant "never replace a body that exists" belongs at the site that
	     renders the body, not only in the one catch that currently happens to uphold it — a future
	     caller setting `loadError` from anywhere else silently reintroduces the exact defect this
	     branch fixed, and these guards make that a no-op instead. They cost nothing and they assert
	     nothing, which is why the claim above is a measurement and not a description of coverage. -->

	{#if denied && !data}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading && !data}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError && !data}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else if data}
		<!-- ⛔ THE CHIPS SHOW INTENT, THIS SHOWS FACT. `class:active` above moves on click; the fetch
		     takes as long as it takes. Without this line the fix for the blank body would simply
		     trade it for a SILENT one — 90-day figures sitting under a 7-day chip. Rendered as a
		     plain number rather than through `num()` on purpose: the ranges are 7/30/90 and no
		     locale groups under 1000, so a formatter here would only add a way to be wrong.

		     ⛔⛔ TWO STATES, TWO SENTENCES. They shared one, and one of them was UNTRUE. "…the new
		     range has not loaded yet" says wait; after a failure nothing is loading and waiting is
		     the one thing that will never help. The reader was told to wait, next to a "Refresh
		     failed" notice, on a page whose only obvious retry control had been made inert (see
		     `setRange`). The failed variant says what actually happened AND names the recovery —
		     click the range again — which is a real instruction now rather than a lie about an
		     inert control. `refreshError` is the discriminator because it is set on exactly the
		     already-loaded-failure path this caveat coexists with. -->
		{#if loadedRange !== null && loadedRange !== range}
			<div class="notice" data-testid="usage-stale-range">
				{refreshError
					? m.admin_usage_showing_previous_failed({ days: loadedRange })
					: m.admin_usage_showing_previous({ days: loadedRange })}
			</div>
		{/if}

		<section class="stats">
			<StatCard
				label={m.admin_usage_stat_spend()}
				value={usdMaybe(data.stats.spendUsd, estimated, locale.current)}
				hint={estimated ? m.spend_estimate_hint() : m.spend_priced_hint()}
			/>
			<StatCard label={m.admin_usage_stat_calls()} value={num(data.stats.calls, locale.current)} />
			<StatCard label={m.admin_usage_stat_models()} value={num(data.stats.models, locale.current)} />
			<StatCard label={m.admin_usage_stat_members()} value={num(data.stats.members, locale.current)} />
		</section>

		{#if legacyCalls > 0}
			<div class="notice">{m.admin_usage_legacy_pricing_note({ count: num(legacyCalls, locale.current) })}</div>
		{/if}

		<div class="grid">
			<div class="col">
				<div class="section-title">{m.admin_usage_section_by_model()}</div>
				<div class="card">
					{#if data.byModel.length === 0}
						<p class="empty">{m.admin_usage_empty_model()}</p>
					{:else}
						{#each data.byModel as mdl, i (mdl.model)}
							<!-- Per-model, so hedge per model: a row priced entirely from published rates is
							     exact even when other rows in the range are not. -->
							<BarRow label={mdl.model} value={usdMaybe(mdl.spendUsd, mdl.estimated, locale.current)} pct={Math.round((mdl.spendUsd / maxModelSpend) * 100)} color={MODEL_COLORS[i % MODEL_COLORS.length]} />
						{/each}
					{/if}
				</div>

				<div class="section-title">{m.admin_usage_section_by_day()}</div>
				<div class="card">
					<div class="spark-wrap" role="img" aria-label={m.admin_usage_section_by_day()} onmousemove={onDayMove} onmouseleave={() => (dayHover = null)}>
						<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none">
							{#if dayPoints}
								<polyline points={dayPoints} fill="none" stroke="var(--c-teal)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
							{/if}
						</svg>
						{#if dayHover != null && data.byDay[dayHover]}
							<div class="guide" style="left:{dayXPct}%"></div>
							<div class="dot" style="left:{dayXPct}%; top:{(1 - data.byDay[dayHover].calls / dayMax) * 100}%"></div>
							<div class="tip" class:right={dayXPct > 60} style="left:{dayXPct}%">
								<div class="tip-time">{dayLabel(data.byDay[dayHover].day, locale.current)}</div>
								<div class="tip-row">{m.admin_usage_legend_calls()}<b>{num(data.byDay[dayHover].calls, locale.current)}</b></div>
								<div class="tip-row">{m.admin_usage_stat_spend()}<b>{usdMaybe(data.byDay[dayHover].spendUsd, estimated, locale.current)}</b></div>
							</div>
						{/if}
					</div>
					<div class="legend"><span><span class="swatch teal"></span>{m.admin_usage_legend_calls()}</span></div>
				</div>
			</div>

			<div class="col">
				<div class="section-title">{m.admin_usage_section_by_member()}</div>
				<!-- ⛔ THE RELABEL, AND IT IS THE POINT OF THE SENTENCE RATHER THAN DECORATION. This
				     column is CP's own ESTIMATE of what a member's calls cost against the workspace's
				     OWN provider key, priced out of `usage_events`. It is NOT what the customer is
				     charged — that is the platform fee + seats + BYO markup in the Billing section
				     above. The two were previously indistinguishable on this screen: a tenant admin
				     read this figure as the bill because nothing on the page said otherwise, and it
				     is the one number here that carries a currency glyph. The breakdown is unchanged;
				     only what it claims to be has been corrected. -->
				<p class="estimate-note">{m.billing_estimate_note()}</p>
				<div class="card table">
					<div class="thead"><button class="col-sort" onclick={() => toggleMemberSort('name')}>{m.admin_usage_col_member()}{memIndicator('name')}</button><button class="col-sort" onclick={() => toggleMemberSort('calls')}>{m.admin_usage_col_calls()}{memIndicator('calls')}</button><button class="col-sort" onclick={() => toggleMemberSort('spend')}>{m.billing_estimate_col_spend()}{memIndicator('spend')}</button></div>
					{#if data.byMember.length === 0}
						<div class="empty">{m.admin_usage_empty_member()}</div>
					{:else}
						{#each sortedMembers as mem (mem.userId)}
							<div class="trow"><span class="mname">{mem.name}</span><span>{num(mem.calls, locale.current)}</span><span class="mspend">{usdMaybe(mem.spendUsd, estimated, locale.current)}</span></div>
						{/each}
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.page { max-width: 1180px; }
	.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
	.eyebrow { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px; }
	h1 { font-family: var(--font-display); font-size: 28px; margin: 0 0 4px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 640px; }
	.ranges { display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; }
	/* Phone width (the shell drawer breakpoint, app.css): nothing on this page may push the screen sideways. */
	@media (max-width: 767.98px) { .ranges { flex-shrink: 1; } }
	.ranges button { font-size: 12.5px; font-weight: 500; color: var(--c-muted); background: var(--c-white); border: 1px solid var(--c-border); padding: 7px 12px; border-radius: var(--r); }
	.ranges button.active { color: var(--c-teal-dark); border-color: var(--c-teal-light); background: var(--c-teal-pale); font-weight: 600; }
	/* logical: physical margin-left put the export button's gap on the wrong side in RTL */
	.ranges .export-btn { margin-inline-start: 8px; color: var(--c-ink); }
	.ranges .export-btn:hover:not(:disabled) { border-color: var(--c-teal); color: var(--c-teal-dark); }
	.ranges .export-btn:disabled { opacity: 0.55; cursor: not-allowed; }
	.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 26px; }
	.grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 22px; align-items: start; }
	.col { min-width: 0; }
	.section-title { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin: 4px 0 10px; }
	.col > .section-title:not(:first-child) { margin-top: 24px; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 16px 18px; }
	.spark-wrap { position: relative; width: 100%; height: 56px; }
	.spark { width: 100%; height: 100%; display: block; }
	.spark-wrap .guide { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--c-border); transform: translateX(-0.5px); pointer-events: none; }
	.spark-wrap .dot { position: absolute; width: 7px; height: 7px; border-radius: 50%; background: var(--c-teal); border: 2px solid var(--c-white); transform: translate(-50%, -50%); pointer-events: none; }
	.spark-wrap .tip { position: absolute; top: 4px; transform: translateX(-50%); background: var(--c-midnight); color: #fff; border-radius: var(--r); padding: 6px 9px; font-size: 11px; white-space: nowrap; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,0.18); z-index: 2; }
	.spark-wrap .tip.right { transform: translateX(-100%); }
	.spark-wrap .tip-time { font-weight: 600; margin-bottom: 3px; color: rgba(255,255,255,0.85); }
	.spark-wrap .tip-row { display: flex; gap: 12px; justify-content: space-between; color: rgba(255,255,255,0.85); }
	.spark-wrap .tip-row b { color: #fff; font-variant-numeric: tabular-nums; }
	.legend { display: flex; gap: 18px; margin-top: 10px; font-size: 12px; color: var(--c-muted); }
	.legend span { display: inline-flex; align-items: center; gap: 6px; }
	.swatch { width: 10px; height: 3px; border-radius: 2px; }
	.swatch.teal { background: var(--c-teal); }
	.table { padding: 6px 0; }
	.thead, .trow { display: grid; grid-template-columns: 1.6fr 0.7fr 0.9fr; align-items: center; gap: 10px; padding: 9px 18px; }
	.thead { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--c-muted); font-weight: 600; border-bottom: 1px solid var(--c-border); }
	.col-sort { font: inherit; text-transform: inherit; letter-spacing: inherit; color: inherit; background: none; border: none; padding: 0; text-align: start; cursor: pointer; white-space: nowrap; }
	.col-sort:hover { color: var(--c-ink); }
	.trow { border-bottom: 1px solid var(--c-surface); font-size: 13px; }
	.trow:last-child { border-bottom: none; }
	.mname { font-weight: 600; color: var(--c-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mspend { font-variant-numeric: tabular-nums; }
	.empty { color: var(--c-muted); font-size: 12.5px; padding: 16px; text-align: center; }
	.estimate-note { color: var(--c-muted); font-size: 11.5px; line-height: 1.45; margin: -4px 0 10px; }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
	@media (max-width: 900px) { .stats { grid-template-columns: repeat(2, 1fr); } .grid { grid-template-columns: 1fr; } }
</style>
