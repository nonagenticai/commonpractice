// src/lib/api/challenges.ts — typed client for the marketplace the Challenge leaderboard routes.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type {
	ChallengeList,
	ChallengeDetail,
	ChallengeInformation,
	InformationCard,
	InformationOption,
	ChallengeStatus,
	ChallengeSort,
	CommentList,
	CommentItem,
	VoteResult,
	CreateChallengeInput,
	ChallengeDatasetInput,
	UpdateChallengeDatasetsResult
} from '$lib/types/challenges';

export { ApiError };

async function unwrap<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = parseBody(text);
	if (!res.ok) {
		// `detailsFrom` forwards the offender's name to the localized catalog — see the ⛔ block on
		// `ApiError` (./blocks). Every sibling `unwrap` in this directory carries the same line.
		throw new ApiError(
			res.status,
			body?.error ?? 'error',
			body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
			detailsFrom(body)
		);
	}
	return body as T;
}

export interface ListChallengeParams {
	workArea?: string;
	status?: ChallengeStatus;
	sort?: ChallengeSort;
	q?: string;
	/**
	 * Only challenges still accepting solutions (`?open=true`) — the backend's `challengeClosedSql`
	 * negated, applied to the rows AND to the per-domain counts, so the chips keep summing to
	 * `total`.
	 *
	 * ⛔ NOT `status: 'voting'`. `status` is not a maintained fact on stale rows: sixteen prod
	 * challenges sat at `voting` for seven weeks with their cycles long dead, which is exactly the
	 * set this filter has to remove. Falsy sends nothing, so the route keeps its own default
	 * (everything, back catalogue included).
	 */
	open?: boolean;
	page?: number;
}

export const challengesApi = {
	async list(params: ListChallengeParams = {}): Promise<ChallengeList> {
		const qs = new URLSearchParams();
		if (params.workArea) qs.set('work_area', params.workArea);
		if (params.status) qs.set('status', params.status);
		if (params.sort) qs.set('sort', params.sort);
		if (params.q) qs.set('q', params.q);
		if (params.open) qs.set('open', 'true');
		if (params.page && params.page > 1) qs.set('page', String(params.page));
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/challenges${suffix}`));
	},

	async get(id: string): Promise<ChallengeDetail> {
		return unwrap(await authFetch(`/api/challenges/${encodeURIComponent(id)}`));
	},

	async create(input: CreateChallengeInput): Promise<{ id: string }> {
		return unwrap(
			await authFetch('/api/challenges', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			})
		);
	},

	// Phase 3.0: replace the challenge's applicable-datasets set (creator or platform).
	async updateDatasets(id: string, datasets: ChallengeDatasetInput[]): Promise<UpdateChallengeDatasetsResult> {
		return unwrap(
			await authFetch(`/api/challenges/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ datasets })
			})
		);
	},

	// W8/P1: the challenge's "Information involved" cards (localized, read-only).
	async entities(id: string): Promise<ChallengeInformation> {
		return unwrap(await authFetch(`/api/challenges/${encodeURIComponent(id)}/entities`));
	},

	// W8/P2: replace the challenge's directly linked types of information (creator or platform).
	async updateEntities(id: string, entityIds: string[]): Promise<ChallengeInformation> {
		return unwrap(
			await authFetch(`/api/challenges/${encodeURIComponent(id)}/entities`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ entityIds })
			})
		);
	},

	// W8/P3: the tenant's AI proposes types of information from the title + description only.
	// Suggestions, never links — the reader confirms each. Any failure answers `{ items: [] }`.
	async suggestEntities(input: { title: string; description: string; work_area: string }): Promise<{ items: InformationCard[] }> {
		return unwrap(
			await authFetch('/api/challenges/entity-suggestions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			})
		);
	},

	// W8/P2: what the picker offers for a work area, localized.
	async entityOptions(workArea: string): Promise<{ items: InformationOption[] }> {
		const qs = new URLSearchParams({ work_area: workArea });
		return unwrap(await authFetch(`/api/challenges/entity-options?${qs.toString()}`));
	},

	async vote(id: string): Promise<VoteResult> {
		return unwrap(await authFetch(`/api/challenges/${encodeURIComponent(id)}/vote`, { method: 'POST' }));
	},

	async unvote(id: string): Promise<VoteResult> {
		return unwrap(await authFetch(`/api/challenges/${encodeURIComponent(id)}/vote`, { method: 'DELETE' }));
	},

	async comments(id: string): Promise<CommentList> {
		return unwrap(await authFetch(`/api/challenges/${encodeURIComponent(id)}/comments`));
	},

	async postComment(id: string, body: string): Promise<CommentItem> {
		return unwrap(
			await authFetch(`/api/challenges/${encodeURIComponent(id)}/comments`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ body })
			})
		);
	}
};
