// @vitest-environment jsdom
//
// src/routes/connectors/connectors-page.pager.render.test.ts — the thirteenth connector did not
// exist as far as this screen was concerned.
//
// ⛔ THE DEFECT. `GET /api/connectors` pages at twelve (backend/src/routes/connectors.ts's
// `PAGE_SIZE = 12`, applied as `.limit(PAGE_SIZE)`) and returns `total`/`page`/`pageSize` so a
// client can say how much it is not showing. /connectors called `connectorsApi.list()` with NO
// ARGUMENTS at both of its call sites, threw `total` away and rendered no pager — so a tenant with
// thirteen connectors could see twelve of them, forever, with nothing on screen admitting the
// thirteenth existed. Every other tenant list page (/datasets, /sandboxes, /solutions, /challenges)
// already pages; this was the odd one out.
//
// ⛔ AND THE SEARCH BOX DENIED IT. `q` was filtered CLIENT-side, over the twelve rows already in
// hand, so typing the thirteenth connector's own name produced `connectors_no_match` — the page
// confidently telling a reader that a connector sitting in their database does not exist. That is
// strictly worse than the truncation: silence you might notice, a denial you believe.
//
// ⚠️ THE FAKE BACKEND BELOW PAGES AND FILTERS FOR REAL, at the route's own `PAGE_SIZE`. A mock that
// answered every call with all thirteen rows would go green on the broken page too — the defect is
// precisely that the client never asks for page two or sends `q`, and only a server that honours
// both can tell the two apart.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { Connector, ConnectorList } from '$lib/types/connectors';

