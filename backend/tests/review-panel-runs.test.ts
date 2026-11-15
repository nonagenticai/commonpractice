// tests/review-panel-runs.test.ts — the seeded `review-panel` block must actually RUN.
//
// ⛔ THE DEFECT. `db/seed.ts` shipped `review-panel` with `capabilities: { network: false }` — in
// BOTH copies of its descriptor, the object and the one baked into its `source` string — while its
// `run()` body is a single `await ctx.mockData("review_decision", { item: inputs.item })`.
// `exec/flow-executor.ts`'s `buildContext` gates that call on `if (!caps.mockData) throw
// productError('capability_missing_mock_data', …)`, reading the descriptor of the LOADED MODULE.
// So the first line of the block's body raised on every run, on every database, since it was
// seeded. `category: 'output'` makes it a terminal node, so the containing flow could not finish
// either.
//
// ⛔ WHY NOTHING NOTICED, AND WHY THAT IS THE INTERESTING PART. The repo had ROUTED AROUND it:
// `db/seed-marketplace.ts` carried "review-panel is deliberately excluded because its descriptor
// omits the mockData capability its code uses" above `LISA_FLOW_SLUGS` — a correct diagnosis of a
// defect, written down as a design constraint — so the one flow the suite actually executes
// (`tests/runs.test.ts`, over `LISA_NODES`) never touched it, while `SOLUTIONS` in the same file
// and in `seed-tenant-showcase.ts` kept advertising the slug in a solution's `blocksUsed`. A grep
// for "review-panel" found five hits and not one of them ran the block.
//
// ⛔ WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It runs the REAL seed source
// through the REAL `loadBlock` (Bun.Transpiler + dynamic import, i.e. the module the runner
// subprocess would import) and the REAL `executeFlow`, with `exec/mock-data.ts`'s REAL `mockData`
// as the dep. It asserts the node REACHES `node_success` with a decision drawn from the block's own
// declared enum. It is NOT a string assertion on `db/seed.ts` — a prior session was made to replace
// exactly that shape, because a grep for `mockData: true` passes over a descriptor whose baked copy
// still says otherwise, and the baked copy is the one the executor reads.
//
// NEGATIVE CONTROL, by name and measured: revert either half of the seed literal — the
// `capabilities` line in the `descriptor` OBJECT or the one inside the `source` template — and
// re-run. Reverting the SOURCE copy reds "⛔ the seeded review-panel source resolves through the
// real executor" with `capability_missing_mock_data`; reverting the OBJECT copy reds "⛔ both
// copies of the review-panel descriptor agree that it fabricates", which is the guard against a
// half-fix that runs green while the "Simulated" badge keeps saying the decision is real.
//
// ⚠️ NO DATABASE. `getSeedBlock` reads the literal `BLOCKS` array in-process, so this file is
// unaffected by which rows a shared test database happens to hold — and by whether
// `migrations/0078_review_panel_mock_data.sql` has been applied to it. 0078 is proved separately,
// against a scratch database holding the OLD row, in
// tests/migration-0078-review-panel-mock-data.test.ts. The two halves repair disjoint populations
// (fresh databases vs. existing ones) and neither test substitutes for the other.
import { test, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeFlow, type ExecDeps } from '../src/exec/flow-executor';
import { loadBlock } from '../src/exec/block-loader';
import { mockData } from '../src/exec/mock-data';
import { getSeedBlock } from '../src/db/seed';
import type { FlowGraph } from '../src/db/flow-types';
import type { TraceEvent } from '../src/db/trace-types';
import type { BlockDescriptor } from '../src/db/block-types';

const NODE_ID = 'rp1';
const VERSION_ID = '00000000-0000-4000-8000-000000780001';
const RUN_ID = '00000000-0000-4000-8000-000000780002';

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cp-review-panel-'));
  scratchDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const d of scratchDirs) await rm(d, { recursive: true, force: true });
});

/**
 * The block's descriptor as the EXECUTOR sees it: transpiled out of the stored source, not read
 * off the seed object. `buildContext`'s capability gate consults exactly this.
 */
async function moduleDescriptor(): Promise<BlockDescriptor> {
  const { source } = getSeedBlock('review-panel');
  const mod = await loadBlock(VERSION_ID, source, await scratch());
  return mod.descriptor;
}

