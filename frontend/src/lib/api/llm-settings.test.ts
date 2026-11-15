// @vitest-environment jsdom
//
// ⛔ Mock auth-fetch by its ALIAS id, never by the relative `./auth-fetch`, even though this file
// sits right next to it. vitest 2.1 works out the importer for a `vi.mock()` id by PARSING A STACK
// TRACE truncated to five frames (`getImporter`, vitest/dist/chunks/vi.*.js) — the test-file frame
// is the 5th of 5. A relative id is resolvable ONLY against that importer, and when it comes back
// wrong the resolve fails SILENTLY: vite-node's `_resolveUrl` falls back to the raw id, so the mock
// registers under the literal key `./auth-fetch`. Lookups are keyed by the RESOLVED path, so that
// key is never read — the real `auth-fetch.ts` loads and its `fetch()` throws `TypeError: fetch()
// URL is invalid` on a relative URL, killing every test in the file. An alias id is resolved by
// vite's alias plugin with NO importer, so it cannot fail that way, and it still intercepts this
// module's own relative import because the registry key is the resolved path either way.
// Evidence: every relative-specifier `vi.mock` in this repo has failed in CI (4 files, 3 SHAs,
// twice on the same SHA); no alias one ever has, across ~395 runs of the job. `mock-specifiers.test.ts`
// keeps it that way, and the global fetch stub in `src/lib/test/setup.ts` names it loudly if it
// ever regresses. jsdom + the keycloak mock stay as belt-and-braces.
// Smoke test for the llm-settings api client. Mocks $lib/api/auth-fetch so the real
// keycloak/$lib chain (browser-only) never loads under vitest's node env.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));
vi.mock('$lib/services/keycloak', () => ({ ensureFreshToken: async () => undefined }));

import { llmSettingsApi, ApiError } from './llm-settings';

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

beforeEach(() => authFetch.mockReset());

describe('llmSettingsApi', () => {
	it('get() requests /api/llm-settings and returns the masked config', async () => {
		authFetch.mockResolvedValue(
			jsonRes(200, { configured: true, provider: 'anthropic', model: 'claude-sonnet-4-6', hasKey: true })
		);
		const s = await llmSettingsApi.get();
		expect(authFetch).toHaveBeenCalledWith('/api/llm-settings');
		expect(s.configured).toBe(true);
		expect(s.provider).toBe('anthropic');
		expect(s.hasKey).toBe(true);
		// the api surface never exposes a raw key field
		expect((s as unknown as Record<string, unknown>).apiKey).toBeUndefined();
	});

	it('get() on an unconfigured tenant returns configured:false', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { configured: false }));
		expect((await llmSettingsApi.get()).configured).toBe(false);
	});

	it('update() PUTs the JSON body to /api/llm-settings', async () => {
		authFetch.mockResolvedValue(
			jsonRes(200, { ok: true, provider: 'openai_compatible', model: 'local-llm', baseUrl: 'http://x/api', hasKey: false })
		);
		const r = await llmSettingsApi.update({
			provider: 'openai_compatible',
			model: 'local-llm',
			baseUrl: 'http://x/api',
			apiKey: 'sk-test'
		});
		expect(authFetch).toHaveBeenCalledWith('/api/llm-settings', expect.objectContaining({ method: 'PUT' }));
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toMatchObject({
			provider: 'openai_compatible',
			model: 'local-llm',
			apiKey: 'sk-test'
		});
		expect(r.hasKey).toBe(false);
	});

	it('throws ApiError carrying the backend status + code on non-2xx', async () => {
		authFetch.mockResolvedValue(jsonRes(403, { error: 'forbidden', message: 'platform only' }));
		const err = await llmSettingsApi.get().then(
			() => null,
			(e) => e
		);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 403, code: 'forbidden', message: 'platform only' });
	});
});
