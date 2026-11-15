// src/exec/sdk.ts — the public Block SDK (SPEC §5). This is the ONLY module a
// block author may import (the save-time static-scan allowlists './sdk'). It is
// also the capability surface the runner injects as `ctx`: a block reaches the
// outside world ONLY through ctx — never ambient globals (which the runner
// strips). Pure types + re-exports; no runtime, no secrets, no DB.
export type {
  FieldType,
  FieldSpec,
  BlockCapabilities,
  BlockLimits,
  BlockDescriptor,
} from '../db/block-types';
import type { BlockDescriptor } from '../db/block-types';

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface LlmRequest {
  /** Omit to use the workspace's configured model. Do not pin a commercial model in a platform block. */
  model?: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  usage: TokenUsage;
  costUsd: number;
}

/** The injected capability surface. Everything a block can do to the outside. */
export interface BlockContext {
  /** Brokered, metered LLM call. The runner has NO provider key — this round-
   *  trips to the trusted host, which enforces the daily-call cap + spend
   *  ceiling before calling the provider. Rejects if the block lacks the `llm`
   *  capability or the cap is hit. */
  llm(req: LlmRequest): Promise<LlmResponse>;
  /** Deterministic sandboxed sample data (no real PII, no secrets). Requires the `mockData`
   *  capability — which is ALSO a user-visible claim that this block's output is invented. */
  mockData(kind: string, opts?: Record<string, unknown>): Promise<any>;
  /** Rows of a developer-loaded dataset, by slug (Phase 2.0). The host resolved +
   *  capped + PII-redacted these before injection; the runner has no DB access.
   *  ⛔ An ABSENT slug THROWS — it does not return []. The old "returns [] for an unknown slug"
   *  behaviour this comment used to describe WAS the bug (#150): it collapsed "this workspace has
   *  no dataset called X" into "X has no rows", so a flow ran happily over empty input with no
   *  failure and no warning. An empty-but-present dataset still legitimately yields [].
   *
   *  ⛔ GATED ON THE `dataset` CAPABILITY — its OWN bit since the split, NOT on `mockData`. These
   *  rows are the tenant's REAL uploaded data, so the grant that opens this door must not double as
   *  the product's "this output is simulated" claim: `load-dataset` had to declare `mockData` purely
   *  to pass the old shared gate, and the honesty badge then read that flag back and told the
   *  customer their own data was fake. `mockData` still opens this gate too, forever, so every block
   *  authored before the split keeps running (flow-executor.ts). */
  dataset(slug: string): Promise<Record<string, unknown>[]>;
  /** Structured logging — surfaced as `log` trace events in the run console. */
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
  /** Per-node abort signal (fires on the node timeout or a run cancel). */
  signal: AbortSignal;
}

export interface Block<
  I = Record<string, unknown>,
  O = Record<string, unknown>,
> {
  descriptor: BlockDescriptor;
  run(inputs: I, ctx: BlockContext): Promise<O>;
}
