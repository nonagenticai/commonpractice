// src/lib/api/datasets.ts — typed client for the Datasets API (Phase 2.0). Upload a
// CSV/Excel file (multipart) or paste text/JSON/SQL-result (JSON body); list/preview;
// edit columns + rescope; delete. Mirrors the sandboxes client (authFetch + unwrap).
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type {
	DatasetColumn,
	DatasetCreated,
	DatasetDetail,
	DatasetList,
	DatasetMapping,
	DatasetRow,
	DatasetSourceType,
	SaveMappingInput,
	SuggestMappingsResponse
} from '$lib/types/datasets';

export { ApiError };

async function unwrap<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = parseBody(text);
	if (!res.ok) {
		// `detailsFrom` forwards the offender's name to the localized catalog — see the ⛔ block on
		// `ApiError` (./blocks). Every sibling `unwrap` in this directory carries the same line.
		throw new ApiError(
			res.status,
			body?.error ?? 'error',
			body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
			detailsFrom(body)
		);
	}
	return body as T;
}

export interface ListDatasetParams {
	q?: string;
	sandbox?: string;
	page?: number;
}

// ---- paging the WHOLE list, for the screens that offer datasets as CHOICES ----
//
// THE DEFECT: `GET /api/datasets` pages at twelve (backend/src/routes/datasets.ts's `PAGE_SIZE`) and
// every screen that offers datasets as CHOICES fetched page 1, took `.items` and threw `total` away.
// So a workspace with thirteen datasets could not attach the thirteenth to anything, and nothing on
// screen said the list was short. Three of the call sites are fixed here — /submit, the
// challenge-detail data editor and /ontology's test-data picker — and the builder's node-config
// dropdown (`lib/components/build/`) is being fixed alongside them; both use this walker.
//
// /ontology was the worst of them: its `bindableDatasets` subtracts the already-bound rows from those
// twelve, so once the first twelve were bound the picker DISAPPEARED and read as "you have no
// datasets".
//
// This mirrors `src/routes/solutions/choices.ts` — same walk, same termination rules, same `capped`
// contract — deliberately COPIED rather than imported: that module belongs to a route, and a `$lib`
// client importing from `src/routes/**` inverts the dependency direction (every consumer of this
// client would then drag the /solutions page's module graph in with it). The two must not drift; the
// shared shape is small enough to read side by side, and both are covered by their own test.
//
// ⚠️ AND IT REPORTS ITS OWN CEILING. `capped` is not decoration: silently truncating is the exact
// defect above, so a walk that stops short must be able to SAY so and the caller must render it.

/**
 * The two fields of a `{items,total,page,pageSize,…}` list response the walk actually reads. Narrower
 * than `DatasetList` on purpose: the test's fake backend then has to supply only what the arithmetic
 * depends on, rather than a `canManage` the walk never looks at.
 */
export interface DatasetPage {
	items: DatasetRow[];
	total: number;
}

export interface AllDatasets {
	items: DatasetRow[];
	/** The server's own total for the query — may exceed `items.length` when `capped`. */
	total: number;
	/** True when the cap stopped the walk before the whole set was collected. */
	capped: boolean;
}

/**
 * Hard ceiling on requests, so a bad `total` (or a list that grows while we walk it) can never turn a
 * page load into an unbounded request loop. 20 pages × the backend's page size of 12 = 240 datasets,
 * far past any workspace today — and the pickers say so out loud when it is not enough.
 */
export const MAX_DATASET_PAGES = 20;

/**
 * Page `fetchPage` until the full set is collected, the cap is hit, or a page comes back empty.
 *
 * Takes an INJECTED page fetcher rather than calling `datasetsApi.list` directly, so the arithmetic
 * is provable without a network, a Keycloak token, or a mock of the whole client — the same reason
 * `loadAllChoices` takes one.
 *
 * @param fetchPage 1-based page fetcher.
 * @param maxPages  request ceiling; defaults to `MAX_DATASET_PAGES`.
 */
