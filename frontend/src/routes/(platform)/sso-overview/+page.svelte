<script lang="ts">
	// SSO overview — the platform (super_admin) cross-tenant view of every tenant's identity
	// provider (Phase 4 / E.1, spec Part 8 / 3.6). Read-only: configuration happens on each
	// tenant's own /sso screen. Backend reads through runAsSystem so the NOBYPASSRLS runtime role
	// still sees all tenants. Secrets are never returned. Backend: GET /api/admin/sso/providers.
	import { onMount } from 'svelte';
	import { adminApi, ApiError } from '$lib/api/admin';
	import { errorText } from '$lib/api/error-message';
	import type { IdpProvider } from '$lib/types/admin';
	import * as m from '$lib/paraglide/messages';

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let providers = $state<IdpProvider[]>([]);

	async function load() {
		loading = true;
		denied = false;
		loadError = null;
		try {
			providers = (await adminApi.allSsoProviders()).providers;
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.admin_tenants_eyebrow()}</div>
		<h1>{m.admin_sso_overview_title()}</h1>
		<p>{m.admin_sso_overview_lede()}</p>
	</header>

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else}
		<div class="card table">
			<div class="thead">
				<span>{m.admin_sso_col_tenant()}</span>
				<span>{m.admin_sso_col_provider()}</span>
				<span>{m.admin_sso_col_status()}</span>
				<span>{m.admin_sso_col_secret()}</span>
				<span></span>
			</div>
			{#if providers.length === 0}
				<div class="empty">{m.admin_sso_overview_empty()}</div>
			{:else}
				{#each providers as p (p.id)}
					<div class="trow">
						<!-- The tenant NAME, joined server-side by `listAllIdps` (sso-service.ts — read the
						     comment there for why this is not resolved client-side from `allTenants`).
						     This column used to render `p.tenantId`: a raw UUID, mono, ellipsed, on the one
						     screen whose entire job is "which tenant has which IdP". The id is kept as the
						     tooltip (it is still the thing an operator pastes into a query) and remains the
						     fallback for an orphaned row with no `tenants` match. -->
						<span class="ctenant" dir="auto" title={p.tenantId}>{p.tenantName ?? p.tenantId}</span>
						<span class="cprov"><b>{p.displayName}</b><span class="alias" dir="ltr">{p.alias}</span></span>
						<span class="cstatus">
							<span class="dot {p.enabled ? 'on' : 'off'}"></span>
							{p.enabled ? m.admin_sso_enabled() : m.admin_sso_disabled()}
						</span>
						<span class="csecret">{p.hasSecret ? m.admin_sso_secret_set() : m.admin_sso_secret_unset()}</span>
						<a class="cmanage" href="/sso?tenant={p.tenantId}">{m.admin_sso_manage()}</a>
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.page { max-width: 1080px; }
	.page-head { margin-bottom: 18px; }
	.eyebrow { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px; }
	h1 { font-family: var(--font-display); font-size: 30px; margin: 0 0 6px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 680px; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.table { padding: 6px 0; }
	.thead, .trow { display: grid; grid-template-columns: 1.6fr 1.6fr 1fr 0.8fr auto; align-items: center; gap: 10px; padding: 10px 18px; }
	.cmanage { font-size: 12.5px; font-weight: 600; color: var(--c-teal-dark); text-decoration: none; white-space: nowrap; }
	.cmanage:hover { text-decoration: underline; }
	.thead { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--c-muted); font-weight: 600; border-bottom: 1px solid var(--c-border); }
	.trow { border-bottom: 1px solid var(--c-surface); font-size: 13px; }
	.trow:last-child { border-bottom: none; }
	/* No `--font-mono` here: this renders a tenant NAME now, not an identifier. The mono face
	   (with the ellipsis) is what made the old UUID column unreadable. */
	.ctenant { font-size: 13px; font-weight: 600; color: var(--c-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.cprov { display: flex; flex-direction: column; gap: 2px; }
	.cprov b { color: var(--c-ink); }
	.alias { font-family: var(--font-mono); font-size: 11.5px; color: var(--c-muted); }
	.cstatus { display: flex; align-items: center; gap: 7px; color: var(--c-ink); }
	.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
	.dot.on { background: var(--c-teal); }
	.dot.off { background: var(--c-coral); }
	.csecret { color: var(--c-muted); font-size: 12.5px; }
	.empty { color: var(--c-muted); font-size: 13px; text-align: center; padding: 20px; }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
</style>
