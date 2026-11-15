// src/lib/components/build/run-error-visibility.ts — who reads the raw text of a HOST failure.
//
// A `node_error` with NO product `rule` and kind `internal` or `timeout` is the host reporting in its
// own words: "run pod … not Running: error: timed out waiting for the condition", or the idle
// watchdog's "the runner sent nothing for 120000ms … its pod destroyed". (Every runner-side timeout
// is ruled — `node_timeout`, `run_wall_clock_exceeded` — so an unruled one is the host's.) A member
// can act on none of it, so they read a plain message; a developer / tenant_admin / super_admin keeps
// the raw text under Details. The backend strips the text below developer too
// (`backend/src/host/run-cost-visibility.ts`); this is the same rule on the screen.
//
// ⛔ A RULED `internal` error (`block_no_default_export`, `node_no_source`, `llm_host_closed`, …) is
// NOT a host failure: it is a deterministic product sentence, localised from its rule, and retrying
// will not fix it. It must never read "try again later".
import * as m from '$lib/paraglide/messages';
import { roleAllows } from '$lib/layout/navConfig';
import type { TraceEvent } from '$lib/types/trace';

export function canSeeInternalErrors(roles: readonly string[]): boolean {
	return roleAllows('developer', roles);
}

type NodeError = Extract<TraceEvent, { type: 'node_error' }>;

/** The plain message for a host failure, or null when the event is not one. */
export function hostFailureText(ev: Pick<NodeError, 'kind' | 'rule'>): string | null {
	if (ev.rule) return null;
	if (ev.kind === 'internal') return m.build_result_internal_error();
	if (ev.kind === 'timeout') return m.build_result_idle_timeout();
	return null;
}
