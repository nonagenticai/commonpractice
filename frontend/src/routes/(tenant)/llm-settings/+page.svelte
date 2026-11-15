<script lang="ts">
	// LLM provider settings — the BYO-key screen (SPEC §5A Layer 1). Platform-gated:
	// a platform user picks provider/model and optionally supplies their own key,
	// which is AES-256-GCM-encrypted server-side and never returned (hasKey only).
	// Backend: GET/PUT /api/llm-settings (routes/llm-settings.ts).
	import { onMount } from 'svelte';
	import { llmSettingsApi, ApiError, type LlmSettings, type ProviderPreset } from '$lib/api/llm-settings';
	import { adapterIdentityFor } from '$lib/llm/adapter-identity';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import * as m from '$lib/paraglide/messages';
	import { exact, usd } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { connectionTestLabel, type ConnectionTestResult } from '$lib/i18n/connection-test-label';

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);

	let presets = $state<ProviderPreset[]>([]);

	// form state
	let presetKey = $state('local');
	let model = $state('');
	let baseUrl = $state('');
	let temperature = $state<number | null>(0.1);
	let paramsText = $state('{}');
	let apiKey = $state('');
	// ──────────────────────────────────────────────────────────────────────────────────────────
	// ⛔ `hasKey` USED TO BE `$state`, AND THAT WAS THE DEFECT.
	//
	// `applyPresetDefaults` reset `baseUrl`, `model` and `apiKey` but never `hasKey`, which was
	// written only at hydrate and after a save. The provider `<select>` calls it, so `hasKey`
	// survived every provider switch: the panel went on reporting "Key set ✓", and — worse —
	// `canSave`'s `(!requiresKey || hasKey || apiKey…)` let a STALE flag satisfy the NEW vendor's
	// key requirement, so the screen offered to save a config it held no credential for.
	//
	// The server half is what made that dangerous: the PUT route left the old ciphertext in place
	// while overwriting provider/base_url, and `ai/llm/select.ts` handed that key to whichever
	// adapter the new row selected — an OpenAI `sk-…` offered to api.anthropic.com as `x-api-key`.
	// That half is fixed in `backend/src/routes/llm-settings.ts`, which now DISOWNS a stored key on
	// a vendor change; this state is the browser saying the same thing.
	//
	// So the fact we hold is not "a key exists" but WHICH VENDOR holds one — written only from the
	// server's own answer — and `hasKey` is derived by comparing it with the vendor the form
	// currently points at. Derived rather than reset inside `applyPresetDefaults` because the
	// `custom` preset's vendor is the base-url TEXT FIELD, which that function never sees: editing
	// it is a vendor switch made without touching the provider dropdown.
	// ──────────────────────────────────────────────────────────────────────────────────────────
	let keyVendor = $state<string | null>(null);

	let saving = $state(false);
	let banner = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	// `platform_only` (demo/trial): bringing your own key is switched OFF — the backend refuses a key
	// (403 `llm_byo_disabled`) and ignores any stored one, so the key field is disabled and says why.
	let byoLocked = $state(false);

	const preset = $derived(presets.find((p) => p.key === presetKey));
	const isCustom = $derived(preset?.custom ?? false);
	const requiresKey = $derived(preset?.requiresKey ?? false);
	// A model dropdown when the preset pins a list; a free text field for custom / empty lists.
	const useModelSelect = $derived(!isCustom && (preset?.models.length ?? 0) > 0);
	// The vendor the form points at right now — the same (family, host) pair the backend keys a
	// stored secret to. `baseUrl` only counts for `custom`; every other preset pins its own.
	const formVendor = $derived(
		preset ? adapterIdentityFor(preset.adapterKind, isCustom ? baseUrl : preset.defaultBaseUrl) : null
	);
	/** Whether a key is stored FOR THE VENDOR ON SCREEN. See the block on `keyVendor`. */
	const hasKey = $derived(keyVendor !== null && keyVendor === formVendor);

	function applyPresetDefaults(p: ProviderPreset) {
		if (!p.custom) baseUrl = p.defaultBaseUrl ?? '';
		if (!p.custom && !p.models.includes(model)) model = p.models[0] ?? '';
		if (!requiresKey) apiKey = '';
		// ⛔ Do NOT add `hasKey = false` here. `hasKey` is derived from `keyVendor` vs `formVendor`,
		// which already covers this switch AND the custom base-url edit this function never sees.
	}

	function onPresetChange() {
		const p = presets.find((x) => x.key === presetKey);
		if (p) applyPresetDefaults(p);
	}

	function hydrate(s: LlmSettings) {
		byoLocked = s.byoMode === 'platform_only';
		if (!s.configured) return;
		presetKey = s.preset ?? 'local';
		model = s.model ?? '';
		baseUrl = s.baseUrl ?? '';
		temperature = s.temperature ?? null;
		paramsText = JSON.stringify(s.params ?? {}, null, 2);
		// Keyed to the vendor the SERVER says the row points at, not to whatever the form drifts to.
		keyVendor = s.hasKey && s.provider ? adapterIdentityFor(s.provider, s.baseUrl ?? null) : null;
	}

	async function load() {
		loading = true;
		loadError = null;
		denied = false;
		try {
			const [cat, cur] = await Promise.all([llmSettingsApi.catalog(), llmSettingsApi.get()]);
			presets = cat.providers;
			hydrate(cur);
			if (!cur.configured) {
				const p = presets.find((x) => x.key === presetKey);
				if (p) applyPresetDefaults(p);
			}
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function parseParams(): Record<string, unknown> | null {
		const raw = paramsText.trim();
		if (!raw) return {};
		try {
			const v = JSON.parse(raw);
			return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}

	// Live validation of the advanced-params JSON so the user sees the error WHILE typing,
	// not only after pressing Save. null = valid (empty or a JSON object).
	const paramsError = $derived.by(() => {
		const raw = paramsText.trim();
		if (!raw) return null;
		try {
			const v = JSON.parse(raw);
			if (!v || typeof v !== 'object' || Array.isArray(v)) return m.llmset_err_params_json();
			return null;
		} catch {
			return m.llmset_err_params_json();
		}
	});

	const canSave = $derived(
		!!preset &&
			model.trim().length > 0 &&
			(!isCustom || baseUrl.trim().length > 0) &&
			(!requiresKey || hasKey || apiKey.trim().length > 0) &&
			(!byoLocked || !requiresKey) &&
			(temperature === null || (temperature >= 0 && temperature <= 2)) &&
			paramsError === null &&
			!saving
	);

	async function save() {
		if (!canSave || !preset) return;
		const params = parseParams();
		if (params === null) {
			banner = { kind: 'error', text: m.llmset_err_params_json() };
			return;
		}
		saving = true;
		banner = null;
		try {
			const res = await llmSettingsApi.update({
				provider: preset.adapterKind,
				model: model.trim(),
				baseUrl: isCustom ? baseUrl.trim() : (preset.defaultBaseUrl ?? undefined),
				temperature,
				params,
				apiKey: apiKey.trim() ? apiKey.trim() : undefined
			});
			// Again from the server's answer — including its `baseUrl`, so the row's own idea of the
			// vendor is what the panel reports, never the form's.
			keyVendor = res.hasKey ? adapterIdentityFor(res.provider, res.baseUrl) : null;
			apiKey = ''; // never keep the plaintext key in the form after a save
			presetKey = res.preset;
			temperature = res.temperature;
			banner = { kind: 'ok', text: m.llmset_saved() };
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_save_failed()) };
		} finally {
			saving = false;
		}
	}

	// Test the provider config the user is EDITING (a 1-token ping via the broker). The form
	// values are posted so unsaved edits are exercised; a blank key falls back to the stored one.
	let testing = $state(false);
	// ⛔ TYPED `ConnectionTestResult`, NOT `{ ok, detail }`. The narrow shape was a LIE that
	// typechecked: the API really does return `code`/`params` at runtime, JS assignment does not
	// strip them, and `connectionTestLabel` reads them — so the localized sentence worked while the
	// declared type said those fields did not exist. The next reader would have "cleaned up" the
	// label module's params handling as dead code.
	let testResult = $state<ConnectionTestResult | null>(null);
	async function testConnection() {
		if (testing || !preset) return;
		const params = parseParams();
		if (params === null) {
			testResult = { ok: false, detail: m.llmset_err_params_json() };
			return;
		}
		testing = true;
		testResult = null;
		try {
			testResult = await llmSettingsApi.test({
				provider: preset.adapterKind,
				model: model.trim(),
				baseUrl: isCustom ? baseUrl.trim() : (preset.defaultBaseUrl ?? undefined),
				temperature,
				params,
				apiKey: apiKey.trim() ? apiKey.trim() : undefined
			});
		} catch (e) {
			// Same deliberate exception as connectors' testCreate: `detail` IS the diagnostic the
			// connection test exists to produce (a provider's own "401 Invalid API key"), so the raw
			// message stays the fallback — but a 402/403/409 still gets localized copy, never leaked.
			testResult = { ok: false, detail: errorText(e, e instanceof Error ? e.message : String(e)) };
		} finally {
			testing = false;
		}
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.llmset_eyebrow()}</div>
		<h1>{m.llmset_title()}</h1>
		<p>{m.llmset_lede()}</p>
	</header>

	{#if denied}
		<div class="notice error">{m.llmset_denied()}</div>
	{:else if loading}
		<div class="notice">{m.llmset_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.llmset_load_failed({ error: loadError })}</div>
	{:else}
		<div class="layout">
			<form class="card" onsubmit={(e) => { e.preventDefault(); save(); }}>
				<div class="field">
					<label for="provider">{m.llmset_provider_label()}</label>
					<select id="provider" bind:value={presetKey} onchange={onPresetChange}>
						{#each presets as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
					</select>
					{#if preset && !requiresKey}<div class="hint">{m.llmset_provider_local_hint()}</div>{/if}
					{#if byoLocked}<div class="hint byo-locked" role="note">{m.llmset_byo_locked()}</div>{/if}
				</div>

				<div class="field">
					<label for="model">{m.llmset_model_label()}</label>
					{#if useModelSelect && preset}
						<select id="model" bind:value={model}>
							{#each preset.models as mid (mid)}<option value={mid}>{mid}</option>{/each}
						</select>
					{:else}
						<input id="model" bind:value={model} placeholder={m.llmset_model_placeholder()} maxlength="200" />
					{/if}
				</div>

				{#if isCustom}
					<div class="field">
						<label for="baseurl">{m.llmset_baseurl_label()}</label>
						<input id="baseurl" type="url" bind:value={baseUrl} placeholder="https://…" maxlength="500" />
						<div class="hint">{m.llmset_baseurl_hint()}</div>
					</div>
				{:else if baseUrl}
					<div class="field">
						<label for="baseurl">{m.llmset_baseurl_label()}</label>
						<!-- Managed default points at an internal cluster endpoint — never surface that
						     hostname to a tenant. Show a friendly "managed" label instead of the URL. -->
						<input id="baseurl" type="text" value={m.llmset_baseurl_managed()} readonly tabindex="-1" />
						<div class="hint">{m.llmset_baseurl_auto_hint()}</div>
					</div>
				{/if}

				<div class="field">
					<label for="temperature">{m.llmset_temperature_label()}</label>
					<input id="temperature" type="number" min="0" max="2" step="0.1" bind:value={temperature} placeholder="0.1" />
					<div class="hint">{m.llmset_temperature_hint()}</div>
				</div>

				{#if requiresKey || hasKey}
					<div class="field">
						<label for="apikey">{m.llmset_apikey_label()}</label>
						<input id="apikey" type="password" bind:value={apiKey} placeholder={m.llmset_apikey_placeholder()} maxlength="500" autocomplete="off" disabled={byoLocked} />
						<div class="hint">
							{#if hasKey}<span class="key-set">{m.llmset_apikey_set()}</span> {/if}{m.llmset_apikey_hint()}
						</div>
					</div>
				{/if}

				<details class="advanced">
					<summary>{m.llmset_params_label()}</summary>
					<div class="field">
						<textarea id="params" class:invalid={paramsError} bind:value={paramsText} rows="4" spellcheck="false"></textarea>
						{#if paramsError}
							<div class="field-error">{paramsError}</div>
						{:else}
							<div class="hint">{m.llmset_params_hint()}</div>
						{/if}
					</div>
				</details>

				{#if banner}<div class="banner {banner.kind}">{banner.text}</div>{/if}

				<div class="actions">
					<button class="btn-ghost" type="button" disabled={testing} onclick={testConnection}>{testing ? m.llmset_testing() : m.llmset_test()}</button>
					<button class="btn-primary" type="submit" disabled={!canSave}>{saving ? m.llmset_saving() : m.llmset_save()}</button>
				</div>
				{#if testResult}
					<!-- Same 200-OK path as /connectors: `{testResult.detail}` was the server's English on
					     both the pass and the fail branch. `provider`/`model` were ALREADY on this
					     response as top-level fields — the machine facts were on the wire the whole
					     time and this line still rendered the server's hand-joined string. -->
					<div class="test-result {testResult.ok ? 'ok' : 'error'}">{connectionTestLabel(testResult, locale.current)}</div>
				{/if}
				<div class="hint test-hint">{m.llmset_test_hint()}</div>
			</form>

			<aside class="preview">
				<div class="preview-label">{m.llmset_status_label()}</div>
				<div class="card status-card">
					<div class="status-row"><span>{m.llmset_provider_label()}</span><b>{preset?.label ?? '—'}</b></div>
					<div class="status-row"><span>{m.llmset_model_label()}</span><b class="mono">{model.trim() || '—'}</b></div>
					<!-- ⛔ `{temperature}` DIRECTLY WAS THE DEFECT. It is a `number`, so Svelte interpolates
					     `String(0.1)` = "0.1" — the DEVELOPER'S punctuation, on the one figure this panel
					     exists to confirm, in a panel whose every other figure (the budget row above)
					     already routes through `usd(…, locale.current)`. Dutch writes 0,1.
					     Not `decimal1()`: temperature is entered free-hand (`step="0.1"` is a stepper
					     hint, and the page's own validation accepts anything in 0…2), so the status row
					     must echo what was typed — `decimal1(1)` would answer "1,0" to a field reading
					     "1", and `decimal1(0.05)` would answer "0,1" to a field reading "0.05".
					     `?? '—'` is unchanged: absence is still absence, never "0".

					     ⛔ AND NOT `num()`, WHICH IS WHAT THIS LINE SHIPPED FIRST. `num()` is
					     `toLocaleString`, default `maximumFractionDigits: 3`. Measured through this very
					     panel: temperature 0.0001 rendered "0" and 0.999999 rendered "1" — a set value
					     reported as unset, and a saved value reported as a different one, while the
					     `<input>` two panes away showed the raw figure at the same moment. Both are
					     accepted by the backend: `routes/llm-settings.ts` is `z.number().min(0).max(2)`
					     with no decimal bound, into a `real` column.

					     ⛔ AND THE FIX IS HERE, NOT IN THE ZOD SCHEMA. Bounding the API instead would be
					     a breaking change that rejects values already persisted and that every provider
					     accepts — CP does not own a precision policy for somebody else's sampling
					     parameter, and this is a RENDER defect (the field and the panel disagreeing),
					     so it is fixed where the rendering is. `exact()` = 21 significant digits, which
					     is every double, with the reader's separator. See its header for why not
					     `maximumFractionDigits: 20`. -->
					<div class="status-row"><span>{m.llmset_temperature_label()}</span><b class="mono">{temperature == null ? '—' : exact(temperature, locale.current)}</b></div>
					{#if baseUrl}<div class="status-row"><span>{m.llmset_baseurl_label()}</span><b class="mono">{isCustom ? (baseUrl.trim() || '—') : m.llmset_baseurl_managed()}</b></div>{/if}
					<div class="status-row"><span>{m.llmset_apikey_label()}</span><b class={hasKey ? 'ok' : 'muted'}>{hasKey ? m.llmset_apikey_set() : requiresKey ? m.llmset_apikey_unset() : m.llmset_apikey_notneeded()}</b></div>
				</div>
				<div class="notice teal">
					<p>{m.llmset_security_note()}</p>
				</div>
			</aside>
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 1080px;
	}
	.page-head {
		margin-bottom: 22px;
	}
	.eyebrow {
		font-size: 10.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-teal-dark);
		margin-bottom: 8px;
	}
	h1 {
		font-family: var(--font-display);
		font-size: 30px;
		margin: 0 0 6px;
		color: var(--c-midnight);
	}
	.page-head p {
		color: var(--c-muted);
		font-size: 13.5px;
		margin: 0;
		max-width: 620px;
	}
	.layout {
		display: grid;
		grid-template-columns: 1fr 340px;
		gap: 22px;
		align-items: start;
	}
	.card {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 20px 22px;
	}
	.field {
		margin-bottom: 16px;
		display: flex;
		flex-direction: column;
	}
	label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
		margin-bottom: 6px;
	}
	input,
	textarea,
	select {
		font-family: var(--font-sans);
		font-size: 13.5px;
		color: var(--c-ink);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 9px 12px;
		width: 100%;
		box-sizing: border-box;
		background: var(--c-white);
	}
	textarea {
		resize: vertical;
		font-family: var(--font-mono);
		font-size: 12.5px;
	}
	.hint {
		font-size: 11.5px;
		color: var(--c-muted);
		margin-top: 5px;
	}
	textarea.invalid {
		border-color: var(--c-coral);
		background: var(--c-coral-pale);
	}
	.field-error {
		font-size: 11.5px;
		color: var(--c-coral-dark);
		margin-top: 5px;
	}
	.test-hint {
		margin-top: 8px;
	}
	input[readonly] {
		background: var(--c-surface);
		color: var(--c-muted);
		cursor: default;
	}
	.advanced {
		margin-bottom: 16px;
	}
	.advanced summary {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
		cursor: pointer;
		margin-bottom: 10px;
	}
	.key-set {
		color: var(--c-teal-dark);
		font-weight: 600;
	}
	.banner {
		font-size: 12.5px;
		padding: 10px 12px;
		border-radius: var(--r);
		margin-bottom: 14px;
	}
	.banner.ok {
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.banner.error {
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		color: var(--c-coral-dark);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.btn-primary {
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 10px 18px;
		border-radius: var(--r);
		border: none;
	}
	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn-ghost {
		font-size: 13px;
		font-weight: 500;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 10px 16px;
		border-radius: var(--r);
	}
	.btn-ghost:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.test-result {
		margin-top: 10px;
		font-size: 12.5px;
		padding: 9px 12px;
		border-radius: var(--r);
	}
	.test-result.ok {
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.test-result.error {
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		color: var(--c-coral-dark);
	}
	.preview {
		display: flex;
		flex-direction: column;
		gap: 14px;
		position: sticky;
		top: 20px;
	}
	.preview-label {
		font-size: 10.5px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-muted);
	}
	.status-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.status-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.status-row b {
		color: var(--c-ink);
		font-weight: 600;
		text-align: end;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 200px;
	}
	.status-row b.mono {
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.status-row b.ok {
		color: var(--c-teal-dark);
	}
	.status-row b.muted {
		color: var(--c-faint);
		font-weight: 400;
	}
	.notice {
		font-size: 12.5px;
		padding: 12px 14px;
		border-radius: var(--r-lg);
		line-height: 1.5;
	}
	.notice.error {
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		color: var(--c-coral-dark);
	}
	.notice.teal {
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		color: var(--c-ink);
	}
	.notice.teal p {
		margin: 0;
	}
	@media (max-width: 820px) {
		.layout {
			grid-template-columns: 1fr;
		}
		.preview {
			position: static;
		}
	}
</style>
