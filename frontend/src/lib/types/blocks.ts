// src/lib/types/blocks.ts — 1:1 mirror of backend/src/db/block-types.ts plus the
// API response shapes returned by /api/blocks. Keep in sync with the backend.
import * as m from '$lib/paraglide/messages';
import type { ErrorKind, LogLevel, BlockErrorDetail } from './trace';

export type FieldType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'json'
	| 'string[]'
	| 'enum'
	| 'dataset';

export interface FieldSpec {
	type: FieldType;
	required?: boolean;
	enum?: string[];
	pii?: boolean;
	description?: string;
	/** Default node-config value (v1: a dataset-typed input's default slug; host injects it). */
	default?: string;
	/** Display label in the author's words. The key stays the wire identifier. */
	label?: string;
}

/**
 * ⛔ TWO BITS, NOT ONE. `mockData` is a CLAIM ABOUT THE OUTPUT ("a run of this returns invented
 * sample data") and is what the `block_simulated_badge` renders from; `dataset` is an ACCESS GRANT
 * ("may read the tenant's REAL datasets via ctx.dataset") and must NEVER drive that badge. They were
 * one flag until `load-dataset` — which reads the tenant's own uploaded rows — had to declare
 * `mockData` just to pass the executor's dataset gate, and would then have been badged "Simulated".
 * See backend/src/db/block-types.ts for the full note; keep the two files in sync.
 */
export interface BlockCapabilities {
	network?: boolean;
	llm?: boolean;
	/** ⚠️ Fabrication bit — user-visible. Drives the "Simulated" badge. */
	mockData?: boolean;
	/** ⚠️ Access grant, NOT a fabrication bit. Never render honesty copy from this. */
	dataset?: boolean;
}

export interface BlockDescriptor {
	inputs: Record<string, FieldSpec>;
	outputs: Record<string, FieldSpec>;
	capabilities: BlockCapabilities;
	limits?: { timeoutMs?: number; memMb?: number };
}

export interface BlockExample {
	name: string;
	inputs: Record<string, unknown>;
	expectedOutputs?: Record<string, unknown>;
}

export type BlockCategory = 'data' | 'ai' | 'logic' | 'output' | 'ui';
export type BlockStatus = 'draft' | 'beta' | 'stable' | 'deprecated';

/** Block ownership (Phase 2 dual ownership): platform-shipped vs tenant-authored. */
export type BlockOwner = 'global' | 'tenant';

/** A card row from GET /api/blocks. */
export interface BlockListItem {
	slug: string;
	name: string;
	description: string;
	category: BlockCategory;
	owner: BlockOwner;
	/** Provenance: set when this block was derived from an ontology entity (Phase 3). */
	source_entity_key?: string | null;
	region: string | null;
	cost_class: string | null;
	version: string | null;
	status: BlockStatus | null;
	/**
	 * The display version's `descriptor.capabilities.mockData`, projected onto the card row by
	 * `routes/blocks.ts` because the list payload carries no descriptor.
	 *
	 * TRUE means the block answers from `ctx.mockData()` — a deterministic fixture generated inside
	 * the runner — so a run of it produces sample data, not a real result. Every surface that
	 * presents a block renders `block_simulated_badge` from this.
	 *
	 * ⚠️ OPTIONAL ON THE WIRE, AND IT MUST STAY OPTIONAL. Mid-rolling-deploy the browser can hold a
	 * payload from a backend that predates the field; `?? false` at every read site means such a
	 * card is UNBADGED rather than crashing. That is the safe direction only because the badge is
	 * additive information — never treat its absence as proof a block is real.
	 *
	 * ⛔ IT IS `mockData` AND NOT `dataset`, AND THERE IS NO `dataset` TWIN OF THIS FIELD ON PURPOSE.
	 * `capabilities.dataset` grants access to the tenant's REAL uploaded rows; it is not a claim
	 * about the output and has no place on a card. A block declaring only `dataset` — `load-dataset`
	 * and every ontology-derived data block — arrives here as `false` and must stay unbadged.
	 */
	mock_data?: boolean;
	usage_count: number;
	maintainer: { name: string; initials: string } | null;
	created_at: string;
}

