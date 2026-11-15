// src/lib/stores/licenseGate.svelte.ts
//
// Authoritative, app-scoped LICENSE GATE for Common Practice — the single source of truth for "is
// this workspace's license valid, expiring, or blocked?". Fed by the backend `GET /api/license/status`
// (which derives the real state from the central licenses service: active / expiring_soon / expired /
// none, plus the expiry date), mirroring fr's pattern.
//
// The backend is the real enforcer (every gated route 402s a `license_*` code when missing/expired —
// see middleware/license-gate.ts). This store lets the SPA render an accurate experience on top of
// that: a hard-block renewal screen for expired/none, and a non-blocking "expiring soon" banner —
// instead of a broken shell or raw 402 toasts.
//
// Two signals feed it:
//   1. A polled GET /api/license/status (on login + on an interval/visibility).
//   2. `handleForbidden()` — called by auth-fetch when ANY request returns a 402 license_* code, so a
//      mid-session expiry blocks immediately even before the next poll.
//
// NOTE vs fr: CP enforcement returns HTTP 402 (Payment Required) for the license codes (fr used 403).
// The block-code detection below is CP-correct (402 + a license_* error code).
//
// `$app/navigation` is imported LAZILY (a dynamic import inside navigateToRenew), NOT at module
// top: this module is pulled in by auth-fetch, which the whole app imports, so a static
// `$app/navigation` import would drag the SvelteKit client runtime (`fetcher.js`, top-level
// `window`) into every consumer — under the node-env vitest mock it throws `window is not defined`
// when the `$app/*` mock occasionally doesn't apply across parallel workers (the #86 CI flake).
import { authFetch } from '$lib/api/auth-fetch';
// No import cycle: activeTenant.svelte.ts imports nothing (auth-fetch already imports it, and it
// imports neither of us).
import { activeTenant } from '$lib/stores/activeTenant.svelte';

export type LicenseGateState =
	| 'active'
	| 'expiring_soon'
	| 'expired'
	| 'none'
	// The WORKSPACE is licensed; THIS CALLER holds no usable seat on it (per-member licensing).
	// ⛔ ITS OWN STATE, NOT `'none'`, AND THE DISTINCTION IS WHAT MAKES THE BLOCK STABLE. Before the
	// endpoint became seat-aware it answered about the TENANT only, so a seatless member polled
	// `'active'` — the entitled branch of `load()` — and the 402-raised block was cleared one
	// round-trip after it was raised, then re-raised by the next gated request: a flap loop, with a
	// renewal wall flickering at a paid-up customer. Folding it into `'none'` would close the flap
	// and reopen the accusation, because every `BLOCKED_STATES` member is labelled `'terminal'`.
	| 'no_seat'
	// This caller IS a member and their seat exists, but it is still being SET UP (an accept whose
	// licence call failed after the seat was committed; the backend tick finishes it). Blocked —
	// every gated request is still refused — but labelled `'setup'`, never `'seat'`: telling someone
	// to ask an administrator for a seat they already hold is the false wall this state removes.
	| 'seat_pending'
	// The request resolved NO tenant: the caller is signed in but seated in no workspace (yet).
	// ⛔ NON-BLOCKING, AND THAT IS THE FIX FOR A MEASURED LOCKOUT (2026-10-13). The backend used to
	// answer `'none'` here, which IS blocked — so a status read in the instant before an invite was
	// accepted was cached as a licence wall, and the brand-new tenant admin clicked "Open app" into
	// "No active license" on a workspace whose licence and seat were both active. "You have no
	// workspace" is not a statement about any licence; `auth.needsWorkspace` (the NoWorkspace
	// screen) explains that state, and Gate 2 still 402s every request regardless.
	| 'no_workspace'
	| 'unknown';

