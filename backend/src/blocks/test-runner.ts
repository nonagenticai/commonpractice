// src/blocks/test-runner.ts — Phase 2-B per-block test execution (TRUSTED host).
// A block test runs the block as a single-node graph through the SAME runner
// subprocess a production flow uses (run-controller.runEphemeral) — same transpile,
// capability gating, timeouts — so a green test reflects what ships. The block's
// declared dataset-typed inputs + the test's extra `datasets` are resolved to rows
// via loadInjectedDatasets, honouring the SAME `data.pii_scrubbing` governance switch
// the run-injection path does (getSnapshot().piiScrubbing) — the developer authoring
// the test may be looking at their own tenant's raw rows either way, but both
// runBlockTests and simulateBlockVersion back MCP tools (`run_block_test`,
// `simulate_block`) whose JSON result is pushed straight into the agent's message
// list and shipped to the tenant's configured EXTERNAL LLM on the next turn
// (ai/agent.ts). "the author's own data" does not survive that destination, so this
// redacts exactly like a production run does, not exactly like a human preview does.
// NOTE: this does NOT run enforceRunPolicies's `data.pii_scrubbing` mock-source check
// — see the comment on runOneBlockTest/simulateBlockVersion for why that rule does not
// transplant to this single-node authoring context.
// The outcome is derived from the run's trace:
//   * expectError → pass iff the node errored (and the kind matches when pinned).
//   * else → require node_success, then (1) descriptor output-conformance, then
//            (2) compare actual vs expected per assertMode. Conformance is checked
//            even when `expected` matches — a wrong-shaped return is always a fail.
// Results are upserted per (version, test); block_versions.tests_passing is the
// recomputed rollup (true only when ≥1 enabled test exists and all pass).
import { and, eq, inArray } from 'drizzle-orm';
import {
  db as defaultDb,
  buildingBlocks,
  blockVersions,
  blockTests,
  blockTestResults,
  runAsSystem,
} from '../db/client';
import type { BlockTest, BuildingBlock, BlockVersion } from '../db/schema';
import type { BlockTestStatus, BlockDescriptor, BlockExample } from '../db/block-types';
import type { FlowGraph } from '../db/flow-types';
import type {
  TraceEvent,
  ErrorKind,
  CostDelta,
  LogLevel,
  BlockErrorRule,
  BlockErrorDetail,
  FieldIssue,
} from '../db/trace-types';
import { zeroCost } from '../db/trace-types';
import { validateOutputs } from '../exec/descriptor';
import { loadInjectedDatasets } from '../datasets/dataset-service';
import { homeTenantOf } from '../middleware/tenant';
import { runEphemeral } from '../host/run-controller';
import { getSnapshot } from '../host/policy-store';
import { assertBlockSourceSafe } from './source-gate';
import { compareOutputs, type Difference } from './deep-compare';

type Db = typeof defaultDb;

export interface BlockTestOutcome {
  testId: string;
  name: string;
  status: BlockTestStatus; // pass | fail | error
  actual: Record<string, unknown> | null;
  /**
   * ⛔ ENGLISH PROSE, AND NOT DELETABLE. `run_block_test` (ai/mcp/tools.ts) returns this verbatim
   * to an LLM, where English is the CORRECT output; `BlockFixAssistant.svelte` puts the same string
   * into an LLM prompt for "Fix with AI"; and every `block_test_results` row written before
   * migration 0072 has this and nothing else, forever, with no backfill possible.
   */
  error: string | null;
  /**
   * The product rule behind `error`, for the BROWSER to write its own sentence
   * (`frontend/src/lib/i18n/block-test-error-label.ts`). ABSENT means the text was not composed
   * here — it is a block author's own throw, or an infrastructure error caught below — and must be
   * rendered raw. Persisted to `block_test_results.error_rule` (0072); without that the localized
   * sentence would appear live and REVERT TO ENGLISH ON REFRESH.
   */
  errorRule?: BlockErrorRule;
  errorDetail?: BlockErrorDetail;
  diffs: Difference[];
  durationMs: number;
}

/**
 * The ONE place a block-test verdict's English is born — rule, message and tokens together.
 *
 * ⛔ NO LITERAL MAY BE ASSIGNED STRAIGHT TO `error:` IN THIS FILE. That is what
 * `block-test-error-label.backend-contract.test.ts` enforces, so a ninth verdict added here cannot
 * ship as untranslatable English by accident. The catch-all at the bottom of `runOneBlockTest` is
 * the deliberate exception: it forwards `err.message`, which is NOT a literal and NOT product
 * English — an infrastructure failure's own text, correctly rendered raw.
 */
