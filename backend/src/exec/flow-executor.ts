// src/exec/flow-executor.ts — the execution heart (SPEC §5). Kahn topological
// order over {nodes, edges}; per node: gather inputs from incoming edges merged
// with the node's literal config, validate, run under a per-node timeout, emit
// trace events, and skip the transitive descendants of any failed node. v1 is
// sequential (parallel fan-out is a later optimisation).
//
// All side effects are injected via ExecDeps so this is 100% unit-testable
// WITHOUT spawning a subprocess: in prod `emit` writes NDJSON to stdout and `llm`
// is the stdio bridge to the host broker; in tests they're a push + a fake.
import type { FlowGraph, FlowNode } from '../db/flow-types';
import type { LlmRequest, LlmResponse, BlockContext } from './sdk';
import { BlockModuleError, type LoadedBlock } from './block-loader';
import { DatasetUnavailableError } from './dataset-resolver';
import { validateInputs, validateOutputs } from './descriptor';
import {
  type TraceEvent,
  type RunStatus,
  type ErrorKind,
  type CostDelta,
  type LogLevel,
  type BlockErrorRule,
  type BlockErrorDetail,
  zeroCost,
  addCost,
} from '../db/trace-types';

export interface ExecDeps {
  loadBlock(blockVersionId: string, source: string, scratchDir: string): Promise<LoadedBlock>;
  /** Brokered LLM. In prod this rounds-trips to the host; may reject with an
   *  Error carrying `.kind` (e.g. 'llm_capped'). */
  llm(req: LlmRequest, nodeId: string): Promise<LlmResponse>;
  mockData(kind: string, opts?: Record<string, unknown>): unknown | Promise<unknown>;
  /** Resolve a dataset's injected rows by slug (Phase 2.0). The runner builds this
   *  from the init frame's `datasets`; tests pass a fake. */
  dataset(slug: string, nodeId: string): Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
  emit(ev: TraceEvent): void;
  now(): number;
}

export interface ExecPolicy {
  /** Org-level wall-clock cap per node (ms); a block's own lower limit wins. */
  maxNodeMs: number;
  /** Block-test mode (Phase 2-B): emit the FULL node output (not the 2KB preview)
   *  so the host test runner can assert against complete outputs. Never set for a
   *  real user run — it would let a huge output flood the trace. */
  fullOutput?: boolean;
  // ---- Phase 5: bounded foreach loops ----
  /** Run-level wall-clock budget (ms). A foreach checks it between iterations and aborts gracefully
   *  before the host SIGKILL. Undefined → no executor-side run deadline (host kill still applies). */
  maxRunMs?: number;
  /** Hard cap on iterations any single foreach may run (default 1000). */
  maxIterations?: number;
  /** Cap on trace events a single foreach may emit before it aborts (default 5000). */
  maxForeachEvents?: number;
}

const PREVIEW_BUDGET = 2048; // bytes — keep a huge output from flooding the stream.


/** Kahn topological order, or null if the graph has a cycle. */
export function topoOrder(graph: FlowGraph): string[] | null {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  // Deterministic order: seed the queue in declared node order.
  const queue = graph.nodes.map((n) => n.id).filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id)!) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  return order.length === ids.size ? order : null;
}

function truncatePreview(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = '[unserialisable output]';
  }
  return s.length > PREVIEW_BUDGET ? `${s.slice(0, PREVIEW_BUDGET)}…` : s;
}

/** Block-test mode: the complete, untruncated JSON output for host-side assertion. */
function fullOutput(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable output]';
  }
}

