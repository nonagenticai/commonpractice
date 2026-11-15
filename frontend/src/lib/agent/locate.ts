// src/lib/agent/locate.ts — bridges the builder's graph state to the real DOM the
// agent driver puppeteers (SPEC §5A Layer 3, Session 7). Returns live elements +
// their on-screen geometry for the palette tile, a node, a port handle, and a config
// field. Every locator may return null (layout change / panel closed / SSR) — the
// driver treats null as "couldn't puppeteer" and falls back to an instant store edit,
// so correctness never depends on a lookup succeeding.

/** CSS.escape with a safe fallback (ids here are slugs / uuid-ish, rarely need it). */
function esc(v: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(v);
  return v.replace(/["\\]/g, '\\$&');
}

function el(selector: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(selector);
}

/** The draggable palette tile for a block slug (BlockPalette.svelte data-block-slug). */
export function paletteTile(slug: string): HTMLElement | null {
  return el(`[data-block-slug="${esc(slug)}"]`);
}

/** The canvas drop target (FlowCanvas.svelte data-cp-canvas). */
export function canvas(): HTMLElement | null {
  return el('[data-cp-canvas]');
}

/** A node's SvelteFlow wrapper element by node id. */
export function nodeEl(nodeId: string): HTMLElement | null {
  return el(`.svelte-flow__node[data-id="${esc(nodeId)}"]`);
}

/** A port handle. `kind` disambiguates a node that has same-named in + out ports:
 *  output (source) handles render at data-handlepos="right", inputs (target) "left". */
export function handleEl(
  nodeId: string,
  handleId: string,
  kind: 'source' | 'target',
): HTMLElement | null {
  const pos = kind === 'source' ? 'right' : 'left';
  return (
    el(
      `.svelte-flow__handle[data-nodeid="${esc(nodeId)}"][data-handleid="${esc(handleId)}"][data-handlepos="${pos}"]`,
    ) ??
    // fall back to ignoring position if the handle wasn't laid out on that side
    el(
      `.svelte-flow__handle[data-nodeid="${esc(nodeId)}"][data-handleid="${esc(handleId)}"]`,
    )
  );
}

/** The input/select control for a config field name (NodeConfigPanel data-field-name). */
export function configField(
  fieldName: string,
): HTMLInputElement | HTMLSelectElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[data-field-name="${esc(fieldName)}"] input, [data-field-name="${esc(fieldName)}"] select`,
  );
}

/** The on-screen center of an element (for cursor targeting). */
export function centerOf(element: Element): { x: number; y: number } {
  const r = element.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