export interface LicenseStatusResponse {
	appKey: string;
	gateEnabled: boolean;
	hasLicense: boolean;
	state: LicenseGateState;
	expiresAt: string | null;
	daysRemaining: number | null;
	planCode: string | null;
	/**
	 * The tenant this answer is ABOUT (`null` = none resolved, i.e. `no_workspace`). `syncTenant`
	 * compares it with the tenant /api/me now reports and re-reads on a mismatch.
	 *
	 * OPTIONAL because a backend older than this field does not send it (a new frontend DOES talk to
	 * an old backend mid-roll). Absent means UNKNOWN, never "no tenant": `syncTenant` re-reads rather
	 * than trusting an answer it cannot attribute.
	 */
	tenantId?: string | null;
}

// `no_seat` blocks like the other two: every gated request 402s for this caller, so a shell of
// failing screens is worse than an honest wall. It is the only member whose remedy is not renewal —
// `load()` labels it `'seat'` rather than `'terminal'` for exactly that reason.
// ⛔ `no_workspace` is deliberately ABSENT — see its definition above.
const BLOCKED_STATES: ReadonlySet<LicenseGateState> = new Set(['expired', 'none', 'no_seat', 'seat_pending']);

/**
 * The backend Gate-2 enforcement codes (middleware/license-gate.ts) that mean "this caller has no
 * usable licence" — a 402 carrying one of these blocks the UI. That is ALMOST always a property of
 * the WORKSPACE; `license_seat_required` is the exception and is marked as such below.
 * `license_app_mismatch` / `license_tenant_mismatch` are 403 (a misconfiguration, not an absent
 * license) and are NOT here.
 */
export const LICENSE_BLOCK_CODES: ReadonlySet<string> = new Set([
	'license_required',
	'license_inactive',
	'license_expired',
	'license_unavailable',
	// The stored licence blob exists but will not decrypt (wrong/rotated CP_SECRET_KEY, corrupt
	// row). Its own code precisely because it is NOT `license_unavailable`: that one promises
	// "access resumes automatically", which is true of a transport blip and false of this — the
	// condition is standing and needs an operator. See `blockReason` below.
	'license_unreadable',
	// ⛔ THE WORKSPACE'S LICENCE IS FINE — THIS READER HAS NO SEAT ON IT (per-member licensing).
	// It still blocks, because every gated request 402s for THIS user and a shell of failing
	// screens is worse than an honest wall. But it is the one block code whose remedy is NOT
	// renewal: an administrator assigns a seat. The copy must say so — see `error_license_seat_
	// required` in `api/error-message.ts`, and the seat branch in `blockReason` below.
	'license_seat_required'
]);

/**
 * Pure predicate (exported for the auth-fetch interceptor + its test): does this response mean the
 * license gate rejected the request? CP enforcement is 402 + a `license_*` code.
 */
export function isLicenseBlockResponse(status: number, errorCode: string | undefined): boolean {
	return status === 402 && errorCode != null && LICENSE_BLOCK_CODES.has(errorCode);
}

export type BlockReason = 'terminal' | 'unreadable' | 'outage' | 'seat' | 'setup' | null;

/**
 * Precedence for `LicenseGate.blockReason`. Higher wins; a lower-ranked signal arriving later is
 * DISCARDED rather than applied. Kept as data (not an if-ladder) so adding a fourth reason forces
 * a deliberate answer to "where does it sit?" instead of being appended to the bottom of a chain.
 *
 * ⚠️ `seat` IS THE FOURTH, AND THE NUMBERS MOVED — THE ORDER DID NOT. `outage < unreadable <
 * terminal` is unchanged in both directions, so nothing about those three behaves differently; the
 * integers are renumbered only because `seat` was slotted BETWEEN the first two rather than appended
 * to the bottom, which is the choice this comment exists to force. Where it sits, and why:
 *
 *   ABOVE `outage` — for the identical reason `unreadable` is. A seat verdict is STANDING (nobody
 *   acquires a seat by waiting), and Gate 2 runs on every request, so one timed-out introspect among
 *   a dozen parallel calls must not relabel it "couldn't verify, try again shortly" and hide the one
 *   instruction that repairs it.
 *
 *   BELOW `unreadable` — a seat assignment cannot decrypt a licence blob. If both ever land, the
 *   operator-fault sentence is the true one and "ask your administrator for a seat" would send the
 *   reader to a person who cannot help. (In practice the pair is near-unreachable: for one caller
 *   `memberEntitlementToken` either returns nothing → seat, or fails to decrypt → unreadable.)
 *
 *   BELOW `terminal` — the rule the `blockReason` doc already states, applied to a new case: an
 *   authoritative commercial verdict on the WORKSPACE outranks any statement about one member. On an
 *   expired workspace there is no seat to assign, and telling the reader otherwise hides the renewal
 *   path from the one customer who needs it.
 */
