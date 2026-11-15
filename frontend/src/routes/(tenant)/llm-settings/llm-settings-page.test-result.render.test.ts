// @vitest-environment jsdom
//
// src/routes/(tenant)/llm-settings/llm-settings-page.test-result.render.test.ts — the strip under
// the **Testen** button on the tenant LLM settings screen.
//
// ⛔ THE DEFECT. `<div class="test-result …">{testResult.detail}</div>`. `POST
// /api/llm-settings/test` answers **HTTP 200** on every reachable outcome (a missing key, a model
// the provider does not offer, a live 401 from the vendor), so nothing throws and `errorText` never
// runs — the same 200-OK blind spot as /connectors and (tenant)/delivery. Every one of those
// sentences was English, success included ("anthropic · claude-sonnet-4").
//
// ⛔⛔ AND THE MACHINE FACTS WERE ALREADY ON THE WIRE. This response has carried top-level
// `provider` and `model` fields for as long as it has existed, and the screen still rendered the
// server's hand-joined `${providerKind} · ${model}` string. Nothing needed to be discovered to fix
// this — only used.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

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

const { getFn, catalogFn, testFn } = vi.hoisted(() => ({
	getFn: vi.fn(),
	catalogFn: vi.fn(),
	testFn: vi.fn()
}));

// ⚠️ `get` / `catalog` / `update` / `test` are the four real `llmSettingsApi` methods — verified
// against the client, not guessed (see the note in the /connectors spec about `saveMapping`).
vi.mock('$lib/api/llm-settings', () => ({
	llmSettingsApi: { get: getFn, catalog: catalogFn, update: vi.fn(), test: testFn },
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle(until: () => boolean, tries = 40) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

/** Load the page, press **Testen**, with `llmSettingsApi.test` answering `result`. */
async function pressTest(result: unknown) {
	catalogFn.mockResolvedValue({
		providers: [
			{
				key: 'anthropic',
				label: 'Anthropic',
				defaultBaseUrl: null,
				requiresKey: true,
				models: ['claude-sonnet-4']
			}
		]
	});
	getFn.mockResolvedValue({
		configured: true,
		provider: 'anthropic',
		model: 'claude-sonnet-4',
		baseUrl: null,
		preset: 'anthropic',
		temperature: 0.1,
		params: null,
		hasKey: true,
		budget: null
	});
	testFn.mockResolvedValue(result);

	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle(() => !!host.querySelector('.actions button.btn-ghost'));

	const testBtn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'llmset_test'
	) as HTMLButtonElement | undefined;
	expect(testBtn, 'the Test button is not on screen — this case tests nothing').toBeTruthy();
	testBtn!.click();
	await settle(() => !!host.querySelector('.test-result'));

	const strip = host.querySelector('.test-result');
	expect(strip, 'no test-result strip rendered — this case tests nothing').not.toBeNull();
	return strip!;
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [getFn, catalogFn, testFn]) fn.mockReset();
});

describe('(tenant)/llm-settings renders the test result from its CODE', () => {
	it('⛔ THE SUCCESS PATH — HTTP 200, ok:true, and the strip is the reader’s sentence', async () => {
		const strip = await pressTest({
			ok: true,
			provider: 'anthropic',
			model: 'claude-sonnet-4',
			code: 'llm_test_ok',
			params: { provider: 'anthropic', model: 'claude-sonnet-4' },
			detail: 'anthropic · claude-sonnet-4'
		});
		expect(strip.className).toContain('ok');
		// The identifiers are bidi-isolated (U+2068/U+2069) — they are vendor-supplied strings that
		// may mix scripts, and this sentence renders inside RTL copy for two of the eight locales.
		expect(strip.textContent).toBe('llm_test_ok:⁨anthropic⁩,⁨claude-sonnet-4⁩');
		expect(host.textContent).not.toContain('anthropic · claude-sonnet-4');
	});

	it('⛔ "no API key" is a localized sentence, not the server’s advice in English', async () => {
		const strip = await pressTest({
			ok: false,
			code: 'llm_test_no_api_key',
			detail: 'No API key for this provider — add one (or save) to test.'
		});
		expect(strip.className).toContain('error');
		expect(strip.textContent).toBe('llm_test_no_api_key');
		expect(host.textContent).not.toContain('No API key for this provider');
	});

	it('⛔ a live vendor failure keeps its raw text inside a localized frame', async () => {
		const strip = await pressTest({
			ok: false,
			code: 'llm_test_failed',
			params: { detail: '401 invalid_api_key' },
			detail: '401 invalid_api_key'
		});
		expect(strip.textContent).toContain('llm_test_failed');
		expect(strip.textContent).toContain('401 invalid_api_key');
	});

	it('⛔ MID-ROLL — an old pod sending only `detail` still renders it, never blank', async () => {
		const strip = await pressTest({ ok: true, detail: 'anthropic · claude-sonnet-4' });
		expect(strip.textContent).toBe('anthropic · claude-sonnet-4');
	});
});
