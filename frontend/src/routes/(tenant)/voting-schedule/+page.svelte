<script lang="ts">
	// /voting-schedule (W7) — the workspace's OWN voting schedule (the owner calls it the
	// "tournament schedule"): off / weekly / monthly / quarterly / yearly, or follow the platform
	// default. tenant_admin+ (the (tenant) layout gates the shell; GET/PATCH
	// /api/tenant/cycle-cadence are `requireTenantAdmin` — the real boundary). The workspace is never
	// sent: the backend takes it from the sign-in.
	//
	// A change takes effect at the next period boundary, so while one is pending the page shows BOTH
	// what runs now and what follows, with the date it takes over.
	import { onMount } from 'svelte';
	import { cycleApi, ApiError } from '$lib/api/cycle';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { policyOptionLabel } from '$lib/i18n/policy-label';
	import { boundaryDate, fullDate } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import type { CycleCadence, TenantCadence } from '$lib/types/cycle';
	import * as m from '$lib/paraglide/messages';

	/** The radio value for "follow the platform default" (the API's `null`). */
	const PLATFORM = 'platform';
	const OPTIONS: CycleCadence[] = ['off', 'week', 'month', 'quarter', 'year'];

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let busy = $state(false);
	let banner = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let data = $state<TenantCadence | null>(null);
	let choice = $state<string>(PLATFORM);

	const label = (v: string): string => policyOptionLabel('cycle.cadence', v);
	const stored = $derived(data ? (data.value ?? PLATFORM) : PLATFORM);

	function apply(d: TenantCadence) {
		data = d;
		choice = d.value ?? PLATFORM;
	}

	async function load() {
		loading = true;
		denied = false;
		loadError = null;
		try {
			apply(await cycleApi.tenantCadence());
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function save() {
		if (busy || !data) return;
		busy = true;
		banner = null;
		try {
			const res = await cycleApi.setTenantCadence(choice === PLATFORM ? null : (choice as CycleCadence));
			apply(res);
			banner = { kind: 'ok', text: res.changed === false ? m.vschedule_unchanged() : m.vschedule_saved() };
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.settings_group_organisation()}</div>
		<h1>{m.nav_voting_schedule()}</h1>
		<p>{m.vschedule_lede()}</p>
	</header>

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else if data}
		{#if banner}<div class="banner {banner.kind}" data-testid="vschedule-banner">{banner.text}</div>{/if}

		<div class="card status" data-testid="vschedule-status">
			<span data-testid="vschedule-current">{m.vschedule_current({ value: label(data.effectiveValue) })}</span>
			{#if data.pendingValue && data.effectiveFrom}
				<span data-testid="vschedule-upcoming">{m.vschedule_upcoming({ value: label(data.pendingValue) })}</span>
				<span class="when" data-testid="vschedule-effective-from">
					{m.governance_cadence_effective_from({ date: boundaryDate(data.effectiveFrom, locale.current) })}
				</span>
			{/if}
		</div>

		<form class="card choose" onsubmit={(e) => { e.preventDefault(); save(); }}>
			<fieldset>
				<legend class="sr-only">{m.nav_voting_schedule()}</legend>
				{#each OPTIONS as opt (opt)}
					<label class="radio">
						<input type="radio" name="cadence" value={opt} bind:group={choice} data-testid={`vschedule-option-${opt}`} />
						{label(opt)}
					</label>
				{/each}
				<label class="radio">
					<input type="radio" name="cadence" value={PLATFORM} bind:group={choice} data-testid="vschedule-option-platform" />
					{m.vschedule_option_platform({ value: label(data.platformDefault) })}
				</label>
			</fieldset>
			<p class="hint">{m.vschedule_off_note()}</p>
			<button class="btn-primary" type="submit" disabled={busy || choice === stored} data-testid="vschedule-save">
				{m.vschedule_save()}
			</button>
		</form>

		<section class="card history">
			<h2>{m.vschedule_history_title()}</h2>
			{#if data.history.length === 0}
				<p class="empty">{m.vschedule_history_empty()}</p>
			{:else}
				<ul>
					{#each data.history as h (h.id)}
						<li data-testid="vschedule-history-row">
							<span class="date">{fullDate(h.createdAt, locale.current)}</span>
							<span class="who">{h.actorName ?? m.audit_actor_system()}</span>
							<span class="what">
								{h.oldValue ? label(h.oldValue) : '—'} →
								{h.followsPlatform ? `${m.vschedule_platform_default()} (${label(h.newValue)})` : label(h.newValue)}
							</span>
							{#if h.effectiveFrom}
								<span class="when">{m.governance_cadence_effective_from({ date: boundaryDate(h.effectiveFrom, locale.current) })}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>

<style>
	.page { max-width: 880px; }
	.page-head { margin-bottom: 18px; }
	.eyebrow { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px; }
	h1 { font-family: var(--font-display); font-size: 30px; margin: 0 0 6px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 680px; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 16px; margin-bottom: 14px; }
	.status { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 13.5px; color: var(--c-ink); }
	.when { color: var(--c-teal-dark); font-weight: 600; }
	fieldset { border: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
	.radio { display: flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--c-ink); cursor: pointer; }
	.hint { font-size: 12.5px; color: var(--c-muted); margin: 12px 0; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 10px 18px; border-radius: var(--r); border: none; cursor: pointer; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	h2 { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--c-muted); font-weight: 600; margin: 0 0 10px; font-family: inherit; }
	.history ul { list-style: none; margin: 0; padding: 0; }
	.history li { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; padding: 8px 0; border-top: 1px solid var(--c-surface); }
	.history li:first-child { border-top: none; }
	.date { color: var(--c-muted); min-width: 96px; }
	.who { font-weight: 600; color: var(--c-ink); }
	.empty { color: var(--c-muted); font-size: 13px; margin: 0; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); margin-bottom: 14px; }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
</style>
