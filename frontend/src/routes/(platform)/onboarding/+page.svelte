<script lang="ts">
	// Onboarding — the PLATFORM controlled-onboarding screen (Phase 4 / C.2a, super_admin).
	// Four surfaces: the self-signup approval queue (approve into a NEW workspace or an existing
	// one), an "Invite to early access" form (a pre-approved signup → its own new workspace, no public
	// form needed), an invite form (e.g. the first tenant_admin of a tenant), and email-domain → tenant
	// routing. Backend: /api/signup-approvals(/invite|/:id/approve|reject), /api/invites, /api/email-domains
	// — all super_admin-gated server-side. Every path ends in an invite the person accepts; when its
	// email fails, the invite link is shown here to hand over.
	//
	// DEEP LINK (early access, George 2026-10-14): the Telegram signup notification's Approve / Reject
	// buttons open `/onboarding?signup=<id>&action=approve|reject`. The page then focuses that signup
	// in a confirm dialog with the decision prefilled (the new workspace's name = the server's
	// suggestion). Nothing is decided until the super_admin confirms here — the bot holds no CP
	// credential. Keycloak's login-required redirect returns to the full URL, so the link survives
	// a sign-in.
	import { onMount, tick } from 'svelte';
	import { adminApi, ApiError } from '$lib/api/admin';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import type {
		SignupApproval,
		PlatformTenant,
		EmailDomainMapping,
		SignupStats,
		TenantRole,
		ByoMode,
		CreatedInvite
	} from '$lib/types/admin';
	import * as m from '$lib/paraglide/messages';
	import { LOCALE_LABELS as LOCALE_NAME } from '$lib/stores/locale.svelte';
	import { SIGNUP_LOCALES, type SignupLocale } from '$lib/types/admin';
	import LoadingRows from '$lib/components/LoadingRows.svelte';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let busy = $state(false);
	// 'warn' = the invite exists but its email failed: never a green "Invite sent.". The invite's
	// own link (`failedInvite.inviteUrl`) is then shown to copy — it is a real accept link, unlike the
	// account-console URL this screen once showed for an account with no password.
	let banner = $state<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);
	let failedInvite = $state<CreatedInvite | null>(null);
	let copied = $state(false);

	let approvals = $state<SignupApproval[]>([]);
	// REJECTED signups whose cleanup has not finished (backend `?status=needs_repair`): an aborted
	// approve left a workspace / licence / seat / login behind. The backend tick retries `pending`
	// ones on its own; `blocked` ones, and `failed` ones (the retries gave up), wait for a super_admin.
	// Retry = reject again (same endpoint).
	let repairs = $state<SignupApproval[]>([]);
	const needsRepair = (a: SignupApproval) =>
		a.status === 'rejected' &&
		(a.reject_repair?.state === 'pending' || a.reject_repair?.state === 'blocked' || a.reject_repair?.state === 'failed');
	let tenants = $state<PlatformTenant[]>([]);
	let domains = $state<EmailDomainMapping[]>([]);
	let stats = $state<SignupStats | null>(null);

	// per-row approve choices. Mode defaults to `existing` when the email domain matched a tenant,
	// else `new_tenant` (a self-signup with no workspace to join).
	let approveMode = $state<Record<string, 'new_tenant' | 'existing'>>({});
	let approveTenantName = $state<Record<string, string>>({});
	let approveByo = $state<Record<string, ByoMode>>({});
	let approveTenant = $state<Record<string, string>>({});
	let approveRole = $state<Record<string, TenantRole>>({});
	const modeOf = (a: SignupApproval) => approveMode[a.id] ?? (a.matched_tenant_id ? 'existing' : 'new_tenant');

	// deep-linked signup (see the header)
	let focusId = $state<string | null>(null);
	let focusAction = $state<'approve' | 'reject'>('approve');
	let focusMissing = $state(false);
	const focused = $derived(focusId ? (approvals.find((a) => a.id === focusId) ?? null) : null);

	function readDeepLink() {
		const q = new URLSearchParams(window.location.search);
		const id = q.get('signup');
		if (!id) return;
		focusId = id;
		focusAction = q.get('action') === 'reject' ? 'reject' : 'approve';
	}
	/** Drop the deep link so a reload does not reopen a dialog for a signup that was just decided. */
	function closeFocus() {
		focusId = null;
		focusMissing = false;
		try {
			const url = new URL(window.location.href);
			url.searchParams.delete('signup');
			url.searchParams.delete('action');
			window.history.replaceState(window.history.state, '', url);
		} catch {
			/* history unavailable — harmless */
		}
	}
	async function openDeepLink() {
		if (!focusId) return;
		const a = approvals.find((x) => x.id === focusId);
		if (!a) {
			focusMissing = true;
			return;
		}
		// Prefill: the name the server would default to, editable before confirming.
		if (approveTenantName[a.id] === undefined && a.suggested_tenant_name) {
			approveTenantName[a.id] = a.suggested_tenant_name;
		}
		await tick();
		document.getElementById(`signup-${a.id}`)?.scrollIntoView?.({ block: 'center' });
	}
	const sourceLabel = (s: SignupApproval['source']) =>
		s === 'web'
			? m.admin_onboarding_source_web()
			: s === 'chat'
				? m.admin_onboarding_source_chat()
				: s === 'app'
					? m.admin_onboarding_source_app()
					: s === 'invite'
						? m.admin_onboarding_source_invite()
						: null;

	// "Invite to early access" form — POST /api/signup-approvals/invite: a pre-approved signup,
	// approved into a NEW workspace in one step (same path, email and Telegram notice as Approve).
	let eaEmail = $state('');
	let eaName = $state('');
	let eaCompany = $state('');
	// The set-password email's language (backend 0121). English unless the super_admin picks another.
	let eaLocale = $state<SignupLocale>('en');

	// invite form
	let invEmail = $state('');
	let invFirstName = $state('');
	let invLastName = $state('');
	let invTenant = $state('');
	let invRole = $state<TenantRole>('member');

	// email-domain form
	let domDomain = $state('');
	let domTenant = $state('');

	// ──────────────────────────────────────────────────────────────────────────────────────────
	// ⛔ THE DEFECT: `?? id` PRINTED A RAW GUID INTO A SENTENCE. Both call sites read
	// "Matched: <name>" and "<domain> → <name>"; when the referenced tenant was not in the loaded
	// `tenants` array, the reader got "Gekoppeld: 3f1c8b2e-9a44-4c07-b1de-0e6a8b2f7c31" — 36
	// characters of opaque hex in the slot the sentence promises a workspace NAME in, on the queue
	// row an operator is about to approve.
	//
	// ⚠️ AND THIS IS NOT ONLY THE MISSING-ROW CASE. `adminApi.allTenants()` is PAGINATED
	// (backend/src/routes/admin.ts, `TENANTS_DEFAULT_LIMIT = 500`) and this page requests no
	// `?limit`/`?offset` and never reads the `total` the route returns for exactly this purpose.
	// So on a platform holding more than 500 workspaces the fallback fires for every tenant from
	// 501 on — for rows that are perfectly present in the database. Naming the gap is this
	// function's job; CLOSING it is a paging change to the queue screen, not a rename.
	//
	// The id is not thrown away: it moves to `title=`, where it is available to copy for whoever
	// has to go and look it up, and out of the prose where it was pretending to be a name.
	// ──────────────────────────────────────────────────────────────────────────────────────────
	function tenantName(id: string | null): string | null {
		if (!id) return null;
		return tenants.find((t) => t.id === id)?.name ?? m.admin_onboarding_tenant_unknown();
	}
	/** The raw tenant id, for the tooltip — `undefined` whenever the NAME is the real one, so a
	 *  resolved workspace does not get a GUID hover it never had. */
	function tenantIdTitle(id: string | null): string | undefined {
		if (!id) return undefined;
		return tenants.some((t) => t.id === id) ? undefined : id;
	}

	async function load() {
		loading = true;
		denied = false;
		loadError = null;
		try {
			const [a, t, d, s, r] = await Promise.all([
				adminApi.signupApprovals('pending'),
				adminApi.allTenants(),
				adminApi.emailDomains(),
				adminApi.signupStats(),
				// Never fails the screen: an older backend ignores the filter (the client-side filter
				// below then keeps nothing) and a failed read just hides the section.
				adminApi.signupApprovals('needs_repair').catch(() => ({ approvals: [] as SignupApproval[] }))
			]);
			approvals = a.approvals;
			repairs = r.approvals.filter(needsRepair);
			tenants = t.tenants;
			domains = d.domains;
			stats = s.stats;
			if (tenants.length && !invTenant) invTenant = tenants[0].id;
			if (tenants.length && !domTenant) domTenant = tenants[0].id;
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(async () => {
		readDeepLink();
		await load();
		await openDeepLink();
	});

	/** `fn` may return its own banner — an invite can be created while its email failed. */
	async function run(fn: () => Promise<{ kind: 'ok' | 'warn'; text: string } | void>, ok: string) {
		if (busy) return;
		busy = true;
		banner = null;
		try {
			const outcome = await fn();
			banner = outcome ?? { kind: 'ok', text: ok };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	/** Banner for an invite outcome; a failed email keeps the accept link on screen to copy. */
	function inviteOutcome(inv: CreatedInvite | null | undefined, ok: string): { kind: 'ok' | 'warn'; text: string } {
		copied = false;
		if (inv?.emailDelivery === 'failed') {
			failedInvite = inv;
			return { kind: 'warn', text: m.admin_onboarding_invite_email_failed({ email: inv.email }) };
		}
		failedInvite = null;
		// Early-access approve: seated already; the set-password email waits for the member licence
		// (the backend retries it), so there is nothing to hand over by hand.
		if (inv?.emailDelivery === 'deferred') {
			return { kind: 'ok', text: m.admin_onboarding_invite_deferred({ email: inv.email }) };
		}
		// No password yet: Keycloak sent its set-password email, which continues to the invite link.
		if (inv?.emailDelivery === 'keycloak_actions') {
			return { kind: 'ok', text: m.admin_onboarding_invite_set_password({ email: inv.email }) };
		}
		return { kind: 'ok', text: ok };
	}

	function approve(a: SignupApproval) {
		const mode = modeOf(a);
		if (mode === 'new_tenant') {
			const tenantName = (approveTenantName[a.id] ?? '').trim();
			// Empty is fine when the server has a default for this signup (`suggested_tenant_name`).
			if (!tenantName && !a.suggested_tenant_name) {
				banner = { kind: 'error', text: m.admin_onboarding_tenant_name_required() };
				return;
			}
			if (a.id === focusId) closeFocus();
			// Untouched select → no byoMode: the backend puts the workspace on the platform's local model
			// (NEW_TENANT_PLAN, local-llm → local_allowed). Only an explicit choice is sent.
			const byoMode = approveByo[a.id];
			run(async () => {
				const r = await adminApi.approveSignup(a.id, {
					mode: 'new_tenant',
					...(tenantName ? { tenantName } : {}),
					...(byoMode ? { byoMode } : {})
				});
				return inviteOutcome(r.invite, m.admin_onboarding_approved());
			}, m.admin_onboarding_approved());
			return;
		}
		const tenantId = approveTenant[a.id] ?? a.matched_tenant_id;
		if (!tenantId) {
			banner = { kind: 'error', text: m.admin_onboarding_unmatched() };
			return;
		}
		if (a.id === focusId) closeFocus();
		const role = approveRole[a.id] ?? 'member';
		run(async () => {
			const r = await adminApi.approveSignup(a.id, { mode: 'existing', tenantId, role });
			return inviteOutcome(r.invite, m.admin_onboarding_approved());
		}, m.admin_onboarding_approved());
	}
	function reject(a: SignupApproval) {
		if (a.id === focusId) closeFocus();
		run(() => adminApi.rejectSignup(a.id).then(() => {}), m.admin_onboarding_rejected());
	}
	/** Re-run a rejected signup's cleanup now (the backend re-checks the blockers first). */
	// The banner says what the backend answered: a 200 is either finished (`done`) or still under way
	// (another runner holds it / licences is busy — the row stays `pending`); 409 / 502 are errors.
	function retryRepair(a: SignupApproval) {
		run(
			() =>
				adminApi.rejectSignup(a.id).then(({ approval }) =>
					approval?.reject_repair && approval.reject_repair.state !== 'done'
						? { kind: 'warn' as const, text: m.admin_onboarding_repair_in_progress() }
						: { kind: 'ok' as const, text: m.admin_onboarding_repair_done() }
				),
			m.admin_onboarding_repair_done()
		);
	}
	// RESOLVE MANUALLY: a failed / blocked cleanup whose cause is permanent is closed with a required
	// note (backend `resolved_manually`, audited); the row then leaves this list.
	let resolvingId = $state<string | null>(null);
	let resolveNote = $state('');
	// ⛔ A resolve that leaves the rejected requester's access LIVE (backend
	// `reject_repair_leaves_live_access`: blocked, or failed on a seat / licence / IdP / identity cause)
	// is terminal — nothing ever offboards it afterwards. The form names who keeps access to what and
	// will not submit until that is confirmed explicitly (the backend refuses it unconfirmed too).
	let resolveAckLive = $state(false);
	function startResolve(a: SignupApproval) {
		resolvingId = a.id;
		resolveNote = '';
		resolveAckLive = false;
	}
	function cancelResolve() {
		resolvingId = null;
		resolveNote = '';
		resolveAckLive = false;
	}
	/** The workspace the requester keeps: the one the aborted approve founded, else the first customer
	 *  workspace it seated / invited them into. */
	function repairTenantLabel(a: SignupApproval): string {
		const id = a.reject_repair?.tenantId ?? a.approve_effects?.[0]?.tenantId ?? null;
		return tenantName(id) ?? '—';
	}
	function confirmResolve(a: SignupApproval) {
		const note = resolveNote.trim();
		const live = a.reject_repair_leaves_live_access === true;
		if (!note || (live && !resolveAckLive)) return;
		run(async () => {
			await adminApi.resolveSignupRepair(a.id, note, live);
			cancelResolve();
		}, m.admin_onboarding_repair_resolved());
	}
	/** Guidance per backend error code (REJECT_REPAIR_ERROR_CODES); an unknown code gets the generic line. */
	function codeGuidance(code: string): string {
		switch (code) {
			case 'owner_unknown': return m.admin_onboarding_repair_code_owner_unknown();
			case 'owner_lookup_failed': return m.admin_onboarding_repair_code_owner_lookup_failed();
			case 'archive_failed': return m.admin_onboarding_repair_code_archive_failed();
			case 'seat_failed': return m.admin_onboarding_repair_code_seat_failed();
			case 'licence_failed': return m.admin_onboarding_repair_code_licence_failed();
			case 'idp_failed': return m.admin_onboarding_repair_code_idp_failed();
			case 'identity_failed': return m.admin_onboarding_repair_code_identity_failed();
			case 'effect_failed': return m.admin_onboarding_repair_code_effect_failed();
			case 'offboard_failed': return m.admin_onboarding_repair_code_offboard_failed();
			case 'internal': return m.admin_onboarding_repair_code_internal();
			default: return m.admin_onboarding_repair_code_unknown();
		}
	}
	// Both names are required: Keycloak's VERIFY_PROFILE stops an invitee whose sign-in identity has
	// no first + last name, so an invite without them lands the person on a form instead of the app.
	const invReady = $derived(Boolean(invEmail.trim() && invFirstName.trim() && invLastName.trim() && invTenant));
	function sendInvite() {
		if (!invReady) return;
		run(async () => {
			const r = await adminApi.invite({
				email: invEmail.trim(),
				firstName: invFirstName.trim(),
				lastName: invLastName.trim(),
				tenantId: invTenant,
				role: invRole
			});
			invEmail = '';
			invFirstName = '';
			invLastName = '';
			return inviteOutcome(r.invite, m.admin_onboarding_invited());
		}, m.admin_onboarding_invited());
	}
	const eaReady = $derived(Boolean(eaEmail.trim() && eaName.trim()));
	function sendEarlyAccessInvite() {
		if (!eaReady) return;
		const email = eaEmail.trim();
		const company = eaCompany.trim();
		run(async () => {
			const r = await adminApi.inviteEarlyAccess({
				email,
				name: eaName.trim(),
				...(company ? { company } : {}),
				locale: eaLocale
			});
			eaEmail = '';
			eaName = '';
			eaCompany = '';
			eaLocale = 'en';
			// One line: which workspace was created, then how the invitation went out (a failed email
			// keeps the accept link on screen to copy, exactly as for Approve).
			const delivery = inviteOutcome(r.invite, m.admin_onboarding_invited());
			const created = r.tenant
				? m.admin_onboarding_ea_done({ name: r.tenant.name, slug: r.tenant.slug, email: r.invite?.email ?? email })
				: null;
			return { kind: delivery.kind, text: created ? `${created} ${delivery.text}` : delivery.text };
		}, m.admin_onboarding_invited());
	}
	async function copyInviteUrl(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
		} catch {
			copied = false;
		}
	}
	function addDomain() {
		if (!domDomain.trim() || !domTenant) return;
		run(() => adminApi.upsertEmailDomain({ domain: domDomain.trim(), tenantId: domTenant }).then(() => { domDomain = ''; }), m.admin_onboarding_domain_mapped());
	}
	function removeDomain(d: EmailDomainMapping) {
		run(() => adminApi.deleteEmailDomain(d.domain).then(() => {}), m.admin_onboarding_domain_removed());
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.admin_onboarding_eyebrow()}</div>
		<h1>{m.admin_onboarding_title()}</h1>
		<p>{m.admin_onboarding_lede()}</p>
	</header>

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading}
		<LoadingRows />
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else}
		{#if banner}
			<div class="banner {banner.kind}">{banner.text}</div>
		{/if}
		{#if failedInvite}
			<div class="card invite-link" data-testid="onboarding-invite-link">
				<span class="hint">{m.admin_invite_link_hint()}</span>
				<input readonly value={failedInvite.inviteUrl} aria-label={m.admin_invite_link_label()}
					onfocus={(e) => e.currentTarget.select()} dir="ltr" />
				<button type="button" class="btn-ghost sm" onclick={() => copyInviteUrl(failedInvite!.inviteUrl)}>
					{copied ? m.admin_invite_link_copied() : m.admin_invite_link_copy()}
				</button>
			</div>
		{/if}

		{#if focusMissing}
			<div class="banner warn" data-testid="signup-focus-missing">{m.admin_onboarding_focus_missing()}</div>
		{:else if focused}
			{@const a = focused}
			<div class="card focus" role="dialog" aria-modal="false" aria-labelledby="signup-focus-title" data-testid="signup-focus">
				<h2 id="signup-focus-title">
					{focusAction === 'reject' ? m.admin_onboarding_focus_reject_title() : m.admin_onboarding_focus_approve_title()}
				</h2>
				<p class="hint">{m.admin_onboarding_focus_hint()}</p>
				<dl class="facts">
					<dt>{m.admin_onboarding_email_label()}</dt><dd dir="ltr">{a.email}</dd>
					{#if a.name}<dt>{m.admin_onboarding_name_label()}</dt><dd>{a.name}</dd>{/if}
					{#if a.company}<dt>{m.admin_onboarding_company()}</dt><dd>{a.company}</dd>{/if}
					{#if sourceLabel(a.source)}<dt>{m.admin_onboarding_source()}</dt><dd>{sourceLabel(a.source)}</dd>{/if}
					{#if a.message}<dt>{m.admin_onboarding_message()}</dt><dd class="message" data-testid="signup-focus-message">{a.message}</dd>{/if}
				</dl>
				{#if focusAction === 'approve'}
					<div class="row">
						<select value={modeOf(a)} aria-label={m.admin_onboarding_approve_mode_label()}
							onchange={(e) => { approveMode[a.id] = e.currentTarget.value as 'new_tenant' | 'existing'; }}>
							<option value="new_tenant">{m.admin_onboarding_mode_new_tenant()}</option>
							<option value="existing">{m.admin_onboarding_mode_existing()}</option>
						</select>
						{#if modeOf(a) === 'new_tenant'}
							<input class="row-input" id="signup-focus-name" bind:value={approveTenantName[a.id]} maxlength="120"
								placeholder={a.suggested_tenant_name ?? m.admin_tenants_name_placeholder()} aria-label={m.admin_tenants_name_label()} />
						{:else}
							<select value={approveTenant[a.id] ?? a.matched_tenant_id ?? ''} aria-label={m.admin_onboarding_tenant_label()}
								onchange={(e) => { approveTenant[a.id] = e.currentTarget.value; }}>
								<option value="" disabled>{m.admin_onboarding_unmatched()}</option>
								{#each tenants as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
							</select>
						{/if}
					</div>
				{/if}
				<div class="actions">
					<button type="button" class="btn-ghost" onclick={closeFocus}>{m.admin_onboarding_focus_cancel()}</button>
					{#if focusAction === 'reject'}
						<button type="button" class="btn-danger" data-testid="signup-focus-confirm" disabled={busy} onclick={() => reject(a)}>{m.admin_onboarding_confirm_reject()}</button>
					{:else}
						<button type="button" class="btn-primary" data-testid="signup-focus-confirm" disabled={busy} onclick={() => approve(a)}>{m.admin_onboarding_confirm_approve()}</button>
					{/if}
				</div>
			</div>
		{/if}

		{#if stats}
			<div class="stat-strip">
				<div class="stat"><span class="sv">{num(stats.pending, locale.current)}</span><span class="sl">{m.admin_onboarding_stat_pending()}</span></div>
				<div class="stat"><span class="sv">{num(stats.approved, locale.current)}</span><span class="sl">{m.admin_onboarding_stat_approved()}</span></div>
				<div class="stat"><span class="sv">{num(stats.rejected, locale.current)}</span><span class="sl">{m.admin_onboarding_stat_rejected()}</span></div>
				<div class="stat"><span class="sv">{num(stats.total, locale.current)}</span><span class="sl">{m.admin_onboarding_stat_total()}</span></div>
			</div>
		{/if}

		<div class="layout">
			<section class="main">
				<!-- signup queue -->
				<div class="block-label">{m.admin_onboarding_queue_title()}</div>
				{#if approvals.length === 0}
					<div class="card empty">{m.admin_onboarding_queue_empty()}</div>
				{:else}
					{#each approvals as a (a.id)}
						<div class="card row" class:focused={a.id === focusId} id="signup-{a.id}">
							<div class="meta">
								<div class="name">{a.name || a.email}</div>
								<div class="sub">{a.email}{#if a.company} · {a.company}{/if}{#if sourceLabel(a.source)} · {sourceLabel(a.source)}{/if}</div>
								{#if a.message}<div class="message" data-testid="signup-message">{a.message}</div>{/if}
							</div>
							{#if a.matched_tenant_id}
								<span class="matched" title={tenantIdTitle(a.matched_tenant_id)}>{m.admin_onboarding_matched()}: {tenantName(a.matched_tenant_id)}</span>
							{/if}
							<select value={modeOf(a)} aria-label={m.admin_onboarding_approve_mode_label()}
								onchange={(e) => { approveMode[a.id] = e.currentTarget.value as 'new_tenant' | 'existing'; }}>
								<option value="new_tenant">{m.admin_onboarding_mode_new_tenant()}</option>
								<option value="existing">{m.admin_onboarding_mode_existing()}</option>
							</select>
							{#if modeOf(a) === 'new_tenant'}
								<input class="row-input" bind:value={approveTenantName[a.id]} maxlength="120"
									placeholder={a.suggested_tenant_name ?? m.admin_tenants_name_placeholder()} aria-label={m.admin_tenants_name_label()}
									title={a.suggested_tenant_name ? m.admin_onboarding_tenant_name_suggested({ name: a.suggested_tenant_name }) : undefined} />
								<select value={approveByo[a.id] ?? 'local_allowed'} aria-label={m.admin_tenants_byo_label()}
									onchange={(e) => { approveByo[a.id] = e.currentTarget.value as ByoMode; }}>
									<option value="byo_required">{m.admin_tenants_byo_required()}</option>
									<option value="local_allowed">{m.admin_tenants_byo_local_allowed()}</option>
									<option value="platform_only">{m.admin_tenants_byo_platform_only()}</option>
								</select>
							{:else}
								<select value={approveTenant[a.id] ?? a.matched_tenant_id ?? ''} aria-label={m.admin_onboarding_tenant_label()}
									onchange={(e) => { approveTenant[a.id] = e.currentTarget.value; }}>
									<option value="" disabled>{m.admin_onboarding_unmatched()}</option>
									{#each tenants as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
								</select>
								<select value={approveRole[a.id] ?? 'member'} aria-label={m.admin_onboarding_role_label()}
									onchange={(e) => { approveRole[a.id] = e.currentTarget.value as TenantRole; }}>
									<option value="member">{m.admin_onboarding_role_member()}</option>
									<option value="developer">{m.admin_onboarding_role_developer()}</option>
									<option value="tenant_admin">{m.admin_onboarding_role_admin()}</option>
								</select>
							{/if}
							<button class="btn-primary sm" disabled={busy} onclick={() => approve(a)}>{m.admin_onboarding_approve()}</button>
							<button class="btn-ghost sm" disabled={busy} onclick={() => reject(a)}>{m.admin_onboarding_reject()}</button>
						</div>
					{/each}
				{/if}

				{#if repairs.length > 0}
					<!-- rejected signups whose cleanup is not finished -->
					<div class="block-label" style="margin-top:22px" data-testid="signup-repairs-title">{m.admin_onboarding_repair_title()}</div>
					<p class="hint">{m.admin_onboarding_repair_hint()}</p>
					{#each repairs as a (a.id)}
						<div class="card row" data-testid="signup-repair-{a.id}">
							<div class="meta">
								<div class="name">{a.name || a.email}</div>
								<div class="sub">{a.email}{#if a.company} · {a.company}{/if}</div>
								{#if a.reject_repair?.state === 'blocked'}
									<div class="repair-state warn" data-testid="signup-repair-state">{m.admin_onboarding_repair_blocked({ blockers: (a.reject_repair.blockers ?? []).join(', ') })}</div>
								{:else if a.reject_repair?.state === 'failed'}
									<div class="repair-state warn" data-testid="signup-repair-state">{m.admin_onboarding_repair_failed({ attempts: a.reject_repair.attempts, error: a.reject_repair.lastError ?? '—' })}</div>
								{:else}
									<div class="repair-state" data-testid="signup-repair-state">{m.admin_onboarding_repair_pending({ error: a.reject_repair?.lastError ?? '—' })}</div>
								{/if}
								{#if a.reject_repair?.state !== 'blocked' && (a.reject_repair?.lastErrorCodes ?? []).length > 0}
									<ul class="repair-codes" data-testid="signup-repair-codes">
										{#each a.reject_repair?.lastErrorCodes ?? [] as code (code)}
											<li data-testid="signup-repair-code-{code}"><code>{code}</code> {codeGuidance(code)}</li>
										{/each}
									</ul>
								{/if}
								{#if resolvingId === a.id}
									<div class="repair-resolve" data-testid="signup-repair-resolve-form">
										{#if a.reject_repair_leaves_live_access}
											<div class="repair-live warn" role="alert" data-testid="signup-repair-resolve-live-warning">{m.admin_onboarding_repair_resolve_live_warning({ email: a.email, tenant: repairTenantLabel(a) })}</div>
											<label class="repair-live-ack">
												<input type="checkbox" bind:checked={resolveAckLive} data-testid="signup-repair-resolve-live-ack" />
												<span>{m.admin_onboarding_repair_resolve_live_ack({ email: a.email })}</span>
											</label>
										{/if}
										<label>
											<span class="hint">{m.admin_onboarding_repair_resolve_note()}</span>
											<textarea rows="2" maxlength="1000" bind:value={resolveNote} data-testid="signup-repair-resolve-note"></textarea>
										</label>
										<div class="repair-resolve-actions">
											<button class="btn-primary sm" data-testid="signup-repair-resolve-confirm" disabled={busy || !resolveNote.trim() || (a.reject_repair_leaves_live_access === true && !resolveAckLive)} onclick={() => confirmResolve(a)}>{m.admin_onboarding_repair_resolve_confirm()}</button>
											<button class="btn-ghost sm" data-testid="signup-repair-resolve-cancel" disabled={busy} onclick={cancelResolve}>{m.admin_onboarding_repair_resolve_cancel()}</button>
										</div>
									</div>
								{/if}
							</div>
							{#if a.reject_repair?.tenantId}
								<span class="matched" title={tenantIdTitle(a.reject_repair.tenantId)}>{tenantName(a.reject_repair.tenantId)}</span>
							{/if}
							<button class="btn-ghost sm" data-testid="signup-repair-retry" disabled={busy} onclick={() => retryRepair(a)}>{m.admin_onboarding_repair_retry()}</button>
							{#if (a.reject_repair?.state === 'failed' || a.reject_repair?.state === 'blocked') && resolvingId !== a.id}
								<button class="btn-ghost sm" data-testid="signup-repair-resolve" disabled={busy} onclick={() => startResolve(a)}>{m.admin_onboarding_repair_resolve()}</button>
							{/if}
						</div>
					{/each}
				{/if}

				<!-- email-domain routing -->
				<div class="block-label" style="margin-top:22px">{m.admin_onboarding_domains_title()}</div>
				{#if domains.length === 0}
					<div class="card empty">{m.admin_onboarding_domains_empty()}</div>
				{:else}
					{#each domains as d (d.domain)}
						<div class="card row">
							<div class="meta">
								<div class="name mono">{d.domain}</div>
								<div class="sub" title={tenantIdTitle(d.tenant_id)}><span class="cp-dir-mirror" aria-hidden="true">→</span> {tenantName(d.tenant_id)}</div>
							</div>
							<span class="count">{d.auto_assign ? m.onboarding_domain_auto() : m.onboarding_domain_manual()}</span>
							<button class="btn-ghost sm" disabled={busy} onclick={() => removeDomain(d)}>{m.admin_onboarding_remove()}</button>
						</div>
					{/each}
				{/if}
				<form class="card inline" onsubmit={(e) => { e.preventDefault(); addDomain(); }}>
					<input bind:value={domDomain} placeholder={m.admin_onboarding_domain_placeholder()} aria-label={m.admin_onboarding_domain_label()} />
					<select bind:value={domTenant} aria-label={m.admin_onboarding_tenant_label()}>
						{#each tenants as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
					</select>
					<button class="btn-ghost" type="submit" disabled={!domDomain.trim() || !domTenant || busy}>{m.admin_onboarding_domain_add()}</button>
				</form>
			</section>

			<!-- invite -->
			<aside class="side">
				<div class="preview-label">{m.admin_onboarding_ea_title()}</div>
				<form class="card" data-testid="ea-invite-form" onsubmit={(e) => { e.preventDefault(); sendEarlyAccessInvite(); }}>
					<p class="hint ea-hint">{m.admin_onboarding_ea_hint()}</p>
					<div class="field">
						<label for="ea-email">{m.admin_onboarding_email_label()}</label>
						<input id="ea-email" type="email" bind:value={eaEmail} maxlength="320" placeholder="person@company.com" required />
					</div>
					<div class="field">
						<label for="ea-name">{m.admin_onboarding_ea_name()}</label>
						<input id="ea-name" type="text" autocomplete="off" bind:value={eaName} maxlength="160" required />
					</div>
					<div class="field">
						<label for="ea-company">{m.admin_onboarding_ea_company()}</label>
						<input id="ea-company" type="text" autocomplete="off" bind:value={eaCompany} maxlength="160" />
					</div>
					<div class="field">
						<label for="ea-locale">{m.admin_onboarding_ea_locale()}</label>
						<select id="ea-locale" data-testid="ea-locale" bind:value={eaLocale}>
							{#each SIGNUP_LOCALES as l (l)}<option value={l}>{LOCALE_NAME[l]}</option>{/each}
						</select>
					</div>
					<div class="actions">
						<button class="btn-primary" type="submit" disabled={!eaReady || busy}>{m.admin_onboarding_ea_btn()}</button>
					</div>
				</form>

				<div class="preview-label">{m.admin_onboarding_invite_title()}</div>
				<form class="card" onsubmit={(e) => { e.preventDefault(); sendInvite(); }}>
					<div class="field">
						<label for="inv-email">{m.admin_onboarding_email_label()}</label>
						<input id="inv-email" type="email" bind:value={invEmail} placeholder="person@company.com" />
					</div>
					<div class="field">
						<label for="inv-first-name">{m.admin_members_first_name_label()}</label>
						<input id="inv-first-name" type="text" autocomplete="off" bind:value={invFirstName} required />
					</div>
					<div class="field">
						<label for="inv-last-name">{m.admin_members_last_name_label()}</label>
						<input id="inv-last-name" type="text" autocomplete="off" bind:value={invLastName} required />
					</div>
					<div class="field">
						<label for="inv-tenant">{m.admin_onboarding_tenant_label()}</label>
						<select id="inv-tenant" bind:value={invTenant}>
							{#each tenants as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
						</select>
					</div>
					<div class="field">
						<label for="inv-role">{m.admin_onboarding_role_label()}</label>
						<select id="inv-role" bind:value={invRole}>
							<option value="member">{m.admin_onboarding_role_member()}</option>
							<option value="developer">{m.admin_onboarding_role_developer()}</option>
							<option value="tenant_admin">{m.admin_onboarding_role_admin()}</option>
						</select>
					</div>
					<div class="actions">
						<button class="btn-primary" type="submit" disabled={!invReady || busy}>{m.admin_onboarding_invite_btn()}</button>
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
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 680px; }
	.layout { display: grid; grid-template-columns: 1fr 320px; gap: 22px; align-items: start; }
	.main { display: flex; flex-direction: column; gap: 10px; }
	.block-label { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; color: var(--c-muted); margin-bottom: 2px; }
	.stat-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
	.stat { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 12px 14px; display: flex; flex-direction: column; gap: 3px; }
	.stat .sv { font-family: var(--font-display); font-size: 22px; color: var(--c-midnight); font-variant-numeric: tabular-nums; }
	.stat .sl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--c-muted); font-weight: 600; }
	@media (max-width: 720px) { .stat-strip { grid-template-columns: repeat(2, 1fr); } }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 14px 16px; }
	.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
	/* The signup-queue controls keep their size; the actor name/email truncate inside .meta
	   instead of overflowing into the tenant/role selects. */
	.row > select, .row > button, .row > .matched { flex-shrink: 0; }
	.row .name, .row .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.inline { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
	.inline input { flex: 1; }
	.meta { flex: 1; min-width: 140px; }
	.name { font-weight: 600; font-size: 14px; color: var(--c-ink); }
	.name.mono, .mono { font-family: var(--font-mono); font-size: 12.5px; }
	.sub { font-size: 11.5px; color: var(--c-muted); margin-top: 2px; }
	.matched { font-size: 11.5px; color: var(--c-teal-dark); background: var(--c-teal-pale); padding: 3px 9px; border-radius: 999px; }
	.count { font-size: 11.5px; color: var(--c-muted); }
	.empty { color: var(--c-muted); font-size: 13px; text-align: center; }
	.side { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 20px; }
	.preview-label { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; color: var(--c-muted); }
	.field { display: flex; flex-direction: column; margin-bottom: 12px; }
	label { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 6px; }
	input, select { font-family: var(--font-sans); font-size: 13.5px; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px; box-sizing: border-box; background: var(--c-white); }
	.field input, .field select { width: 100%; }
	.actions { display: flex; justify-content: flex-end; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 10px 18px; border-radius: var(--r); border: none; }
	.btn-primary.sm, .btn-ghost.sm { padding: 7px 12px; font-size: 12px; }
	.btn-primary:disabled, .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { font-size: 12.5px; font-weight: 500; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); padding: 7px 14px; border-radius: var(--r); }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); margin-bottom: 14px; }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	/* 'warn' is deliberately NOT the error red: the user really was provisioned, so painting it as
	   a failure would send an operator hunting a problem that does not exist. It is also not the
	   ok teal, which is exactly the lie this screen is fixing. */
	.banner.warn { background: var(--c-amber-pale); border: 1px solid var(--c-amber-light); color: var(--c-amber-dark, #92400E); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.row-input { flex: 1 1 140px; min-width: 120px; font-size: 12.5px; padding: 7px 10px; }
	.row.focused { border-color: var(--c-teal); box-shadow: 0 0 0 2px var(--c-teal-pale); }
	.focus { margin-bottom: 18px; border-color: var(--c-teal); display: flex; flex-direction: column; gap: 10px; }
	.focus h2 { font-family: var(--font-display); font-size: 18px; margin: 0; color: var(--c-midnight); }
	.focus .hint { margin: 0; }
	.focus .facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; font-size: 13px; }
	.focus .facts dt { color: var(--c-muted); font-weight: 600; }
	/* The applicant's own text: line breaks kept, long words wrapped, plain text only. */
	.message { white-space: pre-wrap; overflow-wrap: anywhere; }
	.row .message { font-size: 12px; margin-top: 4px; max-height: 7.5em; overflow-y: auto; }
	.repair-state { font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; color: var(--c-muted); }
	.repair-state.warn { color: var(--c-amber-dark, #92400E); }
	.repair-codes { margin: 4px 0 0; padding-inline-start: 16px; font-size: 12px; color: var(--c-muted); overflow-wrap: anywhere; }
	.repair-codes code { font-size: 11px; }
	.repair-resolve { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
	.repair-resolve label { display: flex; flex-direction: column; gap: 4px; }
	.repair-resolve textarea { width: 100%; max-width: 480px; font: inherit; }
	.repair-resolve-actions { display: flex; gap: 6px; flex-wrap: wrap; }
	.repair-live { font-size: 12px; overflow-wrap: anywhere; color: var(--c-amber-dark, #92400E); font-weight: 600; }
	.repair-resolve label.repair-live-ack { flex-direction: row; align-items: flex-start; gap: 6px; font-size: 12px; }
	.focus .facts dd { margin: 0; color: var(--c-ink); overflow-wrap: anywhere; }
	.focus .actions { gap: 8px; }
	.btn-danger { background: var(--c-coral-dark); color: #fff; font-weight: 600; font-size: 13px; padding: 10px 18px; border-radius: var(--r); border: none; }
	.btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
	.invite-link { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
	.invite-link .hint { width: 100%; margin: 0; }
	.invite-link input { flex: 1; min-width: 240px; font-family: var(--font-mono); font-size: 11.5px; }
	.hint { font-size: 11.5px; color: var(--c-muted); margin: 6px 0 0; }
	.ea-hint { margin: 0 0 12px; }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
	@media (max-width: 820px) { .layout { grid-template-columns: 1fr; } .side { position: static; } }
</style>
