// @vitest-environment jsdom
//
// src/routes/audit/audit-page.refresh-failure.render.test.ts — a transient failure on an
// APPEND-ONLY AUDIT LOG must not destroy the rows, and must not skip a window of them.
//
// ⛔ TWO DEFECTS, ONE FUNCTION, AND THE SECOND ONE IS SILENT.
//
//   1. `load()`'s catch wrote `error`, which renders inside the `{#if loading}{:else if error}`
//      chain whose SIBLING branch holds the whole table. `feed` and `items` were never cleared —
//      the twenty-five rows the reader was reading were still in memory — the chain simply refused
//      to render them. So a 500 on "Load more" blanked the log to report that more of the log could
//      not be fetched. The page already had the shape of the fix in it: `actionError` (the CSV
//      export) is rendered ABOVE the chain for exactly this reason, and its own comment says so.
//
//   2. `loadMore()` was `page += 1; load();` with NO ROLLBACK. After one failed click the counter
//      sat at 3 for the rest of the session, so the next SUCCESSFUL click fetched window 4 and
//      appended it to window 1 — twenty-five events of an append-only log missing from the reader's
//      screen, with a green table and no message at all. Nothing on screen could reveal it; the
//      only witness is the argument handed to the API, which is what the third case asserts.
//
//   3. …AND THE FIRST FIX FOR (2) INTRODUCED THE SAME GAP BY ANOTHER ROUTE, WITH NO FAILURE
//      ANYWHERE. Moving `page`'s write to after the await handed a late response the power to
//      overwrite the `page = 1` a chip click had already made, and handed a stale window the power
//      to be appended under the new chips. Both reproduce with two 200s. Adversarial review
//      measured `{category:'block', page:3}` on the branch against `page:2` on main, and a 50-row
//      table spliced out of two filters. Section 3 of this file drives both interleavings.
//
//   4. A 401/403 ON A REFRESH REPLACED THE ENTIRE PAGE — rows, chips, range select, search box and
//      export button — with one sentence and no control to retry with. A session expiring during
//      "Load more" is the likeliest way this is ever reached. Section 4.
//
// ⛔ THE ANTI-VACUITY RULE THIS FILE IS BUILT ON. Every failure case asserts BOTH halves: the rows
// are STILL THERE **and** the error is on screen. An assertion that only says "the blank did not
// happen" is satisfied by a page that never rendered anything — which is the exact failure mode
// this repo keeps hitting — so `assertRows()` pins the row COUNT and the row TEXT, not an absence.
//
// ⚠️ AND A DOCUMENTED REVERT IS ONLY A PROOF ONCE IT HAS BEEN RUN. Two cases in this file passed
// against the mutation they claimed to catch — one guarding a line that was already dead, one
// ordering its two promises so the fix under test could not matter. Both are fixed; every
// "REVERT THAT TURNS THIS RED" note below has been measured, not reasoned about.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { AuditFeed, AuditItem } from '$lib/types/audit';

// Real `en` catalog, each key resolving to its own name (+ its arguments when it takes any), so a
// reworded translation cannot red this file and a resurrected hardcoded English string cannot pass.
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

