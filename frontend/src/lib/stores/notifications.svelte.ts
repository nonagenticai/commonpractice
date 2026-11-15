// src/lib/stores/notifications.svelte.ts
//
// The in-app notification feed backing the topbar bell. Modelled directly on
// stores/licenseGate.svelte.ts: a lightweight polled count (cheap, every consumer needs it),
// with the full list fetched only when the panel is actually opened.
//
// Deliberately quiet on failure: a notification feed is auxiliary. If the poll fails (offline,
// a 401 mid-refresh) the badge simply keeps its last value rather than throwing an error banner
// into an otherwise working page.
//
// ⛔ QUIET IS NOT THE SAME AS SILENT, and `load()` used to be silent. See the note on `error`.
import { notificationsApi } from '$lib/api/notifications';
import type { AppNotification } from '$lib/types/admin';

/** How often the unread badge refreshes while the tab is visible. */
const POLL_MS = 60_000;

/**
 * ⚠️ EXPORTED FOR TESTS, WHICH IS THE `licenseGate.svelte.ts` idiom AND NOT AN INVITATION TO A
 * SECOND INSTANCE IN THE APP. `start()` installs an interval and a `visibilitychange` listener, so
 * a second live instance would poll twice and leak a listener. The singleton below is the only one
 * any component may touch; a test constructs its own so the optimistic-update cases cannot leak
 * `items`/`unread` into each other.
 */
export class NotificationStore {
	unread = $state(0);
	items = $state<AppNotification[]>([]);
	loading = $state(false);
	open = $state(false);
	/**
	 * Did the LAST `load()` fail? Read together with `items`, never on its own:
	 *   error && items.length === 0 → the panel has nothing to show and could not get it
	 *   error && items.length > 0   → the panel is showing the PREVIOUS list, now unrefreshed
	 * The bell says two different things for those two states, because they are two different
	 * facts. Not an error MESSAGE: what failed is never interesting to this reader (offline, a 401
	 * mid-refresh, a 500) and the panel is 340px wide.
	 *
	 * Not touched by `refreshCount`, on purpose. A failed poll is genuinely invisible — the badge
	 * keeps its last value and no panel is open to say anything in.
	 */
	error = $state(false);

	#timer: ReturnType<typeof setInterval> | null = null;
	#started = false;

	/** Begin polling the unread count. Idempotent — safe to call from a layout effect. */
	start(): void {
		if (this.#started || typeof window === 'undefined') return;
		this.#started = true;
		void this.refreshCount();
		this.#timer = setInterval(() => {
			if (document.visibilityState === 'visible') void this.refreshCount();
		}, POLL_MS);
		// A tab that was hidden for a while should catch up the moment it is looked at again.
		document.addEventListener('visibilitychange', this.#onVisible);
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		this.#started = false;
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this.#onVisible);
		}
	}

	#onVisible = (): void => {
		if (document.visibilityState === 'visible') void this.refreshCount();
	};

	async refreshCount(): Promise<void> {
		try {
			this.unread = (await notificationsApi.unreadCount()).unread;
		} catch {
			/* auxiliary feed — keep the last known count rather than surfacing an error */
		}
	}

	async load(): Promise<void> {
		this.loading = true;
		try {
			const res = await notificationsApi.list({ limit: 30 });
			this.items = res.notifications;
			this.unread = res.unread;
			// Cleared only on success, so a recovered open stops apologising for the previous one.
			this.error = false;
		} catch {
			// ⛔ THE DEFECT WAS AN INCOMPLETE COMMENT, NOT A CARELESS ONE. "leave whatever was already
			// shown" is exactly right for a REPEAT open — the reader had a list a moment ago, the
			// refresh failed, and blanking it would destroy readable content to report a transient
			// fetch. What it never considered is the FIRST open, where "whatever was already shown"
			// is the initial `[]`. The panel's only two branches were loading → empty → list, so an
			// empty `items` after a failed load took the empty branch and stated, as a fact,
			// "Nothing to catch up on." — while `refreshCount`'s own catch had correctly kept the
			// badge, leaving a "3" hanging over "Geen meldingen".
			//
			// So: keep the items (the original behaviour, unchanged) AND record that the load failed.
			// The bell reads the two together and distinguishes "nothing to show" from
			// "could not refresh what is shown".
			this.error = true;
		} finally {
			this.loading = false;
		}
	}

	async toggle(): Promise<void> {
		this.open = !this.open;
		if (this.open) await this.load();
	}

	/**
	 * ⛔ AN OPTIMISTIC UPDATE MUST REVERT BOTH HALVES OF WHAT IT CHANGED, AND THIS ONE REVERTED
	 * NEITHER. The catch used to be `void this.refreshCount()` alone. That leaves the panel in a
	 * state the server never had and the reader can SEE is inconsistent:
	 *
	 *   · `item.read` stays `true` — `refreshCount()` reads `GET /notifications/count` and touches
	 *     ONLY `unread`; nothing in it can undo a mutation to `items`. The row keeps its read
	 *     styling forever, or until the panel is re-opened and `load()` refetches.
	 *   · `unread` is left to a SECOND network call that has just been shown to be a bad bet. The
	 *     realistic cause of a failed `markRead` is offline or a 401 mid-refresh, and both make
	 *     `refreshCount` fail too — whose own catch deliberately keeps the last value, which is now
	 *     the OPTIMISTIC one. So the decrement sticks: a notification counted as read that the
	 *     server still considers unread, with no path back except a reload.
	 *   · and when `refreshCount` DOES succeed, the badge snaps back to 1 over a row that is still
	 *     painted read. The badge and the list contradict each other on screen.
	 *
	 * ⚠️ REVERT FIRST, THEN RE-SYNC — the order is load-bearing. The revert is synchronous and
	 * restores a state the server actually holds; `refreshCount()` is still fired afterwards
	 * because the server is the authority (the POST may have SUCCEEDED and only its response been
	 * lost) and it will overwrite `unread` with the truth a moment later. Dropping it in favour of
	 * the local revert alone would leave that case wrong in the other direction.
	 *
	 * ⚠️ `wasUnread`, NOT `unread + 1`. Re-incrementing assumes nothing else moved the count
	 * between the decrement and the failure — but a `refreshCount` poll can land inside that
	 * window (`POLL_MS`, or a visibilitychange) and set `unread` from the server. Restoring the
	 * captured value is wrong by at most one poll interval; recomputing it invents a number.
	 */
	async markRead(id: string): Promise<void> {
		// Optimistic: the panel should respond instantly.
		const item = this.items.find((n) => n.id === id);
		if (!item || item.read) return;
		const wasUnread = this.unread;
		item.read = true;
		this.unread = Math.max(0, this.unread - 1);
		try {
			await notificationsApi.markRead(id);
		} catch {
			item.read = false;
			this.unread = wasUnread;
			void this.refreshCount();
		}
	}

	/** Identical shape, identical defect, identical repair — see `markRead` above. */
	async markAllRead(): Promise<void> {
		// ⚠️ `map` builds NEW objects, so the captured array's elements are untouched and putting the
		// reference back is a complete revert. A `forEach(n => n.read = true)` here would mutate the
		// very rows this snapshot is supposed to preserve.
		const prevItems = this.items;
		const wasUnread = this.unread;
		this.items = this.items.map((n) => ({ ...n, read: true }));
		this.unread = 0;
		try {
			await notificationsApi.markAllRead();
		} catch {
			this.items = prevItems;
			this.unread = wasUnread;
			void this.refreshCount();
		}
	}
}

export const notifications = new NotificationStore();
