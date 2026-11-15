// src/routes/pipeline/pipeline-page.no-reviewer-count.test.ts — a TEXT guard against the exact
// literal that caused the defect.
//
// `+page.svelte` used to call `pipelineApi.move(card.id, { reviewed: true, reviewerCount: 2 })`.
// That hard-coded `2` was a CLIENT-SUPPLIED AUTHORIZATION INPUT: the backend's promotion gate
// compared it against `promotion.required_reviewers`, so one click by one admin satisfied "2
// reviewers required" — and because nothing in the product could ever send a 3, setting the policy
// to 3 (an option the Governance screen offers) deadlocked promotion permanently, with a fully
// green test suite. Migration 0062 moved the count onto real per-reviewer rows counted server-side.
//
// ⚠️ BE HONEST ABOUT WHAT THIS TEST IS. It is a GREP, not a behavioural assertion. It cannot prove
// the count is right; it only stops the specific literal from being reintroduced by a well-meaning
// revert or copy-paste. THE REAL GUARANTEE IS SERVER-SIDE and lives in backend/tests/pipeline.test.ts:
// T1 ("a client-supplied reviewerCount is ignored") sends `reviewerCount: 99` over the wire and
// asserts the recorded count is 1 and the gate refuses at `(have 1)`. Even if this file were
// deleted and the literal restored, T1 would still fail. This test exists because the literal is
// cheap to reintroduce and expensive to notice, not because it is the thing holding the property.
//
// Reading source text from disk in a vitest test is an established pattern in this repo — see
// `src/lib/api/error-message.backend-contract.test.ts`, which walks `backend/src` the same way and
// documents why (two separate Bun projects, no shared-types or codegen step to lean on).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));

describe('the pipeline page never asserts a reviewer count', () => {
	it('contains no `reviewerCount` literal in its request payload', () => {
		const src = readFileSync(PAGE, 'utf-8');

		// Sanity: the file must be the one we think it is, or this passes vacuously after a move.
		expect(src).toContain('pipelineApi.move');

		// Strip comments before searching — the explanatory note above `toggleReview` names the
		// field deliberately, and a guard that a comment can trip is a guard nobody keeps.
		const code = src
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^[ \t]*\/\/.*$/gm, '')
			.replace(/<!--[\s\S]*?-->/g, '');

		const offenders = [...code.matchAll(/reviewerCount/g)];
		expect(
			offenders.length,
			'`+page.svelte` mentions `reviewerCount` in executable code. The browser must never ' +
				'assert how many people reviewed a card — that number gates a production deploy and is ' +
				'derived server-side from `pipeline_reviews` rows (migration 0062). Send ' +
				'`{ reviewed: true }` to record ONE review by the acting admin instead.',
		).toBe(0);
	});

	// D3: the confirmation must report the action that was taken. `toggleReview` flashed
	// `pipeline_flash_reviewed` ("… marked reviewed") in BOTH directions, so an admin who had just
	// revoked their approval was told they had granted one — the same class of mistake as D1's
	// audit copy, on the other side of the wire.
	it('flashes DIFFERENT copy for an approval and a withdrawal', () => {
		const src = readFileSync(PAGE, 'utf-8');
		expect(
			src,
			'`toggleReview` does not reference `pipeline_flash_review_withdrawn`, so it reports the ' +
				'same "marked reviewed" copy in both directions — telling an admin who withdrew their ' +
				'approval that they granted one.',
		).toContain('pipeline_flash_review_withdrawn');
		expect(src).toContain('pipeline_flash_reviewed');
	});

	it('sends the review toggle as a patch carrying ONLY `reviewed`', () => {
		const src = readFileSync(PAGE, 'utf-8');
		// Exactly one key in the payload. Matching the key SET rather than a particular expression
		// keeps this from breaking every time the direction is computed differently — the property
		// that matters is that nothing else rides along.
		expect(src).toMatch(/pipelineApi\.move\(\s*card\.id,\s*\{\s*reviewed:\s*\w+\s*\}\s*\)/);
		// …and the direction comes from the card's own state rather than always asserting `true`,
		// which is what makes withdrawing possible at all.
		expect(src).toContain('card.myReview');
	});
});
