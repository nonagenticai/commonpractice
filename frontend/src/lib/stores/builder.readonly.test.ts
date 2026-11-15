// src/lib/stores/builder.readonly.test.ts — a flow that belongs to somebody else must come out of
// the builder exactly as it went in, no matter which door an edit arrives through.
//
// ⛔ THE DEFECT. `GET /api/flows/:id` (backend/src/routes/flows.ts `getFlow`) has always answered
// `readOnly: true` for a caller who is not the owner and is only seeing the flow because it backs a
// published marketplace solution — that IS the "Open in Build" button on a solution page. Nothing in
// `frontend/src` read the field: `flowsApi.get` did not type it, `types/flows.ts` did not carry it,
// and the only `readOnly` in the tree came from the SNAPSHOTS endpoint (`FlowHistoryPanel`). So a
// visitor got a fully live canvas over somebody else's flow, the 800 ms autosave `PATCH`ed a row
// `loadOwnedFlow` refuses, "Opslaan mislukt" pinned itself over the topbar for the rest of the
// session, and every edit was lost on reload.
//
// ⛔⛔ WHY THE STORE AND NOT ONLY THE PAGE. Three independent callers reach these mutators: the
// reader's own clicks and drags, the palette's drop handlers, and the AI copilot's tool-calls
// (`agent-chat`'s driver calls `addNode` / `connectNodes` / `updateConfig` by name). Each page-level
// affordance closes exactly one of those doors. The store is where all three meet, so this is the
// file that can state the property once for all of them.
//
// ⛔ THE ASSERTION IS `serialize()`, BYTE FOR BYTE, NOT "the method returned early". A guard that
// returns after it has already spliced `this.edges` — the exact hazard in `insertNode`, which calls
// `addNode` and then rewrites the edge list around the id it gets back — passes any test that only
// watches return values. Comparing the SERIALIZED graph is the only check that sees a half-applied
// mutation, and it is also the shape the autosave effect and `doSave` actually put on the wire.
//
// ⚠️ AND THE EDITABLE HALF IS ASSERTED TOO, ONE MUTATOR AT A TIME. `expect(serialize()).toEqual(…)`
// over a store where NOTHING can mutate is a test that passes on a broken product: delete the
// bodies of all eleven methods and the read-only half stays green forever. Every case below drives
// the same call twice — once refused, once applied — so the refusal is only ever reported against a
// mutator that demonstrably works.
import { describe, it, expect } from 'vitest';
import { getEdgeId } from '@xyflow/system';
import type { BlockDescriptor } from '$lib/types/blocks';
import type { Flow, FlowGraph } from '$lib/types/flows';
import { BuilderStore, type BlockEntry } from './builder.svelte';

const DESC: BlockDescriptor = {
	inputs: { in: { type: 'json' } },
	outputs: { out: { type: 'json' } },
	capabilities: {}
};
const resolve = () => DESC;

const ENTRY: BlockEntry = {
	blockId: 'b_new',
	blockVersionId: 'v_new',
	slug: 'summarise',
	name: 'Summarise',
	category: 'ai',
	descriptor: DESC
};

function node(id: string, x: number, y: number, extra: Record<string, unknown> = {}) {
	return {
		id,
		blockId: `b_${id}`,
		blockVersionId: `v_${id}`,
		slug: id,
		label: id,
		category: 'logic' as const,
		config: {},
		position: { x, y },
		...extra
	};
}

/** A flow with a block pair, a foreach container and a body node — one instance of every shape a
 *  mutator below touches, so no case is refused merely because its target does not exist. */
function graph(): FlowGraph {
	return {
		nodes: [
			node('a', 100, 100),
			node('b', 400, 100),
			{
				id: 'fe1',
				blockId: '',
				blockVersionId: '',
				slug: 'foreach',
				label: 'For each row',
				category: 'logic',
				config: {},
				position: { x: 700, y: 100 },
				kind: 'foreach',
				loop: { rowsInput: 'in', maxIterations: 50 }
			},
			node('body', 760, 180, { parentId: 'fe1' })
		],
		edges: [{ id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }]
	};
}

function flow(readOnly: boolean | undefined): Flow {
	return {
		id: 'f1',
		name: "Someone else's claim summariser",
		description: '',
		owner_id: 'u-other',
		status: 'draft',
		version: '1',
		solution_id: 's1',
		last_saved_at: '2026-08-01T00:00:00.000Z',
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		graph: graph(),
		...(readOnly === undefined ? {} : { readOnly })
	};
}

