// src/lib/i18n/flow-summary-label.bidi.test.ts — an Arabic or Hebrew reader gets
// `n_4f1a.text`, in that ORDER, and not `text.n_4f1a`.
//
// ⛔⛔ THE DEFECT THIS FILE EXISTS FOR was measured on the sibling vocabulary and is documented in
// full in `graph-issue-label.bidi.test.ts`: a sentence that joins two backend fields into one
// compound, with each field isolated SEPARATELY, leaves the `.` outside both isolates. Per UAX#9 an
// isolate collapses to a single NEUTRAL, so `⁨…⁩ . ⁨…⁩` is an all-neutral run inside an RTL sentence,
// resolves to the RTL base level, and the two halves SWAP. Rendering the real `ar`/`he` catalog
// strings two independent ways — `bidi-js`'s reordering, and per-character
// `Range.getBoundingClientRect()` in Chromium under `<html dir="rtl">` — agreed exactly:
//
//     no isolate at all      → `http-fetch.rows`      correct
//     isolate PER FIELD      → `rows.http-fetch`      the shipped defect
//     isolate the COMPOUND   → `http-fetch.rows`      correct
//
// TWO of the nine snapshot sentences have that exact shape — `flow_summary_connected` (two compound
// refs, `node.handle`) and `flow_summary_configured` (one, `node.key`) — so the catalogs name each
// compound as ONE placeholder (`{sourceRef}`, `{targetRef}`, `{nodeRef}`) and `flowSummaryLabel`
// joins the dot BEFORE isolating.
//
// ⛔ WHY THIS IS AN ORDER/SHAPE ASSERTION AND NOT A COUNT. A count of `⁨` codepoints PASSES the
// reversed string — per-field isolation emits the same number of pairs. That is the measured way
// this guard fails silently.
//
// ⛔ WHY IT ASSERTS ON THE SOURCE STRING RATHER THAN ON PIXELS. jsdom does no layout and cannot
// resolve bidi at all, so a jsdom mount proves nothing about order; `bidi-js` exists in
// node_modules only as a TRANSITIVE dependency of jsdom, so importing it would make this file red on
// an unrelated jsdom bump. What is asserted instead is the property the measurement identified as
// the cause: the compound must live inside ONE FSI…PDI pair. Under UAX#9 the text between an isolate
// initiator and its matching PDI is resolved independently and rendered as a unit at the surrounding
// level, so an unbroken isolate FIXES the internal order — a theorem about the algorithm, not a
// heuristic. Both the required shape and the forbidden one are asserted, by name.
//
// ⛔ NOTHING IS MOCKED. The REAL compiled paraglide catalogs are driven through `overwriteGetLocale`,
// the same lever `$lib/stores/locale.svelte.ts` pulls in the running app. The panel render test
// mocks the message module (deliberately — it is asserting WHICH key resolved) and the contract test
// reads the JSON on disk; only this file exercises the SHIPPED artifact. A locale that re-split the
// compound during translation would be invisible to both of the others in one direction or another.
import { describe, it, expect, afterEach } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import { flowSummaryLabel } from './flow-summary-label';

/** FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE — what `<bdi>` compiles down to. */
const FSI = '⁨';
const PDI = '⁩';

const SOURCE_REF = 'n_4f1a.text';
const TARGET_REF = 'n_9c02.prompt';
const NODE_REF = 'n_9c02.model';

const CONNECTED = {
	summary: 'connected n_4f1a.text → n_9c02.prompt',
	summary_code: 'flow_summary_connected',
	summary_params: {
		source: 'n_4f1a',
		sourceHandle: 'text',
		target: 'n_9c02',
		targetHandle: 'prompt'
	}
};
const CONFIGURED = {
	summary: 'configured n_9c02.model',
	summary_code: 'flow_summary_configured',
	summary_params: { nodeId: 'n_9c02', key: 'model' }
};

/** Every locale the catalogs ship, RTL first — the property must hold in all eight. */
const LOCALES = ['ar', 'he', 'en', 'nl', 'de', 'es', 'fr', 'pl'] as const;
const RTL = ['ar', 'he'] as const;

afterEach(() => overwriteGetLocale(() => 'en'));

