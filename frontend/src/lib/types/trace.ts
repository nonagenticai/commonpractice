// src/lib/types/trace.ts — 1:1 mirror of backend/src/db/trace-types.ts (the
// frontend-relevant subset: the TraceEvent union the SSE stream delivers). Keep
// in sync with the backend.
export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';

export type ErrorKind =
  | 'timeout'
  | 'validation'
  | 'block_throw'
  | 'network_blocked'
  | 'llm_capped'
  | 'model_not_allowed'
  | 'budget_exhausted'
  | 'flow_error'
  | 'internal';

export interface CostDelta {
  usd: number;
  tokensIn: number;
  tokensOut: number;
  llmCalls: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The identifier-only parameters a block-run refusal carries so the BROWSER can write the sentence.
 *
 * Mirrors `BlockErrorDetail` in backend/src/db/trace-types.ts. Every field is optional because each
 * rule supplies only what its own sentence names, and the whole bag is optional because a runner
 * one deploy behind — and every archived `flow_runs.trace`, and every `block_test_results` row
 * written before migration 0072 — ships none of it. See `blockTestErrorLabel` for what that costs.
 *
 * Values are port names, enum options, `ErrorKind` tokens and slugs: NEVER translated, never prose.
 * ⛔ WITH ONE EXCEPTION THAT IS THE WHOLE POINT — `cause` IS prose, and is prose this product did
 * NOT write. It is the arbitrary text a product sentence was concatenated onto, usually a block
 * author's own message. It is interpolated verbatim and must never be localized.
 */
export interface BlockErrorDetail {
	field?: string;
	/** ⛔ AN ARRAY, NOT A JOINED LIST. "[a, b, c]" is an ENGLISH list — the separator and the final
	 *  conjunction are language-specific — so `Intl.ListFormat` rebuilds it here. */
	options?: string[];
	expectedKind?: string;
	actualKind?: string;
	/** ⛔ RAW. See above. */
	cause?: string;
	/** The per-field issues that the backend ALSO joined into `message` with `'; '`. A joined string
	 *  has no seam a client can take apart, so each one arrives intact and the label RECURSES. */
	issues?: FieldIssue[];
	blockVersion?: string;
	port?: string;
	slug?: string;
	/** `dataset_not_available*` — the dataset SLUG the block asked for. Not folded into `slug`,
	 *  which means the node's BLOCK slug: one sentence could name both. */
	dataset?: string;
	/** `llm_daily_cap_reached` / `llm_weekly_spend_reached` — the governance bound, already
	 *  formatted by the host (a call count, or a dollar amount with its sign). */
	limit?: string;
	/** `llm_model_not_allowed` — the model id the allowlist refused. */
	model?: string;
}

/** ONE field-validation refusal: the rule, its OWN English fallback, and its own tokens. */
export interface FieldIssue {
	/** A plain `string`, not the backend's 28-value union — same reason as `BlockError.rule`. */
	rule: string;
	message: string;
	detail?: BlockErrorDetail;
}

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
      /** ABSENT for a caller below tenant_admin: the server strips spend (run-cost-visibility.ts). */
      cost?: CostDelta;
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
       * ⛔ NOT DEAD. The backend's English, and REQUIRED — it is the only thing an archived
       * `flow_runs.trace` row carries, it is the mid-roll fallback, and when `rule` is ABSENT it is
       * the BLOCK AUTHOR'S OWN sentence, which must be rendered exactly as they wrote it.
       */
      error: string;
      kind: ErrorKind;
      /**
       * The product rule behind `error`. ABSENT ⇒ the text is not ours to translate. A plain
       * `string`, not the backend union, so a rule shipped backend-first degrades to its own
       * message instead of failing to type-check.
       */
      rule?: string;
      detail?: BlockErrorDetail;
    }
  | {
      type: 'node_skipped';
      runId: string;
      ts: number;
      nodeId: string;
      slug: string;
      /**
       * ⛔ NOT DEAD. The backend's English, and REQUIRED — it is the only thing an archived
       * `flow_runs.trace` row (written before `reasonCode` existed) carries, as well as the
       * mid-roll fallback. `RunConsole` renders it whenever `reasonCode` is absent.
       */
      reason: string;
      /** Machine code. OPTIONAL: absent on an old runner and on every archived trace. */
      reasonCode?: 'upstream_no_output';
      /** The upstream node's BLOCK SLUG (not its node id). Optional for the same reason. */
      upstreamSlug?: string;
    }
  | {
      type: 'run_complete';
      runId: string;
      ts: number;
      totalMs: number;
      status: RunStatus;
      /** ABSENT for a caller below tenant_admin, like `node_success.cost`. */
      totals?: CostDelta;
    };

export interface FlowRun {
  id: string;
  flow_id: string;
  triggered_by: string;
  status: RunStatus;
  trace: TraceEvent[];
  total_ms: number | null;
  total_cost_usd: string;
  tokens_in: number;
  tokens_out: number;
  llm_calls: number;
  started_at: string;
  finished_at: string | null;
}

export function zeroCost(): CostDelta {
  return { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 };
}
