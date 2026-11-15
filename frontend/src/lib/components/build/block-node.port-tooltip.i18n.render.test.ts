// @vitest-environment jsdom
//
// src/lib/components/build/block-node.port-tooltip.i18n.render.test.ts — a port row's TOOLTIP must
// say what the port row's CHIP says.
//
// ⛔ THE DEFECT, AND IT IS A SELF-CONTRADICTION INSIDE ONE ELEMENT. The row was
//
//     <div class="port" title="{p}: {spec.type}{spec.pii ? ' · PII' : ''}">
//       …
//       <span class="ptype">{fieldTypeLabel(spec.type)}</span>
//
// so a Dutch builder saw the chip "Tekst" and hovered it to be told `string`. One value, one DOM
// node, two languages — and no way for the reader to tell which one is the product's word.
//
// ⛔ THIS IS A DISTINCT SITE FROM THE ONE `field-type-label.ts` WAS EXTRACTED FOR. That fix replaced
// `BlockNode`'s own hardcoded English abbreviator on the two `.ptype` spans; the `title` attribute
// two characters away was not part of it, and `block-node.port-types.render.test.ts` reads
// `.ptype` textContent only, so nothing in the repo could see the attribute at all.
//
// ⚠️ THE PORT NAME STAYS VERBATIM, and that is asserted rather than assumed: `p` is a wire key the
// flow's edges are keyed on. Translating it would be a different and wrong fix.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice, same reason, as `block-node.port-types`
// beside it, whose header spells the reasoning out.
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

function ports(specs: readonly FieldSpec[]): Record<string, FieldSpec> {
	return Object.fromEntries(specs.map((s, i) => [`p${i}`, s]));
}

/** Mount a node carrying `specs` on BOTH columns; return each column's port titles + chips. */
function render(specs: readonly FieldSpec[]): {
	inTitles: string[];
	outTitles: string[];
	inChips: string[];
} {
	const data: BlockNodeData = {
		blockId: 'b1',
		blockVersionId: 'v1',
		slug: 'triage-claims',
		label: 'Triage claims',
		category: 'data',
		descriptor: { inputs: ports(specs), outputs: ports(specs), capabilities: {} },
		config: {}
	} as unknown as BlockNodeData;
	app = mount(BlockNode, { target: host, props: { data, selected: false } as never });
	flushSync();
	const titles = (sel: string) =>
		[...host.querySelectorAll(`${sel} .port`)].map((n) => n.getAttribute('title') ?? '');
	return {
		inTitles: titles('.col.in'),
		outTitles: titles('.col.out'),
		inChips: [...host.querySelectorAll('.col.in .ptype')].map((n) => n.textContent ?? '')
	};
}

const typed = (t: string, pii = false) => ({ type: t, ...(pii ? { pii: true } : {}) }) as FieldSpec;

describe('the /build port TOOLTIP agrees with the port CHIP', () => {
	it('⛔ THE DEFECT: the input tooltip is the Dutch word, not the enum', () => {
		// REVERT THAT TURNS THIS RED: `title="{p}: {spec.type}…"`.
		const { inTitles, inChips } = render(FIELD_TYPES.map((t) => typed(t)));
		// ⛔ NON-VACUITY FIRST: seven ports in, seven titles out. A selector matching nothing satisfies
		// every `not.toContain` below for free.
		expect(inTitles, 'the input column rendered no port rows').toHaveLength(7);
		expect(inTitles).toEqual(FIELD_TYPES.map((t, i) => `p${i}: ${DUTCH[t]}`));
		// …and the chip beside it says the SAME thing, which is the property this is about.
		expect(inChips).toEqual(FIELD_TYPES.map((t) => DUTCH[t]));
	});

	it('⛔ …and so does the OUTPUT tooltip — two sites, two assertions', () => {
		// The second render site. Reverting one and not the other is invisible to the case above.
		const { outTitles } = render(FIELD_TYPES.map((t) => typed(t)));
		expect(outTitles, 'the output column rendered no port rows').toHaveLength(7);
		expect(outTitles).toEqual(FIELD_TYPES.map((t, i) => `p${i}: ${DUTCH[t]}`));
	});

	it('⛔ NO ENUM TOKEN SURVIVES IN ANY TITLE — the whole vocabulary at once', () => {
		const { inTitles, outTitles } = render(FIELD_TYPES.map((t) => typed(t)));
		const all = [...inTitles, ...outTitles];
		expect(all).toHaveLength(14);
		// A positive marker before the absences, so "no English" cannot mean "nothing rendered".
		expect(all.some((t) => t.includes('Tekst'))).toBe(true);
		for (const t of FIELD_TYPES) {
			// ⚠️ `: <enum>` — anchored on the separator, because the port NAME legitimately contains no
			// type token but a bare `.toContain('enum')` would also match a port literally named that.
			expect(all.filter((title) => title.endsWith(`: ${t}`)), `the raw "${t}" is still a title`)
				.toEqual([]);
		}
	});

	it('⚠️ THE PORT NAME IS AN IDENTIFIER AND STAYS VERBATIM', () => {
		// `p` is a wire key the flow's edges are keyed on; localizing it would be a different and wrong
		// fix. Asserted so the next reader does not "finish the job".
		const { inTitles } = render([typed('string')]);
		expect(inTitles).toEqual(['p0: Tekst']);
	});

	it('the PII marker rides along, and is the catalog’s word rather than a literal', () => {
		// It was `' · PII'` welded into the template, and the dot's own tooltip was a second hard-coded
		// "PII". Since copy round 2 (2026-10-15) the catalog spells it in plain words ("PII" is jargon
		// to a member), which is exactly the case the one-place-to-change design was for.
		const { inTitles } = render([typed('string', true)]);
		expect(inTitles).toEqual(['p0: Tekst · Persoonsgegevens']);
		expect(
			host.querySelector('.col.in .pii')?.getAttribute('title'),
			'the PII dot kept its hard-coded tooltip'
		).toBe('Persoonsgegevens');
	});

	it('⛔ AN UNKNOWN TYPE DEGRADES TO ITSELF IN THE TITLE TOO', () => {
		// A type added server-side and deployed one roll ahead. `fieldTypeLabel`'s `default:` returns
		// the raw enum on purpose; the title must follow it rather than going blank.
		const { inTitles } = render([typed('geojson')]);
		expect(inTitles).toEqual(['p0: geojson']);
	});
});
