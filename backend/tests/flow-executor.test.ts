// tests/flow-executor.test.ts — the execution heart, 100% in-process (no spawn,
// no DB). loadBlock/llm/emit are injected fakes; blocks are in-memory closures.
import { test, expect } from 'bun:test';
import { executeFlow, topoOrder, type ExecDeps } from '../src/exec/flow-executor';
import type { LoadedBlock } from '../src/exec/block-loader';
import type { FlowGraph, FlowNode } from '../src/db/flow-types';
import type { TraceEvent } from '../src/db/trace-types';
import type { LlmRequest, LlmResponse } from '../src/exec/sdk';

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

interface Harness {
  events: TraceEvent[];
  deps: ExecDeps;
}

function harness(
  blocks: Record<string, LoadedBlock>,
  llm?: (req: LlmRequest, nodeId: string) => Promise<LlmResponse>,
): Harness {
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
      llm: llm ?? (async () => ({ text: 'x', usage: { tokensIn: 0, tokensOut: 0 }, costUsd: 0 })),
      mockData: (kind) => ({ kind }),
      dataset: () => [],
      emit: (ev) => events.push(ev),
      now: () => clock++,
    },
  };
}

const POLICY = { maxNodeMs: 1000 };

test('topoOrder returns an order for a DAG and null for a cycle', () => {
  const dag: FlowGraph = {
    nodes: [node('a'), node('b')],
    edges: [{ id: 'e', source: 'a', sourceHandle: 'o', target: 'b', targetHandle: 'i' }],
  };
  expect(topoOrder(dag)).toEqual(['a', 'b']);
  const cyclic: FlowGraph = {
    nodes: [node('a'), node('b')],
    edges: [
      { id: 'e1', source: 'a', sourceHandle: 'o', target: 'b', targetHandle: 'i' },
      { id: 'e2', source: 'b', sourceHandle: 'o', target: 'a', targetHandle: 'i' },
    ],
  };
  expect(topoOrder(cyclic)).toBeNull();
});

test('happy path: chains output→input, edge value overrides config', async () => {
  const producer: LoadedBlock = {
    descriptor: { inputs: {}, outputs: { o: { type: 'string' } }, capabilities: {} },
    run: async () => ({ o: 'from-producer' }),
  };
  let seen: unknown;
  const consumer: LoadedBlock = {
    descriptor: {
      inputs: { i: { type: 'string', required: true } },
      outputs: { r: { type: 'string' } },
      capabilities: {},
    },
    run: async (inputs) => {
      seen = inputs.i;
      return { r: `got:${inputs.i}` };
    },
  };
  const graph: FlowGraph = {
    nodes: [
      node('p', { blockVersionId: 'v-p' }),
      // config sets i='literal' but the edge should win
      node('c', { blockVersionId: 'v-c', config: { i: 'literal' } }),
    ],
    edges: [{ id: 'e', source: 'p', sourceHandle: 'o', target: 'c', targetHandle: 'i' }],
  };
  const h = harness({ 'v-p': producer, 'v-c': consumer });
  const status = await executeFlow(graph, new Map([['v-p', '_'], ['v-c', '_']]), 'r1', '/tmp', h.deps, POLICY);
  expect(status).toBe('ok');
  expect(seen).toBe('from-producer'); // edge overrode config 'literal'
  const types = h.events.map((e) => e.type);
  expect(types).toContain('run_start');
  expect(types.filter((t) => t === 'node_success')).toHaveLength(2);
  expect(h.events.at(-1)).toMatchObject({ type: 'run_complete', status: 'ok' });
});

