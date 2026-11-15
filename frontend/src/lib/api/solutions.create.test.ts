// Unit tests for `solutionsApi.create()` and `solutionErrorIssues` — the client for the ONE route
// that puts a user-built solution into the marketplace.
//
// `create()` existed with zero callers for the whole life of the product: the Build screen's Submit
// button PATCHed `flows.status = 'submitted'` (a field nothing reads) and never posted a solution,
// so eight consecutive weekly cycles closed with no winner because no user-submitted solution had
// ever been created. These tests pin the request that fixes that, and the error information the
// author gets when it is refused.
//
// The tests drive the REAL path — a mocked `authFetch` returns an actual `Response` with a verbatim
// backend body, `create()` runs it through `unwrap()`, and the thrown error is what
// `solutionErrorIssues` is asked about. Hand-building the error instead would not notice if
// `unwrap()`'s merge ever stopped landing `issues` under `details`. Same construction as
// `runs.test.ts`, deliberately: it is the same body shape from the same validators.
//
// ⛔ `vi.mock` uses the ALIAS id `$lib/api/auth-fetch`, never a relative specifier — see the header
// of `flows-snapshots.test.ts`. `mock-specifiers.test.ts` enforces it. No jsdom: `authFetch` is the
// only browser-only import in the chain and it is mocked away.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { solutionsApi, solutionErrorIssues, SolutionApiError, ApiError } from './solutions';
import { writeErrorText } from './error-message';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import { iso } from '$lib/test/bidi';

function respondWith(status: number, body: unknown) {
	authFetch.mockResolvedValueOnce(
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
	);
}

const PAYLOAD = {
	challenge_id: '11111111-1111-1111-1111-111111111111',
	title: 'Invoice triage',
	flow_id: '22222222-2222-2222-2222-222222222222',
	blocks_used: ['http-fetch', 'llm-summarize']
};

/** Run `solutionsApi.create()` against a queued response and hand back whatever it threw. */
async function createAndCatch(): Promise<unknown> {
	try {
		await solutionsApi.create(PAYLOAD);
		throw new Error('expected solutionsApi.create to reject');
	} catch (e) {
		return e;
	}
}

beforeEach(() => {
	authFetch.mockReset();
});

describe('solutionsApi.create', () => {
	it('POSTs the payload to /api/solutions and returns the created row', async () => {
		respondWith(201, { id: 'sol-1', title: 'Invoice triage', status: 'voting', week: '2026-W32' });

		const created = await solutionsApi.create(PAYLOAD);

		expect(authFetch).toHaveBeenCalledTimes(1);
		const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/solutions');
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({ 'content-type': 'application/json' });
		// The body is the payload verbatim — `createSolutionSchema` is `.strict()`, so the client
		// must never decorate it.
		expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
		// The route returns the inserted solutions row; the caller navigates to `/solutions/:id`.
		expect(created.id).toBe('sol-1');
	});
});

