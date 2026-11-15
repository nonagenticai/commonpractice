// @vitest-environment jsdom
//
// src/routes/build/build-page.challenge-closed.render.test.ts — /build must not arm Submit for a
// challenge that will refuse the submission, and must NOT disarm it when it simply could not ask.
//
// ⛔ WHY /build NEEDS ITS OWN GATE AT ALL. Withdrawing the "Build a solution" CTA on the challenge
// page removes the INVITATION; it does not remove the ENTRANCE. `?challenge=` is a hand-editable URL
// parameter, it survives a bookmark, and `builderBootUrl` deliberately carries it across every
// navigation this page makes (flow switch, new flow, boot redirect). So a reader can be sitting in
// the builder with a dead challenge in context having never seen a link — and before this, with a
// fully live Submit button that could only answer `422 challenge_closed` after the work was done.
//
// `build-topbar.submit-gate.render.test.ts` proves the topbar honours the `challengeClosed` PROP.
// THIS file proves /build computes it: that the flag is captured off the challenge fetch the page
// already performs, and — the part no other test can reach — what happens when that fetch FAILS.
//
// ⛔ THE ASYMMETRY IS THE POINT OF THE LAST TEST, AND IT IS NOT AN OVERSIGHT.
// `$lib/solutions/solution-state.ts` argues unknown ⇒ BLOCKED and is right to: a wrongly-live vote
// pill costs one click that answers with a red banner. Here the currency is different. A
// wrongly-DISABLED Submit costs a COMPLETED BUILD, with no way to force it, and the server guard is
// now total — the worst case of staying open is one honest 422 that names the finished cycle and
// points at the current one. Anyone "fixing" the two modules to agree should red that test.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

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

// ⚠️ `?challenge=` IS IN THE MOCKED URL — that is the entry this file is about. The id is a literal
// inside the factory: `vi.mock` is hoisted above every const here.
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/build?id=f1&challenge=ch-dead-1') }
}));
const CH_ID = 'ch-dead-1';
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getChallenge, getFlow, saveFlow, listFlows, listBlocks } = vi.hoisted(() => ({
	getChallenge: vi.fn(),
	getFlow: vi.fn(),
	saveFlow: vi.fn(),
	listFlows: vi.fn(),
	listBlocks: vi.fn()
}));

