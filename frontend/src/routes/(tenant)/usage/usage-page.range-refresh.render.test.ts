// @vitest-environment jsdom
//
// src/routes/(tenant)/usage/usage-page.range-refresh.render.test.ts — clicking a range on /usage
// must not tear the BODY of the page down, and a slow response must not land under the wrong chip.
//
// ⛔ FOUR DEFECTS ON ONE SCREEN, ALL FOUR ON THE HAPPY PATH OF AN ORDINARY CLICK.
//
//   1. `setRange()` → `load()` → `loading = true`, and the template's third branch was a bare
//      `{:else if loading}`. `data` is never cleared — the four stat cards, the by-model bars, the
//      calls/day sparkline and the by-member table were all still in memory — the chain simply
//      refused to render them. So every range click blanked the body of the one page a tenant admin
//      reads to decide what they are spending, with no error anywhere.
//
//      ⚠️ THE BODY, NOT THE PAGE. The header, the three range chips and the Export button live
//      OUTSIDE the `{#if}` chain and always survived. A reviewer told "the chips vanish" would look
//      at a correct screen and conclude the fix had not landed.
//
//   2. `{:else if loadError}` — the same branch, one along: a failed REFRESH destroyed the loaded
//      numbers in order to announce that a refresh had failed.
//
//   3. `{#if denied}` — a session expiring during a range click replaced the stats, the bars and
//      the table with one sentence. On this page the chips are outside the chain and survive even
//      that; the body does not, and the body is the reason the reader is here.
//
//   4. ⛔ AND THE ONE WITH NO FAILURE IN IT AT ALL. `load()` took no ticket and assigned
//      `data = await …` unconditionally. Click 7 while 30 is out, or 90 while 7 is out, and the
//      page renders whichever response lands LAST — 90-day figures under a 7-day chip, or the
//      reverse. Nothing errors, nothing spins, and nothing on screen can say which range the
//      numbers belong to. That is the defect `reqSeq` + `loadedRange` exist for.
//
// ⛔ THE ANTI-VACUITY RULE THIS FILE IS BUILT ON. Every case asserts the POSITIVE half — the rows
// are there, by name, and the figure is there, as text — not merely that `admin_loading` is absent.
// An assertion that only says "the blank did not happen" is satisfied by a page that never rendered
// anything, which is the exact failure mode this repo keeps hitting.
//
// ⚠️ HARNESS REUSED VERBATIM from `usage-page.locale-numbers.render.test.ts` (jsdom pragma, real-`en`
// message mock, `vi.hoisted` `{currentTenant, usage}`, `$lib/api/admin` alias mock). The one
// addition is `deferred()`, which is MANDATORY here: `mockResolvedValue` resolves on the next
// microtask, so two requests issued in the same tick can never be observed OVERLAPPING and the
// branch under test in section 3 is unreachable — every assertion about it would pass for the wrong
// reason. This is spelled out at `audit-page.refresh-failure.render.test.ts:124-136`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { TenantUsage } from '$lib/types/admin';
import { locale } from '$lib/stores/locale.svelte';

// Message stub built from the real `en` catalog: every key resolves to its own name (+ its
// arguments when it takes any), so nothing here asserts on wording and a key the page invents but
// never adds fails loudly as "undefined is not a function".
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

// ⛔ `ApiError` IS DECLARED IN `vi.hoisted` so the cases below can throw the VERY SAME CLASS the
// page tests against. Two lookalike classes make `e instanceof ApiError` false and silently reroute
// a 401 into the generic branch — the case would then pass while proving the opposite.
const { currentTenant, usage, ApiErrorMock } = vi.hoisted(() => ({
	currentTenant: vi.fn(),
	usage: vi.fn(),
	ApiErrorMock: class ApiError extends Error {
		constructor(
			readonly status: number,
			readonly code = 'error',
			message = 'error'
		) {
			super(message);
		}
	}
}));
// ⛔ ALIAS module ids, never relative ones — a relative mock id resolves to a different module
// record than the one the page imports and silently does nothing.
vi.mock('$lib/api/admin', () => ({
	adminApi: { currentTenant, usage },
	ApiError: ApiErrorMock
}));
vi.mock('$lib/api/error-message', () => ({ errorText: (_e: unknown, f: string) => f }));

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;
const realRect = Element.prototype.getBoundingClientRect;