test('skip-on-error is transitive: a mid-chain throw skips all descendants', async () => {
  const ok: LoadedBlock = {
    descriptor: { inputs: {}, outputs: { o: { type: 'string' } }, capabilities: {} },
    run: async () => ({ o: 'ok' }),
  };
  const boom: LoadedBlock = {
    descriptor: { inputs: {}, outputs: { o: { type: 'string' } }, capabilities: {} },
    run: async () => {
      throw new Error('kaboom');
    },
  };
  const graph: FlowGraph = {
    nodes: [node('a', { blockVersionId: 'v-ok' }), node('b', { blockVersionId: 'v-boom' }), node('c', { blockVersionId: 'v-ok' })],
    edges: [
      { id: 'e1', source: 'a', sourceHandle: 'o', target: 'b', targetHandle: 'i' },
      { id: 'e2', source: 'b', sourceHandle: 'o', target: 'c', targetHandle: 'i' },
    ],
  };
  const h = harness({ 'v-ok': ok, 'v-boom': boom });
  const status = await executeFlow(graph, new Map([['v-ok', '_'], ['v-boom', '_']]), 'r1', '/tmp', h.deps, POLICY);
  expect(status).toBe('partial'); // a succeeded, b errored, c skipped
  const err = h.events.find((e) => e.type === 'node_error');
  expect(err).toMatchObject({ nodeId: 'b', kind: 'block_throw' });
  const skipped = h.events.find((e) => e.type === 'node_skipped');
  expect(skipped).toMatchObject({ nodeId: 'c' });
});

// ⛔ THE HALF-DUTCH LINE. `console_trace_node_skipped` has always been a TRANSLATED frame, and the
// `reason` interpolated into it was an English sentence naming a graph-internal NODE ID:
//     "join-rows overgeslagen (upstream node 'b' did not produce output)"
// The builder canvas labels nodes by BLOCK SLUG and never shows `b`, so the one identifier in the
// sentence was the one the reader could not look up. The event now carries a CODE plus the slug;
// the browser owns the words (RunConsole.skipReason).
//
// REVERT THAT TURNS THIS RED: drop `reasonCode`/`upstreamSlug` from either emit site in
// flow-executor.ts — the frontend then has nothing to switch on and prints the English again.
test('node_skipped carries a reason CODE and the upstream BLOCK SLUG, plus the legacy prose', async () => {
  const ok: LoadedBlock = {
    descriptor: { inputs: {}, outputs: { o: { type: 'string' } }, capabilities: {} },
    run: async () => ({ o: 'ok' }),
  };
  const boom: LoadedBlock = {
    descriptor: { inputs: {}, outputs: { o: { type: 'string' } }, capabilities: {} },
    run: async () => {
      throw new Error('kaboom');
    },
  };
  const graph: FlowGraph = {
    nodes: [
      node('a', { blockVersionId: 'v-boom', slug: 'triage-claim' }),
      node('b', { blockVersionId: 'v-ok', slug: 'join-rows' }),
    ],
    edges: [{ id: 'e1', source: 'a', sourceHandle: 'o', target: 'b', targetHandle: 'i' }],
  };
  const h = harness({ 'v-ok': ok, 'v-boom': boom });
  await executeFlow(graph, new Map([['v-ok', '_'], ['v-boom', '_']]), 'r1', '/tmp', h.deps, POLICY);

  const skipped = h.events.find((e) => e.type === 'node_skipped');
  expect(skipped, 'nothing was skipped — this test asserts nothing').toBeDefined();
  expect(skipped).toMatchObject({
    nodeId: 'b',
    slug: 'join-rows',
    reasonCode: 'upstream_no_output',
    // ⛔ THE SLUG, NOT THE NODE ID. Node 'a' runs block `triage-claim`; the two differ here on
    // purpose, so a mutation that ships `poisonedBy.source` as `upstreamSlug` reddens.
    upstreamSlug: 'triage-claim',
  });
  // ⛔ `reason` STAYS, byte-identical. It is the fallback for an old frontend mid-roll AND — more
  // durably — the only thing every trace already archived in `flow_runs.trace` carries.
  expect((skipped as { reason: string }).reason).toBe(
    "upstream node 'a' did not produce output",
  );
});

