// src/lib/agent/synthetic.ts — REAL synthetic DOM event sequences for the agent
// co-pilot (SPEC §5A Layer 3, Session 7). These drive the actual browser interactions
// the user would perform — an HTML5 drag from the palette onto the canvas, a pointer
// drag from one port handle to another, typing into a config field — so the same
// component event handlers fire. They are best-effort and self-verifying against the
// builder store: each returns whether the intended mutation actually landed. The
// driver (driver.ts) commits the edit directly when a performer reports failure, so
// the puppetry is cosmetic and correctness is always store-authoritative.
import type { BuilderStore } from '$lib/stores/builder.svelte';
import { cursor } from './cursor.svelte';
import { centerOf } from './locate';

const hasRaf = typeof requestAnimationFrame === 'function';
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll a predicate up to `ms`, resolving true as soon as it holds (false on timeout). */
async function waitUntil(pred: () => boolean, ms = 500): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - start > ms) return false;
    await delay(hasRaf ? 16 : 0);
  }
}

// ---- add_node: drag a palette tile onto the canvas ----

export async function syntheticAddNode(
  builder: BuilderStore,
  tile: HTMLElement,
  canvasEl: HTMLElement,
  slug: string,
): Promise<boolean> {
  const beforeCount = builder.nodes.length;
  const tc = centerOf(tile);
  await cursor.moveTo(tc.x, tc.y);
  await cursor.press();

  // A drop point inside the canvas, cascaded so successive drops don't stack.
  const r = canvasEl.getBoundingClientRect();
  const dx = r.left + Math.min(Math.max(r.width - 60, 60), 140 + (beforeCount % 4) * 70);
  const dy = r.top + Math.min(Math.max(r.height - 60, 60), 90 + beforeCount * 40);
  await cursor.moveTo(dx, dy);

  const dt = new DataTransfer();
  dt.setData('application/cp-block', slug);
  const fire = (el: HTMLElement, type: string) =>
    el.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dx, clientY: dy }),
    );
  fire(tile, 'dragstart');
  fire(canvasEl, 'dragenter');
  fire(canvasEl, 'dragover');
  fire(canvasEl, 'drop');
  fire(tile, 'dragend');

  await cursor.release();
  // onDropBlock resolves a (cached) block then addNode — wait for the node to appear.
  return waitUntil(() => builder.nodes.length > beforeCount, 600);
}

// ---- connect_nodes: pointer-drag one handle to another ----

function pointer(el: EventTarget, type: string, x: number, y: number): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  );
}

export async function syntheticConnect(
  builder: BuilderStore,
  srcHandle: HTMLElement,
  tgtHandle: HTMLElement,
  matches: () => boolean,
): Promise<boolean> {
  const s = centerOf(srcHandle);
  const t = centerOf(tgtHandle);
  await cursor.moveTo(s.x, s.y);
  await cursor.press();

  pointer(srcHandle, 'pointerdown', s.x, s.y);
  // a couple of intermediate moves (xyflow attaches move/up on the document)
  const mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
  await cursor.moveTo(mid.x, mid.y, 160);
  pointer(document, 'pointermove', mid.x, mid.y);
  await cursor.moveTo(t.x, t.y, 160);
  pointer(tgtHandle, 'pointermove', t.x, t.y);
  pointer(document, 'pointermove', t.x, t.y);
  pointer(tgtHandle, 'pointerup', t.x, t.y);
  pointer(document, 'pointerup', t.x, t.y);

  await cursor.release();
  return waitUntil(matches, 500);
}

// ---- configure_node: type a value into the open config field ----

export async function syntheticConfigure(
  field: HTMLInputElement | HTMLSelectElement,
  value: unknown,
  applied: () => boolean,
): Promise<boolean> {
  const c = centerOf(field);
  await cursor.moveTo(c.x, c.y);
  await cursor.press();
  field.focus?.();

  if (field instanceof HTMLInputElement && field.type === 'checkbox') {
    field.checked = Boolean(value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (field instanceof HTMLSelectElement) {
    field.value = value == null ? '' : String(value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const text =
      value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    field.value = text;
    // the panel listens on `input` for text/number, `change` for completeness
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  await cursor.release();
  return waitUntil(applied, 300);
}

/** Move the cursor to an element (a cosmetic flourish before a direct-apply edit). */
export async function flourishTo(element: Element | null): Promise<void> {
  if (!element) return;
  const c = centerOf(element);
  await cursor.moveTo(c.x, c.y);
}
