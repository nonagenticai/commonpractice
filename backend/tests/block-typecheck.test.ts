// tests/block-typecheck.test.ts — Phase 2-B type-check + lint (pure, no DB).
//
// EVERY test here gets an explicit timeout. `typeCheckBlockSource` runs the TypeScript compiler, so
// a case costs 5-13 s on a loaded machine, and bun 1.3.14 ignores bunfig's `[test] timeout` for
// TESTS just as it does for hooks — the real budget is a hard 5 s. Without these the file goes red
// under CI contention as `timed out after 5000ms` with zero assertion failures, which reads like a
// regression and is not one.
import { test, expect } from 'bun:test';
import { typeCheckBlockSource } from '../src/blocks/type-check';
import { lintBlock } from '../src/blocks/lint';

const clean = `export default {
  descriptor: { inputs: {}, outputs: { n: { type: 'number' } }, capabilities: {} },
  async run(inputs, ctx) { ctx.log('info', 'hi'); return { n: 42 }; }
};`;

test('type-check passes a clean block', () => {
  const r = typeCheckBlockSource(clean);
  expect(r.ok).toBe(true);
  expect(r.diagnostics).toHaveLength(0);
}, 30_000);

test('type-check catches a real type error with line/col', () => {
  const src = `export default {
  descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  async run(inputs, ctx) { const x: number = "not a number"; return { x }; }
};`;
  const r = typeCheckBlockSource(src);
  expect(r.ok).toBe(false);
  expect(r.diagnostics[0]?.code).toBe(2322); // not assignable
  expect(r.diagnostics[0]?.line).toBe(3);
  expect(typeof r.diagnostics[0]?.col).toBe('number');
}, 30_000);

test('type-check types ctx when the block annotates as Block (catches ctx misuse)', () => {
  const src = `import type { Block } from './sdk';
const b: Block = {
  descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  async run(inputs, ctx) { ctx.nope(); return {}; }
};
export default b;`;
  const r = typeCheckBlockSource(src);
  expect(r.ok).toBe(false);
  expect(r.diagnostics.some((d) => d.code === 2339)).toBe(true); // property does not exist
}, 30_000);

test('type-check does NOT reject the conventional un-annotated run(inputs, ctx) style', () => {
  // noImplicitAny is off on purpose — existing blocks rely on the SDK contract.
  const r = typeCheckBlockSource(clean);
  expect(r.ok).toBe(true);
}, 30_000);

test('module-not-found (2307) is suppressed (owned by static-scan)', () => {
  const r = typeCheckBlockSource(`import x from 'lodash';\nexport default { async run(){ return {}; } };`);
  expect(r.diagnostics.some((d) => d.code === 2307)).toBe(false);
}, 30_000);

// ---- lintBlock = scan ⊕ tsc ----

test('lintBlock passes clean source', () => {
  expect(lintBlock(clean).ok).toBe(true);
}, 30_000);

test('lintBlock flags a banned import via the scan layer', () => {
  const r = lintBlock(`import net from 'node:net';\nexport default { async run(){ return {}; } };`);
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.source === 'scan' && f.rule === 'banned-import')).toBe(true);
}, 30_000);

test('lintBlock flags a type error via the type layer', () => {
  const r = lintBlock(`export default {
  descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  async run(inputs, ctx) { const x: number = true; return { x }; }
};`);
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.source === 'type')).toBe(true);
}, 30_000);
