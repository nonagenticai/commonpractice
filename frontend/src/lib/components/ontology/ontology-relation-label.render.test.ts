// @vitest-environment jsdom
//
// src/lib/components/ontology/ontology-relation-label.render.test.ts — the /ontology GRAPH EDGE
// prints the relation's authored/translated label, and never blanks itself to do it.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. A Dutch org admin adds a relation and types `hoort bij`
// into the modal's label field. `saveRelation` sends it (routes/ontology/+page.svelte:511), the
// route takes it, the service stores it, and `compileEffective` even OVERLAYS a seeded Dutch
// translation onto `label` for a non-en reader (pass 3, backend/src/ontology/ontology-service.ts).
// The edge then rendered:
//
//     label: r.predicate      ← OntologyGraph.svelte:60
//
// …so the graph said `belongs_to` and the words the author typed were on no screen in any locale.
// The detail-panel half of the same defect is pinned by
// `routes/ontology/ontology-page.relation-label.render.test.ts`; a fix that lands on one of the two
// render sites is the exact failure mode this repo keeps shipping, so both are held by name.
//
// ⚠️ `@xyflow/svelte` IS STUBBED, AND THE STUB IS THE POINT — this asserts the `edges` array the
// component HANDS the renderer, not pixels the vendor draws. Mounting the real `SvelteFlow` under
// jsdom does render, but an edge is only drawn once BOTH endpoint nodes have been MEASURED, and
// jsdom measures nothing (`ResizeObserver` is a no-op shim there). A DOM assertion on edge text
// would therefore pass or fail on the shim rather than on this component's one line — the
// "green that proves nothing" shape. The boundary this file owns is: what words does /ontology put
// on the edge. What the vendor does with them is the vendor's spec.
//
// ⚠️ AND THE STUB IS THE WHOLE MODULE, NOT THE COMPONENT UNDER TEST. `OntologyGraph`'s own `layout`
// runs for real; nothing about the relation→words mapping is faked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { CompiledOntology, OntologyEntity, OntologyRelation } from '$lib/types/ontology';
import { ontologyRelationLabel } from '$lib/i18n/ontology-relation-label';

const { captured } = vi.hoisted(() => ({
	captured: { props: null as Record<string, unknown> | null }
}));

vi.mock('@xyflow/svelte', () => ({
	// A Svelte 5 component is a function of `($$anchor, $$props)`. This one appends nothing and
	// keeps the live props object, whose `nodes`/`edges` are getters over the component's state —
	// so reading them after `flushSync()` reads exactly what the renderer would have received.
	SvelteFlow: (_anchor: unknown, props: Record<string, unknown>) => {
		captured.props = props;
	},
	Background: () => {},
	Controls: () => {},
	BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
	// `OntologyEntityNode` is in this import graph (it is the `nodeTypes` entry) and destructures
	// these two. The stubbed flow never renders it, so they are never called — but a mock that
	// omits an export vitest is asked for throws on first access rather than returning undefined.
	Handle: () => {},
	Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
}));

import OntologyGraph from './OntologyGraph.svelte';

function entity(name: string, label: string): OntologyEntity {
	return {
		id: `ent-${name}`,
		key: `industry_dept:Insurance:Claims:${name}`,
		name,
		label,
		synonyms: [],
		description: null,
		scope: 'industry_dept',
		tenantOwned: true,
		attributes: []
	};
}

/** A compiled graph with ONE relation, whose `label` is the variable under test.
 *
 * ⚠️ THE ENTITY LABELS ARE ALREADY DUTCH BECAUSE THE SERVER MAKES THEM SO — `localizeEntityLabels`
 * resolves `label` per locale before the wire. Nothing here needs a locale switch: the browser's
 * job on this field is to PRINT what arrived, and that is precisely what regressed. */
