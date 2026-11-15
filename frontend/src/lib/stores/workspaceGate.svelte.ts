// src/lib/stores/workspaceGate.svelte.ts
//
// App-scoped WORKSPACE SUSPENSION GATE — the single source of truth for "has a platform operator
// suspended this workspace?". It is the sibling of `licenseGate.svelte.ts` and deliberately NOT a
// flag on it.
//
// The backend is the enforcer: the tenant-status gate answers HTTP 403 with the error code
// `tenant_suspended` on every gated route once an operator has suspended the caller's tenant (and
// 503 `tenant_status_unavailable` when the status could not be read at all). Without a UI branch
// the SPA renders that as a generic "you don't have permission" toast on a half-built shell, which
// tells the customer nothing true and looks like a bug in the product.
//
// ⛔ WHY THIS IS A SEPARATE STORE AND MUST STAY ONE.
// Folding suspension into `licenseGate.forcedBlocked` would reuse `LicenseBlocked.svelte`, and that
// screen's primary action is "Renew your licence" pointing at `/license-upgrade`. A suspended
// workspace's licence may be perfectly valid and fully paid; sending that customer to a renewal
// page is a false claim about why they are locked out AND a payment funnel that cannot unlock them.
// The two conditions are also independently settable, so a single boolean could not represent both.
// The precedence question ("which screen wins when both are set?") is answered once, in
// `routes/+layout.svelte`, not smeared across two stores.
//
// ⛔ WHY THERE IS NO POLL, NO STATUS ENDPOINT AND NO CTA.
// `licenseGate` polls `GET /api/license/status` because a licence expires on a clock and can be
// renewed by the customer mid-session — the app must notice both edges by itself. Suspension has
// neither property: it is set and cleared by a platform OPERATOR out-of-band, there is no
// tenant-facing endpoint that reports it, and there is nothing the person reading the block screen
// can press to lift it. A poll would therefore be a round-trip that can only ever confirm what the
// last 403 already said. Reinstatement is picked up by the retry button (a full reload), which is
// the honest affordance: the next request either 403s again or it doesn't.
//
// ⛔ WHY THE FLAG IS STICKY.
// It is set by the auth-fetch interceptor and cleared ONLY by a reload or a sign-out. It is
// deliberately NOT cleared on the next 2xx: the app fires many requests in parallel, and several of
// them hit endpoints the tenant gate exempts (health, session/profile, anything unscoped). A
// success from one of those arriving after a 403 from a gated one would tear the block down and the
// next gated request would raise it again — the flap loop `licenseGate.load()` has a long comment
// about avoiding. A one-way latch cannot flicker.
//
// NOTE: unlike `licenseGate`, this module imports NOTHING — no `authFetch` (no endpoint to call)
// and no `$app/navigation`, not even lazily. The block is a render branch in the root layout, never
// a `goto`; a navigation here is how you build a redirect loop against a gate that fires on every
// request. Keeping the module dependency-free also means the pure predicate below is importable in
// a node-env vitest worker with no DOM and no SvelteKit client runtime — which is precisely the
// `$app/*` mock flake that forced `licenseGate`'s lazy import.

/**
 * The backend tenant-lifecycle enforcement code that means "this workspace has been suspended by a
 * platform operator". Exported so the interceptor test can assert against the same literal the
 * production predicate reads, rather than a hand-retyped copy of it.
 *
 * ⚠️ `tenant_status_unavailable` (HTTP 503) is deliberately NOT here. That code means the gate could
 * not READ the tenant's status — a transport/infrastructure fault that fails closed, exactly like
 * `license_unavailable` on the licence side. Latching the suspension screen on it would tell a
 * perfectly active customer that an operator had suspended their workspace, which is a false
 * accusation that no reload can clear as long as the outage lasts. A 503 stays a transient error and
 * is surfaced by the normal error path.
 */
export const TENANT_SUSPENDED_CODE = 'tenant_suspended';

/**
 * Does this thrown value carry the workspace-suspension refusal?
 *
 * Structural (`status` + `code`) rather than `instanceof ApiError`, for the same reason
 * `isSuspendedResponse` above is a pure predicate: this module deliberately imports NOTHING, so it
 * stays loadable in a node-env vitest worker with no DOM and no SvelteKit runtime. Importing the
 * error class here would drag `api/admin.ts` — and with it `auth-fetch`, which imports THIS module —
 * into a cycle.
 *
 * Used by the auth store to tell an EXPLAINED state apart from a failure: a suspended workspace is
 * not a profile that failed to load, and must not be logged or described as one.
 */
export function isSuspendedApiError(e: unknown): boolean {
	if (typeof e !== 'object' || e === null) return false;
	const { status, code } = e as { status?: unknown; code?: unknown };
	return status === 403 && code === TENANT_SUSPENDED_CODE;
}

/**
 * Pure predicate (exported for the auth-fetch interceptor + its test): does this response mean the
 * tenant-status gate rejected the request because the workspace is suspended?
 *
 * Both halves are load-bearing and the test asserts both directions:
 *   - the STATUS must be 403 — a 402 carrying this code is not this gate, and matching on the code
 *     alone would let an unrelated payload flip the SPA into a full-screen block;
 *   - the CODE must be exactly `tenant_suspended` — a 403 is the app's ordinary "you may not do
 *     that" answer (role checks, ownership checks), and matching on the status alone would replace
 *     every permission error in the product with a "your workspace is suspended" wall.
 *
 * Kept free of any rune/DOM/module state so it is testable as a plain function.
 */
export function isSuspendedResponse(status: number, errorCode: string | undefined): boolean {
	return status === 403 && errorCode === TENANT_SUSPENDED_CODE;
}

/**
 * The tenant-route refusal for a signed-in person CP has not seated in any workspace (no `users`
 * row, `tenant_id` NULL, or tombstoned). Like suspension it is a whole-app state, not a permission
 * toast: the root layout renders `NoWorkspace.svelte` (pending invites + sign-out) instead.
 */
export const NO_WORKSPACE_CODE = 'no_workspace';

/** Pure predicate for the auth-fetch interceptor: 403 AND the exact code, for the reason
 *  `isSuspendedResponse` requires both. */
export function isNoWorkspaceResponse(status: number, errorCode: string | undefined): boolean {
	return status === 403 && errorCode === NO_WORKSPACE_CODE;
}

export class WorkspaceGate {
	/**
	 * Sticky: set once a live request returned 403 `tenant_suspended`, and never unset by a
	 * subsequent success (see the module docblock — a one-way latch cannot flap). The only exits are
	 * a full page reload (the Retry button) and sign-out.
	 */
	isSuspended = $state(false);

	/**
	 * Called by auth-fetch when `isSuspendedResponse()` matched. Idempotent by construction: it sets
	 * one boolean and kicks nothing off, so the dozen parallel requests that all 403 during the same
	 * tick cost nothing beyond the first.
	 */
	handleSuspended(): void {
		this.isSuspended = true;
	}

	/**
	 * Set once a live request returned 403 `no_workspace`. Unlike suspension it has an in-app exit:
	 * accepting an invite clears it (`clearNoWorkspace`) after `/api/me` confirms the new seat.
	 */
	noWorkspace = $state(false);

	handleNoWorkspace(): void {
		this.noWorkspace = true;
	}

	clearNoWorkspace(): void {
		this.noWorkspace = false;
	}

	/**
	 * Reset. Exists for sign-out and for tests; NOT wired to any response handler, deliberately —
	 * see the stickiness note in the module docblock.
	 */
	clear(): void {
		this.isSuspended = false;
		this.noWorkspace = false;
	}
}

export const workspaceGate = new WorkspaceGate();