test('missing required input → node_error kind validation, run failed', async () => {
  const needsInput: LoadedBlock = {
    descriptor: { inputs: { i: { type: 'string', required: true } }, outputs: {}, capabilities: {} },
    run: async () => ({}),
  };
  const graph: FlowGraph = { nodes: [node('a', { blockVersionId: 'v-x' })], edges: [] };
  const h = harness({ 'v-x': needsInput });
  const status = await executeFlow(graph, new Map([['v-x', '_']]), 'r1', '/tmp', h.deps, POLICY);
  expect(status).toBe('failed');
  expect(h.events.find((e) => e.type === 'node_error')).toMatchObject({ kind: 'validation' });
});

test('llm cost accumulates; a capped llm rejection surfaces as node_error llm_capped', async () => {
  const aiBlock: LoadedBlock = {
    descriptor: { inputs: {}, outputs: { summary: { type: 'string' } }, capabilities: { llm: true } },
    run: async (_inputs, ctx) => {
      const res = await ctx.llm({ model: 'm', prompt: 'p' });
      return { summary: res.text };
    },
  };
  // success path: cost flows into node_success + run totals
  const okLlm = async (): Promise<LlmResponse> => ({
    text: 'a summary',
    usage: { tokensIn: 100, tokensOut: 50 },
    costUsd: 0.0021,
  });
  const graph: FlowGraph = { nodes: [node('a', { blockVersionId: 'v-ai' })], edges: [] };
  const h = harness({ 'v-ai': aiBlock }, okLlm);
  const status = await executeFlow(graph, new Map([['v-ai', '_']]), 'r1', '/tmp', h.deps, POLICY);
  expect(status).toBe('ok');
  const success = h.events.find((e) => e.type === 'node_success');
  expect(success).toMatchObject({ cost: { llmCalls: 1, tokensIn: 100, tokensOut: 50 } });
  const complete = h.events.at(-1);
  expect(complete).toMatchObject({ type: 'run_complete', totals: { llmCalls: 1 } });

  // capped path: the bridge rejects with kind llm_capped
  const cappedLlm = async (): Promise<LlmResponse> => {
    throw Object.assign(new Error('daily LLM cap exceeded'), { kind: 'llm_capped' });
  };
  const h2 = harness({ 'v-ai': aiBlock }, cappedLlm);
  const status2 = await executeFlow(graph, new Map([['v-ai', '_']]), 'r2', '/tmp', h2.deps, POLICY);
  expect(status2).toBe('failed');
  expect(h2.events.find((e) => e.type === 'node_error')).toMatchObject({ kind: 'llm_capped' });
});

test('a block that exceeds its node timeout → node_error kind timeout', async () => {
  const slow: LoadedBlock = {
    descriptor: { inputs: {}, outputs: {}, capabilities: {} },
    run: () => new Promise(() => {}), // never resolves
  };
  const graph: FlowGraph = { nodes: [node('a', { blockVersionId: 'v-slow' })], edges: [] };
  const h = harness({ 'v-slow': slow });
  const status = await executeFlow(graph, new Map([['v-slow', '_']]), 'r1', '/tmp', h.deps, {
    maxNodeMs: 30,
  });
  expect(status).toBe('failed');
  expect(h.events.find((e) => e.type === 'node_error')).toMatchObject({ kind: 'timeout' });
});

test('a block without the llm capability cannot call ctx.llm', async () => {
  const sneaky: LoadedBlock = {
    descriptor: { inputs: {}, outputs: {}, capabilities: {} },
    run: async (_i, ctx) => {
      await ctx.llm({ model: 'm', prompt: 'p' });
      return {};
    },
  };
  const graph: FlowGraph = { nodes: [node('a', { blockVersionId: 'v-s' })], edges: [] };
  const h = harness({ 'v-s': sneaky });
  const status = await executeFlow(graph, new Map([['v-s', '_']]), 'r1', '/tmp', h.deps, POLICY);
  expect(status).toBe('failed');
  expect(h.events.find((e) => e.type === 'node_error')?.error).toContain('llm capability');
});

