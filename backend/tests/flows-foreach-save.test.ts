// tests/flows-foreach-save.test.ts — the ROUTE-level door to the Phase-5 foreach feature.
//
// ⛔ The executor for bounded foreach loops shipped in #68 and its canvas authoring in #70, both
// well covered — by tests that call `executeFlow` with hand-built IN-MEMORY graphs. Nothing ever
// exercised the only way a foreach graph can actually reach the database: `PATCH /api/flows/:id`.
// Its `flowNodeSchema` was `.strict()`, required non-empty `blockId`/`blockVersionId`, and knew
// nothing of `kind`/`parentId`/`loop` — so a foreach container failed validation on three grounds
// at once and the feature was IMPOSSIBLE TO USE. Live prod:
// `SELECT count(*) FROM flows WHERE graph::text LIKE '%foreach%'` → 0, a month after "shipped".
//
// These tests are schema-level (no DB) so they always run and pin the contract directly.
import { test, expect } from 'bun:test';
import { __flowGraphSchemaForTests as flowGraphSchema } from '../src/routes/flows';

const pos = { x: 0, y: 0 };
const blockNode = {
  id: 'n1',
  blockId: 'b1',
  blockVersionId: 'v1',
  slug: 'load-dataset',
  label: 'Load',
  category: 'data' as const,
  config: {},
  position: pos,
};
// Exactly what `stores/builder-graph.ts` emits for a container + one body node.
const foreachContainer = {
  id: 'loop1',
  blockId: '',
  blockVersionId: '',
  slug: 'foreach',
  label: 'For each row',
  category: 'logic' as const,
  config: {},
  position: pos,
  kind: 'foreach' as const,
  loop: { rowsInput: 'in', maxIterations: 100 },
};
const bodyNode = { ...blockNode, id: 'n2', parentId: 'loop1', kind: 'block' as const };

test('a foreach container graph SAVES — the bug: this was rejected on three grounds at once', () => {
  const r = flowGraphSchema.safeParse({ nodes: [foreachContainer, bodyNode], edges: [] });
  if (!r.success) console.error(JSON.stringify(r.error.issues, null, 2));
  expect(r.success).toBe(true);
});

test('the Phase-5 fields survive the round-trip, not silently stripped', () => {
  const r = flowGraphSchema.safeParse({ nodes: [foreachContainer, bodyNode], edges: [] });
  expect(r.success).toBe(true);
  const [container, body] = (r as { data: { nodes: Record<string, unknown>[] } }).data.nodes;
  expect(container!.kind).toBe('foreach');
  expect(container!.loop).toEqual({ rowsInput: 'in', maxIterations: 100 });
  expect(body!.parentId).toBe('loop1');
});

test('an ORDINARY block node still REQUIRES both ids — the relaxation must not weaken the default', () => {
  for (const field of ['blockId', 'blockVersionId']) {
    const bad = { ...blockNode, [field]: '' };
    const r = flowGraphSchema.safeParse({ nodes: [bad], edges: [] });
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as { error: unknown }).error)).toContain(field);
  }
});

test('unknown keys are still rejected — the schema stays strict', () => {
  const r = flowGraphSchema.safeParse({
    nodes: [{ ...blockNode, somethingElse: 1 }],
    edges: [],
  });
  expect(r.success).toBe(false);
});

test('a bad loop config is rejected (negative cap, unknown key)', () => {
  const neg = { ...foreachContainer, loop: { maxIterations: -1 } };
  expect(flowGraphSchema.safeParse({ nodes: [neg], edges: [] }).success).toBe(false);
  const unknown = { ...foreachContainer, loop: { nope: true } };
  expect(flowGraphSchema.safeParse({ nodes: [unknown], edges: [] }).success).toBe(false);
});

// ---- the hole that opens the moment the schema above is fixed --------------------------------

import { validateGraphStructure } from '../src/exec/flow-validate';

test('a NESTED foreach is refused at validation — the executor would drop its body silently', () => {
  // ⛔ Fixing the save schema removed one of the two guards that made nesting unreachable (the
  // other is a frontend check, which is not a boundary). The executor special-cases `foreach` only
  // at the graph ROOT; a nested container hits `runBlockNode` and throws on its empty
  // blockVersionId — and the inner container's own children appear in NO loop's body order, so
  // they vanish from the run with no trace event at all. Refusing at save time makes that a visible
  // error instead of a silent omission.
  const outer = { ...foreachContainer, id: 'outer' };
  const inner = { ...foreachContainer, id: 'inner', parentId: 'outer' };
  const r = validateGraphStructure({ nodes: [outer, inner], edges: [] } as never);
  expect(r.ok).toBe(false);
  expect(r.issues.map((i) => i.rule)).toContain('nested-foreach');
});

test('a body node claiming a non-loop parent is refused too', () => {
  const r = validateGraphStructure({
    nodes: [blockNode, { ...blockNode, id: 'n3', parentId: 'n1' }],
    edges: [],
  } as never);
  expect(r.ok).toBe(false);
  expect(r.issues.map((i) => i.rule)).toContain('orphan-loop-body');
});

test('a LEGITIMATE one-level foreach still validates — the guard must not break the feature', () => {
  const r = validateGraphStructure({ nodes: [foreachContainer, bodyNode], edges: [] } as never);
  expect(r.issues.map((i) => i.rule)).not.toContain('nested-foreach');
  expect(r.issues.map((i) => i.rule)).not.toContain('orphan-loop-body');
});
