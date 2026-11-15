// src/lib/api/datasets.test.ts — the dataset PICKERS must offer every dataset, or say out loud that
// they do not.
//
// THE DEFECT: `GET /api/datasets` pages at twelve and every screen that offers datasets as CHOICES
// took `.items` off page 1 and dropped `total`. The three guarded below are /submit, the
// challenge-detail data editor and /ontology's test-data picker (the builder's node-config dropdown
// is the fourth and is fixed in its own lane). The thirteenth dataset could not be attached to
// anything and nothing on screen admitted the list was short. /ontology compounded it:
// `bindableDatasets` subtracts the already-bound rows from those twelve, so once the first twelve
// were bound the picker vanished entirely and read as "you have no datasets".
//
// `pageAllDatasets` takes an injected fetcher precisely so this arithmetic is provable without a
// network round trip — same reason, same shape, as routes/solutions/choices.test.ts.
import { describe, it, expect, vi } from 'vitest';

// ⛔ `authFetch` IS THE ONE BROWSER-ONLY IMPORT IN THIS MODULE'S CHAIN (it pulls the keycloak client
// in), so it is mocked away and no jsdom is needed — the same construction as `solutions.create.test.ts`.
// Nothing here calls it: `pageAllDatasets` takes an injected fetcher precisely so the walk is provable
// without a request. The mock exists to make the IMPORT resolvable, not to record calls.
// ⛔ The ALIAS id `$lib/api/auth-fetch`, never a relative specifier — `mock-specifiers.test.ts`
// enforces it.
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { pageAllDatasets, MAX_DATASET_PAGES, type DatasetPage } from './datasets';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readSource, stripComments } from '$lib/test/source-scan';
import type { DatasetRow } from '$lib/types/datasets';

/** The backend's real page size for this route (backend/src/routes/datasets.ts's `PAGE_SIZE`). */
const PAGE_SIZE = 12;

function row(n: number): DatasetRow {
	return {
		id: `id-${n}`,
		slug: `ds-${n}`,
		name: `Dataset ${n}`,
		sourceType: 'csv',
		columns: [],
		rowCount: 0,
		sizeBytes: 0,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	};
}

/** A fake backend holding `total` datasets, served twelve at a time like `GET /api/datasets`. */
function backend(total: number) {
	const all = Array.from({ length: total }, (_, i) => row(i + 1));
	return vi.fn(
		async (page: number): Promise<DatasetPage> => ({
			items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
			total
		})
	);
}

