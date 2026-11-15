// src/lib/stores/auth.svelte.ts — Svelte 5 runes auth store (trimmed from fr).
import {
	initKeycloak,
	KeycloakConfigError,
	login as kcLogin,
	logout as kcLogout
} from '$lib/services/keycloak';
import { authFetch } from '$lib/api/auth-fetch';
import { adminApi, ApiError, unwrap } from '$lib/api/admin';
import { errorText } from '$lib/api/error-message';
import { isSuspendedApiError, workspaceGate } from '$lib/stores/workspaceGate.svelte';
import { licenseGate } from '$lib/stores/licenseGate.svelte';
import { activeTenant } from '$lib/stores/activeTenant.svelte';
import type { PendingInviteView, TenantRole } from '$lib/types/admin';
import * as m from '$lib/paraglide/messages';

export interface NavCounts {
	challenges: number;
	solutions: number;
	/**
	 * FLEET-WIDE (cross-tenant), and present ONLY for a super_admin.
	 *
	 * `/sandboxes` is `requireSuperAdmin` + `runAsSystem`, so a tenant-scoped count here reported a
	 * number the page contradicts one click later. The backend now counts it under `runAsSystem` and
	 * OMITS the key for everyone else rather than emitting a platform-wide total into every member's
	 * `/api/me`. `Sidebar.badgeCount` renders only positive numbers, so `undefined` is already the
	 * "no badge" state. See backend/src/routes/me.ts `navCounts`.
	 */
	sandboxes?: number;
	/** W8/P5: pending information requests — present only for a reviewer (tenant_admin / developer /
	 *  super_admin). Absent = no badge. */
	requests?: number;
}

/**
 * The signed-in user as `GET /api/me` reports it — the ONLY source of tenant and role. Keycloak
 * authenticates; CP's own `users` row decides the workspace and the role. `roles` is the hydrated
 * set (`super_admin` from the realm, plus the CP `tenant_role` when the user has a home tenant).
 *
 * The tenancy fields are optional so a backend older than the CP-owned model (mid-roll) reads as
 * "has a workspace" rather than locking everyone out.
 */
export interface AuthUser {
	id: string;
	email: string;
	name: string;
	roles: string[];
	tenantId?: string | null;
	tenantRole?: TenantRole | null;
	isSuperAdmin?: boolean;
	hasWorkspace?: boolean;
	pendingInvites?: PendingInviteView[];
	/**
	 * The locale `GET /api/me` RESOLVED for this request (§5B) — not necessarily a stored choice.
	 *
	 * ⚠️ "Defaults to 'en' server-side" is what this comment used to say, and it was the visible
	 * face of the bug 0081 fixes: `users.locale` was NOT NULL DEFAULT 'en', so /api/me really did
	 * answer 'en' to everyone and `locale.init(auth.user?.locale)` in +layout.svelte overwrote
	 * Paraglide's browser negotiation with it. The column is now nullable and NULL means "never
	 * chosen"; the route answers the stored preference when there is one, otherwise the best match
	 * from this request's Accept-Language, otherwise 'en'. Still ALWAYS a supported locale string,
	 * so `init()` needs no change — but it is a resolution, not a preference, and only the topbar
	 * switcher's PATCH turns it into one.
	 */
	locale?: string;
	/**
	 * Live sidebar badge counts (from /api/me). NOT uniformly tenant-scoped — each count is taken in
	 * the scope of the page its badge links to, which for `sandboxes` is cross-tenant. See NavCounts.
	 */
	counts?: NavCounts;
	/**
	 * The EFFECTIVE voting-cycle cadence (0107). `off` hides the winner screen from the sidebar.
	 * Absent from an older backend: treated as on.
	 */
	cycleCadence?: 'off' | 'week' | 'month' | 'quarter' | 'year';
	/**
	 * The address behind the shell's "Feedback" link (backend SUPPORT_EMAIL). null / absent = unset:
	 * the link is hidden, never pointed at a guessed address.
	 */
	supportEmail?: string | null;
	/**
	 * Set ONLY when this request carried a super_admin's `X-Active-Tenant-Id` and the backend refused
	 * it (the code says why — e.g. `tenant_offboarded`, `license_inactive`). The rest of this payload
	 * is then about the HOME tenant, and the stale selection must be dropped (see `loadMe`).
	 */
	activeTenantRejected?: string | null;
}

