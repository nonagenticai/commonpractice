// tests/dataset-resolver.test.ts — ctx.dataset(slug) must not turn a MISSING dataset into an
// empty one.
//
// Every global ontology data block defaults to a dataset the DEMO tenant seeds. A different tenant
// dragging one onto the canvas has no such dataset, so the host injects nothing for that slug — and
// the old `datasets[slug]?.rows ?? []` served `[]`. The block then emitted `count: 0` and the flow
// carried on over empty input: no failure, no warning, and a block that looked like it worked.
import { test, expect } from 'bun:test';
// Imported from `exec/dataset-resolver`, NOT `exec/runner-entry`. runner-entry deletes
// globalThis.fetch at module load (that stripping is its sandbox), so importing it from a test
// disarms fetch for the whole `bun test` process and every later file that uses it dies with
// `ReferenceError: fetch is not defined`. That is how this suite first went red in CI — 42
// delivery/egress failures — while passing locally, because file order decides who gets poisoned.
import { makeDatasetResolver } from '../src/exec/dataset-resolver';

test('an injected dataset serves its rows', () => {
  const resolve = makeDatasetResolver({ claims: { rows: [{ id: 1 }, { id: 2 }] } });
  expect(resolve('claims')).toEqual([{ id: 1 }, { id: 2 }]);
});

test('an injected but EMPTY dataset still returns [] — that is a real answer', () => {
  // The distinction the whole fix rests on: the host injected it, and it genuinely has no rows.
  const resolve = makeDatasetResolver({ claims: { rows: [] } });
  expect(resolve('claims')).toEqual([]);
});

test('a MISSING dataset throws instead of silently yielding an empty flow', () => {
  const resolve = makeDatasetResolver({ mine: { rows: [{ a: 1 }] } });
  expect(() => resolve('claims-2024')).toThrow(/not available in this workspace/);
});

test('the error names what this workspace DOES have — the fix is usually to repoint the source', () => {
  const resolve = makeDatasetResolver({ mine: { rows: [] }, other: { rows: [] } });
  try {
    resolve('claims-2024');
    throw new Error('should have thrown');
  } catch (err) {
    const msg = (err as Error).message;
    expect(msg).toContain("'claims-2024'");
    expect(msg).toContain('mine');
    expect(msg).toContain('other');
  }
});

test('with NOTHING injected the message stays clean rather than listing an empty set', () => {
  const resolve = makeDatasetResolver({});
  const msg = (() => {
    try {
      resolve('claims-2024');
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  })();
  expect(msg).toContain('not available in this workspace');
  expect(msg).not.toContain('available here');
});
