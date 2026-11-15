<script lang="ts">
	// Tenants — the PLATFORM all-tenants screen (Phase 4 / Phase B, super_admin only).
	// A compact list of every tenant (each row opens /tenants/<id>, where the licence editor and
	// every per-tenant action live) plus the create form behind a "New workspace" button, so the
	// list keeps the full width. Backend: GET /api/admin/tenants, POST /api/tenants — both
	// super_admin-gated server-side; the (platform) route group guards the shell.
	import { onMount } from 'svelte';
	import { adminApi, ApiError } from '$lib/api/admin';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { seatsUsedOf, type PlatformTenant, type ByoMode, type CreatedInvite, type LicencePlan } from '$lib/types/admin';
	import { dateInputToIso } from '$lib/admin/licence-terms';
	import { addBundleKeys, failedBundleKeys, MAX_BUNDLES } from '$lib/admin/licence-bundles';
	import { licenseChipFor } from '$lib/admin/license-chip';
	import {
		EMPTY_TERMS_DRAFT,
		NEW_TENANT_PLAN,
		parseTermsDraft,
		planFixedByo,
		planHelp,
		postureFor,
		rateCardToDraft,
		type TermsDraft
	} from '$lib/admin/billing-terms';
	import ByoModeField from '$lib/components/admin/ByoModeField.svelte';
	import {
		LICENSE_CHIP_HINT,
		LICENSE_CHIP_LABEL,
		isAutoSlug,
		isSystemTenantRow,
		licencesAlias,
		planLimitsText
	} from '$lib/admin/tenant-labels';
	import * as m from '$lib/paraglide/messages';
	import { num, fullDate } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let tenants = $state<PlatformTenant[]>([]);

	// Create form, collapsed behind "New workspace". Billing terms are optional here (all three empty
	// = none written; set them later on the workspace's page).
	let createOpen = $state(false);
	let name = $state('');
	let firstAdminEmail = $state('');
	// Required with the email (backend refuses without): the realm requires both names, and an
	// identity minted without them is stopped at Keycloak's profile form on first sign-in.
	let firstAdminFirstName = $state('');
	let firstAdminLastName = $state('');
	let byoMode = $state<ByoMode>('byo_required');
	let maxMembers = $state('');
	let busy = $state(false);
	// Licence terms at create (A2). `planCode` '' = not chosen yet (the plan list has not loaded or
	// could not be read) → omitted from the body together with `byoMode`, and the backend applies
	// NEW_TENANT_PLAN (local-llm). `effectivePlan` is what that create will actually be on, so the
	// posture field shows local-llm's fixed posture instead of sending a contradicting byoMode.
	let planCode = $state('');
	const effectivePlan = $derived(planCode || NEW_TENANT_PLAN);
	let startsAt = $state('');
	let expiresAt = $state('');
	// The plan catalogue, for the create select. `plansError` is set when it could not be read:
	// create still works (default plan).
	let plans = $state<LicencePlan[]>([]);
	let defaultPlanCode = $state<string | null>(null);
	let plansError = $state(false);
	const activePlans = $derived(plans.filter((p) => !p.revoked));
	const selectedPlan = $derived(plans.find((p) => p.code === planCode) ?? null);
	// local-llm / byo FIX the posture: the select follows the plan and is locked; the body omits it.
	const fixedByo = $derived(planFixedByo(effectivePlan));
	// The posture the OPERATOR last chose; a plan that fixes it overrides it only while selected.
	let chosenByo = $state<ByoMode>('byo_required');
	$effect(() => {
		const want = postureFor(effectivePlan, chosenByo);
		if (byoMode !== want) byoMode = want;
	});
	const selectedPlanHelp = $derived(planHelp(effectivePlan));
	let terms = $state<TermsDraft>({ ...EMPTY_TERMS_DRAFT });
	// Licences bundles (backend 0104): free-form keys as chips — licences has no listing endpoint and
	// decides which keys exist, so the form checks only their shape.
	let bundleKeys = $state<string[]>([]);
	let bundleDraft = $state('');
	let bundleError = $state<string | null>(null);
	function addBundles(): boolean {
		const out = addBundleKeys(bundleKeys, bundleDraft);
		if (out.invalid) {
			bundleError = m.admin_tenants_bundles_invalid({ bundle: out.invalid });
			return false;
		}
		if (out.tooMany) {
			bundleError = m.admin_tenants_bundles_too_many({ max: num(MAX_BUNDLES, locale.current) });
			return false;
		}
		bundleKeys = out.keys;
		bundleDraft = '';
		bundleError = null;
		return true;
	}
	function removeBundle(key: string) {
		bundleKeys = bundleKeys.filter((k) => k !== key);
	}
	// The first-admin invite from the last create. When the email failed, its link is the only way in.
	let inviteResult = $state<CreatedInvite | null>(null);
	let copied = $state(false);
	// `warn` is a THIRD outcome, not a nicer error: something SUCCEEDED with work left over (an
	// invite whose email failed). Coral would say "retry"; teal would hide it.
	let banner = $state<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

	function parseSeats(raw: string): number | undefined | null {
		const t = raw.trim();
		if (!t) return undefined;
		const n = Number.parseInt(t, 10);
		return Number.isInteger(n) && n > 0 ? n : null;
	}

	const PAGE_SIZE = 25;
	let offset = $state(0);
	let total = $state(0);
	const shownTo = $derived(Math.min(offset + tenants.length, total));

	async function load() {
		loading = true;
		denied = false;
		loadError = null;
		try {
			const res = await adminApi.allTenants({ limit: PAGE_SIZE, offset });
			tenants = res.tenants;
			total = res.total ?? res.tenants.length;
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		load();
		loadPlans();
		loadRateCard();
	});

	// Billing's STANDARD rate card prefills the terms; the operator edits from there. Non-fatal: no
	// rate card (billing not wired / older billing) leaves the three fields empty, as before.
	let rateCardDraft = $state<TermsDraft | null>(null);
	async function loadRateCard() {
		try {
			const { rateCard } = await adminApi.rateCard();
			if (!rateCard) return;
			rateCardDraft = rateCardToDraft(rateCard);
			if (!terms.platformFee && !terms.seatFee && !terms.markup) terms = { ...rateCardDraft };
		} catch {
			/* the form still works without a prefill */
		}
	}

	function goPage(nextOffset: number) {
		offset = Math.max(0, nextOffset);
		load();
	}

	/** The create form's starting plan: NEW_TENANT_PLAN (local-llm) when it is live in the catalogue,
	 *  else the deployment default when that is live, else '' (not chosen). */
	function initialPlan(list: LicencePlan[], deploymentDefault: string | null): string {
		const live = (code: string | null) => !!code && list.some((p) => p.code === code && !p.revoked);
		if (live(NEW_TENANT_PLAN)) return NEW_TENANT_PLAN;
		return live(deploymentDefault) ? deploymentDefault! : '';
	}

	/** The plan catalogue (non-fatal: the create form falls back to NEW_TENANT_PLAN). */
	async function loadPlans() {
		try {
			const res = await adminApi.plans({ includeRevoked: true });
			plans = res.plans;
			defaultPlanCode = res.defaultPlanCode;
			plansError = false;
			// Pre-select once — never overwrite a plan the operator already picked.
			if (!planCode) planCode = initialPlan(res.plans, res.defaultPlanCode);
		} catch {
			plansError = true;
		}
	}

	function planLabel(code: string): string {
		const p = plans.find((x) => x.code === code);
		return p ? p.name : code;
	}

	/** The banner for a created/resent invite, by how it was delivered. */
	function inviteBanner(inv: CreatedInvite): { kind: 'ok' | 'warn'; text: string } {
		if (inv.emailDelivery === 'failed') {
			return { kind: 'warn', text: m.admin_tenants_created_invite_failed({ email: inv.email }) };
		}
		if (inv.emailDelivery === 'keycloak_actions') {
			return { kind: 'ok', text: m.admin_tenants_created_set_password({ email: inv.email }) };
		}
		return { kind: 'ok', text: m.admin_tenants_created_invited({ email: inv.email }) };
	}

	async function create() {
		if (!name.trim() || busy) return;
		const seats = parseSeats(maxMembers);
		if (seats === null) {
			banner = { kind: 'error', text: m.admin_tenants_seats_invalid() };
			return;
		}
		const start = dateInputToIso(startsAt);
		const end = dateInputToIso(expiresAt);
		if (start === undefined || end === undefined) {
			banner = { kind: 'error', text: m.admin_tenants_date_invalid() };
			return;
		}
		if (start && end && new Date(end).getTime() <= new Date(start).getTime()) {
			banner = { kind: 'error', text: m.error_licence_window_invalid() };
			return;
		}
		if (firstAdminEmail.trim() && (!firstAdminFirstName.trim() || !firstAdminLastName.trim())) {
			banner = { kind: 'error', text: m.admin_tenants_first_admin_names_required() };
			return;
		}
		const parsedTerms = parseTermsDraft(terms);
		if (!parsedTerms.ok) {
			banner = { kind: 'error', text: m.admin_terms_invalid() };
			return;
		}
		// A key still typed in the chip input counts — nobody expects it dropped on submit.
		if (bundleDraft.trim() && !addBundles()) {
			banner = { kind: 'error', text: bundleError ?? m.error_create_failed() };
			return;
		}
		busy = true;
		banner = null;
		inviteResult = null;
		copied = false;
		const invitedEmail = firstAdminEmail.trim();
		try {
			const res = await adminApi.createTenant({
				name: name.trim(),
				...(fixedByo ? {} : { byoMode }),
				...(parsedTerms.terms ? { terms: parsedTerms.terms } : {}),
				...(firstAdminEmail.trim()
					? {
							firstAdminEmail: firstAdminEmail.trim(),
							firstAdminFirstName: firstAdminFirstName.trim(),
							firstAdminLastName: firstAdminLastName.trim()
						}
					: {}),
				...(seats !== undefined ? { maxMembers: seats } : {}),
				...(planCode ? { planCode } : {}),
				...(start ? { startsAt: start } : {}),
				...(end ? { expiresAt: end } : {}),
				...(bundleKeys.length > 0 ? { licenceBundles: [...bundleKeys] } : {})
			});
			name = '';
			firstAdminEmail = '';
			firstAdminFirstName = '';
			firstAdminLastName = '';
			maxMembers = '';
			byoMode = 'byo_required';
			chosenByo = 'byo_required';
			startsAt = '';
			expiresAt = '';
			terms = rateCardDraft ? { ...rateCardDraft } : { ...EMPTY_TERMS_DRAFT };
			bundleKeys = [];
			bundleDraft = '';
			bundleError = null;
			planCode = initialPlan(plans, defaultPlanCode);
			inviteResult = res.invite ?? null;
			// The tenant stands when the first-admin invite fails (tenant-service step 5): the response
			// then carries `inviteError` and `invite: null`, and a plain "created" would hide that
			// nobody was invited.
			const head: { kind: 'ok' | 'warn'; text: string } = res.invite
				? inviteBanner(res.invite)
				: res.inviteError
					? {
							kind: 'warn',
							text: `${m.admin_tenants_created_invite_error({ email: invitedEmail })} ${writeErrorText(
								new ApiError(409, res.inviteError, res.inviteError),
								''
							)}`.trim()
						}
					: { kind: 'ok', text: m.admin_tenants_created() };
			// CP registers its OWN licences tenant; when the slug was taken there it got `<slug>-cp…`.
			// Say so — it is the name the operator will find in licences.
			const alias = licencesAlias(res.tenant.slug, res.tenant.licences_name);
			const extra: string[] = [];
			if (alias) extra.push(m.admin_tenants_licences_registered_as({ name: alias }));
			// The tenant stands when billing refused its terms or its local-LLM access could not be set
			// up — both are finished from its page, and both must be SAID, not hidden behind "created".
			// Name the step and the REAL cause: billing being unavailable (terms held, retried by the
			// backend) is not the same sentence as billing refusing them (terms held, needs Retry).
			if (res.termsError) {
				const termsStep = res.provisioning?.steps.billing_terms;
				extra.push(
					termsStep?.status === 'pending'
						? m.admin_tenants_terms_pending()
						: termsStep?.status === 'failed'
							? m.admin_tenants_terms_refused()
							: m.admin_tenants_terms_failed()
				);
			}
			if (res.inferenceError) extra.push(m.admin_tenants_inference_failed());
			// The tenant stands when a licences bundle was refused (backend 0104): name the bundles.
			const failedBundles = failedBundleKeys(res.licenceBundles);
			if (res.licenceBundlesError || failedBundles.length > 0) {
				extra.push(m.admin_tenants_bundles_failed({ bundles: failedBundles.join(', ') }));
			}
			const kind =
				res.termsError || res.inferenceError || res.licenceBundlesError || failedBundles.length > 0
					? 'warn'
					: head.kind;
			banner = { kind, text: [head.text, ...extra].join(' ') };
			offset = 0;
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_create_failed()) };
		} finally {
			busy = false;
		}
	}

	async function copyInviteUrl(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
		} catch {
			copied = false;
		}
	}

	const statusLabel = (s: string): string =>
		s === 'active' ? m.tenant_status_active() : m.tenant_status_suspended();

	function seatsText(t: PlatformTenant): string {
		return t.maxMembers === null
			? m.admin_tenants_seats_used_unlimited({ used: num(seatsUsedOf(t), locale.current) })
			: m.admin_tenants_seats_used({ used: num(seatsUsedOf(t), locale.current), max: num(t.maxMembers, locale.current) });
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="head-text">
			<div class="eyebrow">{m.admin_tenants_eyebrow()}</div>
			<h1>{m.admin_tenants_title()}</h1>
			<p>{m.admin_tenants_lede()}</p>
		</div>
		<!-- Open: a quiet secondary "Cancel", not a second green primary beside the form's own submit. -->
		<button class={createOpen ? 'btn-ghost' : 'btn-primary'} data-testid="tenant-new" aria-expanded={createOpen} aria-controls="tenant-create"
			onclick={() => (createOpen = !createOpen)}>
			{createOpen ? m.common_cancel() : m.admin_tenants_new()}
		</button>
	</header>

	{#if createOpen}
		<!-- The create form, folded out above the list rather than beside it: the list keeps the
		     full width. Every field says in plain words what it does (owner's ask: "I won't remember"). -->
		<form id="tenant-create" class="card create" onsubmit={(e) => { e.preventDefault(); create(); }}>
			<div class="preview-label">{m.admin_tenants_create()}</div>
			<div class="create-grid">
				<div class="field">
					<label for="tname">{m.admin_tenants_name_label()}</label>
					<input id="tname" bind:value={name} maxlength="120" placeholder={m.admin_tenants_name_placeholder()} />
					<span class="hint">{m.admin_tenants_name_help()}</span>
				</div>
				<div class="field">
					<label for="tadmin">{m.admin_tenants_first_admin_label()}</label>
					<input id="tadmin" type="email" bind:value={firstAdminEmail} placeholder="person@company.com" />
					<span class="hint">{m.admin_tenants_first_admin_help({ role: m.admin_onboarding_role_admin() })}</span>
				</div>
				{#if firstAdminEmail.trim()}
					<div class="field">
						<label for="tadmin-first">{m.admin_tenants_first_admin_first_name_label()}</label>
						<input id="tadmin-first" bind:value={firstAdminFirstName} maxlength="80" required autocomplete="off" />
					</div>
					<div class="field">
						<label for="tadmin-last">{m.admin_tenants_first_admin_last_name_label()}</label>
						<input id="tadmin-last" bind:value={firstAdminLastName} maxlength="80" required autocomplete="off" />
						<span class="hint">{m.admin_tenants_first_admin_names_required()}</span>
					</div>
				{/if}
				<div class="field wide">
					<ByoModeField id="tbyo" testid="create" bind:value={byoMode} fixed={fixedByo}
						onchoose={(mode) => (chosenByo = mode)} />
				</div>
				<div class="field">
					<label for="tplan">{m.admin_tenants_plan_label()}</label>
					<!-- Current plans only: a retired plan cannot be assigned (422 plan_retired). '' =
					     the deployment default, used when the catalogue could not be read. -->
					<select id="tplan" bind:value={planCode}>
						{#if !planCode}<option value="">{m.admin_tenants_plan_default_option()}</option>{/if}
						{#each activePlans as p (p.id)}
							<option value={p.code}>
								{p.isDefault ? m.admin_tenants_plan_option_default({ name: p.name }) : p.name}
							</option>
						{/each}
					</select>
					<span class="hint">{plansError ? m.admin_tenants_plans_unavailable() : m.admin_tenants_plan_hint()}</span>
					{#if selectedPlanHelp}
						<span class="hint" data-testid="create-plan-help">{selectedPlanHelp}</span>
					{/if}
					{#if selectedPlan}
						<span class="hint" data-testid="create-plan-limits">{planLimitsText(selectedPlan, locale.current)}</span>
					{/if}
				</div>
				<div class="field">
					<label for="tseats">{m.admin_tenants_seats_label()}</label>
					<input id="tseats" bind:value={maxMembers} inputmode="numeric" placeholder={m.admin_tenants_seats_placeholder()} />
					<span class="hint">{m.admin_tenants_seats_help()}</span>
				</div>
				<div class="field">
					<label for="tstart">{m.admin_licence_starts_label()}</label>
					<input id="tstart" type="date" bind:value={startsAt} />
					<span class="hint">{m.admin_tenants_starts_help()}</span>
				</div>
				<div class="field">
					<label for="texpires">{m.admin_licence_expires_label()}</label>
					<input id="texpires" type="date" bind:value={expiresAt} />
					<span class="hint">{m.admin_tenants_expires_help()}</span>
				</div>
				<div class="field wide">
					<label for="tbundles">{m.admin_tenants_bundles_label()}</label>
					{#if bundleKeys.length > 0}
						<ul class="bundle-chips" data-testid="create-bundle-chips">
							{#each bundleKeys as key (key)}
								<li class="bundle-chip">
									<code dir="ltr">{key}</code>
									<button type="button" class="chip-remove" aria-label={m.admin_tenants_bundles_remove({ bundle: key })}
										onclick={() => removeBundle(key)}>×</button>
								</li>
							{/each}
						</ul>
					{/if}
					<div class="bundle-input">
						<input id="tbundles" data-testid="create-bundles-input" bind:value={bundleDraft} dir="ltr" autocomplete="off"
							placeholder={m.admin_tenants_bundles_placeholder()}
							onkeydown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addBundles(); } }} />
						<button type="button" class="btn-ghost" data-testid="create-bundles-add" disabled={!bundleDraft.trim()}
							onclick={() => addBundles()}>{m.admin_tenants_bundles_add()}</button>
					</div>
					{#if bundleError}<span class="hint error" data-testid="create-bundles-error">{bundleError}</span>{/if}
					<span class="hint">{m.admin_tenants_bundles_help()}</span>
				</div>
				<div class="field wide">
					<span class="hint">{m.admin_tenants_create_terms_help()}</span>
				</div>
				<div class="field">
					<label for="cplatform">{m.admin_terms_platform_fee_label()}</label>
					<input id="cplatform" data-testid="create-terms-platform-fee" inputmode="decimal" bind:value={terms.platformFee} />
					<span class="hint">{m.admin_terms_platform_fee_help()}</span>
				</div>
				<div class="field">
					<label for="cseat">{m.admin_terms_seat_fee_label()}</label>
					<input id="cseat" data-testid="create-terms-seat-fee" inputmode="decimal" bind:value={terms.seatFee} />
					<span class="hint">{m.admin_terms_seat_fee_help()}</span>
				</div>
				<div class="field">
					<label for="cmarkup">{m.admin_terms_markup_label()}</label>
					<input id="cmarkup" data-testid="create-terms-markup" inputmode="decimal" bind:value={terms.markup} />
					<span class="hint">{m.admin_terms_markup_help()}</span>
				</div>
			</div>
			<div class="actions">
				<button class="btn-primary" type="submit" disabled={!name.trim() || busy}>{m.admin_tenants_create()}</button>
			</div>
		</form>
	{/if}

	{#if banner}<div class="banner {banner.kind}">{banner.text}</div>{/if}
	{#if inviteResult && inviteResult.emailDelivery === 'failed'}
		<div class="card invite-link" data-testid="tenant-invite-link">
			<div class="hint">{m.admin_invite_link_hint()}</div>
			<input readonly value={inviteResult.inviteUrl} aria-label={m.admin_invite_link_label()}
				onfocus={(e) => e.currentTarget.select()} dir="ltr" />
			<button type="button" class="btn-ghost" onclick={() => copyInviteUrl(inviteResult!.inviteUrl)}>
				{copied ? m.admin_invite_link_copied() : m.admin_invite_link_copy()}
			</button>
		</div>
	{/if}

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else if tenants.length === 0}
		<div class="card empty">{m.admin_tenants_empty()}</div>
	{:else}
		<div class="table">
			<div class="thead" aria-hidden="true">
				<span>{m.admin_tenants_col_name()}</span>
				<span>{m.admin_tenants_col_status()}</span>
				<span>{m.admin_tenants_col_plan()}</span>
				<span class="num">{m.admin_tenants_col_seats()}</span>
			</div>
			{#each tenants as t (t.id)}
				{@const system = isSystemTenantRow(t)}
				{@const chip = licenseChipFor(t)}
				{@const gone = t.offboardedAt != null}
				{@const alias = licencesAlias(t.slug, t.licencesName)}
				<a class="trow" href="/tenants/{t.id}" data-testid="tenant-row"
					class:suspended={t.status === 'suspended'} class:gone>
					<span class="cell meta">
						<!-- Long names TRUNCATE (ellipsis, full name in `title`) — they used to run under
						     the plan chip on the same line. -->
						<span class="name" data-testid="tenant-name" title={t.name}>{t.name}</span>
						<!-- The system row's badge already says "System workspace"; the subtitle does not repeat it. -->
						{#if !system}
							<span class="slug" title={t.slug}>
								{isAutoSlug(t.slug) ? m.tenant_personal_subtitle() : t.slug}
								{#if alias}
									<span class="alias" data-testid="tenant-licences-name">· {m.admin_tenants_licences_name_short({ name: alias })}</span>
								{/if}
							</span>
						{/if}
					</span>
					<span class="cell badges">
						{#if gone}
							<span class="status offboarded">{m.tenant_status_offboarded()}</span>
						{:else}
							<span class="status {t.status}">{statusLabel(t.status)}</span>
						{/if}
						<!-- The system tenant holds no licence of its own and cannot be edited, so its row
						     says what it IS instead of a licence verdict ("Licensed") its page contradicts. -->
						{#if system}
							<span class="lic system" data-testid="tenant-system-badge" title={m.admin_tenants_system_hint()}>
								{m.admin_tenants_system()}
							</span>
						{:else if !gone && chip.tone !== 'ok'}
							<span class="lic {chip.tone}" data-testid="tenant-licence-chip" title={LICENSE_CHIP_HINT[chip.label]()}>
								{LICENSE_CHIP_LABEL[chip.label]()}
							</span>
						{/if}
					</span>
					<span class="cell plan" data-testid="tenant-plan-chip">
						{#if t.planCode && !system}
							{t.licenceExpiresAt
								? m.admin_licence_chip({ plan: planLabel(t.planCode), date: fullDate(t.licenceExpiresAt, locale.current) })
								: m.admin_licence_chip_perpetual({ plan: planLabel(t.planCode) })}
						{/if}
					</span>
					<span class="cell num seats" class:full={t.maxMembers !== null && seatsUsedOf(t) >= t.maxMembers}>
						{seatsText(t)}
					</span>
				</a>
			{/each}
		</div>

		{#if total > PAGE_SIZE}
			<div class="pager">
				<span class="pager-info">{m.admin_pager_showing({ from: num(offset + 1, locale.current), to: num(shownTo, locale.current), total: num(total, locale.current) })}</span>
				<div class="pager-btns">
					<button class="btn-ghost" disabled={busy || offset === 0} onclick={() => goPage(offset - PAGE_SIZE)}>{m.admin_pager_prev()}</button>
					<button class="btn-ghost" disabled={busy || shownTo >= total} onclick={() => goPage(offset + PAGE_SIZE)}>{m.admin_pager_next()}</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.page { max-width: 1080px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
	.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 10px; }
	.head-text { min-width: 0; flex: 1 1 320px; }
	.eyebrow { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px; }
	h1 { font-family: var(--font-display); font-size: 30px; margin: 0 0 6px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 640px; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 16px 18px; }
	.create-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); column-gap: 16px; margin-top: 10px; }
	.field.wide { grid-column: 1 / -1; }
	/* The list: a CSS-grid table, so a row can be one link and still collapse on a phone. */
	.table { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); overflow: hidden; }
	.thead, .trow { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(0, 1.4fr) minmax(0, 1.6fr) minmax(0, 0.8fr); gap: 12px; align-items: center; padding: 10px 16px; }
	.thead { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: var(--c-muted); background: var(--c-surface); border-bottom: 1px solid var(--c-border); }
	.trow { color: inherit; text-decoration: none; border-bottom: 1px solid var(--c-border); }
	.trow:last-child { border-bottom: none; }
	.trow:hover { background: var(--c-surface); }
	.trow:focus-visible { outline: 2px solid var(--c-teal); outline-offset: -2px; }
	.trow.suspended { opacity: 0.75; }
	/* An offboarded tenant is HISTORY, not a problem. Muted, never coral. */
	.trow.gone { opacity: 0.62; }
	.cell { min-width: 0; }
	.num { text-align: end; }
	.meta { display: flex; flex-direction: column; }
	/* ⛔ NEVER OVERLAP. A long name is cut with an ellipsis; `title` carries it whole. */
	.name, .slug, .plan { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.name { font-weight: 600; font-size: 14px; color: var(--c-ink); }
	.slug { font-family: var(--font-mono); font-size: 11.5px; color: var(--c-muted); margin-top: 2px; }
	.alias { font-family: var(--font-sans); margin-inline-start: 4px; }
	.badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
	.plan { font-size: 12px; color: var(--c-muted); }
	.seats { font-size: 12px; color: var(--c-muted); white-space: nowrap; }
	.seats.full { color: var(--c-coral-dark); font-weight: 600; }
	.status { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; text-transform: capitalize; white-space: nowrap; }
	.status.active { background: var(--c-teal-pale); color: var(--c-teal-dark); }
	.status.suspended { background: var(--c-coral-pale); color: var(--c-coral-dark); }
	.status.offboarded { background: var(--c-surface-2); color: var(--c-muted); }
	.lic { font-size: 11px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
	/* A workspace nobody can use (no licence / not active) is the loudest thing on the row. */
	.lic.missing { color: var(--c-coral-dark); background: var(--c-coral-pale); font-weight: 600; }
	/* "Can't verify" (licences unreachable) — muted, NOT coral: an outage must not paint the estate red. */
	.lic.muted { color: var(--c-muted); font-style: italic; }
	.lic.system { color: var(--c-muted); border: 1px solid var(--c-border); }
	.empty { color: var(--c-muted); font-size: 13px; text-align: center; }
	.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px; flex-wrap: wrap; }
	.pager-info { font-size: 12.5px; color: var(--c-muted); }
	.pager-btns { display: flex; gap: 8px; }
	.preview-label { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; color: var(--c-muted); }
	.field { display: flex; flex-direction: column; margin-bottom: 14px; min-width: 0; }
	label { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 6px; }
	.hint { font-size: 11px; color: var(--c-muted); margin-top: 4px; line-height: 1.45; }
	.hint.error { color: var(--c-coral-dark); }
	.bundle-chips { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
	.bundle-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border: 1px solid var(--c-border); border-radius: 999px; font-size: 12px; }
	.bundle-chip code { font-family: var(--font-mono); font-size: 11.5px; }
	.chip-remove { border: 0; background: transparent; color: var(--c-muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; }
	.chip-remove:hover { color: var(--c-coral-dark); }
	.bundle-input { display: flex; gap: 8px; }
	.bundle-input input { flex: 1; min-width: 0; }
	input, select { font-family: var(--font-sans); font-size: 13.5px; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px; width: 100%; box-sizing: border-box; background: var(--c-white); min-width: 0; }
	.actions { display: flex; justify-content: flex-end; }
	.invite-link { display: flex; flex-direction: column; gap: 8px; }
	.invite-link input { font-family: var(--font-mono); font-size: 11.5px; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 10px 18px; border-radius: var(--r); border: none; white-space: nowrap; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { font-size: 12.5px; font-weight: 500; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); padding: 7px 14px; border-radius: var(--r); }
	.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	/* THE THIRD OUTCOME — a success with work left over. `--c-amber-dark` is NOT defined in
	   tokens.css; the `#92400E` fallback is the only spelling that renders the colour it claims. */
	.banner.warn { background: var(--c-amber-pale); border: 1px solid var(--c-amber-light); color: var(--c-amber-dark, #92400E); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
	/* Phone width: no header row; each row stacks name over badges, plan and seats. */
	@media (max-width: 640px) {
		.thead { display: none; }
		.trow { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'meta seats' 'badges badges' 'plan plan'; row-gap: 6px; }
		.meta { grid-area: meta; }
		.badges { grid-area: badges; }
		.plan { grid-area: plan; }
		.seats { grid-area: seats; }
	}
</style>
