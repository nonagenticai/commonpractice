// src/lib/api/solutions.ts — typed client for the marketplace the Solution leaderboard routes.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage } from './parse';
import { ApiError } from './blocks';
import { graphIssuesFrom, type IssueCarryingDetails } from './graph-issues';
import type { SolutionList, SolutionDetail, CreateSolutionInput } from '$lib/types/solutions';
import type { VoteResult } from '$lib/types/challenges';
import type { GraphIssue } from '$lib/types/flows';

export { ApiError };

export interface SolutionErrorDetails extends IssueCarryingDetails {
	/** Present on a policy refusal (`enforceRunPolicies`, routes/solutions.ts). */
	policyKey?: string;
	requestId?: string;
}

/**
 * The error every `solutionsApi` call throws. Extends `ApiError` — so existing `instanceof ApiError`
 * checks and `errorText`/`writeErrorText`'s status+code duck-typing are unaffected — and adds the
 * `details` bag the plain `ApiError` had no field for.
 *
 * That missing field is why submitting a solution could only ever say "The flow is not ready to
 * publish." `POST /api/solutions` refuses an unpublishable graph with
 * `unprocessable('flow_invalid', …, { issues })` naming each offending node, and `unwrap()` read
 * `body.error`/`body.message` and dropped the rest on the floor.
 */
export class SolutionApiError extends ApiError {
	constructor(
		status: number,
		code: string,
		message: string,
		readonly details: SolutionErrorDetails = {}
	) {
		super(status, code, message);
		this.name = 'SolutionApiError';
	}
}

/**
 * The actionable per-node issues behind a refused `solutionsApi.create()`, or `[]`.
 *
 * Mirrors `runErrorIssues` (./runs) exactly — same body shape, same structural guard, same
 * deliberate refusal to gate on `code === 'flow_invalid'` (any 4xx carrying `details.issues` is
 * saying something per-node; the guard in ./graph-issues is what keeps a Zod-issue body out).
 */
export function solutionErrorIssues(e: unknown): GraphIssue[] {
	if (!(e instanceof SolutionApiError)) return [];
	return graphIssuesFrom(e.details);
}

async function unwrap<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = parseBody(text);
	if (!res.ok) {
		throw new SolutionApiError(
			res.status,
			body?.error ?? 'error',
			body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
			// Same merge as runs.ts `unwrap`: `route()` writes `details` AND spreads the same fields
			// at the top level for clients that have not migrated, so read both.
			{ ...(body?.details ?? {}), ...body, requestId: body?.requestId }
		);
	}
	return body as T;
}

/**
 * Params for the solution leaderboard. An options object rather than positionals: `q` is a THIRD
 * axis and `list(id, page, q)` would have made every call site carry a `1` it does not mean.
 * Mirrors `ListChallengeParams` in ./challenges. One call site (routes/solutions/+page.svelte).
 */
export interface ListSolutionParams {
	challengeId?: string;
	/** Server-side search over title ∪ author name ∪ block slug. */
	q?: string;
	page?: number;
}

export const solutionsApi = {
	async list(params: ListSolutionParams = {}): Promise<SolutionList> {
		const qs = new URLSearchParams();
		if (params.challengeId) qs.set('challenge_id', params.challengeId);
		if (params.q) qs.set('q', params.q);
		if (params.page && params.page > 1) qs.set('page', String(params.page));
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/solutions${suffix}`));
	},

	async get(id: string): Promise<SolutionDetail> {
		return unwrap(await authFetch(`/api/solutions/${encodeURIComponent(id)}`));
	},

	async create(input: CreateSolutionInput): Promise<{ id: string }> {
		return unwrap(
			await authFetch('/api/solutions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			})
		);
	},

	async vote(id: string): Promise<VoteResult> {
		return unwrap(await authFetch(`/api/solutions/${encodeURIComponent(id)}/vote`, { method: 'POST' }));
	},

	async unvote(id: string): Promise<VoteResult> {
		return unwrap(await authFetch(`/api/solutions/${encodeURIComponent(id)}/vote`, { method: 'DELETE' }));
	}
};
