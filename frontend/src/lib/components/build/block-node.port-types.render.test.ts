// @vitest-environment jsdom
//
// src/lib/components/build/block-node.port-types.render.test.ts — a block node on the /build
// canvas, in DUTCH, with one port of every type the descriptor vocabulary has.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. `/build` at locale `nl`, on load: eighteen raw English
// type tokens inside `<span class="ptype">` — `string`, `json`, `num`, `enum` — on the port badges
// of the block nodes, i.e. on the product's PRIMARY authoring surface, beside chrome that is
// otherwise fully Dutch. `BlockNode.svelte` carried its own hardcoded ENGLISH abbreviator
// (`string[]`→"list", `dataset`→"data", `boolean`→"bool", `number`→"num", everything else raw)
// instead of going through the catalog like every other enum this repo renders.
//
// ⚠️ THIS FILE ASSERTS DUTCH WORDS, NOT KEY NAMES — deliberately, and unlike its neighbours.
// `run-console.i18n.render.test.ts` mocks each key to its OWN NAME because its subject is WHICH key
// a branch reaches. Here the reader-visible failure is that the badge said "string", and a
// key-name mock cannot tell "the badge is Dutch" from "the badge is a key that happens to contain
// the word string". So the mock resolves the REAL `messages/nl.json`, and the assertions are the
// words a Dutch employee sees.
//
// ⛔ THE ONE-LINE MUTATION THIS IS BUILT AGAINST is the revert: put `{spec.type}` back in place of
// `{fieldTypeLabel(spec.type)}` at either render site. Both columns are asserted separately,
// because the two sites are two separate lines and a revert of one only would otherwise hide
// behind the other's badges.
//
// ⚠️ `@xyflow/svelte` is stubbed. `Handle` needs the SvelteFlow store context, which a bare `mount`
// has no way to provide, and the handles are dots — they render no text and cannot carry this
// defect. `Position` is a plain enum object, so it is reproduced rather than stubbed away.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockNodeData } from '$lib/stores/builder.svelte';
import type { FieldSpec } from '$lib/types/blocks';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = () => catalog[key];
	}
	return mod;
});

vi.mock('@xyflow/svelte', () => ({
	Handle: () => ({}),
	Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
}));

import BlockNode from './BlockNode.svelte';
import { fieldTypes } from '$lib/stores/field-types.svelte';

/** The whole closed vocabulary — `fieldTypeSchema`, backend/src/blocks/descriptor-schema.ts. */
const FIELD_TYPES = ['string', 'number', 'boolean', 'json', 'string[]', 'enum', 'dataset'] as const;

/** What a Dutch reader must see, per type. The values live in `messages/nl.json`. */
const DUTCH: Record<string, string> = {
	string: 'Tekst',
	number: 'Getal',
	boolean: 'Ja/nee',
	json: 'JSON',
	'string[]': 'Lijst',
	enum: 'Keuze',
	dataset: 'Data'
};

/** Every English token the badge used to be able to print — the abbreviations AND the raw enum. */
const ENGLISH = ['string', 'number', 'boolean', 'string[]', 'enum', 'dataset', 'num', 'bool', 'list'];

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	// Type chips are a developer's opt-in (stores/field-types.svelte); this file is about the chips.
	fieldTypes.allowed = true;
	fieldTypes.preference = true;
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

function ports(types: readonly string[]): Record<string, FieldSpec> {
	return Object.fromEntries(types.map((t, i) => [`p${i}`, { type: t } as FieldSpec]));
}

/** Mounts a node with `types` on BOTH columns and returns the two columns' badge texts. */
function render(types: readonly string[]): { inputs: string[]; outputs: string[] } {
	const data: BlockNodeData = {
		blockId: 'b1',
		blockVersionId: 'v1',
		slug: 'triage-claims',
		label: 'Triage claims',
		category: 'data',
		descriptor: { inputs: ports(types), outputs: ports(types), capabilities: {} },
		config: {}
	};
	app = mount(BlockNode, { target: host, props: { data, selected: false } as never });
	flushSync();
	const badges = (sel: string) =>
		[...host.querySelectorAll(`${sel} .ptype`)].map((n) => n.textContent ?? '');
	return { inputs: badges('.col.in'), outputs: badges('.col.out') };
}

