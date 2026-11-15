// @vitest-environment jsdom
//
// src/routes/translations/translations-page.filtered-empty.render.test.ts — an empty FILTER result
// is not the same claim as an empty pipeline.
//
// ⛔ THE DEFECT, AND IT CONTRADICTED ITSELF ON ONE SCREEN. The jobs table rendered `tr_empty` —
// "Nog geen vertaaltaken." / "No translation jobs yet." — whenever `data.jobs.length === 0`,
// INCLUDING when one of the Mislukt / In behandeling / Klaar chips was active. So on a workspace
// with 728 done jobs, clicking "Mislukt" produced:
//
//     coverage matrix (eight lines higher, same viewport):  nl  0 / 728 / 0
//     jobs table:                                           "Nog geen vertaaltaken."
//
// Two numbers on one screen that cannot both be true, with no explanation — and the only available
// reading is that the page is broken, at the exact moment the reader is trying to find out whether
// the pipeline is. /audit already models the right sentence: `audit_empty` says "no audit events
// match this view", not "there are no audit events".
//
// ⛔ BOTH DIRECTIONS ARE ASSERTED IN EVERY CASE — the right sentence is present AND the wrong one
// is absent — because `tr_empty` is ALSO rendered legitimately by the coverage matrix above the
// table (`locales.length === 0`), so "the page does not contain tr_empty" is not a safe assertion
// on its own and a fix that swapped the two globally would be invisible to a looser test.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { JobsResponse, TranslationJob } from '$lib/types/translation';

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

const { jobs, queue, run, override } = vi.hoisted(() => ({
	jobs: vi.fn(),
	queue: vi.fn(),
	run: vi.fn(),
	override: vi.fn()
}));
// ⛔ `ApiError` MUST BE A REAL CLASS — `load()` does `e instanceof ApiError` for the 401/403 split.
vi.mock('$lib/api/translations', () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error'
		) {
			super(message);
		}
	},
	translationsApi: { jobs, queue, run, override }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

function job(id: string, status: TranslationJob['status']): TranslationJob {
	return {
		id,
		entity_type: 'challenge',
		entity_id: 'ch-0000000000',
		field: 'title',
		target_locale: 'nl',
		source_text: 'Claims intake takes four days',
		status,
		attempts: 1,
		error: null,
		requested_by: null,
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		current_value: 'Claimintake duurt vier dagen',
		current_updated_at: '2026-08-02T00:00:00.000Z'
	};
}

/**
 * ⚠️ THE COVERAGE MATRIX IS ALWAYS POPULATED, IN EVERY FIXTURE, INCLUDING THE ONES WITH NO JOB
 * ROWS. That is not scene-setting — it is the defect. `byLocale` counting 728 done beside a table
 * that says "no translation jobs yet" is the contradiction under test, and a fixture with an empty
 * `byLocale` would make the coverage panel render `tr_empty` too and blur exactly the distinction
 * these assertions are about.
 */
function response(rows: TranslationJob[]): JobsResponse {
	return {
		stats: {
			byStatus: { done: 728, pending: 0, failed: 0 },
			byLocale: { nl: { pending: 0, done: 728, failed: 0 } }
		},
		jobs: rows,
		jobsLimit: 200,
		jobsTotal: rows.length
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/** The jobs card's own empty line — NOT the coverage matrix's, which shares the class. */
function jobsEmptyText(): string {
	const card = host.querySelector('.card.table');
	expect(card, 'the jobs card never rendered — this case tests nothing').not.toBeNull();
	expect(card!.textContent, 'that is not the jobs card').toContain('tr_jobs_title');
	const empty = card!.querySelector('.empty');
	expect(empty, 'the jobs card rendered no empty line at all').not.toBeNull();
	return empty!.textContent ?? '';
}

/** Click one of the status chips and let the reload land. */
async function clickFilter(key: string) {
	const btn = [...host.querySelectorAll('.filters button')].find(
		(b) => b.textContent?.trim() === key
	);
	expect(btn, `the ${key} chip is not on screen`).toBeDefined();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [jobs, queue, run, override]) fn.mockReset();
});

