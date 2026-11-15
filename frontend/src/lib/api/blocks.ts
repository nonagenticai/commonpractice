// src/lib/api/blocks.ts — typed client for /api/blocks over authFetch.
// Thin per-resource module (fr's nested-resource shape, trimmed). Throws
// ApiError on non-2xx so callers can show the backend's error code/message.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { writeErrorText } from './error-message';
import { parseBlock } from '$lib/services/sse';
import * as m from '$lib/paraglide/messages';
import type {
	BlockDescriptor,
	BlockDetail,
	BlockExample,
	BlockListItem,
	BlockVersion,
	BlockCategory,
	ScanFinding,
	BlockTest,
	CreateBlockTestBody,
	BlockTestOutcome,
	BlockTestRunSummary,
	LintResult,
	SimulateResult
} from '$lib/types/blocks';

/**
 * The error every typed client throws on a non-2xx. Eighteen of the twenty api modules import THIS
 * class (the four-way duplication with ./admin, ./llm-settings and ./delivery is older than this
 * change and is not touched by it); `SolutionApiError` extends it.
 *
 * ⛔ `details` WAS MISSING FOR THE WHOLE OF THE REFUSAL-LOCALIZATION LANE, AND THE COST WAS THE LANE.
 * The backend puts the offender's NAME in `details` — `{ attribute }`, `{ slug }`, `{ name }`,
 * `{ reason }`, `{ limitMb }` — and about twenty `VALIDATION_MESSAGES` entries (./error-message) are
 * built to interpolate exactly that. `writeErrorText` reads it with `detailsOf(e)`. This class had
 * no such field, so every `unwrap` in the fleet read `body.error` and `body.message` and dropped
 * `body.details` on the floor: `detailsOf()` was ALWAYS `undefined`, every name-requiring entry
 * correctly declined (its `null` contract), and all twenty sentences fell through to the backend's
 * English. The wire carried the value, the catalog asked for it, and the class in between silently
 * dropped it.
 *
 * ⛔ AND IT WAS INVISIBLE TO 2054 GREEN TESTS, WHICH IS THE HALF WORTH REMEMBERING. The unit tests
 * for those entries hand-build `{ status, code, message, details }` object literals — a shape this
 * client could not produce — so they proved the catalog's arithmetic and never the wire that feeds
 * it. Measured in a real browser on /ontology: two attributes named `auteur` → Opslaan →
 * `Attribute 'auteur' is listed more than once`, in English, to a Dutch tenant. `error-message.wire.
 * test.ts` is the guard that closes that gap: it goes through the REAL `unwrap` from a real
 * `Response`, so a client that stops forwarding `details` reds instead of quietly re-anglicising.
 *
 * ⚠️ OPTIONAL, AND IT MUST STAY OPTIONAL. An OLD POD ships these codes with no `details` at all —
 * the browser reaches the API through the Service, so a new bundle really is answered by an old pod
 * for the length of a roll. That path degrades to the English sentence, which still NAMES the
 * offender. See `ValidationCopy` in ./error-message for why that is the doctrine, not a fallback.
 *
 * ⚠️ `details` SITS AT POSITION 4 AND `findings` MOVED TO 5, on purpose: the other three ApiError
 * copies take `details` fourth, and one shared position across four classes is what stops a future
 * `unwrap` from passing the bag into the wrong slot. `findings` is read by NAME everywhere
 * (`routes/block-edit/+page.svelte`), and this file holds its only construction site, so the swap
 * is local. `findings` is the lint/scan payload, NOT a `details` field — see `scan-finding-label.ts`.
 */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: Record<string, unknown>,
		readonly findings?: ScanFinding[]
	) {
		super(message);
		this.name = 'ApiError';
	}
}

async function unwrap<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = parseBody(text);
	if (!res.ok) {
		// `detailsFrom` forwards the offender's name to the localized catalog — see the ⛔ block on
		// `ApiError`. Every sibling `unwrap` in this directory carries the same line.
		throw new ApiError(
			res.status,
			body?.error ?? 'error',
			body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
			detailsFrom(body),
			body?.findings
		);
	}
	return body as T;
}

