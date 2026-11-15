// @vitest-environment jsdom
//
// src/routes/connectors/connectors-page.duplicate-columns.render.test.ts — /connectors survives a
// live source whose columns repeat a name.
//
// ⛔ THE DEFECT. The preview drawer keyed both of its `{#each}` blocks on the column NAME
// (`{#each selected.columns as c (c.name)}`), so a connector carrying two columns of one name threw
// Svelte's `each_key_duplicate` — NOT dev-only (svelte/internal/client/dom/blocks/each.js) — and,
// with no `<svelte:boundary>` anywhere in this tree, took the WHOLE /connectors page down to an
// empty shell: the drawer, the connector table behind it, and the sync controls with it.
//
// ⚠️ AND THIS PAGE IS THE ONE WHERE THE INPUT IS LEAST UNDER ANYONE'S CONTROL. A connector
// materializes a LIVE source on every refresh — `SELECT * FROM claims c JOIN policies p ON …` over
// two tables that both have an `id` is the ordinary way to end up here, and nobody uploaded
// anything to review. The refresh path now de-duplicates at parse (datasets/parse/infer.ts's
// `uniqueColumnNames`, reached through `finalize`). Rows already stored with a repeat are NOT
// repaired - the migration that would have done it was withdrawn - so this must render them anyway;
// what was already
// stored, but a render must not be one upstream schema change away from a blank page.
//
// ⚠️ NON-VACUITY. A page that threw renders nothing and `querySelectorAll` returns `[]`, which
// passes any "the bad thing is absent" check. Both cases assert the exact header names and the
// exact cell text, and the first also asserts the table BEHIND the drawer is still standing —
// which is what distinguishes "the drawer coped" from "the page survived".
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Connector, ConnectorList } from '$lib/types/connectors';

// Real `en` catalog, each key resolving to its own name — so the Preview button is selected by
// WHICH message it renders rather than by English prose a copy edit could move out from under this
// file. (`connectors-notice.locale-numbers.render.test.ts` deliberately does the opposite, because
// its subject IS the rendered sentence; this file's is the DOM structure.)
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

const { list, get } = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record than
// the one the page imports and silently does nothing.
vi.mock('$lib/api/connectors', () => ({
	connectorsApi: {
		list,
		get,
		sync: vi.fn(),
		create: vi.fn(),
		test: vi.fn(),
		rotateSecret: vi.fn(),
		reregisterNotifications: vi.fn(),
		verifyNotifications: vi.fn(),
		reconcileNotifications: vi.fn(),
		remove: vi.fn()
	},
	// No SSE — the render must follow from the response body alone.
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

const CONNECTOR: Connector = {
	id: 'c-1',
	slug: 'claims-pg',
	name: 'ZWS3 Claims Postgres',
	sourceType: 'postgres',
	status: 'ready',
	eventSource: 'none',
	meta: { kind: 'postgres', host: 'db.example.com' },
	columns: [],
	rowCount: 1,
	sizeBytes: 512,
	sandboxId: null,
	lastSyncedAt: '2026-08-09T10:00:00.000Z',
	syncError: null,
	syncErrorCode: null,
	syncErrorDetail: null,
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-09T10:00:00.000Z'
};

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle(until: () => boolean, tries = 30) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

/** Mount the page and open the preview drawer on the single connector. */
async function openDrawer(columns: Connector['columns'], rows: Record<string, unknown>[]) {
	list.mockResolvedValue({
		items: [{ ...CONNECTOR }],
		total: 1,
		page: 1,
		pageSize: 20,
		canManage: true
	} satisfies ConnectorList);
	get.mockResolvedValue({ ...CONNECTOR, columns, rows });
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle(() => !!target.querySelector('td.row-actions button'));

	const previewBtn = [...target.querySelectorAll('td.row-actions button')].find(
		(b) => b.textContent?.trim() === 'connectors_preview'
	) as HTMLButtonElement | undefined;
	expect(previewBtn, 'the Preview button is not on screen, so this case tests nothing').toBeTruthy();
	previewBtn!.click();
	await settle(() => !!target.querySelector('aside .sample thead th'));
}

const headers = () => [...target.querySelectorAll('aside .sample thead th')].map((n) => n.textContent);
const cells = () => [...target.querySelectorAll('aside .sample tbody td')].map((n) => n.textContent);

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	list.mockReset();
	get.mockReset();
});

describe('/connectors renders a live source whose columns repeat a name', () => {
	it('⛔ THE DEFECT: a joined SELECT with two “id” columns no longer blanks the page', async () => {
		await openDrawer(
			[
				{ name: 'id', type: 'number' },
				{ name: 'id', type: 'number' },
				{ name: 'amount', type: 'number' }
			],
			[{ id: 7, amount: 250 }]
		);

		// ⛔ THE POSITIVE ANCHOR. Pre-fix these were `[]` — the page threw during the drawer render.
		expect(headers()).toEqual(['id', 'id', 'amount']);
		expect(cells()).toEqual(['7', '7', '250']);

		// ⛔ AND THE PAGE BEHIND THE DRAWER. `each_key_duplicate` was never scoped to the drawer; the
		// connector table and its controls went with it. This is the half that makes the claim "the
		// page survived" rather than "the drawer coped".
		expect(target.textContent).toContain('ZWS3 Claims Postgres');
		expect(target.querySelector('td.row-actions button')).not.toBeNull();
	});

	it('the ordinary case is unchanged — the index key changed nothing a reader can see', async () => {
		await openDrawer(
			[
				{ name: 'claim_id', type: 'string' },
				{ name: 'amount', type: 'number' }
			],
			[{ claim_id: 'CLM-1', amount: 250 }]
		);
		expect(headers()).toEqual(['claim_id', 'amount']);
		expect(cells()).toEqual(['CLM-1', '250']);
	});
});
