<script lang="ts">
	// Delivery connectors — the tenant-admin screen to configure where a winning solution is
	// forwarded (Phase 5 / 5A). Jira / Azure DevOps backlog, or the internal fr bridge. Credentials
	// are secret-box encrypted server-side and never returned (hasCredentials only); a save that
	// leaves the credential fields blank keeps the stored blob. The actual "Forward to delivery"
	// dispatch lands in 5B. Backend: /api/delivery-targets (routes/delivery.ts).
	import { onMount } from 'svelte';
	import {
		deliveryApi,
		ApiError,
		type DeliveryKind,
		type DeliveryTarget
	} from '$lib/api/delivery';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import * as m from '$lib/paraglide/messages';
	import { confirmDialog } from '$lib/stores/confirm.svelte';
	import { locale } from '$lib/stores/locale.svelte';
	import { connectionTestLabel, type ConnectionTestResult } from '$lib/i18n/connection-test-label';
	// ⛔ IMPORTED, NOT RE-DECLARED. A field LABEL interpolated into a localized sentence is
	// user-visible text of its own: in `ar`/`he` an unisolated latin label ("Jira API token")
	// drags the sentence's punctuation to the wrong end of the line. Every `i18n/*-label.ts`
	// module carries this helper privately; `graph-issue-label` exports it precisely so a
	// COMPONENT can use it without embedding a literal U+2068/U+2069 in its own source, which
	// Svelte flags as `bidirectional_control_characters`. `routes/build/+page.svelte` does the
	// same for the same reason.
	import { bidiIsolate } from '$lib/i18n/graph-issue-label';

	const KINDS: { v: DeliveryKind; labelKey: string }[] = [
		{ v: 'jira', labelKey: 'delivery_kind_jira' },
		{ v: 'azure_devops', labelKey: 'delivery_kind_azure_devops' },
		{ v: 'fr', labelKey: 'delivery_kind_fr' }
	];
	const mm = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;
	const kindLabel = (k: DeliveryKind) =>
		mm[KINDS.find((x) => x.v === k)?.labelKey ?? 'delivery_kind_jira']();

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let targets = $state<DeliveryTarget[]>([]);

	// form state
	let editingId = $state<string | null>(null);
	let editingHasCreds = $state(false);
	let kind = $state<DeliveryKind>('jira');
	let name = $state('');
	let baseUrl = $state('');
	let projectKey = $state('');
	let defaultItemType = $state('');
	let enabled = $state(true);
	// credential fields (per kind)
	let jiraEmail = $state('');
	let jiraToken = $state('');
	let adoPat = $state('');
	let frToken = $state('');

	let saving = $state(false);
	let banner = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

	const usesBacklog = $derived(kind === 'jira' || kind === 'azure_devops');

	async function load() {
		loading = true;
		loadError = null;
		denied = false;
		try {
			targets = await deliveryApi.list();
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function resetForm() {
		editingId = null;
		editingHasCreds = false;
		kind = 'jira';
		name = '';
		baseUrl = '';
		projectKey = '';
		defaultItemType = '';
		enabled = true;
		jiraEmail = jiraToken = adoPat = frToken = '';
		banner = null;
	}

	function startEdit(t: DeliveryTarget) {
		editingId = t.id;
		editingHasCreds = t.hasCredentials;
		kind = t.kind;
		name = t.name;
		baseUrl = t.baseUrl ?? '';
		projectKey = t.projectKey ?? '';
		defaultItemType = t.defaultItemType ?? '';
		enabled = t.enabled;
		jiraEmail = jiraToken = adoPat = frToken = '';
		banner = null;
	}

	type CredentialOutcome =
		| { state: 'unchanged' }
		| { state: 'value'; value: Record<string, unknown> }
		| { state: 'incomplete'; field: string };

	/**
	 * Build the credential object from the per-kind fields.
	 *
	 * ⛔ JIRA'S TWO FIELDS ARE ONE CREDENTIAL, AND THE OLD GUARD LET HALF OF ONE THROUGH.
	 * The guard was `if (!jiraEmail.trim() && !jiraToken.trim()) return undefined` — it required
	 * BOTH to be blank. Fill only the e-mail and the page shipped `{ email, apiToken: '' }`.
	 * `PATCH /api/delivery-targets/:id` takes `credentials` as an opaque `z.record`
	 * (backend/src/routes/delivery.ts) and secret-box-encrypts whatever it is handed, so THE
	 * STORED API TOKEN WAS REPLACED BY AN EMPTY STRING — by an admin who only wanted to correct a
	 * typo in the address. The banner said `delivery_saved`, the row still read
	 * `delivery_credentials_set` (a blob genuinely exists; it is merely useless), and the damage
	 * surfaced later, on another screen, as a Forward that could not authenticate.
	 * `azure_devops` and `fr` carry a single field each and were never exposed — Jira is the only
	 * multi-field kind, and the only broken one.
	 *
	 * ⛔ WHY REFUSE RATHER THAN GUESS. Half-filled is ambiguous by nature and only one of the three
	 * available answers is honest:
	 *   (a) send `undefined` unless BOTH are filled — the stored blob survives, but the e-mail the
	 *       admin just typed is silently discarded under a green "Saved". That swaps a silent
	 *       destroy for a silent no-op: the same lie, a different victim.
	 *   (b) send only the filled field and merge server-side — the backend would have to decrypt,
	 *       merge and re-encrypt a blob whose SHAPE IS PER-KIND and which it deliberately does not
	 *       understand (`z.record`, one opaque column for three kinds). It would also cheerfully
	 *       marry a new e-mail to the old token, producing a credential that is structurally
	 *       complete, does not authenticate, and still reports "set" — this defect again, one
	 *       layer down.
	 *   (c) refuse the save and name the missing field — CHOSEN. Jira basic auth IS the pair; you
	 *       cannot authenticate with half of it, so "half filled" is not an intent the product can
	 *       honour. Refusing costs the admin one field instead of a token, and it is what makes
	 *       `delivery_credentials_hint` ("Leave blank to keep the current credentials") literally
	 *       true: blank BOTH keeps, fill BOTH replaces, and there is no third outcome.
	 */
	function credentials(): CredentialOutcome {
		if (kind === 'jira') {
			const email = jiraEmail.trim();
			const apiToken = jiraToken.trim();
			if (!email && !apiToken) return { state: 'unchanged' };
			if (!email) return { state: 'incomplete', field: m.delivery_jira_email_label() };
			if (!apiToken) return { state: 'incomplete', field: m.delivery_jira_token_label() };
			return { state: 'value', value: { email, apiToken } };
		}
		if (kind === 'azure_devops') {
			return adoPat.trim() ? { state: 'value', value: { pat: adoPat.trim() } } : { state: 'unchanged' };
		}
		return frToken.trim()
			? { state: 'value', value: { licenseToken: frToken.trim() } }
			: { state: 'unchanged' };
	}

	/** Which Jira field the OTHER one now obliges. Drives the native `required` attribute so the
	 *  pair advertises that it moves together BEFORE the admin reaches the refusal above. */
	const jiraEmailRequired = $derived(kind === 'jira' && !!jiraToken.trim() && !jiraEmail.trim());
	const jiraTokenRequired = $derived(kind === 'jira' && !!jiraEmail.trim() && !jiraToken.trim());

	const canSave = $derived(name.trim().length > 0 && !saving);

	async function save() {
		if (!canSave) {
			banner = { kind: 'error', text: m.delivery_err_name_required() };
			return;
		}
		// Refuse BEFORE `saving = true` — nothing has been attempted, so the button must not flicker
		// through its in-flight label for a request that never leaves.
		const creds = credentials();
		if (creds.state === 'incomplete') {
			// ⛔ AN EXISTING GENERIC SENTENCE, NOT AN EIGHTH TRANSLATION OF ONE. `blockerr_field_required`
			// is "“{field}” is required." in all eight catalogues and is already used this way by
			// `i18n/block-test-error-label.ts`. Minting `delivery_err_credentials_incomplete` beside it
			// would be two keys for one sentence — the same call `error-message.ts` makes for
			// `bad_config_required`. The FIELD is what makes it specific, and it is localized too.
			banner = { kind: 'error', text: m.blockerr_field_required({ field: bidiIsolate(creds.field) }) };
			return;
		}
		saving = true;
		banner = null;
		const body = {
			name: name.trim(),
			baseUrl: baseUrl.trim() || undefined,
			projectKey: usesBacklog && projectKey.trim() ? projectKey.trim() : undefined,
			defaultItemType: usesBacklog && defaultItemType.trim() ? defaultItemType.trim() : undefined,
			enabled,
			...(creds.state === 'value' ? { credentials: creds.value } : {})
		};
		try {
			if (editingId) {
				await deliveryApi.update(editingId, body);
			} else {
				await deliveryApi.create({ kind, ...body });
			}
			await load();
			resetForm();
			banner = { kind: 'ok', text: m.delivery_saved() };
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_save_failed()) };
		} finally {
			saving = false;
		}
	}

	let testingId = $state<string | null>(null);
	// ⛔ TYPED `ConnectionTestResult`, NOT `{ ok, detail }`. The narrow shape was a LIE that
	// typechecked: the API really does return `code`/`params` at runtime, JS assignment does not
	// strip them, and `connectionTestLabel` reads them — so the localized sentence worked while the
	// declared type said those fields did not exist. The next reader would have "cleaned up" the
	// label module's params handling as dead code.
	let testResults = $state<Record<string, ConnectionTestResult>>({});
	async function testTarget(t: DeliveryTarget) {
		if (testingId) return;
		testingId = t.id;
		try {
			testResults = { ...testResults, [t.id]: await deliveryApi.test(t.id) };
		} catch (e) {
			// Same deliberate exception as connectors' testCreate: `detail` IS the diagnostic the
			// connection test exists to produce, so the raw message stays the fallback — but a
			// 402/403/409 still gets localized copy, never leaked.
			testResults = {
				...testResults,
				[t.id]: { ok: false, detail: errorText(e, e instanceof Error ? e.message : String(e)) }
			};
		} finally {
			testingId = null;
		}
	}

	async function remove(t: DeliveryTarget) {
		if (!(await confirmDialog({ message: m.delivery_confirm_delete() }))) return;
		try {
			await deliveryApi.remove(t.id);
			if (editingId === t.id) resetForm();
			await load();
			banner = { kind: 'ok', text: m.delivery_deleted() };
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_delete_failed()) };
		}
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.delivery_eyebrow()}</div>
		<h1>{m.delivery_title()}</h1>
		<p>{m.delivery_lede()}</p>
	</header>

	{#if denied}
		<div class="notice error">{m.delivery_denied()}</div>
	{:else if loading}
		<div class="notice">{m.delivery_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.delivery_load_failed({ error: loadError })}</div>
	{:else}
		<div class="layout">
			<form class="card" onsubmit={(e) => { e.preventDefault(); save(); }}>
				<h2>{editingId ? m.delivery_form_edit() : m.delivery_form_new()}</h2>

				<div class="field">
					<label for="kind">{m.delivery_kind_label()}</label>
					<select id="kind" bind:value={kind} disabled={!!editingId}>
						{#each KINDS as k (k.v)}<option value={k.v}>{mm[k.labelKey]()}</option>{/each}
					</select>
				</div>

				<div class="field">
					<label for="name">{m.delivery_name_label()}</label>
					<input id="name" bind:value={name} placeholder={m.delivery_name_placeholder()} maxlength="120" />
				</div>

				<div class="field">
					<label for="baseurl">{m.delivery_baseurl_label()}</label>
					<input id="baseurl" type="url" bind:value={baseUrl} placeholder={m.delivery_baseurl_placeholder()} maxlength="500" />
				</div>

				{#if usesBacklog}
					<div class="field">
						<label for="projectkey">{m.delivery_project_key_label()}</label>
						<input id="projectkey" bind:value={projectKey} maxlength="200" />
					</div>
					<div class="field">
						<label for="itemtype">{m.delivery_item_type_label()}</label>
						<input id="itemtype" bind:value={defaultItemType} placeholder={m.delivery_item_type_placeholder()} maxlength="60" />
					</div>
				{/if}

				<fieldset class="creds">
					<legend>{m.delivery_credentials_label()}
						<span class={editingHasCreds ? 'creds-set' : 'creds-unset'}>
							{editingHasCreds ? m.delivery_credentials_set() : m.delivery_credentials_unset()}
						</span>
					</legend>
					{#if kind === 'jira'}
						<!-- `required` is driven by the OTHER field, never by both at once: an untouched form
						     must not nag (blank-both is the documented "keep what is stored" case), but the
						     moment one half is typed the other stops being optional. That is the affordance
						     for the pair-is-one-credential rule `credentials()` enforces. -->
						<div class="field">
							<label for="jira-email">{m.delivery_jira_email_label()}</label>
							<input id="jira-email" bind:value={jiraEmail} autocomplete="off" maxlength="200"
								required={jiraEmailRequired} aria-invalid={jiraEmailRequired} />
						</div>
						<div class="field">
							<label for="jira-token">{m.delivery_jira_token_label()}</label>
							<input id="jira-token" type="password" bind:value={jiraToken} autocomplete="off" maxlength="500"
								required={jiraTokenRequired} aria-invalid={jiraTokenRequired} />
						</div>
					{:else if kind === 'azure_devops'}
						<div class="field">
							<label for="ado-pat">{m.delivery_ado_pat_label()}</label>
							<input id="ado-pat" type="password" bind:value={adoPat} autocomplete="off" maxlength="500" />
						</div>
					{:else}
						<div class="field">
							<label for="fr-token">{m.delivery_fr_token_label()}</label>
							<input id="fr-token" type="password" bind:value={frToken} autocomplete="off" maxlength="800" />
						</div>
					{/if}
					<div class="hint">{m.delivery_credentials_hint()}</div>
				</fieldset>

				<label class="toggle">
					<input type="checkbox" bind:checked={enabled} />
					{m.delivery_enabled_label()}
				</label>

				{#if banner}<div class="banner {banner.kind}">{banner.text}</div>{/if}

				<div class="actions">
					{#if editingId}<button type="button" class="btn-ghost" onclick={resetForm}>{m.delivery_cancel()}</button>{/if}
					<button class="btn-primary" type="submit" disabled={!canSave}>{saving ? m.delivery_saving() : m.delivery_save()}</button>
				</div>
			</form>

			<aside class="preview">
				<div class="preview-label">{m.delivery_status_label()}</div>
				{#if targets.length === 0}
					<div class="notice">{m.delivery_empty()}</div>
				{:else}
					<ul class="target-list">
						{#each targets as t (t.id)}
							<li class="card target-row" class:disabled={!t.enabled}>
								<div class="target-head">
									<span class="kind-badge">{kindLabel(t.kind)}</span>
									<b class="target-name">{t.name}</b>
								</div>
								<div class="target-meta">
									<span class={t.hasCredentials ? 'ok' : 'muted'}>
										{t.hasCredentials ? m.delivery_credentials_set() : m.delivery_credentials_unset()}
									</span>
									{#if !t.enabled}<span class="muted">· {m.delivery_disabled_tag()}</span>{/if}
								</div>
								<div class="target-actions">
									<!-- `testingId !== null`, not `=== t.id`: the lock in `testTarget` is single-flight for the
									     WHOLE list, so while any row is in flight every other row's Test click returns at the
									     first line — no spinner, no result, no banner. Disabling only the row that HOLDS the
									     lock left the others looking pressable for the full 10s connector timeout. -->
									<button type="button" class="btn-link" onclick={() => testTarget(t)} disabled={testingId !== null}>{testingId === t.id ? m.delivery_testing() : m.delivery_test()}</button>
									<button type="button" class="btn-link" onclick={() => startEdit(t)}>{m.delivery_edit()}</button>
									<button type="button" class="btn-link danger" onclick={() => remove(t)}>{m.delivery_delete()}</button>
								</div>
								{#if testResults[t.id]}
									<!-- Same 200-OK path as the other two test screens. The adapters emit a machine
									     `kind` ('jira' | 'azure_devops') rather than a product NAME, so the tool is
									     named through `deliveryKindLabel` in the reader's locale too. -->
									<div class="test-result {testResults[t.id].ok ? 'ok' : 'error'}">{connectionTestLabel(testResults[t.id], locale.current)}</div>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
				<div class="notice teal"><p>{m.delivery_security_note()}</p></div>
				<div class="notice"><p>{m.delivery_dispatch_note()}</p></div>
			</aside>
		</div>
	{/if}
</div>

<style>
	.page { max-width: 1080px; }
	.page-head { margin-bottom: 22px; }
	.eyebrow {
		font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase;
		font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px;
	}
	h1 { font-family: var(--font-display); font-size: 30px; margin: 0 0 6px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 620px; }
	.layout { display: grid; grid-template-columns: 1fr 360px; gap: 22px; align-items: start; }
	.card {
		background: var(--c-white); border: 1px solid var(--c-border);
		border-radius: var(--r-lg); padding: 20px 22px;
	}
	form h2 { font-size: 15px; margin: 0 0 16px; color: var(--c-midnight); }
	.field { margin-bottom: 16px; display: flex; flex-direction: column; }
	label { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 6px; }
	input, select {
		font-family: var(--font-sans); font-size: 13.5px; color: var(--c-ink);
		border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px;
		width: 100%; box-sizing: border-box; background: var(--c-white);
	}
	select:disabled { opacity: 0.6; }
	.hint { font-size: 11.5px; color: var(--c-muted); margin-top: 5px; }
	.creds {
		border: 1px solid var(--c-border); border-radius: var(--r); padding: 12px 14px 4px;
		margin: 0 0 16px; min-inline-size: 0;
	}
	.creds legend {
		font-size: 12px; font-weight: 600; color: var(--c-ink); padding: 0 6px;
		display: inline-flex; gap: 8px; align-items: center;
	}
	.creds-set { color: var(--c-teal-dark); font-weight: 600; font-size: 11px; }
	.creds-unset { color: var(--c-faint); font-weight: 400; font-size: 11px; }
	.toggle { flex-direction: row; align-items: center; gap: 8px; font-weight: 500; margin-bottom: 14px; }
	.toggle input { width: auto; }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); margin-bottom: 14px; }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.actions { display: flex; justify-content: flex-end; gap: 10px; }
	.btn-primary {
		background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px;
		padding: 10px 18px; border-radius: var(--r); border: none;
	}
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost {
		background: transparent; color: var(--c-muted); font-weight: 600; font-size: 13px;
		padding: 10px 16px; border-radius: var(--r); border: 1px solid var(--c-border);
	}
	.preview { display: flex; flex-direction: column; gap: 14px; position: sticky; top: 20px; }
	.preview-label {
		font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase;
		font-weight: 600; color: var(--c-muted);
	}
	.target-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
	.target-row { padding: 14px 16px; }
	.target-row.disabled { opacity: 0.6; }
	.target-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
	.kind-badge {
		font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--c-teal-dark); background: var(--c-teal-pale); border-radius: 999px; padding: 2px 8px;
	}
	.target-name { color: var(--c-ink); font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.target-meta { font-size: 11.5px; color: var(--c-muted); margin-bottom: 8px; }
	.target-meta .ok { color: var(--c-teal-dark); font-weight: 600; }
	.target-meta .muted { color: var(--c-faint); }
	.target-actions { display: flex; gap: 14px; }
	.btn-link { background: none; border: none; padding: 0; font-size: 12.5px; font-weight: 600; color: var(--c-teal-dark); cursor: pointer; }
	.btn-link:disabled { opacity: 0.55; cursor: not-allowed; }
	.btn-link.danger { color: var(--c-coral-dark); }
	.test-result { margin-top: 8px; font-size: 12px; padding: 8px 10px; border-radius: var(--r); }
	.test-result.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	.test-result.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.notice { font-size: 12.5px; padding: 12px 14px; border-radius: var(--r-lg); line-height: 1.5; }
	.notice.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.notice.teal { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-ink); }
	.notice p { margin: 0; }
	@media (max-width: 820px) {
		.layout { grid-template-columns: 1fr; }
		.preview { position: static; }
	}
</style>
