// @vitest-environment jsdom
//
// src/lib/components/block-edit/block-result-view.error-message.render.test.ts — the failure
// SENTENCE on /block-edit, in Dutch, against the REAL catalogs.
//
// ⛔ THE DEFECT. `block-result-view.error-kind.render.test.ts` localized the coral PILL and then
// asserted, one test down, that "the author's own error message is passed through UNTRANSLATED".
// That is right for an author's `throw`, and it was applied to the whole field — so a Dutch author
// whose test failed on a DESCRIPTOR check read:
//
//     [ VALIDATIE ]  Fout
//     De uitvoer van het blok komt niet overeen met…              ← the hint, Dutch
//     output does not match the declared descriptor: 'doubled' must be a finite number
//                                                                 ← the sentence, English
//
// The line that says WHAT IS WRONG was the only English on the panel, and it is composed by
// `backend/src/blocks/test-runner.ts` + `backend/src/exec/descriptor.ts` at a known site, from
// known machine tokens. The wire keeps the English (`run_block_test` ships it to an LLM, and "Fix
// with AI" seeds a prompt with it) and now ALSO carries `rule` + `detail`; the browser owns the
// words.
//
// ⛔ NOTHING IS MOCKED. The component is pure — props in, markup out — so what a reader sees is
// entirely a function of the props and the locale. That also means these assertions are driven by
// the REAL `nl.json`: a key missing from a catalog reds here rather than in a stub.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { locale } from '$lib/stores/locale.svelte';
import * as m from '$lib/paraglide/messages';
import BlockResultView from './BlockResultView.svelte';

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
	// Assigned directly, never via `locale.set()` — that PATCHes /api/me/locale, which the fail-loud
	// fetch stub in lib/test/setup.ts would name.
	locale.current = initialLocale;
});

function render(props: Record<string, unknown>): string {
	app = mount(BlockResultView, {
		target: host,
		props: { status: 'fail', ...props } as never
	});
	flushSync();
	// ⛔ THE POSITIVE ANCHOR. `.err-msg` lives inside `{#if errorMessage}`; a component that rendered
	// nothing would satisfy every "the English is gone" assertion below for free.
	const el = host.querySelector('.err-msg');
	expect(el, 'the error message never rendered — the fixture reached nothing').not.toBeNull();
	return el!.textContent ?? '';
}

/** The bidi isolate the label module wraps every readable token in (U+2068 … U+2069). */
const iso = (v: string) => `⁨${v}⁩`;

describe('the /block-edit failure sentence is the reader’s language', () => {
	it('⛔ THE DUTCH CASE: a descriptor refusal reads from the catalog, not the backend English', () => {
		locale.current = 'nl';
		const ENGLISH = "'doubled' must be a finite number";
		const text = render({
			errorKind: 'validation',
			errorMessage: ENGLISH,
			errorRule: 'field_must_be_number',
			errorDetail: { field: 'doubled' }
		});
		expect(text).toBe(m.blockerr_field_must_be_number({ field: iso('doubled') }));
		// REVERT THAT TURNS THIS RED: render `{errorMessage}` again.
		expect(text, 'the backend English is still on screen').not.toBe(ENGLISH);
		expect(text).not.toContain('must be a finite number');
		// The port name is an IDENTIFIER and survives verbatim inside its isolate.
		expect(text).toContain('doubled');
	});

	it('⛔ THE ENUM JOIN: `options` is a list, joined by Intl.ListFormat in the reader’s language', () => {
		// The backend cannot join this — "[a, b, c]" is an English list. It ships the ARRAY.
		locale.current = 'nl';
		const text = render({
			errorMessage: "'mode' must be one of [fast, slow, off]",
			errorRule: 'field_must_be_one_of',
			errorDetail: { field: 'mode', options: ['fast', 'slow', 'off'] }
		});
		expect(text).toContain('fast');
		expect(text).toContain('off');
		// `nl` disjunction is "fast, slow of off" — the Dutch "of", never the English "or", and never
		// the raw `[a, b, c]` bracket form the backend composed.
		expect(text).toContain(' of ');
		expect(text).not.toContain('[fast, slow, off]');
		expect(text).not.toContain(' or ');
	});

	it('⛔ THE JOINED-ERRORS SITE: a conformance failure RECURSES into its per-field issues', () => {
		// `conform.errors.join('; ')` was unrecoverable — a joined English string has no seam a
		// client can localize. The wire now carries `detail.issues`, each a full `{rule, message,
		// detail}` triple, and the label function calls itself.
		locale.current = 'nl';
		const text = render({
			errorMessage:
				"output does not match the declared descriptor: 'doubled' must be a finite number; " +
				"missing required output 'summary'",
			errorRule: 'test_output_not_conformant',
			errorDetail: {
				issues: [
					{
						rule: 'field_must_be_number',
						message: "'doubled' must be a finite number",
						detail: { field: 'doubled' }
					},
					{
						rule: 'output_missing_required',
						message: "missing required output 'summary'",
						detail: { field: 'summary' }
					}
				]
			}
		});
		expect(text).toContain(m.blockerr_field_must_be_number({ field: iso('doubled') }));
		expect(text).toContain(m.blockerr_output_missing_required({ field: iso('summary') }));
		expect(text).not.toContain('must be a finite number');
		expect(text).not.toContain('missing required output');
	});

	it('⛔ THE CONCATENATION SITE: the product half localizes, the `cause` stays RAW', () => {
		// `${error.kind}: ${error.error}` glued PRODUCT English onto ARBITRARY author text. They are
		// split now: the kind goes through the shared `errorKindLabel`, the sentence through the
		// catalog, and the author's own words ride along in `detail.cause`, untouched.
		locale.current = 'nl';
		const text = render({
			errorMessage: 'block_throw: mijn eigen fout',
			errorRule: 'test_block_errored',
			errorDetail: { actualKind: 'block_throw', cause: 'mijn eigen fout' }
		});
		expect(text).toContain('mijn eigen fout');
		// The KIND word is Dutch, from the family the pill already uses — not the raw enum.
		expect(text).toContain(m.console_error_kind_block_throw());
		expect(text).not.toContain('block_throw:');
	});

	it('⛔⛔ THE CRUX: with NO rule the author’s own words render RAW, byte for byte', () => {
		locale.current = 'nl';
		const text = render({ errorKind: 'block_throw', errorMessage: 'mijn eigen fout' });
		expect(text).toBe('mijn eigen fout');
	});

	it('a known rule with an INCOMPLETE detail bag keeps the English (the mid-roll branch)', () => {
		locale.current = 'nl';
		const ENGLISH = "'doubled' must be a finite number";
		const text = render({
			errorMessage: ENGLISH,
			errorRule: 'field_must_be_number',
			errorDetail: {}
		});
		expect(text).toBe(ENGLISH);
		expect(text).not.toContain('undefined');
	});

	it('an ARCHIVED result — rule and detail both absent — still renders its message', () => {
		// `block_test_results.error_rule` is nullable with NO backfill: every result row written
		// before migration 0072 has it NULL forever. This is not a transitional branch.
		locale.current = 'nl';
		const text = render({ errorMessage: 'output did not match expected' });
		expect(text).toBe('output did not match expected');
	});

	it('…and in ENGLISH the catalog still wins, so the base locale is not a silent passthrough', () => {
		locale.current = 'en';
		const text = render({
			errorMessage: "'doubled' must be a finite number",
			errorRule: 'field_must_be_number',
			errorDetail: { field: 'doubled' }
		});
		expect(text).toBe(m.blockerr_field_must_be_number({ field: iso('doubled') }));
	});
});