function testError(
  rule: BlockErrorRule,
  message: string,
  detail?: BlockErrorDetail,
): { error: string; errorRule: BlockErrorRule; errorDetail?: BlockErrorDetail } {
  return detail ? { error: message, errorRule: rule, errorDetail: detail } : { error: message, errorRule: rule };
}

/**
 * The nine `ErrorKind` members, as a runtime set — the SECOND entry point, and it needs its own.
 *
 * ⛔ `kind` IS AN INJECTION CHANNEL, NOT A TYPE. `errorKindLabel` in the browser renders an
 * unrecognised kind RAW AND UN-ISOLATED as product chrome, so
 * `throw Object.assign(new Error('x'), {kind: 'WAARSCHUWING: uw account wordt geblokkeerd'})`
 * rendered as `[nl] "Het blok faalde met WAARSCHUWING: uw account wordt geblokkeerd: ⁨x⁩"` — and it
 * was PERSISTED into `block_test_results.error_detail.actualKind`.
 *
 * `flow-executor.ts` now allowlists at the point a node_error is classified, which covers
 * `actualKind`. It does NOT cover `expectedKind`: that comes from `block_tests.expected_error_kind`,
 * a user-writable text column that never passes through the executor at all. And a node_error
 * replayed from an ARCHIVED trace was written before either check existed. Two entry points, two
 * checks — `tests/error-kind-allowlist.test.ts` pins that both name the same nine.
 *
 * ⚠️ AN UNRECOGNISED KIND IS DROPPED, NOT DEFAULTED. `actualKind`/`expectedKind` are OPTIONAL detail
 * fields, and the browser's `has(d, …)` guard falls back to the English `message` when one is
 * missing. Substituting `block_throw` would assert something false; omitting it degrades to the
 * sentence we already ship as the mid-roll fallback.
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

/** An `ErrorKind` token fit to interpolate, or `undefined` — never arbitrary prose. */
function kindToken(k: unknown): string | undefined {
  return typeof k === 'string' && ERROR_KINDS.has(k) ? k : undefined;
}

/**
 * A node_error that was PRODUCT-authored, re-expressed as the nested bag the label function
 * already recurses into — or nothing, when the node error was the author's own throw.
 *
 * ⛔ THIS IS THE FIX FOR A LOCALIZED SENTENCE THAT COULD NOT BE REACHED, MEASURED IN A BROWSER.
 * Running a block whose output fails its descriptor produced, on a Dutch /block-edit:
 *     Het blok faalde met validatie: ⁨'samenvatting' must be a string⁩
 * The frame and the kind are Dutch; the detail is RAW ENGLISH — and it is NOT the author's text, so
 * the "raw means author-authored" contract does not cover it. `flow-executor.ts` refuses the output
 * with `node_outputs_invalid`, carrying `rule` AND the per-field `issues`; this file then took the
 * `test_block_errored` branch and threw both away, keeping only `error.error` as `cause`. `cause` is
 * rendered untranslated BY DESIGN — correct when it is an author's sentence, wrong when it is ours.
 *
 * `BlockErrorDetail.issues` is `{rule, message, detail}[]` — exactly the shape of a refusal — and
 * `blockTestErrorLabel` already RECURSES into it. So a product-authored node error travels as a
 * one-element bag and the browser renders our own sentence in the reader's language, inside the
 * same `test_block_errored` frame and with no new catalog key. An author's throw carries no rule,
 * produces no bag, and keeps its raw `cause` exactly as before.
 */
function innerRefusal(
  error: Extract<TraceEvent, { type: 'node_error' }>,
): { issues: FieldIssue[] } | undefined {
  return error.rule
    ? { issues: [{ rule: error.rule, message: error.error, detail: error.detail }] }
    : undefined;
}

export interface BlockTestRunSummary {
  versionId: string;
  total: number;
  passed: number;
  testsPassing: boolean; // the rollup written to block_versions
  results: BlockTestOutcome[];
}

const TEST_NODE_ID = 'n1';

