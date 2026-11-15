// src/lib/types/pipeline.ts — 1:1 with /api/pipeline payloads.
export type Stage = 'review' | 'hardening' | 'staging' | 'production';

export interface PipelineCard {
	id: string;
	title: string;
	solutionId: string | null;
	/** The originating challenge's display code (via solution → challenge); null if unlinked. */
	challengeCode: string | null;
	/** The originating challenge's id, so the code badge can deep-link to the challenge. */
	challengeId: string | null;
	author: { name: string; initials: string } | null;
	stage: Stage;
	week: string | null;
	rolloutPct: number;
	progress: { day?: number; ofDays?: number } | null;
	/**
	 * ⚠️ DISPLAY CACHES. `reviewed` / `reviewerCount` / `reviewedBy` / `reviewedAt` are columns on
	 * `pipeline_items` that the backend maintains alongside the real review rows. The promotion
	 * gate does NOT read them (migration 0062) — it counts `pipeline_reviews` server-side — so
	 * treat these as rendering hints and `reviewers` below as the truth.
	 */
	reviewed: boolean;
	reviewerCount: number;
	/** Who most recently reviewed the card; null until approved. */
	reviewedBy?: { name: string; initials: string } | null;
	reviewedAt?: string | null;
	/**
	 * The real, distinct reviewers (0062). OPTIONAL, and every read must use a `??` fallback: a
	 * NEW frontend briefly talks to an OLD backend on every roll (separate images), and an
	 * unguarded read of a field the old backend never sent throws and blanks the whole page.
	 */
	reviewers?: { id: string; name: string; initials: string; at: string }[];
	/** Has the CALLING admin already reviewed this card? Drives approve-vs-withdraw. Optional. */
	myReview?: boolean;
	/** Is the calling admin this card's author? They may not review their own work. Optional. */
	isAuthor?: boolean;
	featured: boolean;
	live: boolean;
	position: number;
}

export interface PipelineColumn {
	stage: Stage;
	title: string;
	count: number;
	items: PipelineCard[];
}

export interface PipelineMetrics {
	/** Cards that have NEVER been live: `stage !== 'production' && !live_at`. A rolled-back card is
	 *  NOT in here (it did go live) and is not in `inProduction` either — these four numbers are
	 *  four independent facts about the board, not a partition of it. */
	inPipeline: number;
	inProduction: number;
	/** Rollbacks in the CURRENT QUARTER (UTC boundary), matching the "this quarter" sub-label. */
	rolledBack: number;
	/** ⛔ LEGACY, whole days, `Math.round`, `0` when nothing shipped. Kept so a NEW frontend talking
	 *  to an OLD backend still has something to render. Only read when `liveCount` is `undefined`;
	 *  never use its magnitude as a "do we have data" test — a 41-minute ship is `0` here, which is
	 *  exactly how "avg time to live —, none live yet" came to sit beside "in production 1". */
	avgTimeToLiveDays: number;
	/** How many cards have ever been live — the DATA-EXISTENCE fact, and the only thing the stat
	 *  card may branch on.
	 *
	 *  OPTIONAL because an old backend does not send it: a new frontend talks to a not-yet-rolled
	 *  backend for the length of every deploy (same rule as `PipelinePolicy` below). `undefined`
	 *  here means "the backend cannot tell me", which is a different question from "nothing has
	 *  shipped" (that is `liveCount === 0`). */
	liveCount?: number;
	/** Mean (live_at − created_at) across live cards, in MILLISECONDS — the browser picks the unit.
	 *
	 *  Two distinct absences, deliberately not collapsed: `undefined` = old backend, fall back to
	 *  `avgTimeToLiveDays`; `null` = new backend, nothing has shipped. `0` is neither — it is a
	 *  legitimate duration, and using it as an absence marker is the conflation being fixed. */
	avgTimeToLiveMs?: number | null;
}

/** The governance policy the board renders against (0062), so a card can show "1 of 2" without a
 *  second round-trip. OPTIONAL for the same deploy-ordering reason as the card fields above —
 *  `board.policy.requiredReviewers` read unguarded against an old backend throws and blanks the
 *  page, so every consumer must go through a `??` fallback. */
export interface PipelinePolicy {
	mandatoryReview: boolean;
	requiredReviewers: number;
}

export interface PipelineBoard {
	columns: PipelineColumn[];
	metrics: PipelineMetrics;
	policy?: PipelinePolicy;
}

export interface PipelinePatch {
	stage?: Stage;
	rolloutPct?: number;
	/** `true` records ONE review by the calling admin (idempotent); `false` withdraws their own. */
	reviewed?: boolean;
	/**
	 * ⛔ DO NOT SEND THIS. It is the defect migration 0062 removed: the browser used to assert the
	 * reviewer count (`reviewerCount: 2`, hard-coded) and the backend gated production deploys on
	 * it, so one click by one admin satisfied "2 reviewers required". The backend still ACCEPTS the
	 * field — removing it from its `.strict()` schema would 422 every OLD frontend's Approve click
	 * during a roll — but it is inert and ignored. The count is derived from real review rows.
	 * Kept in the type only so the field is documented rather than silently reintroduced.
	 * @deprecated inert since 0062; remove once no client sends it.
	 */
	reviewerCount?: number;
}
