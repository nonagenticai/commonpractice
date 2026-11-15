// @vitest-environment jsdom
//
// src/routes/(tenant)/llm-settings/llm-settings.temperature-locale.render.test.ts — the status
// panel's one bare number is punctuated in the READER's language, not the developer's.
//
// ⛔ THE DEFECT. The panel read `<b class="mono">{temperature ?? '—'}</b>`. `temperature` is a
// `number`, so Svelte interpolates `String(0.1)` — an EN-US decimal point, hard-coded, on the one
// figure this panel exists to confirm. In Dutch (and de/fr/es/pl) '.' is the THOUSANDS separator,
// so "0.1" is not merely foreign-looking; it is the wrong glyph doing a different job, in a row
// whose label and whose every neighbouring figure (the budget card above, three `usd(…,
// locale.current)` calls) were already the reader's.
//
// ⛔ WHY THIS IS A RENDER TEST AND NOT A `num()` UNIT TEST. `num()` was never broken —
// format.ts has its own suite and its header block documents this exact class at length. What was
// broken is that this call site did not USE it, and the only artifact that can witness that is the
// mounted page. The assertions below are on `.status-card` text.
//
// ⛔⛔ AND THE FIRST FIX FOR IT WAS ITSELF WRONG, WHICH IS THE MORE INTERESTING HALF OF THIS FILE.
// The line was changed to `num(temperature, locale.current)` on the stated ground that `num()`
// "echoes exactly what the field holds". It does not: `num()` is `toLocaleString`, default
// `maximumFractionDigits: 3`. Measured with the harness below, against that very commit:
//
//     temperature 0.0001    renders "0"        temperature 0.999999    renders "1"
//
// `backend/src/routes/llm-settings.ts` is `z.number().min(0).max(2)` — NO decimal bound — so both
// values are accepted and stored in a `real` column, and the `<input type="number">` beside this
// panel shows the raw figure while the panel showed a rounded one. A set value reported as unset,
// and a saved value reported as a different one; "0" additionally collides with this file's own
// "ABSENCE IS STILL ABSENCE … not '0'" invariant at the bottom. The site now calls `exact()`
// (21 significant digits — every double, exactly, with the reader's separator; see its header in
// `$lib/utils/format.ts` for why `maximumFractionDigits: 20` is NOT enough).
//
// ⚠️ NON-VACUITY. `0.1` is BELOW every grouping floor, so the two spellings differ in exactly one
// character and only a locale-aware formatter can produce the Dutch one — the test runtime is not
// Dutch, so "0,1" cannot appear here by accident. Both halves are asserted in every case: the
// right string is PRESENT and the interpolated-`String()` one is ABSENT. And `render()` refuses to
// return while the page is still on `llmset_loading`, so an assertion can never pass against a
// page that rendered nothing.
//
// REVERTS THAT TURN THIS RED (both measured): restore `{temperature ?? '—'}` at the status row
// (reds the locale cases); or put `num(...)` back in place of `exact(...)` (reds 0.0001 / 0.999999).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { locale } from '$lib/stores/locale.svelte';

// The real `en` catalog, each key resolving to its own name — nothing here asserts on wording, and
// a key the page invents but never adds fails loudly instead of rendering blank.
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