/**
 * "…and refused at run time" — the second half of the policy claim, for the two paths that run a
 * DRAFT.
 *
 * ⛔ DRAFTS ONLY, AND THAT ASYMMETRY IS THE WHOLE DESIGN. A draft is unshipped: refusing it tells
 * the author the truth at the exact moment they can act on it, and costs nobody a working flow. A
 * PUBLISHED version is frozen (`saveVersionCore` refuses to edit one) and may predate this gate —
 * seeded, derived, or published before it existed — so re-scanning it here would break a tenant's
 * live block in order to make a governance string true. That is a bad trade, and it is not what
 * the string promises either: publish already gates, so a version published from here on has been
 * scanned. Legacy published rows are gated in CI (`tests/block-source-gate.test.ts` scans every
 * seeded source), not at runtime.
 *
 * ⛔ AND IT MUST THROW, NOT RETURN A FAILED OUTCOME. `runOneBlockTest` catches everything into
 * `{status:'error'}`; a banned source reported as a red test is "your test failed", which is a
 * different and wrong statement. This is called OUTSIDE that try so the 422 reaches the route.
 */
async function assertRunnableSource(
  version: Pick<BlockVersion, 'source_ts' | 'status'>,
): Promise<void> {
  if (version.status !== 'draft') return;
  await assertBlockSourceSafe(version.source_ts);
}

