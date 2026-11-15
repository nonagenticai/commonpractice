// @vitest-environment jsdom
//
// src/routes/connectors/connectors.sync-error-dutch.render.test.ts — the one string on /connectors
// that a Dutch admin could not read, and that no test had ever constructed.
//
// ⛔ THE DEFECT. `datasets.sync_error` is ENGLISH PROSE COMPOSED ON THE SERVER AND WRITTEN TO A
// COLUMN — `` `${code}: ${err.message}` `` in backend/src/datasets/connector-refresh.ts's catch.
// `/connectors` rendered it verbatim in two places: the drawer's error notice, right next to the
// localized `connectors_sync_error_label`, and the status badge's `title=` tooltip. So the page
// showed:
//
//     Laatste synchronisatiefout: egress_host_not_allowlisted: Host 'files.example.com' is not
//     on the connector egress allowlist.
//
// …a machine token and an English sentence, inside an otherwise fully-Dutch page. And because it is
// a COLUMN and not a response, it survived reload, re-render and re-login — it stayed English until
// that connector next synced successfully, which for a connector whose host was de-allowlisted is
// "never".
//
// ⛔ WHY CI NEVER SAW IT. Every render fixture under this directory sets `syncError: null` — seven
// files, measured. The one field guaranteed to carry English was the one no fixture ever populated.
// This file is the fixture that populates it.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connector, ConnectorDetail, ConnectorList } from '$lib/types/connectors';