/**
 * A refusal the PRODUCT authored, as opposed to one a block author threw.
 *
 * ⛔⛔ THE DISCRIMINATOR IS OBJECT IDENTITY IN A MODULE-PRIVATE `WeakSet`, AND THAT IS A FIX, NOT A
 * STYLE CHOICE. `classify()` funnels everything into `node_error.error`: a block author's own
 * `throw new Error('…')`, a timeout, and the refusals this executor writes itself. `kind` cannot
 * separate them — `block_throw` is the DEFAULT arm below, so it means "unclassified", not "authored
 * by the block". The browser therefore renders the catalog sentence iff `rule` is present, and a
 * `rule` an author can attach is a PHISHING PRIMITIVE IN THE PRODUCT'S OWN VOICE: their text, in
 * the reader's language, in the product's quotes, on /build's run console.
 *
 * This used to be a class (`err instanceof ProductError`). The class check was sound; ITS
 * REACHABILITY WAS NOT. `buildContext` reads `caps` from the block's OWN descriptor, so a block
 * that declares no capabilities and calls `ctx.llm()` was HANDED a live `ProductError` — and from
 * there `e.constructor` IS the class. Both attacks were measured against real transpiled blocks:
 *
 *   ATTACK1  catch it, `e.rule = 'field_must_be_string'`, `e.detail = {field: <phishing>}`, rethrow
 *            → rendered `[nl] "⁨Sessie verlopen — voer uw wachtwoord opnieuw in⁩" moet tekst zijn.`
 *   ATTACK2  `const PE = e.constructor; throw new PE('node_inputs_invalid', …)` → a forged nested
 *            `issues` bag, rendered as our own field-validation prose.
 *
 * So what crosses into author code is an OPAQUE, FROZEN sentinel and the rule lives beside it:
 *
 *   • `REFUSALS` — a module-private `WeakSet`. Membership is granted ONLY inside `productError`,
 *     which always mints a fresh `Error` of its own. An author cannot enumerate a WeakSet, cannot
 *     obtain a reference to it (nothing here is exported), and cannot get an object of theirs into
 *     it. `e.constructor` is the global `Error`; `constructor.constructor` is `Function`; walking
 *     `Object.getPrototypeOf` reaches `Error.prototype`; `globalThis` holds neither. Even importing
 *     this module at runtime yields nothing: `productError`, `REFUSALS` and `REFUSAL_FIELDS` are
 *     module-private, and the two exported carrier classes (`BlockModuleError`,
 *     `DatasetUnavailableError`) are converted here, at call sites author code cannot reach, so a
 *     hand-made one thrown from `run()` is just another author throw.
 *   • `REFUSAL_FIELDS` — a module-private `WeakMap` holding the rule/kind/message/detail. NONE of
 *     it is an own property of the thrown object, so mutating the object cannot change what is
 *     reported, and `Object.freeze` means the mutation does not even land: `e.rule = …` and
 *     `Object.assign(e, …)` both throw `TypeError` in the block's (always strict, always ESM)
 *     module scope, and the TypeError is then the author's own unruled error.
 *
 * ⚠️ A PRISTINE RETHROW STILL CARRIES THE RULE, AND THAT IS CORRECT. A capability refusal is thrown
 * INTO author code, so an author may catch and rethrow the same frozen object. What the reader then
 * sees is OUR sentence about THEIR block ("block 'x' lacks the llm capability") — our words, not
 * theirs, with a server-supplied `detail.slug`. Nothing of the author's can reach the catalog that
 * way. WRAPPING it (`throw new Error(e.message)`) loses the rule and renders raw, which is also
 * correct: at that point the sentence belongs to the author.
 */
interface ProductRefusal {
  rule: BlockErrorRule;
  message: string;
  kind: ErrorKind;
  detail?: BlockErrorDetail;
}

const REFUSALS = new WeakSet<object>();
const REFUSAL_FIELDS = new WeakMap<object, ProductRefusal>();

/**
 * Mint a product refusal: an opaque frozen sentinel, with the rule and tokens held OUT OF BAND.
 *
 * ⛔ THE ONLY WAY AN ERROR MAY BE BORN IN THIS FILE, and the only way an object may enter
 * `REFUSALS`. `block-test-error-label.backend-contract.test.ts` asserts that no product sentence is
 * born anywhere in this file outside a sanctioned factory, so a refusal written the obvious way
 * reds CI and names the literal instead of shipping as untranslatable English into seven locales.
 *
 * ⚠️ THE SENTINEL KEEPS THE ENGLISH AS ITS `message`. The author is a developer debugging their own
 * block — `catch (e) { console.log(e.message) }` must say something — and English is the right
 * language for that reader for the same reason `mcp/tools.ts` ships English to an LLM. It is safe
 * to expose because it is frozen: the author can READ our sentence, and can relay it (their choice,
 * rendered raw), but cannot alter one byte of what we report.
 */
function productError(
  rule: BlockErrorRule,
  message: string,
  kind: ErrorKind,
  detail?: BlockErrorDetail,
): Error {
  const sentinel = new Error(message);
  REFUSAL_FIELDS.set(sentinel, detail ? { rule, message, kind, detail } : { rule, message, kind });
  REFUSALS.add(sentinel);
  // ⛔ FROZEN, AND THE FREEZE IS LOAD-BEARING. Without it ATTACK1's mutation silently succeeds on a
  // property nothing reads, which is harmless — but `e.message` would then be the author's, and
  // `message` IS reported. Freezing makes every write throw at the author's own hand instead.
  return Object.freeze(sentinel);
}

/**
 * A foreach's own refusal: the rule, its English and its tokens, for the `ok: false` arm.
 *
 * ⛔ A SECOND SANCTIONED FACTORY, because a foreach refuses by RETURNING rather than throwing and
 * therefore cannot go through `productError`. It is sanctioned in the same sense: the guard in
 * `block-test-error-label.backend-contract.test.ts` accepts a product sentence born INSIDE one of
 * the named factories and nowhere else, so the two spellings are covered by one rule rather than
 * the guard quietly not looking at half the file.
 */
function foreachRefusal(
  rule: BlockErrorRule,
  message: string,
  kind: ErrorKind,
  detail?: BlockErrorDetail,
): {
  ok: false;
  hadErrors: true;
  kind: ErrorKind;
  rule: BlockErrorRule;
  message: string;
  detail?: BlockErrorDetail;
} {
  return detail
    ? { ok: false, hadErrors: true, kind, rule, message, detail }
    : { ok: false, hadErrors: true, kind, rule, message };
}

