// src/db/block-types.ts
// Shared TS shapes for the block descriptor (typed I/O + capabilities + limits)
// and examples, persisted as JSONB on `block_versions`. These mirror SPEC §5's
// SDK contract; the frontend has a 1:1 copy in lib/types/blocks.ts. Kept as a
// standalone module (no drizzle imports) so both runtimes can share it.

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'json'
  | 'string[]'
  | 'enum'
  // A reference to a developer-loaded dataset (Phase 2.0). The node-config value is
  // the dataset's slug (a string); the host resolves it to {columns, rows} and
  // injects the rows, which the block reads via ctx.dataset(slug).
  | 'dataset';

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  /** Allowed values when type === 'enum'. */
  enum?: string[];
  /** Marks a field as carrying PII — gated to mock-data sources at run time. */
  pii?: boolean;
  description?: string;
  /**
   * Default node-config value for this input when the flow node sets none. v1 use:
   * a `dataset`-typed input whose default is a slug — the host injects that dataset
   * even without explicit node config (Phase 3 derived data blocks bind their source
   * sample this way; a developer can still override it via the node config panel).
   */
  default?: string;
  /**
   * Display label for this port, in the author's words ("Always use OCR" for `force_ocr`). The key
   * stays the wire identifier. Localized labels live in content_translations (blocks/port-labels.ts)
   * and win over this for the reader's locale; GET /api/blocks/:slug serves the resolved result.
   */
  label?: string;
}

/**
 * What a block is permitted to reach through `ctx`.
 *
 * ⛔ `mockData` AND `dataset` ARE TWO BITS BECAUSE THEY MEAN TWO THINGS, and collapsing them shipped
 * a false claim to a customer. `ctx.dataset()` used to be gated on `mockData` under the rationale
 * "same trust class as mockData (test/sample data) → reuse that capability". The trust argument was
 * fine; the OVERLOAD was not, because `mockData` had meanwhile become USER-VISIBLE COPY — the
 * "Simulated" badge on the catalogue card, the build palette, the canvas node and the run output all
 * render from it. So `load-dataset`, whose `run()` is one `ctx.dataset(inputs.source)` over the
 * TENANT'S OWN UPLOADED ROWS, declared `mockData: true` purely to pass the gate and was therefore
 * about to be badged "Simulated" — telling a customer their real data is fake, on the first node of
 * most demo flows. One flag cannot be both a fabrication claim and an access grant.
 *
 * The split is by WHAT THE READER IS BEING TOLD, not by how the runner is wired:
 *   • `mockData` is a CLAIM ABOUT THE OUTPUT — "a run of this returns invented sample data". It is
 *     rendered as prose to a non-technical reader, so anything derived from it must be true of the
 *     output, not merely true of the plumbing.
 *   • `dataset` is an ACCESS GRANT — "this block may read the tenant's REAL datasets". It says
 *     nothing about whether the output is real, and must NEVER drive user-visible honesty copy.
 * A block that genuinely does both (fabricates for one output, reads a real dataset for another)
 * declares both; that is the honest description of such a block.
 */
export interface BlockCapabilities {
  /** Outbound HTTP. Default false — stripped in the runner unless true. */
  network?: boolean;
  /** Brokered LLM access via ctx.llm(). */
  llm?: boolean;
  /**
   * ctx.mockData() access (sandboxed, invented sample data).
   * ⚠️ A FABRICATION BIT, AND USER-VISIBLE. True ⇒ the block's output is sample data, and every
   * surface says so. Do NOT set it merely to obtain dataset access — use `dataset` for that.
   */
  mockData?: boolean;
  /**
   * ctx.dataset() access — may read the tenant's REAL datasets by slug.
   * ⚠️ NOT A FABRICATION BIT. This is an access grant and must never be rendered as honesty copy;
   * the rows it returns are the tenant's own. `flow-executor.ts` still accepts `mockData` alone for
   * the same gate, so every block written before the split keeps working.
   */
  dataset?: boolean;
}

export interface BlockLimits {
  timeoutMs?: number;
  memMb?: number;
}

export interface BlockDescriptor {
  /** Maps to input ports in the Build canvas. */
  inputs: Record<string, FieldSpec>;
  /** Maps to output ports. */
  outputs: Record<string, FieldSpec>;
  capabilities: BlockCapabilities;
  limits?: BlockLimits;
}

export interface BlockExample {
  name: string;
  inputs: Record<string, unknown>;
  expectedOutputs?: Record<string, unknown>;
}

// ---- Per-block tests (Phase 2-B) ----
// A `block_test` is a runnable, dataset-backed test case for a block — distinct
// from `examples` (docs). The suite is scoped to the BLOCK (persists across
// versions); a result is recorded per (version, test) so the publish gate checks
// the specific version's source. `inputs` is the node config (dataset-typed
// values are slugs); `datasets` lists extra ctx.dataset(slug) fixtures not wired
// as an input. The runner executes the block as a 1-node graph; the outcome is
// compared to `expected` per `assertMode` (exact = deep-equal, subset = every
// expected key/value present in actual), unless `expectError` is set.

export const ASSERT_MODES = ['exact', 'subset'] as const;
export type AssertMode = (typeof ASSERT_MODES)[number];

export const BLOCK_TEST_STATUSES = ['pass', 'fail', 'error'] as const;
export type BlockTestStatus = (typeof BLOCK_TEST_STATUSES)[number];

export interface BlockTestSpec {
  name: string;
  description?: string;
  /** Node config: values for the block's declared inputs (dataset-typed = slug). */
  inputs: Record<string, unknown>;
  /** Extra ctx.dataset(slug) fixtures not referenced by a dataset-typed input. */
  datasets: string[];
  /** Expected outputs object (ignored when expectError). */
  expected?: Record<string, unknown> | null;
  assertMode: AssertMode;
  expectError: boolean;
  /** Optional required error kind when expectError (timeout|validation|block_throw|…). */
  expectedErrorKind?: string | null;
  enabled: boolean;
}

export const BLOCK_CATEGORIES = ['data', 'ai', 'logic', 'output', 'ui'] as const;
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

export const BLOCK_STATUSES = [
  'draft',
  'beta',
  'stable',
  'deprecated',
] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

export const BLOCK_LANGUAGES = ['typescript'] as const;
export type BlockLanguage = (typeof BLOCK_LANGUAGES)[number];

export function emptyDescriptor(): BlockDescriptor {
  return { inputs: {}, outputs: {}, capabilities: { network: false } };
}
