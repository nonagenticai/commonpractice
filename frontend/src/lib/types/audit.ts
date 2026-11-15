// src/lib/types/audit.ts — 1:1 with /api/audit payloads.
export type AuditTone = 'ok' | 'warn' | 'error' | null;

export interface AuditItem {
	id: string;
	action: string;
	category: string;
	targetType: string;
	targetId: string | null;
	result: string | null;
	/**
	 * The flow-summary CODE for this row, when it has one — the same vocabulary
	 * `FlowSnapshotSummary.summary_code` carries, derived by `backend/src/routes/audit.ts` from the
	 * `metadata` jsonb `recordAudit` already persists.
	 *
	 * ⛔ WHY THIS EXISTS. `result` is English prose the server composed ("Manual checkpoint",
	 * "Restored snapshot from 2026-08-07T09:12:44.031Z"), and /build renders the SAME EVENT through
	 * `flowSummaryLabel`. A Dutch reader got "Handmatig checkpoint" on /build and "Manual
	 * checkpoint" on /audit for one checkpoint. The wire carries the code; the browser owns the
	 * words — the split `flow-summary-label.ts` documents at length.
	 *
	 * ⚠️ OPTIONAL, AND `string` RATHER THAN THE BACKEND'S NINE-VALUE UNION, for two different
	 * reasons. Optional: an OLD pod mid-roll ships neither field and the row must still typecheck
	 * and render exactly as it does today. Widened: a tenth code shipped backend-first must degrade
	 * to its own English sentence via `flowSummaryLabel`'s `default:` branch, never render a bare
	 * `flow_summary_forked` token.
	 *
	 * ⚠️ `null` IS A FACT, NOT AN ABSENCE OF ONE. A checkpoint whose text the USER TYPED is written
	 * with no code on purpose (backend/src/routes/flows.ts) so their own words come back verbatim in
	 * whatever language they typed. That branch produces new code-less rows every day.
	 */
	resultCode?: string | null;
	/** Machine fields the coded sentence interpolates (`{ at }` for the restore). Raw, never
	 *  pre-formatted — `flowSummaryLabel` falls back to `result` when a field it needs is missing. */
	resultParams?: Record<string, unknown> | null;
	resultTone: AuditTone;
	createdAt: string;
	/**
	 * `null` when NO HUMAN wrote the row — a sweeper, a cron, a webhook.
	 *
	 * ⛔ THE BACKEND USED TO ANSWER THIS WITH `{ name: 'System', initials: 'SYS' }`, an English noun
	 * manufactured on a server that cannot know who is reading. Every consumer of this field renders
	 * it inside otherwise-localized copy, so a Dutch reader got "System · Aangepaste entiteit
	 * aangemaakt · 2u geleden". The absence is now the fact on the wire and `m.audit_actor_system()`
	 * is the word for it — the same shape `GovernanceChange.actor` (types/governance.ts) already had.
	 *
	 * ⚠️ NULLABLE ALSO COVERS THE MID-ROLL: an old pod still ships `{ name: 'System' }`, which every
	 * consumer renders unchanged, so a rolling deploy degrades to today's behaviour rather than to a
	 * blank cell.
	 */
	actor: { name: string; initials: string } | null;
}

export interface AuditFeed {
	items: AuditItem[];
	total: number;
	page: number;
	pageSize: number;
	counts: Record<string, number>;
}

// ---------------------------------------------------------------------------------------------
// Categories.
//
// ⛔ THE DEFECT. The feed rendered FIVE chips — sandbox, block, policy, deploy, auth — beside an
// "All events" count that sums EVERY category, so the header arithmetic visibly did not add up:
// `data` alone is the busiest writer in the product (31 recordAudit call sites vs `policy`'s 2),
// and `system` (11) and `tenant` (7) were equally unreachable. Their rows DID render — as grey
// `outline` badges in the table — but nothing could filter to them, `?category=data` was
// discarded twice without a signal (once by the chip guard here, once by the backend's own
// CATEGORIES allowlist), and the two numbers on screen contradicted each other.
//
// ⚠️ THIS LIST IS HALF OF A CONTRACT. The other half is `CATEGORIES` in
// `backend/src/routes/audit.ts`, which is what actually filters and what zeroes the per-category
// counts. A value present here but absent there renders a chip that always reads 0; a value
// present there but absent here is a filterable category with no way to click it. The two are
// kept in step by `audit-categories.backend-contract.test.ts`, which walks the backend source and
// diffs BOTH directions against the categories `recordAudit` is actually called with.
//
// Order is the chip render order: the five original chips first (so the demo walk sees no
// reshuffle), then the three that were missing.
export const AUDIT_CATEGORIES = [
	'sandbox',
	'block',
	'policy',
	'deploy',
	'auth',
	'data',
	'system',
	'tenant'
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * Badge tone per category (colour only — the badge's TEXT is `item.action`, never the category).
 *
 * `auth` and `system` deliberately share `outline`: they were the two the demo palette never gave
 * a colour to, and inventing one now would recolour rows a reviewer has already seen. `data` and
 * `tenant` get their own tones because they are new on screen and `outline` is already the
 * fallback for anything unrecognised — three categories collapsing onto it would make the badge
 * stop distinguishing exactly where the feed is busiest.
 */
export const AUDIT_BADGE: Record<AuditCategory, string> = {
	sandbox: 'violet',
	block: 'teal',
	policy: 'amber',
	deploy: 'coral',
	auth: 'outline',
	data: 'emerald',
	system: 'outline',
	tenant: 'slate'
};

export interface AuditQuery {
	category?: string;
	/** Preset relative window (today | 7d | 30d | all) or 'custom' with from/to. */
	range?: string;
	/** Inclusive start date (YYYY-MM-DD), used when range === 'custom'. */
	from?: string;
	/** Inclusive end date (YYYY-MM-DD), used when range === 'custom'. */
	to?: string;
	q?: string;
	page?: number;
}
