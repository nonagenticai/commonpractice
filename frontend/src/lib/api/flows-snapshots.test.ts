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
// Smoke test for the §3-H flow-history client methods. Mocks $lib/api/auth-fetch (and the
// blocks module it re-exports ApiError from) so the browser-only keycloak chain never
// loads under vitest's node env. Verifies URL + method shaping only.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));
// flows.ts re-exports ApiError from ./blocks, which transitively imports
// $lib/services/sse. That chain is NOT browser-only (sse.ts uses fetch +
// ReadableStream, never window/EventSource), so this stub is belt-and-braces
// rather than load-bearing — kept only to hold this fix to a single variable.
vi.mock('$lib/api/blocks', () => ({ ApiError: class ApiError extends Error {} }));
vi.mock('$lib/services/keycloak', () => ({ ensureFreshToken: async () => undefined }));

import { flowsApi } from './flows';

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

beforeEach(() => authFetch.mockReset());

describe('flowsApi history methods', () => {
	it('listSnapshots() GETs /api/flows/:id/snapshots', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { items: [], readOnly: false }));
		const r = await flowsApi.listSnapshots('flow 1');
		expect(authFetch).toHaveBeenCalledWith('/api/flows/flow%201/snapshots');
		expect(r.readOnly).toBe(false);
	});

	it('getSnapshot() GETs the snapshot sub-path', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { id: 's1', graph: { nodes: [], edges: [] } }));
		await flowsApi.getSnapshot('f1', 's1');
		expect(authFetch).toHaveBeenCalledWith('/api/flows/f1/snapshots/s1');
	});

	it('checkpoint() POSTs a summary body', async () => {
		authFetch.mockResolvedValue(jsonRes(201, { id: 's2', source: 'manual', summary: 'hi' }));
		await flowsApi.checkpoint('f1', 'hi');
		expect(authFetch).toHaveBeenCalledWith(
			'/api/flows/f1/snapshots',
			expect.objectContaining({ method: 'POST' })
		);
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ summary: 'hi' });
	});

	it('checkpoint() with no summary POSTs an empty body', async () => {
		authFetch.mockResolvedValue(jsonRes(201, { id: 's3', source: 'manual', summary: 'Manual checkpoint' }));
		await flowsApi.checkpoint('f1');
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({});
	});

	it('restoreSnapshot() POSTs the restore sub-path', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { id: 'f1', graph: { nodes: [], edges: [] }, validation: null }));
		await flowsApi.restoreSnapshot('f1', 's1');
		expect(authFetch).toHaveBeenCalledWith(
			'/api/flows/f1/snapshots/s1/restore',
			expect.objectContaining({ method: 'POST' })
		);
	});
});
