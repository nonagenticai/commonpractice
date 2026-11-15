// src/lib/i18n/flow-controls-aria.sites.test.ts — the CALL-SITE half of the xyflow chrome fix, and
// the KEY-NAME half that no type check can perform.
//
// ⛔ WHY A SOURCE GUARD FOR THE SECOND SITE. The behaviour is driven end-to-end in
// `components/ontology/flow-controls.aria.render.test.ts`, which mounts a real `<SvelteFlow>` and
// reads the rendered `aria-label`. The other consumer, `components/build/FlowCanvas.svelte`, calls
// `useSvelteFlow()` at the top of its script and therefore only mounts inside a
// `<SvelteFlowProvider>` — a render test for it would measure a harness this repo does not
// otherwise have. So /build's site is pinned textually instead: the prop must be there, exactly
// once, and on the FLOW.
//
// ⛔ AND THE PROP MUST BE ON `<SvelteFlow>`, NOT ON `<Controls>` — a distinction `svelte-check`
// cannot make, because `<Controls>` accepts arbitrary `...rest` props and silently forwards them to
// its `<Panel>` as DOM attributes. `Controls.svelte` reads `store.ariaLabelConfig`, which only the
// flow populates via `mergeAriaLabelConfig`. Putting the config one element lower compiles, renders,
// and leaves every label English.
//
// ⛔ THE KEY NAMES ARE THE OTHER UNTYPED HAZARD. `AriaLabelConfig`'s keys are dotted string
// literals ('controls.zoomIn.ariaLabel'). `Partial<…>` means a TYPO IS A COMPILE ERROR only if the
// object is annotated — but an excess-property check does not fire through a helper's return type
// in every shape, and more importantly a key we simply FORGET is legal `Partial`. So the emitted
// key set is compared against the vendor's own `defaultAriaLabelConfig` at runtime: every key we
// emit must exist there, spelled exactly as the vendor spells it.
import { describe, it, expect, vi } from 'vitest';
import { defaultAriaLabelConfig } from '@xyflow/system';
import { stripComments, readSource } from '$lib/test/source-scan';

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
		mod[key] = () => catalog[key];
	}
	return mod;
});

/** Both consumers of `flowControlsAria()`. Adding a third canvas without the prop reds this file. */
const SITES = [
	'lib/components/build/FlowCanvas.svelte',
	'lib/components/ontology/OntologyGraph.svelte'
];

describe('every xyflow canvas passes the localized chrome config', () => {
	for (const site of SITES) {
		it(`⛔ ${site} passes ariaLabelConfig on <SvelteFlow>, exactly once`, () => {
			const src = stripComments(readSource(site));

			// POSITIVE ANCHOR FIRST: a stripper that ate the file would make every absence-style
			// assertion below pass for the wrong reason.
			expect(src, `${site} does not import flowControlsAria`).toContain(
				"import { flowControlsAria } from '$lib/i18n/flow-controls-aria'"
			);

			const calls = src.split('ariaLabelConfig={flowControlsAria()}').length - 1;
			expect(calls, `${site} passes ariaLabelConfig ${calls} times, not once`).toBe(1);

			// ⛔ AND IT IS INSIDE THE `<SvelteFlow` TAG. Slice from the opening tag to its `>` and
			// require the prop to fall in that window; on `<Controls>` (or on the wrapper div) it is
			// inert and every label stays English.
			const open = src.indexOf('<SvelteFlow');
			expect(open, `${site} has no <SvelteFlow> element`).toBeGreaterThan(-1);
			const close = src.indexOf('>', open);
			const tag = src.slice(open, close);
			expect(
				tag,
				`${site} puts ariaLabelConfig outside the <SvelteFlow> tag, where it does nothing`
			).toContain('ariaLabelConfig={flowControlsAria()}');
		});
	}

	it('⛔ every key emitted is one the vendor actually reads', async () => {
		// A misspelled key is not a type error the compiler will always catch, and it fails
		// SILENTLY: that one label simply stays English while the others turn Dutch.
		const { flowControlsAria } = await import('./flow-controls-aria');
		const vendorKeys = Object.keys(defaultAriaLabelConfig);
		expect(vendorKeys, 'the vendor default config is empty — this guard reads nothing').not.toHaveLength(0);

		const ours = Object.keys(flowControlsAria());
		expect(ours.length, 'flowControlsAria() emits nothing').toBeGreaterThan(0);
		for (const key of ours) {
			expect(vendorKeys, `"${key}" is not a key @xyflow/system reads`).toContain(key);
		}
		// The four control labels are the reason this change exists; a partial config that dropped
		// one of them would leave that button English and pass a "keys are valid" check.
		for (const key of [
			'controls.ariaLabel',
			'controls.zoomIn.ariaLabel',
			'controls.zoomOut.ariaLabel',
			'controls.fitView.ariaLabel',
			'controls.interactive.ariaLabel'
		]) {
			expect(ours, `${key} is not localized — that control stays English`).toContain(key);
		}
	});
});
