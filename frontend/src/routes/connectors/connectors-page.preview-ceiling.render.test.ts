// @vitest-environment jsdom
//
// src/routes/connectors/connectors-page.preview-ceiling.render.test.ts — the preview drawer must
// never present a truncated table as the whole table.
//
// ⛔ THE DEFECT. `GET /api/connectors/:slug` returned a hardcoded 50 rows and this page asked for
// nothing, while the SAME drawer header rendered `rowCount` — so a 10 000-row connector showed a
// header saying "10.000 rijen" above a table holding fifty, and nothing anywhere on the screen
// admitted the other 9 950 existed. That is the dataset picker's silent stop-at-12 (PR #309) on a
// different screen: a hardcoded cap hiding user data behind a number that contradicts it.
//
// Two halves, and BOTH are asserted here because either alone leaves the defect:
//   1. the page ASKS for the whole ceiling (`?limit=200`) rather than accepting the old 50, and
//   2. when the ceiling is genuinely below `rowCount`, the screen SAYS SO — `dataset_preview_more`,
//      the same "showing N of M rows" sentence /datasets' preview table uses, in all eight
//      catalogs. A cap the reader can see is a product decision; a cap they cannot is a lie.
//
// ⚠️ ASSERTIONS ARE ON MESSAGE TOKENS, not English prose — the catalog is mocked key→key, so
// `dataset_preview_more` on screen means "this key, rendered here".
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ConnectorList, ConnectorDetail } from '$lib/types/connectors';

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
			params && Object.keys(params).length ? `${key}:${Object.values(params).join('|')}` : key;
	}
	return mod;
});

const { list, get } = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));

// ⚠️ EVERY NAME BELOW IS A REAL `connectorsApi` METHOD — a stub for a method that does not exist
// resolves to `undefined`, the page's own catch swallows the TypeError, and every assertion past
// it is vacuous. Checked against `$lib/api/connectors`.
vi.mock('$lib/api/connectors', () => ({
	connectorsApi: {
		list,
		get,
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

async function settle(until: () => boolean, tries = 60) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

const CONNECTOR = {
	id: 'c1',
	slug: 'big-connector',
	name: 'Big Connector',
	sourceType: 'postgres' as const,
	status: 'ready',
	eventSource: 'none' as const,
	meta: { kind: 'postgres' as const, host: 'db.example' },
	columns: [{ name: 'n', type: 'number' as const }],
	rowCount: 10_000,
	sizeBytes: 1,
	sandboxId: null,
	lastSyncedAt: null,
	syncError: null,
	syncErrorCode: null,
	syncErrorDetail: null,
	createdAt: '2026-08-01T00:00:00Z',
	updatedAt: '2026-08-01T00:00:00Z'
};

async function openPreview(rows: Record<string, unknown>[], rowCount = 10_000) {
	list.mockResolvedValue({
		items: [CONNECTOR],
		total: 1,
		page: 1,
		pageSize: 12,
		canManage: false
	} as ConnectorList);
	get.mockResolvedValue({ ...CONNECTOR, rowCount, rows } as ConnectorDetail);

	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle(() => !!host.querySelector('tbody tr'));

	const previewBtn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'connectors_preview'
	) as HTMLButtonElement | undefined;
	expect(previewBtn, 'no Preview button — this case tests nothing').toBeTruthy();
	previewBtn!.click();
	await settle(() => !!host.querySelector('.drawer table.sample'));
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
	get.mockReset();
});

describe('/connectors preview does not hide rows behind a cap', () => {
	it('⛔ asks the server for MORE than the old hardcoded 50', async () => {
		await openPreview(Array.from({ length: 200 }, (_, i) => ({ n: i })));
		expect(get).toHaveBeenCalledTimes(1);
		const opts = get.mock.calls[0]![1] as { limit?: number } | undefined;
		expect(opts, 'the page sent no window at all — the drawer is still capped at 50').toBeTruthy();
		expect(opts!.limit).toBeGreaterThan(50);
	});

	it('⛔ SAYS SO when the window is smaller than the connector — "showing N of M", not silence', async () => {
		await openPreview(Array.from({ length: 200 }, (_, i) => ({ n: i })), 10_000);
		const more = host.querySelector('.drawer .sample-more');
		expect(more, 'a 200-row window over a 10 000-row connector renders no ceiling notice').not.toBeNull();
		expect(more!.textContent).toContain('dataset_preview_more');
		// Both figures, grouped in the reader's locale — the header already renders rowCount that way.
		expect(more!.textContent).toContain('200');
		expect(more!.textContent).toContain('10,000');
	});

	it('says nothing when the whole connector is on screen — no notice on a 12-row source', async () => {
		await openPreview(Array.from({ length: 12 }, (_, i) => ({ n: i })), 12);
		expect(host.querySelector('.drawer .sample-more')).toBeNull();
	});
});
