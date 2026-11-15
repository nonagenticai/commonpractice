// @vitest-environment jsdom
//
// src/lib/layout/topbar-search.failure.render.test.ts — what the GLOBAL search says when it could
// not search.
//
// ⛔ THE DEFECT: "GEEN RESULTATEN VOOR “SCHADE”" WHEN THE SEARCH ENDPOINT IS 500-ING.
//
// The catch did two things:
//
//     searchDenied = licenseOrPermissionMessage(e);
//     results = { q: trimmed, challenges: [], solutions: [], blocks: [] };
//
// `licenseOrPermissionMessage` returns a string ONLY for a 402, a 403, a `seat_limit_reached` 409
// or a NAMED 503, and `null` for everything else — deliberately, and documented as such at
// api/error-message.ts:1361-1370. So for a 500, a dead backend, a DNS failure or an offline laptop
// `searchDenied` stayed `null`, the fabricated empty result set was truthy, and the markup fell past
// `{:else if searchDenied}` into `{:else if results && !hasResults}` → `m.search_no_results({ q })`.
//
// The topbar is chrome: it is on all 24 screens and the reader cannot navigate away from it. So the
// product answered a question it had not asked anyone — "does this workspace contain 'schade'?" —
// with a confident, wrong "no". A reader who has just filed a claim under that word concludes their
// work is gone. That is strictly worse than the 403-shown-as-no-results case the `searchDenied`
// state was introduced for; it is the same bug with a wider blast radius.
//
// ⚠️ THE FIX IS NOT "ALWAYS SHOUT". The in-file comment that argued for the old behaviour — "a
// network blip should not shout at the user" — is right about tone and wrong about facts, and the
// distinction is what the four cases below pin. The failure renders in the SAME quiet `.search-msg`
// line the dropdown already uses for "Zoeken…"; the honest empty answer keeps saying "Geen
// resultaten"; and a licence/permission refusal keeps its own specific copy rather than being
// flattened into the generic sentence.
//
// ⛔ ANTI-VACUITY. Every case asserts a POSITIVE marker (the dropdown is open, and the specific
// sentence expected is present) alongside the negative one. "The lie is absent" is satisfied by a
// component that crashed on mount and rendered nothing at all, so no case is allowed to consist of
// `not.toContain` alone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

// The real `nl` catalog, interpolated — this file is about what a DUTCH reader is told, and the
// three sentences under test are three different strings in that catalog. Same shape as
// notification-bell.load-failure.render.test.ts, which pins the same bug class one component over.
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

const { query, goto } = vi.hoisted(() => ({ query: vi.fn(), goto: vi.fn() }));
// ⛔ ALIAS module ids, never relative ones — a relative mock id resolves to a different module
// record than the one the component imports and silently does nothing.
vi.mock('$lib/api/search', () => ({ searchApi: { query } }));
vi.mock('$app/navigation', () => ({ goto }));
// The bell polls `/api/notifications/unread-count` from its own `onMount`; it is not this file's
// subject and its unmocked fetch would be the loudest thing in the run.
vi.mock('$lib/layout/NotificationBell.svelte', async () => {
	const { createRawSnippet, mount: m2 } = await import('svelte');
	void createRawSnippet;
	void m2;
	return { default: function Noop() {} };
});

import Topbar from './Topbar.svelte';

/**
 * The real `ApiError` shape `searchApi.query` throws (api/search.ts:38-45) — a class with a numeric
 * `status` and a string `code`, which is what `statusOf`/`codeOf` read.
 *
 * ⚠️ Constructed here rather than imported so the 500 case cannot accidentally be satisfied by some
 * other module's notion of an error. The three cases below differ ONLY in `status`/`code`, which is
 * the whole point: the same throw site produces all three.
 */
class ApiError extends Error {
	constructor(
		public status: number,
		public code = 'error',
		message = 'error'
	) {
		super(message);
	}
}

