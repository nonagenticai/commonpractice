// src/routes/build/build-page.submit.test.ts — a TEXT guard that the Build page still WIRES the
// submit path to the route that creates a solution.
//
// ⚠️ BE HONEST ABOUT WHAT THIS TEST IS. It is a GREP, not a behavioural assertion. It cannot prove
// a solution is created; it only stops the wiring from being unhooked again. The behavioural
// guarantees live next door and would still fail on their own: `entry.test.ts` drives the boot URL
// and the payload directly, `src/lib/api/solutions.create.test.ts` drives the real request and the
// 422 issue-lifting, and `backend/tests/solutions.test.ts` owns the route itself.
//
// This exists because the defect it guards was invisible for the product's entire life: Submit
// PATCHed `flows.status = 'submitted'` — a value NOTHING in `backend/src` reads outside the enum,
// two seeds and the route's own side effect — so the button relabelled itself "Submitted ✓" and no
// solution was ever created. Eight consecutive `marketplace_cycles` closed with `winner_solution_id`
// NULL. A green suite the whole way. The cheapest thing that would have caught it is exactly this:
// checking that the one call that matters is present.
//
// Reading source text from disk in a vitest test is an established pattern in this repo — see
// `src/routes/pipeline/pipeline-page.no-reviewer-count.test.ts` and
// `src/lib/api/error-message.backend-contract.test.ts`, which document why.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));

/** The page source with comments stripped — a guard a comment can trip is a guard nobody keeps. */
function code(): string {
	return readFileSync(PAGE, 'utf-8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^[ \t]*\/\/.*$/gm, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

describe('the Build page submits a real solution', () => {
	it('is the file we think it is (or every assertion below passes vacuously)', () => {
		const src = code();
		expect(src).toContain('function submitSolution');
		expect(src).toContain('BuildTopbar');
	});

	it('calls solutionsApi.create — the only route that creates a solution', () => {
		expect(
			code(),
			'`+page.svelte` never calls `solutionsApi.create`. The Submit button is then decorative: ' +
				'`POST /api/solutions` is the sole entry point into challenge → solution → vote → ' +
				'weekly winner → pipeline, and without it the marketplace stays permanently empty ' +
				'while the button reads "Submitted ✓".'
		).toContain('solutionsApi.create');
	});

	it('does NOT flip the flow to `submitted` client-side', () => {
		const src = code();
		// The route sets `flows.status = 'submitted'` in the SAME transaction as the insert
		// (backend/src/routes/solutions.ts). Doing it from the browser first marks the flow submitted
		// even when the POST goes on to 422 — a flow that claims to be published and is not.
		expect(
			src,
			'`+page.svelte` PATCHes a flow status. That write belongs to POST /api/solutions, which ' +
				'does it transactionally; doing it here first leaves the flow marked submitted when ' +
				'the submission is refused.'
		).not.toMatch(/flowsApi\.save\([^;]*status\s*:/);
	});

	it('sends the challenge from the URL, not a hard-coded or invented id', () => {
		const src = code();
		expect(src).toContain('challengeId: challengeParam');
		// …and refuses to submit at all without one, rather than posting a null challenge_id.
		expect(src).toMatch(/if \(!builder\.flow \|\| !challengeParam/);
	});

	it('preserves ?challenge= across the boot redirect', () => {
		const src = code();
		expect(
			src,
			'the boot redirect no longer goes through `builderBootUrl`. Rebuilding the URL from the ' +
				'flow id alone drops the `?challenge=` the challenge-page CTA put there, which is the ' +
				'only way a challenge ever reaches /build.'
		).toContain('builderBootUrl(page.url, target)');
	});

	it('preserves ?challenge= across EVERY navigation, not just the boot redirect', () => {
		// ⚠️ This assertion used to be `not.toMatch(/goto\(\s*`\/build\?id=\$\{target\}/)` — anchored
		// on the identifier `target`. Two OTHER navigations in this same file, `newFlow()` and
		// `selectFlow()`, built the same URL from `${created.id}` and `${id}` and sailed straight
		// through it. An adversarial review found them. The consequence was worse than the original
		// bug: arriving from a challenge and clicking "New flow" — the natural move, since boot lands
		// you on an arbitrary pre-existing flow — left Submit permanently disabled with no way back
		// except editing the address bar. So the guard is now written against the SHAPE of the
		// mistake rather than against one instance of it.
		const offenders = [...code().matchAll(/`\/build\?id=\$\{[^`]*`/g)].map((mm) => mm[0]);
		expect(
			offenders,
			'a /build?id= URL is being built by hand instead of through `builderBootUrl`. Every such ' +
				'literal drops `?challenge=`, and a page with no challenge in context cannot submit.'
		).toEqual([]);
	});

	it('renders the refused-publish issues through the same per-node list as a refused run', () => {
		const src = code();
		expect(src).toContain('solutionErrorIssues');
		expect(src).toContain('render issueList(submitIssues)');
		// `issueNodeLabel` is what turns an issue `ref` into the node's canvas label.
		expect(src).toContain('issueNodeLabel');
	});

	it('tells the topbar which challenge is in context, so it can gate the button', () => {
		expect(code()).toContain('challengeId={challengeParam}');
	});
});