describe('pageAllDatasets', () => {
	it('pages until it holds EVERY dataset, not just the first twelve', async () => {
		const fetchPage = backend(13); // one past the page size — the smallest workspace that broke
		const res = await pageAllDatasets(fetchPage);

		expect(res.items).toHaveLength(13);
		expect(res.total).toBe(13);
		expect(res.capped).toBe(false);
		// The row the old `list({ page: 1 }).items` could never reach, on any of the four screens.
		expect(res.items.map((d) => d.slug)).toContain('ds-13');
		expect(fetchPage).toHaveBeenCalledTimes(2);
	});

	it('stops as soon as it has the whole set — it does not walk to the cap', async () => {
		const fetchPage = backend(5);
		const res = await pageAllDatasets(fetchPage);
		expect(res.items).toHaveLength(5);
		expect(res.capped).toBe(false);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it('REPORTS truncation when the cap stops it short, and reports the SERVER total', async () => {
		const total = MAX_DATASET_PAGES * PAGE_SIZE + 5; // 245 — one page beyond the ceiling
		const fetchPage = backend(total);
		const res = await pageAllDatasets(fetchPage);

		expect(fetchPage).toHaveBeenCalledTimes(MAX_DATASET_PAGES);
		expect(res.items).toHaveLength(MAX_DATASET_PAGES * PAGE_SIZE);
		// `capped` is the whole point: silently returning 240 of 245 is the same bug one order of
		// magnitude further out. A version that always returned `false` fails right here.
		expect(res.capped).toBe(true);
		// …and it must carry the REAL total, so the picker can name the number the reader is missing.
		expect(res.total).toBe(total);
		expect(res.total).toBeGreaterThan(res.items.length);
	});

	it('honours a lower cap (the ceiling is a parameter, not a hard-coded 20)', async () => {
		const fetchPage = backend(100);
		const res = await pageAllDatasets(fetchPage, 2);
		expect(fetchPage).toHaveBeenCalledTimes(2);
		expect(res.items).toHaveLength(24);
		expect(res.capped).toBe(true);
	});

	it('treats an empty page as the end of the list even when `total` disagrees', async () => {
		// A list that shrinks mid-walk (a dataset deleted between two requests) must not spin to the
		// cap and must not be reported as truncated — there is nothing left to fetch.
		const fetchPage = vi.fn(async (page: number) => ({
			items: page === 1 ? [row(1), row(2)] : [],
			total: 99
		}));
		const res = await pageAllDatasets(fetchPage);
		expect(fetchPage).toHaveBeenCalledTimes(2);
		expect(res.items).toHaveLength(2);
		expect(res.capped).toBe(false);
	});

	it('survives an empty workspace', async () => {
		const res = await pageAllDatasets(backend(0));
		expect(res).toEqual({ items: [], total: 0, capped: false });
	});
});

// ---- the CALL SITES, not just the arithmetic ----
//
// ⛔ THE WALKER PASSING PROVES NOTHING ON ITS OWN. `pageAllDatasets` is new code; a test of new code
// passes on the branch that introduced it by construction. The defect was never in the arithmetic —
// it was three screens that asked for page 1 and rendered the answer as if it were the whole list.
// A unit test of the helper is exactly the "green that proves nothing" this repo keeps shipping, so
// the fix is pinned where it actually lives: in the source of the screens that offer datasets as
// CHOICES.
//
// ⚠️ AND IT ASSERTS BOTH SIDES. Absence of `datasetsApi.list(` alone would pass on a file that had
// simply deleted the fetch; presence of `listAll(` alone would pass on a file that called both. The
// pair is what says "this screen offers the whole list, and there is no page-1 read left behind it".
//
// ⚠️ `.list(` WITH THE PAREN, deliberately: `listAll(` contains the substring `list`, so a bare
// `.list` test would fail against its own fix.
//
// ⚠️ AND THROUGH `readSource`, WHICH STRIPS COMMENTS. Every one of these three files documents the
// call it no longer makes — `⛔ WAS datasetsApi.list({ page: 1 })` — and this codebase documents WHY
// a guard exists AT the guard, so the prose is not optional. Scanning raw text would red on the
// comment describing the fix, and the obvious "fix" for that (deleting the sentence) is the wrong
// direction. `lib/test/source-scan.ts` exists for exactly this, and its header carries the five
// measured evasions that shaped it — including counting occurrences rather than testing the first.
// ⛔ DERIVED, NOT TYPED OUT — the hand-written version of this list named THREE files while six
// production files call `listAll`, so the two assertions below were unenforced for half the
// consumers and a seventh screen added tomorrow would have joined nothing. That is the same defect
// this file's `GROUPED` header describes, committed one section further down. A reviewer caught it;
// the list now comes from a scan, and the floor makes the scan itself non-vacuous.
function choiceScreens(): string[] {
	const roots = ['src/routes', 'src/lib/components'];
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) walk(p);
			else if (entry.endsWith('.svelte') && stripComments(readFileSync(p, 'utf8')).includes('datasetsApi.listAll('))
				out.push(relative('src', p).split(sep).join('/'));
		}
	};
	for (const r of roots) walk(r);
	return out.sort();
}

const CHOICE_SCREENS = choiceScreens();

const count = (src: string, needle: string): number => src.split(needle).length - 1;

describe('the screens that offer datasets as choices page the WHOLE list', () => {
	it('⛔ the scan found the screens — an empty list would make every case below vacuous', () => {
		// Six files call `listAll` today: three routes and the three build-canvas panels. A floor
		// rather than an exact pin, so ADDING a choice screen is not a red — but deleting the scan's
		// input, or breaking the walk, is.
		expect(CHOICE_SCREENS.length, `the listAll scan found ${CHOICE_SCREENS.join(', ') || 'nothing'}`)
			.toBeGreaterThanOrEqual(6);
	});

	for (const rel of CHOICE_SCREENS) {
		it(`${rel} calls datasetsApi.listAll and never datasetsApi.list(`, () => {
			const src = readSource(rel);
			// Non-vacuity: a typo'd path, or an over-eager strip, would make every assertion below
			// trivially true against an empty string. `readSource` throws on a missing file, so this
			// anchors the CONTENT rather than the read.
			expect(src, `${rel} scanned to nothing — the guard would pass on an empty string`).toContain(
				'datasetsApi'
			);
			// `datasetsApi.get(` (the per-dataset preview) is untouched and must stay — only the LIST
			// read is the defect.
			expect(
				count(src, 'datasetsApi.list('),
				`${rel} still fetches ONE page of datasets. GET /api/datasets pages at 12, so every ` +
					`dataset from the 13th on is missing from this screen's picker, with nothing on screen ` +
					`saying the list is short.`
			).toBe(0);
			// EXACTLY once, not "at least once": a file that kept a page-1 read alongside the walk would
			// satisfy a `toContain` and still render whichever list landed last.
			expect(count(src, 'datasetsApi.listAll(')).toBe(1);
			// The walk can still stop at its ceiling, and when it does the screen has to SAY so —
			// silently truncating one order of magnitude further out is the same bug.
			expect(count(src, 'm.datasets_picker_capped(')).toBe(1);
		});
	}
});