const { get, catalog } = vi.hoisted(() => ({ get: vi.fn(), catalog: vi.fn() }));
// ⛔ ALIAS ids, never relative ones — see the long note in $lib/api/llm-settings.test.ts.
vi.mock('$lib/api/llm-settings', () => ({
	llmSettingsApi: { get, catalog, update: vi.fn(), test: vi.fn() },
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
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

let target: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;
const initialLocale = locale.current;

/** Mount the page with `temperature` already saved, in the given app locale. */
async function render(temperature: number | null, tag: typeof locale.current): Promise<HTMLElement> {
	// ⚠️ Assigned directly, never through `locale.set()`: that method fires an authFetch PATCH to
	// /api/me/locale, which this file has no business doing and lib/test/setup.ts would name.
	locale.current = tag;
	catalog.mockResolvedValue({ providers: [] });
	get.mockResolvedValue({
		configured: true,
		preset: 'local',
		model: 'qwen3-30b',
		baseUrl: '',
		temperature,
		params: {},
		hasKey: false,
		budget: null
	});
	target = document.createElement('div');
	document.body.appendChild(target);
	component = mount(Page, { target }) as Record<string, unknown>;
	for (let i = 0; i < 20 && target.textContent?.includes('llmset_loading') !== false; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	expect(
		target.textContent,
		'the page never left its loading state — the fixture did not land, so nothing below is a proof'
	).not.toContain('llmset_loading');
	return target;
}

/** The status panel only — the form's `<input type="number">` holds the raw value by design
 *  (it is what gets PUT back), and asserting over the whole page would read it too. */
const statusText = (el: HTMLElement) => el.querySelector('.status-card')!.textContent ?? '';

afterEach(() => {
	if (component) unmount(component);
	component = null;
	target?.remove();
	target = null;
	locale.current = initialLocale;
	get.mockReset();
	catalog.mockReset();
});

describe('the temperature the status panel reports', () => {
	it('THE DUTCH DEMO: 0.1 renders "0,1", and the developer\'s "0.1" is not in the panel', async () => {
		const el = await render(0.1, 'nl');
		expect(statusText(el)).toContain('0,1');
		// ⛔ The inverse assertion is the one that reds on a revert: `String(0.1)` is exactly this.
		expect(statusText(el)).not.toContain('0.1');
	});

	it('and English still reads "0.1" — this is a locale fix, not a comma fix', async () => {
		const el = await render(0.1, 'en');
		expect(statusText(el)).toContain('0.1');
		expect(statusText(el)).not.toContain('0,1');
	});

	it('French, which also writes the decimal comma, agrees with Dutch', async () => {
		const el = await render(0.7, 'fr');
		expect(statusText(el)).toContain('0,7');
		expect(statusText(el)).not.toContain('0.7');
	});

	it('a whole value is echoed as typed — "1", never "1,0"', async () => {
		// ⚠️ THE OVER-CORRECTION GUARD, and the reason this row uses `num()` rather than
		// `decimal1()`. The field beside it renders `1`; a status panel answering "1,0" to it would
		// be a second, quieter version of the same defect — the panel reporting something other
		// than the setting it is confirming.
		const el = await render(1, 'nl');
		expect(statusText(el)).toContain('1');
		expect(statusText(el)).not.toContain('1,0');
	});

	it('⛔ 0.0001 IS NOT "0" — a set value reported as unset', async () => {
		// ⛔ THE SECOND DEFECT ON THIS LINE, and it shipped inside the fix for the first one.
		// `num()` is `toLocaleString`, whose default `maximumFractionDigits` is 3. Measured with
		// this harness against the committed page: 0.0001 rendered "0". The backend accepts it —
		// `backend/src/routes/llm-settings.ts` is `z.number().min(0).max(2)`, no decimal bound —
		// so the `<input type="number">` two panes away showed "0.0001" while this panel said "0".
		// It also collides head-on with the em-dash invariant asserted below: "0" is precisely the
		// glyph that file forbids for a temperature that is not set, and here it was being printed
		// for one that IS.
		//
		// REVERT THAT TURNS THIS RED (measured): `exact(...)` → `num(...)` at the status row.
		const el = await render(0.0001, 'nl');
		expect(statusText(el), 'a set temperature was rounded away to "0"').toContain('0,0001');
		// The inverse, which is what `num()` produced. `\b0\b` rather than '0': "0,0001" contains a
		// literal '0', so a bare substring check would pass against the very output being rejected.
		expect(statusText(el), 'the panel still reports a bare 0 for a set value').not.toMatch(
			/(?<![\d,.])0(?![\d,.])/
		);
		// …and the developer's punctuation is still absent, i.e. the first fix is intact.
		expect(statusText(el)).not.toContain('0.0001');
	});

	it('⛔ 0.999999 IS NOT "1" — a saved value reported as a different one', async () => {
		// The same rounding, in the direction that is harder to notice: the panel confirms a
		// temperature the workspace does not have, and "1" is a perfectly plausible setting, so
		// nothing about the screen looks wrong. Measured "1" against the committed page.
		const el = await render(0.999999, 'nl');
		expect(statusText(el), '0.999999 was rounded up to a different setting').toContain(
			'0,999999'
		);
		expect(statusText(el), 'the panel reports a whole 1 for a fractional setting').not.toMatch(
			/(?<![\d,.])1(?![\d,.])/
		);
		expect(statusText(el)).not.toContain('0.999999');
	});

	it('and English is exact too — this is a rounding fix, not a comma fix', async () => {
		// The over-correction guard for the pair above: the en spelling must gain the digits without
		// gaining a comma. Both halves, because "0,999999" would satisfy "not rounded" and be wrong.
		const el = await render(0.999999, 'en');
		expect(statusText(el)).toContain('0.999999');
		expect(statusText(el)).not.toContain('0,999999');
	});

	it('ABSENCE IS STILL ABSENCE: a null temperature renders the em dash, not "0"', async () => {
		// The `?? '—'` branch must survive the change. `num(null)` would have been the trap here:
		// a formatter that turns "not set" into a figure invents a setting.
		const el = await render(null, 'nl');
		expect(statusText(el)).toContain('—');
		expect(statusText(el)).not.toMatch(/\b0\b/);
	});
});
