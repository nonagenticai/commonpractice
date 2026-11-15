// @vitest-environment jsdom
//
// src/routes/audit/audit-page.result-sort.render.test.ts — the Result column sorts by the string
// that is ON SCREEN.
//
// ⛔ THE DEFECT, AND WE INTRODUCED IT. Localizing the Result cell (`AuditRow` now renders a coded
// row through `flowSummaryLabel`) left `sortVal()`'s `result` arm reading the raw English
// `it.result`. Before that change both were the same field and could not disagree; afterwards a
// Dutch reader clicked "Resultaat ↑" and got a table whose visible first column read
//
//     Ingelogd via SSO
//     Handmatig checkpoint          ← filed under M, for "Manual checkpoint"
//     Zzz laatste rij
//
// — an ordering with no relationship to anything the reader can see. That reads as a broken sort,
// not as a translation bug, so nobody would look here for it. `sortVal`'s `actor` arm three lines
// above already argues the convention out loud: "the column sorts by what the reader can see".
//
// The fix is the shared adapter `$lib/i18n/audit-result-label`, called by the ROW and by the SORT,
// so there is one mapping rather than two that must be kept in step by hand.
//
// ⛔ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED. The REAL compiled catalogs are driven through the
// REAL locale store, because the assertion IS the literal Dutch string and its position — a
// key-name mock would resolve `flow_summary_manual_checkpoint` to a token starting with `f` and
// sort it somewhere neither locale ever would, proving nothing about either.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { locale } from '$lib/stores/locale.svelte';
import type { AuditFeed, AuditItem } from '$lib/types/audit';

// `ApiError` must be a REAL class — `load()` does `e instanceof ApiError` to split 401/403 off from
// an ordinary failure. Hoisted for the same reason the sibling refresh-failure test hoists it.
const { list, exportCsv, ApiErrorMock } = vi.hoisted(() => ({
	list: vi.fn(),
	exportCsv: vi.fn(),
	ApiErrorMock: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error'
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/audit', () => ({ ApiError: ApiErrorMock, auditApi: { list, exportCsv } }));

import Page from './+page.svelte';

const BASE: Omit<AuditItem, 'id' | 'result'> = {
	action: 'flow.checkpoint',
	category: 'block',
	targetType: 'flow',
	targetId: '3f1c8b2e-1c4a-4d2b-9f0e-6c1b2d3e4a8b',
	resultTone: 'ok',
	createdAt: '2026-08-18T10:00:00.000Z',
	actor: { name: 'Mary de Vries', initials: 'MV' }
};

// ⛔ THE FIXTURE IS CHOSEN SO THE TWO ORDERINGS DIFFER, which is the only thing that makes this
// file able to fail. The coded row's sort key moves with the language — `manual checkpoint` (M) in
// English, `handmatig checkpoint` (H) in Dutch — and the two legacy rows bracket BOTH positions, so
// the coded row lands in the middle for an English reader and first for a Dutch one. Fixtures whose
// order happened to coincide would make every assertion below pass against the defect.
const CODED: AuditItem = {
	...BASE,
	id: 'coded',
	result: 'Manual checkpoint',
	resultCode: 'flow_summary_manual_checkpoint',
	resultParams: null
};
/** No `resultCode` — an ordinary pre-existing row, i.e. nearly the whole append-only feed. */
const LEGACY_I: AuditItem = { ...BASE, id: 'legacy-i', action: 'auth.login', result: 'Ingelogd via SSO' };
const LEGACY_Z: AuditItem = { ...BASE, id: 'legacy-z', action: 'auth.logout', result: 'Zzz laatste rij' };

function feed(items: AuditItem[]): AuditFeed {
	return { items, total: items.length, page: 1, pageSize: 25, counts: { all: items.length, block: items.length } };
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
const initialLocale = locale.current;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	list.mockReset();
	exportCsv.mockReset();
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	// Assigned directly, never via `locale.set()`: that PATCHes /api/me/locale.
	locale.current = initialLocale;
});

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/**
 * Mount the page in `loc`, click the Result column header once (→ ascending), and return the
 * VISIBLE result cell of every row, in DOM order.
 */
async function sortedResultCells(loc: 'en' | 'nl', items: AuditItem[]): Promise<string[]> {
	locale.current = loc;
	list.mockResolvedValue(feed(items));
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	const headers = [...target.querySelectorAll('button.th-sort')];
	expect(headers, 'the table header did not render, so this case tests nothing').toHaveLength(5);
	// ⛔ `bubbles: true` — Svelte 5 DELEGATES DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the handler and the table keeps its default time sort, which
	// would make an assertion about the fixture's insertion order pass for free.
	headers[4]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();

	const rows = [...target.querySelectorAll('tbody tr')];
	expect(rows, 'no rows on screen').toHaveLength(items.length);
	return rows.map((r) => r.querySelector('.dot-status')?.textContent?.trim() ?? '');
}

describe('the Result column orders by the words the reader can see', () => {
	it('⛔ nl — the coded row sorts under H for "Handmatig checkpoint", not under M', async () => {
		// REVERT THAT TURNS THIS RED: `case 'result': return (it.result ?? '').toLowerCase();`. The
		// row still RENDERS "Handmatig checkpoint" under that revert — only its position moves — so
		// an assertion about the text alone would not catch it. The assertion is the ORDER.
		const cells = await sortedResultCells('nl', [LEGACY_Z, CODED, LEGACY_I]);
		expect(cells).toEqual(['Handmatig checkpoint', 'Ingelogd via SSO', 'Zzz laatste rij']);
	});

	it('NON-VACUITY — en, the same three rows, and the coded row moves to the MIDDLE', async () => {
		// The two orderings genuinely differ, so the Dutch case above cannot be satisfied by a sort
		// that ignores the locale, and this one cannot be satisfied by one that always speaks Dutch.
		const cells = await sortedResultCells('en', [LEGACY_Z, CODED, LEGACY_I]);
		expect(cells).toEqual(['Ingelogd via SSO', 'Manual checkpoint', 'Zzz laatste rij']);
	});

	it('⭐ LEGACY ROWS SORT EXACTLY AS THEY ALWAYS DID — same order in nl as in en', async () => {
		// `audit_log` is append-only with no backfill: rows without a `resultCode` are nearly the
		// whole feed and their sort key must still be their raw `result` string, byte for byte. A
		// projection that "helpfully" normalised them would silently reorder years of history.
		const expected = ['Ingelogd via SSO', 'Zzz laatste rij'];
		expect(await sortedResultCells('nl', [LEGACY_Z, LEGACY_I])).toEqual(expected);
		unmount(component!);
		component = null;
		target.remove();
		target = document.createElement('div');
		document.body.appendChild(target);
		expect(await sortedResultCells('en', [LEGACY_Z, LEGACY_I])).toEqual(expected);
	});
});
