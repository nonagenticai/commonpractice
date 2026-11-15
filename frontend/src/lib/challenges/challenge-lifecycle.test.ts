// src/lib/challenges/challenge-lifecycle.test.ts — the four timeline steps, over the whole
// `status × shipped` product.
//
// ⛔ EVERY ASSERTION NAMES THE EXACT EDIT THAT REDS IT. This repo has shipped tests that stayed
// green with their own defect restored (see the header of
// `routes/solutions/[id]/solution-detail.vote-control.render.test.ts`), so "it passes" is worth
// nothing on its own here.
//
// The truth table is asserted as WHOLE OBJECTS rather than field-by-field: a per-field expectation
// silently tolerates a fifth field appearing, and the point of this module is that the four steps
// are decided together.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// `$lib/paraglide/messages` is GENERATED at build time and is absent from the tree, so the module
// under test cannot even be imported without this. Each key resolves to its own name (the
// challenge-state.test.ts technique): the assertions below are about WHICH message was chosen,
// never about English copy a translator may legitimately reword.
vi.mock('$lib/paraglide/messages', () => {
	const tag = (name: string) => (): string => name;
	return {
		challenge_detail_lc_winner_sub: tag('WINNER_SUB_NEUTRAL'),
		challenge_detail_lc_winner_sub_shipped: tag('WINNER_SUB_SHIPPED'),
		challenge_detail_lc_winner_sub_none: tag('WINNER_SUB_NONE'),
		challenge_lc_state_done: tag('STATE_DONE'),
		challenge_lc_state_active: tag('STATE_ACTIVE'),
		challenge_lc_state_pending: tag('STATE_PENDING'),
		challenge_lc_state_not_reached: tag('STATE_NOT_REACHED')
	};
});

import {
	challengeLifecycle,
	hasShippingSolution,
	lifecycleStepClass,
	lifecycleStateLabel,
	lifecycleWinnerSubLabel,
	type ChallengeLifecycle,
	type LifecycleStepState
} from './challenge-lifecycle';
import type { ChallengeStatus } from '$lib/types/challenges';

const STATUSES: ChallengeStatus[] = ['voting', 'solution_phase', 'closed'];
const STATES: LifecycleStepState[] = ['done', 'active', 'pending', 'not_reached_terminal'];

/** Every `status × shipped` pair — six rows, no sampling. */
const ALL: [ChallengeStatus, boolean][] = STATUSES.flatMap(
	(s) => [[s, false], [s, true]] as [ChallengeStatus, boolean][]
);

const steps = (l: ChallengeLifecycle): LifecycleStepState[] => [
	l.submitted,
	l.voting,
	l.solutionPhase,
	l.winner
];

describe('hasShippingSolution', () => {
	it('is true when ANY solution reached production', () => {
		// Red by: `s.status === 'shipping'` → `s.status === 'voting'` (or any other literal) in
		// challenge-lifecycle.ts.
		expect(hasShippingSolution([{ status: 'shipping' }])).toBe(true);
		expect(hasShippingSolution([{ status: 'voting' }, { status: 'shipping' }])).toBe(true);
		expect(hasShippingSolution([{ status: 'draft' }, { status: 'shipping' }])).toBe(true);
	});

	it('⛔ is FALSE for draft and archived — the negative-predicate trap', () => {
		// THE decisive case. Red by: `s.status === 'shipping'` → `s.status !== 'voting'`, the tempting
		// "anything that moved past voting" shortcut, which calls a NEVER-SUBMITTED draft and a PULLED
		// archived solution a production release — the loudest possible version of this screen's
		// original sin, and one that would tick step 4 on challenges that shipped nothing.
		expect(hasShippingSolution([{ status: 'draft' }])).toBe(false);
		expect(hasShippingSolution([{ status: 'archived' }])).toBe(false);
		expect(hasShippingSolution([{ status: 'draft' }, { status: 'archived' }])).toBe(false);
	});

	it('is false for the ordinary board: every loser left at `voting`, and for no solutions at all', () => {
		// `closeCycle` flips only the winner to 'shipping' and leaves every other row at 'voting'
		// forever, so this is what most closed challenges actually look like on the wire.
		// Red by: `.some(` → `.every(` (empty array then answers true and every closed challenge ticks).
		expect(hasShippingSolution([{ status: 'voting' }, { status: 'voting' }])).toBe(false);
		expect(hasShippingSolution([])).toBe(false);
	});
});

