// src/lib/i18n/graph-issue-label.bidi.test.ts — an Arabic or Hebrew reader gets
// `“http-fetch.rows”`, in that ORDER, and not `“rows.http-fetch”`.
//
// ⛔⛔ THE DEFECT THIS FILE EXISTS FOR, MEASURED. `graph_issue_incompatible_handle_type` is the only
// one of the twelve sentences whose pattern joins two backend fields into one compound. It used to
// read `“{sourceNode}.{sourceHandle}”` and `graphIssueLabel` isolated each field SEPARATELY, which
// left the `.` and the quotation marks outside both isolates. Per UAX#9 an isolate collapses to a
// single NEUTRAL, so `« ⁨…⁩ . ⁨…⁩ »` is an all-neutral run between two RTL runs, resolves to the
// RTL base level, and the two halves SWAP. Rendering the real `ar`/`he` catalog strings two
// independent ways — `bidi-js`'s reordering, and per-character `Range.getBoundingClientRect()` in
// Chromium under `<html dir="rtl">` — agreed exactly:
//
//     no isolate at all      → “… »http-fetch.rows«”      correct
//     isolate PER FIELD      → “… »rows.http-fetch«”      ← what the branch shipped
//     isolate the COMPOUND   → “… »http-fetch.rows«”      correct
//
// So the isolate has to wrap the whole compound, dot included, which is why the catalogs name it as
// ONE placeholder (`{source}` / `{target}`).
//
// ⛔ WHY THIS IS AN ORDER ASSERTION AND NOT A COUNT. `graph-issue-label.test.ts` already counted
// isolate codepoints — `expect([...out].filter(c => c === '⁨')).toHaveLength(6)` — and PASSED on the
// reversed string, because per-field isolation emits six pairs too. Counting cannot see order. And
// `build-page.graph-issues.render.test.ts` is nl-only, so no ar/he text was rendered anywhere on the
// branch.
//
// ⛔ WHY IT ASSERTS ON THE SOURCE STRING RATHER THAN ON PIXELS. jsdom does no layout and cannot
// resolve bidi at all, so a jsdom mount proves nothing about order; `bidi-js` is present in
// node_modules only as a TRANSITIVE dependency of jsdom, so importing it would make this file red on
// an unrelated jsdom bump. What is asserted instead is the property the measurement identified as
// the cause: the compound must live inside ONE FSI…PDI pair. Under UAX#9 the text between an isolate
// initiator and its matching PDI is resolved independently and rendered as a unit at the surrounding
// level, so an unbroken isolate FIXES the internal order — that is a theorem about the algorithm,
// not a heuristic. Both the required shape and the forbidden one are asserted, by name.
//
// ⛔ NOTHING IS MOCKED. The REAL compiled paraglide catalogs are driven through `overwriteGetLocale`,
// the same lever `$lib/stores/locale.svelte.ts` pulls in the running app — a catalog that reverts to
// `“{sourceNode}.{sourceHandle}”` in one of the eight locales must red here, and a mocked message
// could not see that.
import { describe, it, expect, afterEach } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import { graphIssueLabel } from './graph-issue-label';
import type { GraphIssue } from '$lib/types/flows';

/** FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE — what `<bdi>` compiles down to. */
const FSI = '⁨';
const PDI = '⁩';

const SOURCE_COMPOUND = 'http-fetch.rows';
const TARGET_COMPOUND = 'llm-summarize.prompt';

const ISSUE: GraphIssue = {
	rule: 'incompatible-handle-type',
	message: "Edge e1: 'http-fetch.rows' (json) cannot feed 'llm-summarize.prompt' (string)",
	ref: 'e1',
	detail: {
		sourceNode: 'http-fetch',
		sourceHandle: 'rows',
		sourceType: 'json',
		targetNode: 'llm-summarize',
		targetHandle: 'prompt',
		targetType: 'string'
	}
};

/** Every locale the catalogs ship, RTL first — the property must hold in all eight. */
const LOCALES = ['ar', 'he', 'en', 'nl', 'de', 'es', 'fr', 'pl'] as const;
const RTL = ['ar', 'he'] as const;

