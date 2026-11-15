// @vitest-environment jsdom
//
// src/lib/components/ontology/flow-controls.aria.render.test.ts — the xyflow canvas chrome, in
// Dutch, on a real mounted flow.
//
// ⛔ THE DEFECT. `ariaLabelConfig` appeared ZERO times repo-wide, so `<SvelteFlow>` fell back to
// `defaultAriaLabelConfig` in @xyflow/system. `Controls.svelte` puts those strings on BOTH `title=`
// and `aria-label=` of every control button, so the ontology graph and /build's canvas showed
// English TOOLTIPS — "Zoom In", "Zoom Out", "Fit View" — and named their landmark "Control Panel"
// in the accessibility tree, on screens that are otherwise entirely Dutch and reachable without a
// licence.
//
// ⚠️ WHY THE ONTOLOGY GRAPH AND NOT `FlowCanvas`. Both call sites pass the same
// `flowControlsAria()`, but `FlowCanvas` calls `useSvelteFlow()` at the top of its script and so
// only mounts inside a `<SvelteFlowProvider>` — mounting it here would measure a test harness. The
// ontology graph is a plain `<SvelteFlow>` consumer, so it exercises the real prop on the real
// vendor component. `flow-controls-aria.sites.test.ts` pins that /build passes the same object.
//
// ⚠️ THE ASSERTION IS ON THE RENDERED ATTRIBUTE, NOT ON THE MODULE. `flowControlsAria()` returning
// perfect Dutch proves nothing if the prop is dropped, spelled wrong, or put on `<Controls>`
// instead of `<SvelteFlow>` (where it is silently ignored — Controls reads `store.ariaLabelConfig`,
// which only the flow populates). Only the DOM can tell those apart.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { CompiledOntology } from '$lib/types/ontology';

// The REAL nl catalog, read from disk — so this measures the strings that actually ship,
// and goes red the day a key is dropped instead of quietly asserting a copy of itself.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));

import OntologyGraph from './OntologyGraph.svelte';

const ONTOLOGY: CompiledOntology = {
	industry: 'verzekeringen',
	department: 'claims',
	entities: [
		{
			key: 'claim',
			label: 'Claim',
			description: 'Een ingediende claim',
			scope: 'generic',
			fields: [],
			attributes: [],
			source: 'global'
		}
	],
	relations: [],
	hidden: []
} as unknown as CompiledOntology;

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	// xyflow measures its container; jsdom has no layout engine and no ResizeObserver.
	if (!('ResizeObserver' in globalThis)) {
		(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	if (!globalThis.matchMedia) {
		(globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {}
		});
	}
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

function controlButtons(): HTMLButtonElement[] {
	const btns = [...host.querySelectorAll('.svelte-flow__controls button')] as HTMLButtonElement[];
	// ⛔ THE ANTI-VACUITY GATE. "no button reads Zoom In" is trivially true of a canvas that
	// rendered no controls at all — a failed mount, a renamed vendor class, a changed selector.
	expect(btns.length, 'the flow rendered no control buttons — this file tests nothing').toBeGreaterThan(0);
	return btns;
}

describe('the xyflow control chrome speaks the reader’s language', () => {
	it('⛔ no control button is labelled in English', async () => {
		// REVERT THAT TURNS THIS RED: drop `ariaLabelConfig={flowControlsAria()}` from
		// `<SvelteFlow>` (or move it onto `<Controls>`, where it is ignored). Every button falls
		// back to @xyflow/system's `defaultAriaLabelConfig` and reads "Zoom In" / "Zoom Out" /
		// "Fit View" again, on both `title` and `aria-label`.
		app = mount(OntologyGraph, {
			target: host,
			props: { ontology: ONTOLOGY, onselect: () => {} }
		}) as Record<string, unknown>;
		flushSync();

		const labels = controlButtons().flatMap((b) => [
			b.getAttribute('aria-label') ?? '',
			b.getAttribute('title') ?? ''
		]);
		// The vendor's exact English defaults, from
		// node_modules/@xyflow/system/dist/esm/constants.d.ts.
		for (const english of ['Zoom In', 'Zoom Out', 'Fit View', 'Toggle Interactivity']) {
			expect(labels, `a control button is still labelled "${english}"`).not.toContain(english);
		}

		// …and the labels are the DUTCH ones, not merely absent: a fix that emptied them would pass
		// the scan above while leaving every button unnamed to a screen reader.
		expect(labels).toContain('Inzoomen');
		expect(labels).toContain('Uitzoomen');
		expect(labels).toContain('Alles passend maken');
		// Every button carries BOTH attributes — `title` is the sighted reader's tooltip and was
		// half the defect.
		for (const b of controlButtons()) {
			expect(b.getAttribute('aria-label'), 'a control button has no accessible name').toBeTruthy();
			expect(b.getAttribute('title'), 'a control button has no tooltip').toBeTruthy();
		}
	});

	it('⛔ the controls LANDMARK is named in Dutch too, not "Control Panel"', async () => {
		app = mount(OntologyGraph, {
			target: host,
			props: { ontology: ONTOLOGY, onselect: () => {} }
		}) as Record<string, unknown>;
		flushSync();

		const panel = host.querySelector('.svelte-flow__controls');
		expect(panel, 'the controls panel never rendered').not.toBeNull();
		expect(panel!.getAttribute('aria-label')).toBe('Bedieningspaneel');
	});
});