/**
 * The `node_skipped` pair: the machine code and the English it stands for, born together.
 *
 * ⛔ `reason` STAYS, BYTE-IDENTICAL — it is the fallback for an old frontend mid-roll AND for every
 * trace already archived in `flow_runs.trace` (see trace-types.ts). `reasonCode` is what the
 * browser actually renders; the node id inside `reason` is a graph handle the canvas never shows,
 * which is why `upstreamSlug` travels too. Minting the two in one call is what makes the pairing
 * structural: writing the sentence without its code is not a thing this file can express.
 */
function skipReason(
  reasonCode: 'upstream_no_output',
  upstreamNodeId: string,
  upstreamSlug: string | undefined,
): { reason: string; reasonCode: 'upstream_no_output'; upstreamSlug: string | undefined } {
  return {
    reason: `upstream node '${upstreamNodeId}' did not produce output`,
    reasonCode,
    upstreamSlug,
  };
}

/** The refusal a sentinel stands for, or `undefined` for anything not minted above. */
function refusalOf(err: unknown): ProductRefusal | undefined {
  // `WeakSet.has` answers `false` for a primitive rather than throwing, but the explicit test keeps
  // the intent readable: only an object can ever have been minted.
  if (typeof err !== 'object' || err === null) return undefined;
  return REFUSALS.has(err) ? REFUSAL_FIELDS.get(err) : undefined;
}

/**
 * The nine `ErrorKind` members, as a runtime set.
 *
 * ⛔ `kind` IS A SECOND INJECTION CHANNEL AND NEEDS NO CAPABILITY TRICK. `classify`'s default arm
 * copied ANY string `err.kind` onto the wire, and the browser's `errorKindLabel` rendered an
 * unrecognised kind RAW AND UN-ISOLATED as product chrome. Measured:
 *   `throw Object.assign(new Error('x'), {kind: 'WAARSCHUWING: uw account wordt geblokkeerd'})`
 *   → `[nl] "Het blok faalde met WAARSCHUWING: uw account wordt geblokkeerd: ⁨x⁩"`
 * …and it was PERSISTED into `block_test_results.error_detail.actualKind`. An author's prose wearing
 * an enum's clothes is not an enum. Anything outside this set is `block_throw` — which is precisely
 * what the default arm means: unclassified.
 *
 * ⚠️ THE ALLOWLIST IS DUPLICATED IN `blocks/test-runner.ts`, DELIBERATELY. That file re-reads
 * `error.kind` off an already-emitted event to build `detail.expectedKind`/`actualKind`, and one of
 * its two sources is `block_tests.expected_error_kind`, a user-writable DB column that never passes
 * through here at all. Two entry points, two checks; `tests/error-kind-allowlist.test.ts` asserts
 * they name the same nine.
 */
const ERROR_KINDS: ReadonlySet<string> = new Set<ErrorKind>([
  'timeout',
  'validation',
  'block_throw',
  'network_blocked',
  'llm_capped',
  'model_not_allowed',
  'budget_exhausted',
  // The broker refused: this member holds no CommonPractice seat (`host/llm-broker.ts`
  // `assertMemberSeat`). Allowlisted here like every other host refusal — an unrecognised kind is
  // DROPPED, so omitting it would silently degrade a seat refusal to the raw English sentence.
  'seat_required',
  'flow_error',
  'internal',
]);

function classify(err: unknown): {
  kind: ErrorKind;
  message: string;
  rule?: BlockErrorRule;
  detail?: BlockErrorDetail;
} {
  const minted = refusalOf(err);
  if (minted)
    return { kind: minted.kind, message: minted.message, rule: minted.rule, detail: minted.detail };
  const anyErr = err as { kind?: unknown; message?: unknown };
  const message = typeof anyErr?.message === 'string' ? anyErr.message : String(err);
  // ⛔ ALLOWLISTED, NOT COPIED. See ERROR_KINDS.
  const kind: ErrorKind =
    typeof anyErr?.kind === 'string' && ERROR_KINDS.has(anyErr.kind)
      ? (anyErr.kind as ErrorKind)
      : 'block_throw';
  // ⛔ NO `rule` HERE, EVER. This arm is reached only by an error this module did not mint, so
  // `message` is the block author's own words — see the sentinel's header.
  return { kind, message };
}

/**
 * The `rule`/`detail` half of a node_error, or NOTHING AT ALL.
 *
 * ⛔ SPREAD, NOT `rule: r.rule`. `node_error` is JSON.stringify'd onto the NDJSON stream and
 * persisted into `flow_runs.trace`; writing `rule: undefined` explicitly puts no key on the wire
 * but DOES put `"rule": null` in the jsonb column once the host round-trips it through a
 * serializer that preserves nulls. The browser's discriminator is "is `rule` absent", and `null`
 * is absent enough for `!err.rule` — but `detail: null` is NOT absent enough for a `d && …` guard
 * written by the next person. Emitting neither key is the shape that cannot be misread.
 */
function ruleOf(r: {
  rule?: BlockErrorRule;
  detail?: BlockErrorDetail;
}): { rule?: BlockErrorRule; detail?: BlockErrorDetail } {
  if (!r.rule) return {};
  return r.detail ? { rule: r.rule, detail: r.detail } : { rule: r.rule };
}

