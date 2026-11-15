// @vitest-environment jsdom
//
// workspace-suspended.render.test.ts — what a suspended workspace's owner actually sees.
//
// ⛔ THE THREE THINGS THIS SCREEN MUST NOT DO, each of which is a recorded scar in this repo:
//   1. offer a licence-renewal path. A suspended workspace's licence may be valid and fully paid;
//      a "Renew" CTA pointing at /license-upgrade is a false explanation AND a payment funnel that
//      cannot lift the suspension. `LicenseBlocked` legitimately renders that button, so the only
//      thing keeping it off THIS screen is the absence asserted below.
//   2. navigate. The backend gate that produces this state 403s on EVERY request, so any `goto`
//      from here is a redirect loop by construction: land → loader 403s → re-trip the gate →
//      navigate again.
//   3. render blank. A gate with no render branch leaves the user on an empty shell, which is
//      indistinguishable from the app being broken.
//
// ⚠️ MESSAGES ARE READ FROM THE REAL `nl.json`, NOT STUBBED TO KEY NAMES (Idiom B — see
// notification-bell.i18n.render.test.ts). This screen is Dutch-first copy whose whole job is to
// explain an unusual state, so a key-name stub would prove the component called four functions and
// nothing about a reader being able to read the result. The expected strings are pulled FROM the
// catalog rather than hardcoded here, so the copywriter can reword without breaking this test — but
// a key that is missing from nl.json is `undefined` and throws on call, which is exactly the loud
// failure we want (a key that exists only in en.json must not quietly render as a token).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { logoutSpy, gotoSpy } = vi.hoisted(() => ({ logoutSpy: vi.fn(), gotoSpy: vi.fn() }));

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(catalog)) {
		if (key === '$schema') continue;
		// Plural entries are ARRAYS of ICU variants in these catalogs. None of this screen's four keys
		// is plural; marking rather than guessing keeps that true loudly.
		if (typeof value !== 'string') {
			mod[key] = () => `[plural:${key}]`;
			continue;
		}
		mod[key] = (params?: Record<string, unknown>) =>
			value.replace(/\{(\w+)\}/g, (whole, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	// ⛔ NO FALLBACK PROXY. A missing key must throw, not resolve to its own name.
	return mod;
});

// `auth.svelte.ts` wraps keycloak's logout; mocking the service keeps the sign-out button assertable
// without a real redirect out of jsdom.
// ⚠️ EVERY NAME auth.svelte.ts DESTRUCTURES MUST BE HERE. It imports `{ keycloak, initKeycloak,
// KeycloakConfigError, login, logout }`, and an ESM named import of a key this factory omits fails
// the whole module load with an error that names the mock, not the missing export.
vi.mock('$lib/services/keycloak', () => ({
	keycloak: null,
	initKeycloak: vi.fn(async () => false),
	KeycloakConfigError: class KeycloakConfigError extends Error {},
	login: vi.fn(),
	logout: logoutSpy,
	ensureFreshToken: vi.fn(async () => undefined)
}));

// The component reaches `$lib/api/auth-fetch` transitively (WorkspaceSuspended → auth.svelte →
// auth-fetch). Stubbed exactly as license-blocked.outage.render.test.ts does: it keeps the profile
// loader off the network, and it cuts the import chain to `$lib/paraglide/runtime`, which is a
// GENERATED module (paraglide-js compile) and therefore absent until `prepare` has run.
vi.mock('$lib/api/auth-fetch', () => ({
	authFetch: vi.fn(async () => new Response('{}', { status: 500 }))
}));

// Not imported by the component — mocked so the "it must never navigate" assertion has a spy to be
// silent on. If someone adds a `goto` here, this is what catches it.
vi.mock('$app/navigation', () => ({ goto: gotoSpy }));

import WorkspaceSuspended from './WorkspaceSuspended.svelte';

/**
 * The exact Dutch strings this screen is contracted to show, read from the catalog itself rather
 * than hardcoded — so rewording the copy does not break this test, while a MISSING key still does
 * (the assertions below require the values to be non-empty, and the message mock throws on a key
 * that is absent from nl.json).
 */
const NL = JSON.parse(
	readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
) as Record<string, string>;

function nl(): Record<string, string> {
	return NL;
}

let host: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	vi.clearAllMocks();
});

