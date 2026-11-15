// src/lib/api/blocks.stream-tests-terminal.test.ts — `streamTests` must signal the END of the run
// on EVERY terminal outcome, not only on the happy path.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. `/block-edit?slug=…` → Testen → "Alle tests uitvoeren"
// with a request that fails (402 licence, 403, a 500, or a dropped connection). The button reads
// "Bezig…" and is dead for the rest of the session; only a tab switch or F5 gets it back.
//
// The wedge was made of two halves that had to agree and did not:
//   - `BlockTesting.svelte` sets `running = true` before the call and clears it ONLY in `onEnd`.
//   - `streamTests` fired `onError` and `return`ed on `!res.ok || !res.body`, and fired `onError`
//     from its `catch` — neither path ever reached `onEnd`.
// Fixing this in the component (clear `running` in `onError` too) would have reproduced the same
// shape one layer up: two call sites that must be kept in sync. The producer is the only place
// that knows a stream is over, so the guarantee lives here — `onEnd` fires exactly once, always.
//
// ⚠️ THE "EXACTLY ONCE" HALF IS NOT DECORATION. `onEnd` in `BlockTesting` also kicks `load()`,
// which re-fetches the suite; a terminal handler that can fire twice turns every run into two
// list requests, and (with the `end` frame) the naive `finally` does exactly that. Both halves are
// asserted below.
//
// ⚠️ AND THE BANNER IS DUTCH NOW. This module hardcoded `stream failed (500)` / `test run failed`
// and passed a raw `Failed to fetch` straight to the screen of a Dutch product. The catalog-backed
// text is asserted here rather than in the component, because this is where it is chosen.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { blocksApi } from './blocks';
import * as m from '$lib/paraglide/messages';

function sseResponse(text: string): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);
}

/** Let the detached async reader in `streamTests` run to completion. */
async function settle(pred: () => boolean) {
	for (let i = 0; i < 50 && !pred(); i++) await Promise.resolve();
}

function handlers() {
	return {
		onResult: vi.fn(),
		onSummary: vi.fn(),
		onError: vi.fn(),
		onEnd: vi.fn()
	};
}

afterEach(() => authFetch.mockReset());

describe('streamTests always reaches a terminal callback', () => {
	it('a non-2xx response ends the run instead of leaving it open forever', async () => {
		authFetch.mockResolvedValueOnce(new Response('', { status: 500 }));
		const h = handlers();
		blocksApi.streamTests('slug', '1.0.0', h);
		await settle(() => h.onEnd.mock.calls.length > 0);

		expect(h.onError).toHaveBeenCalledTimes(1);
		expect(h.onEnd, 'the run never ended — the Testen tab stays on "Bezig…"').toHaveBeenCalledTimes(1);
	});

	it('a dropped connection ends the run instead of leaving it open forever', async () => {
		authFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		const h = handlers();
		blocksApi.streamTests('slug', '1.0.0', h);
		await settle(() => h.onEnd.mock.calls.length > 0);

		expect(h.onError).toHaveBeenCalledTimes(1);
		expect(h.onEnd, 'the run never ended — the Testen tab stays on "Bezig…"').toHaveBeenCalledTimes(1);
	});

	it('an `error` FRAME mid-stream still ends the run', async () => {
		authFetch.mockResolvedValueOnce(
			sseResponse('event: error\ndata: {"message":"runner unavailable"}\n\n')
		);
		const h = handlers();
		blocksApi.streamTests('slug', '1.0.0', h);
		await settle(() => h.onEnd.mock.calls.length > 0);

		// ⚠️ THE TEXT IS THE OTHER DESCRIBE'S BUSINESS — this case is about the run TERMINATING.
		// It used to assert `toHaveBeenCalledWith('runner unavailable')`, which pinned the defect
		// the block below exists to remove.
		expect(h.onError).toHaveBeenCalledTimes(1);
		expect(h.onEnd).toHaveBeenCalledTimes(1);
	});

	it('the happy path ends exactly once', async () => {
		authFetch.mockResolvedValueOnce(
			sseResponse(
				'event: summary\ndata: {"testsPassing":true,"total":1,"passed":1,"failed":0,"errored":0}\n\n' +
					'event: end\ndata: {}\n\n'
			)
		);
		const h = handlers();
		blocksApi.streamTests('slug', '1.0.0', h);
		await settle(() => h.onEnd.mock.calls.length > 0);
		await settle(() => false);

		expect(h.onSummary).toHaveBeenCalledTimes(1);
		expect(h.onError).not.toHaveBeenCalled();
		expect(h.onEnd, 'a double `onEnd` doubles the list reload it triggers').toHaveBeenCalledTimes(1);
	});

	it('a clean close with no `end` frame ends exactly once', async () => {
		authFetch.mockResolvedValueOnce(sseResponse(''));
		const h = handlers();
		blocksApi.streamTests('slug', '1.0.0', h);
		await settle(() => h.onEnd.mock.calls.length > 0);
		await settle(() => false);

		expect(h.onEnd).toHaveBeenCalledTimes(1);
	});
});