/** The outcome of running ONE block node (root or foreach body). Emission of node_success/error is
 *  the caller's job so a foreach can budget body events; node_start is emitted here (only once the
 *  block actually loads + its inputs validate, matching the original ordering). */
interface NodeRunResult {
  ok: boolean;
  output?: Record<string, unknown>;
  cost: CostDelta;
  durationMs: number;
  kind?: ErrorKind;
  message?: string;
  /** Present ⇔ the refusal was PRODUCT-authored. See the refusal sentinel above. */
  rule?: BlockErrorRule;
  detail?: BlockErrorDetail;
}

async function runBlockNode(
  node: FlowNode,
  inputs: Record<string, unknown>,
  runId: string,
  sources: Map<string, string>,
  scratchDir: string,
  deps: ExecDeps,
  policy: ExecPolicy,
): Promise<NodeRunResult> {
  const t0 = deps.now();
  try {
    const source = sources.get(node.blockVersionId);
    if (source === undefined) {
      throw productError(
        'node_no_source',
        `no source for block version ${node.blockVersionId}`,
        'internal',
        { blockVersion: node.blockVersionId },
      );
    }
    // ⛔ CONVERTED HERE, AT A CALL SITE AUTHOR CODE CANNOT REACH. `loadBlock` runs before the block
    // has a `ctx` — its three "this module is not a block" refusals are product sentences that land
    // in the run console, so they carry a rule; but the carrier class is exported and therefore
    // forgeable, so the ONLY place it becomes a real refusal is right here. Anything else it throws
    // (a `SyntaxError` from the author's own source, an import failure) is deliberately left
    // unruled: those words are the engine's report on the author's code, not a product sentence.
    let block: LoadedBlock;
    try {
      block = await deps.loadBlock(node.blockVersionId, source, scratchDir);
    } catch (err) {
      throw err instanceof BlockModuleError
        ? productError(err.rule, err.message, 'internal', err.detail)
        : err;
    }
    const inCheck = validateInputs(inputs, block.descriptor);
    if (!inCheck.ok) {
      // ⛔ THE JOIN IS UNRECOVERABLE ON THE WIRE, so the ISSUES ride along beside it. `'; '` glues
      // N English sentences into one string with no seam a client can take apart; `detail.issues`
      // keeps each `{rule, message, detail}` intact and the browser's label function recurses.
      throw productError('node_inputs_invalid', inCheck.errors.join('; '), 'validation', {
        issues: inCheck.issues,
      });
    }
    const { ctx, getCost } = buildContext(node, block, runId, policy, deps);
    deps.emit({ type: 'node_start', runId, ts: t0, nodeId: node.id, slug: node.slug });
    const output = await runWithTimeout(block, inputs, ctx, ctxTimeout(block, policy));
    const outCheck = validateOutputs(output, block.descriptor);
    if (!outCheck.ok) {
      throw productError('node_outputs_invalid', outCheck.errors.join('; '), 'validation', {
        issues: outCheck.issues,
      });
    }
    return { ok: true, output, cost: getCost(), durationMs: deps.now() - t0 };
  } catch (err) {
    const { kind, message, rule, detail } = classify(err);
    return { ok: false, cost: zeroCost(), durationMs: deps.now() - t0, kind, message, rule, detail };
  }
}