function graph(label: string | null | undefined): CompiledOntology {
	const relation = {
		id: 'rel-1',
		from: 'BrokerNote',
		to: 'Policy',
		predicate: 'belongs_to',
		label,
		cardinality: 'n:1',
		tenantOwned: true
	} as unknown as OntologyRelation;
	return {
		industry: 'Insurance',
		department: 'Claims',
		entities: [entity('BrokerNote', 'Makelaarsnotitie'), entity('Policy', 'Polis')],
		relations: [relation],
		hidden: []
	} as CompiledOntology;
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	captured.props = null;
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Mount the real component over a one-relation graph and return the edges it produced. */
function edgesFor(label: string | null | undefined): { id: string; label: string }[] {
	app = mount(OntologyGraph, {
		target: host,
		props: { ontology: graph(label), onselect: () => {} }
	}) as Record<string, unknown>;
	flushSync();
	// ⛔ THE POSITIVE ANCHOR. A component that threw, or a stub that never received the flow's
	// props, hands back `undefined` — against which every "the predicate is gone" assertion below
	// would pass over an empty array.
	expect(captured.props, 'OntologyGraph never rendered its SvelteFlow').toBeTruthy();
	const nodes = captured.props!.nodes as { id: string }[];
	expect(
		nodes.map((n) => n.id),
		'the graph laid out no entity nodes — nothing here is reachable'
	).toEqual(['BrokerNote', 'Policy']);
	return captured.props!.edges as { id: string; label: string }[];
}

describe('an /ontology graph edge is named by the relation’s label, not its predicate', () => {
	it('⛔ THE DUTCH CASE: an authored label `hoort bij` is what the edge says', () => {
		const edges = edgesFor('hoort bij');
		expect(edges).toHaveLength(1);
		expect(edges[0]!.label).toBe('hoort bij');
		// ⛔ THE ASSERTION THAT INVERTS ON A REVERT TO `label: r.predicate` — the exact token that was
		// on the live screen where the author's words should have been.
		expect(edges[0]!.label, 'the canonical predicate is still the edge’s visible text').not.toBe(
			'belongs_to'
		);
	});

	it('AN EMPTY LABEL FALLS BACK TO THE PREDICATE — `??` would print nothing at all', () => {
		// ⛔ THIS IS THE ORDINARY CASE, NOT AN EDGE CASE. `ontology_relations.label` is
		// `text NOT NULL DEFAULT ''` and the insert path writes `input.label?.trim() ?? ''`
		// (backend/src/ontology/ontology-service.ts), so EVERY relation whose author left the field
		// blank — and every seeded global edge — arrives here with `''`. Written with `??`, this
		// case renders an unlabelled edge: the fix would have turned "wrong word" into "no word".
		const edges = edgesFor('');
		expect(edges[0]!.label).toBe('belongs_to');
		expect(edges[0]!.label, 'the edge lost its text entirely').not.toBe('');
	});

	it('A MISSING LABEL FALLS BACK TOO — an older wire, or a client that never sent one', () => {
		expect(edgesFor(null)[0]!.label).toBe('belongs_to');
		expect(edgesFor(undefined)[0]!.label).toBe('belongs_to');
	});

	it('⛔ THE EDGE `id` STAYS ON THE PREDICATE — a key must not move with the reader’s language', () => {
		// Keying the edge on a localized string re-keys every edge on a locale switch, and keying it
		// on a value that can be `''` collides two edges of the same pair into one. Display words
		// move; identity does not. See $lib/i18n/ontology-relation-label.ts.
		expect(edgesFor('hoort bij')[0]!.id).toBe('e0_BrokerNote_belongs_to_Policy');
	});
});

describe('ontologyRelationLabel — the rule both render sites share', () => {
	it('prefers a non-blank label and degrades to the predicate', () => {
		expect(ontologyRelationLabel({ predicate: 'belongs_to', label: 'hoort bij' })).toBe('hoort bij');
		expect(ontologyRelationLabel({ predicate: 'belongs_to', label: '' })).toBe('belongs_to');
		// Whitespace is not a label. The write path already trims (`f.label.trim() || …`), but a
		// pre-fix row, a seed file, or a direct API caller can hold one.
		expect(ontologyRelationLabel({ predicate: 'belongs_to', label: '   ' })).toBe('belongs_to');
		expect(ontologyRelationLabel({ predicate: 'belongs_to', label: null })).toBe('belongs_to');
		expect(ontologyRelationLabel({ predicate: 'belongs_to' })).toBe('belongs_to');
		// It never returns a blank: `predicate` is `min(1)` on the write path and 400s empty.
		expect(ontologyRelationLabel({ predicate: 'belongs_to', label: '' })).not.toBe('');
	});
});
