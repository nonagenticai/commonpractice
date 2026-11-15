// tests/trace-frame-validation.test.ts — the runner→host trace channel is a TRUST BOUNDARY.
//
// The runner subprocess writes protocol frames to fd 1, and so does anything a block author's code
// prints. The host used to cast every parsed stdout line straight to `TraceEvent` and dereference
// `ev.cost.usd` / `ev.totals`. A block doing `console.log(JSON.stringify(row))` on a row that
// happened to carry a `type` key could therefore:
//   • crash the event pump, so its own SUCCESSFUL run was reported as failed;
//   • poison the totals with NaN, leaving the flow_runs row stuck at status 'running' forever;
//   • declare its own `run_complete` status and zero out its recorded spend.
import { expect, test } from 'bun:test';
import { isTraceEvent, zeroCost } from '../src/db/trace-types';

const base = { runId: 'r1', ts: 1 };

test('well-formed frames are accepted', () => {
  expect(isTraceEvent({ ...base, type: 'run_start', nodeCount: 2 })).toBe(true);
  expect(isTraceEvent({ ...base, type: 'node_start', nodeId: 'n1', slug: 's' })).toBe(true);
  expect(isTraceEvent({ ...base, type: 'log', nodeId: 'n1', level: 'info', msg: 'hi' })).toBe(true);
  expect(
    isTraceEvent({ ...base, type: 'node_success', nodeId: 'n1', slug: 's', durationMs: 1, cost: zeroCost(), outputPreview: '' }),
  ).toBe(true);
  expect(
    isTraceEvent({ ...base, type: 'run_complete', totalMs: 5, status: 'ok', totals: zeroCost() }),
  ).toBe(true);
});

test('an unknown type is rejected — a block cannot invent a frame', () => {
  expect(isTraceEvent({ type: 'give_me_money' })).toBe(false);
  expect(isTraceEvent({ type: 'user_created', id: 7 })).toBe(false);
});

test('non-objects and typeless JSON are rejected', () => {
  for (const junk of [null, undefined, 42, 'run_complete', [], [{ type: 'run_start' }], {}, { type: 3 }]) {
    expect(isTraceEvent(junk)).toBe(false);
  }
});

test('node_success WITHOUT a usable cost is rejected — this is the NaN/crash vector', () => {
  const n = { ...base, type: 'node_success', nodeId: 'n1', slug: 's', durationMs: 1, outputPreview: '' };
  expect(isTraceEvent(n)).toBe(false); // no cost at all → used to throw and kill the pump
  expect(isTraceEvent({ ...n, cost: {} })).toBe(false); // → NaN totals → stuck 'running' row
  expect(isTraceEvent({ ...n, cost: { usd: 'free', tokensIn: 0, tokensOut: 0, llmCalls: 0 } })).toBe(false);
  expect(isTraceEvent({ ...n, cost: { usd: NaN, tokensIn: 0, tokensOut: 0, llmCalls: 0 } })).toBe(false);
  expect(isTraceEvent({ ...n, cost: { usd: 1, tokensIn: 2, tokensOut: 3, llmCalls: 4 } })).toBe(true);
});

test('run_complete cannot be forged with a bogus status or missing totals', () => {
  const c = { ...base, type: 'run_complete', totalMs: 1 };
  expect(isTraceEvent({ ...c, status: 'ok' })).toBe(false); // no totals → spend record erased
  expect(isTraceEvent({ ...c, status: 'succeeded', totals: zeroCost() })).toBe(false); // not a RunStatus
  expect(isTraceEvent({ ...c, status: 'ok', totals: { usd: 0 } })).toBe(false);
  expect(isTraceEvent({ ...c, status: 'failed', totals: zeroCost() })).toBe(true);
});

test('a plausible block console.log that merely HAS a type key is rejected', () => {
  // The accidental case, and the most likely one in practice.
  expect(isTraceEvent({ type: 'claim', id: 'C-1', amount: 120 })).toBe(false);
  expect(isTraceEvent({ type: 'node_success', id: 'C-1', amount: 120 })).toBe(false);
});
