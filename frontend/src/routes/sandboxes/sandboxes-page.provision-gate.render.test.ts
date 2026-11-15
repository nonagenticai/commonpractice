// @vitest-environment jsdom
//
// src/routes/sandboxes/sandboxes-page.provision-gate.render.test.ts — the one WRITE on /sandboxes
// lived above the page's own refusal notice.
//
// ⛔ THE DEFECT, AND WHY IT SURVIVED A PAGE THAT ALREADY HAD A GATE. `+page.svelte` wraps its whole
// body in `{#if denied}…{:else}`, so a reader the API refuses gets `sandboxes_denied` and no table.
// But "Provision sandbox" sits in `<header class="page-head">`, which renders ABOVE that chain —
// so the single control that writes stayed on screen, at full opacity, for exactly the reader who
// had just been refused, and answered 403 on click. `POST /api/sandboxes` is `requireSuperAdmin`
// (backend/src/routes/sandboxes.ts:312).
//
// ⛔ TWO INDEPENDENT WAYS TO BE WRONG, SO TWO HALVES TO THE GATE, and a case for each:
//   • the ROLE half (`canReachNav('/sandboxes', …)`, the same fact navConfig.ts:98 states) — this is
//     what takes the button away IMMEDIATELY, before any response arrives. Gating on `denied` alone
//     would still flash a live Provision button at every member for the length of the first request.
//   • the SERVER half (`!denied`) — for a refusal the token cannot predict (an unprovisioned tenant,
//     a role revoked mid-session). A super_admin who is refused must lose the button too.
// The last case is the over-correction guard: a super_admin on a healthy page still gets it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { SandboxList } from '$lib/types/sandboxes';

// Real `en` catalog, each key resolving to its own name — see the sibling render tests.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { list, provision, store, FakeApiError } = vi.hoisted(() => ({
	list: vi.fn(),
	provision: vi.fn(),
	store: { auth: { user: null as { roles: string[] } | null } },
	// ⛔ A real class: the page branches on `e instanceof ApiError` to decide `denied`.
	FakeApiError: class FakeApiError extends Error {
		constructor(readonly status: number) {
			super(`HTTP ${status}`);
		}
	}
}));
// ⛔ ALIAS module ids, never relative ones.
vi.mock('$lib/api/sandboxes', () => ({
	sandboxesApi: { list, get: vi.fn(), pause: vi.fn(), resume: vi.fn(), provision },
	ApiError: FakeApiError
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: store.auth }));

import Page from './+page.svelte';

const MEMBER = ['member'];
const DEVELOPER = ['developer'];
const TENANT_ADMIN = ['tenant_admin'];
const SUPER_ADMIN = ['super_admin'];

const EMPTY_LIST: SandboxList = {
	items: [],
	total: 0,
	page: 1,
	pageSize: 20,
	counts: { all: 0, running: 0, idle: 0, suspended: 0, error: 0 }
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(roles: string[]) {
	store.auth.user = { roles };
	window.history.replaceState({}, '', '/sandboxes');
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// ⛔ POSITIVE ANCHOR — the head always renders, denied or not, which is the whole point.
	expect(host.querySelector('h1')?.textContent, 'the page never rendered').toBe('sandboxes_title');
}

const provisionButton = () =>
	[...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'sandboxes_provision') ??
	null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	list.mockReset();
	provision.mockReset();
	store.auth.user = null;
});

describe('/sandboxes shows "Provision sandbox" only to someone the API would let provision', () => {
	it('⛔ THE DEFECT: a refused reader keeps a live Provision button above their own refusal', async () => {
		list.mockRejectedValue(new FakeApiError(403));
		await render(TENANT_ADMIN);
		// The page DID reach its refusal arm — without this the assertion below is vacuous.
		expect(host.textContent, 'the denied notice never rendered').toContain('sandboxes_denied');
		expect(
			provisionButton(),
			'Provision renders above the refusal — the one control that writes, for the one reader refused'
		).toBeNull();
	});

	it('…and it is gone BEFORE the first response, not only after the 403 comes back', async () => {
		// The role half. A gate written as `{#if !denied}` alone leaves a live, enabled Provision
		// button on a member's screen for the whole round trip — which is when a demo tester clicks.
		list.mockReturnValue(new Promise(() => {})); // never settles
		await render(MEMBER);
		expect(host.textContent, 'the page is not in its loading state, so this case tests nothing').toContain(
			'sandboxes_loading'
		);
		expect(provisionButton(), 'Provision is live while the page is still loading').toBeNull();
	});

	// ⛔ THESE TWO PIN THE ROLE *LEVEL*, NOT MERELY "SOME ROLE". Without them the gate could be
	// relaxed to any lesser nav gate and the suite stayed green — an adversarial pass substituted
	// `canReachNav('/members', …)` (tenant_admin) and `canReachNav('/block-edit', …)` (developer) and
	// BOTH survived 4/4. The member case above cannot catch that: a member fails every one of those
	// gates, so it never separates them. The 403 cases cannot either, because `!denied` alone already
	// hides the button once the refusal lands. The discriminating state is a NON-super_admin who is
	// NOT (yet) refused — i.e. the load window, which is exactly when a demo tester clicks.
	it('a TENANT ADMIN never gets it either — not even before the list settles', async () => {
		list.mockReturnValue(new Promise(() => {})); // never settles → `denied` stays false
		await render(TENANT_ADMIN);
		expect(host.textContent, 'not in the loading state, so this case tests nothing').toContain(
			'sandboxes_loading'
		);
		expect(
			provisionButton(),
			'a tenant_admin got Provision — the gate has been relaxed below super_admin'
		).toBeNull();
	});

	it('nor a DEVELOPER — the gate is super_admin, not "any elevated role"', async () => {
		list.mockReturnValue(new Promise(() => {}));
		await render(DEVELOPER);
		expect(host.textContent, 'not in the loading state, so this case tests nothing').toContain(
			'sandboxes_loading'
		);
		expect(
			provisionButton(),
			'a developer got Provision — the gate has been relaxed below super_admin'
		).toBeNull();
	});

	it('A SUPER ADMIN STILL GETS IT — the over-correction guard', async () => {
		// ⛔ `{#if false}` passes both cases above forever; this is the half that reds on it.
		list.mockResolvedValue(EMPTY_LIST);
		await render(SUPER_ADMIN);
		expect(host.textContent).toContain('sandboxes_empty');
		expect(provisionButton(), 'the platform admin lost the only write on the screen').not.toBeNull();
		expect(provisionButton()!.disabled).toBe(false);
	});

	it('…but loses it if the server refuses them anyway — the role is a claim, not the authority', async () => {
		list.mockRejectedValue(new FakeApiError(403));
		await render(SUPER_ADMIN);
		expect(host.textContent).toContain('sandboxes_denied');
		expect(provisionButton(), 'a refused platform admin is still refused').toBeNull();
	});
});
