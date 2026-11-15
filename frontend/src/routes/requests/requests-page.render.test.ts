// @vitest-environment jsdom
//
// W8/P5 /requests: approving records the decision and OPENS the existing create screen (the server's
// `next.href`); rejecting needs a note; a reader who is not a reviewer is refused without a call.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema' || typeof catalog[key] !== 'string') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			(catalog[key] as string).replace(/\{(\w+)\}/g, (w: string, n: string) => (params && n in params ? String(params[n]) : w));
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'en' } }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
const { goto, list, get, approve, reject, auth } = vi.hoisted(() => ({
	goto: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	approve: vi.fn(),
	reject: vi.fn(),
	auth: { isDeveloper: true, user: { roles: ['developer'], counts: { challenges: 0, solutions: 0, requests: 1 } } }
}));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/stores/auth.svelte', () => ({ auth }));
vi.mock('$lib/api/information-requests', () => ({
	ApiError: class ApiError extends Error {},
	informationRequestsApi: { list, get, approve, reject }
}));

import Page from './+page.svelte';

const REQ = {
	id: 'r1', challengeId: 'c1', challengeTitle: 'Claims wait', kind: 'missing_information', status: 'pending', name: 'Policy holder',
	description: 'Who owns it', fieldNames: ['policy number'], fileName: null, columns: [], rowCount: null, createdByName: 'Anna',
	mine: false, createdAt: '2026-10-14T00:00:00Z', reviewedAt: null, reviewNote: null
};

let host: HTMLElement;
let app: Record<string, unknown> | null = null;
async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}
beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	for (const f of [goto, list, get, approve, reject]) f.mockReset();
	auth.isDeveloper = true;
	list.mockResolvedValue({ items: [REQ], pendingCount: 1 });
	get.mockResolvedValue({ ...REQ, rows: [], masked: false, canReview: true });
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

async function openFirst() {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	(host.querySelector('[data-request-id="r1"] .row') as HTMLButtonElement).click();
	await settle();
}

describe('/requests (W8/P5)', () => {
	it('approve records the decision, then opens the existing create screen the server names', async () => {
		approve.mockResolvedValue({ item: { ...REQ, status: 'approved' }, next: { href: '/ontology?fromRequest=r1' } });
		await openFirst();
		expect(host.textContent).toContain('From Anna on “Claims wait”');
		expect(host.textContent).toContain('Example fields: policy number');
		(host.querySelector('[data-testid="approve"]') as HTMLButtonElement).click();
		await settle();
		expect(approve).toHaveBeenCalledWith('r1');
		expect(goto).toHaveBeenCalledWith('/ontology?fromRequest=r1');
	});

	it('reject needs a reason before it can be sent', async () => {
		reject.mockResolvedValue({ item: { ...REQ, status: 'rejected' } });
		await openFirst();
		(host.querySelector('[data-testid="reject"]') as HTMLButtonElement).click();
		flushSync();
		const confirm = host.querySelector('[data-testid="reject-confirm"]') as HTMLButtonElement;
		expect(confirm.disabled).toBe(true);
		const note = host.querySelector('[data-testid="reject-note"]') as HTMLTextAreaElement;
		note.value = 'Already in Claims April';
		note.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		confirm.click();
		await settle();
		expect(reject).toHaveBeenCalledWith('r1', 'Already in Claims April');
		expect(goto).not.toHaveBeenCalled();
	});

	it('a reader who is not a reviewer is refused, and no request is listed', async () => {
		auth.isDeveloper = false;
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		expect(host.querySelector('[data-testid="requests-list"]')).toBeNull();
		expect(host.textContent).toContain('Only admins and developers can review requests.');
		expect(list).not.toHaveBeenCalled();
	});
});