/** 4xx refusals of /api/me that say something permanent about the acting tenant (an older backend
 *  without `activeTenantRejected`). Excludes the token (401), rate limiting (429), the licences
 *  outage code and every 5xx — all transient, none a reason to forget the selection. */
const TRANSIENT_CODES = new Set(['license_unavailable', 'tenant_status_unavailable']);
export function isPermanentScopeRefusal(e: ApiError): boolean {
	return e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429 && !TRANSIENT_CODES.has(e.code);
}

class AuthState {
	isAuthenticated = $state(false);
	isLoading = $state(true);
	user = $state<AuthUser | null>(null);
	error = $state<string | null>(null);

	// Role taxonomy (super_admin > tenant_admin > developer/member), all read from /api/me.
	// super_admin passes the tenant_admin gate too; admins pass the developer gate too. These
	// mirror the backend guards in middleware/admin-guards.ts and drive the role-based nav.
	isSuperAdmin = $derived(
		this.user?.isSuperAdmin === true || (this.user?.roles.includes('super_admin') ?? false),
	);
	isTenantAdmin = $derived(
		this.isSuperAdmin || (this.user?.roles.includes('tenant_admin') ?? false),
	);
	isDeveloper = $derived(
		this.isTenantAdmin || (this.user?.roles.includes('developer') ?? false),
	);
	canAccessAdmin = $derived(this.isSuperAdmin || this.isTenantAdmin);

	/** `false` only when /api/me explicitly says so; unknown (no profile, old backend) is `true`. */
	hasWorkspace = $derived(this.user?.hasWorkspace !== false);
	pendingInvites = $derived<PendingInviteView[]>(this.user?.pendingInvites ?? []);
	/**
	 * Render the no-workspace screen instead of the app: signed in, not a super_admin, and either
	 * /api/me said so or a live request came back 403 `no_workspace`.
	 */
	needsWorkspace = $derived(
		this.isAuthenticated &&
			this.user !== null &&
			!this.isSuperAdmin &&
			(!this.hasWorkspace || workspaceGate.noWorkspace),
	);

	/**
	 * Re-read /api/me (after accepting an invite). Clears the no-workspace latch once seated, and
	 * re-reads the licence gate when the tenant changed — a status cached while this person had no
	 * workspace is about NO tenant, and rendering it after they were seated is the 2026-10-13 lockout
	 * (see `licenseGate.syncTenant`). Every seat-mid-session path (invite accept page, NoWorkspace
	 * accept, SSO first login) ends here, so this is the one hook.
	 */
	async refresh(): Promise<void> {
		this.user = await this.loadMe();
		if (this.user.hasWorkspace !== false) workspaceGate.clearNoWorkspace();
		licenseGate.syncTenant(this.effectiveTenantId());
	}

