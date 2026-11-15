// @vitest-environment jsdom
//
// src/routes/(tenant)/llm-settings/llm-settings.key-vendor.render.test.ts — a stored provider key
// belongs to the vendor it was issued to, and this screen must stop claiming otherwise the moment
// the form points somewhere else.
//
// ⛔ THE DEFECT. `applyPresetDefaults` reset `baseUrl`, `model` and `apiKey` but never `hasKey` —
// which was only ever written at hydrate and after a save. The provider `<select>` calls it, so
// `hasKey` survived every provider switch. Two things followed, both wrong and both visible:
//
//   1. THE PANEL KEPT SAYING "Key set ✓" for a vendor that has never been given a key.
//   2. `canSave` reads `(!requiresKey || hasKey || apiKey.trim().length > 0)`, so a STALE `hasKey`
//      satisfied the NEW provider's key requirement and the screen happily offered Save.
//
// The server half is what made that dangerous rather than merely untidy: the PUT route left the
// old ciphertext in place while overwriting provider/base_url, and `ai/llm/select.ts` then handed
// that key to whichever adapter the new row selected — an OpenAI `sk-…` offered to api.anthropic.com
// as `x-api-key`, and to api.x.ai as `Authorization: Bearer`. That half is fixed in
// `backend/src/routes/llm-settings.ts` (and pinned in `backend/tests/llm-settings.test.ts`); this
// file is the browser half, so the screen never again asserts a key it cannot have.
//
// ⛔ SECTION 3 IS THE OVER-CORRECTION GUARD AND IS NOT OPTIONAL. "Clear `hasKey` on every change"
// passes every assertion in sections 1 and 2, and would demand the tenant re-type their key to
// switch model — the exact edit the backend's `keyPatch` was written to protect.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ProviderPreset } from '$lib/api/llm-settings';

