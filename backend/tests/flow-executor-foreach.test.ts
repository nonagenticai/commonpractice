// tests/flow-executor-foreach.test.ts — Phase 5: bounded foreach container execution, 100%
// in-process (no spawn, no DB). Proves: per-row body execution with `item` wiring + collected
// `results`; skip-and-continue on a failed row; iteration-cap (soft), event-budget (fatal),
// wall-clock (fatal) bounds; and a non-array rowset → validation error.
import { test, expect } from 'bun:test';
import { executeFlow, type ExecDeps } from '../src/exec/flow-executor';
import type { LoadedBlock } from '../src/exec/block-loader';
import type { FlowGraph, FlowNode } from '../src/db/flow-types';
import type { TraceEvent } from '../src/db/trace-types';

function node(id: string, over: Partial<FlowNode> = {}): FlowNode {
  return {
    id,
    blockId: `b-${id}`,
    blockVersionId: `v-${id}`,
    slug: over.slug ?? id,
    label: id,
    category: 'logic',
    config: over.config ?? {},
    position: { x: 0, y: 0 },
    ...over,
  };
}

function harness(blocks: Record<string, LoadedBlock>): { events: TraceEvent[]; deps: ExecDeps } {
  const events: TraceEvent[] = [];
  let clock = 0;
  return {
    events,
    deps: {
      async loadBlock(versionId) {
        const b = blocks[versionId];
        if (!b) throw new Error(`no fake block ${versionId}`);
        return b;
      },
      llm: async () => ({ text: 'x', usage: { tokensIn: 0, tokensOut: 0 }, costUsd: 0 }),
      mockData: (kind) => ({ kind }),
      dataset: () => [],
      emit: (ev) => events.push(ev),
      now: () => clock++,
    },
  };
}

const SRC: LoadedBlock = {
  descriptor: { inputs: {}, outputs: { rows: { type: 'json' } }, capabilities: {} },
  run: async (i) => ({ rows: (i.rows as unknown[]) ?? [] }),
};
function bodyBlock(fn: (n: number) => Record<string, unknown>): LoadedBlock {
  return {
    descriptor: { inputs: { item: { type: 'json' } }, outputs: { out: { type: 'json' } }, capabilities: {} },
    run: async (inputs) => {
      const n = (inputs.item as { n?: number } | undefined)?.n ?? 0;
      return { out: fn(n) };
    },
  };
}
let aggSeen: unknown;
const AGG: LoadedBlock = {
  descriptor: { inputs: { results: { type: 'json' } }, outputs: {}, capabilities: {} },
  run: async (inputs) => {
    aggSeen = inputs.results;
    return {};
  },
};

/** src(rows) → foreach.in ; foreach.item → body ; foreach.results → agg. */
function loopGraph(rows: unknown[], body = 'v-body', loop?: FlowNode['loop']): FlowGraph {
  return {
    nodes: [
      node('src', { blockVersionId: 'v-src', config: { rows } }),
      node('fe', { kind: 'foreach', blockVersionId: '', blockId: '', loop }),
      node('b1', { parentId: 'fe', blockVersionId: body }),
      node('agg', { blockVersionId: 'v-agg' }),
    ],
    edges: [
      { id: 'e1', source: 'src', sourceHandle: 'rows', target: 'fe', targetHandle: 'in' },
      { id: 'e2', source: 'fe', sourceHandle: 'item', target: 'b1', targetHandle: 'item' },
      { id: 'e3', source: 'fe', sourceHandle: 'results', target: 'agg', targetHandle: 'results' },
    ],
  };
}
const SRC_MAP = new Map([['v-src', '_'], ['v-body', '_'], ['v-agg', '_']]);

test('runs the body per row and collects results in order', async () => {
  aggSeen = undefined;
  const h = harness({ 'v-src': SRC, 'v-body': bodyBlock((n) => ({ doubled: n * 2 })), 'v-agg': AGG });
  const status = await executeFlow(loopGraph([{ n: 1 }, { n: 2 }, { n: 3 }]), SRC_MAP, 'r', '/tmp', h.deps, { maxNodeMs: 1000 });
  expect(status).toBe('ok');
  const start = h.events.find((e) => e.type === 'foreach_start');
  expect(start).toMatchObject({ nodeId: 'fe', total: 3 });
  expect(h.events.find((e) => e.type === 'foreach_complete')).toMatchObject({ iterations: 3, errors: 0 });
  expect(aggSeen).toEqual([{ out: { doubled: 2 } }, { out: { doubled: 4 } }, { out: { doubled: 6 } }]);
});

