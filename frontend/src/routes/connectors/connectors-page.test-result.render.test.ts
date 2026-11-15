// @vitest-environment jsdom
//
// src/routes/connectors/connectors-page.test-result.render.test.ts — the notice under the
// **Testen** button in the "new connector" drawer.
//
// ⛔ THE DEFECT, AND ITS SUCCESS BRANCH IS THE HEADLINE. The line read
//
//     {#if testResult}<div class="notice …">{testResult.detail}</div>{/if}
//
// `POST /api/connectors/test` answers **HTTP 200** whether the probe passed or failed — a bad
// config is a normal test RESULT, not a transport error (the route says so in its own docblock).
// Because nothing throws, `api/error-message.ts`'s `errorText` — the one helper in this app that
// turns a backend code into localized copy — is NEVER reached on this path. So a Dutch tenant
// admin who clicks **Testen** on a connector that WORKS read, in English:
//
//     Connected — read 5 columns, 3 sample rows.
//
// including hand-built English plurals (`column${cols === 1 ? '' : 's'}`), which is not a
// pluralisation rule that survives translation to Polish or Arabic anyway.
//
// ⚠️ THE ASSERTIONS ARE ON MESSAGE TOKENS, not on English prose a copy edit could move out from
// under this file — the catalog is mocked key→key, so `connector_test_ok:5,3` means "this key, with
// these arguments". The one exception is the `not.toContain` on the backend's real sentence, which
// is the whole point of the file.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ConnectorList } from '$lib/types/connectors';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { list, test: testFn } = vi.hoisted(() => ({ list: vi.fn(), test: vi.fn() }));

// ⚠️ EVERY NAME BELOW IS A REAL `connectorsApi` METHOD, checked against the client. A sibling lane
// found `datasets-page.*.render.test.ts` stubbing `saveMapping` for a client that only has
// `saveMappings`: the call hit `undefined`, the page's own catch swallowed the TypeError, and every
// assertion past that stub was vacuous.
vi.mock('$lib/api/connectors', () => ({
	connectorsApi: {
		list,
		get: vi.fn(),
		sync: vi.fn(),
		create: vi.fn(),
		test: testFn,
		remove: vi.fn(),
		rotateSecret: vi.fn(),
		reregisterNotifications: vi.fn(),
		verifyNotifications: vi.fn(),
		reconcileNotifications: vi.fn()
	},
	streamConnectors: () => ({ close: () => {} }),
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback,
	// ⚠️ THE LEGACY-TEXT ARM ONLY — every fixture in THIS file sets `syncError: null`, so the stub
	// is never asked for a sentence. The real catalog path (a wire code → the reader's own
	// language) is asserted in connectors.sync-error-dutch.render.test.ts, which deliberately does
	// NOT mock this module. Do not add a non-null `syncError` fixture here expecting localization.
	syncErrorText: (_code: string | null | undefined, legacy: string | null | undefined) =>
		legacy ?? ''
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle(until: () => boolean, tries = 40) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

const EMPTY: ConnectorList = {
	items: [],
	total: 0,
	page: 1,
	pageSize: 20,
	canManage: true
} as ConnectorList;

/** Open the create drawer and press **Testen**, with `connectorsApi.test` answering `result`. */
async function pressTest(result: unknown) {
	list.mockResolvedValue(EMPTY);
	testFn.mockResolvedValue(result);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle(() => !!host.querySelector('button.btn-primary'));

	const openBtn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'connectors_new'
	) as HTMLButtonElement | undefined;
	expect(openBtn, 'the "new connector" button is not on screen — this case tests nothing').toBeTruthy();
	openBtn!.click();
	flushSync();

	const testBtn = [...host.querySelectorAll('.create-actions button')].find(
		(b) => b.textContent?.trim() === 'connectors_test'
	) as HTMLButtonElement | undefined;
	expect(testBtn, 'the Test button is not in the drawer — this case tests nothing').toBeTruthy();
	testBtn!.click();
	await settle(() => !!host.querySelector('.notice.ok, .notice.error'));

	const notice = host.querySelector('.notice.ok, .notice.error');
	expect(notice, 'no test notice rendered — this case tests nothing').not.toBeNull();
	return notice!;
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	list.mockReset();
	testFn.mockReset();
});

describe('/connectors renders the test result from its CODE, not the server’s English', () => {
	it('⛔ THE SUCCESS PATH — HTTP 200, ok:true, and the notice is the reader’s sentence', async () => {
		const notice = await pressTest({
			ok: true,
			code: 'connector_test_ok',
			params: { cols: 5, rows: 3 },
			detail: 'Connected — read 5 columns, 3 sample rows.'
		});
		expect(notice.className).toContain('ok');
		expect(notice.textContent).toBe('connector_test_ok:5,3');
		// The exact sentence a Dutch admin used to read on a connector that WORKS.
		expect(host.textContent).not.toContain('Connected — read 5 columns, 3 sample rows.');
	});

	it('⛔ the FAILURE path localizes the frame and keeps the driver’s text inside it', async () => {
		// `detail` is a parameter here, not a fallback: "connect ECONNREFUSED 10.0.0.4:5432" is the
		// most useful string on the screen and no catalog can ever contain it.
		const notice = await pressTest({
			ok: false,
			code: 'connector_test_failed',
			params: { detail: 'connect ECONNREFUSED 10.0.0.4:5432' },
			detail: 'connect ECONNREFUSED 10.0.0.4:5432'
		});
		expect(notice.className).toContain('error');
		expect(notice.textContent).toContain('connector_test_failed');
		expect(notice.textContent).toContain('connect ECONNREFUSED 10.0.0.4:5432');
	});

	it('⛔ MID-ROLL — an old pod sending only `detail` still renders it, never a blank notice', async () => {
		// The browser reaches the API through the Service, so a new bundle really is answered by an
		// old pod for the length of a rolling deploy. A blank notice would be worse than English.
		const notice = await pressTest({ ok: true, detail: 'Connected — read 5 columns, 3 sample rows.' });
		expect(notice.textContent).toBe('Connected — read 5 columns, 3 sample rows.');
	});

	it('⛔ an UNKNOWN code (a forwarded HttpError code) falls back — never a bare token', async () => {
		const notice = await pressTest({
			ok: false,
			code: 'foreign_bucket',
			detail: 'that bucket belongs to another workspace'
		});
		expect(notice.textContent).toBe('that bucket belongs to another workspace');
		expect(notice.textContent).not.toContain('foreign_bucket');
	});
});
