// @vitest-environment jsdom
//
// Render guards for the pipeline card's review control (migration 0062 + the follow-up review).
//
// The control was reworked from "an Approve button that disappears once the card is reviewed" into
// an always-rendered add/withdraw toggle. That rework created two defects this file pins, both
// found by adversarial review:
//
//   D2 — the toggle rendered on LIVE PRODUCTION cards too, so the two reviewers of a shipped card
//        could click Withdraw and hard-delete the record of why it was allowed to ship, leaving it
//        live at 100% rollout with `reviewer_count = 0` and no tombstone. Newly reachable: before
//        the rework the button vanished once reviewed.
//   D4 — the "you can't approve your own card" reason lived only in `title=` on a DISABLED button.
//        Disabled buttons are out of the tab order and titles are not reliably announced, so
//        keyboard/AT users got no reason at all. Same title-only pattern on the reviewer avatars.
//
// ⚠️ These are DOM assertions about affordances. The server-side guarantees are separate and are
// what actually hold: backend/tests/pipeline.test.ts D2 asserts the PATCH itself is refused with
// 422 `review_locked`, because a UI-only guard is not a guard — the request is reachable whatever
// this component renders.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { PipelineCard, PipelinePolicy } from '$lib/types/pipeline';

vi.mock('$lib/paraglide/messages', () => ({
	ops_kancard_unassigned: () => 'Unassigned',
	ops_kancard_won: () => ' won',
	ops_kancard_live: () => 'live',
	ops_kancard_day_progress: () => 'day',
	ops_kancard_rollout: () => 'rollout',
	ops_kancard_reviewed: () => 'reviewed',
	ops_kancard_needs_review: () => 'needs review',
	ops_kancard_approved_by: () => 'approved by',
	ops_kancard_reviewers_progress: ({ count, required }: { count: number; required: number }) =>
		`${count} of ${required} reviewers`,
	ops_kancard_reviewers_count: ({ count }: { count: number }) => `${count} reviewers`,
	ops_kancard_reviewers_list: ({ names }: { names: string }) => `Reviewed by ${names}`,
	ops_kancard_review_add: () => 'APPROVE_BUTTON',
	ops_kancard_review_withdraw: () => 'WITHDRAW_BUTTON',
	ops_kancard_review_self_note: () => 'SELF_NOTE_VISIBLE',
	ops_kancard_review_self_title: () => 'SELF_TITLE',
	pipeline_rollback: () => 'Roll back'
}));

const POLICY: PipelinePolicy = { mandatoryReview: true, requiredReviewers: 2 };

function makeCard(over: Partial<PipelineCard> = {}): PipelineCard {
	return {
		id: 'card-1',
		title: 'A card',
		solutionId: null,
		challengeCode: null,
		challengeId: null,
		author: { name: 'Ada Author', initials: 'AA' },
		stage: 'hardening',
		week: null,
		rolloutPct: 0,
		progress: null,
		reviewed: false,
		reviewerCount: 0,
		reviewers: [],
		myReview: false,
		isAuthor: false,
		featured: false,
		live: false,
		position: 0,
		...over
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

// ⚠️ `policy` is REQUIRED and passed explicitly at every call site — no default parameter. A
// default would swallow an explicit `undefined`, and "the backend has not rolled and sent no
// policy" is exactly the case the last test in this file needs to construct.
async function render(card: PipelineCard, policy: PipelinePolicy | undefined) {
	const { default: KanbanCard } = await import('./KanbanCard.svelte');
	app = mount(KanbanCard, {
		target: host,
		props: { card, policy, onToggleReview: () => {}, onRollback: () => {} }
	});
	flushSync();
	return host;
}

describe('D2 — a live Production card cannot have its approvals withdrawn from the UI', () => {
	it('renders NO review toggle on a production card, even for one of its reviewers', async () => {
		const el = await render(
			makeCard({
				stage: 'production',
				live: true,
				rolloutPct: 100,
				reviewed: true,
				reviewerCount: 2,
				myReview: true,
				reviewers: [
					{ id: 'u1', name: 'Pipe Admin', initials: 'PA', at: '2026-08-09T00:00:00Z' },
					{ id: 'u2', name: 'Bea Reviewer', initials: 'BR', at: '2026-08-09T00:00:00Z' }
				]
			}),
			POLICY
		);
		expect(el.textContent).not.toContain('WITHDRAW_BUTTON');
		expect(el.textContent).not.toContain('APPROVE_BUTTON');
		// The standing is still SHOWN — the record stays visible, it just is not editable.
		expect(el.textContent).toContain('2 of 2 reviewers');
		// The rollback control is how you un-ship a card; it must still be there.
		expect(el.textContent).toContain('Roll back');
	});

	it('DOES render the toggle on a non-production card (so the test above is not vacuous)', async () => {
		const el = await render(makeCard({ stage: 'staging', myReview: true, reviewerCount: 1 }), POLICY);
		expect(el.textContent).toContain('WITHDRAW_BUTTON');
	});
});

describe('D4 — the reason a control is refused is reachable, not title-only', () => {
	it('renders the own-card reason as VISIBLE TEXT wired via aria-describedby', async () => {
		const el = await render(makeCard({ isAuthor: true }), POLICY);
		const btn = el.querySelector('button.approve') as HTMLButtonElement | null;
		expect(btn).not.toBeNull();
		expect(btn!.disabled).toBe(true);

		// The reason is real text in the DOM, not only a `title=` on a disabled (unfocusable) button.
		expect(el.textContent).toContain('SELF_NOTE_VISIBLE');

		// …and it is programmatically associated with the control it explains.
		const describedBy = btn!.getAttribute('aria-describedby');
		expect(describedBy).toBeTruthy();
		const note = el.ownerDocument.getElementById(describedBy!);
		expect(note, `no element with id "${describedBy}" — aria-describedby points at nothing`).not.toBeNull();
		expect(note!.textContent).toContain('SELF_NOTE_VISIBLE');
	});

	it('does not show the own-card note when the card is not yours', async () => {
		const el = await render(makeCard({ isAuthor: false }), POLICY);
		expect(el.textContent).not.toContain('SELF_NOTE_VISIBLE');
		const btn = el.querySelector('button.approve') as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
		expect(btn.getAttribute('aria-describedby')).toBeNull();
	});

	it('exposes the reviewers by NAME, not only as initials in a title attribute', async () => {
		const el = await render(
			makeCard({
				reviewerCount: 2,
				reviewers: [
					{ id: 'u1', name: 'Pipe Admin', initials: 'PA', at: '2026-08-09T00:00:00Z' },
					{ id: 'u2', name: 'Bea Reviewer', initials: 'BR', at: '2026-08-09T00:00:00Z' }
				]
			}),
			POLICY
		);
		// Names are text content (in an sr-only span), so assistive tech reads them.
		expect(el.textContent).toContain('Reviewed by Pipe Admin, Bea Reviewer');
		// The decorative initials are hidden from AT so the names are not announced twice.
		const avatarWrap = el.querySelector('.reviewer-avatars span[aria-hidden="true"]');
		expect(avatarWrap).not.toBeNull();
	});
});

describe('the pre-0062 fallback still renders when the backend sent no policy', () => {
	it('falls back to the old copy rather than throwing on the missing fields', async () => {
		const el = await render(makeCard({ reviewed: false }), undefined);
		expect(el.textContent).toContain('needs review');
		expect(el.textContent).toContain('APPROVE_BUTTON');
	});
});
