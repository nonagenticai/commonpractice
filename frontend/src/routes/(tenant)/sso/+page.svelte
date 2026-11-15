<script lang="ts">
	// SSO — per-tenant Entra OIDC identity provider (Phase 4 / E.1, spec Part 8). A tenant_admin
	// connects their company's Microsoft Entra ID; the backend brokers it to a Keycloak IdP
	// (alias entra-<slug>) and stamps a hardcoded tenant_id mapper bound to THIS tenant — so a
	// brokered user can only ever land here. The Entra client secret is write-only (never returned;
	// blank on edit = keep). Backend: GET /api/tenant, GET/POST/PATCH/DELETE
	// /api/tenants/:id/sso/providers.
	import { onMount } from 'svelte';
	import { adminApi, ApiError } from '$lib/api/admin';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { tenantSignInUrl } from '$lib/services/keycloak';
	import type { IdpProvider, TenantSummary } from '$lib/types/admin';
	import * as m from '$lib/paraglide/messages';
	import { confirmDialog } from '$lib/stores/confirm.svelte';

	// The shareable tenant sign-in link (origin/?idp=<alias>) routes a user's browser straight to
	// this tenant's Entra, skipping the provider picker (spec Part 8.3, kc_idp_hint). origin is only
	// known in the browser, so resolve it lazily.
	let origin = $state('');
	onMount(() => {
		origin = window.location.origin;
	});

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let busy = $state(false);
	let banner = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

	let providers = $state<IdpProvider[]>([]);
	let active = $state<TenantSummary | null>(null);
	// Super-admin drill-down: /sso?tenant=<id> from the platform SSO overview manages
	// another tenant's IdP via the audited X-Active-Tenant-Id scope-switch (threaded as
	// the activeTenantId arg to every call). Null = the admin's own tenant (normal path).
	let scopeTenantId = $state<string | null>(null);

	// connect form
	let guid = $state('');
	let clientId = $state('');
	let clientSecret = $state('');
	let scopes = $state('openid profile email');
	let trustEmail = $state(true);
	let linkOnly = $state(false);

	async function load() {
		loading = true;
		denied = false;
		loadError = null;
		try {
			scopeTenantId = new URLSearchParams(window.location.search).get('tenant');
			if (scopeTenantId) {
				// Platform-admin drill-down: resolve the target tenant for display, then scope-switch.
				const all = await adminApi.allTenants();
				const t = all.tenants.find((x) => x.id === scopeTenantId);
				active = t
					? { id: t.id, name: t.name, slug: t.slug, status: t.status }
					: { id: scopeTenantId, name: scopeTenantId, slug: '', status: 'active' };
				providers = (await adminApi.ssoProviders(scopeTenantId, scopeTenantId)).providers;
			} else {
				active = (await adminApi.currentTenant()).tenant;
				providers = (await adminApi.ssoProviders(active.id)).providers;
			}
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function run(fn: () => Promise<void>, ok: string) {
		if (busy) return;
		busy = true;
		banner = null;
		try {
			await fn();
			banner = { kind: 'ok', text: ok };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	function connect() {
		if (!active || !guid.trim() || !clientId.trim() || !clientSecret.trim()) return;
		run(
			() =>
				adminApi
					.createSsoProvider(active!.id, {
						entraTenantGuid: guid.trim(),
						clientId: clientId.trim(),
						clientSecret: clientSecret.trim(),
						scopes: scopes.trim() || undefined,
						trustEmail,
						linkOnly
					}, scopeTenantId ?? undefined)
					.then(() => {
						guid = '';
						clientId = '';
						clientSecret = '';
						scopes = 'openid profile email';
						trustEmail = true;
						linkOnly = false;
					}),
			m.admin_sso_added()
		);
	}

	function toggle(p: IdpProvider) {
		if (!active) return;
		run(() => adminApi.updateSsoProvider(active!.id, p.id, { enabled: !p.enabled }, scopeTenantId ?? undefined).then(() => {}), m.admin_sso_updated());
	}

	async function remove(p: IdpProvider) {
		if (!active) return;
		// Irreversible and high blast-radius: every user who signs in through this IdP is locked
		// out the moment it is gone. Every comparable destructive action in the app confirms first.
		if (!(await confirmDialog({ message: m.admin_sso_delete_confirm({ name: p.displayName || p.alias }) }))) return;
		run(() => adminApi.deleteSsoProvider(active!.id, p.id, scopeTenantId ?? undefined).then(() => {}), m.admin_sso_deleted());
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.admin_sso_eyebrow()}</div>
		<h1>{m.admin_sso_title()}</h1>
		<p>{m.admin_sso_lede()}</p>
	</header>

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else}
		{#if scopeTenantId && active}
			<div class="scope-bar">
				<span>{m.admin_sso_managing({ tenant: active.name })}</span>
				<a href="/sso-overview">{m.admin_sso_back_overview()}</a>
			</div>
		{/if}
		{#if banner}<div class="banner {banner.kind}">{banner.text}</div>{/if}

		<div class="card table">
			<div class="thead">
				<span>{m.admin_sso_col_provider()}</span>
				<span>{m.admin_sso_col_status()}</span>
				<span>{m.admin_sso_col_secret()}</span>
				<span></span>
			</div>
			{#if providers.length === 0}
				<div class="empty">{m.admin_sso_empty()}</div>
			{:else}
				{#each providers as p (p.id)}
					<div class="trow">
						<span class="cprov">
							<b>{p.displayName}</b>
							<span class="alias" dir="ltr">{p.alias}</span>
						</span>
						<span class="cstatus">
							<span class="dot {p.enabled ? 'on' : 'off'}"></span>
							{p.enabled ? m.admin_sso_enabled() : m.admin_sso_disabled()}
						</span>
						<span class="csecret">{p.hasSecret ? m.admin_sso_secret_set() : m.admin_sso_secret_unset()}</span>
						<span class="cactions">
							<button class="btn-ghost" disabled={busy} onclick={() => toggle(p)}>
								{p.enabled ? m.admin_sso_disable() : m.admin_sso_enable()}
							</button>
							<button class="btn-ghost danger" disabled={busy} onclick={() => remove(p)}>{m.admin_sso_delete()}</button>
						</span>
					</div>
					<div class="redirect">
						<label for={`redir-${p.id}`}>{m.admin_sso_redirect_label()}</label>
						<input id={`redir-${p.id}`} dir="ltr" readonly value={p.redirectUri} onfocus={(e) => e.currentTarget.select()} />
						<label for={`signin-${p.id}`}>{m.admin_sso_signin_link_label()}</label>
						<input id={`signin-${p.id}`} dir="ltr" readonly value={tenantSignInUrl(origin, p.alias)} onfocus={(e) => e.currentTarget.select()} />
					</div>
				{/each}
			{/if}
		</div>

		{#if providers.length === 0}
			<!-- connect a new Entra IdP -->
			<form class="card connect" onsubmit={(e) => { e.preventDefault(); connect(); }}>
				<div class="field">
					<label for="sso-guid">{m.admin_sso_guid_label()}</label>
					<input id="sso-guid" dir="ltr" bind:value={guid} placeholder={m.admin_sso_guid_placeholder()} />
				</div>
				<div class="field">
					<label for="sso-client">{m.admin_sso_client_id_label()}</label>
					<input id="sso-client" dir="ltr" bind:value={clientId} />
				</div>
				<div class="field">
					<label for="sso-secret">{m.admin_sso_client_secret_label()}</label>
					<input id="sso-secret" type="password" dir="ltr" bind:value={clientSecret} />
				</div>
				<div class="field">
					<label for="sso-scopes">{m.admin_sso_scopes_label()}</label>
					<input id="sso-scopes" dir="ltr" bind:value={scopes} />
				</div>
				<label class="check"><input type="checkbox" bind:checked={trustEmail} /> {m.admin_sso_trust_email_label()}</label>
				<label class="check"><input type="checkbox" bind:checked={linkOnly} /> {m.admin_sso_link_only_label()}</label>
				<button class="btn-primary" type="submit" disabled={busy || !guid.trim() || !clientId.trim() || !clientSecret.trim()}>
					{m.admin_sso_add()}
				</button>
			</form>
		{/if}
	{/if}
</div>

<style>
	.page { max-width: 1080px; }
	.page-head { margin-bottom: 18px; }
	.eyebrow { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px; }
	h1 { font-family: var(--font-display); font-size: 30px; margin: 0 0 6px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 680px; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.table { padding: 6px 0; margin-bottom: 14px; }
	.thead, .trow { display: grid; grid-template-columns: 2fr 1fr 0.8fr 1.4fr; align-items: center; gap: 10px; padding: 10px 18px; }
	.thead { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--c-muted); font-weight: 600; border-bottom: 1px solid var(--c-border); }
	.trow { font-size: 13px; }
	.cprov { display: flex; flex-direction: column; gap: 2px; }
	.cprov b { color: var(--c-ink); }
	.alias { font-family: var(--font-mono); font-size: 11.5px; color: var(--c-muted); }
	.cstatus { display: flex; align-items: center; gap: 7px; color: var(--c-ink); }
	.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
	.dot.on { background: var(--c-teal); }
	.dot.off { background: var(--c-coral); }
	.csecret { color: var(--c-muted); font-size: 12.5px; }
	.cactions { display: flex; gap: 8px; justify-content: flex-end; }
	.redirect { padding: 0 18px 14px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--c-surface); }
	.redirect label { font-size: 12px; font-weight: 600; color: var(--c-ink); }
	.redirect input { font-family: var(--font-mono); font-size: 11.5px; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r); padding: 8px 10px; }
	.empty { color: var(--c-muted); font-size: 13px; text-align: center; padding: 20px; }
	.connect { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
	.field { display: flex; flex-direction: column; }
	label { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 6px; }
	input { font-family: var(--font-sans); font-size: 13.5px; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px; box-sizing: border-box; background: var(--c-white); width: 100%; }
	.check { display: flex; flex-direction: row; align-items: center; gap: 8px; font-weight: 500; font-size: 13px; color: var(--c-ink); margin: 0; }
	.check input { width: auto; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 10px 18px; border-radius: var(--r); border: none; white-space: nowrap; align-self: flex-start; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { background: transparent; color: var(--c-teal-dark); border: 1px solid var(--c-border); font-size: 12px; padding: 6px 10px; border-radius: var(--r); cursor: pointer; }
	.btn-ghost.danger { color: var(--c-coral-dark); }
	.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
	.scope-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12.5px; padding: 10px 14px; border-radius: var(--r); margin-bottom: 14px; background: var(--c-amber-pale, var(--c-surface)); border: 1px solid var(--c-amber-light, var(--c-border)); color: var(--c-ink); }
	.scope-bar a { color: var(--c-teal-dark); font-weight: 600; text-decoration: none; white-space: nowrap; }
	.scope-bar a:hover { text-decoration: underline; }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); margin-bottom: 14px; }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
</style>
