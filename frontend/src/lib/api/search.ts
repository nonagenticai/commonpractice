// src/lib/api/search.ts — typed client for the global topbar search (GET /api/search).
// Tenant-scoped on the server; returns up to 5 matches per group.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';

export { ApiError };

export interface SearchChallenge {
	id: string;
	title: string;
	code: string | null;
}
export interface SearchSolution {
	id: string;
	title: string;
}
export interface SearchBlock {
	slug: string;
	name: string;
}
export interface SearchResults {
	q: string;
	challenges: SearchChallenge[];
	solutions: SearchSolution[];
	blocks: SearchBlock[];
}

/**
 * Is this the envelope `SearchResults` promises, all the way down?
 *
 * ⛔ WHY A 200 NEEDS A GUARD AT ALL, given every sibling client just casts. `Topbar.svelte` is the
 * only consumer, it is CHROME — it renders on all 24 screens and the reader cannot navigate away
 * from it — and it maps all three arrays inside a `$derived`:
 *
 *     const hits = $derived(results ? [...results.challenges.map(…), …] : []);
 *
 * A `$derived` that throws is not a caught error; it kills the reactive update. Measured on a 200
 * whose body is `{ q: 'schade' }`: `TypeError: Cannot read properties of undefined (reading 'map')`,
 * and because the throw happens during the re-render AFTER the `finally` that would have cleared
 * `loading`, the dropdown FREEZES on "Zoeken…" for the rest of the session. A `null` body renders a
 * blank dropdown instead. Neither reaches the `catch` in `runSearch`, so neither reaches the
 * failure copy that catch now exists to show — this is the one remaining path where the topbar
 * still answers a search it could not perform with something other than "it failed".
 *
 * ⚠️ STRICT ON ENTRIES TOO, WHICH IS A DELIBERATE SPLIT FROM `data-findings.ts:63` AND
 * `graph-issues.ts:69`. Those drop malformed entries and keep the rest, because a findings list
 * missing one row is still a useful findings list. A SEARCH result is a claim about what the
 * workspace contains: silently dropping a hit turns "we could not read the answer" into "there is
 * no such thing", which is the exact lie the commit that introduced `searchDenied` was written to
 * stop telling. Half an answer here is indistinguishable from a complete one, so there is no honest
 * way to serve it.
 */
function isSearchResults(v: unknown): v is SearchResults {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	const o = v as Record<string, unknown>;
	if (typeof o.q !== 'string') return false;
	const every = (raw: unknown, keys: readonly string[]) =>
		Array.isArray(raw) &&
		raw.every(
			(e) =>
				typeof e === 'object' &&
				e !== null &&
				keys.every((k) => typeof (e as Record<string, unknown>)[k] === 'string')
		);
	// `code` is `string | null` on SearchChallenge, so it is not in the required set — an absent or
	// null code is a real challenge, not a malformed one.
	return (
		every(o.challenges, ['id', 'title']) &&
		every(o.solutions, ['id', 'title']) &&
		every(o.blocks, ['slug', 'name'])
	);
}

export const searchApi = {
	async query(q: string, signal?: AbortSignal): Promise<SearchResults> {
		const res = await authFetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
		// This was a bare `Error('search failed: 403')`, the only typed client that DISCARDED the
		// backend's machine-readable `error` code — which made the topbar-search permission failure
		// the one 403 in the app that could never be mapped to localized copy. Mirror the siblings.
		if (!res.ok) {
			const text = await res.text();
			const body = parseBody(text);
			// `detailsFrom` forwards the offender's name to the localized catalog — see the ⛔ block on
			// `ApiError` (./blocks). Every sibling `unwrap` in this directory carries the same line.
			throw new ApiError(
				res.status,
				body?.error ?? 'error',
				body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
				detailsFrom(body)
			);
		}
		// ⛔ NOT `as SearchResults`. The cast is a promise the wire does not keep, and the one consumer
		// dies on it — see `isSearchResults`. Thrown, not defaulted to an empty result set: an empty
		// result set is an ANSWER, and this code path has none. `ApiError` so it lands in exactly the
		// same `catch` as a 403 or a 500 and reaches the same localized failure line; the status is
		// the REAL one (a 200 that could not be read is still a 200) and `licenseOrPermissionMessage`
		// matches none of 402/403/409/503, so `errorText` falls through to `m.error_load_failed()`.
		const body: unknown = await res.json();
		if (!isSearchResults(body)) {
			// ⛔ `detailsFrom(body)` IS NOT DECORATION HERE, AND CI CAUGHT ITS ABSENCE.
			// `error-message.wire.test.ts` scrapes every `new ApiError(...)` in this directory and
			// requires each one to forward the `details` bag — the exact defect that made ~20 of the
			// product's localized refusal sentences inert in production once before. A malformed body
			// is still a body: it can carry a well-formed `details` even when the top level is wrong,
			// and `detailsFrom` is total over `unknown` (it returns undefined for a non-object).
			// Dropping the argument here would have been a silent, permanent `undefined`.
			throw new ApiError(
				res.status,
				'malformed_response',
				`The search service answered ${res.status} with a body this client cannot read.`,
				detailsFrom(body)
			);
		}
		return body;
	}
};