/** One node, no edges: `item` is supplied by config, which is how a terminal review node is used. */
function graph(): FlowGraph {
  return {
    nodes: [
      {
        id: NODE_ID,
        blockId: 'b-review-panel',
        blockVersionId: VERSION_ID,
        slug: 'review-panel',
        label: 'Review panel',
        category: getSeedBlock('review-panel').category,
        config: { item: { claim: 'CLM-2001', amount: 240 } },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
}

/** The real loader, the real mockData. `llm`/`dataset` throw: this block must need neither. */
function deps(events: TraceEvent[]): ExecDeps {
  let clock = 0;
  return {
    loadBlock,
    llm: async () => {
      throw new Error('review-panel must not call ctx.llm');
    },
    mockData: (kind, opts) => mockData(kind, opts ?? {}),
    dataset: () => {
      throw new Error('review-panel must not call ctx.dataset');
    },
    emit: (ev) => events.push(ev),
    now: () => clock++,
  };
}

async function runSeededReviewPanel(): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  const sources = new Map([[VERSION_ID, getSeedBlock('review-panel').source]]);
  await executeFlow(graph(), sources, RUN_ID, await scratch(), deps(events), { maxNodeMs: 5000 });
  return events;
}

test('⛔ the seeded review-panel source resolves through the real executor', async () => {
  const events = await runSeededReviewPanel();

  // ⛔ THE ASSERTION THAT NAMES THE DEFECT. Before the fix this arm carried
  // `error_code: 'capability_missing_mock_data'`; the message below is what a reader gets when it
  // comes back.
  const errors = events.filter((e) => e.type === 'node_error');
  expect(
    errors,
    errors.length
      ? `review-panel errored instead of resolving: ${JSON.stringify(errors)}. If the code is ` +
          `'capability_missing_mock_data', the descriptor baked into db/seed.ts's \`source\` ` +
          `template is missing \`mockData: true\` — the executor reads THAT copy, not the ` +
          `descriptor object beside it.`
      : undefined,
  ).toEqual([]);

  const success = events.filter((e) => e.type === 'node_success');
  expect(success).toHaveLength(1);

  // NON-VACUITY: a run that emitted `run_complete` with status 'failed' and no nodes would satisfy
  // "no node_error" trivially.
  const complete = events.find((e) => e.type === 'run_complete');
  expect(complete && 'status' in complete ? complete.status : undefined).toBe('ok');
}, 30_000);

test('⛔ review-panel returns a decision from its own declared enum', async () => {
  const events = await runSeededReviewPanel();
  const success = events.find((e) => e.type === 'node_success');
  expect(success).toBeDefined();

  // The block's contract, read from the module the executor imported — not restated here, so a
  // descriptor that narrowed its enum reddens this rather than passing against a stale copy.
  const desc = await moduleDescriptor();
  const declared = (desc.outputs?.decision as { enum?: string[] } | undefined)?.enum;
  expect(declared, 'review-panel must declare its decision enum').toEqual([
    'accept',
    'edit',
    'reject',
  ]);

  // `node_success.output` is a preview string (flow-executor truncates it); the decision has to be
  // visible in it, which is what /build's run console shows the user.
  const output = success && 'outputPreview' in success ? String(success.outputPreview) : '';
  expect(output.length, 'a node_success carrying no output would make the next line vacuous')
    .toBeGreaterThan(0);
  expect(declared!.some((k) => output.includes(k))).toBe(true);
}, 30_000);

test('⛔ both copies of the review-panel descriptor agree that it fabricates', async () => {
  // The SEED OBJECT copy — the one `upsertGlobalBlock` writes into `block_versions.descriptor`, and
  // therefore the one `routes/blocks.ts` projects as `mock_data` for the "Simulated" badge and
  // `host/run-policy.ts` reads as the whole `data.pii_scrubbing` taint test.
  const seeded = getSeedBlock('review-panel').descriptor;
  expect(seeded.capabilities?.mockData).toBe(true);

  // The MODULE copy — the one the executor gates on. These two disagreeing is exactly how this
  // block shipped broken with a descriptor that looked fine in a code review of one of them.
  const fromModule = await moduleDescriptor();
  expect(fromModule.capabilities?.mockData).toBe(true);
  expect(fromModule.capabilities?.network).toBe(seeded.capabilities?.network);
}, 30_000);