function screen(): string {
	app = mount(WorkspaceSuspended, { target: host, props: {} });
	flushSync();
	return host.textContent ?? '';
}

describe('WorkspaceSuspended — a suspended workspace gets an explanation, not a permission toast', () => {
	it('renders the Dutch heading and body from the catalog', () => {
		const text = screen();
		const catalog = nl();
		expect(catalog.workspace_suspended_heading).toBeTruthy();
		expect(catalog.workspace_suspended_body).toBeTruthy();
		expect(text).toContain(catalog.workspace_suspended_heading);
		expect(text).toContain(catalog.workspace_suspended_body);
	});

	it('the heading is the accessible name of the alert dialog', () => {
		screen();
		const dialog = host.querySelector('[role="alertdialog"]');
		expect(dialog).not.toBeNull();
		const labelledBy = dialog?.getAttribute('aria-labelledby');
		expect(labelledBy).toBeTruthy();
		expect(host.querySelector(`#${labelledBy}`)?.textContent).toBe(
			nl().workspace_suspended_heading
		);
	});

	it('offers EXACTLY two actions: retry and sign out', () => {
		screen();
		const buttons = Array.from(host.querySelectorAll('button'));
		expect(buttons).toHaveLength(2);
		const labels = buttons.map((b) => (b.textContent ?? '').trim());
		const catalog = nl();
		expect(labels).toContain(catalog.workspace_suspended_retry.trim());
		expect(labels).toContain(catalog.workspace_suspended_signout.trim());
	});

	it('⛔ OFFERS NO LICENCE-RENEWAL PATH — no /license-upgrade link, and no link at all', () => {
		// The whole reason this is a separate component from LicenseBlocked. A suspended customer sent
		// to a renewal page is told something false and invited to pay for something that cannot help.
		screen();
		expect(host.querySelector('a[href*="license-upgrade"]')).toBeNull();
		expect(host.querySelectorAll('a')).toHaveLength(0);
		expect(host.innerHTML).not.toContain('license-upgrade');
	});

	it('⛔ DOES NOT NAVIGATE ON MOUNT — a redirect here is a loop against a gate that 403s everything', () => {
		screen();
		expect(gotoSpy).not.toHaveBeenCalled();
	});

	it('the sign-out button actually signs out', () => {
		screen();
		const catalog = nl();
		const signOut = Array.from(host.querySelectorAll('button')).find(
			(b) => (b.textContent ?? '').trim() === catalog.workspace_suspended_signout.trim()
		);
		expect(signOut).toBeDefined();
		signOut?.click();
		flushSync();
		expect(logoutSpy).toHaveBeenCalledTimes(1);
		// ⛔ NON-VACUITY: signing out must not ALSO be a client-side navigation. Keycloak owns the
		// redirect; a `goto` layered on top would race it.
		expect(gotoSpy).not.toHaveBeenCalled();
	});

	it('⛔ THE RETRY ACTION IS A RELOAD, NOT A ROUTER NAVIGATION', () => {
		// It is deliberately NOT clicked here: jsdom refuses `location.reload()` ("Not implemented:
		// navigation"), and stubbing a non-configurable Location just to watch a one-line handler
		// would test the stub. What IS assertable, and is the real regression risk, is that the retry
		// affordance is a plain <button> rather than an anchor or a goto — a full reload is the only
		// thing that lowers the sticky suspension latch in workspaceGate once an operator reinstates
		// the workspace.
		screen();
		const catalog = nl();
		const retry = Array.from(host.querySelectorAll('button')).find(
			(b) => (b.textContent ?? '').trim() === catalog.workspace_suspended_retry.trim()
		);
		expect(retry).toBeDefined();
		expect(retry?.tagName).toBe('BUTTON');
		expect(retry?.getAttribute('href')).toBeNull();
	});
});