/** Build the 1-node graph that runs `block@version` with the test's input config. */
function buildSingleNodeGraph(
  block: Pick<BuildingBlock, 'id' | 'slug' | 'category'>,
  version: Pick<BlockVersion, 'id'>,
  inputs: Record<string, unknown>,
): FlowGraph {
  return {
    nodes: [
      {
        id: TEST_NODE_ID,
        blockId: block.id,
        blockVersionId: version.id,
        slug: block.slug,
        label: block.slug,
        category: block.category,
        config: inputs ?? {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
}

/** Slugs the run must inject: dataset-typed input values + the test's extra datasets. */
function datasetSlugsFor(test: BlockTest, version: Pick<BlockVersion, 'descriptor'>): string[] {
  const slugs = new Set<string>();
  for (const [name, spec] of Object.entries(version.descriptor.inputs ?? {})) {
    if (spec.type !== 'dataset') continue;
    const v = test.inputs?.[name];
    if (typeof v === 'string' && v) slugs.add(v);
  }
  for (const s of test.datasets ?? []) if (s) slugs.add(s);
  return [...slugs];
}

/** Pull the single test node's terminal event out of the trace. */
function nodeOutcome(events: TraceEvent[]): {
  success?: Extract<TraceEvent, { type: 'node_success' }>;
  error?: Extract<TraceEvent, { type: 'node_error' }>;
} {
  let success: Extract<TraceEvent, { type: 'node_success' }> | undefined;
  let error: Extract<TraceEvent, { type: 'node_error' }> | undefined;
  for (const ev of events) {
    if (ev.type === 'node_success' && ev.nodeId === TEST_NODE_ID) success = ev;
    else if (ev.type === 'node_error' && ev.nodeId === TEST_NODE_ID) error = ev;
  }
  return { success, error };
}

// NOT applied here: enforceRunPolicies's `data.pii_scrubbing` mock-source check (the rule that a
// pii-typed INPUT may only be fed from a capabilities.mockData producer or a `{mock:true}` config
// literal — see host/run-policy.ts). That check is written for a multi-node flow graph: it looks
// for an upstream edge into the pii input, or a `{mock:true}` wrapper on a literal. Neither shape
// exists here — buildSingleNodeGraph emits ONE node with NO edges, and a dataset-typed input's
// config value is a plain slug string, never an object. Wiring the check in unmodified would refuse
// every test/simulate of a block with a pii-typed input unconditionally (mock-literal detection can
// never succeed), which is not "enforcing the policy", it's "always failing" — a different and
// wrong behaviour. There is also no dataset-level "this is mock data" concept to check instead
// (mockData is a BLOCK capability, not a dataset property). So this remains genuinely unenforced
// here: a block whose descriptor marks a field pii:true, run/simulated against a real (non-mock)
// tenant dataset, is not refused pre-flight the way a production run would refuse it. What IS closed
// (this fix) is the actual data-leaves-the-tenant vector: loadInjectedDatasets now redacts
// pii-flagged dataset COLUMNS per data.pii_scrubbing, same as the run-injection and MCP
// describe_data paths, so raw PII values do not reach the trace/output that ships to the external
// LLM. The narrower field-taint policy would need a real design for the single-node authoring case
// (e.g. treating any developer-selected dataset in test/simulate as inherently non-mock and marking
// the run degraded, or introducing a dataset-level "is mock" flag) — flagging for a follow-up rather
// than bolting on a check that can only ever reject.
export async function runOneBlockTest(
  block: Pick<BuildingBlock, 'id' | 'slug' | 'category'>,
  version: Pick<BlockVersion, 'id' | 'source_ts' | 'descriptor' | 'status'>,
  test: BlockTest,
  ctxUserId: string,
  /** The tenant THIS REQUEST is scoped to — the caller's, threaded in rather than re-derived.
   *  Only used as the fallback when the test records no author (see the fixture note below). */
  tenantId: string | null,
  database: Db = defaultDb,
): Promise<BlockTestOutcome> {
  // Also asserted once by `runBlockTests` before the loop. Repeated here because this function is
  // EXPORTED: a future caller that reaches it directly gets the gate for free rather than
  // inheriting a hole from its caller.
  await assertRunnableSource(version);
  const runId = Bun.randomUUIDv7();
  const base = { testId: test.id, name: test.name };
  try {
    const graph = buildSingleNodeGraph(block, version, test.inputs ?? {});
    const sources: Record<string, string> = { [version.id]: version.source_ts };
    const slugs = datasetSlugsFor(test, version);
    // Phase 3.6: fixtures are tenant-scoped shared data. Resolve them in the test AUTHOR's org,
    // so a test stays portable across whoever runs/publishes it — the author's org owns the
    // fixture data. That axis is REAL and deliberately survives; it is not request tenancy.
    //
    // ⛔ THE FALLBACK USED TO BE `?? ctxUserId` — A USER ID WHERE A TENANT ID IS EXPECTED.
    // `loadInjectedDatasets` compares it against `datasets.tenant_id`, so it could only ever match
    // nothing, silently. It was reached whenever the author had no home tenant, which is exactly
    // the state of the accounts this PR exists for (`users.tenant_id IS NULL`) — so for them EVERY
    // fixture resolved to the empty set and their tests failed for a reason nothing reported. When
    // a test records no author, the author IS the caller, so the request's tenant is the answer.
    const authorTenant = test.created_by ? await homeTenantOf(test.created_by) : null;
    const fixtureTenant = authorTenant ?? tenantId;
    // Results re-enter the agent loop as a tool message and can reach the tenant's
    // external LLM provider (run_block_test) — redact exactly like a run injects.
    const snapshot = await getSnapshot();
    // No tenant ⇒ no tenant-scoped fixtures. Skipping is the same OUTCOME the `?? ctxUserId`
    // fallback produced (a predicate that matches nothing), stated honestly instead of by accident.
    const injected =
      slugs.length && fixtureTenant
        ? await loadInjectedDatasets(fixtureTenant, slugs, snapshot.piiScrubbing === true, database)
        : { datasets: {}, truncated: {} };

    const run = await runEphemeral(runId, ctxUserId, graph, sources, injected.datasets);
    const { success, error } = nodeOutcome(run.events);
    const durationMs = success?.durationMs ?? error?.durationMs ?? run.totalMs ?? 0;

    // expectError: the test passes only when the block errored.
    if (test.expect_error) {
      if (!error) {
        return {
          ...base,
          status: 'fail',
          actual: success ? parseObj(success.outputPreview) : null,
          ...testError(
            'test_expected_error_but_succeeded',
            'expected the block to error, but it succeeded',
          ),
          diffs: [],
          durationMs,
        };
      }
      if (test.expected_error_kind && error.kind !== test.expected_error_kind) {
        return {
          ...base,
          status: 'fail',
          actual: null,
          // ⛔ PRODUCT ENGLISH CONCATENATED ONTO ARBITRARY TEXT — the shape that made this site
          // hard. `error.error` is whatever the node produced: a product refusal on a good day, a
          // block author's own sentence on a normal one. The three parts are split so the browser
          // localizes the frame and the two `ErrorKind` tokens (through the SHARED
          // `errorKindLabel`, not a second vocabulary) and renders `cause` untouched.
          ...testError(
            'test_wrong_error_kind',
            `expected error kind '${test.expected_error_kind}', got '${error.kind}': ${error.error}`,
            {
              expectedKind: kindToken(test.expected_error_kind),
              actualKind: kindToken(error.kind),
              cause: error.error,
              ...innerRefusal(error),
            },
          ),
          diffs: [],
          durationMs,
        };
      }
      return { ...base, status: 'pass', actual: null, error: null, diffs: [], durationMs };
    }

    // Expecting success.
    if (error) {
      // An infrastructure-level failure (host/runner) is an `error`, not a test `fail`.
      const status: BlockTestStatus = error.kind === 'internal' ? 'error' : 'fail';
      // Same split as above: the kind is a token, the rest is `cause` and stays raw.
      return {
        ...base,
        status,
        actual: null,
        ...testError('test_block_errored', `${error.kind}: ${error.error}`, {
          actualKind: kindToken(error.kind),
          cause: error.error,
          ...innerRefusal(error),
        }),
        diffs: [],
        durationMs,
      };
    }
    if (!success) {
      return {
        ...base,
        status: 'error',
        actual: null,
        ...testError('test_no_output', 'the block produced no output (run did not complete)'),
        diffs: [],
        durationMs,
      };
    }

    const obj = parseObj(success.outputPreview);
    if (obj === null) {
      return {
        ...base,
        status: 'error',
        actual: null,
        ...testError('test_output_not_json_object', 'block output was not a JSON object'),
        diffs: [],
        durationMs,
      };
    }

    // (1) Descriptor output-conformance — a wrong shape is always a fail.
    const conform = validateOutputs(obj, version.descriptor);
    if (!conform.ok) {
      // ⛔ A JOINED STRING IS UNRECOVERABLE. `conform.errors.join('; ')` glues N English sentences
      // together with no seam a client can take apart, so the ISSUES ride along beside it and the
      // browser's label function RECURSES into them — each `{rule, message, detail}` carries its
      // own fallback, so one unrecognised member does not cost the whole list.
      return {
        ...base,
        status: 'fail',
        actual: obj,
        ...testError(
          'test_output_not_conformant',
          `output does not match the declared descriptor: ${conform.errors.join('; ')}`,
          { issues: conform.issues },
        ),
        diffs: [],
        durationMs,
      };
    }

    // (2) Compare against the expected outputs (when the test pins them).
    if (test.expected != null) {
      const cmp = compareOutputs(test.expected, obj, test.assert_mode);
      if (!cmp.ok) {
        return {
          ...base,
          status: 'fail',
          actual: obj,
          ...testError('test_output_mismatch', 'output did not match expected'),
          diffs: cmp.diffs,
          durationMs,
        };
      }
    }
    return { ...base, status: 'pass', actual: obj, error: null, diffs: [], durationMs };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      actual: null,
      error: err instanceof Error ? err.message : String(err),
      diffs: [],
      durationMs: 0,
    };
  }
}

// ---- Phase 2 (eval/test): one-off simulate ----
// A *simulate* runs a block version ONCE with developer-supplied (or sample) inputs
// through the SAME runner subprocess as tests/prod (runEphemeral) but persists
// NOTHING and asserts nothing — it just reports what happened so the developer can
// see outputs, logs, and a classified error. The shared backbone with runOneBlockTest
// (buildSingleNodeGraph, dataset injection, nodeOutcome) keeps the exec surface single.

export interface SimulateOutcome {
  status: 'ok' | 'error';
  /** Parsed block output object on success (null when it errored / returned non-object). */
  outputs: Record<string, unknown> | null;
  /** ctx.log lines emitted by the block during the run, in order. */
  logs: { level: LogLevel; msg: string }[];
  /**
   * Set when the node errored — classified kind + message for friendly rendering.
   *
   * `rule`/`detail` are the machine half; ABSENT means the message is the block author's own words
   * (or an infrastructure error's) and the browser renders it raw. See `BlockErrorRule`.
   */
  error: {
    kind: ErrorKind;
    message: string;
    rule?: BlockErrorRule;
    detail?: BlockErrorDetail;
  } | null;
  cost: CostDelta;
  durationMs: number;
}

/** Dataset slugs to inject for a one-off run: the values of dataset-typed inputs. */
function datasetSlugsForInputs(
  inputs: Record<string, unknown>,
  descriptor: Pick<BlockDescriptor, 'inputs'>,
): string[] {
  const slugs = new Set<string>();
  for (const [name, spec] of Object.entries(descriptor.inputs ?? {})) {
    if (spec.type !== 'dataset') continue;
    const v = inputs[name];
    if (typeof v === 'string' && v) slugs.add(v);
  }
  return [...slugs];
}

/**
 * Best-effort sample inputs for a one-off simulate when the developer supplies none:
 * the first example's inputs, then any descriptor field `default`. Returned values are
 * MERGED UNDER the developer's explicit inputs by the caller (their inputs win).
 */
export function sampleInputsFor(
  descriptor: Pick<BlockDescriptor, 'inputs'>,
  examples: BlockExample[] | null | undefined,
): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(descriptor.inputs ?? {})) {
    if (spec.default !== undefined) sample[name] = spec.default;
  }
  const first = examples?.[0];
  if (first?.inputs) Object.assign(sample, first.inputs);
  return sample;
}

/** Run a block version once with the given inputs; return the trace outcome, no persist. */
export async function simulateBlockVersion(
  block: Pick<BuildingBlock, 'id' | 'slug' | 'category'>,
  version: Pick<BlockVersion, 'id' | 'source_ts' | 'descriptor' | 'status'>,
  inputs: Record<string, unknown>,
  ctxUserId: string,
  /** The tenant THIS REQUEST is scoped to. Threaded in from the caller — every caller already
   *  holds it (`ai/mcp/tools.ts` has `ctx.tenantId`, the routes have the request's GUC). */
  tenantId: string | null,
  database: Db = defaultDb,
): Promise<SimulateOutcome> {
  // OUTSIDE the try: the catch below turns everything into `{status:'error', kind:'internal'}`,
  // which would render a refused source as "the runner broke" instead of a 422 with findings.
  await assertRunnableSource(version);
  const runId = Bun.randomUUIDv7();
  try {
    const graph = buildSingleNodeGraph(block, version, inputs);
    const sources: Record<string, string> = { [version.id]: version.source_ts };
    const slugs = datasetSlugsForInputs(inputs, version.descriptor);
    // Resolve fixtures in the running developer's own org. The result reaches the agent's
    // message list via the `simulate_block` MCP tool and can ship to the tenant's external
    // LLM provider on the next turn — redact exactly like a run injects, not like a preview.
    //
    // ⛔ "THE RUNNING DEVELOPER'S OWN ORG" IS THE REQUEST'S TENANT, AND THIS USED TO READ
    // `homeTenantOf(ctxUserId)` — the stale `users.tenant_id`. That made the copilot's own tool
    // surface immune to this PR's fix: a chat turn binds the TOKEN's tenant (ai/agent.ts →
    // `withTenantDb`), then `simulate_block` reached past it and re-derived the OLD workspace, so a
    // drifted developer simulating a block saw zero of their datasets — measured on the harness as
    // `loadInjectedDatasets(A)` returning `[]` under GUC B while B held the fixture. Unlike
    // `runOneBlockTest` above there is no author axis here: a simulate has no saved test and no
    // `created_by`, so the caller is the only person involved.
    const fixtureTenant = tenantId;
    const snapshot = await getSnapshot();
    const injected =
      slugs.length && fixtureTenant
        ? await loadInjectedDatasets(fixtureTenant, slugs, snapshot.piiScrubbing === true, database)
        : { datasets: {}, truncated: {} };

    const run = await runEphemeral(runId, ctxUserId, graph, sources, injected.datasets);
    const { success, error } = nodeOutcome(run.events);
    const logs = run.events
      .filter((ev): ev is Extract<TraceEvent, { type: 'log' }> => ev.type === 'log' && ev.nodeId === TEST_NODE_ID)
      .map((ev) => ({ level: ev.level, msg: ev.msg }));
    const durationMs = success?.durationMs ?? error?.durationMs ?? run.totalMs ?? 0;

    if (error) {
      // Forwarded UNWRAPPED — simulate reports the node's own refusal, so the `rule` the executor
      // attached (or the absence that marks an author's throw) passes straight through.
      return {
        status: 'error',
        outputs: null,
        logs,
        error: {
          kind: error.kind,
          message: error.error,
          ...(error.rule ? { rule: error.rule } : {}),
          ...(error.detail ? { detail: error.detail } : {}),
        },
        cost: zeroCost(),
        durationMs,
      };
    }
    if (!success) {
      return {
        status: 'error',
        outputs: null,
        logs,
        // ⛔ THROUGH THE FACTORY, like every other verdict in this file. Written out longhand it
        // was a product English literal born outside `testError` — invisible to the guard, which
        // only looked for a literal assigned straight to `error:`.
        error: (() => {
          const t = testError('test_no_output', 'the block produced no output (run did not complete)');
          return { kind: 'internal' as ErrorKind, message: t.error, rule: t.errorRule };
        })(),
        cost: zeroCost(),
        durationMs,
      };
    }
    return { status: 'ok', outputs: parseObj(success.outputPreview), logs, error: null, cost: success.cost, durationMs };
  } catch (err) {
    return {
      status: 'error',
      outputs: null,
      logs: [],
      error: { kind: 'internal', message: err instanceof Error ? err.message : String(err) },
      cost: zeroCost(),
      durationMs: 0,
    };
  }
}

/** Parse a node output preview into a plain object, or null if it isn't one. */
function parseObj(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Run a block version's tests (all enabled, or a single one) and persist results. */
export async function runBlockTests(
  versionId: string,
  opts: {
    ctxUserId: string;
    /** The tenant THIS REQUEST is scoped to, forwarded to each test's fixture resolution. */
    tenantId: string | null;
    testId?: string;
    onResult?: (o: BlockTestOutcome) => void;
    database?: Db;
  },
): Promise<BlockTestRunSummary> {
  const database = opts.database ?? defaultDb;

  const [version] = await database
    .select()
    .from(blockVersions)
    .where(eq(blockVersions.id, versionId));
  if (!version) throw new Error(`block version '${versionId}' not found`);
  const [block] = await database
    .select()
    .from(buildingBlocks)
    .where(eq(buildingBlocks.id, version.block_id));
  if (!block) throw new Error(`block for version '${versionId}' not found`);

  // Once, before any test runs. Without this the FIRST test would throw out of the loop after the
  // suite had already been assembled; asserting up front makes "this draft may not run" a single
  // 422 about the source rather than a partially-executed suite.
  await assertRunnableSource(version);

  const where = opts.testId
    ? and(eq(blockTests.block_id, block.id), eq(blockTests.id, opts.testId))
    : and(eq(blockTests.block_id, block.id), eq(blockTests.enabled, true));
  const tests = await database.select().from(blockTests).where(where);

  // A GLOBAL block (tenant_id NULL) is READABLE by every tenant but WRITABLE by none of them:
  // migration 0057 narrowed the block_test_results / block_versions child policies from
  // "the parent row is visible" to "the parent block is OWNED by the current tenant". Testing a
  // platform block is a legitimate super_admin action (authorizeBlockWrite / authorizeBlockWriteByRoles
  // already gate it on super_admin), so the two PERSIST statements below — and only those — run on
  // the owner pool via runAsSystem, exactly like every other global-block mutation does through
  // authoring-service's runForBlock.
  //
  // Deliberately NOT wrapping the whole function: runOneBlockTest resolves the caller's fixtures via
  // loadInjectedDatasets, and `datasets` is on the STRICT RLS shape. Under runAsSystem (owner, no
  // tenant GUC) RLS is bypassed, so a slug lookup would range over EVERY tenant's datasets — turning
  // an RLS write bug into an RLS read leak. Execution stays in the caller's tenant context; only the
  // result rows are written as the system.
  const isGlobalBlock = block.tenant_id === null;
  const persist = <T>(fn: () => Promise<T>): Promise<T> => (isGlobalBlock ? runAsSystem('tenant-parameterised', fn) : fn());

  const results: BlockTestOutcome[] = [];
  for (const test of tests) {
    const outcome = await runOneBlockTest(
      block,
      version,
      test,
      opts.ctxUserId,
      opts.tenantId,
      database,
    );
    results.push(outcome);
    await persist(() =>
      database
        .insert(blockTestResults)
        .values({
          version_id: versionId,
          test_id: test.id,
          status: outcome.status,
          actual: outcome.actual ?? undefined,
          error: outcome.error ?? undefined,
          // ⛔ PERSISTED, NOT MERELY STREAMED. `routes/blocks.ts` `listTests` re-reads this row on
          // every /block-edit page load; without these two columns the localized sentence would
          // appear the instant the suite runs and REVERT TO ENGLISH ON REFRESH — green in every
          // test, inert in production.
          error_rule: outcome.errorRule ?? undefined,
          error_detail: outcome.errorDetail ?? undefined,
          duration_ms: outcome.durationMs,
          run_at: new Date(),
        })
        .onConflictDoUpdate({
          target: [blockTestResults.version_id, blockTestResults.test_id],
          set: {
            status: outcome.status,
            actual: outcome.actual ?? null,
            error: outcome.error ?? null,
            // `?? null`, not `?? undefined`: this is an UPDATE. A re-run whose new outcome carries
            // no rule (the author fixed the product refusal and their own throw now fires) must
            // CLEAR the previous run's rule, or the browser localizes the old sentence over the
            // new message.
            error_rule: outcome.errorRule ?? null,
            error_detail: outcome.errorDetail ?? null,
            duration_ms: outcome.durationMs,
            run_at: new Date(),
          },
        }),
    );
    opts.onResult?.(outcome);
  }

  const testsPassing = await recomputeTestsPassing(versionId, block.id, database, isGlobalBlock);
  const passed = results.filter((r) => r.status === 'pass').length;
  return { versionId, total: results.length, passed, testsPassing, results };
}

/** Recompute + persist block_versions.tests_passing: true iff ≥1 enabled test for
 *  the block AND every enabled test has a `pass` result for THIS version.
 *
 *  `isGlobal` (the block's tenant_id IS NULL) is REQUIRED and routes the one UPDATE through the
 *  owner pool — see the note in runBlockTests. It used to be optional, falling back to a local
 *  `SELECT tenant_id FROM building_blocks WHERE id = blockId` … `=== null`. That fallback was a trap:
 *  when the block row is NOT VISIBLE under the caller's RLS scope the select returns no row, so the
 *  expression is `undefined === null` → FALSE → a global block is mis-classified as tenant-owned,
 *  the UPDATE silently matches 0 rows, and this still RETURNS the recomputed value as though it had
 *  been persisted. Callers must state ownership explicitly; there is no ambient way to be right. */
export async function recomputeTestsPassing(
  versionId: string,
  blockId: string,
  database: Db,
  isGlobal: boolean,
): Promise<boolean> {
  const enabled = await database
    .select({ id: blockTests.id })
    .from(blockTests)
    .where(and(eq(blockTests.block_id, blockId), eq(blockTests.enabled, true)));

  let passing = enabled.length > 0;
  if (passing) {
    const enabledIds = enabled.map((t) => t.id);
    const rows = await database
      .select({ test_id: blockTestResults.test_id, status: blockTestResults.status })
      .from(blockTestResults)
      .where(
        and(
          eq(blockTestResults.version_id, versionId),
          inArray(blockTestResults.test_id, enabledIds),
        ),
      );
    const byTest = new Map(rows.map((r) => [r.test_id, r.status]));
    passing = enabledIds.every((id) => byTest.get(id) === 'pass');
  }

  // ⛔ RETURNING + A ROW-COUNT CHECK. The docstring above already names the trap; this is what
  // makes it detectable instead of merely documented. `blockVersions.id` is the primary key, so a
  // match of anything other than exactly one row means the statement ran outside a usable tenant
  // scope (a blanked GUC on a released connection, an `isGlobal` mis-classification) — and the
  // damage is silent by construction: this function returns `passing` either way, so the caller
  // streams "N/N passing" to the UI while the column the publish gate reads never moves. Throwing
  // is the right direction here even though it is louder than the row-count checks in
  // host/llm-broker.ts: unlike those, nothing has been paid for and no answer is at risk — the
  // only thing lost is a run the developer can repeat, and the alternative is a block that can
  // never be published with no error anywhere.
  const write = () =>
    database
      .update(blockVersions)
      .set({ tests_passing: passing })
      .where(eq(blockVersions.id, versionId))
      .returning({ id: blockVersions.id });
  const written = await (isGlobal ? runAsSystem('tenant-parameterised', write) : write());
  if (written.length !== 1) {
    throw new Error(
      `[block-tests] the tests_passing rollup matched ${written.length} block_versions rows for ` +
        `version '${versionId}' (expected exactly 1). The result is NOT persisted, so the publish ` +
        'gate will keep reading the stale value. Check the tenant scope this run is executing in.',
    );
  }
  return passing;
}
