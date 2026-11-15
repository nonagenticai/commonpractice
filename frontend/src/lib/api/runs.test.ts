// Unit test for runErrorIssues — the per-node graph issues carried by a refused `POST /api/runs`.
//
// The point of the function is that a `flow_invalid` 422 already names the offending nodes and the
// build page used to throw that away, so the tests drive the REAL path: a mocked `authFetch`
// returns an actual `Response` with a real run-controller body, `runsApi.start()` runs it through
// `unwrap()`, and the resulting `RunApiError` is what `runErrorIssues` is asked about. Testing a
// hand-built `RunApiError` instead would not notice if `unwrap()`'s spread ever stopped landing
// `issues` under `details`.
//
// ⛔ `vi.mock` uses the ALIAS id `$lib/api/auth-fetch`, never the relative `./auth-fetch` — see the
// header of flows-snapshots.test.ts for why a relative specifier fails silently under vitest 2.1.
// `mock-specifiers.test.ts` enforces it. No jsdom: `authFetch` is the only browser-only import in
// runs.ts's chain, and it is mocked away.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { runsApi, runErrorIssues, RunApiError } from './runs';

/** Queue one response for the next `authFetch` call. */
function respondWith(status: number, body: unknown) {
	authFetch.mockResolvedValueOnce(
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
	);
}

/** Run `runsApi.start()` against a queued response and hand back whatever it threw. */
async function startAndCatch(): Promise<unknown> {
	try {
		await runsApi.start('flow-1');
		throw new Error('expected runsApi.start to reject');
	} catch (e) {
		return e;
	}
}

beforeEach(() => {
	authFetch.mockReset();
});

describe('runErrorIssues', () => {
	it('lifts every issue out of a real run-controller flow_invalid 422', async () => {
		// Verbatim shape of `unprocessable('flow_invalid', …, { issues })` as serialized by
		// backend/src/utils/http.ts: `details` plus the backwards-compatible top-level copy.
		const issues = [
			{ rule: 'missing-required-input', message: 'Input "rows" is required.', ref: 'node-a' },
			{ rule: 'cycle', message: 'The flow contains a cycle.', ref: 'node-b' }
		];
		respondWith(422, {
			error: 'flow_invalid',
			message: 'The flow is not ready to run.',
			details: { issues },
			issues,
			requestId: 'req-1'
		});

		const err = await startAndCatch();
		expect(err).toBeInstanceOf(RunApiError);
		expect((err as RunApiError).code).toBe('flow_invalid');

		const got = runErrorIssues(err);
		expect(got).toHaveLength(2);
		expect(got).toEqual(issues);
		// The refs are what let the page name the node on the canvas.
		expect(got.map((i) => i.ref)).toEqual(['node-a', 'node-b']);
	});

	it('returns [] for anything that is not a RunApiError', () => {
		expect(runErrorIssues(new Error('boom'))).toEqual([]);
		expect(runErrorIssues(null)).toEqual([]);
		expect(runErrorIssues(undefined)).toEqual([]);
		expect(runErrorIssues('flow_invalid')).toEqual([]);
		// A look-alike plain object must NOT pass: the page renders these, and only the typed
		// client's own error is known to have come from `unwrap()`.
		expect(runErrorIssues({ details: { issues: [{ rule: 'cycle', message: 'x' }] } })).toEqual([]);
	});

	it('drops malformed entries and keeps the valid ones', async () => {
		respondWith(422, {
			error: 'flow_invalid',
			message: 'The flow is not ready to run.',
			details: {
				issues: [
					{ rule: 'cycle', message: 'The flow contains a cycle.', ref: 'node-a' },
					null, // not an object
					'edge-missing-source', // a bare string
					{ message: 'no rule field' }, // missing `rule`
					{ rule: 'cycle' }, // missing `message` — nothing to render
					{ rule: 'cycle', message: 'bad ref', ref: 42 }, // `ref` is not a string
					// A ZodError issue: `route()`'s validation branch puts these under the SAME
					// `details.issues` key, and they have `code`/`path`, no `rule`.
					{ code: 'invalid_type', path: ['flowId'], message: 'Required' },
					{ rule: 'orphan-loop-body', message: 'Loop body has no container.', ref: 'node-c' }
				]
			}
		});

		const got = runErrorIssues(await startAndCatch());
		expect(got).toEqual([
			{ rule: 'cycle', message: 'The flow contains a cycle.', ref: 'node-a' },
			{ rule: 'orphan-loop-body', message: 'Loop body has no container.', ref: 'node-c' }
		]);
	});

	it('accepts a rule the frontend has never heard of', async () => {
		// The guard checks `rule` as a plain string on purpose. A rule shipped backend-first must
		// still reach the user — a mirrored union would make it vanish silently, which is the exact
		// information loss this function exists to fix.
		respondWith(422, {
			error: 'flow_invalid',
			message: 'The flow is not ready to run.',
			details: { issues: [{ rule: 'some-future-rule', message: 'Something new is wrong.' }] }
		});

		expect(runErrorIssues(await startAndCatch())).toEqual([
			{ rule: 'some-future-rule', message: 'Something new is wrong.' }
		]);
	});

	it('returns [] when the error carries no issues at all', async () => {
		// The common case for every non-validation refusal: 403, 402, a 500. `details.issues` is
		// absent, and the caller must get an empty list rather than a crash.
		respondWith(403, { error: 'flow_not_owner', message: 'Not your flow.' });
		expect(runErrorIssues(await startAndCatch())).toEqual([]);

		// And when `issues` is present but not an array.
		respondWith(422, {
			error: 'flow_invalid',
			message: 'The flow is not ready to run.',
			details: { issues: 'cycle' }
		});
		expect(runErrorIssues(await startAndCatch())).toEqual([]);
	});
});
