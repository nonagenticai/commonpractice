// @vitest-environment jsdom
//
// src/lib/components/dataset-preview.duplicate-columns.render.test.ts — ONE BAD DATASET MUST NEVER
// BLANK A SCREEN.
//
// ⛔ THE DEFECT. `DatasetPreviewTable` keyed both of its `{#each}` blocks on the column NAME:
//
//     {#each columns as c (c.name)}
//
// A dataset whose ingest accepted a repeated header therefore made Svelte throw `each_key_duplicate`
// (svelte/internal/client/dom/blocks/each.js). That error is NOT dev-only, and there is no
// `<svelte:boundary>` anywhere in `frontend/src` — so it propagated out of the component and took
// the whole mounted tree down to an empty shell. This is the SHARED preview component: /datasets,
// /submit, /challenges/[id], the builder node-config panel and the builder "Challenge data" panel
// all mount it, so one keyed expression was five screens. Same mechanism that blanked /governance
// (PR #233) and that /it-dash's alert list documents at +page.svelte:178.
//
// The backend half of this fix stops NEW datasets from carrying a repeated name. Datasets ALREADY
// stored with a repeated name are NOT repaired (the repair migration was withdrawn - see below), so
// this component must stay renderable on them, which is exactly what these cases pin.
// repairs the ones already stored — but neither reaches a dataset served by an OLD pod mid-rolling-
// deploy, and neither is a reason for a render to be one malformed value away from a white page.
//
// ⚠️ NON-VACUITY. A component that throws renders NOTHING, and `querySelectorAll` over an empty DOM
// returns `[]` — which passes any "the bad thing is absent" assertion. Every case here therefore
// asserts POSITIVE structure first (the exact header names, the exact cell text), so "it rendered
// correctly" cannot be confused with "it rendered nothing".
//
// ⚠️ THE TWO FIXES ARE NOT REDUNDANT, MEASURED SEPARATELY. Reverting ONLY the `{#each}` keys to
// `(c.name)` and leaving the `<svelte:boundary>` in place gives: fallback shown, sibling markup
// intact, and `table.sample` GONE — the page survives but the reader loses the preview outright,
// and the two cases below go red with `expected [] to deeply equal [...]`. So the index key is what
// keeps the DATA on screen; the boundary is what keeps the PAGE. Neither substitutes for the other,
// which is why both are here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DatasetColumn } from '$lib/types/datasets';
import DatasetPreviewTable from './DatasetPreviewTable.svelte';

// Real `en` catalog, each key resolving to its own NAME — so an assertion names WHICH message
// reached the DOM rather than matching prose that a later copy edit would silently invalidate.
// Same mock as `submit-page.failure-honesty.render.test.ts`.
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

function render(columns: DatasetColumn[], rows: Record<string, unknown>[]) {
	app = mount(DatasetPreviewTable, { target: host, props: { columns, rows } });
	flushSync();
}
const headers = () => [...host.querySelectorAll('.col-name')].map((n) => n.textContent);
const bodyCells = () => [...host.querySelectorAll('tbody td')].map((n) => n.textContent);

describe('the dataset preview survives a duplicate column name', () => {
	it('⛔ THE DEFECT: two columns named “Amount” render instead of blanking the screen', () => {
		// Exactly the shape the un-fixed xlsx ingest persisted: three columns, a repeated name.
		const columns: DatasetColumn[] = [
			{ name: 'id', type: 'number' },
			{ name: 'Amount', type: 'number' },
			{ name: 'Amount', type: 'number' }
		];
		render(columns, [{ id: 1, Amount: 999 }]);

		// ⛔ THE POSITIVE ANCHOR. Pre-fix this array was `[]` — the component threw during mount and
		// the host held nothing at all. Asserting the three header names pins that the table is
		// really there, which is the claim; a `not.toBe('')` on the host would not.
		expect(headers()).toEqual(['id', 'Amount', 'Amount']);
		expect(host.querySelectorAll('thead th')).toHaveLength(3);
		expect(bodyCells()).toEqual(['1', '999', '999']);
	});

	it('a THREE-way repeat renders three columns, not one', () => {
		render(
			[
				{ name: 'n', type: 'number' },
				{ name: 'n', type: 'number' },
				{ name: 'n', type: 'number' }
			],
			[{ n: 7 }]
		);
		expect(headers()).toEqual(['n', 'n', 'n']);
		expect(bodyCells()).toEqual(['7', '7', '7']);
	});

	it('the ordinary case is untouched — the index key changed nothing a reader can see', () => {
		render(
			[
				{ name: 'claim_id', type: 'string' },
				{ name: 'amount', type: 'number' }
			],
			[
				{ claim_id: 'CLM-1', amount: 250 },
				{ claim_id: 'CLM-2', amount: 980 }
			]
		);
		expect(headers()).toEqual(['claim_id', 'amount']);
		expect(bodyCells()).toEqual(['CLM-1', '250', 'CLM-2', '980']);
	});

	it('a DIFFERENT column at the same index shows the new column, not a stale cell', () => {
		// ⚠️ THE COST OF AN INDEX KEY, STATED AND MEASURED. Keying by index lets Svelte reuse the DOM
		// node at a position when the value there changes, so the hazard the change introduces is a
		// STALE CELL, not a crash. Two mounts with different columns at index 1 pin that the header
		// and the body both follow the data. (Two mounts rather than a mutated `$state` array: runes
		// only compile in `.svelte.ts` modules, and this behaviour does not need reactivity to hold.)
		render(
			[
				{ name: 'a', type: 'number' },
				{ name: 'b', type: 'number' }
			],
			[{ a: 1, b: 2, c: 3 }]
		);
		expect(headers()).toEqual(['a', 'b']);
		expect(bodyCells()).toEqual(['1', '2']);

		unmount(app!);
		app = undefined;
		render(
			[
				{ name: 'a', type: 'number' },
				{ name: 'c', type: 'number' }
			],
			[{ a: 1, b: 2, c: 3 }]
		);
		expect(headers()).toEqual(['a', 'c']);
		expect(bodyCells()).toEqual(['1', '3']);
	});
});

describe('the render boundary degrades to a message instead of a white page', () => {
	it('⛔ a cell value that cannot be stringified loses the TABLE, not the SCREEN', () => {
		// `cell()` calls `JSON.stringify` on any object value. A cycle makes it throw — an ordinary
		// hazard for a `json`-typed column fetched from a live connector, and precisely the "one bad
		// row of data" case. Pre-boundary this took down whatever mounted the preview.
		const cyclic: Record<string, unknown> = { name: 'loop' };
		cyclic.self = cyclic;

		// A sibling that must survive the neighbour's failure — this is what "the screen" means here.
		const sibling = document.createElement('p');
		sibling.textContent = 'the rest of the page';
		host.appendChild(sibling);

		render([{ name: 'payload', type: 'json' }], [{ payload: cyclic }]);

		// The boundary caught it: the fallback is on screen…
		expect(host.querySelector('.sample-error')).not.toBeNull();
		expect(host.querySelector('.sample-error')!.textContent).toContain(
			'dataset_preview_render_failed'
		);
		// …the broken table is gone rather than half-drawn…
		expect(host.querySelector('table.sample')).toBeNull();
		// …and the rest of the page is still standing, which is the entire point of the boundary.
		expect(host.textContent).toContain('the rest of the page');
	});

	it('the boundary is INERT on a healthy preview — it must not swallow a working table', () => {
		render([{ name: 'a', type: 'number' }], [{ a: 1 }]);
		expect(host.querySelector('.sample-error')).toBeNull();
		expect(headers()).toEqual(['a']);
	});
});