export async function pageAllDatasets(
	fetchPage: (page: number) => Promise<DatasetPage>,
	maxPages: number = MAX_DATASET_PAGES
): Promise<AllDatasets> {
	const items: DatasetRow[] = [];
	let total = 0;

	for (let page = 1; page <= maxPages; page++) {
		const res = await fetchPage(page);
		total = res.total;
		items.push(...res.items);
		// An empty page is the end of the list even when `total` disagrees — trusting `total` alone
		// would spin `maxPages` times against a route whose count and rows can differ mid-walk (a
		// dataset deleted between two requests).
		if (res.items.length === 0) return { items, total, capped: false };
		if (items.length >= total) return { items, total, capped: false };
	}

	// Cap reached with rows still outstanding. `total` is the SERVER's, so the notice the page renders
	// names the real number, not the number we managed to fetch.
	return { items, total, capped: items.length < total };
}

export interface PasteDatasetInput {
	name: string;
	sourceType: Extract<DatasetSourceType, 'csv' | 'json' | 'text' | 'sql'>;
	content: string;
	sandboxId?: string | null;
}

export const datasetsApi = {
	async list(params: ListDatasetParams = {}): Promise<DatasetList> {
		const qs = new URLSearchParams();
		if (params.q) qs.set('q', params.q);
		if (params.sandbox) qs.set('sandbox', params.sandbox);
		if (params.page && params.page > 1) qs.set('page', String(params.page));
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/datasets${suffix}`));
	},

	/**
	 * Every dataset matching `params`, not just the first page of twelve.
	 *
	 * ⛔ `list()` IS LEFT ALONE. /datasets is a paged BROWSE screen with a Pager under it and must keep
	 * receiving one page at a time; this is for the screens that render the list as a set of CHOICES,
	 * where a page boundary is not a scroll position but a dataset the reader cannot pick.
	 */
	async listAll(
		params: Omit<ListDatasetParams, 'page'> = {},
		maxPages: number = MAX_DATASET_PAGES
	): Promise<AllDatasets> {
		// `datasetsApi.list`, not `this.list` — `const { listAll } = datasetsApi` is a shape every
		// caller here is free to write, and a `this` that depended on the call site would break it.
		return pageAllDatasets((page) => datasetsApi.list({ ...params, page }), maxPages);
	},

	async get(slug: string, opts: { offset?: number; limit?: number } = {}): Promise<DatasetDetail> {
		const qs = new URLSearchParams();
		if (opts.offset) qs.set('offset', String(opts.offset));
		if (opts.limit) qs.set('limit', String(opts.limit));
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/datasets/${encodeURIComponent(slug)}${suffix}`));
	},

	async uploadFile(file: File, name?: string): Promise<DatasetCreated> {
		const form = new FormData();
		form.append('file', file);
		if (name) form.append('name', name);
		return unwrap(await authFetch('/api/datasets', { method: 'POST', body: form }));
	},

	async paste(input: PasteDatasetInput): Promise<DatasetCreated> {
		return unwrap(
			await authFetch('/api/datasets', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			})
		);
	},

	async update(
		slug: string,
		patch: { name?: string; columns?: DatasetColumn[]; sandboxId?: string | null }
	): Promise<DatasetRow> {
		return unwrap(
			await authFetch(`/api/datasets/${encodeURIComponent(slug)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			})
		);
	},

	async remove(slug: string): Promise<void> {
		await unwrap(await authFetch(`/api/datasets/${encodeURIComponent(slug)}`, { method: 'DELETE' }));
	},

	// ---- Phase 3.3: ontology mapping ----
	async listMappings(slug: string): Promise<{ mappings: DatasetMapping[] }> {
		return unwrap(await authFetch(`/api/datasets/${encodeURIComponent(slug)}/mappings`));
	},

	async suggestMappings(
		slug: string,
		body: { industry: string; department: string; useLlm?: boolean }
	): Promise<SuggestMappingsResponse> {
		return unwrap(
			await authFetch(`/api/datasets/${encodeURIComponent(slug)}/mappings/suggest`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
	},

	async saveMappings(slug: string, mappings: SaveMappingInput[]): Promise<{ mappings: DatasetMapping[] }> {
		return unwrap(
			await authFetch(`/api/datasets/${encodeURIComponent(slug)}/mappings`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mappings })
			})
		);
	},

	async deleteMapping(slug: string, entityId: string): Promise<void> {
		await unwrap(
			await authFetch(`/api/datasets/${encodeURIComponent(slug)}/mappings/${encodeURIComponent(entityId)}`, {
				method: 'DELETE'
			})
		);
	}
};
