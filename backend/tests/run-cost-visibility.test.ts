// tests/run-cost-visibility.test.ts — LLM spend is tenant_admin+ ON THE WIRE.
//
// The rule itself, plus a pin on every call site that sends spend to a browser or an agent. The
// SSE stream and GET /api/runs/:id are covered end to end in runs.test.ts; block simulate (REST +
// the `simulate_block` MCP tool) and the assistant's chat stream are pinned here at the source,
// because each is one line that a refactor could drop without any behavioural test noticing.
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  canSeeRunCostRoles,
  INTERNAL_ERROR_REDACTED,
  TIMEOUT_ERROR_REDACTED,
  redactTraceCost,
  traceEventFor,
  runRowFor,
  simulateOutcomeFor,
} from '../src/host/run-cost-visibility';
import type { TraceEvent } from '../src/db/trace-types';

const cost = { usd: 0.004, tokensIn: 10, tokensOut: 5, llmCalls: 1 };

describe('canSeeRunCostRoles', () => {
  test.each([
    [['member'], false],
    [['developer'], false],
    [['employee'], false],
    [[], false],
    [['tenant_admin'], true],
    [['super_admin'], true],
    [['developer', 'tenant_admin'], true],
  ])('%j → %s', (roles, expected) => {
    expect(canSeeRunCostRoles(roles)).toBe(expected);
  });
});

test('redactTraceCost drops node_success.cost and run_complete.totals, nothing else', () => {
  const ok: TraceEvent = { type: 'node_success', runId: 'r', ts: 1, nodeId: 'n', slug: 's', durationMs: 3, cost, outputPreview: '{}' };
  const done: TraceEvent = { type: 'run_complete', runId: 'r', ts: 2, totalMs: 3, status: 'ok', totals: cost };
  expect(redactTraceCost(ok)).toEqual({ type: 'node_success', runId: 'r', ts: 1, nodeId: 'n', slug: 's', durationMs: 3, outputPreview: '{}' } as never);
  expect(redactTraceCost(done)).toEqual({ type: 'run_complete', runId: 'r', ts: 2, totalMs: 3, status: 'ok' } as never);
  const start: TraceEvent = { type: 'run_start', runId: 'r', ts: 0, nodeCount: 1 };
  expect(redactTraceCost(start)).toBe(start);
});

test('runRowFor: member loses cost columns and trace cost; admin gets the row as is', () => {
  const row = {
    id: 'r', status: 'ok', total_cost_usd: '0.004', tokens_in: 10, tokens_out: 5, llm_calls: 1,
    trace: [{ type: 'run_complete', runId: 'r', ts: 2, totalMs: 3, status: 'ok', totals: cost }] as TraceEvent[],
  };
  const member = runRowFor({ roles: ['member'] }, row) as Record<string, unknown>;
  for (const c of ['total_cost_usd', 'tokens_in', 'tokens_out', 'llm_calls']) expect(member).not.toHaveProperty(c);
  expect(JSON.stringify(member)).not.toMatch(/usd|tokensIn|llmCalls/);
  expect(member.status).toBe('ok');
  expect(runRowFor({ roles: ['tenant_admin'] }, row)).toBe(row);
});

