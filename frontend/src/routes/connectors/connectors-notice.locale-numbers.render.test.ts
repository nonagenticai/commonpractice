// @vitest-environment jsdom
//
// src/routes/connectors/connectors-notice.locale-numbers.render.test.ts — /connectors prints ONE
// spelling of a row count, not two.
//
// ⛔ THE DEFECT, AND WHY THIS PAGE IS THE PROOF THAT IT WAS AN OVERSIGHT RATHER THAN A DECISION.
// `+page.svelte` renders the table's row count through `num(c.rowCount, locale.current)` (the
// PR #247 sweep reached it) and, twenty lines earlier, hands the SAME KIND OF FIGURE to
// `m.connectors_sync_ok({ rows })` completely unformatted, because paraglide interpolates a message
// parameter verbatim: the compiled body is `` `Synchronisatie voltooid — ${i?.rows} rijen geladen.` ``
// with no `Intl` in it. A Dutch tester clicking Sync on a capped dataset therefore read
// "10000 rijen geladen" in the banner and "10.000" in the row directly beneath it — the same
// number, in the same language, in the same viewport, spelled two ways.
//
// ⚠️ THE REAL COMPILED MESSAGES, NOT THE KEY-NAME STUB that `sync-outcome.render.test.ts` (this
// page's other render spec) uses. That stub joins params with COMMAS, which is the very character
// English grouping inserts — it literally cannot distinguish "1,000" from "1000,37". Anything
// asserting on grouping has to render the real sentence.
//
// ⚠️ NON-VACUITY. 10 000 is `DATASET_INJECT_ROW_CAP` (backend/src/db/dataset-types.ts), the real
// ceiling this notice exists to announce; it is above the grouping floor in every locale, and this
// runtime's own locale is not Dutch, so "10.000" cannot appear by accident. Every assertion below
// inverts when the `num()` wrap is removed.
//
// ⚠️ NO SWITCH TEST HERE, DELIBERATELY. `actionNotice` is built inside the `syncNow` HANDLER and
// stored as a finished string, so it does not re-render on a locale switch — and that is true of
// the SENTENCE too, not just the number: `m.connectors_sync_ok()` was already resolved at click
// time before this change. Wrapping the parameter neither introduces nor removes that property, so
// pinning it here would assert a pre-existing page behaviour under the banner of this fix. The
// reactivity claim is driven where it is real, in
// $lib/components/dataset-preview.locale-numbers.render.test.ts.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Connector, ConnectorList, RefreshOutcome } from '$lib/types/connectors';
import { locale } from '$lib/stores/locale.svelte';

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
	// No SSE: the notice must be produced by the response body alone.
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

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
const initialLocale = locale.current;

/** The notice's SENTENCE — its `<span>`, not the wrapper, which also holds the ✕ dismiss button. */
const noticeText = (sel: string) =>
	document.querySelector(`${sel} span`)?.textContent ?? '';

async function settle() {
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount the page, click Sync on the single connector, and let the response settle. */
async function clickSync(outcome: RefreshOutcome, rowAfter: Partial<Connector> = {}) {
	list.mockResolvedValue({
		items: [{ ...CONNECTOR }],
		total: 1,
		page: 1,
		pageSize: 20,
		canManage: true
	} satisfies ConnectorList);
	sync.mockResolvedValue({ ...CONNECTOR, ...rowAfter, rows: [], sync: outcome });
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	// ⚠️ Selected STRUCTURALLY, not by label. This file mounts the page in four languages, and
	// "Sync now" is only its English name — matching on text made three of these tests silently
	// stop clicking anything.
	const syncBtn = target.querySelector('td.row-actions button') as HTMLButtonElement | null;
	expect(syncBtn, 'the Sync button must exist, or this file tests nothing').toBeTruthy();
	syncBtn!.click();
	await settle();
}

beforeEach(() => {
	locale.current = 'en';
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	list.mockReset();
	sync.mockReset();
	// ⚠️ Assigned directly, never via `locale.set()` — that fires an authFetch PATCH to
	// /api/me/locale, which the fail-loud fetch stub in lib/test/setup.ts would name.
	locale.current = initialLocale;
});

describe('/connectors spells a row count ONE way', () => {
	it('THE ENGLISH BASELINE: the banner groups 10 000 exactly as the table row does', async () => {
		await clickSync({ ok: true, rowCount: 10_000 }, { status: 'ready', rowCount: 10_000 });

		expect(noticeText('.notice.ok')).toBe('Sync complete — 10,000 rows loaded.');
		// ⛔ THE INCONSISTENCY, as one assertion: the banner and the cell are the same figure and
		// must read identically. Before this change the cell said "10,000" and the banner "10000".
		expect(target.querySelector('td.num')?.textContent?.trim()).toBe('10,000');
		expect(noticeText('.notice.ok')).not.toContain('10000');
	});

	it('THE DUTCH CASE: both read "10.000", and the ungrouped form is nowhere on the screen', async () => {
		locale.current = 'nl';
		await clickSync({ ok: true, rowCount: 10_000 }, { status: 'ready', rowCount: 10_000 });

		expect(noticeText('.notice.ok')).toBe('Synchronisatie voltooid — 10.000 rijen geladen.');
		expect(target.querySelector('td.num')?.textContent?.trim()).toBe('10.000');
		// ⛔ Reds on a revert: paraglide interpolates the raw number, producing exactly this.
		expect(target.textContent).not.toContain('10000');
	});

	it('the TRUNCATED banner groups BOTH of its figures', async () => {
		// The cap notice is the one a tester actually meets at 10 000 rows, and it carries TWO
		// figures. Both are above the grouping floor on purpose: `truncated` is the parameter a
		// partial fix is most likely to miss, since the eye goes to `rows`.
		locale.current = 'nl';
		await clickSync(
			{ ok: true, rowCount: 10_000, truncated: 1207 },
			{ status: 'ready', rowCount: 10_000 }
		);

		expect(noticeText('.notice.warn')).toBe(
			'Synchronisatie voltooid, maar afgekapt: 10.000 rijen geladen, 1.207 weggelaten.'
		);
		expect(noticeText('.notice.warn')).not.toContain('1207');
	});

	it('German groups like Dutch and Polish does not group four digits — the tag is read, not assumed', async () => {
		// pl sets `minimumGroupingDigits: 2`, so 1207 stays "1207" there while 10 000 becomes
		// "10 000" (U+00A0). A test whose only fixture grouped everywhere would pass against a
		// helper that hard-coded one locale.
		locale.current = 'de';
		await clickSync({ ok: true, rowCount: 10_000 }, { status: 'ready', rowCount: 10_000 });
		expect(noticeText('.notice.ok')).toBe('Synchronisierung abgeschlossen — 10.000 Zeilen geladen.');
		unmount(component!);
		component = null;
		target.textContent = '';
		list.mockReset();
		sync.mockReset();

		locale.current = 'pl';
		await clickSync({ ok: true, rowCount: 1207 }, { status: 'ready', rowCount: 1207 });
		expect(noticeText('.notice.ok')).toContain('1207');
	});
});
