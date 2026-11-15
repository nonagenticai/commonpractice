// src/blocks/deep-compare.ts — assertion comparison for block tests (Phase 2-B).
// Two modes:
//   * exact  — `actual` must deep-equal `expected` (same keys, same values).
//   * subset — every key/value in `expected` must be present+equal in `actual`;
//              extra keys in `actual` are tolerated (the default: a test usually
//              pins the outputs it cares about, not the block's whole return).
// Returns a structured list of differences (path + expected + actual) so the UI
// can render an actual-vs-expected diff. An empty list means the assertion passed.

import type { AssertMode } from '../db/block-types';

export interface Difference {
  /** Dotted/bracketed path to the mismatching value, e.g. `pages[0].text`. */
  path: string;
  kind: 'missing' | 'mismatch' | 'unexpected';
  expected?: unknown;
  actual?: unknown;
}

export interface CompareResult {
  ok: boolean;
  diffs: Difference[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep structural equality for JSON values (objects key-order-insensitive). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

/** Recursively collect the differences of `actual` vs `expected`. In subset mode,
 *  keys present in actual but not expected are NOT flagged. */
function collect(
  expected: unknown,
  actual: unknown,
  mode: AssertMode,
  path: string,
  diffs: Difference[],
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push({ path, kind: 'mismatch', expected, actual });
      return;
    }
    // Arrays compare positionally in both modes; a length mismatch is a diff.
    if (expected.length !== actual.length) {
      diffs.push({ path, kind: 'mismatch', expected, actual });
      return;
    }
    expected.forEach((e, i) => collect(e, actual[i], mode, joinPath(path, i), diffs));
    return;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) {
      diffs.push({ path, kind: 'mismatch', expected, actual });
      return;
    }
    for (const [k, ev] of Object.entries(expected)) {
      if (!Object.prototype.hasOwnProperty.call(actual, k)) {
        diffs.push({ path: joinPath(path, k), kind: 'missing', expected: ev });
        continue;
      }
      collect(ev, actual[k], mode, joinPath(path, k), diffs);
    }
    if (mode === 'exact') {
      for (const k of Object.keys(actual)) {
        if (!Object.prototype.hasOwnProperty.call(expected, k)) {
          diffs.push({ path: joinPath(path, k), kind: 'unexpected', actual: actual[k] });
        }
      }
    }
    return;
  }
  // Primitive.
  if (!deepEqual(expected, actual)) {
    diffs.push({ path: path || '(root)', kind: 'mismatch', expected, actual });
  }
}

export function compareOutputs(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  mode: AssertMode,
): CompareResult {
  const diffs: Difference[] = [];
  collect(expected, actual, mode, '', diffs);
  return { ok: diffs.length === 0, diffs };
}
