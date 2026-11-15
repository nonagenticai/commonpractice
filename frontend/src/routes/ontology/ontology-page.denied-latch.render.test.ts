// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.denied-latch.render.test.ts — /ontology must not stay refused
// after the refusal is over.
//
// ⛔ THE DEFECT, MEASURED LIVE. `denied` is set true in two places (`load()` and `loadGraph()`) and
// set false in exactly none — `$state(false)` is the only thing that ever writes the other value, and
// that runs once, at mount. So a single 401/403 on the first load latched the page to
// "Je hebt geen toegang tot de ontologie." for the lifetime of the SPA session: the network came back,
// the role was restored, `load()` re-ran on a locale switch and SUCCEEDED — and the page still said
// no. Only F5 cleared it.
//
// Every sibling screen already resets the flag at the top of its load path (connectors:101,
// pipeline:48, sandboxes:116, it-dash:39, datasets:262, (tenant)/usage:134, sso:47, llm-settings:68,
// mcp-keys:30, delivery:55) — /ontology is the one that did not, and it is the one page in that list
// whose refusal is EXPECTED for ordinary members, so it latches most often.
//
// ⛔ WHAT IS ASSERTED IS THE RECOVERY, NOT THE RESET LINE. "the page renders the matrix after a
// successful second load" is a claim about behaviour; "the source contains `denied = false`" is a
// claim about a keystroke, and would pass with the assignment placed after the `catch` that sets it.
// So every case here drives the SECOND load for real and reads the DOM.
//
// ⚠️ THE SECOND LOAD IS FIRED THROUGH `reloadOnLocaleChange`, which is the exact live repro: a
// language switch is what re-ran `load()` on the session that was measured. The mock captures the
// callback instead of standing up the paraglide runtime — the same technique as
// `solutions/solutions-page.reachable.render.test.ts`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';

// Real `en` catalog, each key resolving to its own name.
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

