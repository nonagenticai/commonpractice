// @vitest-environment jsdom
//
// src/lib/components/dataset-preview.locale-numbers.render.test.ts — a row count that lives INSIDE
// an ICU message is grouped in the app's locale, and re-groups on a locale switch.
//
// ⛔ THE DEFECT. `num()` (PR #247) reached the figures a component renders DIRECTLY — `{num(x,
// locale.current)}` — and never reached the ones handed to a message as a parameter. Paraglide
// compiles those raw: `dataset_preview_more` emits `` `${i?.shown} van ${i?.total} rijen getoond` ``
// with no `Intl` in sight. So a Dutch reader inspecting a dataset at the injection cap read
// "50 van 10000 rijen getoond" — the same figure the /connectors table one screen over already
// printed as "10.000", in the same session, in the same language.
//
// ⚠️ THE REAL COMPILED MESSAGES, NOT THE KEY-NAME STUB the other render specs use. A stub that
// returns `"dataset_preview_more:50,10000"` cannot tell a grouped parameter from a raw one once
// the values are joined by commas — the separator IS a comma. This file therefore mocks nothing
// and asserts on the Dutch sentence the reader actually gets.
//
// ⚠️ THIS COMPONENT IS PURE (props in, markup out; it owns no data loading), which is exactly why
// the switch test at the bottom means something: there is no `load()` that could re-run and no API
// that could be refetched, so re-evaluation of `num()` is the ONLY thing that can change the DOM.
//
// ⚠️ NON-VACUITY. The fixture is 10 000 — `DATASET_INJECT_ROW_CAP` in
// `backend/src/db/dataset-types.ts`, the real ceiling this notice announces. It is above the
// grouping floor in every locale, and this runtime's own locale is neither Dutch nor German, so
// "10.000" cannot appear here by accident: the pre-fix expression produces "10000" and every
// assertion below inverts on a revert.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DatasetColumn } from '$lib/types/datasets';
import { locale } from '$lib/stores/locale.svelte';
import DatasetPreviewTable from './DatasetPreviewTable.svelte';

const columns: DatasetColumn[] = [{ name: 'bedrag', type: 'number', pii: false }];
/** The real injection cap. Ten thousand rows, of which the drawer shows 50. */
const rows = Array.from({ length: 10_000 }, (_, i) => ({ bedrag: i }));

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
	// /api/me/locale, which the fail-loud fetch stub in lib/test/setup.ts would name.
	locale.current = initialLocale;
});

function render() {
	app = mount(DatasetPreviewTable, { target: host, props: { columns, rows, maxRows: 50 } });
	flushSync();
	const more = host.querySelector('.sample-more');
	expect(more, 'the truncation notice did not render — the fixture never reached it').toBeTruthy();
	return more as HTMLElement;
}

describe('the dataset preview counts its rows in the reader’s language', () => {
	it('THE DUTCH CASE: "10.000", and the raw "10000" is nowhere in the notice', () => {
		locale.current = 'nl';
		const more = render();

		expect(more.textContent).toBe('50 van 10.000 rijen getoond');
		// ⛔ The assertion that reds on a revert to `total: rows.length`: paraglide interpolates the
		// number verbatim, so the un-fixed component prints exactly this.
		expect(more.textContent).not.toContain('10000');
	});

	it('the same rows in English group with "," — the site reads the tag, it does not hard-code one', () => {
		locale.current = 'en';
		expect(render().textContent).toBe('Showing 50 of 10,000 rows');
	});

	it('and in German, Polish and French — every tag reaches the formatter, not just two', () => {
		// ⚠️ pl groups with U+00A0 NO-BREAK SPACE and fr with U+202F NARROW NO-BREAK SPACE. Both are
		// written as ESCAPES: an ASCII space here is a wrong expectation that is indistinguishable
		// from the right one on screen, and it cost this file one red run to find out.
		const NBSP = ' ';
		const NNBSP = ' ';
		for (const [tag, expected] of [
			['de', '50 von 10.000 Zeilen angezeigt'],
			['pl', `Pokazano 50 z 10${NBSP}000 wierszy`],
			['fr', `50 sur 10${NNBSP}000 lignes affichées`]
		] as const) {
			locale.current = tag;
			expect(render().textContent, `locale ${tag}`).toBe(expected);
			unmount(app!);
			app = undefined;
			host.textContent = '';
		}
	});

	it('re-groups ON THE SWITCH — the reactivity claim, driven', () => {
		// ⛔ WHY THE CALL SITE READS `locale.current` IN THE MARKUP INSTEAD OF THE HELPER IMPORTING
		// THE STORE. `locale.current` is the rune paraglide's `getLocale()` is rebound onto
		// (stores/locale.svelte.ts:125), so a number wrapped at the call site sits in the same
		// reactive graph as the sentence around it. This component fetches nothing, so nothing but
		// re-evaluation can have changed the text.
		locale.current = 'en';
		const more = render();
		expect(more.textContent).toBe('Showing 50 of 10,000 rows');

		locale.current = 'nl';
		flushSync();

		expect(more.textContent).toBe('50 van 10.000 rijen getoond');
	});
});
