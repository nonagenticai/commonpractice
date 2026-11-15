// @vitest-environment jsdom
//
// src/lib/components/ontology/ontology-attr-type.dutch.render.test.ts — the /ontology graph names
// every attribute's TYPE in the reader's language, on FIRST PAINT.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. Locale `nl`, `/ontology`, no click required: 34 raw
// English type labels — `string` ×22, `number` ×9, `date` ×3 — one per attribute row of every
// entity card on the graph, sitting inside a card whose scope chip immediately above them is
// correctly localized by `ontologyScopeLabel`. The node printed the column verbatim:
//
//     <span class="attr-type">{a.type}</span>
//
// `ontology_attributes.type` is a bare `text` column (backend/src/db/schema.ts) written by the
// ontology seeders. It can never be Dutch. The wire carries the value; the browser owns the words.
//
// ⛔ THE HELPER WAS WRITTEN FOR THIS CALL SITE AND WAS NEVER IMPORTED. `datasetColumnTypeLabel`'s
// docblock in `$lib/i18n/dataset-label.ts` names the ontology by name — "this takes `string` and
// degrades to the raw value … the ONTOLOGY carries a parallel attribute type that is NOT closed …
// This function is fit for that call site precisely because an unknown value comes back out as
// itself" — and nothing imported it. The fix is the import.
//
// ⚠️ `@xyflow/svelte` IS STUBBED, AND ONLY IT. Mounting this component for real throws
// `Handle must be used within a Custom Node component`: `Handle` reads a node context that only the
// flow renderer provides, which is a real limitation of the library and the reason
// `sparkline.locale-numbers.render.test.ts` gave up on `ForeachNode` entirely. A connection anchor
// has no text and cannot affect what a reader reads, so replacing it costs this file nothing and
// buys the REAL component's real markup. Nothing about the message layer is stubbed: the Dutch
// below comes from the compiled paraglide functions, exactly as in a browser.
//
// ⚠️ THE SISTER CALL SITE — `routes/ontology/+page.svelte`'s detail panel, the SAME vocabulary one
// pane to the right — cannot be driven from here: `selectedEntity` is set only by
// `OntologyGraph`'s `onselect`, i.e. by clicking a node inside the flow renderer this file has just
// stubbed out. It is held by the source pin at the bottom instead, which reds by name on a revert.
// Stated rather than left implicit: a spec that silently covers two of three sites is how the third
// one ships.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '$lib/test/source-scan';
import type { OntologyEntity } from '$lib/types/ontology';
import { locale } from '$lib/stores/locale.svelte';

vi.mock('@xyflow/svelte', () => ({
	// A Svelte 5 component is a function of `($$anchor, $$props)`; one that appends nothing renders
	// nothing, which is precisely what a connection handle contributes to the text of this card.
	Handle: () => {},
	Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
}));

import OntologyEntityNode from './OntologyEntityNode.svelte';

/** The three types the live database actually holds, plus one it does not.
 *
 * ⚠️ MEASURED, NOT INVENTED: `select type, count(*) from ontology_attributes group by type` on the
 * running stack answers `string` 97, `number` 23, `date` 16 — the exact three that were on screen.
 * `geopoint` is the open half: the column has no enum and no check constraint, so an unrecognised
 * value is a live path here rather than a deploy-skew safety net. */
const entity: OntologyEntity = {
	id: 'e1',
	key: 'generic::claim',
	name: 'claim',
	label: 'Claim',
	synonyms: [],
	description: null,
	scope: 'generic',
	tenantOwned: false,
	attributes: [
		{ name: 'klantnaam', type: 'string', synonyms: [], pii: true, description: null },
		{ name: 'bedrag', type: 'number', synonyms: [], pii: false, description: null },
		{ name: 'ingediend_op', type: 'date', synonyms: [], pii: false, description: null },
		{ name: 'vestiging', type: 'geopoint', synonyms: [], pii: false, description: null }
	]
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	// Assigned directly, never via `locale.set()` — that PATCHes /api/me/locale, which the fail-loud
	// fetch stub in lib/test/setup.ts would name.
	locale.current = initialLocale;
});