describe('the `node.handle` compound survives an RTL sentence', () => {
	it('the fixture really reaches the catalog — not the English fallback', () => {
		// ⛔ NON-VACUITY, FIRST. Every assertion below is "the rendered string contains X". If
		// `flowSummaryLabel` took its fallback branch (a missing param), it would return
		// `summary` — which contains `n_4f1a.text` verbatim and would satisfy the positive half of
		// every case here while proving nothing at all about the catalog.
		overwriteGetLocale(() => 'ar');
		const out = flowSummaryLabel(CONNECTED, 'ar');
		expect(out, 'flowSummaryLabel fell back to the English summary').not.toBe(CONNECTED.summary);
		expect(out).not.toContain('connected ');
		// …and it really is the Arabic pattern, not the English one.
		expect(out).toContain('تم توصيل');
		expect(out).toContain(FSI);
	});

	it('⛔ each compound is ONE isolate — the dot never sits between two of them', () => {
		for (const locale of LOCALES) {
			overwriteGetLocale(() => locale);
			const connected = flowSummaryLabel(CONNECTED, locale);
			const configured = flowSummaryLabel(CONFIGURED, locale);
			// THE POSITIVE HALF: every compound present, in order, wrapped as a single unit.
			expect(connected, `${locale}: source ref is not one isolate`).toContain(
				`${FSI}${SOURCE_REF}${PDI}`
			);
			expect(connected, `${locale}: target ref is not one isolate`).toContain(
				`${FSI}${TARGET_REF}${PDI}`
			);
			expect(configured, `${locale}: node ref is not one isolate`).toContain(
				`${FSI}${NODE_REF}${PDI}`
			);
			// THE DEFECT, BY NAME: `⁨n_4f1a⁩.⁨text⁩` — a PDI, the dot, then an FSI. This is what
			// reverses to `text.n_4f1a` for an ar/he reader.
			expect(connected, `${locale}: a compound is split across two isolates`).not.toMatch(
				/⁩\s*\.\s*⁨/
			);
			expect(configured, `${locale}: the compound is split across two isolates`).not.toMatch(
				/⁩\s*\.\s*⁨/
			);
		}
	});

	it('⛔ and with the isolates stripped the ar/he sentence still reads source THEN target', () => {
		// The logical-order half, stated as an ORDER and not as a presence. Per-field isolation
		// leaves the logical order intact and only the RESOLVED order wrong, so this case alone
		// would not catch the defect — which is why it sits beside the isolate-shape case above
		// rather than replacing it.
		for (const locale of RTL) {
			overwriteGetLocale(() => locale);
			const bare = flowSummaryLabel(CONNECTED, locale).replaceAll(FSI, '').replaceAll(PDI, '');
			expect(bare, `${locale}`).toContain(SOURCE_REF);
			expect(bare, `${locale}`).toContain(TARGET_REF);
			expect(bare.indexOf('n_4f1a')).toBeLessThan(bare.indexOf('text'));
			expect(bare.indexOf(SOURCE_REF)).toBeLessThan(bare.indexOf(TARGET_REF));
		}
	});

	it('⛔ the ARROW is the catalog’s, and ar/he chose the mirrored one', () => {
		// The `→` is punctuation inside a sentence that has to mirror. Concatenating it in the label
		// module would have hard-coded an LTR arrow into an RTL sentence; putting it in the catalog
		// is what lets ar/he render `←`, and this is the assertion that says they took the option.
		for (const locale of LOCALES) {
			overwriteGetLocale(() => locale);
			const out = flowSummaryLabel(CONNECTED, locale);
			expect(out, `${locale} lost its direction marker`).toMatch(/→|←/);
		}
		for (const locale of RTL) {
			overwriteGetLocale(() => locale);
			const out = flowSummaryLabel(CONNECTED, locale);
			expect(out, `${locale} kept the LTR arrow`).toContain('←');
			expect(out, `${locale} kept the LTR arrow`).not.toContain('→');
		}
		// …and the LTR locales did NOT mirror it, or the assertion above would be trivially true.
		for (const locale of ['en', 'nl', 'de', 'es', 'fr', 'pl'] as const) {
			overwriteGetLocale(() => locale);
			expect(flowSummaryLabel(CONNECTED, locale)).toContain('→');
		}
	});

	it('every catalog names the compound as ONE placeholder, so no locale can re-split it', () => {
		// ⛔ THE HALF A TRANSLATOR COULD UNDO. `flowSummaryLabel` passes `{sourceRef}`; a locale that
		// went back to `{source}.{sourceHandle}` would render the placeholders as literal text or
		// drop them, and only THIS assertion would say which locale. Driven through the compiled
		// message, so it is the shipped artifact being checked, not the JSON on disk.
		for (const locale of LOCALES) {
			overwriteGetLocale(() => locale);
			const connected = m.flow_summary_connected({ sourceRef: 'S', targetRef: 'D' });
			expect(connected, `${locale} lost {sourceRef}`).toContain('S');
			expect(connected, `${locale} lost {targetRef}`).toContain('D');
			expect(connected, `${locale} still names {source}`).not.toContain('{source}');
			expect(connected, `${locale} still names {sourceHandle}`).not.toContain('{sourceHandle}');
			expect(connected, `${locale} re-split the compound`).not.toContain('S.');

			const configured = m.flow_summary_configured({ nodeRef: 'N' });
			expect(configured, `${locale} lost {nodeRef}`).toContain('N');
			expect(configured, `${locale} still names {key}`).not.toContain('{key}');
			expect(configured, `${locale} re-split the compound`).not.toContain('N.');
		}
	});

	it('⚠️ `inserted` keeps TWO separate isolates, and its operands stay separated by WORDS', () => {
		// The deliberate NON-compound. `{slug}` and `{edgeId}` are two operands of one sentence, not
		// one token — a strong directional run between two isolates fixes their order, so they must
		// NOT be joined. The property that makes that safe is that no catalog places them adjacent
		// with only neutrals between: this asserts exactly that, per locale.
		for (const locale of LOCALES) {
			overwriteGetLocale(() => locale);
			const out = flowSummaryLabel(
				{
					summary: 'inserted ai-summarize into edge e_11',
					summary_code: 'flow_summary_inserted',
					summary_params: { slug: 'ai-summarize', edgeId: 'e_11' }
				},
				locale
			);
			expect(out, `${locale}: slug lost its isolate`).toContain(`${FSI}ai-summarize${PDI}`);
			expect(out, `${locale}: edgeId lost its isolate`).toContain(`${FSI}e_11${PDI}`);
			// ⛔ THE PROPERTY THAT KEEPS TWO ISOLATES SAFE: between the two there is at least one
			// non-space, non-punctuation character — a real WORD, which is directionally strong in
			// its own script. A catalog that shortened this to `⁨slug⁩ ⁨edge⁩` would reintroduce the
			// neutral-run reversal without any dot being involved.
			const between = out.slice(out.indexOf(PDI) + 1, out.lastIndexOf(FSI));
			expect(between.trim(), `${locale}: nothing but neutrals separates the two isolates`).toMatch(
				/\p{L}/u
			);
		}
	});
});
