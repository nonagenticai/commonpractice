// @vitest-environment jsdom
//
// src/routes/error-page.status-branch.render.test.ts — the root `+error.svelte` boundary.
//
// ⛔ THE DEFECT THIS PROVES FIXED. There was no `+error.svelte` anywhere in `frontend/src/routes` —
// confirmed by `git ls-tree -r origin/main` before this change. A mistyped, stale or bookmarked URL
// dropped the reader on SvelteKit's bare default error page: English, unstyled, no app shell, no
// navigation, no way back. On a Dutch demo that is a hard stop.
//
// ⚠️ REAL COMPILED MESSAGES, NOT A KEY-NAME STUB. A stub that returns `"error_page_status:404"`
// cannot tell "Status 404" (the real Dutch sentence) from a wrapped-wrong-variable defect. This file
// mocks nothing about `$lib/paraglide/messages` and asserts the Dutch sentence the reader actually
// gets — same technique as dataset-preview.locale-numbers.render.test.ts.
//
// ⚠️ `page` FROM `$app/state` IS MOCKED AS A MUTABLE OBJECT (`vi.hoisted`), so each test can set its
// own `status` before mounting without re-mocking the module per test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { locale } from '$lib/stores/locale.svelte';

const pageState = vi.hoisted(() => ({ status: 404 }));
vi.mock('$app/state', () => ({ page: pageState }));

import ErrorPage from './+error.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	// Assigned directly, never through `locale.set()` — that method fires an authFetch PATCH to
	// /api/me/locale, which this file never stubs (same rule as the locale-numbers render specs).
	locale.current = initialLocale;
});

describe('the root error boundary tells a Dutch reader what happened and how to leave', () => {
	it('⛔ THE 404 CASE: not-found copy, the status code, and a link home — not the generic sentence', () => {
		pageState.status = 404;
		locale.current = 'nl';
		app = mount(ErrorPage, { target: host });
		flushSync();

		expect(host.textContent).toContain('Pagina niet gevonden');
		expect(host.textContent).toContain('Deze pagina bestaat niet.');
		// The status line: `num()` is a no-op below 1000, so "404" proves the wiring without proving
		// the digits are pinned latn — that half is icu-number-params.sites.test.ts's job.
		expect(host.textContent).toContain('Status 404');
		// The generic branch's title must NOT leak into the 404 case — a 404 is not "something went
		// wrong", it is "this page does not exist", and papering both with one sentence is the defect
		// this page exists to remove.
		expect(host.textContent).not.toContain('Er is iets misgegaan');

		const link = host.querySelector<HTMLAnchorElement>('a.retry');
		expect(link, 'no way out of the error page').not.toBeNull();
		expect(link!.getAttribute('href'), 'home href did not come from navConfig').toBe('/');
		expect(link!.textContent).toBe('Terug naar Start');
	});

	it('⛔ A NON-404 STATUS TAKES THE OTHER BRANCH: the generic sentence, not "page not found"', () => {
		pageState.status = 500;
		locale.current = 'nl';
		app = mount(ErrorPage, { target: host });
		flushSync();

		expect(host.textContent).toContain('Er is iets misgegaan');
		expect(host.textContent).toContain('Deze pagina kan niet worden getoond.');
		expect(host.textContent).toContain('Status 500');
		expect(host.textContent).not.toContain('Pagina niet gevonden');

		// Still offers the same way home — a 500 reader needs the exit as much as a 404 reader does.
		const link = host.querySelector<HTMLAnchorElement>('a.retry');
		expect(link).not.toBeNull();
		expect(link!.getAttribute('href')).toBe('/');
	});

	it('renders the English branch too — the site reads the tag, it does not hard-code Dutch', () => {
		pageState.status = 404;
		locale.current = 'en';
		app = mount(ErrorPage, { target: host });
		flushSync();

		expect(host.textContent).toContain('Page not found');
		expect(host.textContent).toContain('Status 404');
		const link = host.querySelector<HTMLAnchorElement>('a.retry');
		expect(link!.textContent).toBe('Back to home');
	});
});