describe('challengeLifecycle — the full truth table', () => {
	// Each row is the whole object. Red for the headline case by returning `'done'` for `winner` on
	// any closed challenge (`winner: shipped ? 'done' : 'not_reached_terminal'` → `winner: 'done'`),
	// which is the "just make the dot teal" fix this module exists to reject.
	it('voting + no shipping solution', () => {
		expect(challengeLifecycle('voting', false)).toEqual({
			submitted: 'done',
			voting: 'active',
			solutionPhase: 'pending',
			winner: 'pending'
		});
	});

	it('⛔ voting + a shipping solution — still `pending`, because an OPEN challenge has not finished', () => {
		// A solution CAN be shipping under an open parent: `POST /api/pipeline/enqueue`
		// (routes/pipeline.ts:561) lets a super_admin queue any solution with no close involved, and
		// `data.solutions[]` spans weeks (no week predicate at routes/challenges.ts:438).
		// Red by: making `shipped` decide step 4 outside the closed branch, e.g.
		// `winner: shipped ? 'done' : 'pending'` in the 'voting' arm.
		expect(challengeLifecycle('voting', true)).toEqual({
			submitted: 'done',
			voting: 'active',
			solutionPhase: 'pending',
			winner: 'pending'
		});
	});

	it('solution_phase + no shipping solution', () => {
		// Red by: `voting: 'done'` → `voting: 'pending'` in the 'solution_phase' arm — the shape of the
		// original bug, where step 3 could never become `done`.
		expect(challengeLifecycle('solution_phase', false)).toEqual({
			submitted: 'done',
			voting: 'done',
			solutionPhase: 'active',
			winner: 'pending'
		});
	});

	it('⛔ solution_phase + a shipping solution — still `pending`, same reason', () => {
		expect(challengeLifecycle('solution_phase', true)).toEqual({
			submitted: 'done',
			voting: 'done',
			solutionPhase: 'active',
			winner: 'pending'
		});
	});

	it('closed + a shipping solution — the whole arc behind it', () => {
		// Red by: `solutionPhase: 'done'` → `solutionPhase: ''`/`'pending'` in the closed arm, which is
		// literally what `+page.svelte:354` used to compute (`status === 'solution_phase' ? 'active' : ''`).
		expect(challengeLifecycle('closed', true)).toEqual({
			submitted: 'done',
			voting: 'done',
			solutionPhase: 'done',
			winner: 'done'
		});
	});

	it('⛔ closed + NOTHING shipped — `not_reached_terminal`, the dominant live state', () => {
		// The row the board is mostly made of, and the one both rejected designs get wrong:
		//   `winner: 'done'`    → a tick over nothing (nine winnerless prod weeks would all show one).
		//   `winner: 'pending'` → the ORIGINAL grey, i.e. "still to come" on a week that is over.
		// Red by either substitution in the closed arm.
		expect(challengeLifecycle('closed', false)).toEqual({
			submitted: 'done',
			voting: 'done',
			solutionPhase: 'done',
			winner: 'not_reached_terminal'
		});
	});
});

