<script lang="ts">
	// MCP API keys — issue/revoke keys for external MCP clients reaching the active
	// tenant's governed tool surface (Phase 2-D). The raw secret is shown EXACTLY ONCE
	// at creation. Backend: /api/tenants/:id/mcp-keys. Tenant-admin gated server-side.
	import { onMount } from 'svelte';
	import { adminApi, ApiError } from '$lib/api/admin';
	import { mcpKeysApi } from '$lib/api/mcpKeys';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import type { McpKeyRow, TenantSummary } from '$lib/types/admin';
	import { timeAgo } from '$lib/utils/format';
	import * as m from '$lib/paraglide/messages';
	import { confirmDialog } from '$lib/stores/confirm.svelte';

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let keys = $state<McpKeyRow[]>([]);
	let active = $state<TenantSummary | null>(null);

	let name = $state('');
	let busy = $state(false);
	let banner = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

	// The freshly-minted raw key — shown once in a panel until dismissed.
	let freshKey = $state<{ name: string; raw: string } | null>(null);
	// ⛔ A TRI-STATE, NOT A BOOLEAN, AND THE REASON IS THE `catch` THIS REPLACES. It read
	// `catch { copied = false; }` where `copied` was ALREADY false — a literal no-op, so a rejected
	// clipboard write left the button reading "Kopiëren" and said nothing at all. `cp_mcp_…` is
	// shown EXACTLY ONCE and the server keeps only a hash, so a reader who believes they copied it,
	// closes the panel and did not, has lost the key for good. `navigator.clipboard` is undefined
	// outside a secure context and rejects when the document is not focused, so this branch really
	// fires. Same shape as /connectors' once-only webhook secret. null = not attempted.
	let copyState = $state<'copied' | 'failed' | null>(null);

	async function load() {
		loading = true;
		denied = false;
		loadError = null;
		try {
			active = (await adminApi.currentTenant()).tenant;
			keys = active ? (await mcpKeysApi.list(active.id)).keys : [];
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function issue() {
		if (!name.trim() || !active || busy) return;
		busy = true;
		banner = null;
		try {
			const issued = await mcpKeysApi.issue(active.id, name.trim());
			freshKey = { name: issued.name, raw: issued.key };
			copyState = null;
			name = '';
			banner = { kind: 'ok', text: m.admin_keys_issued() };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_create_failed()) };
		} finally {
			busy = false;
		}
	}

	async function copyKey() {
		if (!freshKey) return;
		try {
			await navigator.clipboard.writeText(freshKey.raw);
			copyState = 'copied';
		} catch {
			// The failure is STATED, and the sentence names the way out — the key is still on screen,
			// so the reader can select it and copy it by hand.
			copyState = 'failed';
		}
	}

	async function revoke(id: string, label: string) {
		if (!active || busy) return;
		// Irreversible: any external integration authenticating with this key stops working
		// immediately, and the key cannot be un-revoked.
		if (!(await confirmDialog({ message: m.admin_keys_revoke_confirm({ name: label }) }))) return;
		busy = true;
		banner = null;
		try {
			await mcpKeysApi.revoke(active.id, id);
			banner = { kind: 'ok', text: m.admin_keys_revoked_ok() };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_delete_failed()) };
		} finally {
			busy = false;
		}
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.admin_keys_eyebrow()}</div>
		<h1>{m.admin_keys_title()}</h1>
		<p>{m.admin_keys_lede()}</p>
	</header>

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else}
		{#if freshKey}
			<div class="fresh card">
				<div class="fresh-title">{m.admin_keys_new_title()}</div>
				<div class="fresh-warn">{m.admin_keys_new_warn()}</div>
				<div class="fresh-row">
					<code dir="ltr">{freshKey.raw}</code>
					<button class="btn-primary" onclick={copyKey}>{copyState === 'copied' ? m.admin_keys_copied() : m.admin_keys_copy()}</button>
				</div>
				<!-- role="status" so the outcome is ANNOUNCED, not only seen: a button label that
				     changes is invisible to a screen reader that is not on the button. -->
				{#if copyState === 'copied'}
					<div class="copy-note ok" role="status" data-testid="key-copy-ok">{m.admin_keys_copied()}</div>
				{:else if copyState === 'failed'}
					<div class="copy-note error" role="status" data-testid="key-copy-failed">{m.admin_keys_copy_failed()}</div>
				{/if}
				<div class="fresh-actions">
					<button class="btn-ghost" onclick={() => (freshKey = null)}>{m.admin_keys_close()}</button>
				</div>
			</div>
		{/if}

		{#if banner}<div class="banner {banner.kind}">{banner.text}</div>{/if}

		<form class="addbar card" onsubmit={(e) => { e.preventDefault(); issue(); }}>
			<input bind:value={name} maxlength="120" placeholder={m.admin_keys_name_placeholder()} aria-label={m.admin_keys_name_label()} />
			<button class="btn-primary" type="submit" disabled={!name.trim() || busy}>{m.admin_keys_issue()}</button>
		</form>

		<div class="card table">
			<div class="thead">
				<span>{m.admin_keys_col_name()}</span>
				<span>{m.admin_keys_col_prefix()}</span>
				<span>{m.admin_keys_col_used()}</span>
				<span>{m.admin_keys_col_created()}</span>
				<span>{m.admin_keys_col_status()}</span>
				<span></span>
			</div>
			{#if keys.length === 0}
				<div class="empty">{m.admin_keys_empty()}</div>
			{:else}
				{#each keys as k (k.id)}
					<div class="trow" class:revoked={!!k.revokedAt}>
						<span class="kname">{k.name}</span>
						<span class="kprefix" dir="ltr">cp_mcp_{k.keyPrefix}…</span>
						<span class="kused">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : m.admin_keys_never_used()}</span>
						<span class="kcreated">{timeAgo(k.createdAt)}</span>
						<span>
							{#if k.revokedAt}
								<span class="status revoked">{m.admin_keys_revoked()}</span>
							{:else}
								<span class="status active">{m.admin_keys_active()}</span>
							{/if}
						</span>
						<span class="kact">
							{#if !k.revokedAt}
								<button class="btn-danger" disabled={busy} onclick={() => revoke(k.id, `cp_mcp_${k.keyPrefix}…`)}>{m.admin_keys_revoke()}</button>
							{/if}
						</span>
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
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 660px; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.fresh { padding: 16px 18px; margin-bottom: 14px; border-color: var(--c-teal-light); background: var(--c-teal-pale); }
	.fresh-title { font-weight: 600; font-size: 14px; color: var(--c-ink); margin-bottom: 4px; }
	.fresh-warn { font-size: 12px; color: var(--c-coral-dark); margin-bottom: 10px; }
	.fresh-row { display: flex; gap: 10px; align-items: center; }
	.fresh-row code { flex: 1; font-family: var(--font-mono); font-size: 12.5px; background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px; overflow-x: auto; white-space: nowrap; }
	.fresh-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
	.copy-note { font-size: 12px; margin-top: 8px; }
	.copy-note.ok { color: var(--c-teal-dark); }
	.copy-note.error { color: var(--c-coral-dark); }
	.addbar { display: flex; gap: 10px; padding: 14px 16px; margin-bottom: 14px; }
	.addbar input { flex: 1; }
	input { font-family: var(--font-sans); font-size: 13.5px; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px; box-sizing: border-box; background: var(--c-white); }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 9px 18px; border-radius: var(--r); border: none; white-space: nowrap; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { font-size: 12.5px; font-weight: 500; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); padding: 7px 14px; border-radius: var(--r); }
	.btn-danger { font-size: 12px; font-weight: 500; color: var(--c-coral-dark); background: var(--c-white); border: 1px solid var(--c-coral-light); padding: 6px 12px; border-radius: var(--r); }
	.btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
	.table { padding: 6px 0; }
	/* Phone width (the shell drawer breakpoint, app.css): nothing on this page may push the screen sideways. */
	@media (max-width: 767.98px) { .table { display: block; overflow-x: auto; } .thead, .trow { min-width: 640px; } }
	.thead, .trow { display: grid; grid-template-columns: 1.2fr 1.1fr 0.9fr 0.9fr 0.8fr 0.8fr; align-items: center; gap: 10px; padding: 10px 18px; }
	.thead { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--c-muted); font-weight: 600; border-bottom: 1px solid var(--c-border); }
	.trow { border-bottom: 1px solid var(--c-surface); font-size: 13px; }
	.trow:last-child { border-bottom: none; }
	.trow.revoked { opacity: 0.6; }
	.kname { font-weight: 600; color: var(--c-ink); }
	.kprefix { font-family: var(--font-mono); font-size: 12px; color: var(--c-muted); }
	.kused, .kcreated { color: var(--c-muted); font-size: 12px; }
	.kact { text-align: end; }
	.status { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
	.status.active { background: var(--c-teal-pale); color: var(--c-teal-dark); }
	.status.revoked { background: var(--c-surface); color: var(--c-muted); }
	.empty { color: var(--c-muted); font-size: 13px; text-align: center; padding: 20px; }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); margin-bottom: 12px; }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
</style>
