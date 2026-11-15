// @vitest-environment jsdom
//
// src/routes/connectors/connectors-page.source-label-search.render.test.ts — the search box could
// not find the word printed in the row.
//
// ⛔ THE DEFECT, MEASURED ON THE DEMO LOCALE. The table renders its source column through
// `sourceLabel()` (+page.svelte) — `m.connectors_source_storage()` is **"Opslagdienst"** in `nl` —
// while the server's `q` predicate (`backend/src/routes/connectors.ts`) matches `name`, `slug`,
// `source_type::text` and `connection_meta->>'host'`: the raw enum `storage`, and never the label.
// A Dutch tester typed the badge word off their own screen and got "no match" with rows carrying
// that badge in front of them. The route's own comment concluded that fixing it "means giving the
// enum labels a DB-side representation, which is a schema change" — retracted in the same commit.
// The enum has three members and THIS FILE'S SUBJECT already owns all eight translations of each,
// so the page resolves the word locally and sends `?source=storage`.
//
// ⛔ THE MESSAGE LAYER IS NOT MOCKED, AND THAT IS THE ONE THING THIS FILE CANNOT COMPROMISE ON.
// Its siblings in this directory (`connectors-page.pager.render.test.ts` and the rest) stub
// `$lib/paraglide/messages` so every key resolves to its own NAME — right for them, since they
// assert WHICH key renders. Here it would be fatal in both directions: the page would be matching
// the typed text against the literal string `connectors_source_storage`, so "Opslagdienst" would
// resolve to nothing and the positive case would red for a reason that has nothing to do with the
// product, while typing `connectors_source_storage` would "work". The real catalog is the subject.
//
// ⚠️ `locale.init('nl')` RATHER THAN `overwriteGetLocale`. `$lib/stores/locale.svelte.ts` rebinds
// paraglide's `getLocale()` to its own rune at module load, and the page reads `locale.current`
// directly for the locale-aware case fold. Driving the STORE keeps those two in agreement exactly
// as they are in a browser; driving paraglide alone would leave `locale.current` on `en` and make
// the fold subtly different from the label it is folding.
//
// ⛔ AND THE FIX'S FIRST VERSION INTRODUCED A REGRESSION THIS FILE NOW PINS. `listParams()`
// returned `{ source, page }` INSTEAD of `q` whenever the input resolved to a label. That is safe
// only while no label is also a word a connector can be NAMED — and
// `connectors_source_postgres` is **"Postgres" in all eight catalogs**, the enum value spelled
// exactly as its own label. So typing "Postgres" stopped being a text search, and an `http`
// connector named "Postgres bridge" — findable by the word in its own name row before the change —
// became unfindable after it. The two readings are now UNIONED: the page sends `q` AND `qSource`,
// and the route ORs `qSource` into the `q` predicate rather than ANDing it. (`?source=` keeps its
// narrowing AND for API callers; the page does not send it.)
//
// TWO NEGATIVE CONTROLS, both by name, and they pull in opposite directions:
//   · `listParams()` returning `{ q: text, page }` unconditionally — the code before
//     `sourceFromQuery` existed, and also the cheapest "repair" for the regression — reds
//     "⛔ typing the Dutch source label filters by the enum" and "⛔ and the widening never REPLACES
//     the text search": the page sends `q: 'Opslagdienst'`, the fake backend (which matches the
//     same four fields the real `where` does) returns nothing, and the table shows
//     `connectors_no_match` with the storage row in the database.
//   · `listParams()` returning `{ source, page }` for a resolved label — the shipped regression —
//     reds "⛔ REGRESSION: an http connector NAMED "Postgres bridge" is still findable by its own
//     name": the page sends `source: 'postgres'`, the fake filters to the postgres row alone, and
//     the row whose name IS the typed word is gone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { Connector, ConnectorList } from '$lib/types/connectors';
import type { ConnectorSourceType } from '$lib/types/connectors';

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
	syncErrorText: (_code: string | null | undefined, legacy: string | null | undefined) =>
		legacy ?? ''
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import * as m from '$lib/paraglide/messages';
import { locale } from '$lib/stores/locale.svelte';
import Page from './+page.svelte';

/** The route's own page size — backend/src/routes/connectors.ts. */
const PAGE_SIZE = 12;