// ⛔ `ApiError` MUST BE A REAL CLASS: `load()` does `e instanceof ApiError` to split 401/403 off
// from an ordinary failure. A mock that omits it fails at import time — loudly, which is the point.
// ⚠️ Declared inside `vi.hoisted` because `vi.mock` factories are hoisted above every top-level
// statement in this file, AND so the cases below can throw the very same class the page tests
// against — two lookalike classes would make `instanceof` false and silently reroute the refusal.
const { list, exportCsv, ApiErrorMock } = vi.hoisted(() => ({
	list: vi.fn(),
	exportCsv: vi.fn(),
	ApiErrorMock: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error'
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/audit', () => ({ ApiError: ApiErrorMock, auditApi: { list, exportCsv } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

const PAGE_SIZE = 25;

/**
 * A row whose ACTION text names both the QUERY it came from and the WINDOW inside it.
 *
 * ⛔ THE QUERY TAG IS NOT DECORATION. The interleaving cases below need to answer "whose rows are
 * these" — a table spliced out of two different filters is 50 rows of perfectly valid audit events,
 * and a fixture that labelled rows by window number alone would render window 1 of filter B and
 * window 2 of filter A as `p1.…` and `p2.…` and look exactly like a correct two-window append.
 * The tag is a PREFIX so `not.toContain('q0-p2.event1')` cannot be satisfied by a row from the
 * other query that happens to share a window number.
 */
function item(n: number, page: number, tag: string): AuditItem {
	return {
		id: `ev-${tag}-${page}-${n}`,
		action: `${tag}-p${page}.event${n}`,
		category: 'data',
		targetType: 'dataset',
		targetId: `tgt-${tag}-${page}-${n}`,
		result: 'ok',
		resultTone: 'ok',
		createdAt: '2026-08-10T09:00:00.000Z',
		actor: { name: `Actor ${tag}-${page}-${n}`, initials: 'AA' }
	};
}

/** One window of the feed. `total` is 100 → four pages, so "Load more" is offered throughout. */
function feed(page: number, tag = 'q0', count = PAGE_SIZE): AuditFeed {
	return {
		items: Array.from({ length: count }, (_, i) => item(i + 1, page, tag)),
		total: 100,
		page,
		pageSize: PAGE_SIZE,
		counts: { all: 100, data: 100 }
	};
}

/**
 * A promise this test resolves by hand.
 *
 * ⛔ THE ONLY WAY TO DRIVE THE DEFECTS IN THE LAST DESCRIBE BLOCK. `mockResolvedValue` resolves on
 * the next microtask, so two requests issued in the same tick can never be observed OVERLAPPING —
 * and both races below need a second request issued while the first is still in flight, then
 * resolved in a chosen order. With auto-resolving mocks the branch under test is unreachable and
 * every assertion about it passes for the wrong reason.
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

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function mountPage() {
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
}

/** The "Load more" button, or `undefined` when the pager has withdrawn it. */
function loadMoreBtn(): HTMLButtonElement | undefined {
	return [...target.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'audit_load_more'
	);
}

async function clickLoadMore() {
	const btn = loadMoreBtn();
	expect(btn, 'the "Load more" button is not on screen, so this case tests nothing').toBeDefined();
	// ⛔ `bubbles: true` — Svelte 5 DELEGATES DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the handler and every assertion below passes for free.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

/**
 * ⛔ THE POSITIVE HALF, ASSERTED IN EVERY CASE. `expect(text).not.toContain(…)` over a page that
 * never mounted is green, so the rows are counted AND read, and the first row of each window named
 * in the fixture is looked up by its own text.
 */
function assertRows(pages: number[], why: string, tag = 'q0') {
	const rows = target.querySelectorAll('tbody tr');
	expect(rows, why).toHaveLength(pages.length * PAGE_SIZE);
	const text = target.textContent ?? '';
	for (const p of pages) {
		expect(text, `window ${p} of ${tag} is not on screen`).toContain(`${tag}-p${p}.event1`);
		expect(text, `window ${p} of ${tag} is not on screen`).toContain(
			`${tag}-p${p}.event${PAGE_SIZE}`
		);
	}
}

/** Every row id currently rendered, read off the DOM rather than off the fixture. */
function renderedTargetIds(): string[] {
	return [...target.querySelectorAll('tbody tr td.target')].map((td) => td.textContent ?? '');
}

/** Click a category chip WITHOUT waiting for its request — the interleaving cases need it in flight. */
function clickChip(labelKey: string) {
	const chip = [...target.querySelectorAll('button.chip')].find((b) =>
		b.textContent?.includes(labelKey)
	);
	expect(chip, `the ${labelKey} chip did not render`).toBeDefined();
	chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** The argument object of the most recent `auditApi.list` call. */
function lastQuery(): Record<string, unknown> {
	expect(list.mock.calls.length, 'no request was ever made').toBeGreaterThan(0);
	return list.mock.calls.at(-1)![0] as Record<string, unknown>;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	list.mockReset();
	exportCsv.mockReset();
});

// ==================================================================================================
// 1. THE TABLE SURVIVES A FAILED APPEND.
// ==================================================================================================
describe('/audit keeps the log on screen when a later fetch fails', () => {
	it('⛔ a failed "Load more" leaves all 25 rows up AND says the refresh failed', async () => {
		// REVERT THAT TURNS THIS RED: put the failure back into `error`. The `{:else if error}` branch
		// is mutually exclusive with the table, so `tbody tr` drops to 0 and the first assertion
		// inverts — measured, not assumed.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		assertRows([1], 'the first window never rendered, so this file would prove nothing');

		list.mockRejectedValueOnce(new Error('Failed to fetch'));
		await clickLoadMore();

		// BOTH HALVES. The content is still there…
		assertRows([1], 'the failed append blanked the table — the defect verbatim');
		// …and the reader is told, in the stale-caveat wording, not a bare "could not load".
		const notice = target.querySelector('[data-testid="audit-refresh-error"]');
		expect(notice, 'nothing on screen said the refresh failed').not.toBeNull();
		expect(notice!.textContent).toContain('audit_refresh_failed');
		expect(notice!.getAttribute('role')).toBe('alert');
		// The first-load branch is NOT what rendered it: that one would have eaten the table.
		expect(target.querySelector('table'), 'the table element is gone').not.toBeNull();
	});

	it('⛔ a failed CHIP click leaves the rows up AND says so', async () => {
		// The filter handlers set `page = 1` first, so only the render half of the defect reaches
		// them — but it reaches them just as hard: clicking "Block" on a 500 blanked the board.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		assertRows([1], 'the first window never rendered');

		list.mockRejectedValueOnce(new Error('Failed to fetch'));
		const chip = [...target.querySelectorAll('button.chip')].find((b) =>
			b.textContent?.includes('audit_chip_block')
		);
		expect(chip, 'the category chips did not render').toBeDefined();
		chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		assertRows([1], 'a failed filter change blanked the table');
		expect(target.querySelector('[data-testid="audit-refresh-error"]')).not.toBeNull();
		// ⚠️ AND THE PAGER WITHDRAWS. The chips now say "Block" while the rows are the previous
		// query's, so window 2 of the NEW query must not be offered for stapling onto them.
		expect(
			loadMoreBtn(),
			'"Load more" would have spliced two different filters into one table'
		).toBeUndefined();
	});

	it('a FIRST load that fails still gets the chain error — there is no table to protect', async () => {
		// ⛔ THE COMPLEMENT, AND THE REASON THE FIX IS TWO SLOTS RATHER THAN A RENAME. A page that has
		// never loaded anything has nothing to preserve, and the full-width chain error is the right
		// rendering for it. A "fix" that routed every failure to the small stale-caveat notice would
		// leave a first-time reader with an empty page and a footnote.
		list.mockRejectedValueOnce(new Error('Failed to fetch'));
		await mountPage();

		expect(list).toHaveBeenCalledTimes(1);
		expect(target.querySelectorAll('tbody tr')).toHaveLength(0);
		expect(target.textContent).toContain('error_load_failed');
		expect(
			target.querySelector('[data-testid="audit-refresh-error"]'),
			'a first load has no rows to be stale'
		).toBeNull();
	});

	it('CLEARS the notice once a later "Load more" succeeds', async () => {
		// The message is a fact about the LAST fetch, not a sticky flag — a recovered feed must stop
		// apologising. REVERT THAT TURNS THIS RED: drop `refreshError = null` from the try block.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		list.mockRejectedValueOnce(new Error('Failed to fetch'));
		await clickLoadMore();
		expect(target.querySelector('[data-testid="audit-refresh-error"]')).not.toBeNull();

		list.mockResolvedValueOnce(feed(2));
		await clickLoadMore();
		assertRows([1, 2], 'the recovered append did not land');
		expect(target.querySelector('[data-testid="audit-refresh-error"]')).toBeNull();
	});
});

// ==================================================================================================
// 2. THE SILENT ONE: the window counter.
// ==================================================================================================
describe('/audit never skips a window of an append-only log', () => {
	it('⛔ the retry after a failed "Load more" requests page 2, NOT page 4', async () => {
		// ⛔ THIS IS THE WHOLE DEFECT AND IT HAS NO RENDERING. `page += 1` before the fetch, with no
		// rollback, put the counter at 3 after one failure (`loadMore` ran twice); the next success
		// fetched window 4 and appended it to window 1. Twenty-five events gone, table green.
		// The only witness is the ARGUMENT, so that is what is asserted.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		expect(list.mock.calls[0]![0]).toMatchObject({ page: 1 });

		list.mockRejectedValueOnce(new Error('Failed to fetch'));
		await clickLoadMore();
		expect(list).toHaveBeenCalledTimes(2);
		expect(list.mock.calls[1]![0], 'the failed click did not even ask for window 2').toMatchObject({
			page: 2
		});

		list.mockResolvedValueOnce(feed(2));
		await clickLoadMore();
		expect(list).toHaveBeenCalledTimes(3);
		expect(
			list.mock.calls[2]![0],
			'the retry skipped a window — 25 audit events the reader will never see'
		).toMatchObject({ page: 2 });

		// …and the rows prove the append is contiguous, not just that the argument was right.
		assertRows([1, 2], 'the recovered window did not land');
		expect(target.textContent, 'a window nobody ever asked for is on screen').not.toContain(
			'q0-p4.event1'
		);
	});

	it('two failures in a row still leave the next request on page 2', async () => {
		// The old body was cumulative: N failures put the counter N ahead. One rollback that only
		// undoes the last one would pass the case above and fail here.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		list.mockRejectedValueOnce(new Error('Failed to fetch'));
		await clickLoadMore();
		list.mockRejectedValueOnce(new Error('Failed to fetch'));
		await clickLoadMore();

		list.mockResolvedValueOnce(feed(2));
		await clickLoadMore();
		expect(list).toHaveBeenCalledTimes(4);
		expect(list.mock.calls[3]![0]).toMatchObject({ page: 2 });
		assertRows([1, 2], 'the recovered window did not land');
	});

	it('two "Load more" clicks in the SAME TICK cannot render a duplicate row', async () => {
		// ⛔ `disabled={loading}` latches only after a flush, so both handlers run. Whatever the client
		// does with the two responses, the keyed `{#each … (item.id)}` must never be handed the same
		// id twice — Svelte throws `each_key_duplicate` and the whole board dies.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		// ⚠️ ARMED BEFORE THE CLICKS, not after: `list()` with no implementation returns `undefined`,
		// `resp.items` throws, and the case would "fail" on a fixture mistake instead of on the
		// property under test.
		list.mockResolvedValue(feed(2));
		const btn = loadMoreBtn()!;
		btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		const ids = renderedTargetIds();
		expect(new Set(ids).size, `a row id was rendered twice: ${ids.join()}`).toBe(ids.length);
		assertRows([1, 2], 'the append did not land');
	});

	it('a server window that OVERLAPS the previous one is de-duplicated, not crashed on', async () => {
		// ⛔ THE REAL-WORLD VERSION, AND IT NEEDS NO CLIENT BUG AT ALL. The feed is append-only and
		// paged by OFFSET, so rows written between the page-1 and page-2 requests shift the window and
		// page 2 legitimately re-serves a row page 1 already had. That is the server being correct;
		// the client must not turn it into `each_key_duplicate`.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		const overlapping = feed(2);
		// The last row of window 1, re-served at the head of window 2 — verbatim, id and all.
		overlapping.items = [item(PAGE_SIZE, 1, 'q0'), ...overlapping.items.slice(1)];
		list.mockResolvedValueOnce(overlapping);
		await clickLoadMore();

		const ids = renderedTargetIds();
		expect(new Set(ids).size, `a row id was rendered twice: ${ids.join()}`).toBe(ids.length);
		expect(ids).toHaveLength(2 * PAGE_SIZE - 1);
		// …and the rows that ARE new all arrived.
		expect(target.textContent).toContain(`q0-p2.event${PAGE_SIZE}`);
	});

	it('a SUCCESSFUL "Load more" still advances — the rollback must not freeze the pager', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. "Never advance `page`" fixes the skip and breaks paging
		// outright, and every assertion in the case above would still pass.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		list.mockResolvedValueOnce(feed(2));
		await clickLoadMore();
		list.mockResolvedValueOnce(feed(3));
		await clickLoadMore();

		expect(list.mock.calls.map((c) => (c[0] as { page?: number }).page)).toEqual([1, 2, 3]);
		assertRows([1, 2, 3], 'the appends did not accumulate');
	});
});

// ==================================================================================================
// 3. TWO REQUESTS IN FLIGHT AT ONCE — and BOTH of them succeed.
//
// ⛔ EVERYTHING ABOVE IS ABOUT A FAILURE. THIS BLOCK IS NOT, AND THAT IS WHY IT MATTERS MOST. A
// "Load more" is outstanding and the reader clicks a chip or types in the search box (250 ms
// debounce) — an entirely ordinary sequence — and two requests overlap. The first version of this
// fix moved `page`'s write to AFTER the await, which handed the late response the power to clobber
// the `page = 1` the filter handler had already written, and handed the stale window the power to
// be appended under the new chips. Both reproduce with two 200-OK responses and no error anywhere,
// which is exactly the class of defect this whole change exists to end: 25 audit events missing,
// nothing on screen saying so.
//
// A page-number rollback cannot express "this response belongs to a query that no longer exists" —
// only a generation token can, so that is what is asserted here, through behaviour.
// ==================================================================================================
describe('/audit discards responses belonging to a query the reader has left', () => {
	/** Load window 1, then leave a "Load more" for window 2 in flight. */
	async function loadMoreInFlight() {
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		assertRows([1], 'the first window never rendered, so nothing below is in flight');
		const more = deferred<AuditFeed>();
		list.mockReturnValueOnce(more.promise);
		loadMoreBtn()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		// One microtask: the handler has run and the request is out, but nothing has resolved.
		await Promise.resolve();
		expect(list, 'the Load more request was never issued').toHaveBeenCalledTimes(2);
		expect((list.mock.calls[1]![0] as { page?: number }).page).toBe(2);
		return more;
	}

	it('⛔ REGRESSION: a late "Load more" must not push the NEXT request past a window', async () => {
		// ⛔ MEASURED ON THIS BRANCH BEFORE THE FIX:
		//      BRANCH  {category:'block', page:3}   ← window 2 SKIPPED, both responses were 200
		//      MAIN    {category:'block', page:2}
		//    `loadMore`'s `page = next` ran after the chip handler's `page = 1` and overwrote it.
		const more = await loadMoreInFlight();

		const chip = deferred<AuditFeed>();
		list.mockReturnValueOnce(chip.promise);
		clickChip('audit_chip_block');
		await Promise.resolve();
		expect(list, 'the chip request was never issued').toHaveBeenCalledTimes(3);

		// The SUPERSEDED response lands first, then the live one.
		more.resolve(feed(2));
		await settle();
		chip.resolve(feed(1, 'blk'));
		await settle();

		// The rows are the new query's first window, and only that.
		assertRows([1], 'the chip response did not land', 'blk');

		list.mockResolvedValueOnce(feed(2, 'blk'));
		await clickLoadMore();
		expect(
			lastQuery(),
			'the pager skipped a window of an append-only log — with no failure anywhere'
		).toMatchObject({ category: 'block', page: 2 });
		assertRows([1, 2], 'the second window of the new query did not append', 'blk');
	});

	it('⛔ REGRESSION: a stale window must not be spliced under the new chips', async () => {
		// ⛔ MEASURED ON THIS BRANCH BEFORE THE FIX (reverse resolution order):
		//      BRANCH  ROWS = 50   block window 1 + data window 2, one table out of two filters
		//      MAIN    ROWS = 25
		//    …plus a header count taken from the discarded query.
		const more = await loadMoreInFlight();

		const chip = deferred<AuditFeed>();
		list.mockReturnValueOnce(chip.promise);
		clickChip('audit_chip_block');
		await Promise.resolve();

		// The LIVE response lands first; the superseded one arrives afterwards.
		chip.resolve(feed(1, 'blk'));
		await settle();
		more.resolve(feed(2));
		await settle();

		assertRows([1], 'the table is spliced out of two different filters', 'blk');
		expect(
			target.textContent,
			'a window from the query the reader had already left is on screen'
		).not.toContain('q0-p2.event1');
	});

	it('⛔ a superseded REJECTION cannot caption a screen that loaded fine', async () => {
		// ⛔ THE ORDER IS THE WHOLE TEST, AND THE FIRST VERSION OF THIS CASE GOT IT WRONG — it rejected
		// the stale request FIRST and let the live success clear the notice afterwards, so it passed
		// with the catch-side guard deleted and proved nothing. Measured: 16/16 green against the
		// mutation. The failure has to arrive LAST, over a screen that is already correct.
		const more = await loadMoreInFlight();

		const chip = deferred<AuditFeed>();
		list.mockReturnValueOnce(chip.promise);
		clickChip('audit_chip_block');
		await Promise.resolve();

		chip.resolve(feed(1, 'blk'));
		await settle();
		assertRows([1], 'the live response did not land', 'blk');

		more.reject(new Error('Failed to fetch'));
		await settle();

		assertRows([1], 'an abandoned request disturbed the rows', 'blk');
		expect(
			target.querySelector('[data-testid="audit-refresh-error"]'),
			'the reader was told a request they had already left had failed — over rows that are fine'
		).toBeNull();
	});

	it('⛔ a superseded REFUSAL cannot blank the page either', async () => {
		// The same hole with a 401/403 in it: without the catch-side ticket check this rejection
		// reaches the `denied` / `refreshError` branch and speaks for a query nobody is on.
		const more = await loadMoreInFlight();

		const chip = deferred<AuditFeed>();
		list.mockReturnValueOnce(chip.promise);
		clickChip('audit_chip_block');
		await Promise.resolve();

		chip.resolve(feed(1, 'blk'));
		await settle();
		more.reject(new ApiErrorMock(403, 'forbidden'));
		await settle();

		assertRows([1], 'an abandoned refusal blanked the board', 'blk');
		expect(target.textContent, 'a refusal nobody is waiting for took the page').not.toContain(
			'audit_denied'
		);
		expect(target.querySelector('[data-testid="audit-refresh-error"]')).toBeNull();
	});

	it('a superseded response cannot end the loading state of the request still in flight', async () => {
		// ⛔ THE `finally`, which is the third place a late response can speak. On a FIRST load there is
		// no table and no error yet, so `loading` is the ONLY thing keeping the loading/error chain on
		// a branch at all: clear it early and every branch is false and the page renders an empty
		// region while a request is genuinely in flight. The chips are outside the chain, so reaching
		// this needs nothing exotic — click one while the very first load is still out.
		const first = deferred<AuditFeed>();
		list.mockReturnValueOnce(first.promise);
		component = mount(Page, { target }) as Record<string, unknown>;
		await Promise.resolve();
		flushSync();
		expect(target.textContent, 'the page is not in its loading branch').toContain('audit_loading');

		const chip = deferred<AuditFeed>();
		list.mockReturnValueOnce(chip.promise);
		clickChip('audit_chip_block');
		await Promise.resolve();

		first.resolve(feed(1));
		await settle();

		expect(
			target.textContent,
			'the page went blank: no rows, no error, no spinner, with a request still in flight'
		).toContain('audit_loading');
		expect(target.querySelectorAll('tbody tr')).toHaveLength(0);

		chip.resolve(feed(1, 'blk'));
		await settle();
		assertRows([1], 'the live first window never arrived', 'blk');
		expect(target.textContent).not.toContain('audit_loading');
	});

	it('the pager withdraws while a filter change is still in flight', async () => {
		// ⛔ THE THIRD WAY TO SPLICE, and it needs no stale response at all: press "Load more" while
		// the chip's own page-1 request is still out, and window 2 of the NEW query is appended to the
		// OLD rows. The rows on screen belong to the previous query, so the pager has nothing
		// coherent to extend and must not offer to.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		const chip = deferred<AuditFeed>();
		list.mockReturnValueOnce(chip.promise);
		clickChip('audit_chip_block');
		await Promise.resolve();
		flushSync();

		expect(loadMoreBtn(), '"Load more" is live over rows from a query nobody is on').toBeUndefined();
		// …and it comes back the moment the new query's own first window is on screen.
		chip.resolve(feed(1, 'blk'));
		await settle();
		expect(loadMoreBtn(), 'the pager never returned').toBeDefined();
		assertRows([1], 'the new query did not land', 'blk');
	});
});

// ==================================================================================================
// 4. THE REFUSAL, AND THE INTERIM.
// ==================================================================================================
describe('/audit keeps the log up when the SESSION, not the request, is what failed', () => {
	it('⛔ a 403 on a refresh does not strip the rows, the chips, the filters and the export', async () => {
		// ⛔ THE COMPLETE ORIGINAL DEFECT, STILL LIVE ON THE MOST LIKELY PATH. `denied` is rendered by
		// `{#if denied}` OUTSIDE the loading/error chain and replaces the entire page — measured
		// mid-session: rows 0, chips 0, export button gone, no notice, one sentence and no control
		// left to retry with. A session that expired during "Load more" is how a real demo hits this,
		// and the reader loses the twenty-five events they were reading in order to be told about it.
		// A first-load 403 keeps the full-page sentence: there is genuinely nothing else to render.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		list.mockRejectedValueOnce(new ApiErrorMock(403, 'forbidden'));
		await clickLoadMore();

		assertRows([1], 'a mid-session refusal blanked the audit log');
		const notice = target.querySelector('[data-testid="audit-refresh-error"]');
		expect(notice, 'the refusal was not reported anywhere').not.toBeNull();
		expect(notice!.textContent, 'the refusal is not named').toContain('audit_denied');
		// The controls the reader needs in order to do anything about it are all still there.
		expect(target.querySelectorAll('button.chip').length).toBeGreaterThan(0);
		expect(target.querySelector('input.input'), 'the search box went with it').not.toBeNull();
		expect(target.querySelector('.btn-export'), 'the export button went with it').not.toBeNull();
	});

	it('a FIRST load that is refused still gets the whole-page sentence', async () => {
		// ⛔ THE COMPLEMENT. "Platform access required" is the correct entire rendering when nothing
		// has ever loaded — a fix that demoted it to a footnote over an empty page would be worse.
		list.mockRejectedValueOnce(new ApiErrorMock(403, 'forbidden'));
		await mountPage();

		expect(target.textContent).toContain('audit_denied');
		expect(target.querySelectorAll('button.chip')).toHaveLength(0);
		expect(target.querySelector('[data-testid="audit-refresh-error"]')).toBeNull();
	});

	it('⛔ the stale caveat stays up WHILE the retry is in flight', async () => {
		// ⛔ THE INTERIM RENDERING, which was dishonest in the opposite direction: the caveat was
		// cleared at the TOP of `load()`, before the await. So during a retry the reader saw the
		// previous query's rows under the new chips with no caveat, no spinner (`{#if loading &&
		// !feed}` is false once `feed` is set) and no pager — a screen asserting, silently, that
		// those rows are the answer. The notice now clears on SUCCESS, which is when it stops
		// being true.
		list.mockResolvedValueOnce(feed(1));
		await mountPage();
		list.mockRejectedValueOnce(new Error('Failed to fetch'));
		clickChip('audit_chip_block');
		await settle();
		expect(target.querySelector('[data-testid="audit-refresh-error"]')).not.toBeNull();

		const retry = deferred<AuditFeed>();
		list.mockReturnValueOnce(retry.promise);
		clickChip('audit_chip_policy');
		await Promise.resolve();
		flushSync();

		assertRows([1], 'the rows went away during the retry');
		expect(
			target.querySelector('[data-testid="audit-refresh-error"]'),
			'the caveat vanished while the rows it describes are still the previous query’s'
		).not.toBeNull();

		retry.resolve(feed(1, 'pol'));
		await settle();
		expect(target.querySelector('[data-testid="audit-refresh-error"]')).toBeNull();
		assertRows([1], 'the retry did not land', 'pol');
	});
});
