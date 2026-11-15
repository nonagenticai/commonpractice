// @vitest-environment jsdom
//
// src/lib/layout/topbar-search.malformed-body.render.test.ts — a 200 the client cannot read must
// reach the SAME failure line as a 500.
//
// ⛔ THE DEFECT, AND WHY IT SURVIVED THE COMMIT THAT FIXED ITS SIBLINGS. `searchApi.query` ended
// with `return (await res.json()) as SearchResults` — a cast, not a check. `Topbar.svelte` then maps
// all three arrays inside a `$derived`:
//
//     const hits = $derived(results ? [...results.challenges.map(…), …] : []);
//
// so a 200 carrying `{ q: 'schade' }` throws `TypeError: Cannot read properties of undefined
// (reading 'map')` — inside the reactive re-render, NOT inside `runSearch`'s try. It therefore never
// reaches the catch, never sets `searchDenied`, and lands after the `finally` that would have
// cleared `loading`: the dropdown FREEZES on "Zoeken…" and stays frozen. A `null` body takes a
// different route to the same place — `results` is falsy, so the panel renders empty.
//
// Both are the same species as the bug this file's sibling
// (topbar-search.failure.render.test.ts) removed: the topbar answering a search it could not
// perform with something that is not "it failed". That one is chrome on all 24 screens, which is
// what makes a permanently frozen search box expensive rather than cosmetic.
//
// ⚠️ THIS FILE MOUNTS THE REAL `searchApi` AND MOCKS ONLY `authFetch`. Its sibling mocks
// `$lib/api/search` outright, which is right for testing the component's branches and is exactly
// why it could not see this: the defect lives in the seam BETWEEN the client and the component —
// the client promising a shape it never checked, and the component dying on the difference. Only a
// test that owns the wire bytes can reach it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

// The real `nl` catalog, interpolated — the three sentences under test are three different strings
// in it, and the reader this product is built for reads that one.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(catalog)) {
		if (key === '$schema') continue;
		if (typeof value !== 'string') {
			mod[key] = () => `[plural:${key}]`;
			continue;
		}
		mod[key] = (params?: Record<string, unknown>) =>
			value.replace(/\{(\w+)\}/g, (whole, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});

const { authFetch, goto } = vi.hoisted(() => ({ authFetch: vi.fn(), goto: vi.fn() }));
// ⛔ THE ONLY SEAM MOCKED. `$lib/api/search` is deliberately REAL here.
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));
vi.mock('$app/navigation', () => ({ goto }));
// The bell polls its own endpoint from `onMount`; not this file's subject.
vi.mock('$lib/layout/NotificationBell.svelte', () => ({ default: function Noop() {} }));

import Topbar from './Topbar.svelte';

/** Straight out of `messages/nl.json` — asserted, not paraphrased. */
const NL = {
	failed: 'Laden mislukt. Probeer het opnieuw.',
	noResults: 'Geen resultaten voor “schade”',
	searching: 'Zoeken…'
};

/** A 200 whose JSON body is exactly `body`. `text()` is present because the client reads it on the
 *  NOT-ok path; these are all ok, so it is never called. */
function ok(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body)
	} as unknown as Response;
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

async function search(term: string) {
	const input = host.querySelector('input[role="combobox"]') as HTMLInputElement;
	expect(input, 'the topbar never rendered its search box').not.toBeNull();
	input.value = term;
	// `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	// ⚠️ FAKE TIMERS ARE MANDATORY: `runSearch` schedules the request inside `setTimeout(…, 200)`, so
	// a test that only awaits microtasks observes the component still `loading` and reads "Zoeken…"
	// for the WRONG reason — which is the exact string this file's defect case is about.
	await vi.advanceTimersByTimeAsync(250);
	for (let i = 0; i < 12; i++) await Promise.resolve();
	flushSync();
}

const dropdown = () => host.querySelector('#topbar-search-results');
const dropdownText = () => dropdown()?.textContent ?? '';

/** ⛔ THE POSITIVE MARKER. Without it "the frozen box is absent" passes against a dead DOM. */
function assertDropdownOpen() {
	expect(authFetch, 'the search request was never issued').toHaveBeenCalled();
	expect(dropdown(), 'the results dropdown never opened').not.toBeNull();
}

