// src/lib/stores/notifications.optimistic-revert.test.ts — an optimistic update that never reverted.
//
// ⛔ THE DEFECT. `markRead()` set `item.read = true` and decremented `unread` before the POST, and
// its catch was `void this.refreshCount()` — nothing else. `markAllRead()` had the IDENTICAL shape.
// So on a failed write:
//
//   · `item.read` stays `true`. `refreshCount()` reads `GET /notifications/count` and assigns ONLY
//     `unread`; there is nothing in it that can undo a mutation to `items`. The row keeps its read
//     styling until the panel is closed and re-opened (`load()` refetches).
//   · `unread` is handed to a SECOND network call that has just been shown to be a bad bet. The
//     realistic cause of a failed `markRead` — offline, a 401 mid-refresh — fails `refreshCount`
//     too, and ITS catch deliberately keeps the last known value, which is now the OPTIMISTIC one.
//     The decrement therefore STICKS: a notification the server still holds as unread, counted as
//     read, with no path back short of a reload.
//   · and when `refreshCount` DOES succeed, the badge snaps back to 1 over a row that is still
//     painted read — the bell and the list contradicting each other on screen.
//
// ⛔ THE TWO FAILURE PATHS ARE ASSERTED SEPARATELY AND THE SECOND IS THE ONE THAT MATTERS.
// A test where only the write fails is answered by `refreshCount` and would let a repair that
// reverts `items` but not `unread` pass. The `unread` half only becomes visible when the count call
// fails too — which is the SAME outage, not a rarer one. Both are below, by name.
//
// ⚠️ EACH CASE BUILDS ITS OWN `NotificationStore`. The module's singleton carries `items`/`unread`
// across cases, and a leaked optimistic mutation is exactly the state these assertions are about.
// `start()` is never called, so no interval or `visibilitychange` listener is installed.
//
// NEGATIVE CONTROL, by name — this is today's code: replace either catch body with a bare
// `void this.refreshCount();` and re-run. Every "⛔" case below reds.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { markReadMock, markAllReadMock, unreadCountMock, listMock } = vi.hoisted(() => ({
	markReadMock: vi.fn(),
	markAllReadMock: vi.fn(),
	unreadCountMock: vi.fn(),
	listMock: vi.fn()
}));
// ⛔ ALIAS id, never a relative one — a relative mock id resolves to a different module record than
// the one the store imports and silently does nothing.
vi.mock('$lib/api/notifications', () => ({
	notificationsApi: {
		list: listMock,
		unreadCount: unreadCountMock,
		markRead: markReadMock,
		markAllRead: markAllReadMock
	}
}));

import { NotificationStore } from './notifications.svelte';
import type { AppNotification } from '$lib/types/admin';

/**
 * A real `AppNotification` — `budget.threshold` is currently the only member of the union
 * ($lib/types/admin.ts), and every field is spelled out rather than cast, so a widened union or a
 * renamed field reddens `bun run check` here instead of drifting behind an `as`.
 */
function note(id: string, read = false): AppNotification {
	return {
		id,
		kind: 'budget.threshold',
		severity: 'info',
		title: `Notification ${id}`,
		body: 'body',
		href: null,
		read,
		createdAt: '2026-08-11T00:00:00.000Z'
	};
}

/** A store holding one UNREAD notification and a badge of 1 — the panel a reader has just opened. */
function storeWithOneUnread(): NotificationStore {
	const s = new NotificationStore();
	s.items = [note('n1')];
	s.unread = 1;
	return s;
}

beforeEach(() => {
	for (const fn of [markReadMock, markAllReadMock, unreadCountMock, listMock]) fn.mockReset();
});

