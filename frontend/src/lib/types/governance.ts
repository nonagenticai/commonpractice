// src/lib/types/governance.ts — 1:1 with /api/governance payloads.
export type PolicyControl = 'toggle' | 'number' | 'select' | 'list' | 'map';
/** `map` = a string→string dictionary with a fixed key set (e.g. models.work_tiers). */
export type PolicyValue = boolean | number | string | string[] | Record<string, string>;

/**
 * What actually backs a rail — 1:1 with `backend/src/host/policy-enforcement.ts`.
 *
 *   'enforced'      — a run, a brokered call, a publish or a promotion is refused on this rail.
 *   'applied'       — a live setting: an edit changes the next run or call, but nothing is refused
 *                     for it and no refusal names it. Editable, like 'enforced'.
 *   'architectural' — true because of how the platform is built; the switch changes nothing.
 *   'retired'       — the claim is withdrawn; the rail is read-only and kept only for history.
 */
export type PolicyEnforcement = 'enforced' | 'applied' | 'architectural' | 'retired';

export interface Policy {
	key: string;
	category: string;
	/**
	 * @deprecated Seeder English from `policies.label`. The screen renders `policyLabel(key)`.
	 * ⛔ Never read, and never as a `?? policy.label` fallback — see $lib/i18n/policy-label.ts.
	 */
	label: string;
	/** @deprecated Seeder English from `policies.description`. See `label`. */
	description: string;
	control: PolicyControl;
	value: PolicyValue;
	options: string[] | null;
	unit: string | null;
	enabled: boolean;
	/**
	 * What backs this rail, from `backend/src/host/policy-enforcement.ts`.
	 *
	 * ⚠️ OPTIONAL ON PURPOSE, for exactly the reason `ComplianceItem.key` below is. The browser
	 * reaches the API through the SERVICE, which load-balances across old and new pods for the
	 * length of a roll, so a NEW frontend really is answered by a PRE-CHANGE backend that sends no
	 * `enforcement` at all. Typing it as required would have `tsc` assert a field the wire does not
	 * send and would make an un-narrowed read look safe.
	 *
	 * ⛔ AND THE FALLBACK IS "SAY NOTHING", NEVER "ASSUME ENFORCED". `governance/+page.svelte`
	 * renders a payload without this field as ONE ungrouped list with no enforcement headings —
	 * i.e. exactly the pre-change screen — because a screen that silently files every rail under
	 * "Enforced at the boundary" during a roll is the original defect, restored.
	 */
	enforcement?: PolicyEnforcement;
	/**
	 * When the PLATFORM's pending switch of this rail takes over (today only `cycle.cadence`), else
	 * null. ⛔ Not GET /api/cycle/cadence — that answers for the caller's own workspace (0110).
	 * Optional: a pre-change backend sends none during a roll, and the screen then shows no date.
	 */
	effectiveFrom?: string | null;
}

export interface PolicyGroup {
	category: string;
	/** @deprecated English heading. The screen renders `policyGroupTitle(category)`. */
	title: string;
	policies: Policy[];
}

export interface ComplianceItem {
	/**
	 * Row identity and the key the panel renders from — `complianceLabel` in $lib/i18n.
	 *
	 * ⚠️ OPTIONAL ON PURPOSE, and it must stay optional until the backend change that introduced
	 * it is fully rolled out. A pre-change backend sends no `key` at all, and during a rolling
	 * deploy a new frontend does reach an old pod through the Service. Typing it as required would
	 * have `tsc` assert a field the wire does not send and would make the un-narrowed `c.key` read
	 * look safe — which is how the whole page came to blank out on `each_key_duplicate`.
	 */
	key?: string;
	/** State key — `passing` | `documented` | `reassess`. NOT one-per-row: two rows are `passing`. Optional for the same reason as `key`. */
	statusKey?: string;
	/**
	 * English prose from `backend/src/routes/governance.ts` COMPLIANCE.
	 *
	 * ⚠️ NOT dead, unlike `Policy.label`: this is the OLD-BACKEND FALLBACK the panel renders when
	 * `key` is absent, and the `{#each}` key when it is. Read it only through `complianceLabel` /
	 * `complianceRowKey`, which encode when that is legitimate. Delete both fields, and the
	 * fallback branch, one deploy after the backend is fully rolled out.
	 */
	label: string;
	/** English prose. The old-backend fallback for `statusKey` — see `label`. */
	status: string;
	tone: string;
}

export interface RecentChange {
	id: string;
	policyKey: string;
	/** @deprecated The English policy name. The list renders `policyLabel(policyKey)`. */
	label: string;
	oldValue: PolicyValue | null;
	newValue: PolicyValue | null;
	actor: { name: string; initials: string } | null;
	createdAt: string;
}

export interface ExportRun {
	date: string;
	status: 'running' | 'success' | 'error';
	rowCount: number;
	objectKey: string | null;
	bucket: string | null;
	sha256: string | null;
	bytes: number;
	triggeredBy: 'scheduler' | 'manual';
	error: string | null;
	finishedAt: string | null;
	createdAt: string;
}

export interface ExportStatus {
	enabled: boolean;
	bucket: string;
	hourUtc: number;
	lastRun: ExportRun | null;
	recent: ExportRun[];
}

export interface ExportResult {
	date: string;
	status: 'success' | 'error' | 'skipped';
	reason?: string;
	rowCount?: number;
	objectKey?: string;
	bucket?: string;
	sha256?: string;
	error?: string;
}

export interface Governance {
	groups: PolicyGroup[];
	compliance: ComplianceItem[];
	recentChanges: RecentChange[];
	exportStatus: ExportStatus;
}
