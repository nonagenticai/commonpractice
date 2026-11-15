// src/lib/types/ops.ts — 1:1 with the backend Ops dashboard payload
// (backend/src/host/ops-metrics.ts). All values are real aggregates.
export interface DashboardStats {
	activeSandboxes: number;
	dailyLlmCalls: number;
	spendTodayUsd: number;
	p95LatencyMs: number | null;
}

export interface HealthBucket {
	hourTs: string;
	activeRuns: number;
	llmCalls: number;
}

export interface TopBlock {
	slug: string;
	/** The block's human name for the bar label. OPTIONAL here while the backend's is
	 *  `string | null`, on purpose: a mid-roll response from an old pod carries no `name` at all,
	 *  and every call site must therefore write `b.name ?? b.slug`. The nullable-and-optional
	 *  union is the honest shape — a deleted or renamed block has no `building_blocks` row, so
	 *  even a current pod answers null. */
	name?: string | null;
	category: string | null;
	count: number;
	pct: number;
}

/**
 * ⛔ `title` / `detail` / `text` ARE NOT DEAD FIELDS, AND THEY ARE REQUIRED ON PURPOSE.
 *
 * They are the backend's ENGLISH prose. `$lib/i18n/ops-alert-label` and `ops-event-label` are what
 * a reader sees now — but the backend keeps shipping these, byte-identical, for one deploy, and
 * they are the ONLY thing the label functions can return when a mid-roll response carries no
 * machine fields. Declaring them optional would let a call site drop the fallback and typecheck.
 *
 * ⛔ EVERY MACHINE FIELD BELOW IS OPTIONAL, ALSO ON PURPOSE. The browser reaches the API through
 * the k8s SERVICE, which load-balances across old and new pods for the length of a rolling
 * deploy, so a NEW frontend really is answered by an OLD pod whose alerts carry prose and nothing
 * else. `types/governance.ts` declaring `key`/`statusKey` REQUIRED is precisely how tsc came to
 * assert a field the old wire does not send, and /governance blanked (PR #233, second commit).
 *
 * TODO(one deploy after this ships): make the machine fields required, delete `title`/`detail`/
 * `text`, and delete the legacy branch of each label function.
 */
interface AttentionItemBase {
	/** @deprecated backend English — the mid-roll fallback. Render via `opsAlertTitle`. */
	title: string;
	/** @deprecated backend English — the mid-roll fallback. Render via `opsAlertDetail`. */
	detail: string;
	href?: string;
}

export interface SandboxErrorAlert extends AttentionItemBase {
	kind: 'sandbox_error';
	/** The TRUE `COUNT(*)`, which is NOT `owners.length` — the sample is capped at 5. */
	errorCount?: number;
	owners?: { name: string; project: string | null }[];
}

export interface HighLatencyAlert extends AttentionItemBase {
	kind: 'high_latency';
	/** Raw milliseconds. No unit, no rounding — the browser owns both. */
	p95Ms?: number;
	thresholdMs?: number;
}

export interface BlockErrorsAlert extends AttentionItemBase {
	kind: 'block_errors';
	slug?: string;
	runCount?: number;
	windowDays?: number;
}

export type AttentionItem = SandboxErrorAlert | HighLatencyAlert | BlockErrorsAlert;

/** The prose every alert shape shares — the widening target for an unrecognised `kind`. */
export type AttentionItemProse = AttentionItemBase & { kind?: string };

interface FeedEventBase {
	actor: string;
	/** @deprecated backend English — the mid-roll fallback. Render via `opsEventText`. */
	text: string;
	ts: string;
	href?: string;
}

export interface BlockPublishedEvent extends FeedEventBase {
	kind: 'block_published';
	block?: string;
	version?: string;
}

export interface RunFinishedEvent extends FeedEventBase {
	kind: 'run_finished';
	flow?: string;
	/** The raw `flow_runs.status` enum — routed through `runStatusLabel`, not a new vocabulary. */
	runStatus?: string;
}

export interface SandboxSuspendedEvent extends FeedEventBase {
	kind: 'sandbox_suspended';
	/** Genuinely nullable, and `null` selects a DIFFERENT sentence — not an empty interpolation. */
	project?: string | null;
}

export type FeedEvent = BlockPublishedEvent | RunFinishedEvent | SandboxSuspendedEvent;

/** The prose every feed shape shares — the widening target for an unrecognised `kind`. */
export type FeedEventProse = FeedEventBase & { kind?: string };

export interface Dashboard {
	stats: DashboardStats;
	health: { buckets: HealthBucket[] };
	topBlocks: TopBlock[];
	attention: AttentionItem[];
	events: FeedEvent[];
}
