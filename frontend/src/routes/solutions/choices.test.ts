// src/routes/solutions/choices.test.ts — the challenge selector must offer every challenge, or say
// out loud that it does not.
//
// THE DEFECT: one `challengesApi.list({sort:'top'})` call, a route that pages at ten, and sixteen
// challenges in prod → six leaderboards with no way to select them and nothing on screen admitting
// it. `loadAllChoices` takes an injected fetcher precisely so this arithmetic is provable without a
// network round trip.
import { describe, it, expect, vi } from 'vitest';
import { loadAllChoices, MAX_CHOICE_PAGES, type ChoicePage } from './choices';

const PAGE_SIZE = 10;

/** A fake backend holding `total` rows, served ten at a time exactly like `GET /api/challenges`. */
function backend(total: number) {
	const all = Array.from({ length: total }, (_, i) => ({ id: `ch-${i + 1}` }));
	return vi.fn(
		async (page: number): Promise<ChoicePage<{ id: string }>> => ({
			items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
			total,
			page,
			pageSize: PAGE_SIZE
		})
	);
}

describe('loadAllChoices', () => {
	it('pages until it holds EVERY challenge, not just the first page', async () => {
		const fetchPage = backend(16); // prod's real number on the day this was written
		const res = await loadAllChoices(fetchPage);

		expect(res.items).toHaveLength(16);
		expect(res.total).toBe(16);
		expect(res.capped).toBe(false);
		// The six rows the old single-call version could never reach.
		expect(res.items.map((c) => c.id)).toContain('ch-11');
		expect(res.items.map((c) => c.id)).toContain('ch-16');
		expect(fetchPage).toHaveBeenCalledTimes(2);
	});

	it('stops as soon as it has the whole set — it does not walk to the cap', async () => {
		const fetchPage = backend(7);
		const res = await loadAllChoices(fetchPage);
		expect(res.items).toHaveLength(7);
		expect(res.capped).toBe(false);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it('REPORTS truncation when the cap stops it short, and reports the SERVER total', async () => {
		const total = MAX_CHOICE_PAGES * PAGE_SIZE + 5; // 205 — one page beyond the ceiling
		const fetchPage = backend(total);
		const res = await loadAllChoices(fetchPage);

		expect(fetchPage).toHaveBeenCalledTimes(MAX_CHOICE_PAGES);
		expect(res.items).toHaveLength(MAX_CHOICE_PAGES * PAGE_SIZE);
		// `capped` is the whole point: silently returning 200 of 205 is the bug, one order of
		// magnitude further out. A version that always returned `false` fails right here.
		expect(res.capped).toBe(true);
		// …and it must carry the REAL total, so the page can name the number the reader is missing.
		expect(res.total).toBe(total);
		expect(res.total).toBeGreaterThan(res.items.length);
	});

	it('honours a lower cap (the ceiling is a parameter, not a hard-coded 20)', async () => {
		const fetchPage = backend(50);
		const res = await loadAllChoices(fetchPage, 2);
		expect(fetchPage).toHaveBeenCalledTimes(2);
		expect(res.items).toHaveLength(20);
		expect(res.capped).toBe(true);
	});

	it('treats an empty page as the end of the list even when `total` disagrees', async () => {
		// A list that shrinks mid-walk (a challenge deleted between pages) must not spin to the cap
		// and must not be reported as truncated — there is nothing left to fetch.
		const fetchPage = vi.fn(async (page: number) => ({
			items: page === 1 ? [{ id: 'a' }, { id: 'b' }] : [],
			total: 99,
			page,
			pageSize: PAGE_SIZE
		}));
		const res = await loadAllChoices(fetchPage);
		expect(fetchPage).toHaveBeenCalledTimes(2);
		expect(res.items).toHaveLength(2);
		expect(res.capped).toBe(false);
	});

	it('survives an empty backend', async () => {
		const res = await loadAllChoices(backend(0));
		expect(res).toEqual({ items: [], total: 0, capped: false });
	});

	describe('seeded with an already-fetched page 1', () => {
		// The caller fetches page 1 itself so it can act on it immediately (pick the default
		// challenge, start the board) and hands it back here to finish the walk in the background.
		// If the seed were ignored, page 1 would be fetched TWICE and the saved round-trip — the
		// entire point — would be spent again.
		it('resumes at page 2 and never re-fetches the page it was given', async () => {
			const fetchPage = backend(16);
			const first = await fetchPage(1);
			fetchPage.mockClear();

			const res = await loadAllChoices(fetchPage, MAX_CHOICE_PAGES, first);

			expect(res.items).toHaveLength(16);
			expect(res.items.map((c) => c.id)).toContain('ch-1');
			expect(res.items.map((c) => c.id)).toContain('ch-16');
			expect(res.capped).toBe(false);
			expect(fetchPage).toHaveBeenCalledTimes(1);
			expect(fetchPage).toHaveBeenCalledWith(2);
		});

		it('issues NO request at all when the seed already holds the whole set', async () => {
			const fetchPage = backend(7);
			const first = await fetchPage(1);
			fetchPage.mockClear();

			const res = await loadAllChoices(fetchPage, MAX_CHOICE_PAGES, first);
			expect(res).toEqual({ items: first.items, total: 7, capped: false });
			expect(fetchPage).not.toHaveBeenCalled();
		});

		it('still counts the seed against the cap, so the ceiling stays a ceiling on requests', async () => {
			// 205 rows: the unseeded walk fetches pages 1…20 and offers 200. Seeding must produce the
			// SAME 200 (pages 2…20 fetched), not 210 — the cap exists to bound requests per load.
			const fetchPage = backend(205);
			const first = await fetchPage(1);
			fetchPage.mockClear();

			const res = await loadAllChoices(fetchPage, MAX_CHOICE_PAGES, first);
			expect(res.items).toHaveLength(MAX_CHOICE_PAGES * PAGE_SIZE);
			expect(res.total).toBe(205);
			expect(res.capped).toBe(true);
			expect(fetchPage).toHaveBeenCalledTimes(MAX_CHOICE_PAGES - 1);
		});
	});
});
