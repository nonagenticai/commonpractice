// src/routes/connectors/sync-outcome.test.ts — the four branches a manual Sync can end in, and the
// slot each one must land in.
//
// The page used to `await connectorsApi.sync(slug)` and discard the result entirely, so three of
// these four branches were invisible: a lock-skipped sync left the row spinning on "Syncing"
// forever, and a truncated fetch was a green "Ready" over a silently capped row count.
import { describe, it, expect } from 'vitest';
import { syncOutcomeNotice } from './sync-outcome';

describe('syncOutcomeNotice', () => {
	it('a clean sync is an OK notice carrying the row count', () => {
		expect(syncOutcomeNotice({ ok: true, rowCount: 412 })).toEqual({
			slot: 'notice',
			tone: 'ok',
			key: 'connectors_sync_ok',
			rows: 412
		});
	});

	it('a TRUNCATED sync is a WARN, not an ok — the dataset is short', () => {
		const n = syncOutcomeNotice({ ok: true, rowCount: 1000, truncated: 37 });
		expect(n.slot).toBe('notice');
		// The bug was that `ok: true` alone decided the colour. It must not.
		expect(n).toEqual({
			slot: 'notice',
			tone: 'warn',
			key: 'connectors_sync_truncated',
			rows: 1000,
			truncated: 37
		});
	});

	it('`truncated: 0` is a plain success, not a warning', () => {
		expect(syncOutcomeNotice({ ok: true, rowCount: 9, truncated: 0 })).toMatchObject({
			tone: 'ok',
			key: 'connectors_sync_ok'
		});
	});

	it('a LOCKED (skipped) refresh is a visible warn notice, never silence', () => {
		// This is the branch that writes no status and fires no NOTIFY. If it produced nothing, the
		// optimistic "Syncing" pill would be the only thing the user ever saw.
		expect(syncOutcomeNotice({ ok: false, skipped: true, reason: 'locked' })).toEqual({
			slot: 'notice',
			tone: 'warn',
			key: 'connectors_sync_locked'
		});
	});

	it('a hard failure goes to the ERROR slot, carrying the backend reason', () => {
		expect(syncOutcomeNotice({ ok: false, reason: 'connection refused' })).toEqual({
			slot: 'error',
			reason: 'connection refused'
		});
	});

	it('a hard failure with no reason still reaches the error slot', () => {
		expect(syncOutcomeNotice({ ok: false })).toEqual({ slot: 'error', reason: '' });
	});

	it('every branch is total — nothing falls through to undefined', () => {
		const cases = [
			{ ok: true },
			{ ok: true, truncated: 5 },
			{ ok: false, skipped: true },
			{ ok: false },
			{ ok: false, skipped: false, reason: 'x' }
		];
		for (const c of cases) {
			const n = syncOutcomeNotice(c);
			expect(['notice', 'error']).toContain(n.slot);
		}
	});
});
