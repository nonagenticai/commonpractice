// src/lib/i18n/flow-controls-aria.ts — the xyflow canvas chrome, in the reader's language.
//
// ⛔ THE DEFECT. `ariaLabelConfig` appeared ZERO times repo-wide, so `<SvelteFlow>` fell back to
// `defaultAriaLabelConfig` in @xyflow/system — English. `Controls.svelte` puts those strings on
// BOTH `title=` and `aria-label=` of every control button, so on /build and on the ontology graph a
// Dutch reader got English TOOLTIPS ("Zoom In", "Zoom Out", "Fit View", "Toggle Interactivity") and
// an English "Control Panel" landmark, and a Dutch screen-reader user got the same in the
// accessibility tree. Both canvases are visible in the ungated demo path.
//
// ⚠️ THE PROP LIVES ON `<SvelteFlow>`, NOT ON `<Controls>`. `Controls.svelte` reads
// `store.ariaLabelConfig`, which the flow builds with `mergeAriaLabelConfig(props.ariaLabelConfig)`
// — so a config passed to `<Controls>` is silently ignored, and a PARTIAL config passed to
// `<SvelteFlow>` is merged over the vendor defaults rather than replacing them. That merge is why
// the keys below are a subset and not the whole type.
//
// ⚠️ THE KEY NAMES ARE THE VENDOR'S, EXACTLY. They are dotted string literals
// (`'controls.zoomIn.ariaLabel'`), not identifiers, and a typo does not fail the build — it
// silently leaves that one label English. Checked against
// `node_modules/@xyflow/system/dist/esm/constants.d.ts` (`defaultAriaLabelConfig`).
//
// ⚠️ `controls.interactive.ariaLabel` IS INCLUDED THOUGH BOTH CURRENT SITES PASS
// `showLock={false}`. It costs one catalog key, and the alternative is a lock button that appears
// in English the day someone turns the lock on.
//
// ⛔ THE `node.a11yDescription.*` / `edge.a11yDescription.*` KEYS ARE DELIBERATELY LEFT ALONE, AND
// THAT IS A KNOWN GAP, NOT AN OVERSIGHT. `node.a11yDescription.ariaLiveMessage` is a FUNCTION the
// vendor calls with `{ direction, x, y }` where `direction` is an English word it generates itself
// ('left'/'right'/'up'/'down'). Localizing that family means owning a direction vocabulary and the
// number formatting of live-region coordinates — a separate change with its own tests, not a
// silent rider on the control labels.
import * as m from '$lib/paraglide/messages';
import type { AriaLabelConfig } from '@xyflow/svelte';

/** The canvas chrome labels to merge over @xyflow/system's English defaults. */
export function flowControlsAria(): Partial<AriaLabelConfig> {
	return {
		'controls.ariaLabel': m.flow_aria_controls(),
		'controls.zoomIn.ariaLabel': m.flow_aria_zoom_in(),
		'controls.zoomOut.ariaLabel': m.flow_aria_zoom_out(),
		'controls.fitView.ariaLabel': m.flow_aria_fit_view(),
		'controls.interactive.ariaLabel': m.flow_aria_interactive(),
		'minimap.ariaLabel': m.flow_aria_minimap(),
		'handle.ariaLabel': m.flow_aria_handle()
	};
}
