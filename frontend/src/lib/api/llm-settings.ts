// src/lib/api/llm-settings.ts — typed client for /api/llm-settings over authFetch.
// Mirrors lib/api/blocks.ts (ApiError/unwrap). The backend route is platform-gated
// and AES-256-GCM-encrypts the key; the key is NEVER returned (only `hasKey`).
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import type { ConnectionTestResult } from '$lib/i18n/connection-test-label';

/**
 * ⛔ A THIRD COPY OF `ApiError` (./blocks holds the canonical one and the full ⛔ block). `details`
 * carries the offender's name off the wire to the localized refusal catalog; without it ~20
 * `VALIDATION_MESSAGES` entries decline and the reader gets English. This module's own refusals go
 * through `bad_config`, whose sentence is chosen by `details.reason` and named by `details.field` —
 * so with no bag it does not merely lose a name, it cannot pick a sentence at all.
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

export type LlmProvider = 'anthropic' | 'openai' | 'openai_compatible';

/** A curated provider preset from the backend catalog (single source of the dropdowns). */
export interface ProviderPreset {
	key: string;
	label: string;
	adapterKind: LlmProvider;
	defaultBaseUrl: string | null;
	requiresKey: boolean;
	models: string[];
	custom?: boolean;
}

/** GET response — the current config, masked (never the key). */
export interface LlmSettings {
	configured: boolean;
	provider?: LlmProvider;
	model?: string;
	baseUrl?: string | null;
	/** The preset the UI should preselect (resolved server-side from provider + base_url). */
	preset?: string;
	temperature?: number | null;
	params?: Record<string, unknown> | null;
	hasKey?: boolean;
	/**
	 * The workspace's LLM-access posture (licences `byo_mode`); `null`/absent = unknown (no licences
	 * service, or an older backend). `platform_only` switches bringing-your-own-key OFF: the backend
	 * refuses to store a key (403 `llm_byo_disabled`) and ignores one stored earlier.
	 */
	byoMode?: 'byo_required' | 'local_allowed' | 'platform_only' | null;
}

/** PUT body — omit `apiKey` to leave the stored key untouched. */
export interface LlmSettingsUpdate {
	provider: LlmProvider;
	model: string;
	baseUrl?: string;
	temperature?: number | null;
	params?: Record<string, unknown>;
	apiKey?: string;
}

export interface LlmSettingsUpdateResult {
	ok: true;
	provider: LlmProvider;
	model: string;
	baseUrl: string | null;
	preset: string;
	temperature: number | null;
	hasKey: boolean;
}

export const llmSettingsApi = {
	async get(): Promise<LlmSettings> {
		return unwrap(await authFetch('/api/llm-settings'));
	},

	async catalog(): Promise<{ providers: ProviderPreset[] }> {
		return unwrap(await authFetch('/api/llm-settings/catalog'));
	},

	async update(body: LlmSettingsUpdate): Promise<LlmSettingsUpdateResult> {
		return unwrap(
			await authFetch('/api/llm-settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
	},

	/** Verify a provider config answers a 1-token ping. Pass the in-progress form to test
	 *  unsaved edits; omit it to test the stored row. {ok, detail}. */
	/**
	 * ⛔ THIS ENDPOINT ANSWERS HTTP 200 EVEN WHEN THE TEST FAILS — deliberately: a bad credential is
	 * a normal test RESULT, not a transport error. So nothing throws, `errorText` never runs, and
	 * `detail` (an English sentence built server-side) used to be rendered raw on screen, success
	 * path included. `code`/`params` carry the machine facts; `$lib/i18n/connection-test-label`
	 * turns them into the reader's words and falls back to `detail` for a code it does not know.
	 *
	 * Both are OPTIONAL because an old pod mid-roll ships neither.
	 */
	async test(
		body?: LlmSettingsUpdate
	): Promise<ConnectionTestResult & { provider?: string; model?: string }> {
		return unwrap(
			await authFetch('/api/llm-settings/test', {
				method: 'POST',
				...(body
					? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
					: {})
			})
		);
	}
};
