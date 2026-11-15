// @vitest-environment jsdom
//
// src/routes/datasets/datasets-page.no-match.render.test.ts — a search that found nothing is not an
// empty account.
//
// ⛔ THE DEFECT. `q` is a SERVER-side filter: `load()` passes it to `datasetsApi.list`, the backend
// does the matching, and the browser gets back a page of rows. So `list.items.length === 0` answers
// two completely different questions with one branch, and the page had only the second answer:
// typing a typo produced "No datasets yet. Upload a CSV/Excel file or paste some data to get
// started." — with a "New dataset" button — in front of an account holding dozens. /challenges,
// /solutions, /blocks and /connectors all fixed this exact shape already; /datasets was the one
// left with a single arm.
//
// ⛔ WHY THE FIRST ASSERTION IS ABOUT THE API CALL. If `q` were filtered client-side, the split
// below would be decorative — the rows would already be in hand and a "no match" state would be
// unreachable in the way that matters. Pinning that the typed string reaches `datasetsApi.list` is
// what makes the rest of this file about a state a user can actually get into.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { DatasetList, DatasetRow } from '$lib/types/datasets';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { listDatasets } = vi.hoisted(() => ({ listDatasets: vi.fn() }));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: {
		list: listDatasets,
		get: vi.fn(),
		uploadFile: vi.fn(),
		paste: vi.fn(),
		remove: vi.fn(),
		updateColumns: vi.fn(),
		listMappings: vi.fn(),
		saveMapping: vi.fn(),
		deleteMapping: vi.fn()
	},
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			message: string
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/ontology', () => ({
	ontologyApi: { matrix: vi.fn(), compiled: vi.fn() },
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

/** A list response carrying whatever the server matched for the current query. */
function listResponse(items: DatasetRow[]): DatasetList {
	return { items, total: items.length, page: 1, pageSize: 20, canManage: true };
}

const ONE_ROW: DatasetRow[] = [
	{
		id: 'ds-1',
		slug: 'claims-2026',
		name: 'Claims 2026',
		sourceType: 'csv',
		columns: [{ name: 'claim_id', type: 'string', pii: false }],
		rowCount: 1240,
		sizeBytes: 90_112,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-06-01T09:00:00.000Z',
		updatedAt: '2026-06-01T09:00:00.000Z'
	}
];

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	listDatasets.mockReset();
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	vi.useRealTimers();
});

async function render(): Promise<HTMLElement> {
	app = mount(Page, { target: host, props: {} });
	flushSync();
	await tick();
	await tick();
	flushSync();
	return host;
}

/** Type into the search box and let the 250 ms debounce fire. */
async function search(term: string) {
	const input = host.querySelector<HTMLInputElement>('input.search')!;
	input.value = term;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	await vi.advanceTimersByTimeAsync(300);
	await tick();
	await tick();
	flushSync();
}

/** Text of the state notice, excluding the page header (which owns its own "New dataset" button). */
function noticeText(): string {
	return [...host.querySelectorAll('.notice')].map((n) => n.textContent ?? '').join(' ');
}

