// src/lib/api/admin.act-as-check.test.ts — the Act-as pre-flight asks the backend the SAME question
// the post-switch reload asks: `GET /api/me` with `X-Active-Tenant-Id` set to the TARGET, and reads
// `activeTenantRejected`. Any other source (a local guess from the licence chip) could promise a
// switch the backend then silently undoes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { adminApi, ApiError } from './admin';

const TARGET = 'aaaaaaaa-0000-4000-8000-00000000a0e3';
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => authFetch.mockReset());

describe('adminApi.actAsCheck', () => {
	it('⛔ asks /api/me with the TARGET as X-Active-Tenant-Id and returns the refusal code', async () => {
		authFetch.mockResolvedValue(json({ id: 'super-1', activeTenantRejected: 'license_required' }));
		await expect(adminApi.actAsCheck(TARGET)).resolves.toBe('license_required');
		const [url, init] = authFetch.mock.calls[0]!;
		expect(url).toBe('/api/me');
		expect(new Headers((init as RequestInit).headers).get('X-Active-Tenant-Id')).toBe(TARGET);
	});

	it('admitted (no activeTenantRejected): null', async () => {
		authFetch.mockResolvedValue(json({ id: 'super-1', activeTenantRejected: null }));
		await expect(adminApi.actAsCheck(TARGET)).resolves.toBeNull();
	});

	it('a transient refusal (licences outage) is an ApiError, not a verdict', async () => {
		authFetch.mockResolvedValue(json({ error: 'license_unavailable', message: 'x' }, 402));
		await expect(adminApi.actAsCheck(TARGET)).rejects.toBeInstanceOf(ApiError);
	});
});
