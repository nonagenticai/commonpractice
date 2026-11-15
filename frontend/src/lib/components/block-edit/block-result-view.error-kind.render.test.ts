// @vitest-environment jsdom
//
// src/lib/components/block-edit/block-result-view.error-kind.render.test.ts — the failure pill on a
// block run says WHY in the reader's language, in the same words the run console uses.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. A Dutch author simulates a block that throws and reads:
//
//     [ BLOCK_THROW ]  Fout                                       ← the pill, raw + CSS-uppercased
//     De code van het blok gooide een fout tijdens het uitvoeren…  ← the explanation, fully Dutch
//
// one on top of the other, from one component. `<span class="kind">{errorKind}</span>` with
// `.kind { text-transform: uppercase }`, directly above `blockresult_errkind_block_throw`.
//
// ⛔ AND THE MAPPING ALREADY EXISTED — this is a DUPLICATION defect, not a missing-key one. Nine
// `console_error_kind_*` keys have been in all eight catalogs since the run console shipped, reached
// by a private `errorKindLabel` switch inside `lib/components/build/RunConsole.svelte`. Same enum,
// same product, two components: one localized it, the other had no mechanism at all. The fix moved
// that switch to `$lib/i18n/error-kind-label.ts` and imported it in both, rather than writing a
// second one — see that module's header for why a second mechanism IS the defect.
//
// ⚠️ TWO KEY FAMILIES, AND CONFLATING THEM IS THE TRAP. This component already imports
// `blockresult_errkind_*` for the hint UNDER the pill; those are PARAGRAPHS. `console_error_kind_*`
// are the SHORT NAMES. Both are asserted below, and asserted to be DIFFERENT STRINGS, because
// "reuse the key that is already imported" is the natural shortcut and it puts a sentence inside a
// 10.5px badge.
//
// ⛔ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED. The component is pure — props in, markup out, no
// data loading — so what a reader sees is entirely a function of the props and the locale.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ErrorKind } from '$lib/types/trace';
import { locale } from '$lib/stores/locale.svelte';
import * as m from '$lib/paraglide/messages';
import BlockResultView from './BlockResultView.svelte';

/**
 * Every kind this component can be handed.
 *
 * ⚠️ MEASURED, NOT ASSUMED. `BlockResultView` takes `errorKind` from exactly one caller —
 * `BlockSimulate.svelte:225`, `errorKind={result.error?.kind ?? null}` — whose type is
 * `{ kind: ErrorKind; message: string } | null` (`$lib/types/blocks.ts:231`). `BlockTesting` passes
 * none at all. So the reachable set is precisely `ErrorKind`, all nine members, and every one of
 * them must map or the pill falls back to the English token this file exists to remove.
 */
const KINDS: ErrorKind[] = [
	'timeout',
	'validation',
	'block_throw',
	'network_blocked',
	'llm_capped',
	'model_not_allowed',
	'budget_exhausted',
	'flow_error',
	'internal'
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
	// Assigned directly, never via `locale.set()` — that PATCHes /api/me/locale, which the fail-loud
	// fetch stub in lib/test/setup.ts would name.
	locale.current = initialLocale;
});

function render(errorKind: ErrorKind | string, errorMessage = "Cannot read property 'id' of undefined") {
	app = mount(BlockResultView, {
		target: host,
		props: { status: 'error', errorKind: errorKind as ErrorKind, errorMessage } as never
	});
	flushSync();
	// ⛔ THE POSITIVE ANCHOR. The pill lives inside `{#if errorKind}`; a component that rendered
	// nothing would make every "the raw enum is gone" assertion below pass for free.
	const pill = host.querySelector('.kind');
	expect(pill, 'the error pill never rendered — the fixture reached nothing').not.toBeNull();
	return pill as HTMLElement;
}