// The real `en` catalog, each key resolving to its own name — nothing here asserts on wording.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { get, catalog, update } = vi.hoisted(() => ({ get: vi.fn(), catalog: vi.fn(), update: vi.fn() }));
// ⛔ ALIAS ids, never relative ones — see the long note in $lib/api/llm-settings.test.ts.
vi.mock('$lib/api/llm-settings', () => ({
	llmSettingsApi: { get, catalog, update, test: vi.fn() },
	ApiError: class ApiError extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			message: string
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

/** The shape of the live backend catalog (ai/llm/provider-catalog.ts), trimmed to what is used. */
const PRESETS: ProviderPreset[] = [
	{
		key: 'local',
		label: 'Local (pgx vLLM)',
		adapterKind: 'openai_compatible',
		defaultBaseUrl: 'http://inference-router.inference-router.svc.cluster.local:8150/api',
		requiresKey: false,
		models: ['local-llm']
	},
	{
		key: 'anthropic',
		label: 'Anthropic (Claude)',
		adapterKind: 'anthropic',
		defaultBaseUrl: null,
		requiresKey: true,
		models: ['claude-opus-4-8', 'claude-sonnet-4-6']
	},
	{
		key: 'openai',
		label: 'OpenAI',
		adapterKind: 'openai_compatible',
		defaultBaseUrl: 'https://api.openai.com/v1',
		requiresKey: true,
		models: ['gpt-4o', 'gpt-4.1']
	},
	{
		key: 'xai',
		label: 'Grok (xAI)',
		adapterKind: 'openai_compatible',
		defaultBaseUrl: 'https://api.x.ai/v1',
		requiresKey: true,
		models: ['grok-4.5']
	},
	{
		key: 'custom',
		label: 'Custom (OpenAI-compatible)',
		adapterKind: 'openai_compatible',
		defaultBaseUrl: null,
		requiresKey: true,
		models: [],
		custom: true
	}
];

let target: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

async function settle(ticks = 20): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

/** Mount with a tenant that already saved a key against the given preset. */
async function render(saved: {
	preset: string;
	provider: 'anthropic' | 'openai' | 'openai_compatible';
	model: string;
	baseUrl: string | null;
	hasKey: boolean;
	byoMode?: 'byo_required' | 'local_allowed' | 'platform_only' | null;
}): Promise<HTMLElement> {
	catalog.mockResolvedValue({ providers: PRESETS });
	get.mockResolvedValue({
		configured: true,
		preset: saved.preset,
		provider: saved.provider,
		model: saved.model,
		baseUrl: saved.baseUrl,
		temperature: 0.1,
		params: {},
		hasKey: saved.hasKey,
		budget: null,
		byoMode: saved.byoMode ?? null
	});
	target = document.createElement('div');
	document.body.appendChild(target);
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	expect(
		target.textContent,
		'the page never left its loading state — the fixture did not land, so nothing below is a proof'
	).not.toContain('llmset_loading');
	return target;
}

/** The tenant whose OpenAI key is stored — the starting point for every case below. */
const OPENAI_TENANT = {
	preset: 'openai',
	provider: 'openai_compatible' as const,
	model: 'gpt-4o',
	baseUrl: 'https://api.openai.com/v1',
	hasKey: true
};

const statusText = () => target!.querySelector('.status-card')!.textContent ?? '';
const saveButton = () => target!.querySelector<HTMLButtonElement>('button.btn-primary')!;
const providerSelect = () => target!.querySelector<HTMLSelectElement>('#provider')!;
const modelSelect = () => target!.querySelector<HTMLSelectElement>('#model')!;
const baseUrlInput = () => target!.querySelector<HTMLInputElement>('#baseurl')!;
const apiKeyInput = () => target!.querySelector<HTMLInputElement>('#apikey');

/** Drive a control the way a person does: set the value, let the browser fire the event. */
async function setValue(el: HTMLSelectElement | HTMLInputElement, value: string, type: string) {
	el.value = value;
	el.dispatchEvent(new Event(type, { bubbles: true }));
	await settle();
}

beforeEach(() => {
	get.mockReset();
	catalog.mockReset();
	update.mockReset();
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target?.remove();
	target = null;
});

describe('1 · the stored key belongs to the vendor it was issued to', () => {
	it('the starting point: the panel legitimately reports the OpenAI key', async () => {
		// The positive half. Without it, "never claim a key" passes everything below.
		await render(OPENAI_TENANT);
		expect(statusText()).toContain('llmset_apikey_set');
		expect(saveButton().disabled).toBe(false);
	});

	it('switching to ANOTHER key-requiring vendor drops the claim and blocks Save', async () => {
		await render(OPENAI_TENANT);
		await setValue(providerSelect(), 'anthropic', 'change');
		// ⛔ 'llmset_apikey_set' before the fix — "Key set ✓" for a vendor that has never had one.
		expect(statusText()).toContain('llmset_apikey_unset');
		expect(statusText()).not.toContain('llmset_apikey_set');
		// ⛔ false before the fix: the stale `hasKey` satisfied `canSave`'s key requirement, so the
		//    screen offered to save a config it knew no credential for.
		expect(saveButton().disabled).toBe(true);
		// …and the field to fix it is on screen, empty.
		expect(apiKeyInput()?.value).toBe('');
	});

	it('typing the NEW vendor’s key unblocks Save again', async () => {
		// The block is a prompt, not a dead end.
		await render(OPENAI_TENANT);
		await setValue(providerSelect(), 'anthropic', 'change');
		expect(saveButton().disabled).toBe(true);
		await setValue(apiKeyInput()!, 'sk-ant-brand-new', 'input');
		expect(saveButton().disabled).toBe(false);
	});

	it('switching to the KEYLESS local provider says "not needed", not "key set"', async () => {
		// The backend clears the ciphertext on this move (it is the one vendor change that can
		// succeed without a key), so a panel still reading "Key set ✓" would be describing a row
		// that no longer holds one.
		await render(OPENAI_TENANT);
		await setValue(providerSelect(), 'local', 'change');
		expect(statusText()).toContain('llmset_apikey_notneeded');
		expect(statusText()).not.toContain('llmset_apikey_set');
		expect(saveButton().disabled).toBe(false); // no key needed — nothing to block
	});

	it('a CUSTOM endpoint retyped at a different host drops the claim too', async () => {
		// ⛔ The control `applyPresetDefaults` never sees. On the `custom` preset the vendor is the
		// URL the user types, so editing it is a vendor switch made without touching the provider
		// dropdown — and the backend disowns the key for it just the same.
		await render({
			preset: 'custom',
			provider: 'openai_compatible',
			model: 'some-model',
			baseUrl: 'https://vendor-a.example/v1',
			hasKey: true
		});
		expect(statusText()).toContain('llmset_apikey_set');
		await setValue(baseUrlInput(), 'https://vendor-b.example/v1', 'input');
		expect(statusText()).toContain('llmset_apikey_unset');
		expect(saveButton().disabled).toBe(true);
	});
});

describe('2 · returning to the vendor the key belongs to', () => {
	it('switching away and back restores the claim — the key was never deleted', async () => {
		await render(OPENAI_TENANT);
		await setValue(providerSelect(), 'xai', 'change');
		expect(statusText()).toContain('llmset_apikey_unset');
		await setValue(providerSelect(), 'openai', 'change');
		expect(statusText()).toContain('llmset_apikey_set');
		expect(saveButton().disabled).toBe(false);
	});
});

describe('3 · THE OVER-CORRECTION GUARD — same-vendor edits keep the key', () => {
	it('changing only the MODEL keeps "Key set ✓" and keeps Save available', async () => {
		// ⛔ WITHOUT THIS CASE, "clear `hasKey` on every change" passes every assertion above and
		// makes the tenant re-enter their key to switch model.
		await render(OPENAI_TENANT);
		await setValue(modelSelect(), 'gpt-4.1', 'change');
		expect(statusText()).toContain('llmset_apikey_set');
		expect(saveButton().disabled).toBe(false);
	});

	it('changing only the TEMPERATURE keeps the key', async () => {
		await render(OPENAI_TENANT);
		await setValue(target!.querySelector<HTMLInputElement>('#temperature')!, '0.7', 'input');
		expect(statusText()).toContain('llmset_apikey_set');
		expect(saveButton().disabled).toBe(false);
	});
});

describe('4 · platform_only: bringing your own key is switched off', () => {
	// ⛔ The backend refuses a key from a platform_only (demo/trial) workspace with 403
	// `llm_byo_disabled` and ignores one stored earlier. Before this, the screen offered the key
	// field and Save as if the key would be used.
	it('the key field is disabled, the reason is shown, and a key-requiring vendor cannot be saved', async () => {
		await render({ ...OPENAI_TENANT, byoMode: 'platform_only' });
		expect(apiKeyInput()!.disabled).toBe(true);
		expect(target!.querySelector('.byo-locked')?.textContent).toBe('llmset_byo_locked');
		expect(saveButton().disabled).toBe(true);
		// The platform's own local model needs no key, so it stays saveable.
		await setValue(providerSelect(), 'local', 'change');
		expect(saveButton().disabled).toBe(false);
	});

	it('local_allowed: the same tenant keeps an editable key field and no lock note', async () => {
		await render({ ...OPENAI_TENANT, byoMode: 'local_allowed' });
		expect(apiKeyInput()!.disabled).toBe(false);
		expect(target!.querySelector('.byo-locked')).toBeNull();
		expect(saveButton().disabled).toBe(false);
	});
});