	/**
	 * `GET /api/me`, with the "acting as" selection made safe FIRST.
	 *
	 * ⛔ A STALE SELECTION USED TO BRICK THE APP (prod E2E 2026-10-14). The choice lives in
	 * localStorage and rides on every request, /api/me included; a super_admin acting as a tenant that
	 * was since offboarded got 402 here, `initialize` failed, and there was no shell to click "return"
	 * in. Three exits, in order:
	 *   1. the request itself 4xx's while a selection is set (a backend that predates
	 *      `activeTenantRejected`) → drop the selection and ask ONCE more without it;
	 *   2. the backend answered but says it refused the acting tenant → drop it (the payload is
	 *      already about the home tenant);
	 *   3. the selection was made by somebody else, or this user is not a super_admin → drop it
	 *      (`activeTenant.reconcile`) — the sign-out-then-sign-in-as-someone-else leak.
	 * (1) fires only on a PERMANENT refusal (`isPermanentScopeRefusal`): a 401 is the token, and a
	 * licences outage (402 `license_unavailable`), a 429 or a 5xx clear by themselves — dropping a
	 * valid selection on them would silently undo the operator's choice. Those surface as the error
	 * they are, with the selection kept.
	 */
	private async loadMe(): Promise<AuthUser> {
		let user: AuthUser;
		try {
			user = await unwrap<AuthUser>(await authFetch('/api/me'));
		} catch (e) {
			if (!activeTenant.id || !(e instanceof ApiError) || !isPermanentScopeRefusal(e)) throw e;
			this.dropActiveTenant(e.code);
			user = await unwrap<AuthUser>(await authFetch('/api/me'));
		}
		if (user.activeTenantRejected) this.dropActiveTenant(user.activeTenantRejected);
		activeTenant.reconcile(user.id, user.isSuperAdmin === true || user.roles.includes('super_admin'));
		return user;
	}

	/** Forget the acting-as tenant AND whatever the gates latched while it was being sent.
	 *  ⛔ `reject`, not `reset`: the drop is RECORDED (with the backend's reason) so the shell tells
	 *  the operator they are back in their own workspace — never a silent switch (George 2026-10-27). */
	private dropActiveTenant(code: string): void {
		activeTenant.reject(code);
		licenseGate.reset();
		workspaceGate.clear();
	}

	/**
	 * The tenant `GET /api/license/status` answers about for this user: the acting-as tenant for a
	 * super_admin who switched scope (the backend honours `X-Active-Tenant-Id` only for them), else
	 * the home tenant. `undefined` when /api/me did not say (old backend) — unknown, not "none".
	 */
	private effectiveTenantId(): string | null | undefined {
		if (this.isSuperAdmin && activeTenant.id) return activeTenant.id;
		return this.user?.tenantId;
	}

	/**
	 * Record a self-signup for the super_admin queue — only for someone /api/me reports as having
	 * no workspace AND no pending invite (an invited person is already on their way in).
	 * Fire-and-forget: never block or break login; the endpoint is open and idempotent.
	 */
	private notifySignupStrand(u: AuthUser): void {
		if (u.hasWorkspace !== false || this.isSuperAdmin) return;
		if ((u.pendingInvites?.length ?? 0) > 0) return;
		if (!u.email) return;
		void adminApi.notifySelf({ email: u.email, name: u.name || undefined }).catch(() => {});
	}