const BLOCK_REASON_RANK: Record<Exclude<BlockReason, null>, number> = {
	outage: 0,
	seat: 1,
	// ABOVE `seat`: the gate's 402 `license_seat_required` is the SAME condition seen without the
	// detail — the poll's `seat_pending` knows the seat exists and is being minted, so a later
	// seat-required 402 must not relabel it "ask your administrator". Below everything else.
	setup: 2,
	unreadable: 3,
	terminal: 4
};

export class LicenseGate {
	status = $state<LicenseStatusResponse | null>(null);
	isLoading = $state(false);
	/** Set when a live request returned a 402 license_* code (mid-session expiry). */
	forcedBlocked = $state(false);
	/**
	 * WHY the UI is currently blocked, which is a different question from WHETHER it is.
	 *
	 *   'terminal'   — an authoritative commercial answer: expired / none / inactive / required.
	 *   'unreadable' — `license_unreadable`: we hold a licence blob we cannot decrypt.
	 *   'outage'     — `license_unavailable`: the licences service could not be reached at all.
	 *   'seat'       — `license_seat_required` / state `no_seat`: the WORKSPACE is licensed and this
	 *                  MEMBER is not. The only reason whose remedy is an administrator, not money.
	 *
	 * ⛔ THESE ARE RANKED, AND A LOWER RANK MAY NEVER OVERWRITE A HIGHER ONE (see BLOCK_REASON_RANK).
	 * Gate 2 runs on every request, so an expired tenant firing a dozen parallel requests will see
	 * one of them time out against the licences service and report `license_unavailable`. Without
	 * the precedence rule that single blip relabels a genuinely expired workspace as "not your
	 * licence, try again" — which is this bug's own mirror image, and would hide the renewal path
	 * from the one customer who needs it.
	 *
	 * `unreadable` sits ABOVE `outage` for the same reason in the other direction: it is a STANDING
	 * fault (a rotated master key does not un-rotate itself), so letting a concurrent transport blip
	 * relabel it "resumes automatically" would restore exactly the false promise it exists to
	 * remove. It sits BELOW `terminal` because an authoritative commercial verdict is the one answer
	 * that came from the licences service itself.
	 *
	 * Only `clear()` or an ENTITLED poll resets any of them.
	 */
	blockReason = $state<BlockReason>(null);

	/** True when the current block is an OUTAGE, not an expiry. Only the WORDS differ, never the block. */
	blockedByOutage = $derived(this.blockReason === 'outage');

	/**
	 * True when we hold a licence we cannot READ — a fault on our side that no user action clears.
	 * Distinct from `blockedByOutage` because the honest copy is different: an outage says "try
	 * again", this says "an operator has to fix this".
	 */
	blockedByUnreadable = $derived(this.blockReason === 'unreadable');
	lastChecked = $state<Date | null>(null);

	state = $derived<LicenseGateState>(this.status?.state ?? 'unknown');
	expiresAt = $derived<string | null>(this.status?.expiresAt ?? null);
	daysRemaining = $derived<number | null>(this.status?.daysRemaining ?? null);
	planCode = $derived<string | null>(this.status?.planCode ?? null);

	/** Expiring within the warning window — show a non-blocking banner. */
	isExpiringSoon = $derived(this.state === 'expiring_soon');