export interface BlockVersion {
	id: string;
	block_id: string;
	version: string;
	status: BlockStatus;
	language: 'typescript';
	docs_md: string;
	source_ts: string;
	descriptor: BlockDescriptor;
	examples: BlockExample[];
	changelog: string;
	tests_passing: boolean;
	/** Real uses of the BLOCK (not of this version) — trace events carry a slug, never a version,
	 *  so the backend serves the block's trace-derived count on every version row. Prefer
	 *  `BlockDetail.usageCount`; this stays for older payloads. */
	usage_count: number;
	published_by: string | null;
	published_at: string | null;
	created_at: string;
	/** Resolved publisher (from published_by) for the history sidebar; null if unknown/draft. */
	author?: { name: string; initials: string } | null;
}

/** Full detail from GET /api/blocks/:slug. */
export interface BlockDetail {
	id: string;
	slug: string;
	name: string;
	description: string;
	category: BlockCategory;
	current_version_id: string | null;
	maintainer_id: string | null;
	owner: BlockOwner;
	source_entity_key?: string | null;
	region: string | null;
	cost_class: string | null;
	license: string | null;
	archived: boolean;
	created_at: string;
	updated_at: string;
	maintainer: { id: string; name: string; initials: string } | null;
	versions: BlockVersion[];
	/** Total real uses of this block, counted from flow-run traces — the same source as
	 *  `usageTrend`/`consumers`. Optional: absent from a backend still on the previous build. */
	usageCount?: number;
	consumers?: BlockConsumer[];
	/**
	 * How many flows ran this block in the last 30 days IN TOTAL, before `consumers` was cut to the
	 * top six (`routes/blocks.ts`, `count(*) OVER ()` — a window evaluated ahead of the `LIMIT`).
	 *
	 * ⚠️ OPTIONAL, and the render site must treat an absent value as "no cap to disclose": a backend
	 * one deploy behind sends `consumers` and no total, and inventing a cap notice out of
	 * `consumers.length === 6` would claim a truncation that may not have happened.
	 */
	consumersTotal?: number;
	usageTrend?: BlockUsagePoint[];
	/**
	 * Port labels resolved for the reader's locale, for every port of every version. A port absent
	 * here has no label anywhere (humanize its key). Optional: absent from an older backend.
	 */
	portLabels?: { inputs: Record<string, string>; outputs: Record<string, string> };
}

export interface BlockUsagePoint {
	day: string;
	runs: number;
}

export interface BlockConsumer {
	flowId: string;
	flowName: string;
	solutionId: string | null;
	solutionTitle: string | null;
	runs: number;
}

/**
 * One hit from the save-time static scanner (backend/src/exec/static-scan.ts).
 *
 * `message` is the backend's ENGLISH sentence and is NOT what the reader sees — `scanFindingLabel`
 * ($lib/i18n/scan-finding-label) turns `rule` + the machine fields into the reader's locale, and
 * only falls back to `message`. `spec`/`detail` are the machine fields that localized sentence has
 * to interpolate; both are optional because an old backend, mid-rolling-deploy, ships neither.
 */
export interface ScanFinding {
	rule: string;
	message: string;
	line?: number;
	/** The module specifier — `no-require`, `banned-import`, `import-not-allowlisted`. */
	spec?: string;
	/** The transpiler's own error text — `syntax`. The catalog entry WRAPS it. */
	detail?: string;
}

// ---- Phase 2-B: lint (scan + tsc) + per-block tests ----

export interface LintFinding {
	/**
	 * ⛔ THE DISCRIMINANT `scanFindingLabel` BRANCHES ON FIRST. `scan` is a closed thirteen-rule
	 * vocabulary and is translated; `type` carries a `TS####` code and tsc's own English diagnostic,
	 * which is unbounded and is passed through verbatim.
	 */
	source: 'scan' | 'type';
	rule: string;
	message: string;
	line?: number;
	col?: number;
	/** Scan-only. See `ScanFinding.spec`. */
	spec?: string;
	/** Scan-only. See `ScanFinding.detail`. */
	detail?: string;
}

export interface LintResult {
	ok: boolean;
	findings: LintFinding[];
}

export type AssertMode = 'exact' | 'subset';
export type BlockTestStatus = 'pass' | 'fail' | 'error';

export interface BlockTestLastResult {
	status: BlockTestStatus;
	actual: Record<string, unknown> | null;
	/** ⛔ The backend's English, and the guaranteed fallback. See `BlockErrorDetail`. */
	error: string | null;
	/**
	 * ⛔ THE HALF THAT SURVIVES A REFRESH. `routes/blocks.ts` `listTests` re-reads
	 * `block_test_results` (migration 0072) into this shape on every /block-edit page load. NULL for
	 * every row written before 0072, and NULL whenever the text is a block author's own throw.
	 */
	error_rule: string | null;
	error_detail: BlockErrorDetail | null;
	duration_ms: number;
	run_at: string;
}

