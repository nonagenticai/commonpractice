<script lang="ts">
	// Tenant — ONE workspace on the PLATFORM screen (super_admin only): its licence editor and every
	// per-tenant action that used to crowd its row on /tenants (licence issue, billing terms,
	// members, act-as, suspend/reactivate, offboard).
	// Backend: GET /api/admin/tenants?id=, GET /api/tenants/:id/{licence,terms}, PATCH /api/tenants/:id,
	// POST /api/tenants/:id/{license,offboard} — all super_admin-gated server-side.
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { adminApi, ApiError } from '$lib/api/admin';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import {
		PROVISIONING_STEPS,
		seatsUsedOf,
		type ByoMode,
		type LicencePlan,
		type PlatformTenant,
		type ProvisioningStep,
		type ProvisioningStepStatus,
		type ProvisioningView,
		type LicenceBundleResult,
		type TenantLicence
	} from '$lib/types/admin';
	import {
		buildLicencePatch,
		isoToDateInput,
		licenceDrift,
		type LicenceDraft
	} from '$lib/admin/licence-terms';
	import { licenseChipFor } from '$lib/admin/license-chip';
	import { actAsReasonText } from '$lib/admin/act-as-refusal';
	import ByoModeField from '$lib/components/admin/ByoModeField.svelte';
	import {
		LICENCE_STATUS_LABEL,
		LICENSE_CHIP_HINT,
		LICENSE_CHIP_LABEL,
		isAutoSlug,
		isSystemTenantRow,
		licencesAlias,
		planLimitsText
	} from '$lib/admin/tenant-labels';
	import { activeTenant } from '$lib/stores/activeTenant.svelte';
	import {
		parseTermsDraft,
		planFixedByo,
		planHelp,
		postureFor,
		rateCardToDraft,
		termsToDraft,
		EMPTY_TERMS_DRAFT,
		type TermsDraft
	} from '$lib/admin/billing-terms';
	import * as m from '$lib/paraglide/messages';
	import { num, fullDate } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	const id = $derived(page.params.id ?? '');

	let loading = $state(true);
	let denied = $state(false);
	let notFound = $state(false);
	let loadError = $state<string | null>(null);
	let tenant = $state<PlatformTenant | null>(null);
	let busy = $state(false);
	// `warn` is a THIRD outcome: something SUCCEEDED with work left over (seats still being
	// revoked, an old licence left unrevoked). Coral would say "retry"; teal would hide it.
	let banner = $state<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

	const system = $derived(tenant ? isSystemTenantRow(tenant) : false);
	const gone = $derived(tenant?.offboardedAt != null);
	const chip = $derived(tenant ? licenseChipFor(tenant) : null);
	const alias = $derived(tenant ? licencesAlias(tenant.slug, tenant.licencesName) : null);

	// The plan catalogue, for the plan select and its limits. `plansError`: the editor keeps the
	// tenant's own plan and says the list could not be read.
	let plans = $state<LicencePlan[]>([]);
	let plansError = $state(false);

	// ---- Licence editor (A2 §4) ----
	let editLoading = $state(false);
	let editLoadError = $state<string | null>(null);
	let editError = $state<string | null>(null);
	let editLicence = $state<TenantLicence | null>(null);
	let editOriginal = $state<LicenceDraft | null>(null);
	let draft = $state<LicenceDraft>({
		name: '',
		planCode: '',
		startsAt: '',
		expiresAt: '',
		seats: '',
		byoMode: '',
		status: 'active'
	});
	const editDrift = $derived(editLicence ? licenceDrift(editLicence) : null);
	const draftPlan = $derived(plans.find((p) => p.code === draft.planCode) ?? null);

	// The plan FIXES the posture for local-llm / byo: the BYO select follows the plan and is locked.
	const fixedByo = $derived(planFixedByo(draft.planCode));
	// The posture the OPERATOR last chose (initially the stored one); a plan that fixes the posture
	// overrides it only while that plan is selected — switching back restores the operator's choice.
	let chosenByo = $state<ByoMode | ''>('');
	$effect(() => {
		const want = postureFor(draft.planCode, chosenByo);
		if (draft.byoMode !== want) draft.byoMode = want;
	});
	const draftPlanHelp = $derived(planHelp(draft.planCode));

	// Billing terms (billing-service is the system of record). `termsState`: what the card can say.
	let termsDraft = $state<TermsDraft>({ ...EMPTY_TERMS_DRAFT });
	let termsOriginal = $state<TermsDraft>({ ...EMPTY_TERMS_DRAFT });
	let termsState = $state<'loading' | 'ok' | 'defaults' | 'unconfigured' | 'error'>('loading');
	let termsError = $state<string | null>(null);

	// Setup — what each creation step did (backend 0101). `null` = not loaded / could not be read.
	let setup = $state<ProvisioningView | null>(null);
	// Licences bundles CP ensured on this workspace (backend 0104), shown under their setup step.
	let setupBundles = $state<LicenceBundleResult[]>([]);
	let setupError = $state<string | null>(null);
	const SETUP_STEP_LABEL: Record<ProvisioningStep, () => string> = {
		licences_tenant: m.admin_tenant_setup_step_licences_tenant,
		licence: m.admin_tenant_setup_step_licence,
		billing_terms: m.admin_tenant_setup_step_billing_terms,
		ir_licence: m.admin_tenant_setup_step_ir_licence,
		licence_bundles: m.admin_tenant_setup_step_licence_bundles,
		first_invite: m.admin_tenant_setup_step_first_invite,
		member_seat: m.admin_tenant_setup_step_member_seat,
		member_licence: m.admin_tenant_setup_step_member_licence,
		invite_email: m.admin_tenant_setup_step_invite_email
	};
	const SETUP_STATUS_LABEL: Record<ProvisioningStepStatus, () => string> = {
		ok: m.admin_tenant_setup_status_ok,
		failed: m.admin_tenant_setup_status_failed,
		pending: m.admin_tenant_setup_status_pending,
		skipped: m.admin_tenant_setup_status_skipped
	};

	async function loadSetup(tenantId: string) {
		setupError = null;
		try {
			const res = await adminApi.tenantProvisioning(tenantId);
			setup = res.provisioning;
			setupBundles = res.licenceBundles ?? [];
		} catch (e) {
			setup = null;
			setupError = errorText(e, m.error_load_failed());
		}
	}

	/** Re-run one creation step with the inputs held since create (nothing is re-entered). */
	async function retrySetupStep(step: ProvisioningStep) {
		const t = tenant;
		if (!t || busy) return;
		busy = true;
		banner = null;
		try {
			const res = await adminApi.retryProvisioning(t.id, step);
			setup = res.provisioning;
			const ok = res.record.status === 'ok' || res.record.status === 'skipped';
			banner = {
				kind: ok ? 'ok' : 'warn',
				text: m.admin_tenant_setup_retry_done({
					step: SETUP_STEP_LABEL[step](),
					status: SETUP_STATUS_LABEL[res.record.status]()
				})
			};
			// A landed billing step changed what billing holds; a landed licence step the chip.
			if (ok && step === 'billing_terms') void loadTerms(t.id);
			if (ok && (step === 'licence' || step === 'licences_tenant')) await reload();
			if (step === 'licence_bundles') void loadSetup(t.id);
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	// The offboard confirmation (the slug typed so far).
	let offboardOpen = $state(false);
	let offboardSlug = $state('');

	async function loadTenant(): Promise<PlatformTenant | null> {
		const t = await adminApi.platformTenant(id);
		tenant = t;
		notFound = t === null;
		return t;
	}

	async function load() {
		loading = true;
		denied = false;
		notFound = false;
		loadError = null;
		try {
			const t = await loadTenant();
			// Not awaited: the header and actions render as soon as the row is in; the editor shows
			// its own "Loading licence…" while licences answers (it can be slow, it is external).
			if (t) {
				void loadLicence(t);
				// An offboarded tenant renders no terms card (it is read-only), so billing is not asked.
				if (!isSystemTenantRow(t) && t.offboardedAt == null) void loadTerms(t.id);
				if (!isSystemTenantRow(t)) void loadSetup(t.id);
			}
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
	});

	async function loadPlans() {
		try {
			const res = await adminApi.plans({ includeRevoked: true });
			plans = res.plans;
			plansError = false;
		} catch {
			plansError = true;
		}
	}

	function planLabel(code: string): string {
		const p = plans.find((x) => x.code === code);
		return p ? p.name : code;
	}

	/** Load the licence into the editor. The system tenant and an offboarded one have no editor:
	 *  PATCH answers 409 `system_tenant` / `tenant_offboarded` for them by design, and an offboarded
	 *  tenant renders the read-only note instead of every action card. */
	async function loadLicence(t: PlatformTenant) {
		editLicence = null;
		editOriginal = null;
		editError = null;
		editLoadError = null;
		if (isSystemTenantRow(t) || t.offboardedAt != null) return;
		editLoading = true;
		try {
			const lic = await adminApi.tenantLicence(t.id);
			const original: LicenceDraft = {
				name: t.name,
				planCode: lic.planCode,
				startsAt: isoToDateInput(lic.startsAt),
				expiresAt: isoToDateInput(lic.expiresAt),
				seats: t.maxMembers === null ? '' : String(t.maxMembers),
				byoMode: lic.byoMode ?? '',
				status: t.status
			};
			editLicence = lic;
			editOriginal = original;
			chosenByo = original.byoMode;
			draft = { ...original };
		} catch (e) {
			editLoadError = errorText(e, m.error_load_failed());
		} finally {
			editLoading = false;
		}
	}

	/** Re-read the row and the licence after a write, so the page shows what the backend now holds. */
	async function reload() {
		try {
			const t = await loadTenant();
			if (t) await loadLicence(t);
		} catch (e) {
			loadError = errorText(e, m.error_load_failed());
		}
	}

	/** Localized sentence for a refused licence edit. `seats_below_usage` carries its numbers. */
	function licenceErrorText(e: unknown, fallback: string): string {
		if (e instanceof ApiError && e.code === 'seats_below_usage') {
			const d = e.details ?? {};
			const n = (k: string) => (typeof d[k] === 'number' ? num(d[k] as number, locale.current) : '?');
			return m.admin_licence_seats_below_usage({
				used: n('used'),
				members: n('members'),
				pending: n('pending'),
				requested: n('requested')
			});
		}
		return writeErrorText(e, fallback);
	}

	function resetDraft() {
		if (editOriginal) {
			draft = { ...editOriginal };
			chosenByo = editOriginal.byoMode;
		}
		editError = null;
	}

	async function saveLicence() {
		const t = tenant;
		if (busy || !editOriginal || !t) return;
		const built = buildLicencePatch(editOriginal, draft);
		if (!built.ok) {
			editError =
				built.reason === 'name_required'
					? m.admin_licence_name_required()
					: built.reason === 'seats_invalid'
						? m.admin_tenants_seats_invalid()
						: built.reason === 'window_invalid'
							? m.error_licence_window_invalid()
							: m.admin_tenants_date_invalid();
			return;
		}
		// Only CHANGED fields are ever sent — a re-sent plan or date re-mints the licence.
		if (Object.keys(built.patch).length === 0) {
			editError = m.admin_licence_no_changes();
			return;
		}
		busy = true;
		editError = null;
		banner = null;
		try {
			const res = await adminApi.patchTenant(t.id, built.patch);
			const tenantName = res.tenant?.name ?? t.name;
			const parts: string[] = [m.admin_licence_saved({ name: tenantName })];
			let warn = false;
			if (res.licence?.reminted) {
				parts.push(m.admin_licence_reminted({ count: num(res.licence.membersReissued, locale.current) }));
			}
			if (res.licence?.oldLicenceRevoked === false) {
				parts.push(m.admin_licence_old_unrevoked());
				warn = true;
			}
			const pendingSeats = (res.licence?.memberFailures?.length ?? 0) + (res.seatFailures?.length ?? 0);
			if (pendingSeats > 0) {
				parts.push(m.admin_licence_seats_pending({ count: num(pendingSeats, locale.current) }));
				warn = true;
			}
			const renamedAlias = licencesAlias(res.tenant?.slug ?? t.slug, res.tenant?.licencesName);
			if (built.patch.name && renamedAlias) parts.push(m.admin_tenants_licences_registered_as({ name: renamedAlias }));
			if (res.inferenceRevokeError) {
				parts.push(m.admin_inference_revoke_failed());
				warn = true;
			}
			banner = { kind: warn ? 'warn' : 'ok', text: parts.join(' ') };
			await reload();
		} catch (e) {
			editError = licenceErrorText(e, m.error_save_failed());
		} finally {
			busy = false;
		}
	}

	/**
	 * Issue (or repair) the tenant's licence. An unlicensed tenant 402s on EVERY screen under the
	 * fail-closed Gate 2. Confirmed rather than one-click because it mints against the external
	 * licences service. `force` REPLACES a stored token — the only repair for a token the licences
	 * service does not honour (the plain call reports `alreadyLicensed` and changes nothing).
	 */
	async function issueLicense(force: boolean) {
		const t = tenant;
		if (!t || busy) return;
		const ask = force
			? m.admin_tenants_license_reissue_confirm({ name: t.name })
			: m.admin_tenants_license_confirm({ name: t.name });
		if (!window.confirm(ask)) return;
		busy = true;
		banner = null;
		try {
			const res = await adminApi.issueLicense(t.id, force ? { force: true } : undefined);
			banner = {
				kind: 'ok',
				text: force
					? m.admin_tenants_license_reissued({ name: t.name })
					: res.alreadyLicensed
						? m.admin_tenants_license_already({ name: t.name })
						: m.admin_tenants_license_issued({ name: t.name })
			};
			await reload();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	/** Read the tenant's billing terms. Unstated terms show billing's defaults, marked as such. */
	async function loadTerms(tenantId: string) {
		termsState = 'loading';
		termsError = null;
		try {
			const res = await adminApi.tenantTerms(tenantId);
			if (!res.terms) {
				termsState = 'unconfigured';
				return;
			}
			termsOriginal = termsToDraft(res.terms);
			termsDraft = { ...termsOriginal };
			termsState = res.terms.fullyConfigured ? 'ok' : 'defaults';
			// No terms stated yet: prefill from billing's STANDARD rate card (non-fatal if absent).
			if (!res.terms.fullyConfigured) {
				const { rateCard } = await adminApi.rateCard().catch(() => ({ rateCard: null }));
				if (rateCard) termsDraft = rateCardToDraft(rateCard);
			}
		} catch (e) {
			termsState = 'error';
			termsError = errorText(e, m.error_load_failed());
		}
	}

	/** Write the terms to billing (one idempotent PUT; the backend skips it when nothing changed). */
	async function saveTerms() {
		const t = tenant;
		if (!t || busy) return;
		const parsed = parseTermsDraft(termsDraft);
		if (!parsed.ok || !parsed.terms) {
			banner = { kind: 'error', text: m.admin_terms_invalid() };
			return;
		}
		busy = true;
		banner = null;
		try {
			const res = await adminApi.patchTenant(t.id, { terms: parsed.terms });
			banner = {
				kind: 'ok',
				text: res.termsStatus === 'unchanged' ? m.admin_terms_unchanged() : m.admin_terms_saved({ name: t.name })
			};
			await loadTerms(t.id);
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_save_failed()) };
		} finally {
			busy = false;
		}
	}

	const statusLabel = (s: string): string =>
		s === 'active' ? m.tenant_status_active() : m.tenant_status_suspended();

	async function toggleStatus() {
		const t = tenant;
		if (!t || busy) return;
		// An offboarded tenant cannot be reactivated (409 `tenant_offboarded`); the button is not even
		// rendered, this is the second half of that guard for any path that reaches the handler anyway.
		if (t.offboardedAt) return;
		busy = true;
		banner = null;
		const next = t.status === 'active' ? 'suspended' : 'active';
		try {
			await adminApi.patchTenant(t.id, { status: next });
			banner = { kind: 'ok', text: m.tenant_status_changed({ name: t.name, status: statusLabel(next) }) };
			await reload();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	/** Members and invitations live on the tenant-scoped /members screen: act as this tenant, then go.
	 *  ⛔ NOT `set()` then `goto()`: `set()` reloads, the reload won, and the button re-opened THIS
	 *  page (prod E2E 2026-10-14). Switching scope navigates as a full load instead; already acting
	 *  as this tenant needs no reload, so that case stays a client-side `goto`. */
	function openMembers() {
		const t = tenant;
		if (!t) return;
		if (activeTenant.current?.id === t.id) {
			void goto('/members');
			return;
		}
		void actAs(t, '/members');
	}

	/**
	 * Switch the session to act as `t` — but only once the backend has said it will HONOUR the switch.
	 *
	 * ⛔ THE BUG (2026-10-27). Act-as on a workspace with no active licence reloaded the app, /api/me
	 * refused the acting tenant (`activeTenantRejected: license_required`), the SPA dropped the
	 * selection, and the operator was back in their own workspace with no explanation. The backend is
	 * right — every tenant-admin route runs Gate 2 against the acting tenant, so nothing would have
	 * worked there — the UI was not. So the switch asks /api/me the same question FIRST
	 * (`adminApi.actAsCheck`) and refuses up front, visibly, with the reason. A transient failure
	 * (licences outage, 5xx) is an error banner and no switch: never a guess either way.
	 */
	async function actAs(t: PlatformTenant, navigateTo?: string) {
		if (busy) return;
		busy = true;
		banner = null;
		try {
			const refused = await adminApi.actAsCheck(t.id);
			if (refused) {
				banner = { kind: 'error', text: m.tenant_act_as_refused({ name: t.name, reason: actAsReasonText(refused) }) };
				return;
			}
			activeTenant.set(t.id, t.name, navigateTo ? { navigateTo } : {});
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	function cancelOffboard() {
		offboardOpen = false;
		offboardSlug = '';
	}

	/**
	 * Offboard — remove every member, revoke their MCP keys and sessions, stamp `offboardedAt`.
	 *
	 * ⛔ `window.confirm` IS NOT ENOUGH HERE: this cannot be undone (reactivation answers 409
	 * `tenant_offboarded`). The panel names the tenant and its member count, and the commit stays
	 * inert until the slug is typed EXACTLY — the string the backend re-checks as `confirmSlug`.
	 * ⚠️ NO TRIM ON THE COMPARISON: `'acme '` and `'acm'` must both leave the button disabled.
	 * ⚠️ A SEAT-REVOKE FAILURE IS A 200 with non-empty `seatFailures`: offboarded, billing pending.
	 */
	async function commitOffboard() {
		const t = tenant;
		if (!t || busy) return;
		if (offboardSlug !== t.slug) return;
		busy = true;
		banner = null;
		try {
			const res = await adminApi.offboardTenant(t.id, { confirmSlug: offboardSlug });
			cancelOffboard();
			const seatsPending = res.seatFailures?.length ?? 0;
			const done = m.tenant_offboard_done({
				name: t.name,
				users: num(res.usersOffboarded, locale.current),
				keys: num(res.keysRevoked, locale.current)
			});
			banner =
				seatsPending > 0
					? { kind: 'warn', text: done + ' ' + m.tenant_offboard_seats_pending({ failed: num(seatsPending, locale.current) }) }
					: { kind: 'ok', text: done };
			await reload();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}
</script>

<div class="page" data-testid="tenant-page">
	<a class="back" href="/tenants" data-testid="tenant-back">← {m.admin_tenant_back()}</a>

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else if notFound || !tenant}
		<div class="notice" data-testid="tenant-not-found">{m.admin_tenant_not_found()}</div>
	{:else}
		{@const t = tenant}
		<header class="page-head" data-testid="tenant-header">
			<h1 title={t.name}>{t.name}</h1>
			<div class="sub">
				<!-- The system badge below already says "System workspace"; the subtitle does not repeat it. -->
				{#if !system}
					<span class="slug" title={t.slug}>
						{isAutoSlug(t.slug) ? m.tenant_personal_subtitle() : t.slug}
					</span>
				{/if}
				{#if alias}<span class="alias" data-testid="tenant-licences-name">· {m.admin_tenants_licences_name_short({ name: alias })}</span>{/if}
			</div>
			<div class="chips">
				{#if gone}
					<span class="status offboarded">{m.tenant_status_offboarded()}</span>
					<span class="muted-text">{m.tenant_offboarded_at({ date: fullDate(t.offboardedAt, locale.current) })}</span>
				{:else}
					<span class="status {t.status}">{statusLabel(t.status)}</span>
				{/if}
				{#if system}
					<span class="lic-status system" data-testid="tenant-system-badge">{m.admin_tenants_system()}</span>
				{:else if editLicence}
					<span class="lic-status {editLicence.status}" data-testid="tenant-licence-status">
						{LICENCE_STATUS_LABEL[editLicence.status]()}
					</span>
				{/if}
				{#if t.planCode && !system}
					<span class="plan-chip" data-testid="tenant-plan-chip">
						{t.licenceExpiresAt
							? m.admin_licence_chip({ plan: planLabel(t.planCode), date: fullDate(t.licenceExpiresAt, locale.current) })
							: m.admin_licence_chip_perpetual({ plan: planLabel(t.planCode) })}
					</span>
				{/if}
				{#if t.centralLink}
					<span class="central" data-testid="tenant-central-link" title={m.admin_tenants_central_hint()}>
						{t.centralLink === 'adopted' ? m.admin_tenants_central_adopted() : m.admin_tenants_central_registered()}
					</span>
				{/if}
				{#if activeTenant.current?.id === t.id}
					<span class="acting">{m.tenant_acting_now()}</span>
				{/if}
			</div>
		</header>

		{#if banner}<div class="banner {banner.kind}">{banner.text}</div>{/if}

		{#if system}
			<!-- The nil-UUID seed tenant: PATCH and offboard answer 409 `system_tenant`, and it holds no
			     licence of its own — so there is nothing here to edit, and no control that can only fail. -->
			<section class="card" data-testid="tenant-system-notice">
				<div class="section-title">{m.admin_tenant_system_title()}</div>
				<p class="body">{m.admin_tenants_system_hint()}</p>
			</section>
		{:else if gone}
			<!-- ⛔ OFFBOARDED = READ-ONLY, and that means NO CONTROLS, not disabled ones. Seen on prod: the
			     action column still offered "Issue licence" on an offboarded tenant. Every write here —
			     licence issue/edit, terms, members/invite, act-as, suspend/reactivate, offboard — is
			     refused 409 `tenant_offboarded` by the backend, so each control could only ever fail. -->
			<section class="card" data-testid="tenant-offboarded-readonly">
				<div class="section-title">{m.admin_tenant_offboarded_note({ date: fullDate(t.offboardedAt, locale.current) })}</div>
				<p class="body">{m.admin_tenant_offboarded_readonly()}</p>
			</section>
		{:else}
			<div class="layout">
				<section class="card editor" data-testid="tenant-licence-editor">
					<div class="section-title">{m.admin_licence_title({ name: t.name })}</div>
					{#if editLoading}
						<p class="hint">{m.admin_licence_loading()}</p>
					{:else if editLoadError}
						<div class="banner error">{m.admin_licence_load_failed({ error: editLoadError })}</div>
					{:else if editLicence}
						{#if editLicence.liveError}
							<div class="drift" data-testid="tenant-licence-live-error">
								{m.admin_licence_live_error({ error: editLicence.liveError })}
							</div>
						{:else if editDrift && (editDrift.missing || editDrift.plan || editDrift.expiry)}
							<div class="drift" data-testid="tenant-licence-drift">
								{#if editDrift.missing}<p>{m.admin_licence_drift_missing()}</p>{/if}
								{#if editDrift.plan && editLicence.live}
									<p>{m.admin_licence_drift_plan({ plan: editLicence.live.planCode ?? '' })}</p>
								{/if}
								{#if editDrift.expiry && editLicence.live}
									<p>{m.admin_licence_drift_expiry({
										date: editLicence.live.expiresAt
											? fullDate(editLicence.live.expiresAt, locale.current)
											: m.admin_licence_no_end()
									})}</p>
								{/if}
							</div>
						{/if}
						<!-- Only CHANGED fields are sent — a re-sent plan or date re-mints the licence
						     (lib/admin/licence-terms.ts buildLicencePatch). -->
						<form class="editor-grid" onsubmit={(e) => { e.preventDefault(); saveLicence(); }}>
							<div class="field">
								<label for="lname">{m.admin_tenants_name_label()}</label>
								<input id="lname" data-testid="licence-name" bind:value={draft.name} maxlength="120" />
								<span class="hint">{m.admin_licence_name_hint()}</span>
							</div>
							<div class="field">
								<label for="lplan">{m.admin_tenants_plan_label()}</label>
								<select id="lplan" data-testid="licence-plan" bind:value={draft.planCode}>
									{#if !plans.some((p) => p.code === draft.planCode)}
										<option value={draft.planCode}>{draft.planCode}</option>
									{/if}
									<!-- A retired plan is listed only when it is the tenant's CURRENT plan; it can
									     never be newly assigned (422 plan_retired). -->
									{#each plans as p (p.id)}
										{#if !p.revoked || p.code === editOriginal?.planCode}
											<option value={p.code}>
												{p.revoked ? m.admin_licence_plan_retired_option({ name: p.name }) : p.name}
											</option>
										{/if}
									{/each}
								</select>
								<span class="hint">{plansError ? m.admin_tenants_plans_unavailable() : m.admin_tenants_plan_change_help()}</span>
								{#if draftPlanHelp}
									<span class="hint" data-testid="licence-plan-help">{draftPlanHelp}</span>
								{/if}
								{#if draftPlan}
									<span class="hint" data-testid="licence-plan-limits">{planLimitsText(draftPlan, locale.current)}</span>
								{/if}
							</div>
							<div class="field">
								<label for="lstart">{m.admin_licence_starts_label()}</label>
								<span class="date-row">
									<input id="lstart" type="date" data-testid="licence-starts" bind:value={draft.startsAt} />
									<button type="button" class="btn-ghost tiny" disabled={!draft.startsAt}
										onclick={() => { draft.startsAt = ''; }}>{m.admin_licence_clear()}</button>
								</span>
								<span class="hint">{m.admin_tenants_starts_help()}</span>
							</div>
							<div class="field">
								<label for="lend">{m.admin_licence_expires_label()}</label>
								<span class="date-row">
									<input id="lend" type="date" data-testid="licence-expires" bind:value={draft.expiresAt} />
									<button type="button" class="btn-ghost tiny" data-testid="licence-expires-clear"
										disabled={!draft.expiresAt}
										onclick={() => { draft.expiresAt = ''; }}>{m.admin_licence_clear()}</button>
								</span>
								<span class="hint">{m.admin_tenants_expires_help()}</span>
							</div>
							<div class="field">
								<label for="lseats">{m.admin_tenants_seats_label()}</label>
								<input id="lseats" data-testid="licence-seats" bind:value={draft.seats} inputmode="numeric"
									placeholder={m.admin_tenants_seats_placeholder()} />
								<span class="hint">{m.admin_tenants_seats_help()}</span>
								<span class="hint">{t.maxMembers === null
									? m.admin_tenants_seats_used_unlimited({ used: num(seatsUsedOf(t), locale.current) })
									: m.admin_tenants_seats_used({ used: num(seatsUsedOf(t), locale.current), max: num(t.maxMembers, locale.current) })}</span>
							</div>
							<div class="field">
								<label for="lstatus">{m.admin_licence_status_label()}</label>
								<select id="lstatus" data-testid="licence-status" bind:value={draft.status}>
									<option value="active">{m.tenant_status_active()}</option>
									<option value="suspended">{m.tenant_status_suspended()}</option>
								</select>
								<span class="hint">{m.admin_tenants_status_help()}</span>
							</div>
							<div class="field wide">
								<ByoModeField id="lbyo" testid="licence" bind:value={draft.byoMode} fixed={fixedByo}
									allowUnknown={editOriginal?.byoMode === ''}
									onchoose={(mode) => (chosenByo = mode)} />
							</div>
							{#if editError}
								<div class="banner error wide" data-testid="tenant-licence-error">{editError}</div>
							{/if}
							<div class="form-actions wide">
								<button class="btn-primary" type="submit" data-testid="licence-save" disabled={busy}>
									{m.admin_licence_save()}
								</button>
								<button type="button" class="btn-ghost" disabled={busy} onclick={resetDraft}>
									{m.admin_tenant_reset()}
								</button>
							</div>
						</form>
					{/if}
				</section>

				<aside class="side">
					<section class="card action" data-testid="tenant-setup-card">
						<div class="section-title">{m.admin_tenant_setup_heading()}</div>
						<p class="hint">{m.admin_tenant_setup_hint()}</p>
						{#if setupError}
							<div class="banner error">{setupError}</div>
						{:else if setup && !setup.recorded}
							<p class="hint" data-testid="tenant-setup-none">{m.admin_tenant_setup_none()}</p>
						{:else if setup}
							<ul class="setup-steps">
								{#each PROVISIONING_STEPS as step (step)}
									{@const rec = setup.steps[step]}
									{#if rec}
										<li class="setup-step {rec.status}" data-testid="tenant-setup-step-{step}">
											<div class="setup-row">
												<span class="setup-name">{SETUP_STEP_LABEL[step]()}</span>
												<span class="setup-status">{SETUP_STATUS_LABEL[rec.status]()}</span>
											</div>
											{#if step === 'licence_bundles' && setupBundles.length > 0}
												<ul class="setup-bundles" data-testid="tenant-setup-bundles">
													{#each setupBundles as b (b.bundle)}
														<li class="setup-bundle {b.status}" data-testid="tenant-setup-bundle-{b.bundle}">
															<code dir="ltr">{b.bundle}</code>
															<span class="setup-status">{SETUP_STATUS_LABEL[b.status]()}</span>
															{#if b.status === 'failed' && b.code}<code class="setup-detail" dir="ltr">{b.code}</code>{/if}
														</li>
													{/each}
												</ul>
											{/if}
											{#if rec.status === 'failed' || rec.status === 'pending'}
												{#if rec.code === 'interrupted'}
													<!-- A create died before this step ran and the tick does not own it (backend
													     tenant-provisioning.ts isInterrupted): say so in the reader's language. -->
													<span class="hint" data-testid="tenant-setup-interrupted-{step}">{m.admin_tenant_setup_interrupted()}</span>
												{:else if rec.message}<code class="setup-detail" dir="ltr">{rec.message}</code>{/if}
												<span class="hint">
													{m.admin_tenant_setup_attempts_label()}: {num(rec.attempts, locale.current)}{#if rec.nextAttemptAt}
														· {m.admin_tenant_setup_next_label()}: {fullDate(rec.nextAttemptAt, locale.current)}{/if}
												</span>
												{#if step === 'billing_terms' && setup.termsHeld}
													<span class="hint">{m.admin_tenant_setup_terms_held()}</span>
												{/if}
												{#if !gone}
													<button class="btn-ghost tiny" data-testid="tenant-setup-retry-{step}" disabled={busy}
														onclick={() => retrySetupStep(step)}>
														{m.admin_tenant_setup_retry()}
													</button>
												{/if}
											{/if}
										</li>
									{/if}
								{/each}
							</ul>
						{/if}
					</section>

					<section class="card action" data-testid="tenant-licence-action-card">
						<div class="section-title">{m.admin_tenant_licence_section()}</div>
						{#if chip}
							<p class="hint">{LICENSE_CHIP_HINT[chip.label]()}</p>
							<button class="btn-ghost license {chip.tone}" data-testid="tenant-licence-action"
								disabled={busy || chip.action === null}
								onclick={() => { if (chip?.action) issueLicense(chip.action === 'force'); }}>
								{chip.action === 'issue'
									? m.admin_tenant_licence_issue()
									: chip.action === 'force'
										? m.admin_tenant_licence_reissue()
										: LICENSE_CHIP_LABEL[chip.label]()}
							</button>
						{/if}
					</section>

					<section class="card action" data-testid="tenant-terms-card">
						<div class="section-title">{m.admin_terms_title()}</div>
						<p class="hint">{m.admin_terms_help()}</p>
						{#if termsState === 'loading'}
							<p class="hint">{m.admin_terms_loading()}</p>
						{:else if termsState === 'unconfigured'}
							<p class="hint" data-testid="tenant-terms-unconfigured">{m.admin_terms_unavailable()}</p>
						{:else if termsState === 'error'}
							<div class="banner error">{m.admin_terms_load_failed({ error: termsError ?? '' })}</div>
						{:else}
							{#if termsState === 'defaults'}
								<p class="hint" data-testid="tenant-terms-defaults">{m.admin_terms_defaults_hint()}</p>
							{/if}
							<form class="terms" onsubmit={(e) => { e.preventDefault(); saveTerms(); }}>
								<label for="tplatform">{m.admin_terms_platform_fee_label()}</label>
								<input id="tplatform" class="money" data-testid="terms-platform-fee" inputmode="decimal"
									bind:value={termsDraft.platformFee} disabled={busy} />
								<span class="hint">{m.admin_terms_platform_fee_help()}</span>
								<label for="tseat">{m.admin_terms_seat_fee_label()}</label>
								<input id="tseat" class="money" data-testid="terms-seat-fee" inputmode="decimal"
									bind:value={termsDraft.seatFee} disabled={busy} />
								<span class="hint">{m.admin_terms_seat_fee_help()}</span>
								<label for="tmarkup">{m.admin_terms_markup_label()}</label>
								<input id="tmarkup" class="money" data-testid="terms-markup" inputmode="decimal"
									bind:value={termsDraft.markup} disabled={busy} />
								<span class="hint">{m.admin_terms_markup_help()}</span>
								<button class="btn-ghost" type="submit" data-testid="terms-save" disabled={busy}>
									{m.admin_terms_save()}
								</button>
							</form>
						{/if}
					</section>

					<section class="card action">
						<div class="section-title">{m.admin_tenant_members_section()}</div>
						<p class="hint">{m.admin_tenant_members_help()}</p>
						<div class="btn-row">
							<button class="btn-ghost" data-testid="tenant-members-link" onclick={openMembers}>
								{m.admin_tenant_members_open()}
							</button>
							{#if activeTenant.current?.id !== t.id}
								<button class="btn-ghost" disabled={busy} data-testid="tenant-act-as" onclick={() => actAs(t)}>
									{m.tenant_action_act_as()}
								</button>
							{/if}
						</div>
					</section>

					<section class="card action">
						<div class="section-title">{m.admin_tenant_status_section()}</div>
						<p class="hint">{m.admin_tenants_status_help()}</p>
						<!-- Never rendered for an offboarded tenant (the read-only branch above): reactivation is
						     refused 409 `tenant_offboarded`. -->
						<button class="btn-ghost" data-testid="tenant-toggle-status"
							disabled={busy} onclick={toggleStatus}>
							{t.status === 'active' ? m.tenant_action_suspend() : m.tenant_action_reactivate()}
						</button>
					</section>

					<section class="card action danger-zone">
						<div class="section-title">{m.tenant_action_offboard()}</div>
						<p class="hint">{m.admin_tenant_offboard_help()}</p>
						<button class="btn-ghost danger" data-testid="tenant-offboard" disabled={busy || offboardOpen}
							onclick={() => { offboardOpen = true; offboardSlug = ''; }}>
							{m.tenant_action_offboard()}
						</button>
						{#if offboardOpen}
							<div class="confirm">
								<div class="confirm-title">{m.tenant_offboard_confirm_title({ name: t.name })}</div>
								<p class="confirm-body">{m.tenant_offboard_confirm_body({ count: num(t.memberCount, locale.current) })}</p>
								<label class="confirm-prompt" for="offboard-slug">
									{m.tenant_offboard_confirm_prompt({ slug: t.slug })}
								</label>
								<!-- svelte-ignore a11y_autofocus -->
								<input id="offboard-slug" class="confirm-input" data-testid="tenant-offboard-input"
									bind:value={offboardSlug}
									disabled={busy} autocomplete="off" autocapitalize="off" spellcheck="false"
									onkeydown={(e) => {
										if (e.key === 'Enter') commitOffboard();
										if (e.key === 'Escape') cancelOffboard();
									}} autofocus />
								<div class="confirm-actions">
									<!-- Exact equality, NOT `.trim()` — see `commitOffboard`. -->
									<button class="btn-ghost danger" data-testid="tenant-offboard-commit"
										disabled={busy || offboardSlug !== t.slug} onclick={commitOffboard}>
										{m.tenant_offboard_confirm_commit()}
									</button>
									<button class="btn-ghost" disabled={busy} onclick={cancelOffboard}>
										{m.tenant_offboard_cancel()}
									</button>
								</div>
							</div>
						{/if}
					</section>
				</aside>
			</div>
		{/if}
	{/if}
</div>

<style>
	.page { max-width: 1080px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
	.back { font-size: 12.5px; color: var(--c-teal-dark); text-decoration: none; align-self: flex-start; }
	.back:hover { text-decoration: underline; }
	.page-head { margin-bottom: 6px; min-width: 0; }
	/* ⛔ A long name truncates with an ellipsis (full name in `title`) — it never pushes the chips. */
	h1 { font-family: var(--font-display); font-size: 28px; margin: 0 0 4px; color: var(--c-midnight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sub { display: flex; gap: 4px; min-width: 0; font-size: 11.5px; color: var(--c-muted); }
	.slug { font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
	.alias { white-space: nowrap; }
	.chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
	.layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; align-items: start; }
	.side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 16px 18px; min-width: 0; }
	.section-title { font-weight: 600; font-size: 13.5px; color: var(--c-ink); margin-bottom: 8px; }
	.setup-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.setup-step { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
	.setup-row { display: flex; justify-content: space-between; gap: 8px; width: 100%; font-size: 12.5px; }
	.setup-name { color: var(--c-ink); }
	.setup-status { font-weight: 600; color: var(--c-muted); }
	.setup-step.ok .setup-status { color: var(--c-teal-dark); }
	.setup-step.failed .setup-status { color: var(--c-coral-dark); }
	.setup-step.pending .setup-status { color: var(--c-amber-dark); }
	.setup-detail { font-family: var(--font-mono); font-size: 11px; color: var(--c-muted); overflow-wrap: anywhere; }
	.setup-bundles { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
	.setup-bundle { display: flex; gap: 8px; align-items: baseline; }
	.setup-bundle code { font-family: var(--font-mono); font-size: 11.5px; }
	.setup-bundle.ok .setup-status { color: var(--c-teal-dark); }
	.setup-bundle.failed .setup-status { color: var(--c-coral-dark); }
	.body { font-size: 13px; color: var(--c-ink); margin: 0; line-height: 1.5; max-width: 680px; }
	.value { font-size: 13px; color: var(--c-ink); margin: 6px 0 8px; }
	.editor-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); column-gap: 14px; }
	.wide { grid-column: 1 / -1; }
	.field { display: flex; flex-direction: column; margin-bottom: 14px; min-width: 0; }
	label { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 6px; }
	.hint { font-size: 11px; color: var(--c-muted); margin: 4px 0 0; line-height: 1.45; }
	.action .hint { margin: 0 0 10px; }
	input, select { font-family: var(--font-sans); font-size: 13.5px; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px; width: 100%; box-sizing: border-box; background: var(--c-white); min-width: 0; }
	.date-row { display: flex; gap: 6px; align-items: center; }
	.inline, .btn-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
	.money { width: 110px; flex: 0 0 auto; }
	.form-actions { display: flex; gap: 8px; flex-wrap: wrap; }
	.banner.wide { margin-bottom: 10px; }
	.status, .lic-status { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
	.status { text-transform: capitalize; }
	.status.active, .lic-status.active { background: var(--c-teal-pale); color: var(--c-teal-dark); }
	.status.suspended, .lic-status.expired, .lic-status.unlicensed, .lic-status.suspended { background: var(--c-coral-pale); color: var(--c-coral-dark); }
	/* Grey, not coral: a closed file, not an incident. */
	.status.offboarded, .lic-status.offboarded { background: var(--c-surface-2); color: var(--c-muted); }
	.lic-status.system { color: var(--c-muted); border: 1px solid var(--c-border); background: none; font-weight: 500; }
	.plan-chip, .muted-text { font-size: 11.5px; color: var(--c-muted); }
	.central { font-size: 11px; color: var(--c-muted); border: 1px solid var(--c-border); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
	.acting { font-size: 11px; font-weight: 600; color: var(--c-teal-dark); white-space: nowrap; }
	/* Licences disagrees with CP (or could not be asked): amber — "read this", not "it failed". */
	.drift { font-size: 12.5px; padding: 8px 12px; margin-bottom: 12px; border-radius: var(--r); background: var(--c-amber-pale); border: 1px solid var(--c-amber-light); color: var(--c-amber-dark, #92400E); }
	.drift p { margin: 0; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 10px 18px; border-radius: var(--r); border: none; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { font-size: 12.5px; font-weight: 500; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); padding: 7px 14px; border-radius: var(--r); }
	.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost.tiny { padding: 5px 8px; font-size: 11.5px; flex: 0 0 auto; }
	/* A workspace nobody can use is the loudest control here; the healthy re-issue is the quietest. */
	.btn-ghost.license.missing { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); font-weight: 600; }
	/* The one IRREVERSIBLE control — `--c-coral-dark`, the estate's destructive token. */
	.btn-ghost.danger { color: var(--c-coral-dark); border-color: var(--c-coral-light); }
	.btn-ghost.danger:hover:not(:disabled) { background: var(--c-coral-pale); border-color: var(--c-coral-dark); }
	.danger-zone { border-color: var(--c-coral-light); }
	.confirm { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--c-border); }
	.confirm-title { font-weight: 600; font-size: 13px; color: var(--c-coral-dark); margin-bottom: 4px; }
	.confirm-body { font-size: 12.5px; color: var(--c-ink); margin: 0 0 10px; }
	.confirm-prompt { display: block; font-size: 12px; font-weight: 500; color: var(--c-muted); margin-bottom: 6px; }
	.confirm-input { font-family: var(--font-mono); font-size: 12.5px; padding: 7px 10px; margin-bottom: 8px; }
	.confirm-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	/* `--c-amber-dark` is NOT defined in tokens.css; the `#92400E` fallback is what renders. */
	.banner.warn { background: var(--c-amber-pale); border: 1px solid var(--c-amber-light); color: var(--c-amber-dark, #92400E); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
	@media (max-width: 860px) { .layout { grid-template-columns: minmax(0, 1fr); } }
	.terms { display: flex; flex-direction: column; gap: 4px; }
	.terms label { font-size: 12px; font-weight: 600; margin-top: 6px; }
	.terms button { align-self: flex-start; margin-top: 8px; }
</style>
