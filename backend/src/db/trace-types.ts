// src/db/trace-types.ts
// Shared TS shapes for a flow run's trace. These cross the trust boundary: the
// untrusted runner (exec/) EMITS them as NDJSON, the trusted host (host/) parses
// + forwards them over SSE + persists the final array to flow_runs.trace, and the
// frontend reads them (1:1 copy in frontend/src/lib/types/trace.ts). Kept free of
// drizzle imports so the spawned runner can share it without pulling the DB layer.

export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';

/** Why a node_error happened — drives the console colour + the run's final status. */
export type ErrorKind =
  | 'timeout' // per-node AbortSignal or the outer wall-clock kill
  | 'validation' // inputs/outputs failed the descriptor field checks
  | 'block_throw' // the block's run() threw (incl. a stripped global like fetch)
  | 'network_blocked' // attempted network without the capability (reserved)
  | 'llm_capped' // the host broker refused the LLM call (cap/ceiling)
  | 'model_not_allowed' // the host broker refused the LLM call (model allowlist)
  | 'budget_exhausted' // the PROVIDER refused for lack of credit (welcome budget / account spent)
  | 'seat_required' // the host broker refused: this member holds no CommonPractice seat
  | 'flow_error' // graph-level failure (e.g. a cycle slipped past pre-flight)
  | 'internal'; // runner/host bug

// ---- the MACHINE FIELDS behind a block-run refusal (the `rule` + `detail` half of node_error,
//      block_test_results.error and SimulateOutcome.error) ----
//
// ⛔ THE DEFECT. Every string below used to travel as ENGLISH PROSE and nothing else, through
// `node_error.error` → `RunConsole.svelte` and through `block_test_results.error` →
// `BlockResultView.svelte`, both rendered raw in all EIGHT locales at the exact moment an author's
// block refuses to run. The server does not know, and must not know, who is reading. So the wire
// carries the RULE plus the machine tokens and the browser owns the words
// (`frontend/src/lib/i18n/block-test-error-label.ts`), exactly as `GraphIssueRule` already does for
// graph validation and `notifications.data` for the bell.
//
// ⛔ THE ENGLISH `message` STAYS, BYTE FOR BYTE, and here that is not merely a fallback:
//   1. `ai/mcp/tools.ts` returns these strings verbatim to an LLM (`run_block_test`,
//      `simulate_block`) — English is CORRECT for that reader and this module is not involved.
//   2. `BlockFixAssistant.svelte` puts the SAME string into an LLM PROMPT ("Fix with AI"). One
//      string, browser-facing and machine-facing, on the same screen.
//   3. `tests/descriptor.test.ts` and `tests/flow-executor.test.ts` pin nine of them.
//
// ⛔⛔ AND THE HARD PART: PRODUCT ENGLISH AND BLOCK-AUTHOR ENGLISH SHARE ONE FIELD.
// `flow-executor.ts` `classify()` funnels a block author's own `throw new Error('…')` into
// `node_error.error` alongside the runner's own refusals. `kind` cannot separate them —
// `block_throw` is the DEFAULT for any error carrying no kind, so it means "unclassified", not
// "authored by the block", and an author can `Object.assign(err, {kind:'validation'})` and
// impersonate a product refusal. THE DISCRIMINATOR IS THE PRESENCE OF `rule`, which is attached
// only by `productError()` — a factory in the executor's module scope that a transpiled block can
// never reach. So:
//     rule present + detail complete → the catalog sentence
//     rule present + detail INCOMPLETE → the English `message`   (archive replay / mid-roll)
//     rule ABSENT                     → the raw text             (author's words, and the
//                                                                 backend-first fallback)
// An author's sentence is therefore never localized BY CONSTRUCTION rather than by heuristic.