describe('markRead reverts BOTH halves of its optimistic update', () => {
	it('the happy path still applies it optimistically — otherwise there is nothing to revert', async () => {
		// ⛔ NON-VACUITY. Every case below asserts "after a failure the state is as it started". A
		// store that never applied the update in the first place satisfies all of them.
		markReadMock.mockResolvedValue({ id: 'n1', read: true });
		const s = storeWithOneUnread();
		await s.markRead('n1');
		expect(markReadMock).toHaveBeenCalledWith('n1');
		expect(s.items[0]!.read).toBe(true);
		expect(s.unread).toBe(0);
	});

	it('⛔ a failing write with a WORKING count: the row stops claiming to be read', async () => {
		markReadMock.mockRejectedValue(new Error('offline'));
		// The count call succeeds and reports the truth: still 1 unread.
		unreadCountMock.mockResolvedValue({ unread: 1 });
		const s = storeWithOneUnread();

		await s.markRead('n1');
		// Let the fire-and-forget `refreshCount()` settle.
		await vi.waitFor(() => expect(unreadCountMock).toHaveBeenCalled());

		// ⛔ THE HALF `refreshCount` CANNOT REACH. It assigns `unread` only — the badge snapped back
		// to 1 while the row stayed painted read, and the two contradicted each other on screen.
		expect(s.items[0]!.read, 'the row is still styled read after a failed write').toBe(false);
		expect(s.unread).toBe(1);
	});

	it('⛔ a failing write AND a failing count: the badge does not keep the optimistic number', async () => {
		// The realistic outage: whatever broke the POST breaks the GET. `refreshCount`'s catch
		// deliberately keeps the last known value — which, before this repair, was the optimistic 0.
		markReadMock.mockRejectedValue(new Error('offline'));
		unreadCountMock.mockRejectedValue(new Error('offline'));
		const s = storeWithOneUnread();

		await s.markRead('n1');
		await vi.waitFor(() => expect(unreadCountMock).toHaveBeenCalled());

		expect(s.unread, 'the decrement stuck — one unread notification counted as read').toBe(1);
		expect(s.items[0]!.read).toBe(false);
	});

	it('the count is RESTORED from the capture, not recomputed as `unread + 1`', async () => {
		// ⛔ THIS CASE EXISTS TO DISCRIMINATE, AND IN THE ORDINARY SHAPE IT WOULD NOT. With `unread`
		// untouched between the decrement and the failure, `wasUnread` and `unread + 1` produce the
		// same number and the choice is invisible. What separates them is a `refreshCount()` landing
		// INSIDE the in-flight window — a `POLL_MS` tick or a `visibilitychange`, both of which
		// assign `unread` from the server while the POST is still open. That is simulated here by
		// moving the count before the rejection.
		//
		// The repair restores the CAPTURED 2. `unread + 1` would produce 6 — a number no server ever
		// reported, arrived at by adding one to a value that already accounts for the row.
		const s = new NotificationStore();
		s.items = [note('n1'), note('n2')];
		s.unread = 2;
		markReadMock.mockImplementation(async () => {
			s.unread = 5; // a poll lands mid-flight
			throw new Error('offline');
		});
		unreadCountMock.mockRejectedValue(new Error('offline'));

		await s.markRead('n1');
		await vi.waitFor(() => expect(unreadCountMock).toHaveBeenCalled());

		expect(s.unread).toBe(2);
		expect(s.unread, 'the badge was recomputed rather than restored').not.toBe(6);
		expect(s.items.map((n) => n.read)).toEqual([false, false]);
	});

	it('a row that is already read is a no-op — the badge is not touched', async () => {
		const s = new NotificationStore();
		s.items = [note('n1', true)];
		s.unread = 3;
		await s.markRead('n1');
		expect(markReadMock, 'an already-read row still posted').not.toHaveBeenCalled();
		expect(s.unread).toBe(3);
	});
});

describe('markAllRead reverts BOTH halves of its optimistic update', () => {
	it('the happy path still applies it optimistically', async () => {
		markAllReadMock.mockResolvedValue({ read: 2 });
		const s = new NotificationStore();
		s.items = [note('n1'), note('n2')];
		s.unread = 2;

		await s.markAllRead();
		expect(markAllReadMock).toHaveBeenCalled();
		expect(s.items.every((n) => n.read)).toBe(true);
		expect(s.unread).toBe(0);
	});

	it('⛔ a failing write with a WORKING count: every row stops claiming to be read', async () => {
		markAllReadMock.mockRejectedValue(new Error('offline'));
		unreadCountMock.mockResolvedValue({ unread: 2 });
		const s = new NotificationStore();
		s.items = [note('n1'), note('n2')];
		s.unread = 2;

		await s.markAllRead();
		await vi.waitFor(() => expect(unreadCountMock).toHaveBeenCalled());

		expect(s.items.map((n) => n.read), 'the whole list is still styled read').toEqual([
			false,
			false
		]);
		expect(s.unread).toBe(2);
	});

	it('⛔ a failing write AND a failing count: the badge does not stay at 0', async () => {
		markAllReadMock.mockRejectedValue(new Error('offline'));
		unreadCountMock.mockRejectedValue(new Error('offline'));
		const s = new NotificationStore();
		s.items = [note('n1'), note('n2')];
		s.unread = 2;

		await s.markAllRead();
		await vi.waitFor(() => expect(unreadCountMock).toHaveBeenCalled());

		expect(s.unread, 'the badge kept the optimistic 0 over two unread rows').toBe(2);
		expect(s.items.every((n) => !n.read)).toBe(true);
	});

	it('a row that was ALREADY read before the failure stays read', async () => {
		// ⛔ THE REVERT MUST RESTORE, NOT BLANKET-CLEAR. `this.items.map(n => ({ ...n, read: true }))`
		// overwrites a row that was already read, so a "fix" that set every row back to `read: false`
		// would pass the two cases above and silently resurrect a notification the reader had
		// already dismissed. Restoring the captured array is what makes that impossible.
		markAllReadMock.mockRejectedValue(new Error('offline'));
		unreadCountMock.mockRejectedValue(new Error('offline'));
		const s = new NotificationStore();
		s.items = [note('n1', true), note('n2', false)];
		s.unread = 1;

		await s.markAllRead();
		await vi.waitFor(() => expect(unreadCountMock).toHaveBeenCalled());

		expect(s.items.map((n) => n.read)).toEqual([true, false]);
		expect(s.unread).toBe(1);
	});
});