	/**
	 * The workspace holds a usable license (entitled). `expiring_soon` is still valid (the app stays
	 * usable); `unknown` is treated as valid so a transient licenses blip never flips a badge to
	 * "invalid" — the 402 path is the real enforcer. Only the terminal blocked states are "not valid".
	 */
	isValid = $derived(
		this.state === 'active' || this.state === 'expiring_soon' || this.state === 'unknown'
	);

	/**
	 * Hard-block the UI: a 402 was seen, OR the polled state is a terminal non-entitled state.
	 * `unknown` (transient upstream error) does NOT block — the per-request 402 path is the backstop,
	 * so a licenses blip can't lock out an entitled user.
	 *
	 * …AND the session is not ACTING AS another tenant. `state` comes from GET /api/license/status,
	 * which resolves the ACTING target — so for a super_admin scope-switched into an unpaid tenant
	 * the poll raises the full-page overlay all by itself, with no 402 anywhere. Exempting the
	 * backend alone therefore leaves the operator staring at exactly the same screen.
	 *
	 * The full-screen block exists to tell THE LICENSEE that their workspace is unpaid. An operator
	 * borrowing a tenant's scope is not that person; for them the truthful, diagnosable state is
	 * per-screen 402s on the tenant screens they open, with the platform console intact.
	 *
	 * NOT a security control, and it does not become one: a non-super user can hand-set
	 * localStorage['cp.activeTenant'] to suppress their own overlay and gain NOTHING, because the
	 * backend ignores X-Active-Tenant-Id for non-super callers (middleware/admin-guards.ts
	 * readActiveTenantHeader) — every request they make still 402s. Cosmetic only.
	 */
	isBlocked = $derived(
		!activeTenant.id && (this.forcedBlocked || BLOCKED_STATES.has(this.state))
	);

	// ⛔ THERE IS NO `statusMessage` HERE, AND RE-ADDING ONE IS THE DEFECT — NOT THE FIX.
	// This class used to carry a `get statusMessage()` that composed the block screen's sentence in
	// code: hard-coded English ("Your license expired on …", "…in N days") with a hand-rolled
	// `day${s}` plural and a raw, ungrouped number. It had NO CONSUMER. `LicenseBlocked.svelte`
	// builds its heading and body from `m.license_blocked_*` / `m.error_license_*`, renders no date
	// at all, and `LicenseExpiringBanner.svelte:16` uses `m.license_expiring_days({ days })` — the
	// catalog owns every word a reader sees. Grep confirmed the getter was referenced only by this
	// file and its own test.
	//
	// It was therefore not a "localization bug on the block screen"; it was dead code that LOOKED
	// like the live one, and a date formatter existed solely to feed it. Anything the gate needs to
	// SAY belongs in the catalog and is composed in the component, where `locale.current` is in
	// scope and paraglide owns the plural. This store exposes STATE (`state`, `expiresAt`,
	// `daysRemaining`, `blockedByOutage`) and nothing a reader reads.
	// Pinned by `licenseGate.no-prose.test.ts`.

	/**
	 * Bumped by `reset()`. A `load()` that started before a reset answers about the PREVIOUS tenant,
	 * so its result is dropped instead of overwriting the fresh one (the pre-accept read can easily
	 * resolve after the post-accept one started).
	 */
	private generation = 0;

