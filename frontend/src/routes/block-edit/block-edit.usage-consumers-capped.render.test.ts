// @vitest-environment jsdom
//
// src/routes/block-edit/block-edit.usage-consumers-capped.render.test.ts — "Waar het wordt gebruikt"
// must not read as a complete inventory when it is a top-six.
//
// ⛔ THE DEFECT. `backend/src/routes/blocks.ts`'s top-consumers query ends
// `ORDER BY r.runs DESC, f.id LIMIT 6`, and the response carried no total and the panel carried no
// wording. So the Usage-stats tab showed six flows under a heading that says where the block is
// used, whether it had six consumers or sixty — and the reader this list exists for is a maintainer
// deciding whether a change is safe. A silently-truncated blast radius is the one number on that
// tab that must not be optimistic.
//
// ⛔ THE CONDITION IS `consumersTotal > consumers.length`, NOT `consumers.length === 6`, and the
// second case below is what pins that. `consumersTotal` is OPTIONAL: a backend one deploy behind
// sends the rows and no total. Deriving the cap from the row count would announce a truncation on a
// block that has exactly six consumers and is not truncated at all — inventing a false fact in the
// name of removing one.
//
// ⚠️ THE COPY IS `datasets_picker_capped`'s SHAPE, VERBATIM (BlockSimulate.svelte:225-233): a muted
// `role="status"` line — nothing failed, the list is merely incomplete — with both figures through
// `num(…, locale.current)`, which `icu-number-params.sites.test.ts` requires and which stops a bare
// `1207` sitting beside a grouped `1.207` on one screen.
//
// Harness copied from `block-edit.capability-toggles.render.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDetail, BlockVersion, BlockConsumer } from '$lib/types/blocks';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

vi.mock('@xyflow/svelte', () => ({
	Handle: () => ({}),
	Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
}));

vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/block-edit?slug=row-counter'), params: {} }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { getBlock, lint, saveVersion } = vi.hoisted(() => ({
	getBlock: vi.fn(),
	lint: vi.fn(),
	saveVersion: vi.fn()
}));
vi.mock('$lib/api/blocks', () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error',
			public details?: Record<string, unknown>,
			public findings?: unknown
		) {
			super(message);
		}
	},
	blocksApi: {
		get: getBlock,
		lint,
		saveVersion,
		publish: vi.fn(),
		createVersion: vi.fn(),
		create: vi.fn(),
		remove: vi.fn()
	}
}));
vi.mock('$lib/api/templates', () => ({ templatesApi: { create: vi.fn(), list: vi.fn() } }));
vi.mock('$lib/api/ontology', () => ({
	ApiError: class ApiError extends Error {},
	ontologyApi: {
		matrix: vi.fn().mockResolvedValue({ industries: [], departments: [], cells: [] }),
		get: vi.fn()
	}
}));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { isDeveloper: true, isSuperAdmin: false, isTenantAdmin: false, user: { roles: ['developer'] } }
}));

import Page from './+page.svelte';

const SLUG = 'row-counter';
/** The backend's `LIMIT 6`. The list never renders more than this many rows. */
const CAP = 6;

function version(): BlockVersion {
	return {
		id: 'v1',
		block_id: 'b1',
		version: '1',
		status: 'stable',
		language: 'typescript',
		docs_md: '# Row counter',
		source_ts: 'export default { async run() { return {}; } };',
		descriptor: { inputs: {}, outputs: {}, capabilities: {} },
		examples: [],
		changelog: '',
		tests_passing: true,
		usage_count: 12,
		published_by: null,
		published_at: '2026-08-01T00:00:00.000Z',
		created_at: '2026-08-01T00:00:00.000Z',
		author: null
	} as BlockVersion;
}

function consumers(n: number): BlockConsumer[] {
	return Array.from({ length: n }, (_, i) => ({
		flowId: `f${i}`,
		flowName: `Flow ${i}`,
		solutionId: null,
		solutionTitle: null,
		runs: n - i
	}));
}