describe('challengeLifecycle — properties that hold across all six rows', () => {
	it('step 1 is `done` in every row: a challenge that exists was submitted', () => {
		// Red by: `submitted:` anything but 'done' in any arm.
		for (const [status, shipped] of ALL) {
			expect(challengeLifecycle(status, shipped).submitted, `${status}/${shipped}`).toBe('done');
		}
	});

	it('⛔ a CLOSED challenge has ZERO `active` steps; every open one has EXACTLY ONE', () => {
		// "Where is this challenge right now" must have exactly one answer while it is open, and none
		// once it is over — a closed challenge with a live-looking current step is the same lie as a
		// teal pill on a challenge the server refuses to accept votes for.
		// Red by: leaving `solutionPhase: 'active'` in the closed arm, or by giving the closed arm any
		// 'active'; and in the other direction by `voting: 'done'` in the 'voting' arm.
		for (const [status, shipped] of ALL) {
			const n = steps(challengeLifecycle(status, shipped)).filter((s) => s === 'active').length;
			expect(n, `${status}/${shipped}`).toBe(status === 'closed' ? 0 : 1);
		}
	});

	it('⛔ `not_reached_terminal` is producible ONLY under `closed`, and only on step 4', () => {
		// The header's rule made executable: steps 2–3 are `done` in the weak "this window is behind
		// the challenge" sense, because `healOrphanedChallenges` can close a challenge that never
		// entered `solution_phase` and the DTO carries no phase history. Claiming a phase provably did
		// not happen is a claim the payload cannot support anywhere but step 4.
		// Red by: emitting 'not_reached_terminal' for `solutionPhase` in the closed arm — the "be even
		// more honest" move that is actually a fourth invented fact.
		for (const [status, shipped] of ALL) {
			const l = challengeLifecycle(status, shipped);
			expect([l.submitted, l.voting, l.solutionPhase], `${status}/${shipped}`).not.toContain(
				'not_reached_terminal'
			);
			if (status !== 'closed') {
				expect(l.winner, `${status}/${shipped}`).not.toBe('not_reached_terminal');
			}
		}
		expect(challengeLifecycle('closed', false).winner).toBe('not_reached_terminal');
	});

	it('⛔ a CLOSED challenge has NO `pending` step anywhere', () => {
		// `pending` means "still ahead of us". Nothing is ahead of a closed week — re-deciding it needs
		// an admin `force` on the cycle, not the passage of time. This is the property that forbids the
		// rejected `winner: 'pending'` design, and it fails independently of the truth-table rows.
		// Red by: `winner: shipped ? 'done' : 'not_reached_terminal'` → `... : 'pending'`.
		for (const shipped of [true, false]) {
			expect(steps(challengeLifecycle('closed', shipped)), `shipped=${shipped}`).not.toContain(
				'pending'
			);
		}
	});

	it('every row uses only declared states, and `challengeLifecycle` is total over its input', () => {
		// Red by: adding an arm that returns a string outside `LifecycleStepState` (tsc would catch a
		// literal, but not a widened `as string`), or by dropping a `case` so a status returns undefined.
		for (const [status, shipped] of ALL) {
			const l = challengeLifecycle(status, shipped);
			expect(Object.keys(l).sort()).toEqual(
				['solutionPhase', 'submitted', 'voting', 'winner'].sort()
			);
			for (const s of steps(l)) expect(STATES, `${status}/${shipped}`).toContain(s);
		}
	});
});

describe('lifecycleStepClass', () => {
	it('is total — every declared state maps to a non-empty class', () => {
		// Red by: dropping any `case` from the switch (the dropped state then returns undefined, and the
		// `<li>` goes back to having no class at all — the original defect, exactly).
		for (const s of STATES) {
			const cls = lifecycleStepClass(s);
			expect(cls, s).toBeTruthy();
			expect(typeof cls, s).toBe('string');
		}
	});

	it('⛔ is INJECTIVE — four states, four DISTINCT classes', () => {
		// THE collapse that resurrects the grey lie: mapping `not_reached_terminal → 'pending'`, on the
		// reasoning that neither is teal. It would repaint the terminal step in the colour that means
		// "still to come", which is the bug this whole module removes.
		// Red by: `case 'not_reached_terminal': return 'terminal'` → `return 'pending'` (or by
		// collapsing 'active' into 'done', the other plausible merge).
		const classes = STATES.map(lifecycleStepClass);
		expect(new Set(classes).size).toBe(STATES.length);
		expect(classes).toEqual(['done', 'active', 'pending', 'terminal']);
	});

	it('⛔ never returns the empty string — "no class" is not a state', () => {
		// Red by: `case 'pending': return 'pending'` → `return ''`, i.e. going back to the implicit
		// third state the CSS used to rely on.
		for (const s of STATES) expect(lifecycleStepClass(s), s).not.toBe('');
	});
});

