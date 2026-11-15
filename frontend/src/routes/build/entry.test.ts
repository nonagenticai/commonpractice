// Unit tests for the /build entry point's two pure decisions — the boot redirect URL and the
// `POST /api/solutions` payload.
//
// These are BEHAVIOURAL, not greps: both functions are pure, so they are driven directly. The
// companion `build-page.submit.test.ts` is the (honestly labelled) text guard that the page still
// CALLS them; this file is what says they are right.
//
// What they are guarding: CommonPractice's loop is challenge → build → vote → weekly winner →
// pipeline, and in production it had no entry point at all — 8 consecutive `marketplace_cycles`
// closed with `winner_solution_id` NULL and not one user-submitted solution had ever existed. Two
// bugs, one each:
//   • the boot redirect rebuilt `/build?id=<flow>` and dropped the `?challenge=` the challenge
//     page's CTA had put there, so a moment after landing there was no challenge in context;
//   • Submit PATCHed `flows.status = 'submitted'` — a field nothing in the product reads — and
//     never posted a solution, so the button said "Submitted ✓" and nothing existed.
import { describe, it, expect } from 'vitest';
import {
	builderBootUrl,
	isDefaultFlowName,
	solutionSubmissionPayload,
	MAX_BLOCKS_USED,
	MAX_TITLE_LENGTH
} from './entry';

describe('builderBootUrl', () => {
	it('carries ?challenge= across the boot redirect', () => {
		const url = new URL('https://cp.test/build?challenge=ch-42');
		const out = builderBootUrl(url, 'flow-1');

		// The assertion that matters: the challenge survives. Read it back off the URL rather than
		// pinning a string, so param ORDER is not what this test is about.
		const params = new URL(out, 'https://cp.test').searchParams;
		expect(
			params.get('challenge'),
			'the boot redirect dropped ?challenge=. The challenge page CTA links to ' +
				'/build?challenge=<id> with no ?id=, so this redirect is the only path that carries a ' +
				'challenge — losing it here leaves the builder with nothing to submit to.'
		).toBe('ch-42');
		expect(params.get('id')).toBe('flow-1');
	});

	it('omits ?challenge= entirely when free-building', () => {
		const out = builderBootUrl(new URL('https://cp.test/build'), 'flow-1');
		expect(out).toBe('/build?id=flow-1');
		// Not `challenge=` with an empty value — the page's `$effect` treats any truthy param as a
		// challenge to fetch, and `?challenge=` would be a 404 lookup on every free build.
		expect(out).not.toContain('challenge');
	});

	it('ignores an empty ?challenge= rather than forwarding it', () => {
		expect(builderBootUrl(new URL('https://cp.test/build?challenge='), 'flow-1')).toBe(
			'/build?id=flow-1'
		);
	});

	it('drops unrelated params — the redirect is not a general-purpose URL rewriter', () => {
		const out = builderBootUrl(new URL('https://cp.test/build?challenge=ch-1&id=stale&x=1'), 'flow-9');
		const params = new URL(out, 'https://cp.test').searchParams;
		expect(params.get('id')).toBe('flow-9');
		expect(params.get('challenge')).toBe('ch-1');
		expect(params.get('x')).toBeNull();
	});

	it('percent-encodes the challenge id it was handed', () => {
		const out = builderBootUrl(new URL('https://cp.test/build?challenge=a%20b%26c'), 'f');
		expect(out).toContain('challenge=a+b%26c');
		expect(new URL(out, 'https://cp.test').searchParams.get('challenge')).toBe('a b&c');
	});
});

describe('solutionSubmissionPayload', () => {
	const base = { challengeId: 'ch-1', title: 'My flow', flowId: 'flow-1' };

	it('sends exactly the keys createSolutionSchema declares, and no others', () => {
		const payload = solutionSubmissionPayload({ ...base, nodeSlugs: ['http-fetch', 'llm-summarize'] });

		// `createSolutionSchema` is `.strict()` (backend/src/routes/solutions.ts): ANY extra key is a
		// 400 whose Zod body has no `message`, so the author loses the submission to an opaque error.
		// Asserting the key SET — not just the values — is what makes that a test failure here.
		expect(Object.keys(payload).sort()).toEqual(['blocks_used', 'challenge_id', 'flow_id', 'title']);
		expect(payload).toEqual({
			challenge_id: 'ch-1',
			title: 'My flow',
			flow_id: 'flow-1',
			blocks_used: ['http-fetch', 'llm-summarize']
		});
	});

	it('OMITS blocks_used on an empty canvas rather than sending [] or undefined', () => {
		const payload = solutionSubmissionPayload({ ...base, nodeSlugs: [] });
		expect(Object.keys(payload).sort()).toEqual(['challenge_id', 'flow_id', 'title']);
		expect('blocks_used' in payload).toBe(false);
	});

	it('drops the slugless loop containers instead of sending undefined entries', () => {
		// A `foreach` node has `kind: 'foreach'` and no `slug` — `z.array(z.string())` rejects a null.
		const payload = solutionSubmissionPayload({
			...base,
			nodeSlugs: ['http-fetch', undefined, null, '', 'llm-summarize']
		});
		expect(payload.blocks_used).toEqual(['http-fetch', 'llm-summarize']);
	});

	it('de-duplicates repeated blocks, keeping first-seen order', () => {
		const payload = solutionSubmissionPayload({
			...base,
			nodeSlugs: ['llm-summarize', 'http-fetch', 'llm-summarize', 'http-fetch']
		});
		expect(payload.blocks_used).toEqual(['llm-summarize', 'http-fetch']);
	});

	it('truncates to the route caps rather than sending a guaranteed 400', () => {
		const many = Array.from({ length: 60 }, (_, i) => `block-${i}`);
		const payload = solutionSubmissionPayload({
			...base,
			title: 'x'.repeat(400),
			nodeSlugs: many
		});
		expect(payload.blocks_used).toHaveLength(MAX_BLOCKS_USED);
		expect(payload.title).toHaveLength(MAX_TITLE_LENGTH);
	});

	it('trims the flow name into the title', () => {
		const payload = solutionSubmissionPayload({ ...base, title: '  Spaced  ', nodeSlugs: [] });
		expect(payload.title).toBe('Spaced');
	});
});

