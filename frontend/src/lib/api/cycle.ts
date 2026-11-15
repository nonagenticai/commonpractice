// src/lib/api/cycle.ts — typed client for the marketplace weekly-cycle controls.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { CycleState, CycleAdvanceRequest, CadenceStatus, CycleCadence, TenantCadence } from '$lib/types/cycle';

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

export const cycleApi = {
	// employee — read-only; null when the engine has not opened a week.
	async current(): Promise<CycleState | null> {
		return unwrap(await authFetch('/api/cycle/current'));
	},
	// any signed-in user — the cadence in force, and when a pending change takes over.
	async cadence(): Promise<CadenceStatus> {
		return unwrap(await authFetch('/api/cycle/cadence'));
	},
	// tenant_admin — the workspace's own voting schedule. The workspace is the caller's own: the
	// backend takes it from the sign-in and refuses one in the body (`tenant_id_not_accepted`).
	async tenantCadence(): Promise<TenantCadence> {
		return unwrap(await authFetch('/api/tenant/cycle-cadence'));
	},
	// `null` = follow the platform default again.
	async setTenantCadence(value: CycleCadence | null): Promise<TenantCadence> {
		return unwrap(
			await authFetch('/api/tenant/cycle-cadence', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value })
			})
		);
	},
	// platform — manual advance / live-verification trigger.
	async advance(body: CycleAdvanceRequest = {}): Promise<CycleState | null> {
		return unwrap(
			await authFetch('/api/cycle/advance', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
	}
};
