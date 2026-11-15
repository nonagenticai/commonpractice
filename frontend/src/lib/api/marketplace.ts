// src/lib/api/marketplace.ts — Home summary + weekly winner client.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { HomeSummary, WeeklyWinner } from '$lib/types/marketplace';

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

export const marketplaceApi = {
	async home(): Promise<HomeSummary> {
		return unwrap(await authFetch('/api/home/summary'));
	},
	async winner(): Promise<WeeklyWinner> {
		return unwrap(await authFetch('/api/winner'));
	}
};