/**
 * ⛔ NEITHER NAME CONTAINS ANY SOURCE LABEL OR ENUM MEMBER, IN ANY LOCALE, AND THAT IS THE FIXTURE'S
 * WHOLE DESIGN. Call the storage connector "Opslag-archief" and typing "Opslagdienst" would find it
 * through the ordinary `name` path, so the case would pass with `sourceFromQuery` deleted.
 * "Schade-archief 2024" and "Polisregister" share no substring with `storage`/`postgres`/`http` or
 * with any `connectors_source_*` value, so the ONLY thing that can select one and exclude the other
 * is the enum the page derives from the label.
 */
const STORAGE_NAME = 'Schade-archief 2024';
const PG_NAME = 'Polisregister';
const HTTP_NAME = 'Koersen feed';
/**
 * ⛔ THE ONE FIXTURE THAT IS DELIBERATELY THE OPPOSITE OF THE THREE ABOVE: an `http` connector
 * whose NAME is another kind's source label. It exists because the first version of this fix sent
 * `?source=` INSTEAD of `?q=`, and **"Postgres" is BOTH the `postgres` enum value and its localized
 * label in all eight catalogs** (`messages/*.json` → `connectors_source_postgres: "Postgres"`), so
 * typing it stopped being a text search. This row was findable by the word printed in its own name
 * column before that change and unfindable after it — a regression the change's own doc-comment
 * promised could not happen.
 */
const HTTP_BRIDGE_NAME = 'Postgres bridge';

function connector(i: number, name: string, sourceType: ConnectorSourceType): Connector {
	return {
		id: `c-${i}`,
		slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
		name,
		sourceType,
		status: 'ready',
		eventSource: 'none',
		meta: { kind: sourceType, host: `h${i}.demo.example.com` } as Connector['meta'],
		columns: [],
		rowCount: 10 * i,
		sizeBytes: 1024,
		sandboxId: null,
		lastSyncedAt: '2026-08-09T10:00:00.000Z',
		syncError: null,
		syncErrorCode: null,
		syncErrorDetail: null,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: new Date(Date.UTC(2026, 7, 20, 0, 0, 0) - i * 60_000).toISOString()
	};
}

const ALL: Connector[] = [
	connector(1, STORAGE_NAME, 'storage'),
	connector(2, PG_NAME, 'postgres'),
	connector(3, HTTP_NAME, 'http'),
	connector(4, HTTP_BRIDGE_NAME, 'http')
];

/**
 * A backend that filters exactly as `GET /api/connectors` does — `q` over the same four fields the
 * real `where` matches, `source` as an INDEPENDENT AND.
 *
 * ⚠️ A FAKE THAT ANSWERED EVERY CALL WITH ALL THREE ROWS WOULD GO GREEN ON THE BROKEN PAGE TOO.
 * The defect is precisely what the client SENDS, and only a server that honours `q` the way the
 * real one does can tell "the page sent the Dutch word as text" apart from "the page sent the enum".
 */