/** The edge `@xyflow/svelte` appends itself for a hand-drawn connection: ITS id, not ours.
 *  ⛔ THE LITERAL IS `@xyflow/system`'s `getEdgeId` OUTPUT, SPELLED OUT — `xy-edge__${source}
 *  ${sourceHandle}-${target}${targetHandle}`, with NO separator between node and handle. Writing it
 *  by hand rather than importing it is the point: if an xyflow upgrade changes the format, this
 *  fixture stops matching what `adoptConnection` computes and the case goes red, which is the
 *  warning we want. The `contract` case below pins the two against each other. */
const XY_EDGE = {
	id: 'xy-edge__bout-fe1in',
	source: 'b',
	target: 'fe1',
	sourceHandle: 'out',
	targetHandle: 'in'
};
const CONN = { source: 'b', sourceHandle: 'out', target: 'fe1', targetHandle: 'in' };

function loaded(readOnly: boolean | undefined): BuilderStore {
	const b = new BuilderStore();
	b.load(flow(readOnly), resolve);
	return b;
}

/** Every mutator, by the name the store exports it under, with a drive that really changes THIS
 *  graph. Hand-listing is the point: a new mutator that forgets its guard has to be added here to
 *  be exercised, and the inventory assertion below is what makes forgetting loud. */
const MUTATORS: Array<{ name: string; drive: (b: BuilderStore) => void }> = [
	{ name: 'addNode', drive: (b) => void b.addNode(ENTRY, { x: 10, y: 20 }) },
	{ name: 'updateConfig', drive: (b) => b.updateConfig('a', 'model', 'gpt-4o') },
	{ name: 'connectNodes', drive: (b) => void b.connectNodes('b', 'out', 'fe1', 'in') },
	// ⚠️ `adoptConnection`'s DRIVE HAS TO APPEND THE EDGE FIRST, because that is the situation it is
	// called in: `@xyflow/svelte` has ALREADY written the new edge through `bind:edges` by the time
	// `onconnect` fires, so the store is never asked to create one — it is asked to keep it (with
	// this app's id) or take it away. Which is why this drive reads as "mutate, then call": the
	// refusal half below is satisfied only if the call REMOVES what xyflow put there.
	{ name: 'adoptConnection', drive: (b) => { b.edges = [...b.edges, XY_EDGE]; b.adoptConnection(CONN); } },
	{ name: 'replaceGraph', drive: (b) => void b.replaceGraph([], []) },
	{ name: 'disconnectNodes', drive: (b) => b.disconnectNodes('e1') },
	{ name: 'removeNode', drive: (b) => b.removeNode('b') },
	{ name: 'moveNode', drive: (b) => b.moveNode('a', { x: 999, y: 999 }) },
	{ name: 'insertNode', drive: (b) => void b.insertNode(ENTRY, 'e1', { x: 250, y: 100 }) },
	{ name: 'addForeach', drive: (b) => void b.addForeach({ x: 40, y: 400 }) },
	{ name: 'assignToLoop', drive: (b) => b.assignToLoop('b', 'fe1') },
	{ name: 'removeFromLoop', drive: (b) => b.removeFromLoop('body') },
	{ name: 'setLoopConfig', drive: (b) => b.setLoopConfig('fe1', { maxIterations: 7 }) }
];

