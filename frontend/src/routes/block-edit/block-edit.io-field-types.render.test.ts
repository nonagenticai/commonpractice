// @vitest-environment jsdom
//
// src/routes/block-edit/block-edit.io-field-types.render.test.ts — the I/O editor's type dropdown
// must name a field type the way the rest of the product names it.
//
// ⛔ THE DEFECT, AND IT IS A CONTRADICTION VISIBLE WITHOUT LEAVING THE SCREEN. The "Permissions &
// data" pane's per-field type `<select>` was
//
//     {#each FIELD_TYPES as ft (ft)}<option value={ft}>{ft}</option>{/each}
//
// i.e. the raw `FieldType` enum — `string[]`, `json`, `boolean` — while the SAME seven values are
// rendered through `fieldTypeLabel()` on /build's port badges (BlockNode.svelte), in /build's
// inspector (NodeConfigPanel.svelte), and on this very page's Simulate and Testing panes
// (BlockSimulate.svelte:239, BlockTesting.svelte:457). So an author declared a port "string[]" in
// one tab and read "Lijst" for it in the next, and the /build canvas showed a third pane's word for
// the thing they had just typed. One block, two vocabularies, one click apart.
//
// ⛔ THE VALUE IS NOT THE LABEL, AND THIS FILE ASSERTS BOTH HALVES SEPARATELY. `value={ft}` is the
// wire key: `bind:value={row.type}` writes it into the descriptor that `fieldTypeSchema`
// (backend/src/blocks/descriptor-schema.ts) validates and that every consumer switches on. A "fix"
// that localized the value would send "Lijst" where the schema demands "string[]" and break saving
// for every non-English author — a far worse defect than the one being fixed, and one that the
// label assertions alone cannot see. Hence `it('the option VALUES stay canonical …')`.
//
// ⚠️ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED — `overwriteGetLocale` is the same lever
// `$lib/stores/locale.svelte.ts` pulls in the running app, so the compiled paraglide functions
// resolve `nl` exactly as a browser does. Same seam, and the same reason, as
// `block-edit.cost-class.render.test.ts` beside this file.
//
// ⛔ THE ONE-LINE MUTATION THIS IS BUILT AGAINST is the revert to `{ft}`: the label assertions then
// read the enum and fail, while the value assertions keep passing — which is exactly the asymmetry
// that makes them worth writing down.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDetail, BlockVersion } from '$lib/types/blocks';

vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/block-edit?slug=claims-triage'), params: {} }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { getBlock } = vi.hoisted(() => ({ getBlock: vi.fn() }));
vi.mock('$lib/api/blocks', () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error',
			public findings?: unknown
		) {
			super(message);
		}
	},
	blocksApi: {
		get: getBlock,
		saveVersion: vi.fn(),
		publish: vi.fn(),
		lint: vi.fn(),
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
	auth: { isDeveloper: true, isSuperAdmin: true, isTenantAdmin: true }
}));

import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import { fieldTypeLabel } from '$lib/i18n/field-type-label';
import Page from './+page.svelte';

/** The closed vocabulary the `<select>` offers — `FIELD_TYPES` in +page.svelte. */
const FIELD_TYPES = ['string', 'number', 'boolean', 'json', 'string[]', 'enum', 'dataset'] as const;

function version(): BlockVersion {
	return {
		id: 'v1',
		block_id: 'b1',
		version: '3',
		status: 'draft',
		language: 'typescript',
		docs_md: '# Claims triage',
		source_ts: 'export default function () {}',
		// One input of every type, so the editor renders a row (and therefore a `<select>`) at all.
		descriptor: {
			inputs: Object.fromEntries(FIELD_TYPES.map((t, i) => [`p${i}`, { type: t }])),
			outputs: {},
			capabilities: { network: false }
		},
		examples: [],
		changelog: '',
		tests_passing: true,
		usage_count: 0,
		published_by: null,
		published_at: null,
		created_at: '2026-08-01T00:00:00.000Z',
		author: null
	};
}

