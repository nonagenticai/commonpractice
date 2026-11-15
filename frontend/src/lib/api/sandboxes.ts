// src/lib/api/sandboxes.ts — typed client for the platform Ops sandbox routes.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { SandboxList, SandboxDetail, SandboxStatus } from '$lib/types/sandboxes';

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

export interface ListSandboxParams {
	status?: SandboxStatus | 'all';
	q?: string;
	page?: number;
}

export const sandboxesApi = {
	async list(params: ListSandboxParams = {}): Promise<SandboxList> {
		const qs = new URLSearchParams();
		if (params.status && params.status !== 'all') qs.set('status', params.status);
		if (params.q) qs.set('q', params.q);
		if (params.page && params.page > 1) qs.set('page', String(params.page));
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/sandboxes${suffix}`));
	},

	async get(id: string): Promise<SandboxDetail> {
		return unwrap(await authFetch(`/api/sandboxes/${encodeURIComponent(id)}`));
	},

	async pause(id: string): Promise<void> {
		await unwrap(await authFetch(`/api/sandboxes/${encodeURIComponent(id)}/pause`, { method: 'POST' }));
	},

	async resume(id: string): Promise<void> {
		await unwrap(await authFetch(`/api/sandboxes/${encodeURIComponent(id)}/resume`, { method: 'POST' }));
	},

	async provision(ownerId?: string): Promise<{ id: string }> {
		return unwrap(
			await authFetch('/api/sandboxes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(ownerId ? { ownerId } : {})
			})
		);
	}
};
