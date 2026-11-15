// @vitest-environment jsdom
//
// src/routes/connectors/connectors-page.create-reset.render.test.ts — what the "new connector"
// drawer contains the SECOND time you open it.
//
// ⛔ THE DEFECT. `openCreate()` clears `pgUrl`, `pgQuery`, `stBucket`, `stKey`, `stToken` and
// `httpUrl` — every field on the form except `stBaseUrl`, the one that decides WHERE the request
// goes. So a tenant admin who creates one storage connector and then opens the drawer again gets a
// form that LOOKS empty (blank bucket, blank object key, blank token) with the previous connector's
// storage host still sitting in "Storage base URL". Nothing about the screen says the value is
// left over, and `baseUrl` is load-bearing on the server:
//
//   backend/src/datasets/connectors/index.ts:87   parseTarget(cfg.baseUrl) → the meta host, which is
//                                                 what the egress guard authorises
//   backend/src/datasets/connectors/index.ts:183  str('baseUrl') — required, so it never 400s
//   backend/src/datasets/connectors/storage.ts:30 `${base}/api/files/${bucket}/${key}` — the object URL
//
// A stale value is therefore not a cosmetic pre-fill: the second connector silently reads from the
// first connector's host. There is no field-level "cleared" affordance anywhere on this drawer, so
// the only thing that can catch it is this test.
//
// ⚠️ THE ASSERTIONS ARE ON MESSAGE TOKENS, not English prose — the catalog is mocked key→key, the
// same way `connectors-page.test-result.render.test.ts` does it, so a copy edit cannot move this
// file out from under itself.
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

const { list } = vi.hoisted(() => ({ list: vi.fn() }));

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
		test: vi.fn(),
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

const byText = (sel: string, text: string): HTMLElement | undefined =>
	[...host.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim() === text);

/** Click the "New connector" button and switch the drawer to the storage source. */
function openStorageDrawer() {
	const openBtn = byText('button', 'connectors_new');
	expect(openBtn, 'the "new connector" button is not on screen — this case tests nothing').toBeTruthy();
	openBtn!.click();
	flushSync();

	const chip = byText('.chips button', 'connectors_source_storage');
	expect(chip, 'the storage chip is not in the drawer — this case tests nothing').toBeTruthy();
	chip!.click();
	flushSync();
}

/** The `<input>` of the `.field` whose label is `key` — the drawer's inputs carry no id. */
function fieldInput(key: string): HTMLInputElement {
	const label = [...host.querySelectorAll<HTMLElement>('.create-body label.field')].find(
		(l) => l.querySelector('.field-label')?.textContent?.trim() === key
	);
	expect(label, `no field labelled ${key} is rendered — this case tests nothing`).toBeTruthy();
	const input = label!.querySelector('input') as HTMLInputElement | null;
	expect(input, `${key} has no input`).toBeTruthy();
	return input!;
}

/** Type into a bound input the way a user does, so Svelte's `bind:value` actually writes state. */
function type(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function closeDrawer() {
	const x = host.querySelector('.drawer .icon-x') as HTMLButtonElement | null;
	expect(x, 'the drawer close button is missing — this case tests nothing').toBeTruthy();
	x!.click();
	flushSync();
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	list.mockResolvedValue(EMPTY);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	list.mockReset();
});

describe('the create drawer opens EMPTY every time, including the field that picks the host', () => {
	it('⛔ THE DEFECT — a second storage connector does not inherit the first one’s base URL', async () => {
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle(() => !!host.querySelector('button.btn-primary'));

		// ── first connector: fill the whole storage form
		openStorageDrawer();
		type(fieldInput('connectors_st_baseurl'), 'https://storage-a.example.com');
		type(fieldInput('connectors_st_bucket'), 'claims');
		type(fieldInput('connectors_st_key'), 'exports/claims.csv');

		// ⛔ NON-VACUITY, AND IT IS THE WHOLE TEST. If `bind:value` never took, every field would read
		// '' at the end and this file would pass on main while proving nothing at all. Assert the
		// typing landed BEFORE asserting it is gone.
		expect(fieldInput('connectors_st_baseurl').value).toBe('https://storage-a.example.com');
		expect(fieldInput('connectors_st_bucket').value).toBe('claims');

		closeDrawer();

		// ── second connector: the same drawer, opened again
		openStorageDrawer();
		const baseUrl = fieldInput('connectors_st_baseurl');
		expect(
			baseUrl.value,
			'the storage base URL survived openCreate() — a new connector would read from the PREVIOUS ' +
				'connector’s host while every other credential field on the form is blank'
		).toBe('');
	});

	it('⚠️ CONTROL — the fields that already reset still reset, so the failure above is specific', async () => {
		// If `openCreate()` were broken outright, the assertion above would fail for an uninteresting
		// reason. These three passed on main and must keep passing: the defect is one missing line,
		// not a missing reset.
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle(() => !!host.querySelector('button.btn-primary'));

		openStorageDrawer();
		type(fieldInput('connectors_st_bucket'), 'claims');
		type(fieldInput('connectors_st_key'), 'exports/claims.csv');
		type(fieldInput('connectors_st_token'), 'lic_abc123');
		closeDrawer();

		openStorageDrawer();
		expect(fieldInput('connectors_st_bucket').value).toBe('');
		expect(fieldInput('connectors_st_key').value).toBe('');
		expect(fieldInput('connectors_st_token').value).toBe('');
	});

	it('⚠️ and the postgres/http branches are unaffected by the storage reset', async () => {
		// `buildConfig()` reads `pgUrl`/`httpUrl` from the same `openCreate()` block; a reset added in
		// the wrong place would clear one source's fields and leave another's.
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle(() => !!host.querySelector('button.btn-primary'));

		byText('button', 'connectors_new')!.click();
		flushSync();
		type(fieldInput('connectors_pg_url'), 'postgres://user:pw@host-a:5432/db');
		expect(fieldInput('connectors_pg_url').value).toBe('postgres://user:pw@host-a:5432/db');
		closeDrawer();

		byText('button', 'connectors_new')!.click();
		flushSync();
		expect(fieldInput('connectors_pg_url').value).toBe('');
	});
});