/**
 * Every product-authored refusal a block run can produce, as a stable snake_case token.
 *
 * ⚠️ ONE MEMBER PER SENTENCE, NOT ONE PER SITE — and NOT one generic `field_wrong_type` carrying
 * the type name as a parameter. A single "'{field}' must be {type}" pattern forces the translator
 * to interpolate a bare noun into a copula, which needs the instrumental in `pl` ("musi być
 * tekstem", not "musi być tekst") and a different construction again in `ar`/`he`. Spelling each
 * type as its own complete sentence is the only shape that inflects correctly in all eight, and it
 * is why `frontend/src/lib/i18n/field-type-label.ts` is deliberately NOT reused here: its own
 * header pins every value to ≤7 characters for an 8.5px canvas chip ("num", "lijst"), which reads
 * as broken prose inside a sentence.
 */
export type BlockErrorRule =
  // exec/descriptor.ts — per-field runtime validation (runs in the UNTRUSTED subprocess)
  | 'field_must_be_string'
  | 'field_must_be_number'
  | 'field_must_be_boolean'
  | 'field_must_be_string_array'
  | 'field_must_be_one_of'
  | 'field_required'
  | 'field_must_be_dataset'
  | 'field_unknown_type'
  | 'input_missing_required'
  | 'output_not_object'
  | 'output_missing_required'
  // exec/flow-executor.ts — the runner's own refusals
  | 'node_no_source'
  | 'node_inputs_invalid'
  | 'node_outputs_invalid'
  | 'node_timeout'
  | 'foreach_input_not_array'
  | 'run_wall_clock_exceeded'
  | 'foreach_event_budget_exceeded'
  | 'capability_missing_llm'
  | 'capability_missing_mock_data'
  | 'capability_missing_dataset'
  // exec/block-loader.ts — the saved module is not a block at all (UNTRUSTED subprocess)
  | 'block_no_default_export'
  | 'block_no_run_function'
  | 'block_no_descriptor'
  // exec/dataset-resolver.ts — the block asked for a dataset slug the host did not inject
  | 'dataset_not_available'
  | 'dataset_not_available_alternatives'
  // host/llm-broker.ts — the TRUSTED host refused the brokered LLM call.
  //
  // ⚠️ THESE ARE MINTED ON THE HOST, NOT IN THE RUNNER, and that is the whole point of the group.
  // The runner is handed only `{error, kind}` over the `llm_response` frame; it cannot know the cap
  // number or the model name, so a rule derived runner-side could only be produced by PARSING the
  // host's English — the exact thing this vocabulary exists to abolish. `llm-broker.ts` attaches
  // the rule where the parameters are still values, `run-controller.ts` forwards it on the frame,
  // and `flow-executor.ts`'s `ctx.llm` converts it into a refusal sentinel before it ever reaches
  // author code.
  | 'llm_daily_cap_reached'
  | 'llm_weekly_spend_reached'
  | 'llm_model_not_allowed'
  | 'llm_budget_exhausted'
  // The person has no CommonPractice seat. Its own rule rather than a cap: no amount of waiting or
  // spending less clears it — an administrator must give them a seat (`assertMemberSeat`).
  | 'llm_seat_required'
  | 'llm_host_closed'
  // Spend-posture refusals (services/byo-posture.ts): the call would run on the PLATFORM's credential
  // but only the tenant's own key may pay for a commercial model / a byo_required tenant's call.
  // Parameterless; the browser reuses the existing `error_llm_*` catalog sentences.
  | 'llm_platform_local_only'
  | 'llm_byo_key_required'
  // blocks/test-runner.ts — the block-test verdict wrapped around one of the above
  | 'test_expected_error_but_succeeded'
  | 'test_wrong_error_kind'
  | 'test_block_errored'
  | 'test_no_output'
  | 'test_output_not_json_object'
  | 'test_output_not_conformant'
  | 'test_output_mismatch';

