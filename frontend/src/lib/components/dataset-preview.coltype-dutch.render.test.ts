// @vitest-environment jsdom
//
// src/lib/components/dataset-preview.coltype-dutch.render.test.ts — the typed-schema preview names
// each column's TYPE in the reader's language.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. `DatasetPreviewTable` printed the backend enum straight
// into the header cell:
//
//     <span class="col-type">{c.type}</span>
//
// so "string / number / boolean / date / json" sat under a Dutch column name, inside a table whose
// truncation notice one line below already reads "50 van 10.000 rijen getoond". This is the SHARED
// component — /datasets, /submit, /challenges/[id], the builder node config and the builder
// "Challenge data" panel all mount it — so one raw expression was five screens.
//
// ⛔ AND THE HELPER WAS ALREADY WRITTEN, IMPORTED BY NOBODY. `datasetColumnTypeLabel` has lived in
// `$lib/i18n/dataset-label.ts` since #247 with a docblock naming this exact vocabulary, and
// `/datasets`' mapping drawer (`+page.svelte:649`, `<span class="map-coltype">`) already called it.
// So the SAME five words rendered as "Tekst / Getal" in the drawer and "string / number" in the
// preview table two panels away, in one session, in one language. The fix is the import.
//
// ⛔ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED. `dataset-label.test.ts` beside the helper mocks the
// catalog to key NAMES, which proves `enum → which key` and nothing about what a human reads: a key
// can exist in all eight catalogs, pass key-parity, pass placeholder-parity and still never reach a
// screen, because nothing rendered it. That is exactly what was true here. This file therefore
// asserts the Dutch WORDS, through the real compiled paraglide functions.
//
// ⚠️ NON-VACUITY, BOTH DIRECTIONS. Every assertion has a paired negative naming the raw enum the
// pre-fix expression produced (`not.toContain('string')` etc.), so a revert cannot leave this green;
// and the runtime's own locale is English, so "Tekst" cannot appear here by accident. The `en` case
// at the bottom proves the site reads the LOCALE rather than hard-coding one language.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DatasetColumn } from '$lib/types/datasets';
import { locale } from '$lib/stores/locale.svelte';
import DatasetPreviewTable from './DatasetPreviewTable.svelte';

/**
 * All five members of `DatasetColumnType` (backend/src/db/dataset-types.ts) plus ONE the enum does
 * not contain.
 *
 * ⚠️ `geopoint` IS NOT PADDING. `ontology_attributes.type` is a bare `text` column, so the value
 * set reaching this vocabulary is genuinely open, and a labeller that blanked an unknown type would
 * print a column header with a NAME and no type at all — a schema that looks incomplete rather than
 * one carrying a type nobody enumerated.
 */
const columns: DatasetColumn[] = [
	{ name: 'klantnaam', type: 'string', pii: true },
	{ name: 'bedrag', type: 'number', pii: false },
	{ name: 'akkoord', type: 'boolean', pii: false },
	{ name: 'ingediend_op', type: 'date', pii: false },
	{ name: 'payload', type: 'json', pii: false },
	// ⚠️ THE CAST IS THE POINT, NOT A WORKAROUND. `DatasetColumn.type` is the closed union, and a
	// sixth member is exactly what `tsc` should refuse to write — but the value REACHES this
	// component at runtime all the same (an ontology attribute type, a column an older importer
	// wrote), which is why `datasetColumnTypeLabel` takes `string` rather than the union. Widening
	// the fixture's type instead would hide that distinction from the next reader.
	{ name: 'vestiging', type: 'geopoint' as DatasetColumn['type'], pii: false }
];
const rows = [
	{
		klantnaam: 'Jansen BV',
		bedrag: 1207,
		akkoord: true,
		ingediend_op: '2026-08-16',
		payload: { a: 1 },
		vestiging: '52.37,4.89'
	}
];

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	// ⚠️ Assigned directly, never through `locale.set()`: that method fires an authFetch PATCH to
	// /api/me/locale, which the fail-loud fetch stub in lib/test/setup.ts would name. Same lever as
	// `dataset-preview.locale-numbers.render.test.ts`, and it is the lever the app itself uses —
	// `stores/locale.svelte.ts` rebinds paraglide's `getLocale()` onto this rune.
	locale.current = initialLocale;
});

function typeChips(): string[] {
	app = mount(DatasetPreviewTable, { target: host, props: { columns, rows } });
	flushSync();
	// ⛔ THE POSITIVE ANCHOR. A component that threw renders nothing, `querySelectorAll` returns []
	// and every "the English enum is gone" assertion below passes against an empty DOM.
	const names = [...host.querySelectorAll('.col-name')].map((n) => n.textContent);
	expect(names, 'the preview header never rendered — the fixture reached nothing').toEqual([
		'klantnaam',
		'bedrag',
		'akkoord',
		'ingediend_op',
		'payload',
		'vestiging'
	]);
	return [...host.querySelectorAll('.col-type')].map((n) => n.textContent ?? '');
}

describe('the dataset preview names its column types in the reader’s language', () => {
	it('⛔ THE DUTCH CASE: a `string` column reads "Tekst", and no raw enum survives', () => {
		locale.current = 'nl';
		const chips = typeChips();

		expect(chips).toEqual(['Tekst', 'Getal', 'Ja/nee', 'Datum', 'Gestructureerd', 'geopoint']);

		// ⛔ THE ASSERTIONS THAT INVERT ON A REVERT TO `{c.type}` — these are the exact tokens the
		// un-fixed component printed. Scoped to the header row, because the fixture's own column
		// NAMES are Dutch and the body cells hold data, so `host.textContent` would be a looser net.
		const header = host.querySelector('thead')!.textContent ?? '';
		for (const raw of ['string', 'number', 'boolean', 'date'])
			expect(header, `the raw enum "${raw}" is still on screen`).not.toContain(raw);
	});

	it('AN UNKNOWN TYPE KEEPS ITS OWN NAME — a blank chip would read as a column with no type', () => {
		locale.current = 'nl';
		const chips = typeChips();
		// `geopoint` has no catalog entry and must not acquire one; the point is that it is still
		// THERE. An empty sixth chip is the failure this asserts against, stated on its own.
		expect(chips[5]).toBe('geopoint');
		expect(chips[5]).not.toBe('');
	});

	it('…and in English the same six read the base catalog — the site reads the tag', () => {
		locale.current = 'en';
		expect(typeChips()).toEqual(['Text', 'Number', 'Yes/no', 'Date', 'Structured', 'geopoint']);
	});

	it('re-labels ON THE SWITCH — this component fetches nothing, so nothing else can have changed it', () => {
		locale.current = 'en';
		typeChips();
		const first = host.querySelector('.col-type')!;
		expect(first.textContent).toBe('Text');

		locale.current = 'nl';
		flushSync();

		expect(first.textContent).toBe('Tekst');
	});
});
