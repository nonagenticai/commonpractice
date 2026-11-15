// src/lib/api/audit.ts — typed client for the platform Audit log feed.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { AuditFeed, AuditQuery } from '$lib/types/audit';

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

export const auditApi = {
	async list(params: AuditQuery = {}): Promise<AuditFeed> {
		const qs = new URLSearchParams();
		if (params.category) qs.set('category', params.category);
		if (params.range) qs.set('range', params.range);
		if (params.from) qs.set('from', params.from);
		if (params.to) qs.set('to', params.to);
		if (params.q) qs.set('q', params.q);
		if (params.page && params.page > 1) qs.set('page', String(params.page));
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/audit${suffix}`));
	},
	// Download the current filtered feed as CSV text (the server returns text/csv).
	async exportCsv(params: AuditQuery = {}): Promise<string> {
		const qs = new URLSearchParams();
		if (params.category) qs.set('category', params.category);
		if (params.range) qs.set('range', params.range);
		if (params.from) qs.set('from', params.from);
		if (params.to) qs.set('to', params.to);
		if (params.q) qs.set('q', params.q);
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		const res = await authFetch(`/api/audit/export.csv${suffix}`);
		if (!res.ok) {
			const text = await res.text();
			const body = parseBody(text) as { error?: string; message?: string } | null;
			// Same forwarding as `unwrap` above. ⚠️ The cast on the line above narrows `details` OFF the
			// type — `detailsFrom` takes `unknown` and reads the runtime value, so the bag still arrives.
			throw new ApiError(
				res.status,
				body?.error ?? 'error',
				body?.message ?? nonJsonErrorMessage(res, text),
				detailsFrom(body)
			);
		}
		return res.text();
	}
};
