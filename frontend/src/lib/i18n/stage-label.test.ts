// src/lib/i18n/stage-label.test.ts — the stage vocabulary resolves from the ENUM, never from
// the English strings the backend still sends alongside it.
//
// The messages module is mocked so each key returns its own name: the assertions are about
// WHICH MESSAGE is selected, not about English copy that a translator may legitimately reword.
// (Same technique as ops/pipeline-stats.render.test.ts and kanban-card.review-control.render.test.ts.)
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	pipeline_stage_won: () => 'M_WON',
	pipeline_stage_review: () => 'M_REVIEW',
	pipeline_stage_hardening: () => 'M_HARDENING',
	pipeline_stage_staging: () => 'M_STAGING',
	pipeline_stage_production: () => 'M_PRODUCTION'
}));

const { stageLabel } = await import('./stage-label');

describe('stageLabel', () => {
	it('resolves every stage the backend can send, plus the synthetic `won` step', () => {
		expect(stageLabel('won')).toBe('M_WON');
		expect(stageLabel('review')).toBe('M_REVIEW');
		expect(stageLabel('hardening')).toBe('M_HARDENING');
		expect(stageLabel('staging')).toBe('M_STAGING');
		expect(stageLabel('production')).toBe('M_PRODUCTION');
	});

	it('covers all five timeline steps — no key is silently missing', () => {
		// `solutionTimeline` emits exactly these five, in this order. A stage added server-side
		// without a catalog key would fall to the default branch and ship a raw enum; this pins
		// that today's five are all resolved.
		const steps = ['won', 'review', 'hardening', 'staging', 'production'];
		const labels = steps.map(stageLabel);
		expect(labels).toEqual(['M_WON', 'M_REVIEW', 'M_HARDENING', 'M_STAGING', 'M_PRODUCTION']);
		expect(new Set(labels).size).toBe(5); // no two stages collapse onto one message
	});

	it('returns the RAW KEY for an unknown stage — never an English sentence', () => {
		// The default branch exists so a stage added server-side ships an ugly word rather than a
		// blank card. What it must never do is reach for the backend's `label`/`title` field.
		expect(stageLabel('quarantine')).toBe('quarantine');
		expect(stageLabel('')).toBe('');
	});
});
