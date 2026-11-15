// @vitest-environment jsdom
//
// src/routes/connectors/sync-outcome.render.test.ts — what a tester actually SEES after clicking
// Sync. `sync-outcome.test.ts` proves the branch table; this proves the page is wired to it.
//
// THREE SEPARATE DEFECTS ARE PINNED HERE:
//
//  1. THE STUCK SPINNER. `syncNow` set `status: 'syncing'` optimistically and threw the response
//     away. On the LOCKED path (`pg_try_advisory_lock` held by another refresh) the backend writes
//     no status and fires no NOTIFY — so the SSE event the page was waiting on NEVER ARRIVES and
//     the row spun on "Syncing" until someone reloaded by hand. The route re-reads the row after
//     the refresh, so the response body is ground truth; assigning it into `items` fixes this with
//     no SSE involved at all, which is why these tests never emit an SSE frame.
//
//  2. THE SILENT CAP. `truncated > 0` was a backend `console.warn` and nothing in the browser: a
//     green "Ready" row over a dataset that had quietly dropped rows.
//
//  3. ⛔ THE BOARD-BLANKING NEAR-MISS. A failed sync must write `actionError`, NEVER the page's
//     `error` state — `error` renders inside `{#if denied}…{:else if error}…{:else}`, which is
//     mutually exclusive with the connector table. The last test asserts the table is STILL THERE
//     under the red banner; moving the assignment to `error` reds it.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Connector, ConnectorList, RefreshOutcome } from '$lib/types/connectors';

// Message stub: every key resolves to its own name (plus its params), so an assertion names the
// exact string the page chose rather than a translation that may be re-worded later. Built from the
// REAL `en` catalog rather than a hand-listed subset — a page this size uses ~90 keys, and a
// hand-listed mock turns "someone added a message" into an unrelated test failure. It also means a
// key the page invents but never adds to the catalogs fails here as `undefined is not a function`.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	// `process.cwd()` is the frontend package root under vitest — same anchor as
	// $lib/i18n/catalogs.test.ts uses.
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

const { list, sync } = vi.hoisted(() => ({ list: vi.fn(), sync: vi.fn() }));
// ⛔ ALIAS ids, never relative ones (see $lib/api/llm-settings.test.ts).
vi.mock('$lib/api/connectors', () => ({
	connectorsApi: {
		list,
		sync,
		get: vi.fn(),
		create: vi.fn(),
		test: vi.fn(),
		rotateSecret: vi.fn(),
		reregisterNotifications: vi.fn(),
		verifyNotifications: vi.fn(),
		reconcileNotifications: vi.fn(),
		remove: vi.fn()
	},
	// No SSE in these tests, deliberately: the fix must hold without it.
	streamConnectors: () => ({ close: () => {} }),
	ApiError: class ApiError extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			message: string
		) {
			super(message);
		}
	}
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
	rowCount: 120,
	sizeBytes: 4096,
	sandboxId: null,
	lastSyncedAt: '2026-08-09T10:00:00.000Z',
	syncError: null,
	syncErrorCode: null,
	syncErrorDetail: null,
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-09T10:00:00.000Z'
};

function listResponse(): ConnectorList {
	return { items: [{ ...CONNECTOR }], total: 1, page: 1, pageSize: 20, canManage: true };
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount the page, click Sync on the single connector, and let the response settle. */
async function clickSync(outcome: RefreshOutcome, rowAfter: Partial<Connector> = {}) {
	list.mockResolvedValue(listResponse());
	sync.mockResolvedValue({
		// The route returns the connector as RE-READ AFTER the refresh, plus the outcome.
		...CONNECTOR,
		...rowAfter,
		rows: [],
		sync: outcome
	});
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	const buttons = [...target.querySelectorAll('button')];
	const syncBtn = buttons.find((b) => b.textContent?.trim() === 'connectors_sync');
	expect(syncBtn, 'the Sync button must exist, or this file tests nothing').toBeTruthy();
	syncBtn!.click();
	await settle();
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	list.mockReset();
	sync.mockReset();
});

describe('clicking Sync on /connectors', () => {
	it('a LOCKED sync reports itself AND the row leaves "Syncing" — with no SSE event at all', async () => {
		await clickSync({ ok: false, skipped: true, reason: 'locked' }, { status: 'ready' });

		// 1. It says something. Before, this branch was completely silent.
		const notice = target.querySelector('.notice.warn');
		expect(notice?.textContent).toContain('connectors_sync_locked');

		// 2. And the row settles on the real status instead of spinning forever. `streamConnectors`
		//    is a no-op stub here, so ONLY the response body can have produced this.
		const badge = target.querySelector('.badge.status');
		expect(badge?.className).toContain('ready');
		expect(badge?.className).not.toContain('syncing');
		expect(badge?.textContent).toBe('connectors_status_ready');
	});

	it('a TRUNCATED sync warns instead of showing a green success', async () => {
		await clickSync({ ok: true, rowCount: 1000, truncated: 37 }, { status: 'ready', rowCount: 1000 });

		expect(target.querySelector('.notice.ok')).toBeNull();
		const notice = target.querySelector('.notice.warn');
		expect(notice?.textContent).toContain('connectors_sync_truncated');
		// Both numbers reach the reader — "capped" without saying by how much is not much better.
		//
		// ⚠️ '1,000', NOT '1000', AND THAT IS THE POINT OF THE CHANGE THAT MOVED THIS LINE. The row
		// count now goes through `num(…, locale.current)` before it reaches the message, so the
		// figure is GROUPED in the reader's language — see `connectors-notice.locale-numbers.
		// render.test.ts`, which drives the same notice in nl. The default locale under vitest is
		// the base locale `en`, so the grouped form here is '1,000'.
		//
		// ⛔ NOT WEAKENED TO `/1[,.]?000/`. The whole defect was that this figure was rendered
		// ungrouped in a Dutch UI; a matcher that accepts both spellings would pass against the
		// code this change replaced, and the assertion would be worth nothing.
		expect(notice?.textContent).toContain('1,000');
		expect(notice?.textContent).toContain('37');
	});

	it('a clean sync confirms, with the row count', async () => {
		await clickSync({ ok: true, rowCount: 412 }, { status: 'ready', rowCount: 412 });
		const notice = target.querySelector('.notice.ok');
		expect(notice?.textContent).toContain('connectors_sync_ok');
		// Under the grouping floor in every locale, so this one reads identically before and after.
		expect(notice?.textContent).toContain('412');
		expect(target.querySelector('.notice.warn')).toBeNull();
	});

	it('⛔ a HARD FAILURE renders in the error slot WITH THE TABLE STILL BENEATH IT', async () => {
		await clickSync({ ok: false, reason: 'connection refused' }, { status: 'error' });

		const err = target.querySelector('.notice.error');
		expect(err?.textContent).toContain('connectors_sync_failed');
		expect(err?.textContent).toContain('connection refused');

		// THE BOARD-BLANKING GUARD. Writing this into the page's `error` state instead of
		// `actionError` puts it inside the `{:else if error}` arm and the whole table disappears —
		// the message replaces the thing it was supposed to explain.
		expect(target.querySelector('table'), 'the connector table was blanked by an action error').not.toBeNull();
		expect(target.textContent).toContain('ZWS3 Claims Postgres');
	});
});