	async initialize(): Promise<void> {
		this.isLoading = true;
		// ⛔ `isAuthenticated` IS PUBLISHED ONLY AFTER /api/me HAS ANSWERED — never in between.
		// It used to be set straight from `initKeycloak()`, leaving a window with `isAuthenticated`
		// true and `user` null. In that window `needsWorkspace` (which requires a user) read false, so
		// +layout's licence `$effect` fired for a person CP had not seated yet; the backend answered
		// about NO tenant, and that answer was cached as a licence wall. A brand-new tenant admin then
		// accepted their invite and clicked "Open app" into "No active license" (2026-10-13).
		// `isLoading` covers the render during the wait; nothing else needs the flag earlier.
		let ok = false;
		try {
			ok = await initKeycloak();
			if (ok) {
				// /api/me is the backend's source of truth for the profile — including ROLES, which
				// drive every nav gate. A non-OK response used to be swallowed here, leaving
				// `user` null while `isAuthenticated` stayed true: the shell still rendered, but the
				// name showed as '—', the role fell through to "Member", and every admin/developer/
				// platform nav item silently disappeared. A super-admin hitting a transient 500 saw a
				// stripped-down app with no error and no reason to suspect anything but a permissions
				// change. Surface it instead.
				//
				// `unwrap` (rather than a hand-rolled !res.ok branch) is what makes this failure
				// LOCALIZABLE: it lifts the backend's machine-readable `error` code into
				// ApiError.code, which errorText() below turns into translated copy. The previous
				// version concatenated an English sentence and spliced 160 raw chars of the backend
				// body into it — so a refused JIT user's very first screen, in every locale, read
				// e.g. "Could not load your profile (HTTP 403). … {"error":"tenant_not_provisioned",
				// "message":"Token tenant is not provisioned; access denied"}".
				this.user = await this.loadMe();
				this.notifySignupStrand(this.user);
			}
			this.isAuthenticated = ok;
		} catch (e) {
			// The SIGN-IN stands whenever Keycloak said so: a failed /api/me (or a suspended workspace)
			// is a profile/workspace state the screens below explain, not a signed-out user. `ok` is
			// still false when initKeycloak itself threw.
			this.isAuthenticated = ok;
			// ⛔ A SUSPENDED WORKSPACE IS NOT AN INITIALIZE FAILURE, AND MUST NOT BE RECORDED AS ONE.
			// When a platform operator has suspended this tenant, EVERY gated call 403s
			// `tenant_suspended` — including the `/api/me` above — and auth-fetch's interceptor has
			// already latched `workspaceGate`, so routes/+layout.svelte renders the full-screen Dutch
			// explanation. Falling through to the generic path below did two wrong things:
			//   • it console.error'd "[auth] initialize failed" for a state the product fully
			//     understands and is ALREADY explaining on screen — noise that fires for every
			//     suspended user and sends whoever reads it hunting a broken token or backend;
			//   • it set `this.error` to "we could not load your profile", which is FALSE. Today the
			//     layout's suspension branch is evaluated first so nobody sees it, but that makes the
			//     truth an ordering accident: reorder those branches and a suspended customer is told
			//     their profile failed to load instead of that their workspace was suspended.
			// Measured in a browser against a live suspended tenant, which is the only way this
			// surfaced — the suite was green.
			// `isAuthenticated` was set true at the top of this catch block — the token is perfectly valid;
			// it is the WORKSPACE that is suspended, not the sign-in.
			if (isSuspendedApiError(e)) return;
			// Keep the raw cause in the console for diagnosis; the user gets translated copy.
			console.error('[auth] initialize failed', e);
			// ⛔ ONE EXCEPTION, AND IT IS NOT A PROFILE FAILURE. `KeycloakConfigError` means the BUNDLE
			// was built without `VITE_KEYCLOAK_*`. Before the guard that raises it, that state was an
			// unbounded self-referential redirect ending in HTTP 431 with nothing on screen; routing it
			// through `errorText` would replace that with "we could not load your profile", which sends
			// whoever reads it to look at the user, the token and the backend — none of which are
			// broken. Its own message names the missing variables and says a rebuild, not a restart,
			// is the fix. Deliberately not localized: see the comment at its definition.
			this.error =
				e instanceof KeycloakConfigError ? e.message : errorText(e, m.error_profile_unavailable());
		} finally {
			this.isLoading = false;
		}
	}

	login() {
		return kcLogin();
	}

	/** Sign out. `redirectUri` is where Keycloak sends the browser afterwards (default: the app
	 *  origin). The invite accept page passes its FULL URL so the `?token=` survives the re-login —
	 *  without it "Switch account" landed the invitee on `/` and the invitation was lost. */
	logout(redirectUri?: string) {
		this.isAuthenticated = false;
		this.user = null;
		workspaceGate.clear();
		// The acting-as choice belongs to THIS session's person; the next one on this browser must not
		// inherit it (it used to survive sign-out and ride on their every request).
		activeTenant.reset();
		return kcLogout(redirectUri);
	}
}

export const auth = new AuthState();