describe('the failure the author reads is the product’s language, not the transport’s', () => {
	it('a 500 with no usable body falls back to the catalog, not `stream failed (500)`', async () => {
		authFetch.mockResolvedValueOnce(new Response('', { status: 500 }));
		const h = handlers();
		blocksApi.streamTests('slug', '1.0.0', h);
		await settle(() => h.onError.mock.calls.length > 0);

		expect(h.onError).toHaveBeenCalledWith(m.error_action_failed());
	});

	it('a 402 licence refusal gets the localized licence copy, not a bare status', async () => {
		authFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: 'license_expired', message: 'Licence expired' }), {
				status: 402
			})
		);
		const h = handlers();
		blocksApi.streamTests('slug', '1.0.0', h);
		await settle(() => h.onError.mock.calls.length > 0);

		const shown = h.onError.mock.calls[0]![0] as string;
		expect(shown).not.toMatch(/stream failed/);
		expect(shown).toBe(m.error_license_expired());
	});

	it('a network failure does not put `Failed to fetch` on a Dutch screen', async () => {
		authFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		const h = handlers();
		blocksApi.streamTests('slug', '1.0.0', h);
		await settle(() => h.onError.mock.calls.length > 0);

		expect(h.onError).toHaveBeenCalledWith(m.error_action_failed());
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE SECOND DEFECT ON THIS PATH, AND IT IS THE ONE THE `describe` ABOVE WALKED PAST.
//
// The two branches of `streamTests` disagreed about whose words reach the author. The NON-2xx branch
// builds a real `ApiError` and goes through `writeErrorText` (that is what the block above pins).
// The `error` FRAME branch — the one that fires when the run got a 200, started streaming, and THEN
// failed — took the frame's `message` verbatim:
//
//     backend/src/routes/blocks.ts   `err instanceof Error ? err.message : String(err)`
//     frontend/src/lib/api/blocks.ts `JSON.parse(block.data).message ?? m.error_action_failed()`
//     BlockTesting.svelte:190        `runError = msg`   → rendered at :366 in `.banner.error`
//
// So a Dutch author watching a test run die read a Dutch coral banner containing one line of raw
// backend English — and that line is the only one saying what went wrong. This is the exact class
// `$lib/i18n/block-test-error-label.ts` was written for, arriving through a channel that module
// never sees: the frame is about the RUN failing, not about a block refusing.
//
// ⛔ THE ENGLISH `message` STAYS ON THE WIRE, BYTE FOR BYTE, AND THAT IS NOT NEGOTIABLE. Read the ⛔
// block at the head of `block-test-error-label.ts`: `ai/mcp/tools.ts` returns it verbatim to an LLM,
// `BlockFixAssistant` puts it INTO a prompt from this very screen, and nine backend assertions pin
// it character for character. The fix ADDS `code` and `status` — the `HttpError`'s own fields, no
// new refusal code minted, so `error-message.backend-contract.test.ts` and `NOT_LOCALIZED_CODES` are
// untouched — and the browser rebuilds the same `ApiError` the sibling branch already builds.
describe('an `error` frame is localized like every other refusal, not printed raw', () => {
	/** One SSE `error` frame with whatever fields the backend put on it. */
	function errorFrame(data: Record<string, unknown>): Response {
		return sseResponse(`event: error\ndata: ${JSON.stringify(data)}\n\n`);
	}

	async function shown(res: Response): Promise<string> {
		authFetch.mockResolvedValueOnce(res);
		const h = handlers();
		blocksApi.streamTests('slug', '1.0.0', h);
		await settle(() => h.onError.mock.calls.length > 0);
		expect(h.onError, 'no failure was reported at all').toHaveBeenCalledTimes(1);
		return h.onError.mock.calls[0]![0] as string;
	}

	it('⛔ THE DEFECT: an internal English message is printed into a Dutch banner', async () => {
		// The shape `blocks.ts`'s stream catch actually produces for an infrastructure fault: an
		// `Error` that is not an `HttpError`, so no `code` and no `status` ride along.
		const text = await shown(
			errorFrame({ message: 'connect ECONNREFUSED 127.0.0.1:6379 while reserving a sandbox' })
		);
		expect(text, 'the backend’s English reached the author’s screen').not.toContain('ECONNREFUSED');
		expect(text).not.toContain('while reserving a sandbox');
		expect(text).toBe(m.blockedit_test_run_failed());
	});

	it('a catalogued `code` resolves to that catalog entry, not to the generic fallback', async () => {
		// ⛔ THE NON-VACUITY HALF, AND IT IS WHAT MAKES THE MACHINE FIELDS WORTH ADDING. Hardcoding
		// `m.blockedit_test_run_failed()` for every frame passes the case above forever while throwing
		// away everything the wire knows. 402 is a real outcome here: the block runner brokers
		// `ctx.llm()` through the host, and a licence-blocked workspace is refused mid-run.
		const text = await shown(
			errorFrame({ status: 402, code: 'license_expired', message: 'Licence expired' })
		);
		expect(text).toBe(m.error_license_expired());
		expect(text).not.toBe(m.blockedit_test_run_failed());
	});

	it('…and so does a 422 whose code the catalog knows', async () => {
		// The other arm of `writeErrorText`. `data_validation_failed` is a parameterless entry, so it
		// cannot pass by accidentally interpolating the English it replaces.
		const text = await shown(
			errorFrame({
				status: 422,
				code: 'data_validation_failed',
				message: 'run refused: data contract violated'
			})
		);
		expect(text).toBe(m.error_data_validation_failed());
		expect(text).not.toContain('data contract violated');
	});

	it('a 422 whose code the catalog does NOT know keeps the backend sentence', async () => {
		// ⛔ THE OVER-CORRECTION GUARD, and it is `writeErrorText`'s documented doctrine rather than a
		// concession: on a validation refusal the backend sentence NAMES THE OFFENDER, and replacing
		// it with a generic localized string says strictly less. The English stops being the ONLY
		// outcome; it does not stop being an outcome.
		const text = await shown(
			errorFrame({
				status: 422,
				code: 'no_such_code_in_the_catalog',
				message: "Test 'counts rows' declares an input the descriptor does not"
			})
		);
		expect(text).toBe("Test 'counts rows' declares an input the descriptor does not");
	});

	it('⛔ the frame’s `details` bag reaches the catalog — a lint refusal names its findings', async () => {
		// ⛔ THE ARGUMENT THE FIRST CUT OF THIS BRANCH DROPPED, AND WHY IT IS NOT HYPOTHETICAL.
		// `runBlockTests` calls `assertRunnableSource` BEFORE the first test (test-runner.ts:605), and
		// that gate throws `unprocessable('lint_failed', 'Block failed lint', { findings })`
		// (source-gate.ts:75). So a 422 with a bag is a real outcome of pressing "Alle tests uitvoeren"
		// on a draft whose source trips the scanner — it is, in fact, the FIRST thing that can fail.
		//
		// `lint_failed`'s catalog entry (error-message.ts:757) is `lintTranscript(details)` and returns
		// `null` when the bag has no usable finding — which drops the reader back onto the backend's
		// English `Block failed lint`, the exact fall-through this whole describe exists to close.
		// `code` and `status` alone cannot carry it: the transcript IS the actionable text.
		const findings = [
			{ source: 'scan', rule: 'banned-import', message: "import of 'node:fs' is not allowed", line: 3 },
			{ source: 'scan', rule: 'no-network', message: 'fetch() is not available in a block', line: 9 }
		];
		const text = await shown(
			errorFrame({
				status: 422,
				code: 'lint_failed',
				message: 'Block failed lint',
				details: { findings }
			})
		);
		expect(text).toBe(
			m.error_lint_failed({
				findings: '\u2068import of \'node:fs\' is not allowed; fetch() is not available in a block\u2069'
			})
		);
		// The two ways this could pass while still dropping the bag.
		expect(text, 'the bag never reached the catalog — the English sentence came back').not.toBe(
			'Block failed lint'
		);
		expect(text).not.toBe(m.blockedit_test_run_failed());
	});

	it('a malformed frame is still a failed run, not a silent one', async () => {
		const text = await shown(sseResponse('event: error\ndata: {not json\n\n'));
		expect(text).toBe(m.blockedit_test_run_failed());
	});

	it('an `error` frame with no data at all still reports the failure', async () => {
		const text = await shown(sseResponse('event: error\ndata: \n\n'));
		expect(text).toBe(m.blockedit_test_run_failed());
	});
});
