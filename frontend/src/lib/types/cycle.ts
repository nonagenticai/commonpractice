// src/lib/types/cycle.ts — the marketplace weekly cycle (backend/src/routes/cycle.ts +
// the cycle field folded into /api/home/summary).
export type CyclePhase = 'voting' | 'solution_phase' | 'closed';

/** A competition period's kind (backend/src/host/period.ts). */
export type PeriodKind = 'week' | 'month' | 'quarter' | 'year';
/** The platform voting-cycle cadence (`cycle.cadence` policy). `off` = no periods, no winners. */
export type CycleCadence = PeriodKind | 'off';

/** `cadence` on /api/home/summary: `effective` governs the screens; `setting` is the next period's. */
export interface CadenceInfo {
	setting: CycleCadence;
	effective: CycleCadence;
}

/** GET /api/cycle/cadence (backend/src/routes/cycle.ts `getCadence`). */
export interface CadenceStatus {
	setting: CycleCadence;
	effective: CycleCadence;
	/** True while a change waits for the running period to end. */
	pending: boolean;
	/** When the setting takes over (00:00 UTC on a period boundary), while a switch is pending. */
	effectiveFrom: string | null;
}

export interface CycleState {
	/** The period KEY ('2026-W41' | '2026-10' | '2026-Q4' | '2026') — the field kept its old name. */
	week: string;
	/** Optional only so an older backend mid-rollout still type-checks; absent means 'week'. */
	periodKind?: PeriodKind;
	periodKey?: string;
	periodStart?: string;
	phase: CyclePhase;
	votingEndsAt: string;
	solutionEndsAt: string;
	closesAt: string;
	// present on /api/cycle/current (omitted from the home-summary fold)
	closedAt?: string | null;
	// NOTE: no winnerSolutionId / stats here. The cycle is the platform-wide phase clock;
	// winners are per-tenant (weekly_winners) and come from /api/winner, which resolves them
	// under the caller's own scope. The backend stopped serving those two fields in 0047.
}

export interface CycleAdvanceRequest {
	week?: string;
	to?: 'solution_phase' | 'closed';
	force?: boolean;
}

/** One entry of a workspace's voting-schedule history (GET /api/tenant/cycle-cadence). */
export interface TenantCadenceChange {
	id: string;
	oldValue: string | null;
	newValue: CycleCadence;
	/** True when the admin switched back to the platform default (`newValue` = that default then). */
	followsPlatform: boolean;
	effectiveFrom: string | null;
	createdAt: string;
	/** Display name of who changed it; null = System (or an account no longer visible). */
	actorName: string | null;
}

/** GET/PATCH /api/tenant/cycle-cadence — the workspace's own voting schedule (tenant_admin). */
export interface TenantCadence {
	/** The workspace's own choice; null = it follows the platform default. */
	value: CycleCadence | null;
	platformDefault: CycleCadence;
	/** What runs now — the same value /api/me carries as `cycleCadence`. */
	effectiveValue: CycleCadence;
	/** What takes over at `effectiveFrom`, while a change is pending. */
	pendingValue: CycleCadence | null;
	effectiveFrom: string | null;
	followsPlatform: boolean;
	/** Newest first, at most 10. */
	history: TenantCadenceChange[];
	/** PATCH only: false when the value was already in force (nothing written). */
	changed?: boolean;
}