describe('the words', () => {
	it('⛔ the WINNER sub-label picks a DIFFERENT key per outcome', () => {
		// The terminal case must not reuse the neutral "IT reviews the winning solution and releases
		// it" — that sentence promises a review that will never happen on a closed, winnerless week.
		// Red by: `case 'not_reached_terminal': return m.challenge_detail_lc_winner_sub_none()` →
		// `return m.challenge_detail_lc_winner_sub()`.
		expect(lifecycleWinnerSubLabel('done')).toBe('WINNER_SUB_SHIPPED');
		expect(lifecycleWinnerSubLabel('not_reached_terminal')).toBe('WINNER_SUB_NONE');
		expect(lifecycleWinnerSubLabel('pending')).toBe('WINNER_SUB_NEUTRAL');
		expect(new Set(STATES.map(lifecycleWinnerSubLabel)).size).toBe(3); // 'active' shares 'pending'
	});

	it('⛔ every state has its OWN sr-only word — the state is never colour-only', () => {
		// Red by: collapsing any two arms of `lifecycleStateLabel`, e.g.
		// `case 'not_reached_terminal': return m.challenge_lc_state_pending()`. A shared word is a
		// screen-reader-visible version of the same grey-dot collapse `lifecycleStepClass` forbids.
		const words = STATES.map(lifecycleStateLabel);
		expect(new Set(words).size).toBe(STATES.length);
		expect(words).toEqual(['STATE_DONE', 'STATE_ACTIVE', 'STATE_PENDING', 'STATE_NOT_REACHED']);
	});

	it('⛔ the catalog carries all six new keys in all 8 locales, with no English left in the other 7', () => {
		// `$lib/i18n/catalogs.test.ts` enforces key-set PARITY, which a copy-paste of the en values
		// satisfies perfectly — a locale would then silently render English inside a Dutch card. This
		// asserts the values actually differ.
		// Red by: pasting the `en` value for any of the six keys into any non-en catalog.
		const NEW = [
			'challenge_detail_lc_winner_sub_shipped',
			'challenge_detail_lc_winner_sub_none',
			'challenge_lc_state_done',
			'challenge_lc_state_active',
			'challenge_lc_state_pending',
			'challenge_lc_state_not_reached'
		];
		const read = (l: string) =>
			JSON.parse(
				readFileSync(resolve(process.cwd(), 'messages', `${l}.json`), 'utf8')
			) as Record<string, string>;
		const en = read('en');
		for (const key of NEW) expect(en[key], `en is missing ${key}`).toBeTruthy();
		for (const locale of ['nl', 'de', 'fr', 'es', 'pl', 'ar', 'he']) {
			const cat = read(locale);
			for (const key of NEW) {
				expect(cat[key], `${locale} is missing ${key}`).toBeTruthy();
				expect(cat[key], `${locale}.${key} is byte-identical to en`).not.toBe(en[key]);
			}
		}
	});
});

describe('challengeLifecycle is TOTAL — an unknown wire status must not blank the page', () => {
	/**
	 * ⛔ THE REGRESSION THIS PINS, MEASURED RATHER THAN IMAGINED.
	 *
	 * `challengeLifecycle` is a `switch` over `ChallengeStatus`. tsc proves it exhaustive at compile
	 * time — and tsc does not run in production, where `status` arrives off the wire. Without a
	 * `default` the switch returns `undefined`, `lifecycle` in `+page.svelte` becomes `undefined`,
	 * and the guard `{:else if data && viewState && lifecycle}` matches NO branch. There is no
	 * trailing `{:else}`. An adversarial review rendered it: a 24-character body containing only the
	 * back link. The entire challenge detail screen disappears.
	 *
	 * That is strictly WORSE than the defect this module was written to remove. `challengeState` is
	 * total (an if-chain ending in an unconditional return), so before this module existed an
	 * unknown status still rendered the whole page — with one grey dot. Trading a cosmetic bug for a
	 * blank page is the same failure class as the keyed `{#each}` that blanked /governance.
	 *
	 * Reachable the moment a fourth phase is added BACKEND-FIRST, which is precisely the
	 * rolling-deploy window this module's own header invokes to reject the `weekly_winners` design.
	 *
	 * ⛔ NON-VACUITY: delete the `default` arm from `challengeLifecycle`. Every assertion below
	 * fails on `undefined`.
	 */
	const UNKNOWN = 'peer_review' as ChallengeStatus; // a plausible 4th phase, not in the enum today

	it('returns a complete lifecycle object rather than undefined', () => {
		for (const shipped of [false, true]) {
			const lc = challengeLifecycle(UNKNOWN, shipped);
			expect(lc, `unknown status + shipped=${shipped} returned nothing`).toBeDefined();
			// Every step must be a real state, or `lifecycleStepClass` hands `class={undefined}` to the
			// `<li>` and we are back to the classless element this module deleted.
			for (const [step, state] of Object.entries(lc)) {
				expect(state, `step ${step} has no state`).toBeTruthy();
				expect(['done', 'active', 'pending', 'not_reached_terminal']).toContain(state);
			}
		}
	});

	it('never claims a terminal outcome for a phase it does not understand', () => {
		// `not_reached_terminal` asserts "this definitively did not happen and never will". An
		// unrecognised phase is the one case where we know least, so it must never make that claim.
		for (const shipped of [false, true]) {
			expect(Object.values(challengeLifecycle(UNKNOWN, shipped))).not.toContain(
				'not_reached_terminal'
			);
		}
	});

	it('maps every step of an unknown status to a real CSS class', () => {
		const lc = challengeLifecycle(UNKNOWN, false);
		for (const state of Object.values(lc)) {
			const cls = lifecycleStepClass(state);
			expect(cls, 'a step resolved to no class — the original defect, restored').toBeTruthy();
			expect(['done', 'active', 'pending', 'terminal']).toContain(cls);
		}
	});
});