// The **nl** catalog, for real, because the SUBJECT of this file is the rendered sentence — the
// key-name stub the sibling structural tests use would prove only that a message function was
// called, which is precisely what the defect already did (it called
// `m.connectors_sync_error_label()` and then pasted English after it).
//
// The REAL nl catalog, read from disk. It briefly carried an overlay from a `.newkeys-be.json`
// handoff file while the new `error_*` keys were being merged into `messages/*.json` in a separate
// step; that file is not part of the repo, so the overlay is gone. `assertDutch` below refuses to
// run on a key that resolved to nothing, so a key dropped from the catalog reds this file rather
// than making it pass vacuously.
vi.mock('$lib/paraglide/messages', async () => {
	const nl = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')) as Record<
		string,
		string
	>;
	const patterns: Record<string, string> = {};
	for (const [k, v] of Object.entries(nl)) if (typeof v === 'string') patterns[k] = v;

	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(patterns)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			patterns[key]!.replace(/\{(\w+)\}/g, (whole, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
// `getLocale` is read by error-message.ts's number/date helpers; the catalog above is what decides
// the words.
vi.mock('$lib/paraglide/runtime', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getLocale: () => 'nl'
}));

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
// ⛔ `$lib/api/error-message` is deliberately NOT mocked. `syncErrorText` IS the unit under test,
// and every sibling file in this directory stubs the module out — which is the other half of why
// this defect survived: the only module that could have localized the string was never loaded.
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';
import { locale } from '$lib/stores/locale.svelte';

/**
 * ⚠️ THE BIDI ISOLATES ARE PART OF THE STRING. `error-message.ts` wraps every foreign value it
 * interpolates in U+2068 FIRST STRONG ISOLATE / U+2069 POP DIRECTIONAL ISOLATE (`iso()` there), so
 * a hostname cannot re-order the Arabic and Hebrew sentences around it. An assertion built from the
 * bare host would therefore never match the DOM. Mirrored rather than imported: the test asserting
 * the rendered characters is the point.
 */
const iso = (v: string) => `\u2068${v}\u2069`;

/** The exact Dutch sentence a key renders, refusing to return an empty/echoed one. */
/** The nl pattern for `key`, from the merged catalog. */
function nlPattern(key: string): string | undefined {
	const nl = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')) as Record<
		string,
		string
	>;
	return nl[key];
}

function assertDutch(key: string, params?: Record<string, unknown>): string {
	const pattern = nlPattern(key);
	expect(
		pattern,
		`no nl copy for '${key}' in messages/nl.json — every assertion that ` +
			`uses it would compare against undefined and prove nothing`
	).toBeTruthy();
	const text = pattern!.replace(/\{(\w+)\}/g, (whole, name: string) =>
		params && name in params ? String(params[name]) : whole
	);
	// Non-vacuity: an empty or key-echoing pattern would make every `toContain` below trivial.
	expect(text.length, `'${key}' resolved to an empty sentence`).toBeGreaterThan(10);
	// …and every placeholder the pattern names must have been supplied, or the assertion would be
	// built from a literal `{host}` that the DOM can never contain.
	expect(text, `'${key}' still carries an uninterpolated placeholder`).not.toMatch(/\{\w+\}/);
	return text;
}

const CONNECTOR: Connector = {
	id: 'c-1',
	slug: 'claims-files',
	name: 'ZSYNCERR Claims Files',
	sourceType: 'storage',
	status: 'error',
	eventSource: 'none',
	meta: { kind: 'storage', host: 'files.example.com', bucket: 'claims', key: 'x.csv' },
	columns: [],
	rowCount: 0,
	sizeBytes: 0,
	sandboxId: null,
	lastSyncedAt: '2026-08-09T10:00:00.000Z',
	// The row EXACTLY as backend/src/datasets/connector-refresh.ts writes it on a refused refresh.
	syncError:
		"egress_host_not_allowlisted: Host 'files.example.com' is not on the connector egress allowlist.",
	syncErrorCode: 'egress_host_not_allowlisted',
	syncErrorDetail: {
		host: 'files.example.com',
		reason: "Host 'files.example.com' is not on the connector egress allowlist."
	},
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-09T10:00:00.000Z'
};

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
const initialLocale = locale.current;

async function settle(until: () => boolean, tries = 30) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

/** Mount the page on ONE connector and open its preview drawer. */
async function openDrawer(over: Partial<Connector> = {}) {
	const row = { ...CONNECTOR, ...over };
	list.mockResolvedValue({
		items: [row],
		total: 1,
		page: 1,
		pageSize: 20,
		canManage: true
	} satisfies ConnectorList);
	get.mockResolvedValue({ ...row, rows: [] } satisfies ConnectorDetail);
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle(() => !!target.querySelector('td.row-actions button'));
	const previewBtn = [...target.querySelectorAll('td.row-actions button')].find(
		(b) => b.textContent?.trim() === nlPattern('connectors_preview')
	) as HTMLButtonElement | undefined;
	expect(
		previewBtn,
		'the Preview button is not on screen, so the drawer assertions below test nothing'
	).toBeTruthy();
	previewBtn!.click();
	// The DRAWER, not the notice — the healthy-connector control below has no notice by design, and
	// waiting on one there would leave that assertion passing against an unopened drawer.
	await settle(() => !!target.querySelector('aside .drawer-head'));
	return row;
}

beforeEach(() => {
	locale.current = 'nl';
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	list.mockReset();
	get.mockReset();
	// ⚠️ Assigned directly, never via `locale.set()` — that fires an authFetch PATCH to
	// /api/me/locale, which the fail-loud fetch stub in lib/test/setup.ts would name.
	locale.current = initialLocale;
});

describe('/connectors renders a failed sync in the reader’s language', () => {
	it('⛔ THE DEFECT: the drawer notice is a Dutch sentence, not the persisted English', async () => {
		await openDrawer();
		const notice = target.querySelector('aside .notice.error')!.textContent!;

		// The sentence the reader can act on, with the offending host in it.
		expect(notice).toContain(
			assertDutch('error_egress_host_not_allowlisted', { host: iso('files.example.com') })
		);

		// ⛔ THE ASSERTION THE OLD PAGE FAILS, AND THE ONE THE FIX IS ABOUT. The wire code is a
		// MACHINE token: it must reach the browser and must never reach the screen.
		expect(notice).not.toContain('egress_host_not_allowlisted');
		// …nor the English prose it prefixed.
		expect(notice).not.toContain('is not on the connector egress allowlist');
		// The label beside it is still the localized one — proving the notice rendered at all.
		expect(notice).toContain(assertDutch('connectors_sync_error_label'));
	});

	it('the status badge tooltip carries the same Dutch sentence, not the raw column', async () => {
		// `title=` is the second render site, and the easier one to forget: it is invisible in a
		// screenshot and in every DOM-text assertion.
		await openDrawer();
		const badge = target.querySelector('tbody .badge.status') as HTMLElement;
		expect(badge, 'no status badge on screen').toBeTruthy();
		expect(badge.title).toBe(
			assertDutch('error_egress_host_not_allowlisted', { host: iso('files.example.com') })
		);
		expect(badge.title).not.toContain('egress_host_not_allowlisted');
	});

	it('the generic default `sync_failed` also renders Dutch', async () => {
		// The other end of the enumeration: everything that is neither an EgressBlockedError nor an
		// HttpError lands on this code (connector-refresh.ts's default arm), and its `reason` is a
		// driver string no catalog can localize — so the CODE has to carry the sentence.
		await openDrawer({
			syncErrorCode: 'sync_failed',
			syncError: 'sync_failed: connect ECONNREFUSED 10.1.2.3:5432',
			syncErrorDetail: { host: 'db.example.com', reason: 'connect ECONNREFUSED 10.1.2.3:5432' }
		});
		const notice = target.querySelector('aside .notice.error')!.textContent!;
		expect(notice).toContain(assertDutch('error_sync_failed'));
		expect(notice).not.toContain('ECONNREFUSED');
		expect(notice).not.toContain('sync_failed');
	});

	it('⚠️ A PRE-0074 ROW STILL RENDERS ITS ENGLISH — the fallback is not scaffolding', async () => {
		// Every row written before migration 0074 has `sync_error_code IS NULL` FOREVER: nothing
		// recomputes the column, only that connector's next successful refresh clears it. Deleting
		// `syncErrorText`'s legacy-text branch would blank those rows in all eight locales, so the
		// branch is pinned here rather than left to be tidied away.
		await openDrawer({ syncErrorCode: null, syncErrorDetail: null });
		const notice = target.querySelector('aside .notice.error')!.textContent!;
		expect(notice).toContain('is not on the connector egress allowlist');
		// Still framed by the localized label — the fallback is the VALUE, never the whole notice.
		expect(notice).toContain(assertDutch('connectors_sync_error_label'));
	});

	// ── the three codes whose sentence needs a field the OLD `{ host, reason }` bag did not carry ──
	//
	// ⛔ EVERY BAG BELOW IS TRANSCRIBED FROM A REAL PERSISTED ROW, never hand-assembled. Each one is
	// the literal `datasets.sync_error_detail` that
	// backend/tests/connector-sync-error-detail.test.ts read back out of Postgres after driving the
	// real `connector-refresh` catch — key order, English prose and all. Inventing a plausible bag
	// here would prove only that the catalog can read a bag someone typed for it, which is the one
	// thing that was never in doubt; the defect was that the server never wrote one.
	//
	// ⚠️ AND THESE ASSERT THE READER'S HALF ONLY. The catalog entries and the nl copy already
	// existed — they returned `null` for want of a field. So these cases are green on main too, and
	// they are here as the end-to-end statement (this bag → this Dutch sentence) plus a guard
	// against the catalog drifting away from what the backend now persists. The half that could
	// only ever go green on the fix is the persistence test named above.

	it('xlsx_too_large: the persisted NUMBERS become a Dutch sentence with both figures', async () => {
		await openDrawer({
			syncErrorCode: 'xlsx_too_large',
			syncError:
				"xlsx_too_large: This Excel file's sheet data decompresses to ~69 MB, over the 60 MB limit — checked before parsing so an oversized sheet is never loaded into memory.",
			syncErrorDetail: {
				host: 'storage.detail.invalid',
				reason:
					"This Excel file's sheet data decompresses to ~69 MB, over the 60 MB limit — checked before parsing so an oversized sheet is never loaded into memory.",
				limitMb: 60,
				actualMb: 69
			}
		});
		const notice = target.querySelector('aside .notice.error')!.textContent!;
		// ⚠️ The figures are NOT isolated — `error-message.ts` formats them with the reader's own
		// `num()` rather than passing them through `iso()`, because a number is not foreign text.
		expect(notice).toContain(assertDutch('error_xlsx_too_large', { actualMb: 69, limitMb: 60 }));
		expect(notice).not.toContain('decompresses to');
		expect(notice).not.toContain('xlsx_too_large');
	});

	it('storage_format_unknown: the persisted object key reaches the Dutch sentence', async () => {
		await openDrawer({
			syncErrorCode: 'storage_format_unknown',
			syncError: "storage_format_unknown: cannot infer a format for object 'quarterly-extract'",
			syncErrorDetail: {
				key: 'quarterly-extract',
				host: 'storage.detail.invalid',
				reason: "cannot infer a format for object 'quarterly-extract'"
			}
		});
		const notice = target.querySelector('aside .notice.error')!.textContent!;
		expect(notice).toContain(
			assertDutch('error_storage_format_unknown', { key: iso('quarterly-extract') })
		);
		expect(notice).not.toContain('cannot infer a format');
		expect(notice).not.toContain('storage_format_unknown');
	});

	it('bad_config: `reason` is the DISCRIMINATOR, so the eight-armed entry picks its arm', async () => {
		await openDrawer({
			syncErrorCode: 'bad_config',
			syncError:
				"bad_config: storage key escapes its bucket (resolved to '/api/files/cp-victim-tenant/secret.csv') — '.' and '..' segments are not allowed",
			syncErrorDetail: {
				host: 'storage.detail.invalid',
				reason: 'key_escapes_bucket',
				resolved: '/api/files/cp-victim-tenant/secret.csv'
			}
		});
		const notice = target.querySelector('aside .notice.error')!.textContent!;
		expect(notice).toContain(
			assertDutch('bad_config_key_escapes_bucket', {
				resolved: iso('/api/files/cp-victim-tenant/secret.csv')
			})
		);
		expect(notice).not.toContain('escapes its bucket');
		expect(notice).not.toContain('bad_config');
	});

	it('⚠️ THE NEGATIVE CONTROL: the OLD bag still lands on the English, and must', async () => {
		// The SAME code and the SAME English column as the case above, with the bag
		// `connector-refresh.ts` used to write: `reason` is the raw `err.message`, not the
		// discriminator. `byReason()` finds no arm named after a whole English sentence and returns
		// `null`, so the reader gets the legacy prose — which still names the rule that broke, and
		// which is strictly better than a machine token or an empty notice.
		//
		// ⛔ THIS ARM IS PERMANENT, not scaffolding. Rows written before this fix are never
		// recomputed — only that connector's next refresh rewrites the column — so deleting it
		// would blank those notices in all eight locales. It is also the mid-roll guard: an old pod
		// serving a new bundle still writes exactly this shape.
		await openDrawer({
			syncErrorCode: 'bad_config',
			syncError:
				"bad_config: storage key escapes its bucket (resolved to '/api/files/cp-victim-tenant/secret.csv') — '.' and '..' segments are not allowed",
			syncErrorDetail: {
				host: 'storage.detail.invalid',
				reason:
					"storage key escapes its bucket (resolved to '/api/files/cp-victim-tenant/secret.csv') — '.' and '..' segments are not allowed"
			}
		});
		const notice = target.querySelector('aside .notice.error')!.textContent!;
		expect(notice).toContain('escapes its bucket');
		// Non-vacuity: it must be the LEGACY text and not the Dutch arm the new bag reaches, or this
		// case would pass against the fixed bag too and prove nothing about the fallback.
		expect(notice).not.toContain(
			assertDutch('bad_config_key_escapes_bucket', {
				resolved: iso('/api/files/cp-victim-tenant/secret.csv')
			})
		);
		expect(notice).toContain(assertDutch('connectors_sync_error_label'));
	});

	it('a healthy connector renders no error notice at all', async () => {
		// The control. Without it, a page that unconditionally rendered `.notice.error` would pass
		// every assertion above.
		await openDrawer({ status: 'ready', syncError: null, syncErrorCode: null, syncErrorDetail: null });
		expect(target.querySelector('aside .notice.error')).toBeNull();
	});
});