	/** Fetch the authoritative status. Never throws. */
	async load(): Promise<void> {
		const gen = this.generation;
		this.isLoading = true;
		try {
			const res = await authFetch('/api/license/status');
			if (gen !== this.generation) return;
			if (res.ok) {
				const body = (await res.json()) as LicenseStatusResponse;
				if (gen !== this.generation) return;

				// ⛔ `no_workspace` NEVER CLEARS AN EXISTING BLOCK — treat it like `unknown`, below.
				// The backend resolves the tenant with `peekEffectiveTenant` (middleware/tenant.ts),
				// which answers null on ANY auth error, so one auth blip during a poll reads as "seated
				// in no workspace". Applying it would overwrite a terminal `status` (and keep a forced
				// block from being re-labelled), unblocking an expired-licence user until the next
				// 402. Not itself a blocking state — a FRESH store (or one `reset()` after an accept)
				// still records it, which is the 2026-10-13 lockout fix — but it is no evidence that a
				// block raised earlier is stale. Only an entitled answer is.
				if (
					body.state === 'no_workspace' &&
					(this.forcedBlocked || BLOCKED_STATES.has(this.status?.state ?? 'unknown'))
				) {
					return;
				}

				this.status = body;
				this.lastChecked = new Date();

				// ⛔ `unknown` IS THE OUTAGE ANSWER — IT MUST NOT CLEAR THE BLOCK.
				// This endpoint fails SOFT where the gate fails CLOSED: when the licences service is
				// unreachable, `lib/license-status.ts` catches and returns state:'unknown' with HTTP 200.
				// So during the very outage that produced `license_unavailable`, this is the only answer
				// the poll can give. Clearing on it (as `!BLOCKED_STATES.has(state)` did) unmounted the
				// block one round-trip after raising it, dropping the user into a shell where every
				// gated request 402s and re-blocks — a flap loop, and a Retry button that dismissed the
				// warning instead of retrying it. Preserve the block; the interval poll in +layout will
				// clear it for real when the service answers.
				if (body.state === 'unknown' || body.state === 'no_workspace') return;

				if (BLOCKED_STATES.has(body.state)) {
					// An AUTHORITATIVE non-entitled answer: the service is reachable and says this caller
					// has no usable licence. Whatever raised the block, the poll's label is now the
					// truthful one — so a preceding outage blip stops suppressing the renewal path.
					//
					// ⚠️ `no_seat` IS THE ONE MEMBER THAT IS NOT `'terminal'`, and collapsing it would
					// undo the reason it is a separate state at all: the workspace is licensed and
					// PAYING, so the renewal wall is a false accusation and the Renew CTA a false
					// promise. Every OTHER blocked state is unchanged.
					this.blockReason =
						body.state === 'no_seat' ? 'seat' : body.state === 'seat_pending' ? 'setup' : 'terminal';
					return;
				}

				// Entitled (active / expiring_soon): the service is reachable AND the licence is good, so
				// any forced block is stale by definition (e.g. the licence was just renewed).
				this.forcedBlocked = false;
				this.blockReason = null;
			}
			// Non-OK (e.g. 401 pre-auth) is left as-is; the route auth gate handles it.
		} catch {
			// Network error → leave prior state; do NOT hard-block on a transient blip.
		} finally {
			// A superseded load must not clear the flag of the load that replaced it.
			if (gen === this.generation) this.isLoading = false;
		}
	}

	/**
	 * Forget everything learned about the previous tenant (status, forced block, reason) and drop any
	 * in-flight answer. Callers follow it with `load()`.
	 */
	reset(): void {
		this.generation++;
		this.isLoading = false;
		this.clear();
	}

	/**
	 * The signed-in user's tenant may have changed (an invite was accepted, an SSO first login seated
	 * them): re-read the status unless the cached one is provably about `tenantId`.
	 *
	 * ⛔ THIS IS THE HOOK THAT WAS MISSING (2026-10-13). The status was loaded once, while the invitee
	 * was still unseated; accepting re-read /api/me but never this store, and +layout's `$effect` only
	 * loads while `status` is null — so the stale answer about NO tenant was what "Open app" rendered.
	 * `auth.refresh()` calls this, which covers every path that seats someone mid-session.
	 *
	 * A cached status WITHOUT `tenantId` (old backend, mid-roll) is unknown, so it is re-read. Nothing
	 * cached and nothing in flight → nothing to do; the layout's effect performs the first load.
	 */
	syncTenant(tenantId: string | null | undefined): void {
		if (this.status === null && !this.isLoading) return;
		const cached = this.status?.tenantId;
		if (
			this.status !== null &&
			cached !== undefined &&
			tenantId !== undefined &&
			(cached ?? '').toLowerCase() === (tenantId ?? '').toLowerCase()
		) {
			return;
		}
		this.reset();
		void this.load();
	}

	async refresh(): Promise<void> {
		await this.load();
	}