describe('/translations jobs table says which empty it means', () => {
	it('⛔ with the "Failed" filter active and no rows, says NO MATCH — not "none yet"', async () => {
		// REVERT THAT TURNS THIS RED: `{m.tr_empty()}` unconditionally. Both assertions invert at once.
		jobs.mockResolvedValueOnce(response([job('j1', 'done')]));
		await render();
		jobs.mockResolvedValueOnce(response([]));
		await clickFilter('tr_filter_failed');

		// The chip really is active and really did re-query with the filter — otherwise the branch
		// under test was never entered.
		expect(jobs).toHaveBeenCalledTimes(2);
		expect(jobs.mock.calls[1]![0]).toEqual({ status: 'failed' });

		const text = jobsEmptyText();
		expect(text, 'the filtered empty state is missing').toContain('tr_empty_filtered');
		expect(
			text,
			'the table claimed there are no translation jobs at all, beside a matrix counting 728'
		).not.toContain('tr_empty:');
		expect(text.trim()).not.toBe('tr_empty');
		// …and the contradiction it used to sit next to is genuinely on screen, so this is the real
		// pairing and not a fixture that made the case easy.
		expect(host.querySelector('.cov')?.textContent).toContain('728');
	});

	it('⛔ …and the same for "Pending" and "Done"', async () => {
		for (const [chip, status] of [
			['tr_filter_pending', 'pending'],
			['tr_filter_done', 'done']
		] as const) {
			jobs.mockResolvedValueOnce(response([job('j1', 'done')]));
			await render();
			jobs.mockResolvedValueOnce(response([]));
			await clickFilter(chip);
			expect(jobs.mock.calls.at(-1)![0]).toEqual({ status });
			expect(jobsEmptyText(), `${chip} rendered the wrong empty`).toContain('tr_empty_filtered');

			unmount(app!);
			app = null;
			host.remove();
			host = document.createElement('div');
			document.body.appendChild(host);
			jobs.mockReset();
		}
	});

	it('with NO filter and no rows, keeps the original "no translation jobs yet"', async () => {
		// ⛔ THE COMPLEMENT, AND THE REASON THIS IS A CHOICE RATHER THAN A RENAME. A brand-new
		// workspace really has no jobs, and "nothing matches this filter" would be nonsense there —
		// there is no filter. A fix that replaced the sentence outright would pass every case above.
		jobs.mockResolvedValue(response([]));
		await render();

		expect(jobs.mock.calls[0]![0], 'a filter leaked into the unfiltered load').toEqual({});
		const text = jobsEmptyText();
		expect(text).toContain('tr_empty');
		expect(text).not.toContain('tr_empty_filtered');
	});

	it('going back to "All" restores the original sentence', async () => {
		// The choice is driven by the LIVE filter, not by a flag set once when a chip was first
		// clicked — a sticky version would leave "nothing matches this filter" over an unfiltered view.
		jobs.mockResolvedValueOnce(response([job('j1', 'done')]));
		await render();
		jobs.mockResolvedValueOnce(response([]));
		await clickFilter('tr_filter_failed');
		expect(jobsEmptyText()).toContain('tr_empty_filtered');

		jobs.mockResolvedValueOnce(response([]));
		await clickFilter('tr_filter_all');
		expect(jobs.mock.calls.at(-1)![0]).toEqual({});
		const text = jobsEmptyText();
		expect(text).toContain('tr_empty');
		expect(text).not.toContain('tr_empty_filtered');
	});

	it('with rows present, neither empty sentence is rendered', async () => {
		// Non-vacuity for the whole file: the jobs card must be capable of rendering rows, or the
		// "empty" assertions above are about a table that never works.
		jobs.mockResolvedValue(response([job('j1', 'failed'), job('j2', 'done')]));
		await render();

		const card = host.querySelector('.card.table')!;
		expect(card.querySelectorAll('.trow')).toHaveLength(2);
		expect(card.querySelector('.empty')).toBeNull();
	});
});