// ---------------------------------------------------------------------------
// The ctx.dataset() gate after `mockData` and `dataset` were split into two bits.
//
// ⛔ WHY THREE CASES AND NOT ONE. `mockData` used to be the ONLY key that opened this gate, under
// the rationale "same trust class as mockData → reuse that capability". That overload is what forced
// `load-dataset` — one `ctx.dataset()` over the tenant's REAL uploaded rows — to declare a
// FABRICATION bit, which the "Simulated" badge then rendered back to the customer. Splitting the bit
// has exactly two ways to go wrong, and only running all three arms catches both:
//   • drop the old key  → every block already persisted in `block_versions` (whose descriptors are
//     JSON in a tenant's database, unreachable by any code change) breaks at run time;
//   • forget to add the new key → the whole split is inert and `load-dataset` still cannot run.
// The third arm is the non-vacuity check: with `if (true)` in place of the gate, arms 1 and 2 both
// still pass and only this one fails.
// ---------------------------------------------------------------------------

/** A block whose `run()` does nothing but read a dataset — the `load-dataset` shape. */
function datasetReader(capabilities: Record<string, boolean>): LoadedBlock {
  return {
    descriptor: {
      inputs: {},
      outputs: { count: { type: 'number' } },
      capabilities,
    },
    run: async (_i, ctx) => {
      const rows = await ctx.dataset('sample-claims');
      return { count: rows.length };
    },
  };
}

/** Run a one-node flow whose single block is `block`. */
async function runOne(block: LoadedBlock): Promise<{ status: string; events: TraceEvent[] }> {
  const graph: FlowGraph = { nodes: [node('a', { blockVersionId: 'v-d' })], edges: [] };
  const h = harness({ 'v-d': block });
  const status = await executeFlow(graph, new Map([['v-d', '_']]), 'r1', '/tmp', h.deps, POLICY);
  return { status, events: h.events };
}

test('BACK-COMPAT: a block declaring ONLY mockData may still call ctx.dataset', async () => {
  // ⛔ THE ARM THAT MUST NEVER BE DELETED. Every block authored before the split — including ones
  // living only as JSONB in a customer's `block_versions` rows — declares `mockData` and nothing
  // else. Tightening this gate to `if (!caps.dataset)` would break all of them at run time, in
  // production, for a change whose entire purpose was display copy.
  const { status, events } = await runOne(datasetReader({ mockData: true }));
  expect(status).toBe('ok');
  expect(events.find((e) => e.type === 'node_error')).toBeUndefined();
});

test('a block declaring ONLY dataset may call ctx.dataset', async () => {
  // The new, honest spelling: an access grant with no fabrication claim attached. This is what
  // `load-dataset` and every ontology-derived data block now declare.
  const { status, events } = await runOne(datasetReader({ dataset: true }));
  expect(status).toBe('ok');
  expect(events.find((e) => e.type === 'node_error')).toBeUndefined();
});

test('a block declaring NEITHER bit is still refused ctx.dataset', async () => {
  const { status, events } = await runOne(datasetReader({}));
  expect(status).toBe('failed');
  const err = events.find((e) => e.type === 'node_error');
  // ⛔ THE RULE IS THE STABLE HALF, and it is unchanged by the split on purpose: it is the key the
  // browser's catalogue looks the localized sentence up by, so renaming it would drop seven locales
  // back to raw English. The message text is the developer-facing fallback and is allowed to move.
  expect(err).toMatchObject({ rule: 'capability_missing_dataset', kind: 'block_throw' });
  // It must name the NEW bit — a message that still says only "mockData" would send the next author
  // straight back into the overload this split exists to remove.
  expect(err?.error).toContain('dataset');
});
