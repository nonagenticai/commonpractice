// @vitest-environment jsdom
//
// src/routes/(platform)/onboarding/onboarding.ea-invite.render.test.ts — the "Invite to early access"
// form on /onboarding (POST /api/signup-approvals/invite, George 2026-10-19).
//
// The owner invites a person directly (pre-approved) instead of waiting for them to submit the public
// form. On success the page says in ONE line which workspace was created and how the invitation went
// out (the same delivery outcomes Approve reports), clears the form and re-reads the queue. A
// refusal renders through the page's existing error banner and keeps what was typed.
//
// Messages are mocked key-returns-its-own-name (with params appended) from the real en.json, so no
// assertion depends on wording.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const stub = (key: string) => (params?: Record<string, unknown>) =>
		params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = stub(key);
	return mod;
});

vi.mock('$lib/api/error-message', () => ({
	errorText: () => 'ERR',
	writeErrorText: (e: { code?: string }) => `WRITE_ERR:${e?.code ?? ''}`
}));

const api = vi.hoisted(() => ({
	signupApprovals: vi.fn(async () => ({ approvals: [] })),
	inviteEarlyAccess: vi.fn()
}));

vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: {
		signupApprovals: api.signupApprovals,
		allTenants: async () => ({ tenants: [{ id: 't-1', name: 'Nonagentic' }] }),
		emailDomains: async () => ({ domains: [] }),
		signupStats: async () => ({ stats: { pending: 0, approved: 0, rejected: 0, total: 0 } }),
		inviteEarlyAccess: api.inviteEarlyAccess
	}
}));