export interface ListParams {
	category?: BlockCategory | 'all';
	status?: string;
	sort?: 'usage' | 'recent' | 'alpha';
	q?: string;
}

export interface CreateBlockBody {
	slug: string;
	name: string;
	description?: string;
	category: BlockCategory;
	region?: string;
	cost_class?: string;
	license?: string;
	docs_md?: string;
	source_ts?: string;
	descriptor?: BlockDescriptor;
}

export interface SaveVersionBody {
	docs_md?: string;
	source_ts?: string;
	descriptor?: BlockDescriptor;
	examples?: BlockExample[];
	changelog?: string;
}

export interface TestStreamHandlers {
	onResult: (o: BlockTestOutcome) => void;
	onSummary: (s: BlockTestRunSummary) => void;
	onError?: (message: string) => void;
	onEnd?: () => void;
}

export const blocksApi = {
	async list(params: ListParams = {}): Promise<{ items: BlockListItem[]; total: number }> {
		const qs = new URLSearchParams();
		if (params.category && params.category !== 'all') qs.set('category', params.category);
		if (params.status) qs.set('status', params.status);
		if (params.sort) qs.set('sort', params.sort);
		if (params.q) qs.set('q', params.q);
		const suffix = qs.toString() ? `?${qs}` : '';
		return unwrap(await authFetch(`/api/blocks${suffix}`));
	},

	async get(slug: string): Promise<BlockDetail> {
		return unwrap(await authFetch(`/api/blocks/${encodeURIComponent(slug)}`));
	},

	async create(body: CreateBlockBody): Promise<{ block: BlockDetail; version: BlockVersion }> {
		return unwrap(
			await authFetch('/api/blocks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
	},

	async createVersion(
		slug: string,
		body: SaveVersionBody & { version?: string; from_version?: string } = {}
	): Promise<BlockVersion> {
		return unwrap(
			await authFetch(`/api/blocks/${encodeURIComponent(slug)}/versions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
	},

	async saveVersion(
		slug: string,
		version: string,
		patch: SaveVersionBody
	): Promise<BlockVersion> {
		return unwrap(
			await authFetch(
				`/api/blocks/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(patch)
				}
			)
		);
	},

	async publish(
		slug: string,
		version: string,
		status: 'beta' | 'stable' = 'stable'
	): Promise<BlockVersion> {
		return unwrap(
			await authFetch(
				`/api/blocks/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/publish`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ status })
				}
			)
		);
	},

	// ---- Phase 2-B: per-block tests + lint ----

	async listTests(
		slug: string,
		version?: string
	): Promise<{ items: BlockTest[]; total: number; version_id: string | null }> {
		const qs = version ? `?version=${encodeURIComponent(version)}` : '';
		return unwrap(await authFetch(`/api/blocks/${encodeURIComponent(slug)}/tests${qs}`));
	},

	async createTest(slug: string, body: CreateBlockTestBody): Promise<BlockTest> {
		return unwrap(
			await authFetch(`/api/blocks/${encodeURIComponent(slug)}/tests`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
	},

	async patchTest(
		slug: string,
		id: string,
		body: Partial<CreateBlockTestBody>
	): Promise<BlockTest> {
		return unwrap(
			await authFetch(`/api/blocks/${encodeURIComponent(slug)}/tests/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
	},

	async deleteTest(slug: string, id: string): Promise<void> {
		await unwrap(
			await authFetch(`/api/blocks/${encodeURIComponent(slug)}/tests/${encodeURIComponent(id)}`, {
				method: 'DELETE'
			})
		);
	},

	/** Delete a block (cascades its versions, tests, results). super_admin for global/platform
	 * blocks; the owning tenant's developer/admin for tenant blocks (enforced server-side). */
	async remove(slug: string): Promise<void> {
		await unwrap(
			await authFetch(`/api/blocks/${encodeURIComponent(slug)}`, { method: 'DELETE' })
		);
	},

	async runTests(
		slug: string,
		version: string,
		testId?: string
	): Promise<BlockTestRunSummary> {
		const qs = testId ? `?testId=${encodeURIComponent(testId)}` : '';
		return unwrap(
			await authFetch(
				`/api/blocks/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/test${qs}`,
				{ method: 'POST', headers: { accept: 'application/json' } }
			)
		);
	},

	/**
	 * Stream per-test results over SSE (POST). Returns a closer.
	 *
	 * ⛔ `onEnd` FIRES ON EVERY TERMINAL OUTCOME, EXACTLY ONCE — success, a non-2xx, a thrown
	 * network error, an abort. It is the ONLY signal a caller gets that the run is over, and
	 * `BlockTesting.svelte` uses it to clear the `running` flag that disables "Alle tests
	 * uitvoeren". It used to fire only on the happy path, so any failed run left the Testen tab
	 * showing "Bezig…" on a dead button for the rest of the session.
	 *
	 * ⚠️ THE GUARANTEE LIVES HERE, NOT IN THE CALLER, AND THAT IS THE POINT. The obvious repair —
	 * clear `running` in the component's `onError` too — rebuilds the same defect one layer up:
	 * two sites that must agree about when a run is finished, where forgetting one is silent. Only
	 * the producer knows the stream is over, so it says so once, from a `finally` that no future
	 * early `return` can skip.
	 *
	 * `close()` is a terminal outcome too: a caller that abandons a run is not still running it.
	 */
	streamTests(
		slug: string,
		version: string,
		handlers: TestStreamHandlers,
		testId?: string
	): { close: () => void } {
		const ac = new AbortController();
		const qs = testId ? `?testId=${encodeURIComponent(testId)}` : '';
		// The `end` frame returns early AND the reader can run dry afterwards, so "exactly once"
		// needs the latch as well as the `finally` — a doubled `onEnd` doubles the list reload it
		// triggers in the Testing tab.
		let ended = false;
		const finish = () => {
			if (ended) return;
			ended = true;
			handlers.onEnd?.();
		};
		void (async () => {
			try {
				const res = await authFetch(
					`/api/blocks/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/test${qs}`,
					{ method: 'POST', headers: { Accept: 'text/event-stream' }, signal: ac.signal }
				);
				if (!res.ok || !res.body) {
					// The refusal reaches a Dutch author's screen verbatim, so it goes through the same
					// localizer every other client error uses: `stream failed (402)` was the ONLY thing a
					// licence-blocked workspace was told, in English, with the backend's own explanation
					// thrown away unread.
					const text = await res.text().catch(() => '');
					const body = parseBody(text);
					handlers.onError?.(
						writeErrorText(
							new ApiError(
								res.status,
								body?.error ?? 'error',
								body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
								// This error is handed STRAIGHT to `writeErrorText` on the next line, so it is the
								// one construction site where dropping `details` is visibly a dropped sentence.
								detailsFrom(body)
							),
							m.error_action_failed()
						)
					);
					return;
				}
				const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
				let buf = '';
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += value;
					let idx: number;
					while ((idx = buf.indexOf('\n\n')) >= 0) {
						const raw = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						const block = parseBlock(raw);
						if (!block) continue;
						if (block.event === 'end') return;
						if (block.event === 'error') {
							// ⛔ THE SAME SHAPE AS THE NON-2xx BRANCH ABOVE, AND FOR THE SAME REASON. This
							// arm used to take the frame's `message` VERBATIM and hand it to
							// `BlockTesting.svelte`, which renders it at `:366` inside a fully Dutch coral
							// banner. `blocks.ts`'s stream catch enqueues `err.message` — the backend's
							// English — so a licence-blocked or infrastructure-failed test run told a Dutch
							// author "Daily LLM call cap reached (200)" and nothing else on the panel was
							// English. The refusal now goes through `writeErrorText` like every other client
							// error in this file: the frame carries the `code` and `status` the `HttpError`
							// already had, and the browser writes the sentence.
							//
							// ⚠️ THE ENGLISH IS NOT DISCARDED — it is the third constructor argument, which
							// is what `writeErrorText` falls back to for a 400/422 whose code has no catalog
							// entry (see its doc comment: on a validation refusal the backend sentence names
							// the offender and IS the actionable thing). What changes is that it stops being
							// the ONLY outcome.
							//
							// A frame with no `status` is read as a 500: an `err` that was not an `HttpError`
							// is an infrastructure fault, and 5xx is the branch that returns the caller's
							// localized fallback.
							//
							// ⛔ AND `details` IS THE FOURTH ARGUMENT, WHICH IS THE HALF THE FIRST CUT OF THIS
							// BRANCH DROPPED. `error-message.wire.test.ts` scrapes every `new ApiError(` in this
							// directory and reds on any that does not forward the bag — because ~20 localized
							// refusals interpolate a value the backend puts in `details`, and a construction that
							// omits it makes every one of them take its `null` branch and fall back to the
							// backend's English. That is not hypothetical here: `runBlockTests` calls
							// `assertRunnableSource` before the first test, whose `lint_failed` (422) carries its
							// whole payload in `details.findings` — without the bag this branch localizes a
							// lint refusal into nothing and prints `Block failed lint`.
							//
							// `detailsFrom` is the same lifter the non-2xx branch above and every sibling
							// `unwrap` use, and the frame nests the bag under the same `details` key
							// `utils/http.ts` uses on a JSON error body, so one reader serves both shapes.
							//
							// ⚠️ NO FIFTH ARGUMENT. `findings` is read BY NAME off a thrown `ApiError`
							// (`routes/block-edit/+page.svelte`); this one is consumed by `writeErrorText` on
							// the next line and discarded, and `handlers.onError` takes a string. The lint
							// transcript reaches the author through `details.findings`, which is where
							// `error-message.ts:757` reads it from.
							let status = 500;
							let code = 'error';
							let message = '';
							let details: Record<string, unknown> | undefined;
							try {
								const frame = block.data ? JSON.parse(block.data) : {};
								if (typeof frame.status === 'number') status = frame.status;
								if (typeof frame.code === 'string' && frame.code) code = frame.code;
								if (typeof frame.message === 'string') message = frame.message;
								details = detailsFrom(frame);
							} catch {
								/* a malformed frame is still a failed run — fall through to the fallback */
							}
							handlers.onError?.(
								writeErrorText(
									new ApiError(status, code, message, details),
									m.blockedit_test_run_failed()
								)
							);
							continue;
						}
						if (!block.data) continue;
						try {
							const payload = JSON.parse(block.data);
							if (block.event === 'test_result') handlers.onResult(payload as BlockTestOutcome);
							else if (block.event === 'summary') handlers.onSummary(payload as BlockTestRunSummary);
						} catch {
							/* ignore a malformed frame */
						}
					}
				}
			} catch (err) {
				// A raw `Failed to fetch` / `NetworkError` is the browser's words, not the product's.
				if (!ac.signal.aborted) handlers.onError?.(writeErrorText(err, m.error_action_failed()));
			} finally {
				finish();
			}
		})();
		return { close: () => ac.abort() };
	},

	async lint(slug: string, version: string, sourceTs?: string): Promise<LintResult> {
		return unwrap(
			await authFetch(
				`/api/blocks/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/lint`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(sourceTs !== undefined ? { source_ts: sourceTs } : {})
				}
			)
		);
	},

	// Phase 2: run the block ONCE with the given inputs (missing fields auto-filled
	// from the version's examples + descriptor defaults). Persists nothing.
	async simulate(
		slug: string,
		version: string,
		inputs?: Record<string, unknown>
	): Promise<SimulateResult> {
		return unwrap(
			await authFetch(
				`/api/blocks/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/simulate`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(inputs !== undefined ? { inputs } : {})
				}
			)
		);
	}
};