function detail(): BlockDetail {
	return {
		id: 'b1',
		slug: 'claims-triage',
		name: 'Claims triage',
		description: 'Triage a claim',
		category: 'logic',
		current_version_id: null,
		maintainer_id: null,
		owner: 'tenant',
		region: 'eu-west-1',
		cost_class: 'low',
		license: 'MIT',
		archived: false,
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		maintainer: null,
		versions: [version()]
	} as BlockDetail;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount /block-edit and open the "Permissions & data" pane, where the I/O editor lives. */
async function openIoEditor(): Promise<HTMLSelectElement> {
	getBlock.mockResolvedValue(detail());
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	// Found by its LABEL rather than by index, so a tab inserted before it does not silently move
	// this onto another pane.
	const tab = [...target.querySelectorAll('button.tab')].find(
		(b) => b.textContent === m.blockedit_tab_permissions()
	);
	expect(tab, 'no "Permissions & data" tab on the page').toBeDefined();
	(tab as HTMLButtonElement).click();
	await settle();
	const sel = target.querySelector('.io-row select') as HTMLSelectElement | null;
	expect(sel, 'the I/O editor rendered no type dropdown').not.toBeNull();
	return sel!;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	overwriteGetLocale(() => 'nl');
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	overwriteGetLocale(() => 'en');
	getBlock.mockReset();
});

describe('the /block-edit I/O editor names a field type the way the canvas does', () => {
	it('the fixture really is Dutch, and really differs from the enum', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. Every assertion below is "the option text is the
		// Dutch word". If `overwriteGetLocale` stopped working, `fieldTypeLabel` would answer the
		// English catalog — whose `fieldtype_json` is "JSON", byte-identical to the enum — and a
		// test written only as `not.toContain('json')` would pass while proving the opposite.
		overwriteGetLocale(() => 'nl');
		const nl = FIELD_TYPES.map((t) => fieldTypeLabel(t));
		expect(nl).toEqual(['Tekst', 'Getal', 'Ja/nee', 'JSON', 'Lijst', 'Keuze', 'Data']);
		// All seven differ from their raw enum as CHARACTERS…
		expect(FIELD_TYPES.filter((t) => fieldTypeLabel(t) !== t)).toHaveLength(7);
		// …but only six differ as WORDS: `json`→"JSON" is the same token re-cased, so it is the one
		// value this whole file cannot distinguish from a revert. That is why the sweep below names
		// `string[]`/`boolean`/`dataset` rather than asserting one blanket "no enum anywhere".
		expect(FIELD_TYPES.filter((t) => fieldTypeLabel(t).toLowerCase() !== t)).toHaveLength(6);
		expect(fieldTypeLabel('json').toLowerCase()).toBe('json');
	});

	it('⛔ every option reads its Dutch word, not the raw FieldType enum', async () => {
		const sel = await openIoEditor();
		const labels = [...sel.options].map((o) => o.textContent);
		// The positive anchor first: seven types in, seven options out. A selector that matched an
		// empty `<select>` would satisfy every absence assertion below for free.
		expect(labels).toHaveLength(FIELD_TYPES.length);
		expect(labels).toEqual(FIELD_TYPES.map((t) => fieldTypeLabel(t)));
	});

	it('⛔ the two ugliest tokens are gone from the dropdown', async () => {
		// `string[]` and `boolean` are the ones a tester actually reports. Scoped to the `<select>`:
		// the page holds a code editor whose source legitimately contains both words, so a
		// document-wide grep would be a coin toss rather than a guard.
		const sel = await openIoEditor();
		const text = [...sel.options].map((o) => o.textContent ?? '');
		expect(text, 'the Dutch words never rendered').toContain('Lijst');
		expect(text).not.toContain('string[]');
		expect(text).not.toContain('boolean');
		expect(text).not.toContain('dataset');
	});

	it('⛔ the option VALUES stay canonical — the label moved, the wire key did not', async () => {
		// The half a naive "localize the dropdown" patch breaks. `bind:value={row.type}` writes
		// this straight into the descriptor `fieldTypeSchema` validates; a localized value would
		// make every save from a Dutch session fail validation.
		const sel = await openIoEditor();
		expect([...sel.options].map((o) => o.value)).toEqual([...FIELD_TYPES]);
	});

	it('the seven labels are seven DIFFERENT labels', async () => {
		// A mis-wire to one key for every arm reads as "every type is Tekst" and would pass a
		// per-type `toContain`.
		const sel = await openIoEditor();
		expect(new Set([...sel.options].map((o) => o.textContent)).size).toBe(FIELD_TYPES.length);
	});

	it('the editor agrees with the canvas, value for value', async () => {
		// The actual ask: ONE vocabulary. This compares the dropdown against the same helper
		// BlockNode/NodeConfigPanel render, so the two screens cannot drift without reddening here.
		const sel = await openIoEditor();
		for (const o of [...sel.options]) {
			expect(o.textContent).toBe(fieldTypeLabel(o.value));
		}
	});
});
