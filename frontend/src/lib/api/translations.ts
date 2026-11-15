// src/lib/api/translations.ts — typed client for the platform translation-management
// API (Phase 2-G). queue/backfill, drain-now, jobs+coverage, and human override. All
// endpoints are platform-gated server-side; 401/403 surface as ApiError for the screen.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { JobsResponse, QueueRequest, BatchResult } from '$lib/types/translation';

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

const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

export const translationsApi = {
	async jobs(params: { status?: string; entityType?: string } = {}): Promise<JobsResponse> {
		const q = new URLSearchParams();
		if (params.status) q.set('status', params.status);
		if (params.entityType) q.set('entityType', params.entityType);
		const qs = q.toString();
		return unwrap(await authFetch(`/api/admin/translations/jobs${qs ? `?${qs}` : ''}`));
	},
	/** `matched` is how many CONTENT ROWS the backfill could see; `queued` how many locale cells it
	 *  wrote. The backfill runs in the caller's own tenant scope (it is deliberately NOT
	 *  platform-wide — see backend/src/routes/translations.ts), so `queued: 0` with `matched > 0`
	 *  means "already up to date", while an explicit `entityId` that matches nothing is a 404
	 *  rather than a green zero. */
	async queue(body: QueueRequest = {}): Promise<{ queued: number; matched: number }> {
		return unwrap(await authFetch('/api/admin/translations/queue', json('POST', body)));
	},
	async run(): Promise<BatchResult> {
		return unwrap(await authFetch('/api/admin/translations/run', json('POST', {})));
	},
	async override(id: string, value: string): Promise<{ ok: boolean }> {
		return unwrap(await authFetch(`/api/admin/translations/${id}`, json('PATCH', { value })));
	}
};
