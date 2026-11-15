// src/lib/stores/activeTenant.svelte.ts — super-admin "act into another tenant" scope.
//
// When set, authFetch attaches the X-Active-Tenant-Id header so every tenant-scoped read
// and write the session makes runs UNDER the chosen tenant — i.e. the Tenants page promise
// "switch the one your session acts under, and manage its members, keys, and spend". The
// backend honours the header for super_admins only and silently ignores it otherwise, so
// this is inert for non-super-admins. Persisted to localStorage so the choice survives
// navigation/reload.
//
// ⛔ THE CHOICE BELONGS TO ONE SIGNED-IN PERSON, NOT TO THE BROWSER. It is stamped with the user
// id it was made by (`ownerId`) and dropped (`reset`) on sign-out, when /api/me reports a different
// user (or one who is no longer a super_admin), and when /api/me says the acting tenant is unusable
// (`activeTenantRejected`, e.g. it was offboarded). Before that (prod E2E 2026-10-14) it survived
// sign-out and rode on the NEXT user's every request, and a super_admin acting as an offboarded
// tenant got 402 from /api/me with no way out of the app. See `auth.svelte.ts initialize/logout`.
const KEY = 'cp.activeTenant';

export interface ActiveTenant {
	id: string;
	name: string;
	/** The user id that chose it. Absent on entries written before this field existed. */
	ownerId?: string;
}

function load(): ActiveTenant | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? (JSON.parse(raw) as ActiveTenant) : null;
	} catch {
		return null;
	}
}

/** A selection the backend refused and the app therefore dropped — shown, never swallowed. */
export interface DroppedActiveTenant {
	name: string;
	/** The backend's refusal code (`license_required`, `tenant_suspended`, `tenant_offboarded`, …). */
	code: string;
}

class ActiveTenantState {
	current = $state<ActiveTenant | null>(load());
	/**
	 * ⛔ NEVER A SILENT DROP (George 2026-10-27). When /api/me refuses the acting tenant the selection
	 * is dropped and the app comes back in the operator's HOME tenant; this says so, and why, so the
	 * shell can tell them instead of leaving them in a different workspace with no explanation.
	 * In memory only: it is about THIS page load, and the drop itself already cleared storage.
	 */
	dropped = $state<DroppedActiveTenant | null>(null);
	/** The signed-in user the next `set()` is stamped with (bound by `reconcile`). */
	private userId: string | null = null;

	/** The tenant id authFetch should send, or null when acting under your own tenant. */
	get id(): string | null {
		return this.current?.id ?? null;
	}

	/** Start acting under another tenant. Reloads so every screen re-reads under it.
	 *  ⚠️ The reload is also why neither switch calls `licenseGate.syncTenant`: the licence status is
	 *  in-memory only, so a reload discards the answer about the previous scope and the layout's
	 *  first load reads the new one. (And while acting-as, `isBlocked` is exempt anyway.) A switch
	 *  that stopped reloading would have to call `syncTenant` — `auth.refresh()` is the place. */
	set(id: string, name: string, opts: { navigateTo?: string } = {}): void {
		this.current = this.userId ? { id, name, ownerId: this.userId } : { id, name };
		this.persist();
		if (typeof location === 'undefined') return;
		// ⚠️ A FULL navigation, not `goto` after this call: the reload below would win the race and
		// land the user back on the page they clicked from (the "Open members" bug, 2026-10-14).
		// `assign` is both the navigation and the reload every screen needs to re-read the scope.
		if (opts.navigateTo) location.assign(opts.navigateTo);
		else location.reload();
	}

	/** Return to your own tenant. Reloads so every screen re-reads under it. */
	clear(): void {
		this.reset();
		if (typeof location !== 'undefined') location.reload();
	}

	/** Drop the selection WITHOUT reloading — for sign-out and for the auth bootstrap, which run
	 *  before (or instead of) any screen having read under the old scope. */
	reset(): void {
		this.current = null;
		try {
			localStorage.removeItem(KEY);
		} catch {
			/* ignore */
		}
	}

	/** The backend refused the acting tenant: drop it (no reload) and RECORD why, for the shell. */
	reject(code: string): void {
		const name = this.current?.name;
		this.reset();
		if (name) this.dropped = { name, code };
	}

	/** The operator has read the "you are back in your own workspace" notice. */
	dismissDropped(): void {
		this.dropped = null;
	}

	/**
	 * Bind the selection to the user /api/me just reported. Drops it (returns `true`) when it cannot
	 * be theirs: they are not a super_admin (the header is inert for them, so it is only a leftover
	 * from someone else), or it was stamped by a DIFFERENT user. An unstamped legacy entry is adopted
	 * by a super_admin.
	 */
	reconcile(userId: string, isSuperAdmin: boolean): boolean {
		this.userId = userId;
		const cur = this.current;
		if (!cur) return false;
		if (!isSuperAdmin || (cur.ownerId !== undefined && cur.ownerId !== userId)) {
			this.reset();
			return true;
		}
		if (cur.ownerId === undefined) {
			this.current = { ...cur, ownerId: userId };
			this.persist();
		}
		return false;
	}

	private persist(): void {
		try {
			localStorage.setItem(KEY, JSON.stringify(this.current));
		} catch {
			/* storage unavailable — in-memory scope still applies for this session */
		}
	}
}

export const activeTenant = new ActiveTenantState();
