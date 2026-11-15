// @vitest-environment jsdom
//
// src/routes/datasets/datasets-page.pii-toggle-readonly.render.test.ts — the schema drawer's PII
// toggle looked live to a reader who cannot manage the dataset.
//
// ⛔ WHAT THIS IS, STATED HONESTLY: an AFFORDANCE defect, NOT an authorization hole. The handler is
// already guarded (`onchange={(v) => canManage && togglePii(i, v)}`) and `Toggle.svelte` is fully
// controlled — it renders `checked` and emits, it never holds state of its own — so a press by a
// member writes nothing and the switch does not even move. Nothing leaks and nothing is written.
// What is wrong is that the control ADVERTISES an action it will not perform: it renders at full
// opacity with a pointer cursor, one line below a `<select>` in the same row that already passes
// `disabled={!canManage}` and greys itself out. Two controls, one row, one permission, two answers.
//
// ⛔ SO THE ASSERTIONS ARE PAIRED WITH THE NEIGHBOUR, not written against the toggle alone. Each
// read-only case asserts the select AND the toggle, because "matches its neighbour" is the actual
// requirement — a toggle disabled by some unrelated condition would satisfy a lone `disabled ===
// true` and mean nothing.
//
// ⛔ AND THE NON-WRITE IS ASSERTED TOO, so this file also pins the guard the reviewer established:
// a click on the read-only toggle leaves `aria-pressed` where it was and arms no Save.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { DatasetDetail, DatasetList, DatasetRow } from '$lib/types/datasets';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';

// Real `en` catalog, each key resolving to its own name. The assertions are about WHICH key each
// control reaches, never the wording.
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

const { listDatasets, getDataset, listMappings, updateColumns, matrixFn, ontologyGet } = vi.hoisted(
	() => ({
		listDatasets: vi.fn(),
		getDataset: vi.fn(),
		listMappings: vi.fn(),
		updateColumns: vi.fn(),
		matrixFn: vi.fn(),
		ontologyGet: vi.fn()
	})
);
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record than
// the one the page imports and silently does nothing.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: {
		list: listDatasets,
		get: getDataset,
		uploadFile: vi.fn(),
		paste: vi.fn(),
		remove: vi.fn(),
		update: updateColumns,
		updateColumns,
		listMappings,
		saveMapping: vi.fn(),
		deleteMapping: vi.fn(),
		suggestMappings: vi.fn()
	},
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			message: string
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/ontology', () => ({
	ontologyApi: { matrix: matrixFn, get: ontologyGet, compiled: vi.fn() },
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

const DATASET: DatasetRow = {
	id: 'd1',
	slug: 'claims-2026',
	name: 'Dataset claims-2026',
	sourceType: 'csv',
	columns: [
		{ name: 'claim_id', type: 'string', pii: false },
		{ name: 'holder_email', type: 'string', pii: true }
	],
	rowCount: 12,
	sizeBytes: 2048,
	status: 'ready',
	sandboxId: null,
	createdAt: '2026-06-01T09:00:00.000Z',
	updatedAt: '2026-06-01T09:00:00.000Z'
} as DatasetRow;

const listResponse = (canManage: boolean): DatasetList => ({
	items: [DATASET],
	total: 1,
	page: 1,
	pageSize: 20,
	canManage
});

const detail = (r: DatasetRow): DatasetDetail => ({ ...r, rows: [], offset: 0, limit: 50 });

