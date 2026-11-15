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
// Smoke test for the C.2a onboarding wrappers on adminApi. Mocks $lib/api/auth-fetch so the
// browser-only keycloak/$lib chain never loads under vitest's node env. Asserts each
// wrapper hits the right endpoint/method/body and surfaces ApiError on non-2xx.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));
vi.mock('$lib/services/keycloak', () => ({ ensureFreshToken: async () => undefined }));

import { adminApi, ApiError } from './admin';

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
beforeEach(() => authFetch.mockReset());

describe('adminApi onboarding wrappers', () => {
	it('signupApprovals() GETs the queue with a status filter', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { approvals: [] }));
		await adminApi.signupApprovals('pending');
		expect(authFetch).toHaveBeenCalledWith('/api/signup-approvals?status=pending');
	});

	it('approveSignup() POSTs the existing-tenant mode to the approve route', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { approval: { id: 'a1' }, tenantId: 't1', role: 'tenant_admin', invite: null }));
		await adminApi.approveSignup('a1', { mode: 'existing', tenantId: 't1', role: 'tenant_admin' });
		expect(authFetch).toHaveBeenCalledWith('/api/signup-approvals/a1/approve', expect.objectContaining({ method: 'POST' }));
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ mode: 'existing', tenantId: 't1', role: 'tenant_admin' });
	});

	it('approveSignup() POSTs the new-tenant mode with name + BYO posture', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { approval: { id: 'a1' }, tenantId: 't9', role: 'tenant_admin', invite: null }));
		await adminApi.approveSignup('a1', { mode: 'new_tenant', tenantName: 'Acme', byoMode: 'byo_required' });
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ mode: 'new_tenant', tenantName: 'Acme', byoMode: 'byo_required' });
	});

	it('inviteEarlyAccess() POSTs {email, name, company} to /api/signup-approvals/invite and returns the approve payload', async () => {
		const payload = {
			approval: { id: 'a7', status: 'approved', source: 'invite' },
			tenantId: 't7',
			role: 'tenant_admin',
			seated: false,
			invite: { id: 'i7', email: 'ann@acme.com', emailDelivery: 'keycloak_actions' },
			tenant: { id: 't7', name: 'Acme', slug: 'acme', licencesName: 'acme' }
		};
		authFetch.mockResolvedValue(jsonRes(200, payload));
		const r = await adminApi.inviteEarlyAccess({ email: 'ann@acme.com', name: 'Ann', company: 'Acme' });
		expect(authFetch).toHaveBeenCalledWith('/api/signup-approvals/invite', expect.objectContaining({ method: 'POST' }));
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ email: 'ann@acme.com', name: 'Ann', company: 'Acme' });
		expect(r.tenant?.slug).toBe('acme');
		expect(r.invite?.emailDelivery).toBe('keycloak_actions');
	});

	it('inviteEarlyAccess() surfaces a 409 refusal as an ApiError with its code', async () => {
		authFetch.mockResolvedValue(
			jsonRes(409, { error: 'user_belongs_to_another_workspace', message: 'This email already belongs to another workspace.' })
		);
		const err = (await adminApi.inviteEarlyAccess({ email: 'x@acme.com', name: 'X' }).catch((e) => e)) as ApiError;
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 409, code: 'user_belongs_to_another_workspace' });
	});

	it('rejectSignup() POSTs to the reject route', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { approval: { id: 'a1' } }));
		await adminApi.rejectSignup('a1');
		expect(authFetch).toHaveBeenCalledWith('/api/signup-approvals/a1/reject', expect.objectContaining({ method: 'POST' }));
	});

	it('invite() POSTs the body to /api/invites', async () => {
		authFetch.mockResolvedValue(jsonRes(201, { invite: { id: 'i1', email: 'x@y.z', tenantId: 't1', role: 'member' } }));
		await adminApi.invite({ email: 'x@y.z', tenantId: 't1', role: 'member' });
		expect(authFetch).toHaveBeenCalledWith('/api/invites', expect.objectContaining({ method: 'POST' }));
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toMatchObject({ email: 'x@y.z', tenantId: 't1', role: 'member' });
	});

	it('upsertEmailDomain() POSTs and deleteEmailDomain() DELETEs the encoded domain', async () => {
		authFetch.mockResolvedValue(jsonRes(201, { domain: { domain: 'acme.com', tenant_id: 't1', auto_assign: true } }));
		await adminApi.upsertEmailDomain({ domain: 'acme.com', tenantId: 't1' });
		expect(authFetch).toHaveBeenCalledWith('/api/email-domains', expect.objectContaining({ method: 'POST' }));

		authFetch.mockResolvedValue(jsonRes(200, { ok: true }));
		await adminApi.deleteEmailDomain('acme.com');
		expect(authFetch).toHaveBeenCalledWith('/api/email-domains/acme.com', expect.objectContaining({ method: 'DELETE' }));
	});

	it('surfaces ApiError with status + code on a 403', async () => {
		authFetch.mockResolvedValue(jsonRes(403, { error: 'super_admin_required', message: 'nope' }));
		const err = await adminApi.signupApprovals().then(() => null, (e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 403, code: 'super_admin_required' });
	});
});