describe('BuilderStore.readOnly', () => {
	it('the flag is minted from the wire, and ONLY `true` closes the gate', () => {
		expect(loaded(true).readOnly, 'a non-owner load left the canvas editable').toBe(true);
		expect(loaded(false).readOnly, "the owner's own flow opened read-only").toBe(false);
		// A create/save response and a backend one deploy behind both omit the field entirely. Both
		// must read as editable — the alternative is a product that goes read-only during a roll.
		expect(loaded(undefined).readOnly, 'an absent field was read as read-only').toBe(false);
	});

	it('the inventory below is the store’s ACTUAL mutator set', () => {
		// ⛔ NON-VACUITY, AND THE SPECIFIC HOLE IT CLOSES. The per-mutator cases are driven off a
		// hand-written list; a twelfth mutator added next month would be guarded by nothing and this
		// file would stay 100% green while saying nothing about it. Comparing the list against the
		// prototype's own methods makes the omission red, with the missing name printed.
		const READS = new Set([
			'constructor',
			'selectedNode', // a getter
			'locked', // a getter: readOnly || viewOnly
			'setChallengeContext', // ephemeral view state, never serialized
			'load', // hydration is not an edit — see the store's own comment
			'resolveSlug', // repairs the RENDER of a node already on screen
			'serialize',
			'isInputConnected'
		]);
		const actual = Object.getOwnPropertyNames(BuilderStore.prototype)
			.filter((n) => !READS.has(n))
			.sort();
		expect(actual).toEqual(MUTATORS.map((m) => m.name).sort());
	});

	for (const { name, drive } of MUTATORS) {
		it(`${name} is refused read-only and applied otherwise`, () => {
			// The refusal half.
			const ro = loaded(true);
			const before = JSON.stringify(ro.serialize());
			drive(ro);
			expect(JSON.stringify(ro.serialize()), `${name} mutated a read-only flow`).toBe(before);

			// The non-vacuity half: the SAME drive against an editable store must change the graph,
			// or the assertion above is only reporting that the drive does nothing at all.
			const rw = loaded(false);
			const baseline = JSON.stringify(rw.serialize());
			drive(rw);
			expect(
				JSON.stringify(rw.serialize()),
				`${name} changed nothing even when editable — the refusal above proves nothing`
			).not.toBe(baseline);
		});
	}

	it('⛔ insertNode leaves NO half-applied edge split behind', () => {
		// The one mutator that mutates in two steps: it calls `addNode` and then rewrites `edges`
		// around the id it gets back. A guard on `addNode` alone would return `''`, the edge split
		// would run anyway, and the graph would end up with `e1` replaced by two edges pointing at a
		// node that does not exist. `serialize()` above already sees that, but the failure deserves
		// to be named rather than folded into a string diff.
		const ro = loaded(true);
		expect(ro.insertNode(ENTRY, 'e1', { x: 250, y: 100 })).toBeNull();
		expect(ro.serialize().edges.map((e) => e.id)).toEqual(['e1']);
		expect(ro.serialize().nodes).toHaveLength(4);
	});

	it('⛔ a connect attempt leaves a read-only edge set EXACTLY as it was', () => {
		// D2. The product defence is `nodesConnectable={false}` on the flow, which stops the drag —
		// a UI-level defence for a store-level rule. This drives the state that prop is supposed to
		// prevent: xyflow has appended its edge and `onconnect` has fired anyway.
		const ro = loaded(true);
		const before = JSON.stringify(ro.serialize());
		ro.edges = [...ro.edges, XY_EDGE];
		expect(ro.serialize().edges, 'the fixture never got xyflow’s edge on — nothing to refuse').toHaveLength(2);
		ro.adoptConnection(CONN);
		expect(JSON.stringify(ro.serialize()), 'a read-only canvas kept an edge the reader drew').toBe(before);

		// The owner half: the same append + call KEEPS the edge and stamps this app's id on it.
		const rw = loaded(false);
		rw.edges = [...rw.edges, XY_EDGE];
		rw.adoptConnection(CONN);
		expect(rw.serialize().edges.map((e) => e.id), 'the owner’s connection was dropped or left unnamed').toEqual([
			'e1',
			'e_b.out->fe1.in'
		]);
	});

	it('⛔ the fixture’s xyflow id is the one @xyflow/system actually mints', () => {
		// ⛔ NON-VACUITY FOR THE TWO CASES AROUND IT. `adoptConnection` recognises the appended edge
		// by an id it recomputes itself; every case here feeds it a HAND-WRITTEN id. If the two ever
		// disagree — an xyflow upgrade changing the format, a typo in the literal — the read-only
		// case would pass because NOTHING matched, which is the failure mode it exists to catch.
		expect(getEdgeId(CONN)).toBe(XY_EDGE.id);
	});

	it('⛔ adoptConnection never touches an edge the reader already had', () => {
		// Re-drawing a connection that already exists must not rename the original — and, read-only,
		// must not DELETE it. Both stores are handed a connect whose endpoints match the
		// pre-existing `e1`, with no xyflow edge appended at all. The old `onConnect` matched on
		// endpoints and excluded `id.startsWith('e_')`, so this drive renamed `e1`.
		const same = { source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' };
		for (const readOnly of [true, false]) {
			const b = loaded(readOnly);
			const before = JSON.stringify(b.serialize());
			b.adoptConnection(same);
			expect(
				JSON.stringify(b.serialize()),
				`adoptConnection rewrote an existing edge (readOnly=${readOnly})`
			).toBe(before);
		}
	});

	it('⛔ replaceGraph REPORTS its refusal, so undo/redo can leave their stacks alone', () => {
		// /build pops `undoStack` only once this has returned true. A guard that returned `void`
		// would refuse the write and still consume the history step — a silent half-apply of the
		// same shape `insertNode` above exists to prevent.
		expect(loaded(true).replaceGraph([], []), 'a refused replaceGraph reported success').toBe(false);
		expect(loaded(false).replaceGraph([], []), 'the owner’s undo was told it had been refused').toBe(true);
	});

	it('load() and resolveSlug() stay ungated — hydration and descriptor repair are not edits', () => {
		// ⛔ THE OVER-CORRECTION GUARD. Gating `load` makes a read-only flow unopenable (an empty
		// canvas and an amber banner about a flow the reader can no longer see); gating `resolveSlug`
		// leaves every node whose descriptor arrived late permanently portless. Both are one line
		// away from the change this file exists for.
		const b = loaded(true);
		expect(b.serialize().nodes, 'load() refused to hydrate a read-only flow').toHaveLength(4);

		// A second load REPLACES the graph even read-only — that is a flow switch, not an edit. This
		// one's descriptor lookup FAILS, which is the state `resolveSlug` exists to repair (a node
		// whose ports are unknown renders with none and xyflow stops drawing its edges).
		b.load({ ...flow(true), graph: { nodes: [node('z', 0, 0)], edges: [] } }, () => null);
		expect(b.serialize().nodes.map((n) => n.id)).toEqual(['z']);
		expect(b.readOnly, 'the second load lost the flag').toBe(true);
		expect(b.nodes[0]!.data.descriptorUnavailable, 'the fixture never reached the repair state').toBe(true);

		// And a descriptor arriving late still patches the node it belongs to.
		b.resolveSlug('z', () => ({ inputs: { late: { type: 'json' } }, outputs: {}, capabilities: {} }));
		expect(Object.keys(b.nodes[0]!.data.descriptor.inputs)).toEqual(['late']);
		expect(b.nodes[0]!.data.descriptorUnavailable).toBeFalsy();
	});

	it('nodes/edges stay directly assignable, because xyflow writes measurements through them', () => {
		// ⛔ THE FIX THAT MUST NOT BE MADE. Turning `nodes`/`edges` into gated accessors is the
		// obvious way to close the last door — and it breaks `fitView`: `FlowCanvas.svelte`'s
		// `bind:nodes` is the SAME channel `@xyflow/svelte` writes measured `width`/`height` back
		// through, so a read-only visitor would open on a canvas stuck at the origin. The canvas is
		// told `nodesDraggable={false} nodesConnectable={false} deleteKey={null}` instead, so xyflow
		// raises no graph mutation to swallow in the first place.
		const b = loaded(true);
		b.nodes = b.nodes.map((n) => ({ ...n, measured: { width: 190, height: 100 } }));
		expect(b.nodes.every((n) => n.measured?.width === 190)).toBe(true);
	});
});

describe('BuilderStore.viewOnly — the narrow-screen half of the ONE gate', () => {
	// ⛔ THE DEFECT. Below 1024px /build passed `narrow` to the canvas and the palette only. The
	// mutators gated on `readOnly` alone, so on the author's OWN flow at 900px the assistant's
	// tool-calls, the Details panel, ⌘Z/⌘Y (`replaceGraph`) and the title all still wrote the graph
	// — on a canvas the note calls view-only. `locked` is the one effective read-only now, and this
	// drives every mutator against an OWNED flow (`readOnly: false`) with only the layout gate shut.
	it('`locked` is readOnly OR viewOnly, and viewOnly is not a fact about the flow', () => {
		const b = loaded(false);
		expect(b.locked).toBe(false);
		b.viewOnly = true;
		expect(b.locked, 'a narrow screen left the store editable').toBe(true);
		expect(b.readOnly, 'the layout gate rewrote the ownership fact').toBe(false);
		b.viewOnly = false;
		expect(b.locked).toBe(false);
	});

	for (const { name, drive } of MUTATORS) {
		it(`${name} is refused on the owner's own flow while viewOnly, and applied once it is lifted`, () => {
			const narrow = loaded(false);
			narrow.viewOnly = true;
			const before = JSON.stringify(narrow.serialize());
			drive(narrow);
			expect(JSON.stringify(narrow.serialize()), `${name} mutated the graph at narrow width`).toBe(before);

			// Non-vacuity: the same store, the gate lifted, the same drive changes the graph.
			narrow.viewOnly = false;
			drive(narrow);
			expect(
				JSON.stringify(narrow.serialize()),
				`${name} changed nothing once widened — the refusal above proves nothing`
			).not.toBe(before);
		});
	}
});