export async function executeFlow(
  graph: FlowGraph,
  sources: Map<string, string>,
  runId: string,
  scratchDir: string,
  deps: ExecDeps,
  policy: ExecPolicy,
): Promise<RunStatus> {
  const order = topoOrder(graph);
  if (order === null) {
    deps.emit({
      type: 'run_complete',
      runId,
      ts: deps.now(),
      totalMs: 0,
      status: 'failed',
      totals: zeroCost(),
    });
    return 'failed';
  }

  deps.emit({ type: 'run_start', runId, ts: deps.now(), nodeCount: graph.nodes.length });

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, FlowGraph['edges']>();
  for (const e of graph.edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }

  // Phase 5: body nodes (parentId) are NOT run at the root — their foreach runs them per row.
  // Their relative order within the global topo is a valid order of the body sub-DAG (its internal
  // edges were honoured), so we reuse it verbatim.
  const bodyNodeIds = new Set<string>();
  const bodyOrderByForeach = new Map<string, string[]>();
  for (const id of order) {
    const n = nodeById.get(id)!;
    if (n.parentId) {
      bodyNodeIds.add(id);
      const arr = bodyOrderByForeach.get(n.parentId) ?? [];
      arr.push(id);
      bodyOrderByForeach.set(n.parentId, arr);
    }
  }

  const nodeOutputs = new Map<string, Record<string, unknown>>();
  const failed = new Set<string>(); // errored OR skipped — poisons descendants
  let anySuccess = false;
  let anyError = false;
  let totals = zeroCost();
  const runStart = deps.now();

  for (const nodeId of order) {
    if (bodyNodeIds.has(nodeId)) continue; // run inside its foreach, not at the root
    const node = nodeById.get(nodeId)!;
    const edges = incoming.get(nodeId) ?? [];

    // Skip if any upstream producer failed/was skipped (transitive via topo order).
    const poisonedBy = edges.find((e) => failed.has(e.source));
    if (poisonedBy) {
      failed.add(nodeId);
      deps.emit({
        type: 'node_skipped',
        runId,
        ts: deps.now(),
        nodeId,
        slug: node.slug,
        ...skipReason(
          'upstream_no_output',
          poisonedBy.source,
          // The reader's name for the upstream node. `nodeById` is already built above, so the
          // slug costs nothing here.
          nodeById.get(poisonedBy.source)?.slug,
        ),
      });
      continue;
    }

    // Gather inputs: literal config first, then wired edges override per port.
    const inputs: Record<string, unknown> = { ...node.config };
    for (const e of edges) {
      inputs[e.targetHandle] = nodeOutputs.get(e.source)?.[e.sourceHandle];
    }

    if (node.kind === 'foreach') {
      const r = await executeForeach(
        node,
        inputs,
        bodyOrderByForeach.get(nodeId) ?? [],
        nodeById,
        incoming,
        runId,
        sources,
        scratchDir,
        deps,
        policy,
        runStart,
      );
      totals = addCost(totals, r.cost);
      if (r.ok) {
        nodeOutputs.set(nodeId, r.output!);
        anySuccess = true;
        if (r.hadErrors) anyError = true;
        deps.emit({
          type: 'node_success',
          runId,
          ts: deps.now(),
          nodeId,
          slug: node.slug,
          durationMs: r.durationMs,
          cost: r.cost,
          outputPreview: truncatePreview(r.output),
        });
      } else {
        anyError = true;
        failed.add(nodeId);
        deps.emit({
          type: 'node_error',
          runId,
          ts: deps.now(),
          nodeId,
          slug: node.slug,
          durationMs: r.durationMs,
          error: r.message,
          kind: r.kind,
          ...ruleOf(r),
        });
      }
      continue;
    }

    const r = await runBlockNode(node, inputs, runId, sources, scratchDir, deps, policy);
    if (r.ok) {
      nodeOutputs.set(nodeId, r.output!);
      anySuccess = true;
      totals = addCost(totals, r.cost);
      deps.emit({
        type: 'node_success',
        runId,
        ts: deps.now(),
        nodeId,
        slug: node.slug,
        durationMs: r.durationMs,
        cost: r.cost,
        outputPreview: policy.fullOutput ? fullOutput(r.output) : truncatePreview(r.output),
      });
    } else {
      anyError = true;
      failed.add(nodeId);
      deps.emit({
        type: 'node_error',
        runId,
        ts: deps.now(),
        nodeId,
        slug: node.slug,
        durationMs: r.durationMs,
        error: r.message ?? 'error',
        kind: r.kind ?? 'block_throw',
        ...ruleOf(r),
      });
    }
  }

  const status: RunStatus = anyError ? (anySuccess ? 'partial' : 'failed') : 'ok';
  deps.emit({
    type: 'run_complete',
    runId,
    ts: deps.now(),
    totalMs: deps.now() - runStart,
    status,
    totals,
  });
  return status;
}

// ---- Phase 5: bounded foreach execution ----

/**
 * ⛔ A DISCRIMINATED UNION, NOT ONE INTERFACE WITH OPTIONALS, AND THAT IS WHAT DELETED THE LAST
 * UNRULED SENTENCE ON THIS PATH. `rule`/`message` used to be optional on both arms, so the emit
 * site had to write `error: r.message ?? 'foreach failed'` — a bare product English literal, born
 * outside any factory, that no guard was looking at. A foreach refuses ONLY for its own two
 * reasons, both of which have a rule; making the type say so removes the fallback rather than
 * translating it.
 */
type ForeachResult =
  | {
      ok: true;
      output: Record<string, unknown>;
      cost: CostDelta;
      durationMs: number;
      /** A row's body errored (skip-and-continue) → the run is `partial`, not failed. */
      hadErrors: boolean;
    }
  | {
      ok: false;
      cost: CostDelta;
      durationMs: number;
      hadErrors: true;
      kind: ErrorKind;
      /** Present on EVERY failure arm — a foreach only ever refuses for product reasons. */
      rule: BlockErrorRule;
      message: string;
      detail?: BlockErrorDetail;
    };

/** The body sub-DAG's sink output for one iteration: the single sink's output, or {slug: output}
 *  when the body fans out to several sinks. */
function collectSinks(
  sinkIds: string[],
  iterOut: Map<string, Record<string, unknown>>,
  nodeById: Map<string, FlowNode>,
): unknown {
  if (sinkIds.length === 1) return iterOut.get(sinkIds[0]!) ?? {};
  const out: Record<string, unknown> = {};
  for (const id of sinkIds) out[nodeById.get(id)?.slug ?? id] = iterOut.get(id) ?? {};
  return out;
}

/**
 * Run a foreach container: iterate its `rows` input, run the body sub-DAG once per row exposing the
 * current row as the foreach node's `item`/`index` output, collect each iteration's sink output into
 * `results`, and stop on the iteration cap / run wall-clock / event budget. A failed body row is
 * skipped (counted), the loop continues; a wall-clock or event-budget abort fails the foreach.
 */
