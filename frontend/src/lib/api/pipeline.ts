// src/lib/api/pipeline.ts — typed client for the platform Production-pipeline kanban.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { PipelineBoard, PipelineCard, PipelinePatch } from '$lib/types/pipeline';

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

export const pipelineApi = {
	async board(): Promise<PipelineBoard> {
		return unwrap(await authFetch('/api/pipeline'));
	},
	async move(id: string, patch: PipelinePatch): Promise<PipelineCard> {
		return unwrap(
			await authFetch(`/api/pipeline/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			})
		);
	},
	async enqueue(solutionId: string): Promise<PipelineCard> {
		return unwrap(
			await authFetch('/api/pipeline/enqueue', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ solutionId })
			})
		);
	},
	async rollback(id: string): Promise<PipelineCard> {
		return unwrap(
			await authFetch(`/api/pipeline/${encodeURIComponent(id)}/rollback`, { method: 'POST' })
		);
	}
};
