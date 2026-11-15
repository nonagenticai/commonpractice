// @vitest-environment jsdom
//
// src/routes/(tenant)/delivery/delivery-page.fr-license.render.test.ts — the fr Gate-2 refusal on
// the screen, end to end, in Dutch.
//
// ⛔ WHY A SECOND RENDER SPEC BESIDE `delivery-page.test-result.render.test.ts` INSTEAD OF A CASE IN
// IT. That file mocks `$lib/paraglide/messages` so every key renders as its own NAME
// ("delivery_test_jira_ok:…"), which is exactly right for proving WHICH KEY a code selects and
// structurally incapable of proving WHAT THE READER SEES. The defect here is not key selection, it
// is that a Dutch tenant_admin read an English sentence — so this file mocks the catalog with the
// REAL nl.json VALUES and asserts on the prose. Two different questions, two different stubs.
//
// ⛔ THE PATH. `POST /api/delivery-targets/:id/test` catches the precheck's `HttpError` and answers
// **HTTP 200** `{ok:false, code, detail}` (backend/src/routes/delivery.ts:249-258). Nothing throws,
// so `errorText` — the app's one localization funnel — is never invoked; `+page.svelte:153` renders
// `connectionTestLabel(result, locale)` and, with no case for the code, that returned `detail`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DeliveryTarget } from '$lib/api/delivery';

// The REAL Dutch catalog, values not key names — see the header.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) => {
			let out = catalog[key]!;
			for (const [k, v] of Object.entries(params ?? {})) out = out.replaceAll(`{${k}}`, String(v));
			return out;
		};
	}
	return mod;
});

const { listFn, testFn } = vi.hoisted(() => ({ listFn: vi.fn(), testFn: vi.fn() }));

vi.mock('$lib/api/delivery', () => ({
	deliveryApi: {
		list: listFn,
		test: testFn,
		create: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		listForSolution: vi.fn(),
		forward: vi.fn(),
		retry: vi.fn()
	},
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';

const TARGET: DeliveryTarget = {
	id: 't-1',
	kind: 'fr',
	name: 'In-house fr',
	baseUrl: 'https://fr.example.com',
	projectKey: null,
	defaultItemType: null,
	config: {},
	enabled: true,
	hasCredentials: true,
	createdAt: '2026-08-14T09:00:00.000Z',
	updatedAt: '2026-08-14T09:00:00.000Z'
};

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle(until: () => boolean, tries = 40) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

async function pressTest(result: unknown) {
	listFn.mockResolvedValue([TARGET]);
	testFn.mockResolvedValue(result);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle(() => !!host.querySelector('.target-actions button'));

	const testBtn = [...host.querySelectorAll('.target-actions button')].find(
		(b) => b.textContent?.trim() === 'Testen'
	) as HTMLButtonElement | undefined;
	expect(testBtn, 'the Testen link is not on screen — this case tests nothing').toBeTruthy();
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
	listFn.mockReset();
	testFn.mockReset();
});

// The exact English `detail` the backend still sends alongside the code (fr-license.ts).
const ENGLISH = 'The fr license belongs to a different tenant';

describe('(tenant)/delivery — the fr Gate-2 refusal reaches a Dutch admin in Dutch', () => {
	it('⛔ THE DEFECT — fr_license_tenant_mismatch renders Dutch, and the English is GONE', async () => {
		const strip = await pressTest({
			ok: false,
			code: 'fr_license_tenant_mismatch',
			detail: ENGLISH
		});
		expect(strip.className).toContain('error');
		expect(strip.textContent).toBe(
			'De opgeslagen licentie hoort bij een andere werkruimte. Vervang die door de eigen fr-licentie van deze werkruimte.'
		);
		// ⛔ The half that pins the defect: before the fix the strip WAS the English sentence. Asserted
		// against the whole document, not just the strip, so it cannot hide in a title/tooltip.
		expect(host.textContent).not.toContain(ENGLISH);
		expect(host.textContent).not.toContain('fr license');
		// And never the bare machine token, which is what a missing catalog key would surface.
		expect(host.textContent).not.toContain('fr_license_tenant_mismatch');
	});

	it('⛔ the other three refusals each render their OWN sentence — four codes, four answers', async () => {
		const seen = new Set<string>();
		for (const [code, english] of [
			['fr_license_inactive', 'The tenant’s fr license is not active'],
			['fr_license_app_mismatch', 'The fr license is for app "commonpractice", not an fr-bridge app'],
			['fr_license_unavailable', 'The fr license could not be verified: HTTP 503']
		] as const) {
			const strip = await pressTest({ ok: false, code, detail: english });
			const text = strip.textContent ?? '';
			expect(text, code).not.toBe(english);
			expect(text.length, code).toBeGreaterThan(10);
			expect(text, `${code} carries an unreplaced placeholder`).not.toMatch(/[{}]/);
			// ⚠️ DISTINCTNESS IS THE WHOLE POINT OF MINTING FOUR CODES. If they collapsed to one
			// sentence the localization would be honest and the DIAGNOSIS would still be lost — which
			// is the defect one code already was.
			expect(seen.has(text), `${code} repeats a sentence already used`).toBe(false);
			seen.add(text);
			if (app) unmount(app);
			app = null;
			host.innerHTML = '';
		}
		expect(seen.size).toBe(3);
	});

	it('⚠️ MID-ROLL — an old pod`s `fr_license_required` still renders its English detail, not blank', async () => {
		// The documented fallback. The backend and this bundle do not deploy atomically.
		const strip = await pressTest({ ok: false, code: 'fr_license_required', detail: ENGLISH });
		expect(strip.textContent).toBe(ENGLISH);
	});
});
