// @vitest-environment jsdom
//
// src/lib/components/build/node-config.required-flag.i18n.render.test.ts — the /build inspector's
// port badge must be ONE language, not one and a half.
//
// ⛔ THE DEFECT, AND IT IS HALF A FIX RATHER THAN A MISSED ONE. `NodeConfigPanel.svelte:258` read
//
//     {fieldTypeLabel(spec.type)}{spec.required ? ' ·req' : ''}
//
// so the TYPE half of the badge went through the catalog and the REQUIRED half was a hardcoded
// English literal welded to the template. A Dutch author selecting any node with a required input
// read "Tekst ·req" — a Dutch word and an English one inside a single `<span class="field-type">`,
// on the product's PRIMARY authoring surface, on every required port of every node. Same species as
// the raw `.ptype` enums `block-node.port-types.render.test.ts` was written for, and it survived
// that fix precisely because `fieldTypeLabel` was already in the line: the badge LOOKED localized.
//
// ⛔ THE KEY ALREADY EXISTED AND WAS ALREADY RENDERING THIS EXACT FLAG. `m.blockedit_flag_req()`
// ("verpl") labels the required checkbox on the /block-edit I/O editor — the screen an author
// reaches from this one to edit the very ports this panel inspects. So the two halves of one
// workflow disagreed about the word for one concept. Reusing the key is the fix; minting a second
// one would have been the same defect with a catalog entry.
//
// ⚠️ THIS FILE ASSERTS THE DUTCH WORD, NOT THE KEY NAME — deliberately, and unlike its neighbour
// `node-config.foreach-label.i18n.render.test.ts`, which mocks each key to its own name because its
// subject is WHICH key a branch reaches. Here the reader-visible failure is that the badge said
// "req", and a key-name mock cannot tell "the badge is Dutch" from "the badge is a key whose name
// contains the word req". The mock therefore resolves the REAL `messages/nl.json` and the
// assertions are the characters a Dutch employee sees. Same choice, same reason, as
// `block-node.port-types.render.test.ts`.
//
// ⛔ THE ONE-LINE MUTATION THIS IS BUILT AGAINST is the revert: put the literal `' ·req'` back in
// place of `` ` ·${m.blockedit_flag_req()}` ``. `requiredBadge` below then reads "Tekst ·req" and
// the first two tests fail on the word and on the English-token sweep.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BuilderStore } from '$lib/stores/builder.svelte';

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
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

const { listAll, listPaged, getDataset, listMappings } = vi.hoisted(() => ({
	listAll: vi.fn(),
	listPaged: vi.fn(),
	getDataset: vi.fn(),
	listMappings: vi.fn()
}));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: getDataset, listMappings }
}));

import NodeConfigPanel from './NodeConfigPanel.svelte';
import { fieldTypes } from '$lib/stores/field-types.svelte';

/** The catalog's own words, read from the file rather than retyped, so a copy change moves both. */
const NL: Record<string, string> = JSON.parse(
	readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
);
/** "verpl" — the required flag, as /block-edit already spells it. */
const REQ = NL.blockedit_flag_req;
/** "Tekst" — the `string` field type, as the canvas already spells it. */
const TEKST = NL.fieldtype_string;

type Node = { id: string; data: Record<string, unknown> };

/** A block node with one REQUIRED string port and one OPTIONAL one. */
function blockNode(): Node {
	return {
		id: 'n1',
		data: {
			slug: 'flag-claims',
			label: 'Markeer claims',
			kind: 'block',
			config: {},
			descriptor: {
				inputs: {
					reden: { type: 'string', required: true },
					notitie: { type: 'string', required: false }
				}
			}
		}
	};
}

function storeWith(node: Node): BuilderStore {
	return {
		selectedNode: node,
		nodes: [node],
		isInputConnected: () => false,
		updateConfig: vi.fn(),
		removeNode: vi.fn(),
		setLoopConfig: vi.fn(),
		assignToLoop: vi.fn(),
		removeFromLoop: vi.fn()
	} as unknown as BuilderStore;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

beforeEach(() => {
	// Type chips are a developer's opt-in (stores/field-types.svelte); this file is about the chips.
	fieldTypes.allowed = true;
	fieldTypes.preference = true;
	vi.clearAllMocks();
	listAll.mockResolvedValue({ items: [], total: 0, truncated: false });
	listPaged.mockResolvedValue({ items: [], total: 0 });
	listMappings.mockResolvedValue([]);
	getDataset.mockResolvedValue({ columns: [], rows: [] });
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

async function render(): Promise<void> {
	app = mount(NodeConfigPanel, { target: host, props: { builder: storeWith(blockNode()) } }) as Record<
		string,
		unknown
	>;
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** The `.field-type` badge of the named port. */
function badge(field: string): string {
	const el = host.querySelector(`[data-field-name="${field}"] .field-type`);
	return el?.textContent ?? '';
}

describe('the /build inspector port badge is one language', () => {
	it('⛔ NON-VACUITY: both ports render a type badge at all', async () => {
		// Every `not.toContain` below is satisfied for free by a selector that matched nothing, and
		// a panel that failed to mount renders no `.field-type` whatsoever. Prove the badges exist
		// and carry the localized TYPE before asserting anything about the required half.
		await render();
		expect(host.querySelectorAll('.field-type')).toHaveLength(2);
		expect(badge('reden'), 'the required port rendered no badge').toContain(TEKST);
		expect(badge('notitie'), 'the optional port rendered no badge').toContain(TEKST);
	});

	it('⛔ the REQUIRED port reads the catalog word, not the literal "req"', async () => {
		await render();
		// The whole badge, exactly: the Dutch type word, the separator glyph, the Dutch flag word.
		expect(badge('reden')).toBe(`${TEKST} ·${REQ}`);
	});

	it('⛔ leaves no English "req" token on the panel', async () => {
		await render();
		// The sweep the literal fails. Scoped to the badges — "req" is a substring of plenty of
		// legitimate Dutch and of several `data-` attributes, so a whole-panel `textContent` sweep
		// would be both noisy and vacuous.
		const all = [...host.querySelectorAll('.field-type')].map((n) => n.textContent ?? '');
		expect(all).toHaveLength(2);
		// A positive marker first, so "no English" cannot silently mean "nothing rendered".
		expect(all.join(' ')).toContain(REQ);
		expect(all.some((t) => /·req\b/.test(t))).toBe(false);
	});

	it('the OPTIONAL port carries no flag at all', async () => {
		// The `: ''` arm. A fix that appended the flag unconditionally would pass every assertion
		// above and label every port in the product required.
		await render();
		expect(badge('notitie')).toBe(TEKST);
		expect(badge('notitie')).not.toContain('·');
	});

	it('the two words are DIFFERENT words', async () => {
		// A mis-wire to `m.fieldtype_string()` for both halves reads "Tekst ·Tekst" and would
		// satisfy the English-absence sweep above.
		await render();
		expect(REQ).not.toBe(TEKST);
		expect(badge('reden')).not.toBe(`${TEKST} ·${TEKST}`);
	});

	it('the port NAME stays verbatim beside the translated badge', async () => {
		// `reden` is a wire key the flow's edges are keyed on. Localizing it too would be a
		// different — and wrong — fix.
		await render();
		expect(
			[...host.querySelectorAll('[data-field-name="reden"] .field-name')].map((n) => n.textContent)
		).toEqual(['reden']);
	});
});