beforeEach(() => {
	vi.useFakeTimers();
	authFetch.mockReset();
	goto.mockReset();
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Topbar, { target: host }) as Record<string, unknown>;
	flushSync();
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	vi.useRealTimers();
});

describe('a 200 with an unreadable body is a failure, not an answer', () => {
	it('the three sentences really are different, and none contains another', () => {
		const all = [NL.failed, NL.noResults, NL.searching];
		for (const a of all)
			for (const b of all)
				if (a !== b) expect(a.includes(b), `"${a}" must not contain "${b}"`).toBe(false);
	});

	it('⛔ PROBE 1 — `{ q: "schade" }`, the arrays missing: the box says it failed, and is NOT frozen', async () => {
		// RED AGAINST `return (await res.json()) as SearchResults`: `hits`' `$derived` throws inside
		// the re-render, `loading` is never cleared, and the dropdown sticks on "Zoeken…".
		authFetch.mockResolvedValue(ok({ q: 'schade' }));
		await search('schade');
		assertDropdownOpen();

		expect(dropdownText()).toContain(NL.failed);
		expect(dropdownText(), 'the dropdown froze on its loading state').not.toContain(NL.searching);
		expect(dropdownText()).not.toContain(NL.noResults);
	});

	it('⛔ PROBE 2 — a `null` body: the same failure line, not a blank panel', async () => {
		// RED differently from probe 1: `results = null` is falsy, so nothing throws and the panel
		// renders with no message at all — an empty box that says nothing about why.
		authFetch.mockResolvedValue(ok(null));
		await search('schade');
		assertDropdownOpen();

		expect(dropdownText()).toContain(NL.failed);
		expect(dropdownText().trim(), 'the dropdown rendered nothing at all').not.toBe('');
		expect(dropdownText()).not.toContain(NL.searching);
	});

	it('a well-formed envelope with ONE malformed hit is also a failure, not a shortened list', async () => {
		// ⛔ THE DELIBERATE SPLIT FROM `data-findings.ts:63` / `graph-issues.ts:69`, which drop bad
		// entries and keep the rest. A findings list missing a row is still a findings list; a SEARCH
		// result is a claim about what the workspace contains, and silently dropping a hit converts
		// "we could not read the answer" into "there is no such thing" — the lie the whole
		// `searchDenied` change exists to stop telling.
		authFetch.mockResolvedValue(
			ok({ q: 'schade', challenges: [{ id: 'c1' }], solutions: [], blocks: [] })
		);
		await search('schade');
		assertDropdownOpen();

		expect(dropdownText()).toContain(NL.failed);
		expect(dropdownText()).not.toContain(NL.noResults);
	});

	it('⛔ THE OVER-CORRECTION GUARD: a WELL-FORMED body still renders its hits', async () => {
		// Without this, a guard that rejected everything would pass every case above. This is also the
		// proof that the harness reaches the real success branch through the real client.
		authFetch.mockResolvedValue(
			ok({
				q: 'schade',
				challenges: [{ id: 'c1', title: 'Schadeclaim sneller afhandelen', code: null }],
				solutions: [],
				blocks: [{ slug: 'read-claim-form', name: 'Claimformulier lezen' }]
			})
		);
		await search('schade');
		assertDropdownOpen();

		expect(dropdown()?.querySelectorAll('button.result')).toHaveLength(2);
		expect(dropdownText()).toContain('Schadeclaim sneller afhandelen');
		expect(dropdownText()).toContain('Claimformulier lezen');
		expect(dropdownText()).not.toContain(NL.failed);
	});

	it('a genuinely EMPTY well-formed body still says "Geen resultaten", not "it failed"', async () => {
		// The other half of the over-correction guard: empty arrays are a valid, common answer and
		// must not be swept into the failure branch by a guard that confuses "empty" with "absent".
		authFetch.mockResolvedValue(ok({ q: 'schade', challenges: [], solutions: [], blocks: [] }));
		await search('schade');
		assertDropdownOpen();

		expect(dropdownText()).toContain(NL.noResults);
		expect(dropdownText()).not.toContain(NL.failed);
	});
});
