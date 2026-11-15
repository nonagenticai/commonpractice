// src/routes/solutions/choices.ts — the challenge selector's option set.
//
// THE DEFECT: `/solutions` built its `<select>` from a single `challengesApi.list({ sort: 'top' })`
// call. That route pages at ten, so with sixteen challenges in prod six leaderboards had no way to
// be selected at all — the board they name is only reachable via `/challenges` → detail →
// "view leaderboard". The selector silently showed ten and said nothing.
//
// This module pages until it has the whole set. It takes an INJECTED page fetcher rather than
// importing `challengesApi`, so its paging arithmetic is testable without a network, a Keycloak
// token, or a mock of the whole API client.
//
// ⚠️ AND IT REPORTS ITS OWN CEILING. `capped` is not diagnostic decoration: silently truncating is
// the exact defect being fixed, so a truncation at the page cap must be *visible* to the reader
// (the page renders a note naming the true total and pointing at /challenges). A version of this
// module that returned `{ capped: false }` unconditionally would reintroduce the bug one order of
// magnitude further out.

/** The shape every paged list route in this backend returns (`{items,total,page,pageSize}`). */
export interface ChoicePage<T> {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
}

export interface ChoicesResult<T> {
	items: T[];
	/** The server's own total for the query — may exceed `items.length` when `capped`. */
	total: number;
	/** True when the cap stopped paging before the whole set was collected. */
	capped: boolean;
}

/**
 * Hard ceiling on requests, so a bad `total` (or a list that grows while we walk it) can never turn
 * a page load into an unbounded request loop. 20 pages × the backend's page size of 10 = 200
 * challenges, ~12× today's whole corpus.
 */
export const MAX_CHOICE_PAGES = 20;

/**
 * Page `fetchPage` until the full set is collected, the cap is hit, or a page comes back empty.
 *
 * @param fetchPage 1-based page fetcher.
 * @param maxPages  request ceiling; defaults to `MAX_CHOICE_PAGES`.
 * @param firstPage an ALREADY-FETCHED page 1, so the caller can act on it (pick a default
 *   selection, start loading the board) before the rest of the walk finishes. Passing it seeds the
 *   walk at page 2 — the page is never fetched twice, and `maxPages` still counts it, so the
 *   ceiling stays a ceiling on requests-per-load either way. Omitted → the walk fetches page 1
 *   itself, the original behaviour.
 */
export async function loadAllChoices<T>(
	fetchPage: (page: number) => Promise<ChoicePage<T>>,
	maxPages: number = MAX_CHOICE_PAGES,
	firstPage?: ChoicePage<T>
): Promise<ChoicesResult<T>> {
	const items: T[] = [];
	let total = 0;

	if (firstPage) {
		total = firstPage.total;
		items.push(...firstPage.items);
		if (firstPage.items.length === 0 || items.length >= total) return { items, total, capped: false };
	}

	for (let page = firstPage ? 2 : 1; page <= maxPages; page++) {
		const res = await fetchPage(page);
		total = res.total;
		items.push(...res.items);
		// An empty page is the end of the list even when `total` disagrees — trusting `total` alone
		// would spin `maxPages` times against a route whose count and rows can differ mid-walk.
		if (res.items.length === 0) return { items, total, capped: false };
		if (items.length >= total) return { items, total, capped: false };
	}

	// Cap reached with rows still outstanding. `total` is the server's, so the note the page renders
	// names the REAL number, not the number we managed to fetch.
	return { items, total, capped: items.length < total };
}