function detail(over: Partial<BlockDetail> = {}): BlockDetail {
	const v = version();
	return {
		id: 'b1',
		slug: SLUG,
		name: 'Row counter',
		description: 'Counts the rows of a workspace dataset.',
		category: 'data',
		current_version_id: v.id,
		maintainer_id: null,
		owner: 'tenant',
		region: null,
		cost_class: null,
		license: null,
		archived: false,
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		maintainer: null,
		versions: [v],
		usageCount: 12,
		usageTrend: [],
		consumers: consumers(CAP),
		consumersTotal: 8,
		...over
	} as BlockDetail;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

function clickByText(text: string): void {
	const btn = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
	expect(btn, `no button labelled "${text}" is on screen`).toBeTruthy();
	btn!.click();
	flushSync();
}

async function openUsageTab(d: BlockDetail) {
	getBlock.mockResolvedValue(d);
	lint.mockResolvedValue({ ok: true, findings: [] });
	saveVersion.mockImplementation(async () => version());
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	// ⛔ THE POSITIVE MARKER. /block-edit mounts a dozen components; one that throws and every
	// "the notice is absent" assertion below passes against an empty DOM.
	expect(
		target.querySelector('header.edit-head'),
		'the editor never rendered, so this file tests nothing'
	).not.toBeNull();
	clickByText('blockedit_tab_usage');
	await settle();
	expect(target.querySelector('.consumers'), 'the Usage stats tab did not open').not.toBeNull();
}

const notice = () => target.querySelector('[data-testid="consumers-capped"]');
const rows = () => target.querySelectorAll('.consumers-list li');

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	flushSync();
	getBlock.mockReset();
	lint.mockReset();
	saveVersion.mockReset();
});

describe('the Usage-stats consumer list admits to its ceiling', () => {
	it('⛔ THE DEFECT: six of eight consumers are shown as if they were all of them', async () => {
		await openUsageTab(detail({ consumers: consumers(CAP), consumersTotal: 8 }));
		// The list itself is unchanged — six rows is still what the panel renders.
		expect(rows(), 'the fixture never reached the capped state').toHaveLength(CAP);

		const el = notice();
		expect(
			el,
			'a truncated blast radius is presented as a complete inventory to the maintainer deciding ' +
				'whether a change is safe'
		).not.toBeNull();
		// `role="status"`, not `alert`: nothing failed, the list is merely incomplete.
		expect(el!.getAttribute('role')).toBe('status');
		// Both figures, both interpolated, and in the right slots — a notice reading "6 of 6" is the
		// same lie with extra words.
		expect(el!.textContent).toContain('blockedit_usage_consumers_capped:6,8');
	});

	it('⛔ a block with exactly SIX consumers and six in total says NOTHING', async () => {
		// THE OVER-CORRECTION GUARD, and the reason the condition is not `consumers.length === 6`.
		// This block is NOT truncated; a notice here invents a truncation to remove one.
		await openUsageTab(detail({ consumers: consumers(CAP), consumersTotal: CAP }));
		expect(rows()).toHaveLength(CAP);
		expect(notice(), 'a full-but-not-capped list claimed it was truncated').toBeNull();
	});

	it('a block with three consumers says nothing', async () => {
		await openUsageTab(detail({ consumers: consumers(3), consumersTotal: 3 }));
		expect(rows()).toHaveLength(3);
		expect(notice()).toBeNull();
	});

	it('a backend one deploy behind — no `consumersTotal` at all — says nothing', async () => {
		// ⚠️ The field is additive and optional. Absent must read as "no cap to disclose", never as
		// zero and never as a reason to guess from the row count.
		await openUsageTab(detail({ consumers: consumers(CAP), consumersTotal: undefined }));
		expect(rows()).toHaveLength(CAP);
		expect(notice(), 'an absent total was treated as a cap').toBeNull();
	});

	it('a block nothing has run renders its empty state, not a cap notice', async () => {
		await openUsageTab(detail({ consumers: [], consumersTotal: 0 }));
		expect(rows()).toHaveLength(0);
		expect(
			target.querySelector('.consumers')!.textContent,
			'the empty state was lost'
		).toContain('blockedit_usage_consumers_empty');
		expect(notice()).toBeNull();
	});
});