// A member pressed "Test" and read the HOST's failure verbatim in the Result panel and Details:
// pod name, namespace and a kubectl message. Below developer the wire carries a fixed sentence.
describe('internal error text is developer+ on the wire', () => {
  const raw =
    'run pod cp-run-0192 not Running: error: timed out waiting for the condition on pods/cp-run-0192';
  const infra: TraceEvent = {
    type: 'node_error', runId: 'r', ts: 1, nodeId: '-', slug: '-', durationMs: 0, error: raw, kind: 'internal',
  };
  const authored: TraceEvent = {
    type: 'node_error', runId: 'r', ts: 1, nodeId: 'n', slug: 's', durationMs: 2, error: 'amount missing', kind: 'block_throw',
  };
  const ruled: TraceEvent = {
    type: 'node_error', runId: 'r', ts: 1, nodeId: 'n', slug: 's', durationMs: 2, error: 'no source for block version v1',
    kind: 'internal', rule: 'node_no_source', detail: { blockVersion: 'v1' } as never,
  };

  const idleRaw =
    'the runner sent nothing for 120000ms (host idle watchdog) — the run was stopped and its pod destroyed';
  const idle: TraceEvent = {
    type: 'node_error', runId: 'r', ts: 1, nodeId: '', slug: '', durationMs: 0, error: idleRaw, kind: 'timeout',
  };
  type NodeError = Extract<TraceEvent, { type: 'node_error' }>;

  test.each([[['member']], [['employee']], [[]]])('%j: an unruled internal error becomes the fixed sentence', (roles) => {
    const out = traceEventFor({ roles }, infra) as NodeError;
    expect(out.error).toBe(INTERNAL_ERROR_REDACTED);
    expect(out.kind).toBe('internal');
    expect(out.rule).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/cp-run|pods\/|kubectl|Running/);
  });

  test.each([[['member']], [[]]])('%j: a RULED internal error keeps its rule and blockVersion, not its English', (roles) => {
    // REVERT THAT TURNS THIS RED: strip `rule` for every internal error — the browser can no longer
    // pick the catalog sentence, and a deterministic block defect reads "try again later".
    const out = traceEventFor({ roles }, ruled) as NodeError;
    expect(out.rule).toBe('node_no_source');
    expect(out.detail).toEqual({ blockVersion: 'v1' } as never);
    expect(out.error).toBe(INTERNAL_ERROR_REDACTED);
  });

  test.each([[['member']], [[]]])('%j: the host idle watchdog becomes the fixed timeout sentence', (roles) => {
    // REVERT THAT TURNS THIS RED: limit the redaction to kind `internal` again.
    const out = traceEventFor({ roles }, idle) as NodeError;
    expect(out.error).toBe(TIMEOUT_ERROR_REDACTED);
    expect(out.kind).toBe('timeout');
    expect(JSON.stringify(out)).not.toMatch(/watchdog|pod|ms/);
  });

  test.each([[['developer']], [['tenant_admin']], [['super_admin']]])('%j keeps the raw text', (roles) => {
    expect((traceEventFor({ roles }, infra) as { error: string }).error).toBe(raw);
    expect(traceEventFor({ roles }, ruled)).toEqual(ruled);
    expect(traceEventFor({ roles }, idle)).toEqual(idle);
  });

  test.each<[string, TraceEvent]>([
    ['validation', { type: 'node_error', runId: 'r', ts: 1, nodeId: 'n', slug: 's', durationMs: 2, kind: 'validation',
      error: "'amount' must be a number", rule: 'field_must_be_number', detail: { field: 'amount' } as never }],
    ['llm_capped', { type: 'node_error', runId: 'r', ts: 1, nodeId: 'n', slug: 's', durationMs: 2, kind: 'llm_capped',
      error: 'daily LLM call cap reached (50)', rule: 'llm_daily_cap_reached', detail: { limit: '50' } as never }],
    ['ruled timeout (node_timeout)', { type: 'node_error', runId: 'r', ts: 1, nodeId: 'n', slug: 's', durationMs: 2,
      kind: 'timeout', error: 'node exceeded its time budget', rule: 'node_timeout' }],
  ])('a member receives a %s node_error unredacted', (_name, ev) => {
    expect(traceEventFor({ roles: ['member'] }, ev)).toEqual(ev);
  });

  test("a block's own error is not touched for a member", () => {
    expect(traceEventFor({ roles: ['member'] }, authored)).toEqual(authored);
  });

  test('GET /api/runs/:id row: the persisted trace is redacted for a member, raw for a developer', () => {
    const row = { id: 'r', status: 'failed', trace: [infra] as TraceEvent[] };
    expect(JSON.stringify(runRowFor({ roles: ['member'] }, row))).not.toContain('cp-run-0192');
    expect(JSON.stringify(runRowFor({ roles: ['developer'] }, row))).toContain('cp-run-0192');
    expect(row.trace[0]).toBe(infra); // the stored row object is never mutated
  });
});

test('simulateOutcomeFor: a developer gets the outcome without cost; an admin with it', () => {
  const outcome = { status: 'ok', outputs: { x: 1 }, logs: [], error: null, cost, durationMs: 3 };
  expect(simulateOutcomeFor(['developer'], outcome)).not.toHaveProperty('cost');
  expect(simulateOutcomeFor(['developer'], outcome)).toHaveProperty('outputs.x', 1);
  expect(simulateOutcomeFor(['tenant_admin'], outcome)).toHaveProperty('cost.llmCalls', 1);
});

describe('every call site that sends spend goes through the rule', () => {
  const src = (p: string) => {
    const s = readFileSync(new URL(p, import.meta.url), 'utf8');
    expect(s.length).toBeGreaterThan(500);
    return s;
  };
  test('POST /api/blocks/:slug/versions/:version/simulate', () => {
    expect(src('../src/routes/blocks.ts')).toMatch(/jsonResponse\(\{ \.\.\.simulateOutcomeFor\(user\.roles, outcome\), inputs \}\)/);
  });
  test('MCP simulate_block', () => {
    expect(src('../src/ai/mcp/tools.ts')).toMatch(/return \{ \.\.\.simulateOutcomeFor\(ctx\.roles, outcome\), inputs \}/);
  });
  test('assistant chat stream drops the cost event below tenant_admin', () => {
    const s = src('../src/routes/agent.ts');
    expect(s).toMatch(/const showCost = canSeeRunCostRoles\(roles\)/);
    expect(s).toMatch(/if \(ev\.type === 'cost' && !showCost\) return;/);
  });
  test('GET /api/runs/:id', () => {
    expect(src('../src/host/run-controller.ts')).toMatch(/return jsonResponse\(runRowFor\(user, run\)\)/);
  });
});