async function executeForeach(
  fe: FlowNode,
  feInputs: Record<string, unknown>,
  bodyOrder: string[],
  nodeById: Map<string, FlowNode>,
  incoming: Map<string, FlowGraph['edges']>,
  runId: string,
  sources: Map<string, string>,
  scratchDir: string,
  deps: ExecDeps,
  policy: ExecPolicy,
  runStart: number,
): Promise<ForeachResult> {
  const t0 = deps.now();
  const rowsPort = fe.loop?.rowsInput ?? 'in';
  const rows = feInputs[rowsPort];
  if (!Array.isArray(rows)) {
    return {
      ...foreachRefusal(
        'foreach_input_not_array',
        `foreach input '${rowsPort}' must be an array`,
        'validation',
        { port: rowsPort },
      ),
      cost: zeroCost(),
      durationMs: deps.now() - t0,
    };
  }

  const capPolicy = policy.maxIterations ?? 1000;
  const cap = Math.min(fe.loop?.maxIterations ?? capPolicy, capPolicy);
  const eventBudget = policy.maxForeachEvents ?? 5000;
  const deadline = policy.maxRunMs ? runStart + policy.maxRunMs : Number.POSITIVE_INFINITY;

  // Body sink(s): body nodes that don't feed another body node.
  const bodySet = new Set(bodyOrder);
  const feedsBody = new Set<string>();
  for (const bid of bodyOrder) {
    for (const e of incoming.get(bid) ?? []) if (bodySet.has(e.source)) feedsBody.add(e.source);
  }
  const sinkIds = bodyOrder.filter((id) => !feedsBody.has(id));

  deps.emit({ type: 'foreach_start', runId, ts: deps.now(), nodeId: fe.id, total: rows.length, cap });

  const results: unknown[] = [];
  let cost = zeroCost();
  let iterErrors = 0;
  let processed = 0;
  let events = 0;
  let aborted: 'iteration_cap' | 'wall_clock' | 'event_budget' | null = null;
  // Budgeted emit for body events — returns false once the foreach's event budget is spent.
  const bEmit = (ev: TraceEvent): boolean => {
    if (events >= eventBudget) return false;
    events++;
    deps.emit(ev);
    return true;
  };

  for (let idx = 0; idx < rows.length; idx++) {
    if (processed >= cap) {
      aborted = 'iteration_cap';
      break;
    }
    if (deps.now() > deadline) {
      aborted = 'wall_clock';
      break;
    }

    const iterOut = new Map<string, Record<string, unknown>>();
    iterOut.set(fe.id, { item: rows[idx], index: idx }); // the current row, for body edges off `item`
    const iterFailed = new Set<string>();
    let budgetHit = false;

    for (const bid of bodyOrder) {
      const bnode = nodeById.get(bid)!;
      const bedges = incoming.get(bid) ?? [];
      const poisoned = bedges.find((e) => iterFailed.has(e.source));
      if (poisoned) {
        iterFailed.add(bid);
        if (
          !bEmit({
            type: 'node_skipped',
            runId,
            ts: deps.now(),
            nodeId: bid,
            slug: bnode.slug,
            // ⚠️ Inside a foreach body the upstream may be the FOREACH NODE ITSELF (the `item`
            // edge), which is in `nodeById` and has a slug like any other node.
            ...skipReason('upstream_no_output', poisoned.source, nodeById.get(poisoned.source)?.slug),
          })
        ) {
          budgetHit = true;
          break;
        }
        continue;
      }
      const inputs: Record<string, unknown> = { ...bnode.config };
      for (const e of bedges) inputs[e.targetHandle] = iterOut.get(e.source)?.[e.sourceHandle];

      const r = await runBlockNode(bnode, inputs, runId, sources, scratchDir, deps, policy);
      cost = addCost(cost, r.cost);
      if (r.ok) {
        iterOut.set(bid, r.output!);
        if (
          !bEmit({
            type: 'node_success',
            runId,
            ts: deps.now(),
            nodeId: bid,
            slug: bnode.slug,
            durationMs: r.durationMs,
            cost: r.cost,
            outputPreview: policy.fullOutput ? fullOutput(r.output) : truncatePreview(r.output),
          })
        ) {
          budgetHit = true;
          break;
        }
      } else {
        iterFailed.add(bid);
        if (
          !bEmit({
            type: 'node_error',
            runId,
            ts: deps.now(),
            nodeId: bid,
            slug: bnode.slug,
            durationMs: r.durationMs,
            error: r.message ?? 'error',
            kind: r.kind ?? 'block_throw',
            ...ruleOf(r),
          })
        ) {
          budgetHit = true;
          break;
        }
      }
    }

    if (budgetHit) {
      aborted = 'event_budget';
      break;
    }

    if (iterFailed.size > 0) {
      iterErrors++; // skip-and-continue: this row is recorded as an error, not collected
    } else {
      results.push(collectSinks(sinkIds, iterOut, nodeById));
    }
    processed++;
  }

  if (aborted) {
    deps.emit({ type: 'foreach_aborted', runId, ts: deps.now(), nodeId: fe.id, reason: aborted, iterations: processed });
  }
  deps.emit({ type: 'foreach_complete', runId, ts: deps.now(), nodeId: fe.id, iterations: processed, errors: iterErrors });

  // A wall-clock / event-budget abort is fatal for the foreach; the iteration cap is a soft bound
  // (the foreach succeeds with the rows it did process).
  if (aborted === 'wall_clock' || aborted === 'event_budget') {
    // ⚠️ HOISTED OUT OF THE THREE TERNARIES ON PURPOSE. It reads better, and it keeps the `rule:`
    // expression free of any quoted literal that is NOT a rule — `block-test-error-label.backend-
    // contract.test.ts` scrapes `rule:` assignments and asserts every literal it finds is a union
    // member, and `aborted === 'wall_clock'` sitting on that line put `'wall_clock'` into the set.
    const wall = aborted === 'wall_clock';
    return {
      ...(wall
        ? foreachRefusal('run_wall_clock_exceeded', 'run wall-clock budget exceeded', 'timeout')
        : foreachRefusal(
            'foreach_event_budget_exceeded',
            'foreach event budget exceeded',
            'flow_error',
          )),
      cost,
      durationMs: deps.now() - t0,
    };
  }
  return {
    ok: true,
    output: { results, count: results.length, errors: iterErrors },
    cost,
    durationMs: deps.now() - t0,
    hadErrors: iterErrors > 0,
  };
}