describe('solutionErrorIssues', () => {
	it('lifts every per-node issue out of a real flow_invalid 422', async () => {
		// Verbatim shape of `unprocessable('flow_invalid', …, { issues })` as serialized by
		// backend/src/utils/http.ts: `details` plus the backwards-compatible top-level copy.
		const issues = [
			{ rule: 'missing-required-input', message: 'Input "rows" is required.', ref: 'n_a1b2c3d4' },
			{ rule: 'orphan-node', message: 'This block is not connected to anything.', ref: 'n_deadbeef' }
		];
		respondWith(422, {
			error: 'flow_invalid',
			message: 'The flow is not ready to publish.',
			details: { issues },
			issues,
			requestId: 'req-1'
		});

		const err = await createAndCatch();
		expect(err).toBeInstanceOf(SolutionApiError);
		expect((err as SolutionApiError).code).toBe('flow_invalid');

		const got = solutionErrorIssues(err);
		expect(
			got,
			'the solutions client discarded `details.issues`, so a refused publish tells the author ' +
				'only "The flow is not ready to publish." and never WHICH node — the one thing the ' +
				'backend had already computed.'
		).toEqual(issues);
		// The refs are what let the build page name the node on the canvas (`issueNodeLabel`).
		expect(got.map((i) => i.ref)).toEqual(['n_a1b2c3d4', 'n_deadbeef']);
	});

	it('still carries a human-readable summary alongside the issues', async () => {
		// ⛔ RE-BASELINED, AND THE OLD ASSERTION WAS ITSELF THE DEFECT. This used to pin the exact
		// string `'The flow is not ready to publish.'` reaching the screen — which is what a Dutch
		// author was shown when they pressed Submit. `flow_invalid` is now in `VALIDATION_MESSAGES`
		// alongside every other code this route can refuse with (derived with file:line by
		// `error-message.backend-contract.test.ts`). What this file is about is unchanged: the
		// summary sentence and the per-node issues both survive `unwrap()`, and the summary is a
		// real sentence rather than the caller's fallback.
		respondWith(422, {
			error: 'flow_invalid',
			message: 'The flow is not ready to publish.',
			details: { issues: [{ rule: 'cycle', message: 'The flow contains a cycle.' }] }
		});
		const err = await createAndCatch();
		// The REAL `en` catalog (this file mocks no messages), so this also proves the key exists.
		const text = writeErrorText(err, 'FALLBACK');
		expect(text).not.toBe('FALLBACK');
		expect(text).not.toBe('The flow is not ready to publish.'); // never the wire string
		// The headline's whole job: "not yet — look at the list below it".
		expect(text).toContain('listed below');
		// …and the list is still there.
		expect(solutionErrorIssues(err)).toHaveLength(1);
	});

	it('keeps a 422 with no issues working — challenge_closed carries none', async () => {
		// ⛔ RE-BASELINED, NOT WEAKENED, AND THE OLD ASSERTION WAS THE THING BEING FIXED. This used to
		// pin `writeErrorText` returning the backend's own sentence verbatim. That sentence is now
		// `Challenge 'ch-…' competed in cycle 2026-W21, which is over — …` and it is the ONE refusal
		// an ordinary author meets at the END of a completed build; shipping it verbatim shows raw ids
		// and ISO week tokens, in English, to all eight locales. `error-message.ts`'s
		// `VALIDATION_MESSAGES` is the narrow exception that localizes it, and that mapping is pinned
		// there (`error-message.test.ts`). What THIS file is about is unchanged: a 422 with no
		// `details.issues` yields an empty issue list and a usable sentence.
		respondWith(422, {
			error: 'challenge_closed',
			message:
				"Challenge 'ch-1' competed in cycle 2026-W21, which is over — it takes no new solutions. Pick a challenge from the current cycle (2026-W33) instead.",
			details: {}
		});
		const err = await createAndCatch();
		expect(solutionErrorIssues(err)).toEqual([]);
		// The REAL `en` catalog (this file mocks no messages), so this also proves the key exists.
		const text = writeErrorText(err, 'FALLBACK');
		expect(text).not.toBe('FALLBACK');
		expect(text).not.toContain("Challenge 'ch-1'"); // no raw id in the reader's face
		expect(text).not.toContain('2026-W21'); // no ISO week token either
		expect(text).toContain('takes no new solutions');
	});

	it('⚠️ an UNCATALOGUED 422 code still keeps the backend sentence — the map is not "422 is localized now"', async () => {
		// The mirror of the case above, and the answer to "what happens to a code nobody has got to
		// yet?". It falls through to the backend's own sentence, exactly as before — that doctrine is
		// unchanged and deleting it would be the regression (`error-message.ts`'s `writeErrorText`
		// header spells out why: a developer-shaped 422 quotes the value the reader typed, and no
		// static translation can carry that).
		//
		// ⛔ THE CODE HERE IS DELIBERATELY ONE THIS ROUTE CANNOT EMIT TODAY. Every 400/422/409 code
		// `POST /api/solutions` can actually refuse with IS catalogued as of this commit, and
		// `error-message.backend-contract.test.ts` derives that set from `backend/src` and fails if a
		// new one appears. So this stands in for the state between "someone adds a throw" and
		// "someone adds its copy" — the window the guard exists to make short and visible, not the
		// window it pretends cannot happen.
		respondWith(422, {
			error: 'solution_quota_exceeded',
			message: "You have already submitted 3 solutions to challenge 'ch-9' this week",
			details: {}
		});
		const err = await createAndCatch();
		expect(solutionErrorIssues(err)).toEqual([]);
		expect(writeErrorText(err, 'FALLBACK')).toBe(
			"You have already submitted 3 solutions to challenge 'ch-9' this week"
		);
	});

	it('⛔ `block_archived` NAMES the block, in the reader’s language, off the REAL 422', async () => {
		// ⛔ RELOCATED FROM `agent-chat.refusal-copy.wire.test.ts`, AND THE MOVE IS THE POINT.
		// `block_archived` is thrown in exactly ONE place — `backend/src/host/publication-service.ts:64`,
		// inside `resolveExecutableBlocks`, reached from `routes/solutions.ts:460` — so
		// `POST /api/solutions` is the ONLY route that can emit it, as a 422. It was being asserted
		// against `POST /api/agent/chat`, which emits 401 `agent_token_no_tenant`, 422 `validation`, 404
		// `flow_not_found`, 401 and 5xx and nothing else. Constructing a body a route cannot produce
		// is the same "only the test can make this" vacuity that file's own header condemns, one
		// level up: the CLIENT was real, the WIRE was not.
		//
		// So the case lives here, on the client for the route that really throws it, at the real
		// status, with the real sentence from the real throw site.
		overwriteGetLocale(() => 'nl');
		try {
			const english = "Block 'llm-summarize' is archived and cannot be published or run.";
			respondWith(422, {
				error: 'block_archived',
				message: english,
				details: {
					nodeId: 'n_a1b2c3d4',
					blockId: '33333333-3333-3333-3333-333333333333',
					versionId: '44444444-4444-4444-4444-444444444444',
					blockSlug: 'llm-summarize'
				}
			});
			const err = await createAndCatch();
			const text = writeErrorText(err, 'FALLBACK');
			// ⛔ THE SLUG IS BIDI-ISOLATED, and this comment used to say the exact opposite — "NO bidi
			// isolate: `naming(...)` hands the slug through RAW ... asserting an isolate the product
			// does not emit would red on a correct fix." That was true when written and became false
			// the day `naming()` started calling `iso()` like every one of its siblings, at which
			// point this file went red in CI having reassured its own reader that it would not.
			// `error_block_archived` is one of the six codes routed through `naming`.
			expect(text).toBe(m.error_block_archived({ block: iso('llm-summarize') }));
			expect(text).not.toBe(english);
			expect(text).not.toBe('FALLBACK');
			// ⛔ NON-VACUITY: the localized sentence is worth having only because it still NAMES the
			// block. A `naming` entry that lost its argument would satisfy both lines above.
			expect(text).toContain('llm-summarize');
		} finally {
			overwriteGetLocale(() => 'en');
		}
	});

	it('KEEPS the English sentence when the wire carries no `blockSlug` — the catalog cannot name it', async () => {
		// The other half, also relocated. Same code, NO `blockSlug` (an older pod mid-roll): `naming`
		// returns `null` and `writeErrorText` falls through to the backend sentence ON PURPOSE — it
		// NAMES the block and no static translation can. A blanket "kill all English" fix turns this
		// green-to-red, which is why it is pinned rather than assumed.
		overwriteGetLocale(() => 'nl');
		try {
			const english = "Block 'llm-summarize' is archived and cannot be published or run.";
			respondWith(422, { error: 'block_archived', message: english, details: {} });
			expect(writeErrorText(await createAndCatch(), 'FALLBACK')).toBe(english);
		} finally {
			overwriteGetLocale(() => 'en');
		}
	});

	it('drops a Zod-issue body — a .strict() key violation is not a per-node graph issue', async () => {
		// `route()`'s ZodError branch (backend/src/utils/http.ts:130) emits `details: { issues: … }`
		// too, but a Zod issue has `code`/`path` and no `rule`. Rendering those in the canvas issue
		// list would show the author "Unrecognized key(s) in object" attributed to no node at all.
		respondWith(400, {
			error: 'validation',
			details: {
				issues: [
					{ code: 'unrecognized_keys', keys: ['status'], path: [], message: "Unrecognized key(s)" }
				]
			}
		});
		expect(solutionErrorIssues(await createAndCatch())).toEqual([]);
	});

	it('drops malformed entries and keeps the valid ones', async () => {
		respondWith(422, {
			error: 'flow_invalid',
			message: 'nope',
			details: {
				issues: [
					{ rule: 'cycle', message: 'The flow contains a cycle.' },
					{ rule: 'cycle' }, // no message
					null,
					'a string',
					{ rule: 'x', message: 'y', ref: 42 } // ref must be a string when present
				]
			}
		});
		expect(solutionErrorIssues(await createAndCatch())).toEqual([
			{ rule: 'cycle', message: 'The flow contains a cycle.' }
		]);
	});

	it('returns [] for anything that is not a SolutionApiError', () => {
		expect(solutionErrorIssues(new Error('boom'))).toEqual([]);
		expect(solutionErrorIssues(null)).toEqual([]);
		expect(solutionErrorIssues(undefined)).toEqual([]);
		// A look-alike plain object must NOT pass: the page renders these, and only the typed
		// client's own error is known to have come from `unwrap()`.
		expect(solutionErrorIssues({ details: { issues: [{ rule: 'cycle', message: 'x' }] } })).toEqual([]);
	});

	it('is still an ApiError, so the existing error copy keeps working', async () => {
		respondWith(403, { error: 'user_offboarded', message: 'Offboarded' });
		const err = await createAndCatch();
		// The vote/leaderboard screens and `licenseOrPermissionMessage` both rely on this.
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(403);
		// 403 keeps the LOCALIZED copy, never the raw backend string.
		expect(writeErrorText(err, 'FALLBACK')).not.toBe('Offboarded');
	});

	it('survives a non-JSON error body (an ingress interstitial) without throwing', async () => {
		authFetch.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
		const err = await createAndCatch();
		expect(err).toBeInstanceOf(SolutionApiError);
		expect(solutionErrorIssues(err)).toEqual([]);
	});
});