/**
 * The identifier-only parameters a refusal carries so the BROWSER can write the sentence.
 *
 * Every field is optional because each rule supplies only what its own sentence names, and the
 * whole bag is optional because a runner one deploy behind — and EVERY archived `flow_runs.trace`
 * row, and every `block_test_results` row written before migration 0072 — ships none of it.
 *
 * ⛔ PLAIN JSON ONLY. `descriptor.ts` runs in the untrusted subprocess and this bag crosses the
 * NDJSON boundary on its way to the host; an `Error` object put here would serialise to `{}` and
 * take the sentence with it. Strings, string arrays, and `FieldIssue` records — nothing else.
 *
 * ⛔ `cause` IS RAW TEXT AND MUST NEVER BE TRANSLATED. It is the arbitrary message the product
 * English was CONCATENATED onto (`${error.kind}: ${error.error}`) — usually a block author's own
 * words. Splitting it out is what lets the product half localize while the author's half stays
 * exactly as they wrote it.
 */
export interface BlockErrorDetail {
  /** The input/output port a field check refused. An identifier, never prose. */
  field?: string;
  /** `field_must_be_one_of` — the permitted values, AS AN ARRAY. Joined client-side by
   *  `Intl.ListFormat`: "[a, b, c]" is an English list and cannot be composed on the server. */
  options?: string[];
  /** `ErrorKind` tokens, rendered through the shared `errorKindLabel` — not a second vocabulary. */
  expectedKind?: string;
  actualKind?: string;
  /** RAW. See the ⛔ above. */
  cause?: string;
  /** `test_output_not_conformant` / `node_*_invalid` — the per-field issues that were joined with
   *  `'; '` on the old wire. A joined string is unrecoverable; the label function RECURSES. */
  issues?: FieldIssue[];
  /** `node_no_source` — the block version id the runner was given no source for. */
  blockVersion?: string;
  /** `foreach_input_not_array` — the loop's rows port. */
  port?: string;
  /** `capability_missing_*` — the node's block slug. */
  slug?: string;
  /** `dataset_not_available*` — the dataset SLUG the block asked for. An identifier, never prose.
   *  Deliberately not folded into `slug`, which already means "the node's block slug": one sentence
   *  could name both, and a reader debugging a trace must be able to tell which is which. */
  dataset?: string;
  /** `llm_daily_cap_reached` / `llm_weekly_spend_reached` — the governance bound that was hit,
   *  ALREADY FORMATTED BY THE HOST (a call count, or a dollar amount with its sign). A string and
   *  not a number because the currency form is composed where the policy lives. */
  limit?: string;
  /** `llm_model_not_allowed` — the model id the governance allowlist refused. */
  model?: string;
}

/**
 * ONE field-validation refusal: the rule, its own English, and its own tokens.
 *
 * `message` is byte-identical to the corresponding entry in `FieldCheck.errors`, so a client that
 * cannot resolve `rule` has a per-issue fallback rather than an all-or-nothing one.
 */
export interface FieldIssue {
  rule: BlockErrorRule;
  message: string;
  detail?: BlockErrorDetail;
}