export interface BlockTest {
	id: string;
	name: string;
	description: string | null;
	inputs: Record<string, unknown>;
	datasets: string[];
	expected: Record<string, unknown> | null;
	assert_mode: AssertMode;
	expect_error: boolean;
	expected_error_kind: string | null;
	enabled: boolean;
	created_at: string;
	updated_at: string;
	last_result: BlockTestLastResult | null;
}

export interface BlockTestDiff {
	path: string;
	kind: 'missing' | 'mismatch' | 'unexpected';
	expected?: unknown;
	actual?: unknown;
}

/** Streamed per-test result + the shape persisted in last_result. */
export interface BlockTestOutcome {
	testId: string;
	name: string;
	status: BlockTestStatus;
	actual: Record<string, unknown> | null;
	error: string | null;
	/** The streamed twin of `BlockTestLastResult.error_rule` / `.error_detail`. */
	errorRule?: string | null;
	errorDetail?: BlockErrorDetail | null;
	diffs: BlockTestDiff[];
	durationMs: number;
}

export interface BlockTestRunSummary {
	versionId: string;
	total: number;
	passed: number;
	testsPassing: boolean;
	results: BlockTestOutcome[];
}

/** Phase 2: result of a one-off `POST .../simulate` (no test saved). Mirrors the
 *  backend SimulateOutcome + the echoed `inputs` the run actually used. */
export interface SimulateResult {
	status: 'ok' | 'error';
	outputs: Record<string, unknown> | null;
	logs: { level: LogLevel; msg: string }[];
	error: {
		kind: ErrorKind;
		message: string;
		/** ABSENT ⇒ the message is the block author's own words. Forwarded UNWRAPPED from the node. */
		rule?: string;
		detail?: BlockErrorDetail;
	} | null;
	/** ABSENT below tenant_admin: the server strips spend (backend run-cost-visibility.ts). */
	cost?: { usd: number; tokensIn: number; tokensOut: number; llmCalls: number };
	durationMs: number;
	/** The inputs the run used (developer's inputs merged over examples + defaults). */
	inputs: Record<string, unknown>;
}

export interface CreateBlockTestBody {
	name: string;
	description?: string;
	inputs?: Record<string, unknown>;
	datasets?: string[];
	expected?: Record<string, unknown> | null;
	assert_mode?: AssertMode;
	expect_error?: boolean;
	expected_error_kind?: string | null;
	enabled?: boolean;
}

// Color/badge mapping only. Labels are localized — resolve via categoryLabel().
export const CATEGORY_META: Record<BlockCategory, { badge: string }> = {
	data: { badge: 'teal' },
	ai: { badge: 'violet' },
	logic: { badge: 'amber' },
	output: { badge: 'coral' },
	ui: { badge: 'teal' }
};

/** Localized display label for a block category (paraglide-backed). */
export function categoryLabel(cat: BlockCategory): string {
	switch (cat) {
		case 'data':
			return m.category_data();
		case 'ai':
			return m.category_ai();
		case 'logic':
			return m.category_logic();
		case 'output':
			return m.category_output();
		case 'ui':
			return m.category_ui();
	}
}

/**
 * Localized display label for a block's lifecycle status (paraglide-backed).
 *
 * ⛔ THE DEFECT. The card grid rendered `{b.status ?? m.blocks_status_draft()}` — so exactly ONE
 * of the four `block_status` enum values was ever translated. A Dutch library read
 * "v3 · stable" next to "v1 · concept": the null case went through the catalog and the three
 * real database values went straight to the screen in English. `block_versions.status` is a
 * pg enum; the wire carries the ENUM and the browser owns the words, same rule as `stageLabel`.
 *
 * Takes `string | null | undefined` rather than `BlockStatus` because `BlockListItem.status` is
 * nullable on the wire and the backend column is an enum the frontend union only MIRRORS —
 * a value added server-side must ship an ugly word, never an English sentence, so the default
 * branch returns the RAW KEY. `null`/absent keeps its established meaning: an unpublished draft.
 */
export function blockStatusLabel(status: string | null | undefined): string {
	switch (status) {
		case 'stable':
			return m.blocks_status_stable();
		case 'beta':
			return m.blocks_status_beta();
		case 'deprecated':
			return m.blocks_status_deprecated();
		case 'draft':
		case null:
		case undefined:
			return m.blocks_status_draft();
		default:
			return status;
	}
}