test('a failing row is skipped, the loop continues (partial)', async () => {
  aggSeen = undefined;
  const body = bodyBlock((n) => {
    if (n === 2) throw new Error('bad row');
    return { ok: n };
  });
  const h = harness({ 'v-src': SRC, 'v-body': body, 'v-agg': AGG });
  const status = await executeFlow(loopGraph([{ n: 1 }, { n: 2 }, { n: 3 }]), SRC_MAP, 'r', '/tmp', h.deps, { maxNodeMs: 1000 });
  expect(status).toBe('partial');
  expect(h.events.find((e) => e.type === 'foreach_complete')).toMatchObject({ iterations: 3, errors: 1 });
  expect(aggSeen).toEqual([{ out: { ok: 1 } }, { out: { ok: 3 } }]); // row 2 dropped
});

test('iteration cap is a soft bound: processes up to the cap and still succeeds', async () => {
  aggSeen = undefined;
  const h = harness({ 'v-src': SRC, 'v-body': bodyBlock((n) => ({ n })), 'v-agg': AGG });
  const rows = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }];
  const status = await executeFlow(loopGraph(rows, 'v-body', { maxIterations: 2 }), SRC_MAP, 'r', '/tmp', h.deps, {
    maxNodeMs: 1000,
    maxIterations: 100,
  });
  expect(status).toBe('ok');
  expect(h.events.find((e) => e.type === 'foreach_aborted')).toMatchObject({ reason: 'iteration_cap', iterations: 2 });
  expect((aggSeen as unknown[]).length).toBe(2);
});

test('event budget is fatal: aborts the foreach (node_error)', async () => {
  const h = harness({ 'v-src': SRC, 'v-body': bodyBlock((n) => ({ n })), 'v-agg': AGG });
  const status = await executeFlow(loopGraph([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]), SRC_MAP, 'r', '/tmp', h.deps, {
    maxNodeMs: 1000,
    maxForeachEvents: 2,
  });
  expect(status).toBe('partial'); // src ok + foreach failed → partial
  expect(h.events.find((e) => e.type === 'foreach_aborted')).toMatchObject({ reason: 'event_budget' });
  expect(h.events.find((e) => e.type === 'node_error' && e.nodeId === 'fe')).toBeDefined();
});

test('run wall-clock budget is fatal: aborts the foreach with a timeout', async () => {
  const h = harness({ 'v-src': SRC, 'v-body': bodyBlock((n) => ({ n })), 'v-agg': AGG });
  const rows = Array.from({ length: 20 }, (_, i) => ({ n: i }));
  const status = await executeFlow(loopGraph(rows), SRC_MAP, 'r', '/tmp', h.deps, {
    maxNodeMs: 1000,
    maxRunMs: 4, // the fake clock ticks per now() call → the deadline trips within a couple iterations
  });
  expect(status).toBe('partial'); // src ok + foreach failed → partial
  expect(h.events.find((e) => e.type === 'foreach_aborted')).toMatchObject({ reason: 'wall_clock' });
  const feErr = h.events.find((e) => e.type === 'node_error' && e.nodeId === 'fe');
  expect(feErr).toMatchObject({ kind: 'timeout' });
});

test('a non-array rowset → foreach validation error', async () => {
  const h = harness({ 'v-src': SRC, 'v-body': bodyBlock((n) => ({ n })), 'v-agg': AGG });
  const graph = loopGraph('not-an-array' as unknown as unknown[]);
  const status = await executeFlow(graph, SRC_MAP, 'r', '/tmp', h.deps, { maxNodeMs: 1000 });
  expect(status).toBe('partial'); // src ok + foreach validation error → partial
  expect(h.events.find((e) => e.type === 'node_error' && e.nodeId === 'fe')).toMatchObject({ kind: 'validation' });
});

test('flow-validate accepts foreach edges via the synthetic descriptor', async () => {
  const { validateGraphAgainstBlocks } = await import('../src/exec/flow-validate');
  const descriptors = new Map([
    ['v-src', SRC.descriptor],
    ['v-body', bodyBlock(() => ({})).descriptor],
    ['v-agg', AGG.descriptor],
  ]);
  const res = validateGraphAgainstBlocks(loopGraph([{ n: 1 }]), descriptors);
  expect(res.ok).toBe(true);
  expect(res.issues).toEqual([]);
});

test('existing non-foreach flows are unaffected (no foreach events emitted)', async () => {
  const h = harness({ 'v-a': { descriptor: { inputs: {}, outputs: { o: { type: 'string' } }, capabilities: {} }, run: async () => ({ o: 'x' }) } });
  const graph: FlowGraph = { nodes: [node('a', { blockVersionId: 'v-a' })], edges: [] };
  const status = await executeFlow(graph, new Map([['v-a', '_']]), 'r', '/tmp', h.deps, { maxNodeMs: 1000 });
  expect(status).toBe('ok');
  expect(h.events.some((e) => e.type.startsWith('foreach'))).toBe(false);
});