/**
 * A promise this test resolves by hand — see the file header. Without it the two requests of
 * section 3 can never be in flight simultaneously.
 */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * ⛔ THE FIGURES ARE CHOSEN SO THAT NO TWO OF THEM SHARE A DIGIT.
 *
 * `MOUNT` (555555 / "Ada Lovelace"), `SEVEN` (4444 / "Grace Hopper") and `NINETY` (8888 /
 * "Katherine Johnson") are pairwise digit-disjoint, so no formatting coincidence — a thousands
 * separator, a truncation, a rounded spend — can let an assertion about one be satisfied by the
 * other. Section 3 depends on this completely: it asserts the 90-day figure is on screen AND the
 * 7-day figure is not, and overlapping digits would make the second half meaningless.
 */
const MOUNT = { days: 30, calls: 555555, text: '555,555', member: 'Ada Lovelace' };
const SEVEN = { days: 7, calls: 4444, text: '4,444', member: 'Grace Hopper' };
const NINETY = { days: 90, calls: 8888, text: '8,888', member: 'Katherine Johnson' };

function payload(f: { days: number; calls: number; member: string }): TenantUsage {
	return {
		rangeDays: f.days,
		stats: {
			spendUsd: 12.5,
			calls: f.calls,
			models: 2,
			members: 1,
			// No flat and no legacy rows → `estimated` is false and the "legacy pricing" notice stays
			// off. Neither is what this file is about.
			pricing: { provider: 3, table: 0, flat: 0, legacy: 0 }
		},
		byModel: [{ model: `gpt-${f.calls}`, provider: 'openai', calls: f.calls, spendUsd: 9, estimated: false }],
		// Two buckets: `dayPoints` needs ≥ 2 to render a polyline at all.
		byDay: [
			{ day: '2026-08-07T00:00:00.000Z', calls: f.calls, spendUsd: 6.0 },
			{ day: '2026-08-08T00:00:00.000Z', calls: 400, spendUsd: 6.5 }
		],
		byMember: [{ userId: 'u-1', name: f.member, calls: f.calls, spendUsd: 12.5 }]
	};
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	currentTenant.mockResolvedValue({ tenant: { id: 't-1', name: 'Acme', slug: 'acme' } });
	// ⚠️ PINNED TO `en` so the asserted strings ('555,555') are a fact about the fixture rather than
	// about whatever locale this runtime happens to boot in. Assigned directly, never through
	// `locale.set()`: that method fires an authFetch PATCH to /api/me/locale, which the fail-loud
	// fetch stub in lib/test/setup.ts would name.
	locale.current = 'en';
	// jsdom lays nothing out, so every rect is 0×0. The sparkline hover is not driven here, but the
	// same stub keeps the chart from being the reason a case fails.
	Element.prototype.getBoundingClientRect = function () {
		return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0 } as DOMRect;
	};
});
afterEach(() => {
	Element.prototype.getBoundingClientRect = realRect;
	if (app) unmount(app);
	app = undefined;
	host.remove();
	locale.current = initialLocale;
	vi.clearAllMocks();
	// ⛔ `clearAllMocks` DOES NOT DRAIN A `…Once` QUEUE. Every case here arms `usage` with
	// `mockResolvedValueOnce` / `mockReturnValueOnce` / `mockRejectedValueOnce`; if a case fails
	// before consuming one — which is exactly what happens while measuring a revert — the leftover
	// leaks into the NEXT case and reds it too. That turns a one-line mutation into a six-test
	// cascade and hides which assertion actually caught the regression. `mockReset` drains the
	// queue; `currentTenant` is re-armed in `beforeEach` and `usage` is armed per case, so nothing
	// depends on an implementation surviving.
	usage.mockReset();
	currentTenant.mockReset();
});

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount with the 30-day payload already resolving, and refuse to proceed until it is on screen. */
async function mountLoaded() {
	usage.mockResolvedValueOnce(payload(MOUNT));
	const { default: UsagePage } = await import('./+page.svelte');
	app = mount(UsagePage, { target: host, props: {} }) as Record<string, unknown>;
	await settle();
	// ⛔ THE ANTI-VACUITY GATE. Every case below is about what SURVIVES a second request; if the
	// first payload never rendered there is nothing to survive and each of them would pass empty.
	expect(host.textContent, 'the page never left its loading state').not.toContain('admin_loading');
	assertBody(MOUNT, 'the first payload never rendered — nothing below would prove anything');
	expect(usage).toHaveBeenCalledTimes(1);
}