describe('/datasets tells a searcher the truth about why the table is empty', () => {
	it('sends the search term to the SERVER — the no-match arm is not client-side theatre', async () => {
		vi.useFakeTimers();
		listDatasets.mockResolvedValue(listResponse(ONE_ROW));
		await render();
		expect(listDatasets).toHaveBeenCalledWith({ q: undefined, page: 1 });

		listDatasets.mockResolvedValue(listResponse([]));
		await search('zzqq');
		expect(listDatasets).toHaveBeenLastCalledWith({ q: 'zzqq', page: 1 });
	});

	it('a search with no hits says NO MATCH, and never "you have no datasets yet"', async () => {
		vi.useFakeTimers();
		listDatasets.mockResolvedValue(listResponse(ONE_ROW));
		await render();
		listDatasets.mockResolvedValue(listResponse([]));
		await search('zzqq');

		const text = noticeText();
		expect(text).toContain('datasets_no_match');
		expect(text).not.toContain('datasets_empty');
		// ⛔ And no upload CTA in the notice: pushing a searcher toward "New dataset" invites them to
		// re-upload a file the account already has. The header button is a separate, always-on
		// affordance and is deliberately outside `.notice`.
		expect(text).not.toContain('datasets_new');
	});

	it('a genuinely empty account still gets the empty state AND its upload CTA', async () => {
		// The half of the branch that must NOT regress: this is the onboarding path.
		listDatasets.mockResolvedValue(listResponse([]));
		await render();

		const notice = host.querySelector('.notice.empty-cta')!;
		expect(notice.textContent).toContain('datasets_empty');
		expect(notice.querySelector('button.btn-primary')!.textContent).toContain('datasets_new');
		expect(noticeText()).not.toContain('datasets_no_match');
	});

	it('clearing the search returns to the empty state rather than sticking on no-match', async () => {
		// `q.trim()` is the discriminator, so whitespace must count as "not searching" — otherwise a
		// stray space parks a genuinely-empty account on a message about a search it is not running.
		vi.useFakeTimers();
		listDatasets.mockResolvedValue(listResponse([]));
		await render();
		await search('zzqq');
		expect(noticeText()).toContain('datasets_no_match');

		await search('   ');
		expect(noticeText()).toContain('datasets_empty');
		expect(noticeText()).not.toContain('datasets_no_match');
	});

	it('rows found for a search render the table, not either empty state', async () => {
		vi.useFakeTimers();
		listDatasets.mockResolvedValue(listResponse([]));
		await render();
		listDatasets.mockResolvedValue(listResponse(ONE_ROW));
		await search('claims');

		expect(host.querySelector('table')).not.toBeNull();
		expect(noticeText()).not.toContain('datasets_no_match');
		expect(noticeText()).not.toContain('datasets_empty');
	});

	// ⛔ THE PAGE DIMENSION. Every other test in this file runs at page 1, which is exactly why this
	// slipped through: the no-match arm splits on `q`, and `q` is empty here. An account holding 20
	// datasets, reader on page 2, the last row deleted under them -> the server truthfully returns
	// `items: []` with `total: 20`, `q` is empty, so the "you have no datasets yet" arm wins and
	// tells a stocked account it is empty. Worse, `.pager` sits INSIDE the table arm, after both
	// empty-state arms, so it unmounts and there is no control to page back with — only a search or
	// a full reload escapes.
	//
	// /solutions hit this first and documented the clamp; this pins the port. Removing the clamp
	// from +page.svelte reddens both assertions.
	it('⛔ a page past the end clamps back to page 1 instead of claiming the account is empty', async () => {
		vi.useFakeTimers();
		// The component's own `page` starts at 1, so the reader has to PAGE FORWARD for this to be
		// reachable at all — mocking a page-2 *response* on mount would not exercise the clamp.
		// 21 rows over a pageSize of 20: page 1 full, page 2 holds the last one.
		listDatasets.mockResolvedValueOnce({ items: ONE_ROW, total: 21, page: 1, pageSize: 20, canManage: true });
		await render();
		const next = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('datasets_pager_next'))!;
		expect(next).toBeDefined();

		// Reader clicks Next; that row is deleted under them, so page 2 comes back empty while the
		// total still says 20. `q` is empty, so without the clamp the "no datasets yet" arm wins.
		listDatasets.mockResolvedValueOnce({ items: [], total: 20, page: 2, pageSize: 20, canManage: true });
		listDatasets.mockResolvedValueOnce({ items: ONE_ROW, total: 20, page: 1, pageSize: 20, canManage: true });
		next.click();
		flushSync();
		await tick();
		await tick();
		flushSync();

		// Three calls: the mount, the page-2 ask, and the clamped retry — and the retry asks page 1.
		expect(listDatasets).toHaveBeenCalledTimes(3);
		expect(listDatasets.mock.calls[1]![0]).toMatchObject({ page: 2 });
		expect(listDatasets.mock.calls[2]![0]).toMatchObject({ page: 1 });
		// And the reader is NOT told their stocked account is empty.
		expect(noticeText()).not.toContain('datasets_empty');
		expect(host.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
	});
});