// Real `en` catalog, each key resolving to its own name — an assertion names a MESSAGE KEY, so no
// reworded translation can red this file.
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
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record than
// the one the page imports and silently does nothing.
vi.mock('$lib/api/connectors', () => ({
	connectorsApi: {
		list,
		get: vi.fn(),
		sync: vi.fn(),
		create: vi.fn(),
		test: vi.fn(),
		rotateSecret: vi.fn(),
		reregisterNotifications: vi.fn(),
		verifyNotifications: vi.fn(),
		reconcileNotifications: vi.fn(),
		remove: vi.fn()
	},
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

/** The route's own page size — backend/src/routes/connectors.ts. */
const PAGE_SIZE = 12;

/** The thirteenth connector, by the name a reader would type into the search box. */
const THIRTEENTH = 'Thirteenth ledger feed';
/** …and by the HOST it reads from, which appears in neither its name nor its slug. Searching a
 *  connector by hostname is a plausible demo action and it worked (within the first twelve) when
 *  the filter was client-side, so the server-side `where` has to match it too. */
const THIRTEENTH_HOST = 'telemetry-egress.demo.example.com';

function connector(i: number, name: string): Connector {
	return {
		id: `c-${i}`,
		slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
		name,
		sourceType: 'postgres',
		status: 'ready',
		eventSource: 'none',
		meta: { kind: 'postgres', host: `db-${i}.demo.example.com` },
		columns: [],
		rowCount: 10 * i,
		sizeBytes: 1024,
		sandboxId: null,
		lastSyncedAt: '2026-08-09T10:00:00.000Z',
		syncError: null,
		syncErrorCode: null,
		syncErrorDetail: null,
		createdAt: '2026-08-01T00:00:00.000Z',
		// Descending, so the ORDER the server returns puts the thirteenth LAST — on page two.
		updatedAt: new Date(Date.UTC(2026, 7, 20, 0, 0, 0) - i * 60_000).toISOString()
	};
}

/** Twelve ordinary connectors, then the one this file is about. */
const ALL: Connector[] = [
	...Array.from({ length: PAGE_SIZE }, (_, i) => connector(i + 1, `Connector ${i + 1}`)),
	{ ...connector(13, THIRTEENTH), meta: { kind: 'postgres' as const, host: THIRTEENTH_HOST } }
];

/**
 * A backend that pages and filters exactly as `GET /api/connectors` does. `params` is optional
 * because the BROKEN page calls `connectorsApi.list()` with nothing at all — that call has to be
 * answerable, or the RED run would die on a TypeError instead of on the defect.
 */
function fakeList(params: { q?: string; page?: number } = {}): ConnectorList {
	const term = params.q?.trim().toLowerCase();
	// The same four fields backend/src/routes/connectors.ts's `where` matches: name, slug,
	// source_type and the `connection_meta->>'host'`. A fake that matched fewer would let a
	// narrowed server pass here.
	const matched = term
		? ALL.filter(
				(c) =>
					c.name.toLowerCase().includes(term) ||
					c.slug.includes(term) ||
					c.sourceType.includes(term) ||
					(c.meta?.host ?? '').toLowerCase().includes(term)
			)
		: ALL;
	const page = Math.max(1, params.page ?? 1);
	return {
		items: matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
		total: matched.length,
		page,
		pageSize: PAGE_SIZE,
		canManage: true
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	list.mockReset();
	list.mockImplementation(async (params?: { q?: string; page?: number }) => fakeList(params));
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	vi.useRealTimers();
});

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await tick();
	await tick();
	flushSync();
}

async function render() {
	app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
	await settle();
}

/** The connector NAMES the table is actually showing. */
const rowNames = () =>
	[...host.querySelectorAll('tbody .ds-name')].map((n) => n.textContent?.trim() ?? '');

/**
 * The pager's "next" control, found by the MESSAGE KEY its label resolves to rather than by a class
 * — the point of this change is that /connectors stops hand-rolling a pager, so pinning one page's
 * private markup would be pinning the thing we are trying not to have.
 */
const nextButton = () =>
	[...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
		/pager_next$/.test(b.textContent?.trim() ?? '')
	);

/** Type into the search box and let the debounce fire. */
async function search(term: string) {
	const input = host.querySelector<HTMLInputElement>('input.search')!;
	input.value = term;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	await vi.advanceTimersByTimeAsync(400);
	await settle();
}

describe('/connectors can reach — and find — the thirteenth connector', () => {
	it('asks the server for a PAGE, and page one is honestly twelve of thirteen', async () => {
		await render();
		// ⛔ THE FIRST HALF OF THE DEFECT: the page called `list()` with no arguments at all.
		expect(list, 'the page never told the server which page it wanted').toHaveBeenCalledWith({
			q: undefined,
			page: 1
		});
		// The positive anchor: twelve rows really rendered, so "the thirteenth is absent" below is
		// about paging and not about an empty table.
		expect(rowNames()).toHaveLength(PAGE_SIZE);
		expect(rowNames(), 'page one should hold the first twelve').not.toContain(THIRTEENTH);
	});

	it('⛔ THE DEFECT: the thirteenth connector is reachable through the pager', async () => {
		await render();
		const next = nextButton();
		expect(next, 'there is no pager at all — twelve connectors is the whole world').toBeTruthy();
		expect(next!.disabled, 'the pager renders but refuses to leave page one').toBe(false);

		next!.click();
		await settle();

		expect(list).toHaveBeenLastCalledWith({ q: undefined, page: 2 });
		// ⛔ THE NAME, not merely "a list rendered": page two must hold THIS connector.
		expect(rowNames(), 'page two never showed the thirteenth connector').toContain(THIRTEENTH);
	});

	it('⛔ THE WORSE HALF: searching for the thirteenth by name FINDS it', async () => {
		vi.useFakeTimers();
		await render();
		await search('Thirteenth');

		// ⛔ THE READER'S OWN EXPERIENCE FIRST: they typed the connector's name and the row is either
		// there or it is not. The mechanism assertions follow it, so the RED message names the
		// connector rather than an argument list.
		expect(rowNames(), 'the search found nothing for a connector in the database').toContain(
			THIRTEENTH
		);
		const notices = [...host.querySelectorAll('.notice')]
			.map((n) => n.textContent ?? '')
			.join(' ');
		expect(notices, 'the page denied a connector that exists').not.toContain(
			'connectors_no_match'
		);
		// The typed term has to reach the SERVER; a client-side filter over the twelve rows already
		// in hand can only ever answer "no match" for a connector that is not among them.
		expect(list, 'the search box never asked the server').toHaveBeenLastCalledWith({
			q: 'Thirteenth',
			page: 1
		});
	});

	it('…and by its HOST, which is on page two and in neither its name nor its slug', async () => {
		// ⛔ THE REGRESSION THIS PINS. The client-side filter this page used to run matched four
		// fields, including `c.meta?.host`; the route's `where` matched two. Sending `q` to the
		// server without widening the `where` would have silently deleted hostname search — working
		// before the fix, dead after it. Escaping the wildcards is proven server-side, against a
		// real Postgres, in backend/tests/connectors-routes.test.ts.
		vi.useFakeTimers();
		await render();
		await search('telemetry-egress');

		expect(rowNames(), 'a connector is no longer findable by the host it reads from').toContain(
			THIRTEENTH
		);
		expect(list).toHaveBeenLastCalledWith({ q: 'telemetry-egress', page: 1 });
	});

	it('a search that genuinely matches nothing still says NO MATCH — the over-correction guard', async () => {
		// ⛔ Deleting the no-match arm would pass the case above forever. This is the half that reds
		// on it, and it is also the arm that must not become "you have no connectors yet".
		vi.useFakeTimers();
		await render();
		await search('zzqq');

		const notices = [...host.querySelectorAll('.notice')]
			.map((n) => n.textContent ?? '')
			.join(' ');
		expect(notices).toContain('connectors_no_match');
		expect(notices, 'a typo was answered with the empty-account onboarding state').not.toContain(
			'connectors_empty'
		);
		expect(rowNames()).toHaveLength(0);
	});
});