describe('adminApi C.2b tenant-user wrappers', () => {
	it('inviteMember() POSTs the body to /api/tenants/:id/users', async () => {
		authFetch.mockResolvedValue(jsonRes(201, { invite: { id: 'i1', email: 'x@y.z', tenantId: 't1', role: 'member' } }));
		await adminApi.inviteMember('t1', { email: 'x@y.z', name: 'X', role: 'member' });
		expect(authFetch).toHaveBeenCalledWith('/api/tenants/t1/users', expect.objectContaining({ method: 'POST' }));
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ email: 'x@y.z', name: 'X', role: 'member' });
	});

	it('tenantInvites() GETs, resendInvite() POSTs and revokeInvite() DELETEs (204)', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { invites: [] }));
		await adminApi.tenantInvites('t1');
		expect(authFetch).toHaveBeenLastCalledWith('/api/tenants/t1/invites', expect.anything());
		authFetch.mockResolvedValue(jsonRes(200, { invite: { id: 'i1' } }));
		await adminApi.resendInvite('t1', 'i1');
		expect(authFetch).toHaveBeenLastCalledWith('/api/tenants/t1/invites/i1/resend', expect.objectContaining({ method: 'POST' }));
		authFetch.mockResolvedValue(new Response(null, { status: 204 }));
		await expect(adminApi.revokeInvite('t1', 'i1')).resolves.toBeUndefined();
		expect(authFetch).toHaveBeenLastCalledWith('/api/tenants/t1/invites/i1', expect.objectContaining({ method: 'DELETE' }));
	});

	it('acceptInvite() POSTs the token to /api/invites/accept', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { tenantId: 't1', role: 'member' }));
		await adminApi.acceptInvite({ token: 'tok' });
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(authFetch.mock.calls[0]![0]).toBe('/api/invites/accept');
		expect(JSON.parse(init.body as string)).toEqual({ token: 'tok' });
	});

	it('createTenant() sends the new body (no budget fields) and surfaces the 409 adopt details', async () => {
		authFetch.mockResolvedValue(
			jsonRes(409, { error: 'licences_tenant_exists', message: 'exists', details: { id: 'L1', name: 'Acme' } })
		);
		const err = (await adminApi
			.createTenant({ name: 'Acme', byoMode: 'byo_required', firstAdminEmail: 'a@acme.com' })
			.catch((e) => e)) as ApiError;
		const body = JSON.parse((authFetch.mock.calls[0]![1] as RequestInit).body as string);
		expect(body).toEqual({ name: 'Acme', byoMode: 'byo_required', firstAdminEmail: 'a@acme.com' });
		expect(body).not.toHaveProperty('welcomeBudgetUsd');
		expect(err).toMatchObject({ status: 409, code: 'licences_tenant_exists', details: { id: 'L1', name: 'Acme' } });
	});

	it('setMemberRole() PATCHes the role to /api/tenants/:id/users/:userId', async () => {
		authFetch.mockResolvedValue(jsonRes(200, { userId: 'u1', role: 'tenant_admin' }));
		await adminApi.setMemberRole('t1', 'u1', 'tenant_admin');
		expect(authFetch).toHaveBeenCalledWith('/api/tenants/t1/users/u1', expect.objectContaining({ method: 'PATCH' }));
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ role: 'tenant_admin' });
	});

	it('notifySelf() POSTs the email to the open notify-self route and tolerates a 204', async () => {
		authFetch.mockResolvedValue(new Response(null, { status: 204 }));
		await adminApi.notifySelf({ email: 'newbie@corp.com', name: 'Newbie' });
		expect(authFetch).toHaveBeenCalledWith('/api/signup-approvals/notify-self', expect.objectContaining({ method: 'POST' }));
		const init = authFetch.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ email: 'newbie@corp.com', name: 'Newbie' });
	});
});

describe('unwrap() on a non-JSON error body', () => {
	// Regression: approving a signup returned 502 with an HTML body (a Cloudflare interstitial).
	// unwrap() called JSON.parse BEFORE checking res.ok, so the SyntaxError replaced the real
	// failure and the operator saw only `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
	// — no status, no cause, nothing to act on.
	function htmlRes(status: number): Response {
		return new Response('<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head></html>', {
			status,
			statusText: 'Bad Gateway',
			headers: { 'content-type': 'text/html' }
		});
	}

	it('throws an ApiError carrying the real status, not a SyntaxError', async () => {
		authFetch.mockResolvedValue(htmlRes(502));
		const err = await adminApi.approveSignup('a1', { mode: 'existing', tenantId: 't1', role: 'member' }).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).not.toBeInstanceOf(SyntaxError);
		expect((err as ApiError).status).toBe(502);
		expect((err as ApiError).message).toContain('502');
		expect((err as ApiError).message).not.toContain('Unexpected token');
	});

	it('still surfaces the structured error code when the body IS json', async () => {
		authFetch.mockResolvedValue(
			jsonRes(502, { error: 'license_provisioning_failed', message: 'issue tenant license: HTTP 400' })
		);
		const err = (await adminApi.approveSignup('a1', { mode: 'existing', tenantId: 't1', role: 'member' }).catch((e) => e)) as ApiError;
		expect(err.status).toBe(502);
		expect(err.code).toBe('license_provisioning_failed');
		expect(err.message).toContain('issue tenant license');
	});

	it('rejects a 2xx whose body is not json instead of returning null', async () => {
		authFetch.mockResolvedValue(
			new Response('not json at all', { status: 200, headers: { 'content-type': 'text/plain' } })
		);
		const err = (await adminApi.signupStats().catch((e) => e)) as ApiError;
		expect(err).toBeInstanceOf(ApiError);
		expect(err.code).toBe('invalid_json');
	});

	it('tolerates an empty body on a 204 (no body is not an invalid body)', async () => {
		authFetch.mockResolvedValue(new Response(null, { status: 204 }));
		await expect(adminApi.notifySelf({ email: 'a@b.c' })).resolves.toBeUndefined();
	});
});
