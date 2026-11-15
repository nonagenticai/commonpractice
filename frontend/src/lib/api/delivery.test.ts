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
// Smoke test for the delivery api client. Mocks $lib/api/auth-fetch so the browser-only keycloak
// chain never loads under vitest's node env. Mirrors llm-settings.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));
vi.mock('$lib/services/keycloak', () => ({ ensureFreshToken: async () => undefined }));

import { deliveryApi, ApiError, type DeliveryTarget } from './delivery';

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const TARGET: DeliveryTarget = {
	id: 't1',
	kind: 'jira',
	name: 'Acme Jira',
	baseUrl: 'https://acme.atlassian.net',
	projectKey: 'DEL',
	defaultItemType: 'Epic',
	config: {},
	enabled: true,
	hasCredentials: true,
	createdAt: '2026-06-12T00:00:00Z',
	updatedAt: '2026-06-12T00:00:00Z'
};

beforeEach(() => authFetch.mockReset());

describe('deliveryApi', () => {
	it('list() requests /api/delivery-targets and unwraps the array', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { targets: [TARGET] }));
		const rows = await deliveryApi.list();
		expect(authFetch).toHaveBeenCalledWith('/api/delivery-targets');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.hasCredentials).toBe(true);
		// the masked surface never carries a raw credentials field
		expect((rows[0] as unknown as Record<string, unknown>).credentials).toBeUndefined();
	});

	it('create() POSTs the JSON body and returns the created target', async () => {
		authFetch.mockResolvedValue(jsonRes(201, { target: TARGET }));
		const t = await deliveryApi.create({
			kind: 'jira',
			name: 'Acme Jira',
			credentials: { email: 'a@b.io', apiToken: 'x' }
		});
		expect(authFetch).toHaveBeenCalledWith(
			'/api/delivery-targets',
			expect.objectContaining({ method: 'POST' })
		);
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toMatchObject({ kind: 'jira', name: 'Acme Jira' });
		expect(t.id).toBe('t1');
	});

	it('update() PUTs to /api/delivery-targets/:id', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { target: { ...TARGET, name: 'Renamed' } }));
		const t = await deliveryApi.update('t1', { name: 'Renamed' });
		expect(authFetch).toHaveBeenCalledWith(
			'/api/delivery-targets/t1',
			expect.objectContaining({ method: 'PUT' })
		);
		expect(t.name).toBe('Renamed');
	});

	it('remove() DELETEs /api/delivery-targets/:id', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { ok: true }));
		await deliveryApi.remove('t1');
		expect(authFetch).toHaveBeenCalledWith('/api/delivery-targets/t1', { method: 'DELETE' });
	});

	it('throws ApiError carrying status + code on non-2xx', async () => {
		authFetch.mockResolvedValue(jsonRes(409, { error: 'delivery_target_name_taken', message: 'taken' }));
		const err = await deliveryApi.create({ kind: 'fr', name: 'dup' }).then(
			() => null,
			(e) => e
		);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 409, code: 'delivery_target_name_taken' });
	});

	// ── Phase 5B: forward / retry / listForSolution ─────────────────────────────────────────

	it('listForSolution() GETs /api/solutions/:id/deliveries and unwraps the array', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { deliveries: [{ id: 'd1', status: 'created' }] }));
		const rows = await deliveryApi.listForSolution('sol-1');
		expect(authFetch).toHaveBeenCalledWith('/api/solutions/sol-1/deliveries');
		expect(rows[0]!.status).toBe('created');
	});

	it('forward() POSTs { target_id } to /api/solutions/:id/forward and returns the delivery', async () => {
		authFetch.mockResolvedValue(jsonRes(201, { delivery: { id: 'd1', status: 'created', externalRef: 'DEL-1' } }));
		const d = await deliveryApi.forward('sol-1', 't1');
		expect(authFetch).toHaveBeenCalledWith(
			'/api/solutions/sol-1/forward',
			expect.objectContaining({ method: 'POST' })
		);
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ target_id: 't1' });
		expect(d.externalRef).toBe('DEL-1');
	});

	it('retry() POSTs to /api/solutions/:id/forward/:deliveryId/retry', async () => {
		authFetch.mockResolvedValue(jsonRes(201, { delivery: { id: 'd2', status: 'created' } }));
		await deliveryApi.retry('sol-1', 'd1');
		expect(authFetch).toHaveBeenCalledWith(
			'/api/solutions/sol-1/forward/d1/retry',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('forward() throws ApiError on 409 delivery_already_live', async () => {
		authFetch.mockResolvedValue(jsonRes(409, { error: 'delivery_already_live', message: 'live' }));
		const err = await deliveryApi.forward('sol-1', 't1').then(
			() => null,
			(e) => e
		);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 409, code: 'delivery_already_live' });
	});
});