describe('the /block-edit failure pill names the error kind in the reader’s language', () => {
	it('⛔ THE DUTCH CASE: a thrown block reads "blokfout", never "block_throw"', () => {
		locale.current = 'nl';
		const pill = render('block_throw');

		expect(pill.textContent).toBe('blokfout');
		// ⛔ THE ASSERTION THAT INVERTS ON A REVERT TO `{errorKind}`. `.kind` is uppercased in CSS,
		// not in the DOM, so the pre-fix text node is the raw enum exactly as written here.
		expect(pill.textContent).not.toBe('block_throw');
		expect(host.textContent, 'the raw enum is still on screen').not.toContain('block_throw');
	});

	it('…and the PARAGRAPH under it is still the other key family, still Dutch, still different', () => {
		// A "fix" that reused `blockresult_errkind_block_throw` for the pill would satisfy the
		// negative above and put a two-line sentence inside a 10.5px uppercase badge.
		locale.current = 'nl';
		const pill = render('block_throw');
		const hint = host.querySelector('.err-hint')!;
		expect(hint.textContent).toBe(m.blockresult_errkind_block_throw());
		expect(hint.textContent).not.toBe(pill.textContent);
		expect(hint.textContent!.length).toBeGreaterThan(pill.textContent!.length * 3);
	});

	it('the author’s own error message is passed through UNTRANSLATED, beside the localized pill', () => {
		// `errorMessage` is arbitrary text a block author wrote; there is nothing to localize it
		// FROM, and the run console makes the same call. Asserted so the fix does not spread.
		locale.current = 'nl';
		render('block_throw');
		expect(host.querySelector('.err-msg')!.textContent).toBe(
			"Cannot read property 'id' of undefined"
		);
	});

	it('⛔ EVERY ONE OF THE NINE KINDS RESOLVES — none falls through to its raw enum', () => {
		locale.current = 'nl';
		const seen: string[] = [];
		for (const kind of KINDS) {
			const text = render(kind).textContent ?? '';
			expect(text, `${kind} rendered its raw enum`).not.toBe(kind);
			expect(text, `${kind} rendered nothing`).not.toBe('');
			seen.push(text);
			unmount(app!);
			app = undefined;
			host.textContent = '';
		}
		// Nine kinds, nine DISTINCT words: two kinds sharing one label would satisfy every
		// assertion above while telling an author the wrong thing about why their block failed.
		expect(seen).toHaveLength(9);
		expect(new Set(seen).size).toBe(9);
	});

	// ⛔⛔ THIS TEST WAS INVERTED 2026-08-24, AND BOTH HALVES OF THE CONFLICT ARE RECORDED HERE
	// BECAUSE THE OLD ASSERTION WAS RIGHT ABOUT ITS HARM AND WRONG ABOUT ITS REMEDY.
	//
	// It used to read `AN UNRECOGNISED KIND KEEPS ITS OWN NAME` and assert
	// `expect(pill.textContent).toBe('quota_exceeded')`, reasoning: "a trace is an ARCHIVE and a
	// runner can be one deploy ahead: a tenth kind must ship an ugly token rather than a blank coral
	// badge. `run-status-label.ts` sets the same precedent." The forward-compat half of that is a
	// real requirement and it SURVIVES BELOW. The precedent is not.
	//
	// ⛔ WHY SECURITY WINS ON THIS LINE. `errorKindLabel`'s default arm returning `kind` was an
	// injection channel, demonstrated against a real transpiled block: `classify()`
	// (backend exec/flow-executor.ts:277) copied ANY string `err.kind` off a caught error onto the
	// wire, so a BLOCK AUTHOR chose the token and this pill rendered it as product chrome —
	//   throw Object.assign(new Error('x'), {kind: 'WAARSCHUWING: uw account wordt geblokkeerd'})
	//   → [nl] "Het blok faalde met WAARSCHUWING: uw account wordt geblokkeerd: ⁨x⁩"
	// — and it PERSISTED into `block_test_results.error_detail.actualKind`, which
	// `block-test-error-label.ts:327/:335` casts straight back to `ErrorKind` and hands to this same
	// function. The backend now allowlists at both mint sites (exec/flow-executor.ts,
	// blocks/test-runner.ts), but `flow_runs.trace` is an archive: every pre-allowlist row still
	// replays through here carrying whatever it was given. So the raw token cannot be rendered.
	//
	// ⚠️ AND THE `run-status-label.ts` PRECEDENT DOES NOT CARRY — the citation was the actual
	// reasoning error. That function's input is `flow_runs.status`, a CLOSED pg enum
	// (db/schema.ts:474 `pgEnum('flow_run_status', […])`) minted only by our own run lifecycle; it is
	// typed `string` because the frontend does not own the pg enum type, which is a TYPING
	// looseness, not a TRUST one. Nothing author-writable reaches it, so raw passthrough there is
	// safe. `ErrorKind` is the opposite on both counts: `err.kind` comes off author-supplied block
	// code, and `block_tests.expected_error_kind` is a user-writable text column.
	//
	// ⛔ THE FORWARD-COMPAT REQUIREMENT IS NOT DROPPED, IT IS RE-AIMED. The defect the old test
	// existed to prevent — "a failure with no stated cause" — is asserted harder below than it was
	// before: the pill must be non-blank, must be TRANSLATED (a tenth kind must not regress the
	// Dutch reader to English), and must NOT be any of the nine known kind labels. That last one is
	// the half that a `.not.toBe('')` would miss and it is the one with teeth: defaulting the
	// unknown arm to `block_throw`'s label would be non-blank, localized, and a LIE about why the
	// block failed. What is conceded is exactly one thing — a genuinely new tenth kind reads
	// "onbekende fout" instead of its own token until the frontend catches up. That is the priced
	// cost recorded at error-kind-label.ts:40, and it is the only option that cannot be authored.
	// The sibling assertion for the same arm is run-console.i18n.render.test.ts:192, inverted the
	// same day for the same reason; the two must move together.
	it('AN UNRECOGNISED KIND READS A GENERIC LOCALIZED WORD — never the author’s token, never blank', () => {
		locale.current = 'nl';

		// (a) THE INJECTION SHAPE, which is what the old assertion licensed. Deliberately used as
		// the FIRST fixture: `quota_exceeded` alone looks like a plausible tenth enum and re-teaches
		// the mental model that the token is ours to trust. It is not — this string is a block
		// author's choice.
		const forged = 'WAARSCHUWING: uw account wordt geblokkeerd';
		let pill = render(forged);
		expect(pill.textContent).toBe(m.console_error_kind_unknown());
		// The token must be gone from the WHOLE component, not merely from the badge — the hint and
		// the message line render from the same props.
		expect(host.textContent).not.toContain('WAARSCHUWING');
		expect(host.textContent).not.toContain(forged);
		unmount(app!);
		app = undefined;
		host.textContent = '';

		// (b) THE FORWARD-COMPAT SHAPE — a well-behaved tenth kind the backend might ship first.
		pill = render('quota_exceeded');
		const text = pill.textContent ?? '';
		expect(text).toBe(m.console_error_kind_unknown());
		// …the author's token is not echoed, …
		expect(host.textContent).not.toContain('quota_exceeded');
		// …the pill still STATES A CAUSE rather than going blank (the old test's real requirement), …
		expect(text.trim()).not.toBe('');
		expect(text.length).toBeGreaterThan(3);
		// …it is TRANSLATED, so a tenth kind does not silently regress a Dutch reader to English, …
		expect(text).toBe('onbekende fout');
		expect(text).not.toBe('unrecognised error');
		// …and it does NOT impersonate one of the nine known causes. A default arm that fell back to
		// `block_throw`'s label would pass every assertion above while telling the author something
		// false about their failure; this is the assertion that forbids it.
		locale.current = 'nl';
		const known = KINDS.map((k) => {
			unmount(app!);
			app = undefined;
			host.textContent = '';
			return render(k).textContent ?? '';
		});
		expect(known, 'the nine-label fixture went vacuous').toHaveLength(9);
		expect(new Set(known).size, 'the nine labels are not distinct — the check below is weakened').toBe(9);
		expect(known).not.toContain(m.console_error_kind_unknown());

		// …and the hint under it stays ABSENT rather than rendering `undefined`: the component's
		// `KNOWN_KINDS` allow-list guards the dynamic `mr[…]` lookup it uses for that family.
		unmount(app!);
		app = undefined;
		host.textContent = '';
		render('quota_exceeded');
		expect(host.querySelector('.err-hint')).toBeNull();
	});

	it('…and in English the same pill reads the base catalog — the site reads the tag', () => {
		locale.current = 'en';
		// ⚠️ THIS IS THE ONE PLACE THE BASE LOCALE STILL DISCRIMINATES: `en`'s
		// `console_error_kind_block_throw` is "block error", not "block_throw", so the underscore
		// spelling really is gone in both languages rather than only in the translated one.
		expect(render('block_throw').textContent).toBe(m.console_error_kind_block_throw());
		expect(host.textContent).not.toContain('block_throw');
	});
});