// The locale-switch reload path, captured rather than driven — see the header note.
const { localeReload } = vi.hoisted(() => ({ localeReload: { fire: null as null | (() => void) } }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({
	reloadOnLocaleChange: (load: () => void) => {
		localeReload.fire = load;
	}
}));

/**
 * ⛔ ONE `ApiError` CLASS, hoisted. The page discriminates with `e instanceof ApiError`, so the
 * rejection value MUST be the class `$lib/api/ontology` exports here — a second class would make
 * that test false, send a 403 down the "real failure" branch, and this file would pass for the
 * wrong reason. `vi.mock` factories hoist above every top-level `const`, hence `vi.hoisted`.
 */
const { matrixFn, getOntology, recentChangesFn, FakeApiError } = vi.hoisted(() => ({
	matrixFn: vi.fn(),
	getOntology: vi.fn(),
	recentChangesFn: vi.fn(),
	FakeApiError: class FakeApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error'
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/ontology', () => ({
	ApiError: FakeApiError,
	ontologyApi: {
		matrix: matrixFn,
		get: getOntology,
		createEntity: vi.fn(),
		updateEntity: vi.fn(),
		deleteEntity: vi.fn(),
		createRelation: vi.fn(),
		deleteRelation: vi.fn(),
		hideEntity: vi.fn(),
		unhideEntity: vi.fn(),
		translations: vi.fn(),
		saveTranslations: vi.fn(),
		samples: vi.fn(),
		saveSample: vi.fn(),
		deleteSample: vi.fn(),
		recentChanges: recentChangesFn
	}
}));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { list: vi.fn().mockResolvedValue({ items: [] }), get: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

function matrix(): MatrixData {
	return {
		industries: ['Insurance'],
		departments: ['Claims'],
		cells: [{ industry: 'Insurance', department: 'Claims', hasSpecialization: true }],
		canManage: false
	} as MatrixData;
}

/** `entities: []` keeps the mount cheap — SvelteFlow is not what this file is about. */
function ontology(): CompiledOntology {
	return {
		industry: 'Insurance',
		department: 'Claims',
		entities: [],
		relations: [],
		hidden: [],
		canManage: false
	} as CompiledOntology;
}

/** An empty matrix — every axis absent, which is what an ontology-less workspace answers. */
function emptyMatrix(): MatrixData {
	return { industries: [], departments: [], cells: [], canManage: false } as MatrixData;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/** Re-run `load()` the way the live session did: a language switch. */
async function switchLocale() {
	expect(localeReload.fire, 'the page never registered a locale-reload handler').not.toBeNull();
	localeReload.fire!();
	await settle();
}

function healthy() {
	matrixFn.mockResolvedValue(matrix());
	getOntology.mockResolvedValue(ontology());
	recentChangesFn.mockResolvedValue({ items: [], unattributed: 0 });
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	localeReload.fire = null;
	recentChangesFn.mockResolvedValue({ items: [], unattributed: 0 });
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [matrixFn, getOntology, recentChangesFn]) fn.mockReset();
});

describe('/ontology recovers from a refusal instead of latching on it', () => {
	it('⛔ a 403 on the first load is cleared by a later successful load', async () => {
		// THE MEASURED DEFECT, end to end. Pre-fix, the second half of this test finds the refusal
		// sentence still on screen and the matrix nowhere.
		matrixFn.mockRejectedValueOnce(new FakeApiError(403, 'forbidden'));
		await render();
		// Non-vacuity: the refusal really rendered, so what follows is a RECOVERY and not a page that
		// never refused in the first place.
		expect(host.textContent, 'the 403 did not render as a refusal').toContain('ontology_denied');

		healthy();
		await switchLocale();

		expect(matrixFn, 'the second load never reached the API').toHaveBeenCalledTimes(2);
		expect(host.textContent, 'the refusal survived a successful reload — the latch').not.toContain('ontology_denied');
		// …and the content the reader came for is actually there. "The sentence is gone" alone is
		// satisfied by a blank page.
		expect(host.querySelector('.graph-col'), 'the page recovered into no content at all').not.toBeNull();
		expect(host.textContent).toContain('ontology_select_industry');
	});

	it('a 401 latches the same way and is cleared the same way', async () => {
		matrixFn.mockRejectedValueOnce(new FakeApiError(401, 'unauthorized'));
		await render();
		expect(host.textContent).toContain('ontology_denied');

		healthy();
		await switchLocale();
		expect(host.textContent).not.toContain('ontology_denied');
		expect(host.querySelector('.graph-col')).not.toBeNull();
	});

	it('⛔ a SECOND refusal still refuses — the reset is not an unconditional clear', async () => {
		// The complement, and the case a naive `denied = false` at the END of `load()` would break.
		// A reader who still has no access must still be told so.
		matrixFn.mockRejectedValue(new FakeApiError(403, 'forbidden'));
		await render();
		expect(host.textContent).toContain('ontology_denied');
		await switchLocale();
		expect(matrixFn).toHaveBeenCalledTimes(2);
		expect(host.textContent, 'a still-refused reader was shown the page anyway').toContain('ontology_denied');
	});

	it('⛔ a load error is cleared by a later successful load too', async () => {
		// `error` latches on the same path, and it is NOT covered by `loadGraph()`'s `error = null`:
		// that line sits AFTER `if (!industry || !department) return`, so a workspace with no matrix
		// cells never reaches it. A recovered load then renders the previous failure over content it
		// successfully fetched.
		matrixFn.mockRejectedValueOnce(new Error('Failed to fetch'));
		await render();
		expect(host.textContent, 'the 500 did not render as a load error').toContain('error_load_failed');

		matrixFn.mockResolvedValue(emptyMatrix());
		await switchLocale();
		expect(host.textContent, 'the load error survived a successful reload').not.toContain('error_load_failed');
	});

	it('⛔ a refusal from the GRAPH loader latches and recovers too — not just from load()', async () => {
		// `denied = true` is set in TWO places: `load()`'s catch and `loadGraph()`'s. Every case above
		// drives only the first. Without this one, deleting `loadGraph`'s `denied = true` — or its
		// matching reset — leaves the whole file green, because nothing exercises that entry point.
		// It is reachable in production: the matrix loads fine and the CELL fetch is what gets
		// refused, which is exactly what a per-cell scope grant looks like when it is missing.
		matrixFn.mockResolvedValue(matrix());
		recentChangesFn.mockResolvedValue({ items: [], unattributed: 0 });
		getOntology.mockRejectedValueOnce(new FakeApiError(403, 'forbidden'));
		await render();
		expect(host.textContent, 'a refused CELL fetch did not render as a refusal').toContain('ontology_denied');

		healthy();
		await switchLocale();
		expect(host.textContent, 'the graph loader latched its own refusal').not.toContain('ontology_denied');
		expect(host.querySelector('.graph-col'), 'recovered into no content at all').not.toBeNull();
	});

	it('⛔ the refusal offers an in-page way out, and it is the recovery', async () => {
		// The latch was only half the trap. The other half: this arm replaces the ENTIRE page,
		// chips included, so with no control in it the only exits were a locale switch or F5 —
		// neither of which a reader who was just granted access would think to perform. The button
		// re-runs `load()`, which clears both flags, so pressing it IS the recovery path.
		matrixFn.mockRejectedValueOnce(new FakeApiError(403, 'forbidden'));
		await render();
		expect(host.textContent).toContain('ontology_denied');

		const retry = host.querySelector('button.retry') as HTMLButtonElement | null;
		expect(retry, 'the refusal is a dead end — no control in the arm that replaced the page').not.toBeNull();
		expect(retry!.textContent).toContain('error_load_retry');

		healthy();
		retry!.click();
		await settle();

		expect(matrixFn, 'the retry control did not re-run the load').toHaveBeenCalledTimes(2);
		expect(host.textContent, 'the refusal survived its own retry control').not.toContain('ontology_denied');
		expect(host.querySelector('.graph-col'), 'the retry recovered into no content').not.toBeNull();
	});

	it('a refusal followed by a plain failure reports the failure, not the refusal', async () => {
		// Both flags reset together or the page tells two stories at once: `{#if denied}` wins the
		// chain, so a stale `denied` would hide a live `error` behind an access message that is no
		// longer true.
		matrixFn.mockRejectedValueOnce(new FakeApiError(403, 'forbidden'));
		await render();
		expect(host.textContent).toContain('ontology_denied');

		matrixFn.mockRejectedValueOnce(new Error('Failed to fetch'));
		await switchLocale();
		expect(host.textContent).not.toContain('ontology_denied');
		expect(host.textContent).toContain('error_load_failed');
	});
});
