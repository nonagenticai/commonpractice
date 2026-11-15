// src/lib/api/graph-issues.ts — the ONE reader for the per-node `details.issues` array a backend
// 422 carries, shared by every typed client that can receive one.
//
// `POST /api/runs` answers an unrunnable graph with
// `unprocessable('flow_invalid', 'The flow is not ready to run.', { issues })`
// (backend/src/host/run-controller.ts) and `POST /api/solutions` answers an unpublishable one with
// the same shape (backend/src/routes/solutions.ts) — same validators, same `GraphIssue[]`. Callers
// used to render only the top-level message, so the author was told the flow "is not ready" and
// never which node — the one thing the backend had already computed for them.
//
// This lives in its own module rather than being copied per client so there is exactly one shape
// and one guard: a second copy is a second thing to keep in step with `flow-validate.ts`.
import type { GraphIssue } from '$lib/types/flows';

/** The `details` bag on a typed client's error, as far as this module cares about it. */
export interface IssueCarryingDetails {
	issues?: unknown;
	[key: string]: unknown;
}

/**
 * Structural check that one entry of `details.issues` is a `GraphIssue`.
 *
 * `issues` is literally whatever the backend put in the response body, so `raw as GraphIssue[]`
 * would be a claim about data nothing ever inspected. It is not even always a graph issue:
 * `route()`'s ZodError branch (backend/src/utils/http.ts:130) emits `details: { issues: err.issues }`
 * too, and a Zod issue has `code`/`path`, no `rule`. Validating here is what keeps that shape out of
 * the rendered list — which matters more now that `POST /api/solutions` has a `.strict()` schema, so
 * a stray request key produces exactly that Zod body.
 *
 * `rule` is deliberately checked as a plain `string`, NOT re-declared as the 12-value union in
 * backend/src/exec/flow-validate.ts. Mirroring that union would mean a rule shipped backend-first
 * fails this guard and VANISHES from the UI — reintroducing the exact information loss this
 * function exists to fix, and silently. An unrecognised rule still carries a human-readable
 * `message`, which is the only field the UI renders.
 */
export function isGraphIssue(v: unknown): v is GraphIssue {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o.rule !== 'string' || typeof o.message !== 'string') return false;
	// `ref` is optional, but when present it must be the node/edge id string the UI resolves.
	if (o.ref !== undefined && typeof o.ref !== 'string') return false;
	return isGraphIssueDetail(o.detail);
}

/**
 * `detail` is the identifier bag `graphIssueLabel` interpolates into a localized sentence, so it is
 * checked for the two things that reading it can go wrong on: that it is a plain object (an ARRAY
 * would index numerically and yield `undefined` for every named field; `null` would throw), and
 * that every value is a `string` (a number or a nested object would be interpolated into the
 * sentence as `[object Object]`).
 *
 * ⛔ AN UNKNOWN KEY IS ACCEPTED, deliberately, and for exactly the reason `rule` is a plain
 * `string` above: `detail` is a backend-first field. Rejecting an issue because it carries a
 * thirteenth key this build has never heard of would make the whole issue VANISH from the list —
 * trading a field the UI would simply ignore for the entire sentence, which is the information loss
 * this module exists to prevent. Absent is fine too: `graphIssueLabel` falls back to the English
 * `message` rather than interpolating `undefined`.
 */
function isGraphIssueDetail(v: unknown): boolean {
	if (v === undefined) return true;
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

/** Every well-formed `GraphIssue` in a `details` bag, or `[]` when there are none. */
export function graphIssuesFrom(details: IssueCarryingDetails | undefined): GraphIssue[] {
	const raw = details?.issues;
	if (!Array.isArray(raw)) return [];
	return raw.filter(isGraphIssue);
}