/** A range chip, by the label key the message stub renders for it. */
function chip(days: 7 | 30 | 90): HTMLButtonElement {
	const btn = [...host.querySelectorAll('.ranges button')].find(
		(b) => b.textContent?.trim() === `admin_usage_range_${days}`
	) as HTMLButtonElement | undefined;
	expect(btn, `the ${days}-day chip did not render`).toBeDefined();
	return btn!;
}

/**
 * Click a range chip WITHOUT waiting for its request — section 3 needs it left in flight.
 * ⛔ `bubbles: true` — Svelte 5 DELEGATES DOM events to the mount root, so a non-bubbling synthetic
 * click silently skips the handler and every assertion below passes for free.
 */
function clickRange(days: 7 | 30 | 90) {
	const btn = chip(days);
	expect(btn.disabled, `the ${days}-day chip is disabled, so the click proves nothing`).toBe(false);
	btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const statValues = () => [...host.querySelectorAll('.stats .stat-value')].map((n) => n.textContent);
const memberRows = () => [...host.querySelectorAll('.trow')];

/**
 * ⛔ THE POSITIVE HALF, ASSERTED IN EVERY CASE. Not "the blank did not happen" — the four stat
 * cards are counted, the calls figure is read off the card, the by-member table is counted and its
 * one row is read by name. A page that rendered nothing fails all four.
 */
function assertBody(f: { text: string; member: string }, why: string) {
	expect(statValues(), why).toHaveLength(4);
	expect(statValues()[1], why).toBe(f.text);
	const rows = memberRows();
	expect(rows, why).toHaveLength(1);
	expect(rows[0]!.textContent, why).toContain(f.member);
	expect(rows[0]!.textContent, why).toContain(f.text);
	// The by-model bar and the sparkline are the other two things the chain was hiding.
	expect(host.textContent, why).toContain(`gpt-${f.text.replace(/,/g, '')}`);
	expect(host.querySelector('.spark polyline'), why).not.toBeNull();
}

// ==================================================================================================
// 1. THE ORDINARY CLICK — no error anywhere.
// ==================================================================================================
describe('/usage keeps its body up while a new range is fetched', () => {
	it('⛔ clicking a range keeps the loaded numbers on screen while the new range is fetched', async () => {
		// REVERT THAT TURNS THIS RED: `{:else if loading}` without `&& !data`. The chain's last branch
		// holds the whole body, so the stat cards drop to 0 and `admin_loading` appears — measured,
		// not assumed.
		await mountLoaded();

		const pending = deferred<TenantUsage>();
		usage.mockReturnValueOnce(pending.promise);
		clickRange(7);
		// One microtask: the handler has run and the request is out, but nothing has resolved.
		await Promise.resolve();
		flushSync();
		expect(usage, 'the 7-day request was never issued').toHaveBeenCalledTimes(2);
		expect(usage.mock.calls[1]).toEqual(['t-1', 7]);

		// THE WHOLE POINT: the previous range's body is still there, mid-flight.
		assertBody(MOUNT, 'the range click tore the body down — the defect verbatim');
		expect(host.textContent, 'the body was replaced by the loading notice').not.toContain(
			'admin_loading'
		);
		// …and the reader is told the figures are the PREVIOUS range's, because the chip has already
		// moved. Without this the blank body is merely traded for a silent one.
		const stale = host.querySelector('[data-testid="usage-stale-range"]');
		expect(stale, 'nothing said the figures belong to the previous range').not.toBeNull();
		expect(stale!.textContent).toContain('admin_usage_showing_previous:30');
		expect(chip(7).classList.contains('active'), 'the chip must show INTENT immediately').toBe(true);

		// …and when it lands, the caveat goes and the new figures are in.
		pending.resolve(payload(SEVEN));
		await settle();
		assertBody(SEVEN, 'the 7-day response never landed');
		expect(host.querySelector('[data-testid="usage-stale-range"]')).toBeNull();
	});

	it('a FIRST load still gets the loading notice — there is no body to protect', async () => {
		// ⛔ THE COMPLEMENT. `loading && !data` must not become "never show a spinner": a page that
		// has never loaded anything has nothing to preserve, and the notice is the right rendering.
		const first = deferred<TenantUsage>();
		usage.mockReturnValueOnce(first.promise);
		const { default: UsagePage } = await import('./+page.svelte');
		app = mount(UsagePage, { target: host, props: {} }) as Record<string, unknown>;
		// ⚠️ `settle()` DRAINS, it does not merely tick. `load()` awaits `currentTenant()` BEFORE
		// `usage()` on the very first pass, so a fixed pair of microtasks leaves the page one await
		// short of having issued the request at all — and the assertions below would then be about a
		// page that had not started loading rather than one that is loading. `first` is deferred, so
		// draining cannot accidentally complete it.
		await settle();
		expect(usage, 'the first request was never issued').toHaveBeenCalledTimes(1);

		expect(host.textContent, 'the first load has no spinner at all').toContain('admin_loading');
		expect(statValues()).toHaveLength(0);

		first.resolve(payload(MOUNT));
		await settle();
		assertBody(MOUNT, 'the first load never landed');
	});
});

// ==================================================================================================
// 2. THE FAILURES — over a body that is already correct.
// ==================================================================================================
describe('/usage reports a failed refresh without destroying what it is a caveat on', () => {
	it('a failed refresh reports itself without destroying the table', async () => {
		// REVERT THAT TURNS THIS RED, MEASURED: restore the original one-line catch
		// (`else loadError = errorText(…)`, no `if (data)` branch) — nothing renders the notice and
		// this case fails on "nothing on screen said the refresh failed". Restore the bare
		// `{:else if loadError}` on top of that and `assertBody` inverts too: rows 0, figures gone.
		//
		// ⚠️ DROPPING `&& !data` ALONE DOES NOT RED THIS, AND THAT IS RECORDED RATHER THAN HIDDEN.
		// The catch routes an already-loaded failure into `refreshError`, so `loadError` is
		// first-load-only and the guard is unreachable belt-and-braces. It stays because it is what
		// makes the blank impossible for a FUTURE caller that writes `loadError` from elsewhere — but
		// a comment claiming it is the load-bearing line would be a green that proves nothing.
		await mountLoaded();

		usage.mockRejectedValueOnce(new Error('Failed to fetch'));
		clickRange(7);
		await settle();

		// BOTH HALVES. The content is still there…
		assertBody(MOUNT, 'a failed refresh blanked the body — the defect verbatim');
		// …and the reader is told, in the stale-caveat wording, not a bare "could not load".
		const notice = host.querySelector('[data-testid="usage-refresh-error"]');
		expect(notice, 'nothing on screen said the refresh failed').not.toBeNull();
		expect(notice!.textContent).toContain('admin_usage_refresh_failed');
		expect(notice!.textContent).toContain('error_load_failed');
		expect(notice!.getAttribute('role')).toBe('alert');
		// The first-load branch is NOT what rendered it: that one would have eaten the body.
		expect(host.textContent, 'the whole-page load error took the body').not.toContain(
			'admin_load_failed'
		);
		// …and the figures are still openly labelled as the previous range's.
		expect(host.querySelector('[data-testid="usage-stale-range"]')).not.toBeNull();
		// The export button reads `data`, so it must not have gone dead either.
		expect(
			(host.querySelector('.export-btn') as HTMLButtonElement).disabled,
			'Export went dead over data that is still on screen'
		).toBe(false);
	});

	it('a 401 during a refresh is a failed refresh, not a wall', async () => {
		// ⛔ `denied` renders OUTSIDE the loading/error chain and replaced the entire body with one
		// sentence. A session expiring during a range click is the likeliest way this is ever reached,
		// and it took the spend figures the reader was reading with it.
		// REVERT THAT TURNS THIS RED, MEASURED: `if (…401||403) denied = true` unconditionally, i.e.
		// without the `if (data)` branch — this case then fails on "the refusal was not reported
		// anywhere", and with the bare `{#if denied}` restored on top of it the body goes as well.
		// (Same caveat as the case above: `&& !data` on its own is unreachable given the catch.)
		await mountLoaded();

		usage.mockRejectedValueOnce(new ApiErrorMock(401, 'unauthorized'));
		clickRange(7);
		await settle();

		assertBody(MOUNT, 'a mid-session refusal blanked the usage body');
		const notice = host.querySelector('[data-testid="usage-refresh-error"]');
		expect(notice, 'the refusal was not reported anywhere').not.toBeNull();
		expect(notice!.textContent, 'the refusal is not named').toContain('admin_denied');
		// The chips live outside the chain and survive even `denied` today — asserted anyway, because
		// they are the only control the reader has left to retry with and a future refactor that moves
		// them inside the chain must red here.
		expect(host.querySelectorAll('.ranges button').length).toBeGreaterThan(3);
		expect(host.textContent, 'the whole-page refusal sentence replaced the body').not.toBe(
			'admin_denied'
		);
	});

	it('a FIRST load that is refused still gets the whole-page sentence', async () => {
		// ⛔ THE COMPLEMENT. "Tenant admin access required" is the correct ENTIRE rendering when
		// nothing has ever loaded — a fix that demoted it to a footnote over an empty page is worse.
		usage.mockRejectedValueOnce(new ApiErrorMock(403, 'forbidden'));
		const { default: UsagePage } = await import('./+page.svelte');
		app = mount(UsagePage, { target: host, props: {} }) as Record<string, unknown>;
		await settle();

		expect(host.textContent).toContain('admin_denied');
		expect(statValues()).toHaveLength(0);
		expect(host.querySelector('[data-testid="usage-refresh-error"]')).toBeNull();
	});

	it('CLEARS the caveat once a later range click succeeds', async () => {
		// The notice is a fact about the LAST fetch, not a sticky flag.
		// REVERT THAT TURNS THIS RED: drop `refreshError = null` from the success path.
		await mountLoaded();
		usage.mockRejectedValueOnce(new Error('Failed to fetch'));
		clickRange(7);
		await settle();
		expect(host.querySelector('[data-testid="usage-refresh-error"]')).not.toBeNull();

		usage.mockResolvedValueOnce(payload(NINETY));
		clickRange(90);
		await settle();

		assertBody(NINETY, 'the recovered range did not land');
		expect(host.querySelector('[data-testid="usage-refresh-error"]')).toBeNull();
		expect(host.querySelector('[data-testid="usage-stale-range"]')).toBeNull();
	});
});

// ==================================================================================================
// 3. TWO REQUESTS IN FLIGHT AT ONCE — and BOTH of them succeed.
//
// ⛔ EVERYTHING ABOVE IS ABOUT A FAILURE. THIS IS NOT, WHICH IS WHY IT MATTERS MOST. Two clicks on
// a slow connection is not exotic; it is the reader deciding they meant 90, not 7. With no ticket,
// the page renders whichever response lands last and cannot say which range it drew.
// ==================================================================================================
describe('/usage discards a response belonging to a range the reader has left', () => {
	it('⛔ a slow 7-day response cannot land under the 90-day chip', async () => {
		// ⛔ MEASURED, NOT REASONED ABOUT. REVERT THAT TURNS THIS RED: drop the `generation !== reqSeq`
		// guard before `data = resp` — the late 7-day payload then overwrites the 90-day one and the
		// screen shows 4,444 under the 90-day chip, with no failure anywhere.
		await mountLoaded();

		const seven = deferred<TenantUsage>();
		usage.mockReturnValueOnce(seven.promise);
		clickRange(7);
		await Promise.resolve();
		expect(usage, 'the 7-day request was never issued').toHaveBeenCalledTimes(2);

		const ninety = deferred<TenantUsage>();
		usage.mockReturnValueOnce(ninety.promise);
		clickRange(90);
		await Promise.resolve();
		expect(usage, 'the 90-day request was never issued').toHaveBeenCalledTimes(3);
		expect(usage.mock.calls[2]).toEqual(['t-1', 90]);

		// The LIVE response lands first; the superseded one arrives afterwards.
		ninety.resolve(payload(NINETY));
		await settle();
		assertBody(NINETY, 'the 90-day response did not land');

		seven.resolve(payload(SEVEN));
		await settle();

		// ⛔ BOTH HALVES, and the fixtures share no digits so neither can satisfy the other.
		assertBody(NINETY, 'a range the reader had already left overwrote the figures on screen');
		expect(host.textContent, 'the abandoned 7-day figure is on screen').not.toContain(SEVEN.text);
		expect(host.textContent, 'the abandoned range’s member is on screen').not.toContain(
			SEVEN.member
		);
		// …and the page is not stuck saying the figures are somebody else's.
		expect(host.querySelector('[data-testid="usage-stale-range"]')).toBeNull();
		expect(chip(90).classList.contains('active')).toBe(true);
	});

	it('a superseded response cannot end the loading state of the request still in flight', async () => {
		// ⛔ THE `finally`, which is the third place a late response can speak. On a FIRST load there
		// is no body and no error yet, so `loading` is the ONLY thing keeping the chain on a branch at
		// all: clear it early and every branch is false and the page renders an empty region while a
		// request is genuinely in flight. The chips are outside the chain, so reaching this needs
		// nothing exotic — click one while the very first load is still out.
		const first = deferred<TenantUsage>();
		usage.mockReturnValueOnce(first.promise);
		const { default: UsagePage } = await import('./+page.svelte');
		app = mount(UsagePage, { target: host, props: {} }) as Record<string, unknown>;
		// Drained rather than ticked — see the note in the first-load case above.
		await settle();
		expect(usage, 'the first request was never issued').toHaveBeenCalledTimes(1);
		expect(host.textContent, 'the page is not in its loading branch').toContain('admin_loading');

		const second = deferred<TenantUsage>();
		usage.mockReturnValueOnce(second.promise);
		clickRange(90);
		await Promise.resolve();
		expect(usage, 'the second request was never issued').toHaveBeenCalledTimes(2);

		first.resolve(payload(MOUNT));
		await settle();
		expect(
			host.textContent,
			'the page went blank: no figures, no error, no spinner, with a request still in flight'
		).toContain('admin_loading');
		expect(statValues()).toHaveLength(0);

		second.resolve(payload(NINETY));
		await settle();
		assertBody(NINETY, 'the live first response never arrived');
		expect(host.textContent).not.toContain('admin_loading');
	});

	it('a re-click of the ACTIVE chip after a failed refresh RETRIES it', async () => {
		// ⛔⛔ THE ONLY OBVIOUS RETRY CONTROL ON THE SCREEN WAS INERT, AND THIS BRANCH IS WHAT MADE
		// THAT PERMANENT. `setRange`'s `if (r === range) return` is pre-existing; before this branch a
		// failed refresh blanked the body, so the stuck state was invisible and transient-looking.
		// Now the body survives — and so does the stuck state, visibly, with no exit: the page sits on
		// "Refresh failed…" plus a stale caveat, the 7 chip is `.active` and `.disabled === false`,
		// and clicking it does nothing.
		//
		// MEASURED BEFORE: expected usage() calls 3, received 2.
		// REVERT THAT TURNS THIS RED: restore the bare `if (r === range) return` in `setRange`.
		await mountLoaded();

		usage.mockRejectedValueOnce(new Error('Failed to fetch'));
		clickRange(7);
		await settle();
		expect(usage).toHaveBeenCalledTimes(2);
		expect(host.querySelector('[data-testid="usage-refresh-error"]')).not.toBeNull();
		// The chip really is in the state that makes it look like the retry control — otherwise this
		// case is about some other button.
		expect(chip(7).classList.contains('active'), 'the 7 chip is not the active one').toBe(true);
		expect(chip(7).disabled, 'the chip is disabled, so its inertness is not the defect').toBe(
			false
		);

		// THE RETRY.
		usage.mockResolvedValueOnce(payload(SEVEN));
		clickRange(7);
		await settle();
		expect(usage, 'the active chip is still inert — the reader has no way out').toHaveBeenCalledTimes(3);
		expect(usage.mock.calls[2]).toEqual(['t-1', 7]);

		// THE POSITIVE HALF: the retry actually recovered the page, it did not merely fire a request.
		assertBody(SEVEN, 'the retried range never landed');
		expect(host.querySelector('[data-testid="usage-refresh-error"]')).toBeNull();
		expect(host.querySelector('[data-testid="usage-stale-range"]')).toBeNull();
	});

	it('a re-click of a chip whose figures ARE on screen does NOT refetch', async () => {
		// ⛔ THE COMPLEMENT, and the reason `setRange` is not simply "always load". The early return
		// exists for the reader clicking the chip they are already reading; a fix that deleted it
		// outright would turn every stray click into a request. The condition must be "the screen
		// already shows THIS range and the last attempt succeeded", not "the chip is active".
		await mountLoaded();
		clickRange(30);
		await settle();
		expect(usage, 'a settled, correct screen refetched on a stray click').toHaveBeenCalledTimes(1);
		assertBody(MOUNT, 'the settled body was disturbed');
	});

	it('the stale caveat says FAILED after a failure and NOT-YET while in flight', async () => {
		// ⛔⛔ TWO STATES SHARED ONE SENTENCE, AND ONE OF THEM WAS UNTRUE. "…the new range has not
		// loaded yet" tells the reader to wait. After a failure nothing is loading and waiting is the
		// one thing that cannot help — and it was rendered directly beneath a "Refresh failed" notice,
		// so the page contradicted itself.
		// REVERT THAT TURNS THIS RED: render `admin_usage_showing_previous` unconditionally again.
		await mountLoaded();

		// IN FLIGHT — the not-yet sentence, and NOT the failed one.
		const pending = deferred<TenantUsage>();
		usage.mockReturnValueOnce(pending.promise);
		clickRange(7);
		await Promise.resolve();
		flushSync();
		const inflight = host.querySelector('[data-testid="usage-stale-range"]');
		expect(inflight, 'nothing said the figures belong to the previous range').not.toBeNull();
		expect(inflight!.textContent).toContain('admin_usage_showing_previous:30');
		expect(
			inflight!.textContent,
			'an in-flight fetch is being reported as a failure'
		).not.toContain('admin_usage_showing_previous_failed');

		// FAILED — the other sentence, over the same `loadedRange`.
		pending.reject(new Error('Failed to fetch'));
		await settle();
		const failed = host.querySelector('[data-testid="usage-stale-range"]');
		expect(failed, 'the caveat vanished when the fetch failed').not.toBeNull();
		expect(
			failed!.textContent,
			'a failed fetch still tells the reader it "has not loaded yet"'
		).toContain('admin_usage_showing_previous_failed:30');
		// The refresh notice is still the thing that names the error; this line is the caveat ON the
		// figures, and the two are different sentences in different places.
		expect(host.querySelector('[data-testid="usage-refresh-error"]')).not.toBeNull();
		assertBody(MOUNT, 'the failed caveat came at the cost of the body');
	});

	it('⛔ a superseded REJECTION cannot caption a screen that loaded fine', async () => {
		// ⛔ THE ORDER IS THE WHOLE TEST. The failure has to arrive LAST, over a screen that is
		// already correct — rejecting the stale request first and letting the live success clear the
		// notice afterwards would pass with the catch-side ticket check deleted.
		await mountLoaded();

		const seven = deferred<TenantUsage>();
		usage.mockReturnValueOnce(seven.promise);
		clickRange(7);
		await Promise.resolve();

		const ninety = deferred<TenantUsage>();
		usage.mockReturnValueOnce(ninety.promise);
		clickRange(90);
		await Promise.resolve();

		ninety.resolve(payload(NINETY));
		await settle();
		assertBody(NINETY, 'the live response did not land');

		seven.reject(new ApiErrorMock(401, 'unauthorized'));
		await settle();

		assertBody(NINETY, 'an abandoned request disturbed the figures');
		expect(
			host.querySelector('[data-testid="usage-refresh-error"]'),
			'the reader was told a request they had already left had failed — over figures that are fine'
		).toBeNull();
	});
});

// ==================================================================================================
// 4. THE FILE THAT LEAVES THE BUILDING — and no failure is involved in this one either.
//
// ⛔ `exportCsv()` labelled the CSV header row and the download filename with `range` — the chip the
// reader last CLICKED — instead of with the range the figures in `data` were actually fetched for.
// The in-flight window this branch created is exactly where the two differ, and the branch RENDERS A
// CAVEAT FOR IT while leaving Export enabled (deliberately, and section 2 pins that). So:
//
//     30-day data loaded → click "7" → page says "showing the previous 30 days" → Export
//         CSV:      "summary","Total (7d)","555555","12.5000"   ← 555555 is the 30-day figure
//         FILENAME: commonpractice-usage-7d-<date>.csv
//
// A tenant admin forwards that to finance. Nothing on screen is wrong; the artefact is.
//
// ⚠️ THE CONTRAST IS `audit/+page.svelte`, whose export RE-FETCHES server-side and therefore cannot
// diverge from its own label. This one serialises what is already in the browser, so it must read
// the payload's own `rangeDays` — the server's statement of the window it aggregated, shipped with
// the numbers.
// ==================================================================================================
describe('/usage exports the range the figures ARE, not the chip that is lit', () => {
	/** Capture the Blob handed to `URL.createObjectURL` and the anchor's `download`. */
	function captureDownload() {
		const seen: { blob?: Blob; filename?: string } = {};
		const createObjectURL = vi.fn((b: Blob) => {
			seen.blob = b;
			return 'blob:stub';
		});
		const revokeObjectURL = vi.fn();
		// ⛔ ASSIGNED ON THE PROTOTYPE, not on a captured element: the page creates its OWN anchor
		// inside `exportCsv`, so there is nothing to spy on until after the click has happened.
		const clickSpy = vi
			.spyOn(HTMLAnchorElement.prototype, 'click')
			.mockImplementation(function (this: HTMLAnchorElement) {
				seen.filename = this.download;
			});
		const realCreate = URL.createObjectURL;
		const realRevoke = URL.revokeObjectURL;
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		return {
			seen,
			restore() {
				clickSpy.mockRestore();
				Object.assign(URL, { createObjectURL: realCreate, revokeObjectURL: realRevoke });
			}
		};
	}

	function exportButton(): HTMLButtonElement {
		const btn = host.querySelector('.export-btn') as HTMLButtonElement | null;
		expect(btn, 'the Export button did not render').not.toBeNull();
		return btn!;
	}

	it('⛔ exporting mid-flight labels the CSV and the filename with the LOADED range', async () => {
		// REVERT THAT TURNS THIS RED: pass `range` to `buildUsageCsv`/`usageCsvFilename` again.
		await mountLoaded();

		const pending = deferred<TenantUsage>();
		usage.mockReturnValueOnce(pending.promise);
		clickRange(7);
		await Promise.resolve();
		flushSync();

		// The precondition, asserted rather than assumed: the chip says 7, the caveat says 30, and
		// Export is still enabled. Without all three this case is not the window under test.
		expect(chip(7).classList.contains('active'), 'the chip did not move to 7').toBe(true);
		expect(
			host.querySelector('[data-testid="usage-stale-range"]')?.textContent,
			'the page is not in the divergent window'
		).toContain('admin_usage_showing_previous:30');
		expect(exportButton().disabled, 'Export is disabled, so this window is untestable').toBe(false);

		const cap = captureDownload();
		try {
			exportButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
			expect(cap.seen.blob, 'no blob was created — Export did nothing').toBeDefined();
			const csv = await cap.seen.blob!.text();

			// THE HEADER ROW. The figure and the label must describe the same range.
			expect(csv, 'the CSV summary row is labelled with the chip, not the data').toContain(
				`"summary","Total (30d)","${MOUNT.calls}"`
			);
			expect(csv, 'the CSV claims a 7-day total over 30-day figures').not.toContain('Total (7d)');
			// THE FILENAME.
			expect(cap.seen.filename, 'the download filename names the chip, not the data').toMatch(
				/^commonpractice-usage-30d-\d{4}-\d{2}-\d{2}\.csv$/
			);
			expect(cap.seen.filename).not.toContain('-7d-');
		} finally {
			cap.restore();
		}

		// …and once the new range lands, the export follows it. Without this half the fix could be
		// "always say 30".
		pending.resolve(payload(SEVEN));
		await settle();
		const cap2 = captureDownload();
		try {
			exportButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
			const csv = await cap2.seen.blob!.text();
			expect(csv, 'the export did not follow the newly loaded range').toContain(
				`"summary","Total (7d)","${SEVEN.calls}"`
			);
			expect(cap2.seen.filename).toContain('-7d-');
		} finally {
			cap2.restore();
		}
	});

	it('exporting after a FAILED range change still labels the range on screen', async () => {
		// The other half of the divergent window: the chip has moved, the fetch failed, and the
		// figures are — correctly — still the previous range's. The file must say so too.
		await mountLoaded();
		usage.mockRejectedValueOnce(new Error('Failed to fetch'));
		clickRange(90);
		await settle();
		expect(host.querySelector('[data-testid="usage-refresh-error"]')).not.toBeNull();

		const cap = captureDownload();
		try {
			exportButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
			const csv = await cap.seen.blob!.text();
			expect(csv).toContain(`"summary","Total (30d)","${MOUNT.calls}"`);
			expect(csv, 'the CSV is labelled with a range that never loaded').not.toContain(
				'Total (90d)'
			);
			expect(cap.seen.filename).toContain('-30d-');
		} finally {
			cap.restore();
		}
	});
});