const OK = {
	approval: { id: 'a1', status: 'approved', source: 'invite' },
	tenantId: 't-9',
	role: 'tenant_admin',
	seated: false,
	invite: {
		id: 'i1',
		tenantId: 't-9',
		email: 'ann@acme.com',
		role: 'tenant_admin',
		expiresAt: '2026-10-26T00:00:00.000Z',
		inviteUrl: 'https://cp.example/invite/accept?token=abc',
		emailDelivery: 'keycloak_actions'
	},
	tenant: { id: 't-9', name: 'Acme', slug: 'acme', licencesName: 'acme' }
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	api.signupApprovals.mockClear();
	api.inviteEarlyAccess.mockReset();
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function mountPage(): Promise<void> {
	const { default: Onboarding } = await import('./+page.svelte');
	app = mount(Onboarding, { target: host });
	await settle();
}

function q<T extends Element>(sel: string): T {
	const el = host.querySelector<T>(sel);
	if (!el) throw new Error(`no element for ${sel} — page markup changed`);
	return el;
}

async function fill(v: { email?: string; name?: string; company?: string }): Promise<void> {
	const set = (sel: string, value: string) => {
		const el = q<HTMLInputElement>(sel);
		el.value = value;
		el.dispatchEvent(new Event('input', { bubbles: true }));
	};
	if (v.email !== undefined) set('#ea-email', v.email);
	if (v.name !== undefined) set('#ea-name', v.name);
	if (v.company !== undefined) set('#ea-company', v.company);
	await settle();
}

async function submit(): Promise<void> {
	q<HTMLFormElement>('[data-testid="ea-invite-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await settle();
}

describe('Onboarding — Invite to early access', () => {
	it('sends exactly {email, name, company, locale} (trimmed; locale defaults to en), then one line: workspace + delivery; form cleared; queue re-read', async () => {
		api.inviteEarlyAccess.mockResolvedValue(OK);
		await mountPage();
		// The pending queue (the screen also reads `needs_repair`, the rejected-cleanup list).
		const queueReads = () => api.signupApprovals.mock.calls.filter((c) => (c as unknown[])[0] === 'pending').length;
		expect(queueReads()).toBe(1);
		await fill({ email: ' ann@acme.com ', name: ' Ann Early ', company: ' Acme ' });
		await submit();
		expect(api.inviteEarlyAccess).toHaveBeenCalledWith({ email: 'ann@acme.com', name: 'Ann Early', company: 'Acme', locale: 'en' });
		const banner = q<HTMLElement>('.banner');
		expect(banner.className).toContain('ok');
		expect(banner.textContent).toContain('admin_onboarding_ea_done:Acme,acme,ann@acme.com');
		expect(banner.textContent).toContain('admin_onboarding_invite_set_password:ann@acme.com');
		expect(q<HTMLInputElement>('#ea-email').value).toBe('');
		expect(q<HTMLInputElement>('#ea-name').value).toBe('');
		expect(q<HTMLInputElement>('#ea-company').value).toBe('');
		expect(queueReads()).toBe(2); // the queue list was refreshed
	});

	it('no company → the field is omitted, not sent empty', async () => {
		api.inviteEarlyAccess.mockResolvedValue(OK);
		await mountPage();
		await fill({ email: 'ann@acme.com', name: 'Ann' });
		await submit();
		expect(api.inviteEarlyAccess).toHaveBeenCalledWith({ email: 'ann@acme.com', name: 'Ann', locale: 'en' });
	});

	it('the email language select offers the eight locales and sends the one picked; reset to en after', async () => {
		api.inviteEarlyAccess.mockResolvedValue(OK);
		await mountPage();
		const select = q<HTMLSelectElement>('#ea-locale');
		expect([...select.options].map((o) => o.value)).toEqual(['ar', 'de', 'en', 'es', 'fr', 'he', 'nl', 'pl']);
		expect(select.value).toBe('en');
		select.value = 'de';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await fill({ email: 'ann@acme.com', name: 'Ann' });
		await submit();
		expect(api.inviteEarlyAccess).toHaveBeenCalledWith({ email: 'ann@acme.com', name: 'Ann', locale: 'de' });
		expect(q<HTMLSelectElement>('#ea-locale').value).toBe('en');
	});

	it('a DEFERRED email (seated; the email follows the licence) is an ok banner, no link to copy', async () => {
		api.inviteEarlyAccess.mockResolvedValue({ ...OK, invite: { ...OK.invite, emailDelivery: 'deferred' } });
		await mountPage();
		await fill({ email: 'ann@acme.com', name: 'Ann' });
		await submit();
		const banner = q<HTMLElement>('.banner');
		expect(banner.className).toContain('ok');
		expect(banner.textContent).toContain('admin_onboarding_invite_deferred:ann@acme.com');
	});

	it('a FAILED invite email is a warn banner and the accept link is shown to copy', async () => {
		api.inviteEarlyAccess.mockResolvedValue({ ...OK, invite: { ...OK.invite, emailDelivery: 'failed' } });
		await mountPage();
		await fill({ email: 'ann@acme.com', name: 'Ann' });
		await submit();
		const banner = q<HTMLElement>('.banner');
		expect(banner.className).toContain('warn');
		expect(banner.textContent).toContain('admin_onboarding_ea_done:Acme,acme,ann@acme.com');
		expect(banner.textContent).toContain('admin_onboarding_invite_email_failed:ann@acme.com');
		expect(q<HTMLInputElement>('[data-testid="onboarding-invite-link"] input').value).toBe(OK.invite.inviteUrl);
	});

	it('without email AND name nothing is sent (the button is disabled)', async () => {
		await mountPage();
		await fill({ email: 'ann@acme.com' });
		expect(q<HTMLButtonElement>('[data-testid="ea-invite-form"] button[type="submit"]').disabled).toBe(true);
		await submit();
		expect(api.inviteEarlyAccess).not.toHaveBeenCalled();
	});

	it('a refusal renders in the error banner and keeps what was typed', async () => {
		api.inviteEarlyAccess.mockRejectedValue(Object.assign(new Error('taken'), { code: 'user_belongs_to_another_workspace' }));
		await mountPage();
		await fill({ email: 'taken@acme.com', name: 'Ta Ken' });
		await submit();
		const banner = q<HTMLElement>('.banner');
		expect(banner.className).toContain('error');
		expect(banner.textContent).toBe('WRITE_ERR:user_belongs_to_another_workspace');
		expect(q<HTMLInputElement>('#ea-email').value).toBe('taken@acme.com');
		expect(q<HTMLInputElement>('#ea-name').value).toBe('Ta Ken');
	});
});
