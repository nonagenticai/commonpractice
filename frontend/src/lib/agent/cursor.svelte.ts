// src/lib/agent/cursor.svelte.ts — the synthetic-cursor controller (SPEC §5A Layer 3,
// Session 7). A reactive singleton the agent driver moves around the screen so the
// user SEES the assistant operate the builder (grab a palette tile, drag to the canvas,
// drag a port to another port, type into a field). It is purely COSMETIC — the actual
// mutation is committed through the builder store (driver.ts), so the animation can
// never affect correctness. SyntheticCursor.svelte renders from this state.
//
// Browser-only timing (requestAnimationFrame). Under jsdom/SSR (no rAF) every motion
// resolves instantly, so the driver's logic stays testable without a real frame loop.

const hasRaf =
  typeof requestAnimationFrame === 'function' && typeof performance === 'object';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class CursorController {
  x = $state(0);
  y = $state(0);
  visible = $state(false);
  pressed = $state(false);

  /** Place the cursor instantly (first appearance) at a screen point. */
  show(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.visible = true;
  }

  /** Ease the cursor to a screen point over `ms`. Resolves when it arrives. The first
   *  move (or without rAF) jumps instantly so the path is always deterministic. */
  moveTo(x: number, y: number, ms = 360): Promise<void> {
    if (!this.visible || !hasRaf) {
      this.show(x, y);
      return Promise.resolve();
    }
    const sx = this.x;
    const sy = this.y;
    const t0 = performance.now();
    return new Promise<void>((resolve) => {
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        // easeInOutQuad
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        this.x = sx + (x - sx) * e;
        this.y = sy + (y - sy) * e;
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async press(): Promise<void> {
    this.pressed = true;
    await delay(hasRaf ? 110 : 0);
  }

  async release(): Promise<void> {
    this.pressed = false;
    await delay(hasRaf ? 80 : 0);
  }

  hide(): void {
    this.visible = false;
    this.pressed = false;
  }
}

export const cursor = new CursorController();
