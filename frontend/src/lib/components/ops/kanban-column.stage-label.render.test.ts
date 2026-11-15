// @vitest-environment jsdom
//
// src/lib/components/ops/kanban-column.stage-label.render.test.ts — the /pipeline board's
// column heads.
//
// ⛔ THE DEFECT. The head rendered `column.title` — a hard-coded English map on the server
// (`routes/pipeline.ts` STAGE_TITLES: "In review", "Staging · canary", "Production") — so a
// Dutch operator's board read in English, including the accessible name of the drop target.
// The enum was on the DTO the whole time; the browser just never used it.
//
// Assertions are on MESSAGE TOKENS, and the fixture's `title` is set to the literal English the
// backend still sends: if the component ever reads it again (directly or via a `?? column.title`
// fallback) those strings appear in the DOM and these tests fail.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { PipelineColumn, Stage } from '$lib/types/pipeline';

vi.mock('$lib/paraglide/messages', () => ({
	ops_kanban_drop_here: () => 'DROP_HERE',
	pipeline_stage_won: () => 'M_WON',
	pipeline_stage_review: () => 'M_REVIEW',
	pipeline_stage_hardening: () => 'M_HARDENING',
	pipeline_stage_staging: () => 'M_STAGING',
	pipeline_stage_production: () => 'M_PRODUCTION'
}));

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

/** `title` carries the backend's ENGLISH on purpose — see the header note. */
function column(stage: Stage, title: string): PipelineColumn {
	return { stage, title, count: 0, items: [] };
}

async function render(col: PipelineColumn) {
	const { default: KanbanColumn } = await import('./KanbanColumn.svelte');
	app = mount(KanbanColumn, {
		target: host,
		props: { column: col, onMove: () => {}, onToggleReview: () => {} }
	});
	flushSync();
	return host;
}

const BACKEND_TITLES: Record<Stage, string> = {
	review: 'In review',
	hardening: 'Hardening',
	staging: 'Staging · canary',
	production: 'Production'
};

describe('the column head names its stage from the enum, not from the backend’s English', () => {
	const expected: Record<Stage, string> = {
		review: 'M_REVIEW',
		hardening: 'M_HARDENING',
		staging: 'M_STAGING',
		production: 'M_PRODUCTION'
	};

	for (const stage of ['review', 'hardening', 'staging', 'production'] as Stage[]) {
		it(`${stage} renders ${expected[stage]} and never "${BACKEND_TITLES[stage]}"`, async () => {
			const el = await render(column(stage, BACKEND_TITLES[stage]));
			expect(el.querySelector('.kan-name')!.textContent).toBe(expected[stage]);
			expect(el.textContent).not.toContain(BACKEND_TITLES[stage]);
		});
	}

	it('the drop target’s ACCESSIBLE NAME is localized too, not just the visible head', async () => {
		// `aria-label` is what a screen-reader user hears when the list receives focus; leaving it
		// on `column.title` would localize the sighted board and nothing else.
		const el = await render(column('staging', BACKEND_TITLES.staging));
		expect(el.querySelector('.kan-col')!.getAttribute('aria-label')).toBe('M_STAGING');
	});

	it('a column with no cards still shows its stage name above the drop hint', async () => {
		const el = await render(column('review', BACKEND_TITLES.review));
		expect(el.textContent).toContain('M_REVIEW');
		expect(el.textContent).toContain('DROP_HERE');
	});
});