function fakeList(
	params: { q?: string; page?: number; source?: ConnectorSourceType; qSource?: ConnectorSourceType } = {}
): ConnectorList {
	const term = params.q?.trim().toLowerCase();
	let matched = ALL;
	// `source` NARROWS (an AND, the API's own composable filter)…
	if (params.source) matched = matched.filter((c) => c.sourceType === params.source);
	// …while `qSource` WIDENS: it is an extra ARM of the `q` predicate, so a row matches when its
	// text matches OR its kind is `qSource`. Modelling it as a second AND here would make the
	// regression case below pass against the broken page, which is exactly what this fake exists to
	// prevent.
	if (term || params.qSource) {
		matched = matched.filter(
			(c) =>
				(term !== undefined &&
					(c.name.toLowerCase().includes(term) ||
						c.slug.includes(term) ||
						c.sourceType.includes(term) ||
						(c.meta?.host ?? '').toLowerCase().includes(term))) ||
				(params.qSource !== undefined && c.sourceType === params.qSource)
		);
	}
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
	list.mockImplementation(
		async (params?: {
			q?: string;
			page?: number;
			source?: ConnectorSourceType;
			qSource?: ConnectorSourceType;
		}) => fakeList(params)
	);
	host = document.createElement('div');
	document.body.appendChild(host);
	locale.init('nl');
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	vi.useRealTimers();
	locale.init('en');
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

/** The source BADGES the table is showing — the words this whole file is about. */
const rowBadges = () =>
	[...host.querySelectorAll('tbody .badge.teal')].map((n) => n.textContent?.trim() ?? '');

/** Type into the search box and let the 250 ms debounce fire. */
async function search(term: string) {
	const input = host.querySelector<HTMLInputElement>('input.search')!;
	input.value = term;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	await vi.advanceTimersByTimeAsync(400);
	await settle();
}

describe('/connectors search finds the source label the row prints', () => {
	it('the fixture really is Dutch, and the label really is a word no name contains', async () => {
		// ⛔ NON-VACUITY. Every case below turns on `m.connectors_source_storage()` being
		// "Opslagdienst" rather than "Storage service". If `locale.init` stopped taking effect, the
		// page would resolve the English label, "Opslagdienst" would match nothing, and the RED would
		// look like a defect in `sourceFromQuery`.
		await render();
		expect(m.connectors_source_storage()).toBe('Opslagdienst');
		expect(m.connectors_source_storage()).not.toBe('Storage service');
		// The badge is genuinely on screen — this is the word the reader copies.
		expect(rowBadges()).toContain('Opslagdienst');
		// …and it appears in NO name or slug, so only the enum mapping can select the row.
		for (const c of ALL) {
			expect(`${c.name} ${c.slug}`.toLowerCase()).not.toContain('opslag');
		}
	});

	it('⛔ typing the Dutch source label filters by the enum', async () => {
		vi.useFakeTimers();
		await render();
		await search(m.connectors_source_storage());

		// ⛔ THE READER'S OWN EXPERIENCE FIRST, so the RED message names the row rather than an
		// argument list: they typed the word on their screen and the storage row is either there or
		// it is not.
		expect(rowNames(), 'searching the badge word found nothing').toEqual([STORAGE_NAME]);

		// …and the MECHANISM: the enum on the wire as `qSource`, ALONGSIDE the typed word as `q`.
		// ⚠️ `qSource`, NOT `source`. The first version of this fix sent `{ source, page }` INSTEAD of
		// `q`, on the reasoning that the route ANDs the two and the label matches no
		// name/slug/enum/host. True here, false for "Postgres" — see the regression case below. The
		// route ORs `qSource` into the `q` predicate, so the two readings union instead of colliding
		// and the storage answer is unchanged: no name contains "Opslagdienst", so the text arm
		// contributes nothing and the category arm selects exactly the storage rows.
		expect(list).toHaveBeenLastCalledWith({ q: 'Opslagdienst', qSource: 'storage', page: 1 });
	});

	it('each of the three labels maps to its own enum member', async () => {
		vi.useFakeTimers();
		await render();
		// ⚠️ The expected ROWS are the union of "matches the text" and "is of that kind", which is
		// what the route now computes. For storage that is one row; for postgres and http it also
		// picks up `HTTP_BRIDGE_NAME`, by NAME and by KIND respectively — the two halves the
		// regression case below pulls apart.
		for (const [label, source, names] of [
			[m.connectors_source_postgres(), 'postgres', [PG_NAME, HTTP_BRIDGE_NAME]],
			[m.connectors_source_storage(), 'storage', [STORAGE_NAME]],
			[m.connectors_source_http(), 'http', [HTTP_NAME, HTTP_BRIDGE_NAME]]
		] as const) {
			await search(label);
			expect(list, `label "${label}"`).toHaveBeenLastCalledWith({
				q: label,
				qSource: source,
				page: 1
			});
			expect(rowNames().sort(), `label "${label}"`).toEqual([...names].sort());
		}
	});

	it('the match is case- and whitespace-insensitive, because a reader types what they type', async () => {
		vi.useFakeTimers();
		await render();
		await search('  opslagdienst  ');
		expect(list).toHaveBeenLastCalledWith({ q: 'opslagdienst', qSource: 'storage', page: 1 });
		expect(rowNames()).toEqual([STORAGE_NAME]);
	});

	it('⛔ REGRESSION: an http connector NAMED "Postgres bridge" is still findable by its own name', async () => {
		// ⛔ THE DEFECT THIS CASE PINS, AND IT WAS INTRODUCED BY THE FIX ABOVE, NOT BY THE ORIGINAL
		// CODE. `connectors_source_postgres` is **"Postgres" in all eight catalogs** — the localized
		// label and the enum value are the same word. The first `listParams()` returned
		// `{ source: 'postgres', page }` INSTEAD of `q` for any input that resolved to a label, so
		// typing "Postgres" stopped being a text search and became a whole-category filter: this
		// `http` row, whose NAME is the word the reader typed, vanished from a search on its own
		// name. It was findable before that change. A category reading must never delete rows the
		// text reading would have found — the two are UNIONED (`q` + `qSource`), not substituted.
		vi.useFakeTimers();
		await render();

		// NON-VACUITY, both halves: the word really is the label in this locale, and it really is in
		// the row's name. If either stopped being true the case would go green for the wrong reason.
		expect(m.connectors_source_postgres()).toBe('Postgres');
		expect(HTTP_BRIDGE_NAME.toLowerCase()).toContain(m.connectors_source_postgres().toLowerCase());
		expect(ALL.find((c) => c.name === HTTP_BRIDGE_NAME)?.sourceType).toBe('http');

		await search('Postgres');

		// ⛔ THE READER'S EXPERIENCE FIRST: they typed the word printed in the row and the row is
		// either on screen or it is not. RED against the pre-fix page, which renders only PG_NAME.
		expect(rowNames(), 'the connector named "Postgres bridge" is not in the results').toContain(
			HTTP_BRIDGE_NAME
		);
		// …and the label reading is NOT lost either — the postgres connector is still there. A "fix"
		// that simply deleted `sourceFromQuery` would pass the line above and fail this one only for
		// labels the enum text cannot match, so both directions are asserted on the SAME query.
		expect(rowNames().sort(), 'the union lost one of its two readings').toEqual(
			[PG_NAME, HTTP_BRIDGE_NAME].sort()
		);

		// …and the MECHANISM: both readings on the wire, the text as `q` and the kind as `qSource`.
		expect(list).toHaveBeenLastCalledWith({ q: 'Postgres', qSource: 'postgres', page: 1 });
	});

	it('⛔ and the widening never REPLACES the text search — "Opslagdienst" is still exactly the storage rows', async () => {
		// ⚠️ THE ORIGINAL DEFECT MUST STAY FIXED. The cheapest way to repair the regression above is
		// to stop sending the enum at all and send only `q` — which reinstates the bug this whole
		// file was written for, because no column holds "Opslagdienst". This case is the guard on
		// that: the word a Dutch reader copies off their own screen still selects the storage row and
		// still EXCLUDES the other three, which is the half a plain `?q=` cannot do.
		vi.useFakeTimers();
		await render();
		await search(m.connectors_source_storage());
		expect(rowNames(), 'the badge word found nothing — the original defect is back').toEqual([
			STORAGE_NAME
		]);
		expect(rowNames()).not.toContain(PG_NAME);
		expect(rowNames()).not.toContain(HTTP_BRIDGE_NAME);
	});

	it('⛔ a NON-label string is still an ordinary text search — the filter is not greedy', async () => {
		vi.useFakeTimers();
		await render();

		// A partial label. DELIBERATELY not a filter: converting six typed letters into a
		// whole-category filter is its own surprise, and the labels are not chosen to be prefix-free
		// across eight catalogs. It stays `q`, and behaves exactly as it did before this change.
		await search('Opslag');
		expect(list).toHaveBeenLastCalledWith({ q: 'Opslag', page: 1 });

		// An ordinary name search is untouched.
		await search('Polis');
		expect(list).toHaveBeenLastCalledWith({ q: 'Polis', page: 1 });
		expect(rowNames()).toEqual([PG_NAME]);

		// …and so is a host search, which the server-side `where` matches through
		// `connection_meta->>'host'`.
		await search('h3.demo.example.com');
		expect(list).toHaveBeenLastCalledWith({ q: 'h3.demo.example.com', page: 1 });
		expect(rowNames()).toEqual([HTTP_NAME]);
	});

	it('an empty box sends neither q nor source', async () => {
		vi.useFakeTimers();
		await render();
		expect(list).toHaveBeenLastCalledWith({ q: undefined, page: 1 });
		await search('Polis');
		await search('   ');
		expect(list).toHaveBeenLastCalledWith({ q: undefined, qSource: undefined, page: 1 });
		expect(rowNames()).toHaveLength(ALL.length);
	});

	it('the ENGLISH label does not filter a Dutch screen — a stated bound, not an accident', async () => {
		// ⚠️ Matching all eight catalogs at once would let one locale's label silently filter another
		// locale's screen. This case exists so that bound is a DECISION with a test on it rather
		// than an undiscovered gap.
		vi.useFakeTimers();
		await render();
		await search('Storage service');
		expect(list).toHaveBeenLastCalledWith({ q: 'Storage service', page: 1 });
	});
});