afterEach(() => overwriteGetLocale(() => 'en'));

describe('the `slug.handle` compound survives an RTL sentence', () => {
	it('the fixture really reaches the catalog — not the English fallback', () => {
		// ⛔ NON-VACUITY, FIRST. Every assertion below is "the rendered string contains X". If
		// `graphIssueLabel` took its mid-roll branch (a missing `detail` field), it would return
		// `issue.message` — which contains `http-fetch.rows` verbatim and would satisfy the positive
		// half of every case here while proving nothing at all about the catalog.
		overwriteGetLocale(() => 'ar');
		const out = graphIssueLabel(ISSUE);
		expect(out, 'graphIssueLabel fell back to the English message').not.toBe(ISSUE.message);
		expect(out).not.toContain('cannot feed');
		// …and it really is the Arabic pattern, not the English one.
		expect(out).toContain('يعطي');
		expect(out).toContain(FSI);
	});

	it('⛔ the compound is ONE isolate — the dot never sits between two of them', () => {
		for (const locale of LOCALES) {
			overwriteGetLocale(() => locale);
			const out = graphIssueLabel(ISSUE);
			// THE POSITIVE HALF: both compounds present, in order, wrapped as a single unit.
			expect(out, `${locale}: source compound is not one isolate`).toContain(
				`${FSI}${SOURCE_COMPOUND}${PDI}`
			);
			expect(out, `${locale}: target compound is not one isolate`).toContain(
				`${FSI}${TARGET_COMPOUND}${PDI}`
			);
			// THE DEFECT, BY NAME: `⁨http-fetch⁩.⁨rows⁩` — a PDI, the dot, then an FSI. This is what
			// reverses to `rows.http-fetch` for an ar/he reader.
			expect(out, `${locale}: the compound is split across two isolates`).not.toMatch(
				/⁩\s*\.\s*⁨/
			);
		}
	});

	it('⛔ and with the isolates stripped the ar/he sentence still reads source THEN target', () => {
		// The logical-order half, stated as an ORDER and not as a presence. `http-fetch` must precede
		// `rows`, and the whole source compound must precede the target compound, in the RTL locales
		// where the reversal was measured. Per-field isolation leaves the logical order intact and
		// only the RESOLVED order wrong, so this case alone would not catch it — which is why it sits
		// beside the isolate-shape case above rather than replacing it.
		for (const locale of RTL) {
			overwriteGetLocale(() => locale);
			const bare = graphIssueLabel(ISSUE).replaceAll(FSI, '').replaceAll(PDI, '');
			expect(bare, `${locale}`).toContain(SOURCE_COMPOUND);
			expect(bare, `${locale}`).toContain(TARGET_COMPOUND);
			expect(bare.indexOf('http-fetch')).toBeLessThan(bare.indexOf('rows'));
			expect(bare.indexOf(SOURCE_COMPOUND)).toBeLessThan(bare.indexOf(TARGET_COMPOUND));
		}
	});

	it('every catalog names the compound as ONE placeholder, so no locale can re-split it', () => {
		// ⛔ THE HALF A TRANSLATOR COULD UNDO. `graphIssueLabel` passes `{source}`; a locale that
		// went back to `“{sourceNode}.{sourceHandle}”` would render the placeholders as literal text
		// or drop them, and only THIS assertion would say which locale. Driven through the compiled
		// message, so it is the shipped artifact being checked, not the JSON on disk.
		for (const locale of LOCALES) {
			overwriteGetLocale(() => locale);
			const probe = m.graph_issue_incompatible_handle_type({
				source: 'S',
				sourceType: 'T1',
				target: 'D',
				targetType: 'T2'
			});
			expect(probe, `${locale} lost {source}`).toContain('S');
			expect(probe, `${locale} lost {target}`).toContain('D');
			expect(probe, `${locale} still names {sourceNode}`).not.toContain('{sourceNode}');
			expect(probe, `${locale} still names {sourceHandle}`).not.toContain('{sourceHandle}');
			expect(probe, `${locale} re-split the compound`).not.toContain('S.');
		}
	});
});