describe('isDefaultFlowName', () => {
	// The eight strings `/build` actually auto-creates flows with — `build_new_flow_default_name`
	// in each of the SPEC §5B locales, in `paraglide/runtime`'s own order (en first).
	const DEFAULTS = [
		'Untitled flow',
		'Naamloze flow',
		'Przepływ bez nazwy',
		'Flux sans titre',
		'Flujo sin título',
		'Unbenannter Flow',
		'تدفق بدون عنوان',
		'זרימה ללא שם'
	] as const;

	it('rejects the name the builder invented in the CURRENT locale', () => {
		expect(isDefaultFlowName('Naamloze flow', DEFAULTS)).toBe(true);
	});

	it('rejects a default name from ANOTHER locale — the flow in prod today', () => {
		// The live defect: the product's first user-submitted solution is titled "Untitled flow".
		// The name is baked in at CREATE time, in whatever locale the author had then; the reader's
		// locale is irrelevant to it. A gate that only knew the current locale's default would let
		// an English-created flow through a Dutch UI, which is exactly the row that exists.
		expect(
			isDefaultFlowName('Untitled flow', DEFAULTS),
			'a flow created in English sails through the gate. `solutions.title` is copied verbatim ' +
				'from the flow name, so this is how "Untitled flow" becomes a weekly winner and a ' +
				'pipeline card.'
		).toBe(true);
		for (const d of DEFAULTS) {
			expect(isDefaultFlowName(d, DEFAULTS), `${d} was not recognised as a default`).toBe(true);
		}
	});

	it('rejects an empty or whitespace-only name', () => {
		expect(isDefaultFlowName('', DEFAULTS)).toBe(true);
		expect(isDefaultFlowName('   ', DEFAULTS)).toBe(true);
		expect(isDefaultFlowName('\t\n ', DEFAULTS)).toBe(true);
		// …and with no defaults supplied at all, so this branch cannot be satisfied by the list.
		expect(isDefaultFlowName('  ', [])).toBe(true);
	});

	it('accepts a name a human chose', () => {
		expect(isDefaultFlowName('Claimformulier-samenvatter', DEFAULTS)).toBe(false);
		expect(isDefaultFlowName('x', DEFAULTS)).toBe(false);
	});

	it('matches EXACTLY, not by substring — "Untitled flow v2" is a real name', () => {
		// The whole reason this is `===` on the trimmed value and not `.includes(`: a user who
		// deliberately builds a v2 off the default name has named their flow, and refusing it
		// forever would be a worse defect than the one being fixed.
		expect(
			isDefaultFlowName('Untitled flow v2', DEFAULTS),
			'the gate matches by substring, so every name that CONTAINS a default is refused — ' +
				'"Untitled flow v2" can never be submitted.'
		).toBe(false);
		expect(isDefaultFlowName('Naamloze flow (kopie)', DEFAULTS)).toBe(false);
		expect(isDefaultFlowName('Re: Untitled flow', DEFAULTS)).toBe(false);
	});

	it('trims both sides before comparing', () => {
		expect(isDefaultFlowName('  Naamloze flow  ', DEFAULTS)).toBe(true);
		expect(isDefaultFlowName('Naamloze flow', ['  Naamloze flow  '])).toBe(true);
	});

	it('is paraglide-free — the caller owns the locale list', () => {
		// Same convention as `lib/admin/license-chip.ts`: pure in, pure out. Passing a single
		// locale's defaults must still work, so the function never reaches for a runtime locale.
		expect(isDefaultFlowName('Untitled flow', ['Untitled flow'])).toBe(true);
		expect(isDefaultFlowName('Untitled flow', ['Naamloze flow'])).toBe(false);
	});
});
