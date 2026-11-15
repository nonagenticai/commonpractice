import { describe, it, expect } from 'vitest';
import { nextStep, latestDraftWithWork, nextStepInput, STEPS } from './next-step';
import type { FlowListItem } from '$lib/types/flows';
import type { HomeSummary } from '$lib/types/marketplace';

const base = { submittedTotal: 0, unvotedOpen: 0, open: 0, draftFlowId: null };

describe('nextStep — the one Kaizen step Home highlights', () => {
	it('nothing submitted → step 1, submit a challenge', () => {
		expect(nextStep({ ...base, unvotedOpen: 3, open: 3 })).toEqual({ step: 'report', action: 'submit', href: '/submit' });
	});

	it('submitted, open challenges not yet voted on → step 2, review', () => {
		expect(nextStep({ ...base, submittedTotal: 1, unvotedOpen: 2, open: 4 })).toEqual({
			step: 'prioritise',
			action: 'vote',
			href: '/challenges'
		});
	});

	it('a draft flow with work on it wins over everything → step 3, continue building that flow', () => {
		expect(nextStep({ ...base, unvotedOpen: 5, open: 5, draftFlowId: 'f/1' })).toEqual({
			step: 'build',
			action: 'continue',
			href: '/build?id=f%2F1'
		});
	});

	it('submitted and voted on every open challenge → step 3, build a solution', () => {
		expect(nextStep({ ...base, submittedTotal: 2, unvotedOpen: 0, open: 3 })).toEqual({
			step: 'build',
			action: 'build',
			href: '/build'
		});
	});

	it('submitted and nothing open → step 4, the solutions', () => {
		expect(nextStep({ ...base, submittedTotal: 2 })).toEqual({ step: 'practice', action: 'results', href: '/solutions' });
	});

	it('the strip has the four steps in loop order, each linking to its own page', () => {
		expect(STEPS.map((s) => s.id)).toEqual(['report', 'prioritise', 'build', 'practice']);
		expect(STEPS.map((s) => s.href)).toEqual(['/submit', '/challenges', '/build', '/solutions']);
	});
});

const flow = (id: string, status: FlowListItem['status'], nodes: number, updated: string): FlowListItem => ({
	id,
	name: id,
	description: '',
	status,
	version: '0.1.0',
	node_count: nodes,
	last_saved_at: updated,
	updated_at: updated
});

describe('latestDraftWithWork', () => {
	it('ignores the empty draft /build creates on first visit', () => {
		expect(latestDraftWithWork([flow('empty', 'draft', 0, '2026-10-14T10:00:00Z')])).toBeNull();
	});

	it('picks the newest draft that has blocks, never a submitted flow', () => {
		const items = [
			flow('old', 'draft', 2, '2026-10-01T10:00:00Z'),
			flow('sub', 'submitted', 4, '2026-10-14T12:00:00Z'),
			flow('new', 'draft', 1, '2026-10-13T10:00:00Z'),
			flow('blank', 'draft', 0, '2026-10-14T13:00:00Z')
		];
		expect(latestDraftWithWork(items)).toBe('new');
	});
});

describe('nextStepInput', () => {
	const summary = (over: Partial<HomeSummary['yourActivity']>, voted: boolean[]): HomeSummary =>
		({
			stats: { activeChallenges: 0, solutionsInVoting: 0, activeBuilders: 0, liveInProduction: 0 },
			cycle: null,
			trending: voted.map((v, i) => ({ id: `c${i}`, hasVoted: v })),
			yourActivity: { submitted: [], submittedTotal: 0, votedOn: [], votedOnTotal: 0, ...over }
		}) as unknown as HomeSummary;

	it('counts the open challenges this reader has not voted on', () => {
		expect(nextStepInput(summary({ submittedTotal: 1 }, [true, false, false]), null)).toEqual({
			submittedTotal: 1,
			unvotedOpen: 2,
			open: 3,
			draftFlowId: null
		});
	});

	it('an old backend without submittedTotal falls back to the slice length, never NaN', () => {
		const old = summary({ submitted: [{ id: 'x' } as never], submittedTotal: undefined as unknown as number }, []);
		expect(nextStepInput(old, null).submittedTotal).toBe(1);
	});
});