function ctxTimeout(block: LoadedBlock, policy: ExecPolicy): number {
  const blockMs = block.descriptor.limits?.timeoutMs;
  return Math.min(blockMs ?? policy.maxNodeMs, policy.maxNodeMs);
}

/**
 * Re-mint a host LLM refusal as a sentinel, keeping the host's rule when it sent one.
 *
 * ⚠️ THE CARRIER IS UNTRUSTED-SHAPED ON PURPOSE and this function does not care: it reads `rule`
 * off an object that only ever comes from `runner-entry.ts`'s stdin reader. An author CAN forge the
 * same shape and throw it from `run()` — and gains nothing, because `classify` never looks at these
 * properties. It looks only at whether THIS function (or `productError` directly) minted the
 * object, which is why the forgery ends up as an ordinary unruled author throw.
 *
 * A rejection with no rule (an older host mid-roll, or a transport failure) keeps the host's
 * English and stays unruled — the same backend-first fallback the browser already renders.
 */
function hostRefusal(err: unknown): unknown {
  const c = err as { kind?: unknown; message?: unknown; rule?: unknown; detail?: unknown };
  if (typeof c?.rule !== 'string' || typeof c.message !== 'string') return err;
  const kind: ErrorKind =
    typeof c.kind === 'string' && ERROR_KINDS.has(c.kind) ? (c.kind as ErrorKind) : 'internal';
  return productError(
    c.rule as BlockErrorRule,
    c.message,
    kind,
    (c.detail as BlockErrorDetail | undefined) ?? undefined,
  );
}

/** Build the per-node ctx + a cost accessor. ctx is the ONLY capability surface;
 *  llm/mockData are gated on the block's declared capabilities. */