	/**
	 * Called by auth-fetch on a 402 license_* code. Blocks the UI immediately, then refreshes to
	 * resolve the precise reason for an accurate message.
	 *
	 * ⛔ THE CODE IS LOAD-BEARING, AND IGNORING IT SHIPPED A FALSE STATEMENT TO CUSTOMERS.
	 * This used to take no argument, so every `license_*` code became one terminal block and
	 * `LicenseBlocked` rendered its EXPIRED copy: "Je werkruimte heeft geen actieve Common
	 * Practice-licentie. Neem contact op met je beheerder." But `license_unavailable` does not mean
	 * that. `middleware/license-gate.ts` emits it when the licences service is UNREACHABLE and the
	 * gate fails closed — an infrastructure blip, not a commercial state. An entitled, paid-up
	 * customer was being told their licence had expired and pointed at a Renew button that could not
	 * possibly help.
	 *
	 * Observed live in production 2026-08-13: a full-page "Licentie verlopen" on first load for a
	 * tenant whose licence is `status=active` with no expiry, which then cleared itself on the next
	 * poll — the self-heal below is exactly why it looked like a ghost rather than a bug.
	 *
	 * ⚠️ THE REQUEST IS STILL DENIED AND THIS STILL BLOCKS. Nothing here is a security relaxation:
	 * the backend denies on outage by design, so letting the user through would just produce a
	 * broken page of failing requests. What changes is only what we CLAIM: an outage is labelled an
	 * outage, and offers "try again" rather than "renew".
	 *
	 * ⚠️ This is also why the store's other half already refuses to block on `unknown` (see
	 * `isBlocked`) — that path was careful about transient upstream failure and this one was not.
	 * The two halves now agree.
	 */
	handleForbidden(code?: string): void {
		this.forcedBlocked = true;
		// Never DOWNGRADE: see `blockReason` + BLOCK_REASON_RANK. One timed-out introspect among a
		// dozen parallel requests must not tell an expired workspace (or a workspace whose token we
		// cannot decrypt) that its licence is fine and it should try again.
		const incoming: Exclude<BlockReason, null> =
			code === 'license_unavailable'
				? 'outage'
				: code === 'license_unreadable'
					? 'unreadable'
					: // The workspace's licence is fine; this member has no seat on it. Not `terminal`:
						// that word is what renders the renewal wall, and there is nothing to renew.
						code === 'license_seat_required'
						? 'seat'
						: 'terminal';
		if (
			this.blockReason === null ||
			BLOCK_REASON_RANK[incoming] > BLOCK_REASON_RANK[this.blockReason]
		) {
			this.blockReason = incoming;
		}
		void this.load();
	}

	clear(): void {
		this.status = null;
		this.forcedBlocked = false;
		this.blockReason = null;
		this.lastChecked = null;
	}
}

/**
 * Where the "Renew" CTA points. Defaults to the in-app renew page; set `VITE_LICENSE_RENEW_URL`
 * (e.g. the future portal e-commerce URL) to redirect renewals out of the app — one knob, ports to
 * every frontend.
 */
export const LICENSE_RENEW_URL: string =
	(import.meta.env.VITE_LICENSE_RENEW_URL as string | undefined) || '/license-upgrade';

/**
 * Send the user to the renewal destination. Absolute (`https://…`) OR protocol-relative (`//host/…`)
 * URLs → a full browser redirect (e.g. the customer portal); anything else is treated as an in-app
 * route. Centralized so every "Renew" CTA shares one correct implementation.
 */
export async function navigateToRenew(): Promise<void> {
	if (/^(https?:)?\/\//i.test(LICENSE_RENEW_URL)) {
		window.location.href = LICENSE_RENEW_URL;
	} else {
		// Lazy: pull SvelteKit's client navigation only when an in-app renew actually happens, so
		// merely importing this store (via auth-fetch, app-wide) never loads the kit client runtime.
		const { goto } = await import('$app/navigation');
		await goto(LICENSE_RENEW_URL);
	}
}

export const licenseGate = new LicenseGate();
