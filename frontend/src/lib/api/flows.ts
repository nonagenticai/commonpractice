// src/lib/api/flows.ts — typed client for /api/flows over authFetch.
// Mirrors the blocks client (ApiError + unwrap). Flows are owner-scoped, so
// every call resolves against the authenticated user on the backend.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type {
	Flow,
	FlowGraph,
	FlowListItem,
	FlowSnapshot,
	FlowSnapshotSummary,
	FlowStatus,
	FlowWithValidation
} from '$lib/types/flows';

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

export interface ListFlowParams {
	status?: FlowStatus;
	q?: string;
}

export interface UpdateFlowBody {
	name?: string;
	description?: string;
	graph?: FlowGraph;
	status?: FlowStatus;
}

export const flowsApi = {
	async list(params: ListFlowParams = {}): Promise<{ items: FlowListItem[]; total: number }> {
		const qs = new URLSearchParams();
		if (params.status) qs.set('status', params.status);
		if (params.q) qs.set('q', params.q);
		const suffix = qs.toString() ? `?${qs}` : '';
		return unwrap(await authFetch(`/api/flows${suffix}`));
	},

	async get(id: string): Promise<Flow> {
		return unwrap(await authFetch(`/api/flows/${encodeURIComponent(id)}`));
	},

	async create(body: { name: string; description?: string }): Promise<Flow> {
		return unwrap(
			await authFetch('/api/flows', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
	},

	async save(id: string, patch: UpdateFlowBody): Promise<FlowWithValidation> {
		return unwrap(
			await authFetch(`/api/flows/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			})
		);
	},

	async remove(id: string): Promise<void> {
		const res = await authFetch(`/api/flows/${encodeURIComponent(id)}`, { method: 'DELETE' });
		if (!res.ok && res.status !== 204) await unwrap(res);
	},

	// ---- history timeline (§3-H) ----

	async listSnapshots(
		flowId: string
	): Promise<{ items: FlowSnapshotSummary[]; readOnly: boolean }> {
		return unwrap(await authFetch(`/api/flows/${encodeURIComponent(flowId)}/snapshots`));
	},

	async getSnapshot(flowId: string, snapshotId: string): Promise<FlowSnapshot> {
		return unwrap(
			await authFetch(
				`/api/flows/${encodeURIComponent(flowId)}/snapshots/${encodeURIComponent(snapshotId)}`
			)
		);
	},

	async checkpoint(flowId: string, summary?: string): Promise<FlowSnapshotSummary> {
		return unwrap(
			await authFetch(`/api/flows/${encodeURIComponent(flowId)}/snapshots`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(summary ? { summary } : {})
			})
		);
	},

	async restoreSnapshot(flowId: string, snapshotId: string): Promise<FlowWithValidation> {
		return unwrap(
			await authFetch(
				`/api/flows/${encodeURIComponent(flowId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
				{ method: 'POST' }
			)
		);
	}
};
