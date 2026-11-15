// src/lib/api/governance.ts — typed client for the platform Governance screen.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { Governance, Policy, PolicyValue, ExportResult } from '$lib/types/governance';

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

export const governanceApi = {
	async get(): Promise<Governance> {
		return unwrap(await authFetch('/api/governance'));
	},
	async update(key: string, value: PolicyValue): Promise<Policy> {
		return unwrap(
			await authFetch(`/api/governance/${encodeURIComponent(key)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value })
			})
		);
	},
	// Trigger a compliance export on demand (defaults to yesterday UTC on the server).
	async exportNow(): Promise<ExportResult> {
		return unwrap(
			await authFetch('/api/audit/export', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			})
		);
	}
};