describe('the /build port badges are words, not the descriptor enum', () => {
	it('⛔ every type renders its Dutch word on the INPUT column', () => {
		const { inputs } = render(FIELD_TYPES);
		// ⛔ NON-VACUITY FIRST: seven ports in, seven badges out. A selector that matched nothing
		// would satisfy every `not.toContain` below for free.
		expect(inputs, 'the input column rendered no type badges').toHaveLength(7);
		expect(inputs).toEqual(FIELD_TYPES.map((t) => DUTCH[t]));
	});

	it('⛔ every type renders its Dutch word on the OUTPUT column', () => {
		// The second render site. `{spec.type}` restored HERE and nowhere else is invisible to the
		// test above, so it gets its own assertion rather than a shared `.ptype` sweep.
		const { outputs } = render(FIELD_TYPES);
		expect(outputs, 'the output column rendered no type badges').toHaveLength(7);
		expect(outputs).toEqual(FIELD_TYPES.map((t) => DUTCH[t]));
	});

	it('leaves no English token anywhere on the badges', () => {
		const { inputs, outputs } = render(FIELD_TYPES);
		const all = [...inputs, ...outputs];
		expect(all).toHaveLength(14);
		// A positive marker before the absences, so "no English" cannot mean "nothing rendered".
		expect(all).toContain('Tekst');
		expect(all.filter((t) => ENGLISH.includes(t))).toEqual([]);
	});

	it('the seven words are seven DIFFERENT words', () => {
		// A labeller wired to one key for every arm — or a catalog where two arms were pasted with
		// the same value — reads as "every port is a Tekst" and would pass a per-type `toContain`.
		const { inputs } = render(FIELD_TYPES);
		expect(new Set(inputs).size).toBe(7);
	});

	it('⛔ AN UNKNOWN TYPE DEGRADES TO ITSELF — never to a blank chip', () => {
		// A type added server-side and deployed one roll ahead of the browser. `{''}` inside
		// `.ptype` is a tinted rectangle with nothing in it: a port that appears to have no type.
		const { inputs } = render(['geojson']);
		expect(inputs).toEqual(['geojson']);
		expect(inputs[0]).not.toBe('');
	});

	it('the port shows a human label; the wire key stays on `data-port`', () => {
		// `p0` is a wire key the flow's edges are keyed on, so it is never changed — only how it is
		// SHOWN (`portLabel`). The key stays reachable for tests and tooling.
		render(['string']);
		const names = [...host.querySelectorAll('.col.in .pname')] as HTMLElement[];
		expect(names.map((n) => n.textContent)).toEqual(['P0']);
		expect(names.map((n) => n.dataset.port)).toEqual(['p0']);
	});
});

describe('a reader who has not switched type chips on', () => {
	it('⛔ sees no type chips, and the ports read as words', () => {
		fieldTypes.preference = false;
		const data: BlockNodeData = {
			blockId: 'b1',
			blockVersionId: 'v1',
			slug: 'read-claim-form',
			label: 'Read claim form',
			category: 'data',
			descriptor: {
				inputs: { force_ocr: { type: 'boolean' } as FieldSpec },
				outputs: { ocr_used: { type: 'boolean' } as FieldSpec },
				capabilities: {}
			},
			config: {}
		};
		app = mount(BlockNode, { target: host, props: { data, selected: false } as never });
		flushSync();
		expect(host.querySelectorAll('.pname'), 'no port rows rendered').toHaveLength(2);
		expect(host.querySelectorAll('.ptype')).toHaveLength(0);
		expect([...host.querySelectorAll('.pname')].map((n) => n.textContent)).toEqual(['Force OCR', 'OCR used']);
		expect(host.textContent).not.toContain('Ja/nee');
	});

	it('⛔ a saved preference does not show chips to a role that may not switch them', () => {
		fieldTypes.allowed = false;
		fieldTypes.preference = true;
		render(['string']);
		expect(host.querySelectorAll('.ptype')).toHaveLength(0);
	});
});
