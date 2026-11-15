// src/routes/connectors/sync-outcome.ts — what a manual Sync actually did, as a value.
//
// THE DEFECT: `syncNow` optimistically set `status: 'syncing'` and then `await`ed
// `connectorsApi.sync(slug)` and THREW THE RESULT AWAY. The backend returns
// `{...connectorOut(fresh), sync: RefreshOutcome}` — the refreshed row plus a precise account of
// what happened — and none of it reached the screen:
//
//  • `{ok:false, skipped:true, reason:'locked'}` (another refresh holds the advisory lock) writes NO
//    status and sends NO NOTIFY, so the optimistic "Syncing" pill spun FOREVER until a manual
//    reload, with no message explaining why.
//  • `{ok:true, truncated:N}` was a `console.warn` in the backend and nothing at all in the browser:
//    a green "Ready" row over a silently capped row count.
//
// Pure and paraglide-free on purpose: it returns a message KEY, so the branch table is testable
// without mounting a component or stubbing the message catalog.
import type { RefreshOutcome } from '$lib/types/connectors';

/**
 * Which slot the page must write into.
 *
 * ⛔ `'error'` MEANS `actionError`, NOT the page's `error` STATE. `error` renders inside the
 * `{#if denied}…{:else if error}…{:else}` chain, which is mutually exclusive with the connector
 * table — writing an action failure there replaces the whole board the message is supposed to
 * explain. That near-miss is documented at the top of `+page.svelte` and pinned by
 * `sync-outcome.slot.test.ts`.
 */
export type SyncNotice =
	| {
			slot: 'notice';
			tone: 'ok' | 'warn';
			key: 'connectors_sync_ok' | 'connectors_sync_truncated' | 'connectors_sync_locked';
			rows?: number;
			truncated?: number;
	  }
	| { slot: 'error'; reason: string };

/** Map a `RefreshOutcome` onto the notice the page renders. Total over the four branches. */
export function syncOutcomeNotice(outcome: RefreshOutcome): SyncNotice {
	const rows = outcome.rowCount ?? 0;
	if (outcome.ok) {
		const truncated = outcome.truncated ?? 0;
		// A capped fetch is NOT a success story. The rows landed, but the dataset is short and the
		// only honest colour for that is amber.
		if (truncated > 0) {
			return { slot: 'notice', tone: 'warn', key: 'connectors_sync_truncated', rows, truncated };
		}
		return { slot: 'notice', tone: 'ok', key: 'connectors_sync_ok', rows };
	}
	// `skipped` = the per-connector advisory lock was held (a concurrent or scheduled refresh).
	// Nothing failed and nothing is wrong with the connector, so this is a warn notice, not an
	// error — but it MUST be said, because it is the branch that leaves no status behind.
	if (outcome.skipped) {
		return { slot: 'notice', tone: 'warn', key: 'connectors_sync_locked' };
	}
	return { slot: 'error', reason: outcome.reason ?? '' };
}
