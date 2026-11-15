// tests/deep-compare.test.ts — Phase 2-B assertion comparison (pure, no DB).
import { test, expect } from 'bun:test';
import { compareOutputs, deepEqual } from '../src/blocks/deep-compare';

test('subset: extra keys in actual are tolerated', () => {
  const r = compareOutputs({ count: 5 }, { count: 5, rows: [1, 2, 3] }, 'subset');
  expect(r.ok).toBe(true);
  expect(r.diffs).toHaveLength(0);
});

test('subset: a missing expected key is a diff', () => {
  const r = compareOutputs({ count: 5, name: 'x' }, { count: 5 }, 'subset');
  expect(r.ok).toBe(false);
  expect(r.diffs.some((d) => d.kind === 'missing' && d.path === 'name')).toBe(true);
});

test('subset: a value mismatch is a diff with both sides', () => {
  const r = compareOutputs({ count: 5 }, { count: 6 }, 'subset');
  expect(r.ok).toBe(false);
  expect(r.diffs[0]).toMatchObject({ path: 'count', kind: 'mismatch', expected: 5, actual: 6 });
});

test('exact: extra keys in actual are flagged as unexpected', () => {
  const r = compareOutputs({ count: 5 }, { count: 5, rows: [] }, 'exact');
  expect(r.ok).toBe(false);
  expect(r.diffs.some((d) => d.kind === 'unexpected' && d.path === 'rows')).toBe(true);
});

test('exact: identical objects pass', () => {
  const r = compareOutputs({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }, 'exact');
  expect(r.ok).toBe(true);
});

test('nested array element mismatch reports an indexed path', () => {
  const r = compareOutputs({ rows: [{ id: 1 }, { id: 2 }] }, { rows: [{ id: 1 }, { id: 9 }] }, 'subset');
  expect(r.ok).toBe(false);
  expect(r.diffs.some((d) => d.path === 'rows[1].id')).toBe(true);
});

test('array length mismatch is a diff', () => {
  const r = compareOutputs({ rows: [1, 2] }, { rows: [1, 2, 3] }, 'subset');
  expect(r.ok).toBe(false);
  expect(r.diffs.some((d) => d.path === 'rows')).toBe(true);
});

test('deepEqual handles primitives, arrays and key-order-insensitive objects', () => {
  expect(deepEqual(1, 1)).toBe(true);
  expect(deepEqual([1, 2], [1, 2])).toBe(true);
  expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  expect(deepEqual('x', 'y')).toBe(false);
});