/** Straight out of `messages/nl.json` — asserted, not paraphrased. */
const NL = {
	/** The LIE: `search_no_results` with q interpolated. */
	noResults: 'Geen resultaten voor “schade”',
	/** The generic failure sentence `errorText` falls back to. */
	failed: 'Laden mislukt. Probeer het opnieuw.',
	/** The permission copy `licenseOrPermissionMessage` owns and must keep owning. */
	forbidden: 'Je hebt geen toestemming om dat te doen.',
	searching: 'Zoeken…'
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

/**
 * Type into the search box and let the 200 ms debounce fire.
 *
 * ⚠️ FAKE TIMERS ARE MANDATORY HERE, not a speed-up: `runSearch` schedules the request inside
 * `setTimeout(…, 200)`, so a test that only awaits microtasks observes the component in its
 * `loading` state forever and every assertion below reads "Zoeken…".
 */
async function search(term: string) {
	const input = host.querySelector('input[role="combobox"]') as HTMLInputElement;
	expect(input, 'the topbar never rendered its search box').not.toBeNull();
	input.value = term;
	// `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	await vi.advanceTimersByTimeAsync(250);
	for (let i = 0; i < 12; i++) await Promise.resolve();
	flushSync();
}

/** A real Enter on the focused search box. `bubbles: true` — Svelte 5 delegates to the mount root;
 *  `focus()` because `onKeydown`'s first branch gates on `document.activeElement === inputEl`. */
function pressEnter() {
	const input = host.querySelector('input[role="combobox"]') as HTMLInputElement;
	input.focus();
	input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	flushSync();
}

function dropdown(): HTMLElement | null {
	return host.querySelector('#topbar-search-results');
}
function dropdownText(): string {
	return dropdown()?.textContent ?? '';
}

/**
 * ⛔ THE POSITIVE MARKER, asserted by every case before anything else. The results panel lives
 * behind `{#if open}`; if the component never opened it, the panel holds neither the lie nor the
 * failure line and a bare `not.toContain` would pass against a dead DOM.
 */
function assertDropdownOpen() {
	expect(query, 'the search API was never called').toHaveBeenCalled();
	expect(dropdown(), 'the results dropdown never opened').not.toBeNull();
	expect(dropdownText(), 'still in the loading branch').not.toContain(NL.searching);
}

beforeEach(() => {
	vi.useFakeTimers();
	query.mockReset();
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

describe('the global search reports a failure as a failure', () => {
	it('the three sentences really are different, and none contains another', () => {
		// ⛔ NOT A FORMALITY. Every case below is "sentence A is present AND sentence B is absent";
		// if two of them overlapped, one half could be satisfied by the other's text.
		const all = [NL.noResults, NL.failed, NL.forbidden];
		for (const a of all)
			for (const b of all)
				if (a !== b) expect(a.includes(b), `"${a}" must not contain "${b}"`).toBe(false);
	});

	it('⛔ THE DEFECT: a 500 says the search failed — NOT "Geen resultaten voor “schade”"', async () => {
		// RED AGAINST THE ORIGINAL CATCH (`searchDenied = licenseOrPermissionMessage(e)` +
		// `results = { q, challenges: [], solutions: [], blocks: [] }`): `licenseOrPermissionMessage`
		// returns null for a 500, so the two assertions below invert exactly.
		query.mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
		await search('schade');
		assertDropdownOpen();

		expect(dropdownText()).toContain(NL.failed);
		expect(
			dropdownText(),
			'the topbar told the reader their workspace holds no “schade”, having never found out'
		).not.toContain(NL.noResults);
	});

	it('⛔ …and it does so for a plain network throw too, which carries no status at all', async () => {
		// `statusOf` returns `undefined` for a bare Error, which took the same `null` path. This is
		// the literal "network blip" the old comment was written about — and the fix's answer to it is
		// a quiet true sentence, not a loud one and not a false one.
		query.mockRejectedValue(new TypeError('Failed to fetch'));
		await search('schade');
		assertDropdownOpen();

		expect(dropdownText()).toContain(NL.failed);
		expect(dropdownText()).not.toContain(NL.noResults);
	});

	it('the failure is announced, not swapped in silently', async () => {
		query.mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
		await search('schade');
		assertDropdownOpen();
		expect(dropdown()?.querySelector('[role="alert"]')?.textContent).toBe(NL.failed);
	});

	it('a 403 keeps its OWN copy — the generic sentence must not flatten the specific one', async () => {
		// ⛔ THE REGRESSION GUARD ON THE HALF THAT ALREADY WORKED. `errorText` is
		// `licenseOrPermissionMessage(e) ?? fallback`, so the permission copy still wins. A fix that
		// replaced the call outright with `m.error_load_failed()` would pass every case above and
		// silently undo the reason `searchDenied` exists.
		query.mockRejectedValue(new ApiError(403, 'forbidden', 'nope'));
		await search('schade');
		assertDropdownOpen();

		expect(dropdownText()).toContain(NL.forbidden);
		expect(dropdownText()).not.toContain(NL.failed);
		expect(dropdownText()).not.toContain(NL.noResults);
	});

	it('⛔ THE COMPLEMENT: a genuinely empty answer STILL says "Geen resultaten"', async () => {
		// The reason the fix is "stop fabricating a result set" rather than "delete the no-results
		// branch". An empty search is a real, common, correct outcome and must keep saying so; a fix
		// that reported a failure for every fruitless search would be a worse bug than this one.
		query.mockResolvedValue({ q: 'schade', challenges: [], solutions: [], blocks: [] });
		await search('schade');
		assertDropdownOpen();

		expect(dropdownText()).toContain(NL.noResults);
		expect(dropdownText()).not.toContain(NL.failed);
	});

	it('a successful search with hits renders the hits, and no message line at all', async () => {
		// The second complement, and the proof that `assertDropdownOpen` is not the only thing the
		// other cases measured: the same harness reaches the real results branch.
		query.mockResolvedValue({
			q: 'schade',
			challenges: [{ id: 'c1', title: 'Schadeclaim sneller afhandelen', code: 'CH-1' }],
			solutions: [],
			blocks: []
		});
		await search('schade');
		assertDropdownOpen();

		expect(dropdown()?.querySelectorAll('button.result')).toHaveLength(1);
		expect(dropdownText()).toContain('Schadeclaim sneller afhandelen');
		expect(dropdownText()).not.toContain(NL.failed);
		expect(dropdownText()).not.toContain(NL.noResults);
	});

	it('a successful search DOES commit its top hit on Enter — the harness can navigate', async () => {
		// ⛔ THE POSITIVE CONTROL FOR THE CASE BELOW. Its assertion is `goto` was NOT called, which is
		// satisfied by a harness whose synthetic Enter never reaches `onKeydown` at all.
		query.mockResolvedValue({
			q: 'schade',
			challenges: [{ id: 'c1', title: 'Schadeclaim sneller afhandelen', code: null }],
			solutions: [],
			blocks: []
		});
		await search('schade');
		assertDropdownOpen();
		pressEnter();
		expect(goto).toHaveBeenCalledWith('/challenges/c1');
	});

	it('⛔ a failure clears the STALE hits — Enter must not open a result for the previous query', async () => {
		// ⛔ THIS IS THE ONLY OBSERVABLE `results = null` HAS, and the comment beside that line says so.
		// It is NOT distinguishable from the fabricated empty result set it replaced — `searchDenied`
		// is checked first in the markup, so both render identically. It IS distinguishable from
		// DELETING the line, which is what this case reds on: `results` would keep the previous
		// SUCCESSFUL payload, `hits` would stay non-empty behind a box that says the search failed,
		// and Enter would navigate to a hit for a query the reader has already typed past.
		query.mockResolvedValue({
			q: 'schade',
			challenges: [{ id: 'c1', title: 'Schadeclaim sneller afhandelen', code: null }],
			solutions: [],
			blocks: []
		});
		await search('schade');
		expect(dropdown()?.querySelectorAll('button.result')).toHaveLength(1);

		query.mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
		await search('schadeloosstelling');
		assertDropdownOpen();
		expect(dropdownText()).toContain(NL.failed);

		pressEnter();
		expect(
			goto,
			'Enter opened a hit from the previous query while the box said the search had failed'
		).not.toHaveBeenCalled();
	});

	it('a later SUCCESS clears the failure — the message is about the last attempt, not sticky', async () => {
		// `searchDenied = null` in the try branch. Without it the box would keep apologising for a
		// blip that is over, which is the mirror-image dishonesty.
		query.mockRejectedValueOnce(new ApiError(500, 'internal_error', 'boom'));
		await search('schade');
		expect(dropdownText()).toContain(NL.failed);

		query.mockResolvedValue({
			q: 'schadel',
			challenges: [{ id: 'c1', title: 'Schadeclaim sneller afhandelen', code: null }],
			solutions: [],
			blocks: []
		});
		await search('schadel');
		assertDropdownOpen();

		expect(dropdownText()).toContain('Schadeclaim sneller afhandelen');
		expect(dropdownText()).not.toContain(NL.failed);
	});
});