const matrix: MatrixData = {
	industries: ['insurance'],
	departments: ['Claims'],
	cells: []
} as MatrixData;
const compiled: CompiledOntology = {
	industry: 'insurance',
	department: 'Claims',
	entities: [],
	relations: [],
	hidden: []
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	listDatasets.mockReset();
	getDataset.mockReset();
	listMappings.mockReset();
	updateColumns.mockReset();
	matrixFn.mockReset();
	ontologyGet.mockReset();
	listMappings.mockResolvedValue({ mappings: [] });
	matrixFn.mockResolvedValue(matrix);
	ontologyGet.mockResolvedValue(compiled);
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Mount the roster and open the schema drawer on the one dataset. */
async function openDrawer(canManage: boolean, extra: Partial<DatasetDetail> = {}): Promise<void> {
	listDatasets.mockResolvedValue(listResponse(canManage));
	getDataset.mockResolvedValue({ ...detail(DATASET), ...extra });
	app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
	for (let i = 0; i < 20 && host.textContent?.includes('datasets_loading') !== false; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	expect(
		host.textContent,
		'the page never left its loading state — nothing below would be a proof'
	).not.toContain('datasets_loading');

	const btn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'datasets_preview'
	);
	expect(btn, 'the Preview button is not on screen, so this case tests nothing').toBeDefined();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the handler and every assertion below passes for free.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	for (let i = 0; i < 20 && !host.querySelector('.schema-row'); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	await tick();
	expect(host.querySelectorAll('.schema-row').length, 'the drawer never opened').toBe(
		DATASET.columns.length
	);
}

const typeSelects = () =>
	[...host.querySelectorAll<HTMLSelectElement>('.schema-row select')].map((s) => s.disabled);
const piiToggles = () =>
	[...host.querySelectorAll<HTMLButtonElement>('.schema-row .pii-cell button.toggle')].map(
		(b) => b.disabled
	);

describe('the schema drawer PII toggle under a reader who cannot manage', () => {
	it('THE DEFECT: the toggle offers itself while the select beside it is already greyed out', async () => {
		await openDrawer(false);
		// The neighbour, one line above it in the same row — the control that got this right.
		expect(typeSelects(), 'the column-type selects are not read-only, so the pair proves nothing')
			.toEqual([true, true]);
		expect(
			piiToggles(),
			'the PII toggle still advertises an action it will refuse to perform'
		).toEqual([true, true]);
	});

	it('and pressing it changes nothing — no flip, no dirty state, no write', async () => {
		// The reviewer's finding, pinned: the handler is guarded and Toggle is fully controlled, so
		// this was never an authorization hole. Keeping the assertion here is what stops a later
		// "simplification" of `canManage && togglePii(...)` from turning the affordance bug into one.
		await openDrawer(false);
		const toggles = [...host.querySelectorAll<HTMLButtonElement>('.schema-row .pii-cell button.toggle')];
		const before = toggles.map((t) => t.getAttribute('aria-pressed'));
		expect(before, 'the toggles are not reflecting the column pii flags').toEqual(['false', 'true']);

		for (const t of toggles) t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await tick();
		flushSync();

		expect(toggles.map((t) => t.getAttribute('aria-pressed'))).toEqual(before);
		expect(updateColumns).not.toHaveBeenCalled();
		// The Save button lives behind `{#if canManage}` — there is no way to commit at all.
		expect(host.textContent).not.toContain('datasets_save');
	});

	it('round 2: a member sees no slug and no mapping section; a manager sees both', async () => {
		// `.ds-slug`, not the page text: the fixture's NAME contains the slug.
		const slugLines = () => [...host.querySelectorAll('.ds-slug')].map((e) => e.textContent ?? '');
		await openDrawer(false);
		expect(slugLines().length, 'the drawer head did not render, so this proves nothing').toBeGreaterThan(0);
		expect(slugLines().some((t) => t.includes('claims-2026')), 'a member is shown the slug').toBe(false);
		expect(host.textContent).not.toContain('datasets_mapping_title');
		unmount(app!);
		app = undefined;
		host.textContent = '';
		await openDrawer(true);
		expect(slugLines().filter((t) => t.includes('claims-2026')).length, 'the manager lost the slug').toBe(2);
		expect(host.textContent).toContain('datasets_mapping_title');
	});

	it('A MANAGER STILL GETS BOTH CONTROLS — the over-correction guard', async () => {
		// ⛔ `disabled={true}` satisfies both cases above forever; this is the half that reds on it.
		await openDrawer(true);
		expect(typeSelects()).toEqual([false, false]);
		expect(piiToggles()).toEqual([false, false]);

		const toggle = host.querySelector<HTMLButtonElement>('.schema-row .pii-cell button.toggle')!;
		toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await tick();
		flushSync();
		// It flips, and the Save that commits it is now on screen — the control is genuinely live.
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		expect(host.textContent).toContain('datasets_save');
	});
});

// "Suggested: not personal" (backend datasets/column-suggestions.ts) is a HINT for data managers; a
// column only becomes real for members once marked `nonPersonal` through the existing column PATCH.
describe('not-personal suggestions in the schema editor', () => {
	const labelled = () =>
		[...host.querySelectorAll('.schema-row')].map(
			(r) => r.querySelector('[data-testid="suggested-not-personal"]')?.textContent ?? null
		);
	const markButton = () => host.querySelector<HTMLButtonElement>('[data-testid="mark-suggested"]');

	it('a manager sees the label on exactly the suggested columns, and nothing is written yet', async () => {
		await openDrawer(true, { suggestedNonPersonal: ['claim_id'] });
		expect(labelled()).toEqual(['datasets_col_suggested_not_personal', null]);
		expect(markButton()?.textContent?.trim()).toBe('datasets_mark_suggested_not_personal');
		expect(updateColumns).not.toHaveBeenCalled();
	});

	it('one action marks every suggested column not personal through the column PATCH', async () => {
		updateColumns.mockResolvedValue(detail(DATASET));
		await openDrawer(true, { suggestedNonPersonal: ['claim_id'] });
		markButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await tick();
		flushSync();
		expect(updateColumns).toHaveBeenCalledTimes(1);
		const [slug, body] = updateColumns.mock.calls[0]!;
		expect(slug).toBe('claims-2026');
		expect(body.columns).toEqual([
			{ name: 'claim_id', type: 'string', pii: false, nonPersonal: true },
			{ name: 'holder_email', type: 'string', pii: true }
		]);
	});

	it('the per-column switch marks one column; it is disabled while the column is personal data', async () => {
		await openDrawer(true, { suggestedNonPersonal: ['claim_id'] });
		const np = [...host.querySelectorAll<HTMLButtonElement>('.schema-row .np-cell button.toggle')];
		expect(np.map((b) => b.disabled)).toEqual([false, true]);
		np[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await tick();
		flushSync();
		expect(np[0]!.getAttribute('aria-pressed')).toBe('true');
		// Marked ⇒ no longer a pending suggestion.
		expect(labelled()).toEqual([null, null]);
		expect(markButton()).toBeNull();
	});

	it('a member sees no suggestion, no switch and no action; an older backend shows none', async () => {
		await openDrawer(false, { suggestedNonPersonal: ['claim_id'] });
		expect(labelled()).toEqual([null, null]);
		expect(host.querySelectorAll('.np-cell').length).toBe(0);
		expect(markButton()).toBeNull();
		unmount(app!);
		app = undefined;
		host.textContent = '';
		await openDrawer(true);
		expect(labelled()).toEqual([null, null]);
		expect(markButton()).toBeNull();
	});
});