/** Token + cost accounting for a single node or a whole run. */
export interface CostDelta {
  usd: number;
  tokensIn: number;
  tokensOut: number;
  llmCalls: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// A discriminated union — the SSE writer stamps `id:` = seq and the frontend
// store switches on `type`. `outputPreview` is pre-truncated by the runner to a
// byte budget so a huge node output can't flood the stream.
export type TraceEvent =
  | { type: 'run_start'; runId: string; ts: number; nodeCount: number }
  | { type: 'node_start'; runId: string; ts: number; nodeId: string; slug: string }
  | {
      type: 'log';
      runId: string;
      ts: number;
      nodeId: string;
      level: LogLevel;
      msg: string;
      data?: unknown;
    }
  | {
      type: 'node_success';
      runId: string;
      ts: number;
      nodeId: string;
      slug: string;
      durationMs: number;
      cost: CostDelta;
      outputPreview: string;
    }
  | {
      type: 'node_error';
      runId: string;
      ts: number;
      nodeId: string;
      slug: string;
      durationMs: number;
      /**
       * ⛔ ENGLISH PROSE, AND NOT DELETABLE — for the three reasons in the block above
       * `BlockErrorRule`, and because `flow_runs.trace` is a jsonb ARCHIVE: every run recorded
       * before this change carries `error` and nothing else, so reopening a week-old run must not
       * show a blank failure line. It outlives the usual one-deploy window.
       */
      error: string;
      kind: ErrorKind;
      /**
       * The product rule behind `error`. ABSENT means the text is the BLOCK AUTHOR'S OWN — see the
       * discriminator note above. Also absent on an old runner and on every archived trace.
       */
      rule?: BlockErrorRule;
      /** Machine tokens for `rule`'s sentence. Absent for the same three reasons. */
      detail?: BlockErrorDetail;
    }
  | {
      type: 'node_skipped';
      runId: string;
      ts: number;
      nodeId: string;
      slug: string;
      /**
       * ⛔ ENGLISH PROSE, AND NOT DELETABLE. The console frame around it
       * (`console_trace_node_skipped`) has always been TRANSLATED, so this produced a half-Dutch
       * half-English line with a raw node id in it: "n3 overgeslagen (upstream node 'n3' did not
       * produce output)". `reasonCode` + `upstreamSlug` below are what the browser renders now.
       *
       * This field stays because it is BOTH the mid-roll fallback AND the only thing PERSISTED
       * runs have: `flow_runs.trace` is a jsonb archive, and every trace written before this
       * change carries `reason` and nothing else. Reopening a week-old run must not show a blank
       * skip line. It therefore outlives the usual one-deploy window — it can only go when the
       * retained trace history no longer contains a pre-change run.
       */
      reason: string;
      /** Machine code for `reason`. Absent on an old runner and on archived traces. */
      reasonCode?: 'upstream_no_output';
      /**
       * The BLOCK SLUG of the upstream node that produced nothing — not its node id.
       *
       * `reason` names the node id (`'n3'`), which is a graph-internal handle the builder never
       * shows: the canvas labels nodes by block slug, so an operator could not find `n3`. The slug
       * is available at both emit sites (`nodeById` is in scope) and is what the reader recognises.
       * ⚠️ It is NOT unique — a flow may use one block twice — so the node id stays in `reason`
       * and this is the display name, not an address.
       */
      upstreamSlug?: string;
    }
  // ---- Phase 5: bounded foreach loop lifecycle (the body runs per row) ----
  | { type: 'foreach_start'; runId: string; ts: number; nodeId: string; total: number; cap: number }
  | {
      type: 'foreach_complete';
      runId: string;
      ts: number;
      nodeId: string;
      /** Rows whose body ran (≤ cap). */
      iterations: number;
      /** Rows whose body errored and were skipped (skip-and-continue). */
      errors: number;
    }
  | {
      type: 'foreach_aborted';
      runId: string;
      ts: number;
      nodeId: string;
      reason: 'iteration_cap' | 'wall_clock' | 'event_budget';
      /** Rows whose body completed before the abort. */
      iterations: number;
    }
  | {
      type: 'run_complete';
      runId: string;
      ts: number;
      totalMs: number;
      status: RunStatus;
      totals: CostDelta;
    };

const TRACE_EVENT_TYPES = new Set([
  'run_start',
  'node_start',
  'log',
  'node_success',
  'node_error',
  'node_skipped',
  'foreach_start',
  'foreach_complete',
  'run_complete',
]);

function isCostDelta(v: unknown): v is CostDelta {
  const c = v as CostDelta | undefined;
  return (
    !!c &&
    typeof c === 'object' &&
    Number.isFinite(c.usd) &&
    Number.isFinite(c.tokensIn) &&
    Number.isFinite(c.tokensOut) &&
    Number.isFinite(c.llmCalls)
  );
}

/**
 * Is this parsed stdout line a trace event the host may TRUST?
 *
 * The runner subprocess writes protocol frames to fd 1 — and so does anything a block author's
 * code prints. A block that does `console.log(JSON.stringify(row))` on a row carrying a `type`
 * key therefore lands arbitrary data in the control channel. The host used to cast that straight
 * to `TraceEvent` and dereference `ev.cost.usd` / `ev.totals`, which meant a block could (by
 * accident) crash the event pump and have its own successful run reported as FAILED, poison the
 * run totals with NaN and leave the row stuck at `status: 'running'`, or (deliberately) declare
 * its own `run_complete` status and zero out its recorded spend.
 *
 * So: validate before trusting. The two frames the host reads NUMBERS out of are checked
 * structurally; the rest only need a known `type`. Anything else is dropped by the caller.
 */
export function isTraceEvent(v: unknown): v is TraceEvent {
  const ev = v as { type?: unknown; cost?: unknown; totals?: unknown; status?: unknown };
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return false;
  if (!TRACE_EVENT_TYPES.has(ev.type)) return false;
  if (ev.type === 'node_success') return isCostDelta(ev.cost);
  if (ev.type === 'run_complete') {
    return (
      isCostDelta(ev.totals) &&
      typeof ev.status === 'string' &&
      ['running', 'ok', 'partial', 'failed'].includes(ev.status)
    );
  }
  return true;
}

export function zeroCost(): CostDelta {
  return { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 };
}

export function addCost(a: CostDelta, b: CostDelta): CostDelta {
  return {
    usd: a.usd + b.usd,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    llmCalls: a.llmCalls + b.llmCalls,
  };
}

// ---- the host→runner / runner→host stdio control frames (NOT trace events) ----
// The runner's ctx.llm() has no provider key; it round-trips to the host broker
// over stdio. Requests are multiplexed onto the runner's STDOUT alongside the
// NDJSON trace (the host pump switches on `type`); responses come back on the
// runner's STDIN, interleaved with the one-shot init frame.

export interface LlmRequestPayload {
  /** Optional: absent means "the tenant's configured model" (host resolves it; see llm-broker.ts). */
  model?: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmResult {
  text: string;
  usage: { tokensIn: number; tokensOut: number };
  costUsd: number;
}

/** runner → host, on stdout. */
export interface LlmRequestFrame {
  type: 'llm_request';
  id: number;
  nodeId: string;
  payload: LlmRequestPayload;
}

/** host → runner, on stdin. */
export type LlmResponseFrame =
  | { type: 'llm_response'; id: number; ok: true; result: LlmResult }
  /**
   * ⛔ THE REJECTION ARM CARRIES ITS OWN `rule` + `detail`, MINTED ON THE HOST. `error` is the
   * host's English (`daily LLM call cap reached (200)`, the budget-exhausted paragraph) and it used
   * to be ALL that crossed: the runner wrapped it in a bare `Error`, `classify` took the default
   * arm, and the browser rendered governance copy raw in eight locales. The runner cannot re-derive
   * the rule from that prose without parsing it, so the host ships it.
   */
  | {
      type: 'llm_response';
      id: number;
      ok: false;
      error: string;
      kind: ErrorKind;
      rule?: BlockErrorRule;
      detail?: BlockErrorDetail;
    };

/** host → runner, on stdin: the one-shot first line delivering the work. */
export interface InitFrame {
  type: 'init';
  runId: string;
  graph: import('./flow-types').FlowGraph;
  /** blockVersionId → transpilable TS source (block_versions.source_ts). */
  sources: Record<string, string>;
  policy: {
    maxNodeMs: number;
    fullOutput?: boolean;
    // Phase 5: bounded foreach budgets.
    maxRunMs?: number;
    maxIterations?: number;
    maxForeachEvents?: number;
  };
  /** Resolved datasets referenced by the flow's dataset-typed inputs (Phase 2.0).
   *  slug → {columns, rows}; rows are already capped + PII-redacted at the host so
   *  the runner never reaches the DB and never sees raw PII. */
  datasets?: Record<string, import('./dataset-types').InjectedDataset>;
}