function buildContext(
  node: FlowNode,
  block: LoadedBlock,
  runId: string,
  _policy: ExecPolicy,
  deps: ExecDeps,
): { ctx: BlockContext; getCost: () => CostDelta } {
  const caps = block.descriptor.capabilities ?? {};
  let cost = zeroCost();
  const ac = new AbortController();

  const ctx: BlockContext = {
    signal: ac.signal,
    log(level: LogLevel, msg: string, data?: unknown) {
      deps.emit({ type: 'log', runId, ts: deps.now(), nodeId: node.id, level, msg, data });
    },
    async llm(req: LlmRequest): Promise<LlmResponse> {
      if (!caps.llm) {
        throw productError(
          'capability_missing_llm',
          `block '${node.slug}' lacks the llm capability`,
          'block_throw',
          { slug: node.slug },
        );
      }
      // ⛔ THE HOST'S REFUSAL IS RE-MINTED BEFORE IT REACHES THE AUTHOR. `deps.llm` rejects with an
      // INERT carrier (`runner-entry.ts` hangs `{kind, rule, detail}` off a plain Error) precisely
      // so that no product-refusal object is ever handed across the trust boundary. The rule itself
      // was minted on the trusted host, where `dailyLlmCap` and `model` were still values —
      // see `BlockErrorRule`'s `host/` group.
      let res: LlmResponse;
      try {
        res = await deps.llm(req, node.id);
      } catch (err) {
        throw hostRefusal(err);
      }
      cost = addCost(cost, {
        usd: res.costUsd,
        tokensIn: res.usage.tokensIn,
        tokensOut: res.usage.tokensOut,
        llmCalls: 1,
      });
      return res;
    },
    async mockData(kind: string, opts?: Record<string, unknown>) {
      if (!caps.mockData) {
        throw productError(
          'capability_missing_mock_data',
          `block '${node.slug}' lacks the mockData capability`,
          'block_throw',
          { slug: node.slug },
        );
      }
      return await deps.mockData(kind, opts);
    },
    async dataset(slug: string) {
      // ⛔ TWO BITS OPEN THIS GATE, AND THAT IS THE FIX — not a widening. `mockData` and `dataset`
      // are now DISTINCT capabilities because they make distinct statements, and only one of them is
      // about the reader: `mockData` is a FABRICATION CLAIM that the product renders as user-visible
      // copy (the "Simulated" badge on the card, the palette, the canvas node and the run output),
      // while `dataset` is an ACCESS GRANT to the tenant's REAL uploaded rows and says nothing about
      // whether the output is invented. They used to be one flag ("same trust class as mockData →
      // reuse that capability"), which forced `load-dataset` — one `ctx.dataset()` over the
      // customer's own data — to declare `mockData` purely to get through here, and the badge then
      // told that customer their real data was simulated.
      //
      // ⛔ `mockData` STILL OPENS IT, PERMANENTLY. Every block written before the split declares only
      // `mockData`, and their descriptors are JSON already persisted in `block_versions` — dropping
      // the old bit here would break each one at run time, in a tenant's database, for a change whose
      // whole purpose was display copy.
      //
      // ⛔ AND THE BACK-COMPAT CLAIM STOPS AT THIS GATE. THE SENTENCE HERE USED TO READ "additive by
      // construction: nothing that ran yesterday stops", WHICH WAS FALSE AS WRITTEN and contradicted
      // `host/run-policy.ts`'s `data.pii_scrubbing` branch, which says in as many words that such a
      // flow "is now refused". Both cannot be true; run-policy's is the true one. What is preserved
      // is narrower, and it is exactly this:
      //
      //   PRESERVED — `ctx.dataset()` ACCESS. A block holding only `mockData` still opens this gate,
      //   forever, whether its descriptor came from the column or from its own baked source. No
      //   block loses the ability to read a dataset. That is what the `|| caps.dataset` above buys.
      //
      //   NOT PRESERVED — THE PII RUN-GATE. `mockData` is read by a SECOND consumer that has nothing
      //   to do with this file: run-policy treats `capabilities.mockData === true` on the PRODUCER as
      //   the entire test for `data.pii_scrubbing`. Migration `0077` DELETES `mockData` from the
      //   persisted descriptor of every repaired block, and run-policy reads that same column (via
      //   `host/publication-service.ts` → `resolveExecutableBlocks`). So a flow that (a) runs with
      //   `data.pii_scrubbing` ON and (b) feeds a repaired block into an input whose FieldSpec has
      //   `pii: true` ran yesterday and is refused today with `policy_pii_violation`.
      //
      // That is retroactive and it is INTENDED — see the argued decision in run-policy.ts. It is also
      // latent as of 0077 (no seeded descriptor marks an input `pii`), which is why it can only be
      // found by reading, and therefore why it is written here instead of being discovered by a
      // tenant. `capability_missing_dataset` below is NOT the error such a flow gets; it never
      // reaches the executor at all.
      if (!caps.mockData && !caps.dataset) {
        throw productError(
          'capability_missing_dataset',
          // ⚠️ THE RULE IS UNCHANGED, ONLY THE ENGLISH. `capability_missing_dataset` is the key the
          // browser's catalogue looks its localized sentence up by (i18n/block-test-error-label.ts,
          // plus a `blockerr_capability_missing_dataset` entry in all 8 message catalogues, all of
          // which were corrected in the same change); renaming it would drop seven locales back to
          // raw English. This message is only the developer-facing fallback, and it now names the
          // `dataset` bit — saying "mockData" here is what taught authors the overload in the first
          // place. It keeps the one-line, single-literal shape the rest of this file uses so the
          // sanctioned-factory scan in block-test-error-label.backend-contract.test.ts still reads it.
          `block '${node.slug}' lacks the dataset capability (needed for ctx.dataset; the legacy mockData capability also opens this gate)`,
          'block_throw',
          { slug: node.slug },
        );
      }
      // Same conversion contract as `loadBlock` above: `DatasetUnavailableError` is an inert
      // carrier, and this is the one site that turns it into a refusal.
      try {
        return await deps.dataset(slug, node.id);
      } catch (err) {
        throw err instanceof DatasetUnavailableError
          ? productError(err.rule, err.message, 'validation', err.detail)
          : err;
      }
    },
  };
  // expose abort for the timeout racer
  (ctx as unknown as { __ac: AbortController }).__ac = ac;
  return { ctx, getCost: () => cost };
}

/** Race the block's run() against a wall-clock timeout. The block keeps its own
 *  ctx.signal (fired on timeout) for cooperative abort; the race is the backstop
 *  so an uncooperative block can't stall the run. */
async function runWithTimeout(
  block: LoadedBlock,
  inputs: Record<string, unknown>,
  ctx: BlockContext,
  ms: number,
): Promise<Record<string, unknown>> {
  const ac = (ctx as unknown as { __ac: AbortController }).__ac;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(productError('node_timeout', 'node exceeded its time budget', 'timeout'));
    }, ms);
  });
  try {
    return await Promise.race([block.run(inputs, ctx), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
