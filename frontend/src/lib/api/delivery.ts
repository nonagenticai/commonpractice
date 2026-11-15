// src/lib/api/delivery.ts — typed client for /api/delivery-targets over authFetch (Phase 5 / 5A).
// Mirrors lib/api/llm-settings.ts (ApiError/unwrap). The backend route is tenant_admin-gated and
// secret-box-encrypts the connector credentials; credentials are NEVER returned (only
// `hasCredentials`). Dispatch ("Forward to delivery") arrives in 5B.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import type { ConnectionTestResult } from '$lib/i18n/connection-test-label';

/**
 * ⛔ A FOURTH COPY OF `ApiError` (./blocks holds the canonical one and the full ⛔ block). `details`
 * carries the offender's name off the wire to the localized refusal catalog; without it ~20
 * `VALIDATION_MESSAGES` entries decline and the reader gets English. Like ./llm-settings, this
 * module's refusals are `bad_config`, whose SENTENCE is selected by `details.reason` — an empty bag
 * costs the whole choice, not just the name.
 */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'ApiError';
	}
}

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

export type DeliveryKind = 'jira' | 'azure_devops' | 'fr';

/** A configured connector as returned by the API — credentials are masked to a boolean. */
export interface DeliveryTarget {
	id: string;
	kind: DeliveryKind;
	name: string;
	baseUrl: string | null;
	projectKey: string | null;
	defaultItemType: string | null;
	config: Record<string, unknown>;
	enabled: boolean;
	hasCredentials: boolean;
	createdAt: string;
	updatedAt: string;
}

/** Create body. Omit `credentials` to create a connector with none yet. */
export interface DeliveryTargetCreate {
	kind: DeliveryKind;
	name: string;
	baseUrl?: string;
	projectKey?: string;
	defaultItemType?: string;
	config?: Record<string, unknown>;
	credentials?: Record<string, unknown>;
	enabled?: boolean;
}

/** Update body — every field optional; omit `credentials` to keep the stored blob. `kind` is fixed. */
export type DeliveryTargetUpdate = Partial<Omit<DeliveryTargetCreate, 'kind'>>;

/** The lifecycle of a "Forward to delivery" attempt (mirrors the `delivery_status` enum). */
export type DeliveryStatus =
	| 'pending'
	| 'sent'
	| 'created'
	| 'draft_created'
	| 'approved'
	| 'promoted'
	| 'rejected'
	| 'failed';

/** A delivery attempt for a solution (the client-safe projection — no payload/credentials). */
export interface Delivery {
	id: string;
	targetId: string | null;
	targetKind: DeliveryKind;
	status: DeliveryStatus;
	externalRef: string | null;
	externalUrl: string | null;
	/**
	 * The adapter's ENGLISH sentence, exactly as `solution_deliveries.error` stores it.
	 *
	 * ⛔ IT IS STILL HERE ON PURPOSE. It is the fallback `deliveryErrorLabel` renders when there is
	 * no `errorCode` — which is every row written before the code existed, and every failure outside
	 * the typed taxonomy — and it is what the row's `title=` tooltip keeps showing even when the
	 * visible text is localized. An English sentence is a worse read than a Dutch one and an
	 * infinitely better read than nothing.
	 */
	error: string | null;
	/**
	 * The stable failure classification: `delivery_target_credentials_missing`, `timeout`,
	 * `transport`, `target_http_error`, `delivery_target_credentials_invalid`,
	 * `delivery_target_incomplete`, the four `egress_*`, or `delivery_ledger_update_failed`.
	 *
	 * `null` for a HISTORICAL row (written before the backend persisted the code — those are not
	 * migrated) and for a genuinely unclassified failure. Both mean the same thing to the renderer:
	 * fall back to `error`.
	 */
	errorCode: string | null;
	/** The target's HTTP status for `target_http_error`; `0` for transport/timeout, `null` otherwise. */
	errorStatus: number | null;
	createdAt: string;
	updatedAt: string;
}

const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

export const deliveryApi = {
	async list(): Promise<DeliveryTarget[]> {
		const { targets } = await unwrap<{ targets: DeliveryTarget[] }>(
			await authFetch('/api/delivery-targets')
		);
		return targets;
	},

	async create(body: DeliveryTargetCreate): Promise<DeliveryTarget> {
		const { target } = await unwrap<{ target: DeliveryTarget }>(
			await authFetch('/api/delivery-targets', json('POST', body))
		);
		return target;
	},

	async update(id: string, body: DeliveryTargetUpdate): Promise<DeliveryTarget> {
		const { target } = await unwrap<{ target: DeliveryTarget }>(
			await authFetch(`/api/delivery-targets/${id}`, json('PUT', body))
		);
		return target;
	},

	async remove(id: string): Promise<void> {
		await unwrap(await authFetch(`/api/delivery-targets/${id}`, { method: 'DELETE' }));
	},

	/** Verify a saved target's config + credentials without dispatching. {ok, code, params?, detail}. */
	/**
	 * ⛔ THIS ENDPOINT ANSWERS HTTP 200 EVEN WHEN THE TEST FAILS — deliberately: a bad credential is
	 * a normal test RESULT, not a transport error. So nothing throws, `errorText` never runs, and
	 * `detail` (an English sentence built server-side) used to be rendered raw on screen, success
	 * path included. `code`/`params` carry the machine facts; `$lib/i18n/connection-test-label`
	 * turns them into the reader's words and falls back to `detail` for a code it does not know.
	 *
	 * Both are OPTIONAL because an old pod mid-roll ships neither.
	 */
	async test(id: string): Promise<ConnectionTestResult> {
		return unwrap(await authFetch(`/api/delivery-targets/${id}/test`, { method: 'POST' }));
	},

	/** The delivery attempts for a solution (newest first) — the status chip's data source. */
	async listForSolution(solutionId: string): Promise<Delivery[]> {
		const { deliveries } = await unwrap<{ deliveries: Delivery[] }>(
			await authFetch(`/api/solutions/${encodeURIComponent(solutionId)}/deliveries`)
		);
		return deliveries;
	},

	/** Forward a solution to a configured connector. Resolves with the resulting delivery whether
	 *  it was created or failed (the `status` drives the UI); throws ApiError on 4xx (403/404/409/422). */
	async forward(solutionId: string, targetId: string): Promise<Delivery> {
		const { delivery } = await unwrap<{ delivery: Delivery }>(
			await authFetch(
				`/api/solutions/${encodeURIComponent(solutionId)}/forward`,
				json('POST', { target_id: targetId })
			)
		);
		return delivery;
	},

	/** Re-dispatch a failed/rejected delivery (reuses its stored payload). */
	async retry(solutionId: string, deliveryId: string): Promise<Delivery> {
		const { delivery } = await unwrap<{ delivery: Delivery }>(
			await authFetch(
				`/api/solutions/${encodeURIComponent(solutionId)}/forward/${encodeURIComponent(deliveryId)}/retry`,
				{ method: 'POST' }
			)
		);
		return delivery;
	}
};
