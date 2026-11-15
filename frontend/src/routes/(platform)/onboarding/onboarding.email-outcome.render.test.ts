// @vitest-environment jsdom
//
// src/routes/(platform)/onboarding/onboarding.email-outcome.render.test.ts — what the Onboarding
// screen SAYS after an invite, under the CP-owned invite model.
//
// ⛔ THE DEFECT THIS STILL GUARDS. A dead SMTP relay once produced the same `201` as a delivered
// invite and this page painted it green — the invited human waited for a link nobody sent. The
// response now carries `invite.emailDelivery`; a `failed` delivery must be a warn banner AND must
// put the invite's own accept link on screen, because that link is the only way in. (Unlike the
// account-console URL this screen once showed for an account with no password, `inviteUrl` is a
// real accept link.)
//
// Messages are mocked key-returns-its-own-name from the real en.json, so no assertion depends on
// wording.
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
	writeErrorText: () => 'WRITE_ERR'
}));

const TENANT = 't-1';
let inviteResult: { invite: Record<string, unknown> };
let inviteBody: Record<string, unknown> | undefined;

vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: {
		signupApprovals: async () => ({ approvals: [] }),
		allTenants: async () => ({ tenants: [{ id: TENANT, name: 'Nonagentic' }] }),
		emailDomains: async () => ({ domains: [] }),
		signupStats: async () => ({ stats: { pending: 0, approved: 0, rejected: 0, total: 0 } }),
		invite: async (body: Record<string, unknown>) => {
			inviteBody = body;
			return inviteResult;
		}
	}
}));

const INVITE = {
	id: 'i1',
	tenantId: TENANT,
	email: 'seed@nonagentic.ai',
	role: 'tenant_admin',
	expiresAt: '2026-10-26T00:00:00.000Z',
	inviteUrl: 'https://cp.example/invite/accept?token=abc'
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	inviteBody = undefined;
	inviteResult = { invite: { ...INVITE, emailDelivery: 'sent' } };
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

async function submitInvite(names: { first: string; last: string } | null = { first: 'Sam', last: 'de Boer' }): Promise<void> {
	const set = (sel: string, v: string) => {
		const el = q<HTMLInputElement>(sel);
		el.value = v;
		el.dispatchEvent(new Event('input', { bubbles: true }));
	};
	set('#inv-email', 'seed@nonagentic.ai');
	if (names) {
		set('#inv-first-name', names.first);
		set('#inv-last-name', names.last);
	}
	await settle();
	q<HTMLFormElement>('#inv-email').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await settle();
}

describe('Onboarding — the invite email outcome is visible', () => {
	it('sends exactly {email, firstName, lastName, tenantId, role} — there is no suppress-email switch any more', async () => {
		await mountPage();
		expect(host.querySelector('#inv-send-email')).toBeNull();
		await submitInvite();
		expect(inviteBody).toEqual({
			email: 'seed@nonagentic.ai',
			firstName: 'Sam',
			lastName: 'de Boer',
			tenantId: TENANT,
			role: 'member'
		});
	});

	it('⛔ without BOTH names nothing is sent: Keycloak would stop the invitee at its profile form', async () => {
		await mountPage();
		await submitInvite(null);
		expect(inviteBody).toBeUndefined();
	});

	it('a delivered invite is a plain OK banner with no link', async () => {
		await mountPage();
		await submitInvite();
		expect(q<HTMLElement>('.banner').className).toContain('ok');
		expect(q<HTMLElement>('.banner').textContent).toContain('admin_onboarding_invited');
		expect(host.querySelector('[data-testid="onboarding-invite-link"]')).toBeNull();
	});

	it('⭐ a FAILED email is a warn banner, never the green "Invite sent.", and the link is shown', async () => {
		inviteResult = { invite: { ...INVITE, emailDelivery: 'failed' } };
		await mountPage();
		await submitInvite();
		const banner = q<HTMLElement>('.banner');
		expect(banner.className).toContain('warn');
		expect(banner.textContent).toContain('admin_onboarding_invite_email_failed:seed@nonagentic.ai');
		expect(q<HTMLInputElement>('[data-testid="onboarding-invite-link"] input').value).toBe(INVITE.inviteUrl);
	});

	it('`keycloak_actions` says a set-password email went out (OK, no link)', async () => {
		inviteResult = { invite: { ...INVITE, emailDelivery: 'keycloak_actions' } };
		await mountPage();
		await submitInvite();
		const banner = q<HTMLElement>('.banner');
		expect(banner.className).toContain('ok');
		expect(banner.textContent).toContain('admin_onboarding_invite_set_password:seed@nonagentic.ai');
		expect(host.querySelector('[data-testid="onboarding-invite-link"]')).toBeNull();
	});
});
