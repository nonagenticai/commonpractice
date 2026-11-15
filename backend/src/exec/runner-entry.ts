// src/exec/runner-entry.ts — entrypoint of the UNTRUSTED subprocess (SPEC §5).
// The host spawns `bun run runner-entry.ts` with a scrubbed env (no DB url, no
// provider key) and the per-run scratch dir as cwd. Protocol (newline-delimited
// JSON):
//   host → runner, on STDIN:  one `init` frame (line 0), then `llm_response`s.
//   runner → host, on STDOUT: NDJSON TraceEvents, multiplexed with `llm_request`s.
//   STDERR: crash diagnostics only (never protocol).
// ctx.llm() has no key — it writes an `llm_request` and awaits the matching
// `llm_response` (the host broker enforces caps and holds the key). The runner
// literally cannot reach a provider on its own.

// 1. STRIP NETWORK GLOBALS FIRST — before any block module is imported/run.
for (const g of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'] as const) {
  try {
    delete (globalThis as Record<string, unknown>)[g];
  } catch {
    (globalThis as Record<string, unknown>)[g] = undefined;
  }
}
if (typeof Bun !== 'undefined') {
  try {
    delete (Bun as unknown as Record<string, unknown>).connect;
    delete (Bun as unknown as Record<string, unknown>).listen;
  } catch {
    /* non-configurable — best effort */
  }
}

import { writeSync } from 'node:fs';
import { makeDatasetResolver } from './dataset-resolver';
import { executeFlow, type ExecDeps, type ExecPolicy } from './flow-executor';
import { loadBlock } from './block-loader';
import { mockData } from './mock-data';
import type { LlmRequest, LlmResponse } from './sdk';
import type {
  TraceEvent,
  InitFrame,
  LlmResponseFrame,
  ErrorKind,
  BlockErrorRule,
} from '../db/trace-types';

// 2. REDIRECT console TO STDERR — fd 1 is the CONTROL PROTOCOL, not a log stream.
// A block doing `console.log(...)` wrote straight into the host's NDJSON frame channel. If what it
// printed happened to be JSON carrying a `type` key (routine for data-mapping blocks that dump a
// row), the host parsed it as a TraceEvent — corrupting run totals, or letting a block declare its
// own terminal status. The host now validates frames too, but the honest fix is that untrusted
// output must never share the channel. Block authors keep their console output — it goes to
// stderr, already the diagnostics stream — and `ctx.log` remains the way into the run trace.
//
// Placed AFTER the imports on purpose: this runs at module-body time, when `writeSync` is bound.
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'] as const) {
  (console as unknown as Record<string, unknown>)[level] = (...args: unknown[]): void => {
    try {
      const line = args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a); // circular / non-serialisable — never let logging break a run
          }
        })
        .join(' ');
      writeSync(2, `[block:${level}] ${line}\n`);
    } catch {
      /* stderr unavailable — drop it rather than fail the run */
    }
  };
}

function writeLine(obj: unknown): void {
  writeSync(1, `${JSON.stringify(obj)}\n`);
}
function diag(msg: string): void {
  writeSync(2, `[runner] ${msg}\n`);
}

// ---- stdin: the init frame + the llm_response channel ----
const pending = new Map<
  number,
  { resolve: (r: LlmResponse) => void; reject: (e: unknown) => void }
>();
let resolveInit!: (f: InitFrame) => void;
const initFrame = new Promise<InitFrame>((res) => {
  resolveInit = res;
});

function handleLine(line: string): void {
  let frame: { type?: string };
  try {
    frame = JSON.parse(line);
  } catch {
    diag(`unparseable stdin line: ${line.slice(0, 120)}`);
    return;
  }
  if (frame.type === 'init') {
    resolveInit(frame as unknown as InitFrame);
  } else if (frame.type === 'llm_response') {
    const f = frame as unknown as LlmResponseFrame;
    const p = pending.get(f.id);
    if (!p) return;
    pending.delete(f.id);
    if (f.ok) p.resolve(f.result);
    // ⛔ THE HOST'S RULE IS FORWARDED, NOT DROPPED. This rejection is awaited inside `ctx.llm()`,
    // i.e. INSIDE AUTHOR CODE, so it must not be a product-refusal object — `flow-executor.ts`'s
    // `ctx.llm` catches this carrier and converts it into an opaque sentinel before the throw
    // reaches the block. What travels here is inert data: a plain Error with the host's fields
    // hung off it. An author can forge exactly this shape and gains nothing, because `classify`
    // trusts the sentinel's IDENTITY and never these properties.
    else p.reject(Object.assign(new Error(f.error), { kind: f.kind, rule: f.rule, detail: f.detail }));
  }
}

async function readStdin(): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line);
    }
  }
  // stdin closed: nothing more is coming — fail any awaiting llm calls.
  for (const [, p] of pending) {
    p.reject(
      Object.assign(new Error('host closed stdin'), {
        kind: 'internal' as ErrorKind,
        rule: 'llm_host_closed' as BlockErrorRule,
      }),
    );
  }
  pending.clear();
}

// ---- the llm stdio bridge ----
let llmSeq = 0;
function llmBridge(req: LlmRequest, nodeId: string): Promise<LlmResponse> {
  const id = ++llmSeq;
  return new Promise<LlmResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeLine({ type: 'llm_request', id, nodeId, payload: req });
  });
}

async function main(): Promise<void> {
  void readStdin(); // run the reader concurrently; don't await (it ends with stdin)
  const init = await initFrame;
  const sources = new Map<string, string>(Object.entries(init.sources));
  const policy: ExecPolicy = {
    maxNodeMs: init.policy?.maxNodeMs ?? 15000,
    fullOutput: init.policy?.fullOutput === true,
    maxRunMs: init.policy?.maxRunMs,
    maxIterations: init.policy?.maxIterations,
    maxForeachEvents: init.policy?.maxForeachEvents,
  };

  // Datasets were resolved + capped + PII-redacted by the host and delivered in the
  // init frame. The runner just serves rows by slug — it never reaches the DB.
  const datasets = init.datasets ?? {};

  const deps: ExecDeps = {
    loadBlock,
    llm: llmBridge,
    mockData,
    dataset: makeDatasetResolver(datasets),
    emit: (ev: TraceEvent) => writeLine(ev),
    now: () => Date.now(),
  };

  try {
    const status = await executeFlow(
      init.graph,
      sources,
      init.runId,
      process.cwd(),
      deps,
      policy,
    );
    process.exit(status === 'failed' ? 1 : 0);
  } catch (err) {
    diag(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    writeLine({
      type: 'run_complete',
      runId: init.runId,
      ts: Date.now(),
      totalMs: 0,
      status: 'failed',
      totals: { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 },
    });
    process.exit(1);
  }
}

void main();
