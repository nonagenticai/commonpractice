<script lang="ts">
	// Plans — the Common Practice licence-plan catalogue (A2 §5, super_admin only). Lists, creates,
	// edits, retires and deletes the plans of THIS app in the licences service. Backend:
	// GET/POST /api/platform/plans, PATCH/DELETE /api/platform/plans/:id — the app is pinned
	// server-side; every route is super_admin-gated, the (platform) group guards the shell.
	// A workspace's plan is changed from Tenants → Edit licence, not here.
	import { onMount } from 'svelte';
	import { adminApi, ApiError } from '$lib/api/admin';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import type { LicencePlan, PlanFields } from '$lib/types/admin';
	import { confirmDialog } from '$lib/stores/confirm.svelte';
	import * as m from '$lib/paraglide/messages';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	/** The numeric limits, in display order, with their label. */
	const LIMITS = [
		{ key: 'durationDays', label: m.admin_plans_duration },
		{ key: 'rateLimitRpm', label: m.admin_plans_rpm },
		{ key: 'rateLimitBurst', label: m.admin_plans_burst },
		{ key: 'quotaMonthly', label: m.admin_plans_quota },
		{ key: 'tokenBudgetMonthly', label: m.admin_plans_tokens }
	] as const;
	type LimitKey = (typeof LIMITS)[number]['key'];
	/** Limits that must be ≥ 1 when set (the rest may be 0). Mirrors routes/platform-plans.ts. */
	const POSITIVE: ReadonlySet<LimitKey> = new Set(['durationDays', 'rateLimitRpm', 'rateLimitBurst']);

	interface PlanDraft {
		name: string;
		description: string;
		limits: Record<LimitKey, string>;
	}

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let plans = $state<LicencePlan[]>([]);
	// null = not observed yet; false = licences refused `revoked` (501) → the retire control is hidden.
	let canRetire = $state<boolean | null>(null);
	let showRetired = $state(false);
	let busy = $state(false);
	let banner = $state<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

	const emptyLimits = (): Record<LimitKey, string> => ({
		durationDays: '',
		rateLimitRpm: '',
		rateLimitBurst: '',
		quotaMonthly: '',
		tokenBudgetMonthly: ''
	});
	let newCode = $state('');
	let newPlan = $state<PlanDraft>({ name: '', description: '', limits: emptyLimits() });

	let editFor = $state<string | null>(null);
	let editDraft = $state<PlanDraft>({ name: '', description: '', limits: emptyLimits() });

	async function load() {
		loading = true;
		denied = false;
		loadError = null;
		try {
			const res = await adminApi.plans({ includeRevoked: showRetired });
			plans = res.plans;
			// Never turn a locally-observed `false` back into `null` from a fresh backend process.
			if (res.capabilities.canRetire !== null || canRetire === null) canRetire = res.capabilities.canRetire;
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function toggleRetired() {
		showRetired = !showRetired;
		load();
	}

	/** '' → null (no limit); a whole number in range → it; anything else → undefined (invalid). */
	function parseLimit(key: LimitKey, raw: string): number | null | undefined {
		const t = raw.trim();
		if (!t) return null;
		if (!/^\d+$/.test(t)) return undefined;
		const n = Number(t);
		if (!Number.isSafeInteger(n) || n > 2_000_000_000) return undefined;
		if (POSITIVE.has(key) && n < 1) return undefined;
		return n;
	}

	/** The draft as plan fields, or null when a limit is not a valid whole number. */
	function fieldsOf(d: PlanDraft): PlanFields | null {
		const out: PlanFields = { name: d.name.trim(), description: d.description.trim() || null };
		for (const { key } of LIMITS) {
			const v = parseLimit(key, d.limits[key]);
			if (v === undefined) return null;
			out[key] = v;
		}
		return out;
	}

	function draftOf(p: LicencePlan): PlanDraft {
		const limits = emptyLimits();
		for (const { key } of LIMITS) limits[key] = p[key] === null ? '' : String(p[key]);
		return { name: p.name, description: p.description ?? '', limits };
	}

	function limitText(key: LimitKey, v: number | null): string {
		if (v === null) return m.admin_plans_unlimited();
		return key === 'durationDays' ? m.admin_plans_days({ count: num(v, locale.current) }) : num(v, locale.current);
	}

	/** "In use by N workspace(s)…" — a PLURAL message: the raw count drives the selector, and the
	 *  catalog groups the digits itself (`{countNum}`), so `num()` must not wrap it. */
	const inUseText = (n: number): string => m.admin_plans_in_use({ count: n });

	/** Localized sentence for a refused plan call. */
	function planErrorText(e: unknown, fallback: string): string {
		if (e instanceof ApiError) {
			if (e.code === 'plan_in_use') {
				const n = e.details?.tenantCount;
				return typeof n === 'number' && n > 0
					? inUseText(n)
					: m.error_plan_in_use();
			}
			if (e.code === 'retire_unsupported') {
				canRetire = false;
				return e.details?.fieldsApplied === true
					? `${m.admin_plans_fields_saved()} ${m.admin_plans_retire_unsupported()}`
					: m.admin_plans_retire_unsupported();
			}
			if (e.code === 'plan_not_found') return m.admin_plans_not_found();
		}
		return writeErrorText(e, fallback);
	}

	const CODE_RE = /^[a-z0-9][a-z0-9_-]*$/;

	async function create() {
		if (busy) return;
		const code = newCode.trim();
		if (!CODE_RE.test(code) || code.length > 64) {
			banner = { kind: 'error', text: m.admin_plans_code_invalid() };
			return;
		}
		if (!newPlan.name.trim()) {
			banner = { kind: 'error', text: m.admin_plans_name_required() };
			return;
		}
		const fields = fieldsOf(newPlan);
		if (!fields) {
			banner = { kind: 'error', text: m.admin_plans_number_invalid() };
			return;
		}
		// Create sends only what was filled in; licences applies its own defaults for the rest.
		const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
		busy = true;
		banner = null;
		try {
			const res = await adminApi.createPlan({ ...body, code, name: fields.name! });
			newCode = '';
			newPlan = { name: '', description: '', limits: emptyLimits() };
			banner = { kind: 'ok', text: m.admin_plans_created({ name: res.plan.name }) };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: planErrorText(e, m.error_create_failed()) };
		} finally {
			busy = false;
		}
	}

	function openEdit(p: LicencePlan) {
		editFor = p.id;
		editDraft = draftOf(p);
	}

	async function saveEdit(p: LicencePlan) {
		if (busy) return;
		if (!editDraft.name.trim()) {
			banner = { kind: 'error', text: m.admin_plans_name_required() };
			return;
		}
		const fields = fieldsOf(editDraft);
		if (!fields) {
			banner = { kind: 'error', text: m.admin_plans_number_invalid() };
			return;
		}
		// Only what changed — the audit row then records a real before/after.
		const changed: PlanFields = {};
		if (fields.name !== p.name) changed.name = fields.name;
		if (fields.description !== (p.description ?? null)) changed.description = fields.description;
		for (const { key } of LIMITS) if (fields[key] !== p[key]) changed[key] = fields[key];
		if (Object.keys(changed).length === 0) {
			banner = { kind: 'error', text: m.admin_licence_no_changes() };
			return;
		}
		busy = true;
		banner = null;
		try {
			const res = await adminApi.updatePlan(p.id, changed);
			editFor = null;
			banner = { kind: 'ok', text: m.admin_plans_saved({ name: res.plan.name }) };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: planErrorText(e, m.error_save_failed()) };
		} finally {
			busy = false;
		}
	}

	async function setRetired(p: LicencePlan, revoked: boolean) {
		if (busy) return;
		if (revoked && !(await confirmDialog({ message: m.admin_plans_retire_confirm({ name: p.name }) }))) return;
		busy = true;
		banner = null;
		try {
			await adminApi.updatePlan(p.id, { revoked });
			canRetire = true;
			banner = {
				kind: 'ok',
				text: revoked ? m.admin_plans_retired_done({ name: p.name }) : m.admin_plans_unretired_done({ name: p.name })
			};
			await load();
		} catch (e) {
			banner = { kind: 'error', text: planErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	async function remove(p: LicencePlan) {
		if (busy || p.tenantCount > 0) return;
		if (!(await confirmDialog({ message: m.admin_plans_delete_confirm({ name: p.name, code: p.code }) }))) return;
		busy = true;
		banner = null;
		try {
			await adminApi.deletePlan(p.id);
			if (editFor === p.id) editFor = null;
			banner = { kind: 'ok', text: m.admin_plans_deleted({ name: p.name }) };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: planErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.admin_tenants_eyebrow()}</div>
		<h1>{m.admin_plans_title()}</h1>
		<p>{m.admin_plans_lede()}</p>
	</header>

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading && plans.length === 0}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else}
		<div class="layout">
			<section class="list">
				<label class="toggle">
					<input type="checkbox" data-testid="plans-show-retired" checked={showRetired} disabled={busy || loading}
						onchange={toggleRetired} />
					{m.admin_plans_show_retired()}
				</label>
				{#if banner}<div class="banner {banner.kind}" data-testid="plans-banner">{banner.text}</div>{/if}
				{#if plans.length === 0}
					<div class="card empty">{m.admin_plans_empty()}</div>
				{:else}
					{#each plans as p (p.id)}
						<div class="card plan" class:retired={p.revoked} data-testid="plan-row">
							<div class="row">
								<div class="meta">
									<div class="name">
										{p.name}
										{#if p.isDefault}<span class="badge default">{m.admin_plans_default()}</span>{/if}
										{#if p.revoked}<span class="badge retired">{m.admin_plans_retired()}</span>{/if}
									</div>
									<div class="code" dir="ltr">{p.code}</div>
									{#if p.description}<div class="desc">{p.description}</div>{/if}
								</div>
								<span class="count" data-testid="plan-tenant-count">
									{m.admin_plans_tenant_count({ count: num(p.tenantCount, locale.current) })}
								</span>
								<button class="btn-ghost" disabled={busy || editFor === p.id} onclick={() => openEdit(p)}>
									{m.admin_plans_edit()}
								</button>
								<!-- Hidden once licences has said it cannot retire (501): a control that can
								     only fail is a lying affordance. Shown while untried (`null`). -->
								{#if canRetire !== false}
									<button class="btn-ghost" data-testid="plan-retire" disabled={busy}
										onclick={() => setRetired(p, !p.revoked)}>
										{p.revoked ? m.admin_plans_unretire() : m.admin_plans_retire()}
									</button>
								{/if}
								<!-- Disabled, not hidden, while workspaces use it — `title` says why. -->
								<button class="btn-ghost danger" data-testid="plan-delete"
									disabled={busy || p.tenantCount > 0}
									title={p.tenantCount > 0 ? inUseText(p.tenantCount) : undefined}
									onclick={() => remove(p)}>
									{m.admin_plans_delete()}
								</button>
							</div>
							{#if editFor === p.id}
								<form class="editor" onsubmit={(e) => { e.preventDefault(); saveEdit(p); }}>
									<div class="grid">
										<div class="field">
											<label for="pname-{p.id}">{m.admin_plans_name_label()}</label>
											<input id="pname-{p.id}" data-testid="plan-edit-name" bind:value={editDraft.name} maxlength="120" />
										</div>
										<div class="field wide">
											<label for="pdesc-{p.id}">{m.admin_plans_description_label()}</label>
											<input id="pdesc-{p.id}" bind:value={editDraft.description} maxlength="2000" />
										</div>
										{#each LIMITS as l (l.key)}
											<div class="field">
												<label for="p{l.key}-{p.id}">{l.label()}</label>
												<input id="p{l.key}-{p.id}" inputmode="numeric" bind:value={editDraft.limits[l.key]}
													placeholder={m.admin_plans_unlimited()} />
											</div>
										{/each}
									</div>
									<div class="actions">
										<button class="btn-primary" type="submit" data-testid="plan-edit-save" disabled={busy}>{m.admin_plans_save()}</button>
										<button type="button" class="btn-ghost" disabled={busy} onclick={() => { editFor = null; }}>{m.common_cancel()}</button>
									</div>
								</form>
							{:else}
								<dl class="limits">
									{#each LIMITS as l (l.key)}
										<div><dt>{l.label()}</dt><dd>{limitText(l.key, p[l.key])}</dd></div>
									{/each}
								</dl>
							{/if}
						</div>
					{/each}
				{/if}
			</section>

			<aside class="side">
				<div class="preview-label">{m.admin_plans_create()}</div>
				<form class="card" onsubmit={(e) => { e.preventDefault(); create(); }}>
					<div class="field">
						<label for="pcode">{m.admin_plans_code_label()}</label>
						<input id="pcode" bind:value={newCode} maxlength="64" autocomplete="off" autocapitalize="off"
							spellcheck="false" dir="ltr" />
						<span class="hint">{m.admin_plans_code_hint()}</span>
					</div>
					<div class="field">
						<label for="pname">{m.admin_plans_name_label()}</label>
						<input id="pname" bind:value={newPlan.name} maxlength="120" />
					</div>
					<div class="field">
						<label for="pdesc">{m.admin_plans_description_label()}</label>
						<input id="pdesc" bind:value={newPlan.description} maxlength="2000" />
					</div>
					{#each LIMITS as l (l.key)}
						<div class="field">
							<label for="pnew-{l.key}">{l.label()}</label>
							<input id="pnew-{l.key}" inputmode="numeric" bind:value={newPlan.limits[l.key]}
								placeholder={m.admin_plans_unlimited()} />
						</div>
					{/each}
					<span class="hint">{m.admin_plans_number_hint()}</span>
					<div class="actions">
						<button class="btn-primary" type="submit" disabled={busy || !newCode.trim() || !newPlan.name.trim()}>
							{m.admin_plans_create()}
						</button>
					</div>
				</form>
			</aside>
		</div>
	{/if}
</div>

<style>
	.page { max-width: 1080px; }
	.page-head { margin-bottom: 22px; }
	.eyebrow { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px; }
	h1 { font-family: var(--font-display); font-size: 30px; margin: 0 0 6px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 640px; }
	.layout { display: grid; grid-template-columns: 1fr 320px; gap: 22px; align-items: start; }
	.list { display: flex; flex-direction: column; gap: 12px; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 16px 18px; }
	.card.retired { opacity: 0.7; }
	.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
	.meta { flex: 1; min-width: 180px; }
	.name { font-weight: 600; font-size: 14px; color: var(--c-ink); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.code { font-family: var(--font-mono); font-size: 11.5px; color: var(--c-muted); margin-top: 2px; }
	.desc { font-size: 12.5px; color: var(--c-muted); margin-top: 6px; }
	.badge { font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
	.badge.default { background: var(--c-teal-pale); color: var(--c-teal-dark); }
	.badge.retired { background: var(--c-surface-2); color: var(--c-muted); }
	.count { font-size: 11.5px; color: var(--c-muted); white-space: nowrap; }
	.limits { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px 14px; margin: 12px 0 0; }
	.limits dt { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-muted); }
	.limits dd { margin: 2px 0 0; font-size: 13px; color: var(--c-ink); }
	.editor { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--c-border); }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); column-gap: 14px; }
	.field.wide { grid-column: span 2; }
	.toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--c-ink); font-weight: 500; }
	.toggle input { width: auto; }
	.empty { color: var(--c-muted); font-size: 13px; text-align: center; }
	.side { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 20px; }
	.preview-label { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; color: var(--c-muted); }
	.field { display: flex; flex-direction: column; margin-bottom: 14px; }
	label { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 6px; }
	input { font-family: var(--font-sans); font-size: 13.5px; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px; width: 100%; box-sizing: border-box; }
	.hint { display: block; font-size: 11px; color: var(--c-muted); margin: -8px 0 14px; }
	.field .hint { margin: 4px 0 0; }
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 10px 18px; border-radius: var(--r); border: none; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { font-size: 12.5px; font-weight: 500; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); padding: 7px 14px; border-radius: var(--r); }
	.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
	/* The estate's destructive affordance — same token as (platform)/tenants' offboard button. */
	.btn-ghost.danger { color: var(--c-coral-dark); border-color: var(--c-coral-light); }
	.btn-ghost.danger:hover:not(:disabled) { background: var(--c-coral-pale); border-color: var(--c-coral-dark); }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	.banner.warn { background: var(--c-amber-pale); border: 1px solid var(--c-amber-light); color: var(--c-amber-dark, #92400E); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
	@media (max-width: 820px) { .layout { grid-template-columns: 1fr; } .side { position: static; } }
</style>