vi.mock('$lib/api/runs', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, runsApi: { start: vi.fn(), startSolution: vi.fn(), get: vi.fn() } };
});
vi.mock('$lib/services/sse', () => ({ streamRun: () => ({ close: () => {} }) }));
vi.mock('$lib/api/flows', () => ({
	flowsApi: { get: getFlow, save: saveFlow, list: listFlows, create: vi.fn() }
}));
// Partial: `$lib/api/solutions` re-exports `ApiError` from here, so a bare factory breaks its import.
vi.mock('$lib/api/blocks', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		blocksApi: { list: listBlocks, get: vi.fn().mockRejectedValue(new Error('no block detail')) }
	};
});
vi.mock('$lib/api/challenges', () => ({ challengesApi: { get: getChallenge, list: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (e: unknown, fallback: string) => (e as Error)?.message ?? fallback
}));

// SvelteFlow reads both of these during construction; jsdom ships neither.
Object.defineProperty(window, 'matchMedia', {
	writable: true,
	value: (q: string) => ({
		matches: false,
		media: q,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false
	})
});
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as never;

import Page from './+page.svelte';

/** A one-node flow with a REAL name — the name gate is a different subject and must stay open. */
function flowFixture() {
	return {
		id: 'f1',
		name: 'Claim summariser',
		owner_id: 'u1',
		status: 'draft',
		version: '1',
		solution_id: null,
		last_saved_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		graph: {
			nodes: [
				{
					id: 'n1',
					blockId: 'b1',
					blockVersionId: 'v1',
					slug: 'load-dataset',
					label: 'Load dataset',
					category: 'data',
					config: {},
					position: { x: 0, y: 0 }
				}
			],
			edges: []
		}
	};
}

function challengeFixture(cycleClosed: boolean | undefined) {
	const c: Record<string, unknown> = {
		id: CH_ID,
		code: 'CH-284',
		title: 'Claims intake',
		description: '',
		businessImpact: '',
		workArea: 'Claims',
		status: 'voting', // ⛔ the column that lied — never the gate
		week: '2026-W21',
		tags: [],
		metrics: {},
		votesCount: 284,
		hasVoted: false,
		submitter: { name: 'S', initials: 'S' },
		createdAt: '2026-05-20T00:00:00.000Z',
		commentCount: 0,
		datasets: [],
		canEditDatasets: false,
		involves: [],
		solutions: [],
		similar: []
	};
	if (cycleClosed !== undefined) c.cycleClosed = cycleClosed;
	return c;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount /build with `?challenge=`, having queued whatever `challengesApi.get` should do. */
async function mountBuild() {
	listBlocks.mockResolvedValue({ items: [] });
	listFlows.mockResolvedValue({ items: [{ id: 'f1', name: 'Claim summariser', node_count: 1 }] });
	getFlow.mockResolvedValue(flowFixture());
	saveFlow.mockImplementation(async () => flowFixture());
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
}

/**
 * The Submit button — AFTER proving the topbar actually rendered.
 *
 * ⛔ THE POSITIVE MARKER. /build mounts a dozen modules; one unstubbed import and the page renders
 * nothing, `querySelector` returns null, and an assertion phrased as "no CHALLENGE_CLOSED hint"
 * passes against an empty DOM. The challenge fetch is also asserted to have HAPPENED, since every
 * case here is about what the page did with its answer.
 */
function submitButton(): HTMLButtonElement {
	expect(
		getChallenge.mock.calls.map((c) => c[0]),
		'/build never fetched the challenge in `?challenge=`, so nothing here is about its answer'
	).toContain(CH_ID);
	const btn = [...target.querySelectorAll('button.btn-primary')].find((b) =>
		['build_submit_solution', 'build_submitting', 'build_submitted'].includes(b.textContent?.trim() ?? '')
	) as HTMLButtonElement | undefined;
	expect(btn, 'the Build topbar never rendered its Submit button — this file would test nothing').toBeDefined();
	return btn!;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	for (const m of [getChallenge, getFlow, saveFlow, listFlows, listBlocks]) m.mockReset();
});

describe('/build gates Submit on the challenge in `?challenge=` still accepting solutions', () => {
	it('⛔ cycleClosed:true on the wire — Submit is DEAD and says why, with a link out', async () => {
		// The hand-edited-URL / bookmarked / carried-across entry, with a challenge dead since May
		// whose `status` column still reads `voting`. Red by never capturing `c.cycleClosed`.
		getChallenge.mockResolvedValue(challengeFixture(true));
		await mountBuild();

		expect(
			submitButton().disabled,
			'Submit is live in a builder pointed at a challenge whose cycle is over. The author spends ' +
				'the whole session and the server answers 422 challenge_closed at the end of it.'
		).toBe(true);
		expect(submitButton().getAttribute('aria-describedby')).toBe('submit-challenge-closed');

		const hint = target.querySelector('a.submit-hint#submit-challenge-closed') as HTMLAnchorElement | null;
		expect(hint, 'Submit is dead with nothing on screen explaining it').not.toBeNull();
		expect(hint!.textContent).toContain('build_submit_challenge_closed');
		expect(hint!.getAttribute('href')).toBe('/challenges');
	});

	it('⛔ THE MIRROR — cycleClosed:false, Submit is LIVE and silent', async () => {
		// Without this, hard-coding `challengeClosed = true` passes the case above and kills the one
		// flow this whole workstream exists to keep enterable.
		getChallenge.mockResolvedValue(challengeFixture(false));
		await mountBuild();

		expect(submitButton().disabled, 'the fix disabled Submit on a LIVE challenge').toBe(false);
		expect(target.textContent).not.toContain('build_submit_challenge_closed');
		expect(submitButton().getAttribute('aria-describedby')).toBeNull();
	});

	it('MID-ROLL: the payload omits cycleClosed — Submit stays LIVE', async () => {
		// An older server that never learned the field must not be read as a refusal — the same
		// "absent is not closed" reading `$lib/challenges/challenge-state.ts` documents. Red by
		// `challengeClosed = c.cycleClosed !== false`, the shape that treats a missing field as dead.
		getChallenge.mockResolvedValue(challengeFixture(undefined));
		await mountBuild();
		expect(submitButton().disabled).toBe(false);
		expect(target.textContent).not.toContain('build_submit_challenge_closed');
	});

	it('⚠️ THE DELIBERATE ASYMMETRY — a FAILED challenge fetch leaves Submit ENABLED', async () => {
		// ⛔ READ THE COMMENT ON THE `catch` IN +page.svelte BEFORE CHANGING THIS TEST. It is not a
		// missing guard. `solution-state.ts` argues unknown ⇒ blocked for a VOTE, where being wrong
		// costs one wasted click; being wrong here costs a completed build, permanently, with the
		// author holding a dead button and no way to force it. The server guard is total and its 422
		// explains itself, so the honest floor is to let the work be filed and let the server answer.
		//
		// Red by `challengeClosed = true` in that catch — which is exactly the "consistency" fix a
		// future reviewer will reach for.
		getChallenge.mockRejectedValue(new Error('network down'));
		await mountBuild();

		expect(
			submitButton().disabled,
			'a challenge fetch that merely FAILED has disabled Submit. The author cannot publish a ' +
				'finished build because of a 500 on a datasets lookup.'
		).toBe(false);
		expect(target.textContent).not.toContain('build_submit_challenge_closed');
	});
});