function typeChips(): string[] {
	app = mount(OntologyEntityNode, {
		target: host,
		// `NodeProps` carries a dozen flow-runtime fields this read-only card never touches; the
		// component destructures `data` and `selected` only.
		props: { data: { entity }, selected: false } as never
	});
	flushSync();
	// ⛔ THE POSITIVE ANCHOR. A card that threw renders nothing, and every "the English enum is
	// gone" assertion below would pass against an empty DOM.
	expect(
		[...host.querySelectorAll('.attr-name')].map((n) => n.textContent),
		'the entity card never rendered its attribute rows'
	).toEqual(['klantnaam', 'bedrag', 'ingediend_op', 'vestiging']);
	return [...host.querySelectorAll('.attr-type')].map((n) => n.textContent ?? '');
}

describe('an /ontology entity card names its attribute types in the reader’s language', () => {
	it('⛔ THE DUTCH CASE: an attribute of type `string` reads "Tekst"', () => {
		locale.current = 'nl';
		expect(typeChips()).toEqual(['Tekst', 'Getal', 'Datum', 'geopoint']);

		// ⛔ THE ASSERTIONS THAT INVERT ON A REVERT TO `{a.type}` — the exact three tokens counted on
		// the live screen. The card's other words (`Claim`, the scope chip, the PII badge) are
		// deliberately left in the net: none of them contains these substrings.
		const text = host.textContent ?? '';
		for (const raw of ['string', 'number', 'date'])
			expect(text, `the raw enum "${raw}" is still on the card`).not.toContain(raw);
	});

	it('…and the localized card still shows everything ELSE it showed before', () => {
		// A "fix" that dropped the row, or the PII badge with it, would satisfy the negatives above.
		locale.current = 'nl';
		typeChips();
		expect(host.querySelector('.onto-node-name')!.textContent).toBe('Claim');
		expect(host.querySelectorAll('.onto-attr')).toHaveLength(4);
		expect(host.querySelectorAll('.attr-pii')).toHaveLength(1);
		// The scope chip was ALREADY localized — it is the neighbour that made the raw type read as
		// an oversight rather than a convention, so it is asserted to still be Dutch.
		expect(host.querySelector('.onto-scope')!.textContent).not.toBe('generic');
	});

	it('AN UNKNOWN TYPE KEEPS ITS OWN NAME — the column has no enum behind it', () => {
		locale.current = 'nl';
		const chips = typeChips();
		expect(chips[3]).toBe('geopoint');
		expect(chips[3]).not.toBe('');
	});

	it('…and in English the same four read the base catalog — the site reads the tag', () => {
		locale.current = 'en';
		expect(typeChips()).toEqual(['Text', 'Number', 'Date', 'geopoint']);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The third call site of this one-line fix, which no render spec in this repo can reach.
describe('⛔ the /ontology DETAIL PANEL renders the same vocabulary through the same helper', () => {
	const src = stripComments(
		readFileSync(resolve(process.cwd(), 'src/routes/ontology/+page.svelte'), 'utf8')
	);

	it('the attribute row calls the labeller — exactly once, and not from a comment', () => {
		// ⚠️ COMMENTS ARE STRIPPED and the occurrence count is pinned at 1. Both defences are
		// load-bearing and both were measured on this repo: a plain revert with the good line left
		// in an HTML comment above it, and a good line with a second raw one added below it, each
		// passed a naive `indexOf` guard with the full suite green. See $lib/test/source-scan.ts.
		const call = '<span class="attr-type">{datasetColumnTypeLabel(a.type)}</span>';
		expect(
			src.split(call).length - 1,
			`routes/ontology/+page.svelte no longer renders ${call} exactly once — a Dutch reader is ` +
				'back to reading "string" in the panel beside a graph that says "Tekst"'
		).toBe(1);
	});

	it('…and the raw expression it replaced is gone from the file entirely', () => {
		// The positive anchor above proves the fixed line exists; this proves the broken one does
		// not, anywhere — a second attribute list added later cannot quietly reintroduce it.
		expect(src).not.toContain('<span class="attr-type">{a.type}</span>');
		// Non-vacuity for the negative: the surrounding markup this scan reads is really there.
		expect(src).toContain('<span class="attr-name">{a.name}</span>');
	});
});
