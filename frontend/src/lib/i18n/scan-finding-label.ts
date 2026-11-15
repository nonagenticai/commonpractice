// src/lib/i18n/scan-finding-label.ts — the ONE place a block-source scan hit becomes words a
// reader can read.
//
// ⛔ THE DEFECT. CommonPractice is demoed in DUTCH. `/block-edit` renders a lint finding as
// `<code>{f.rule}</code> {f.message}` at TWO sites, and `message` is authored in
// backend/src/exec/static-scan.ts as an ENGLISH sentence — "eval() is forbidden.", "Import of
// 'lodash' is not allowed; blocks may only import the Common Practice SDK." Right beside it sits
// the counter badge `blockedit_lint_issues`, which IS localized, so a Dutch author pasting one bad
// line gets a half-translated screen: "3 problemen" over "eval() is forbidden." The server does not
// know, and must not know, who is reading. The wire carries the RULE plus the machine fields; the
// browser owns the words. Same split as `data-finding-label.ts` and `stage-label.ts`.
//
// ⛔⛔ THE VOCABULARY IS HALF-OPEN, AND THAT IS WHAT SHAPES THIS MODULE.
// `LintFinding` unifies two layers (backend/src/blocks/lint.ts):
//   * `source: 'scan'` — the THIRTEEN rules declared in `static-scan.ts`. Closed, enumerable,
//     pinned by `scan-finding-label.backend-contract.test.ts`. Translatable.
//   * `source: 'type'` — `rule` is a `TS####` code and `message` is TSC'S OWN DIAGNOSTIC. That is
//     an unbounded English vocabulary (thousands of messages, reworded between compiler releases)
//     that no catalog can ever cover, and translating a compiler diagnostic is not this product's
//     job — a developer googles it verbatim. It is returned UNCHANGED, and the branch is FIRST so
//     a `TS####` can never accidentally fall into the rule switch below.
//
// ⛔ THIS IS A SIBLING OF `data-finding-label.ts`, NOT A SHARED MODULE WITH IT — the reason is
// spelled out in `$lib/api/data-findings.ts` and applies verbatim. A `LintFinding` points at a
// SOURCE LINE AND COLUMN and carries a `source` discriminant; a `DataValidationFinding` points at a
// dataset/column/attribute and has no analogue for either. A union of the two could only be guarded
// down to `rule` + `message`, which is exactly the information loss these modules exist to prevent.
//
// EXHAUSTIVE SWITCH, NOT A LOOKUP TABLE. Paraglide compiles ONE function per message key and
// tree-shakes on the import graph, so `m[`scan_finding_${rule}`]()` does not resolve — there is no
// runtime object to index. The explicit switch is the house idiom.
//
// ⛔ THE FALLBACK IS THREE-BRANCH, AND THE MIDDLE BRANCH IS LOAD-BEARING.
// The browser reaches the API through the SERVICE, which load-balances across old and new pods for
// the length of a rolling deploy (`maxSurge: 1` / `maxUnavailable: 0` GUARANTEES that window), so a
// NEW frontend really is answered by an OLD backend. Nine of the thirteen rules need no backend
// change at all and are safe on day one; the other four interpolate a field that shipped WITH this
// change:
//   rule known + its machine field present → the catalog message           (the normal path)
//   rule known, `spec`/`detail` MISSING    → `finding.message`             (old backend, mid-roll)
//   rule absent or UNRECOGNISED            → `finding.message`             (rule shipped backend-first)
// Interpolating an absent field would print "Importing “undefined” is not allowed" — a localized
// sentence that says strictly less than the English one it replaced.
//
// ⚠️ AN UNRECOGNISED RULE DEGRADES TO ITS OWN MESSAGE, IT DOES NOT VANISH AND DOES NOT BECOME A
// BARE TOKEN — the same rule `data-finding-label.ts` and `api/graph-issues.ts` already establish. A
// twelfth scan rule shipped backend-first names a real safety violation in the author's code; the
// English sentence is a worse read than a translated one and an infinitely better read than
// nothing. The backend-contract test is what stops that state from being permanent.
import * as m from '$lib/paraglide/messages';
import type { LintFinding } from '$lib/types/blocks';

/**
 * A machine field is usable only when it really is a NON-EMPTY STRING.
 *
 * ⛔ `LintFinding` IS A CLAIM ABOUT THE WIRE, NOT A CHECK OF IT. `blocks.ts` builds its `ApiError`
 * from `body?.findings` — whatever JSON the backend sent, cast, never inspected — so `spec` being a
 * `string` is a promise the TYPE makes and nothing enforces. Measured against this module before the
 * guard existed:
 *
 *     scanFindingLabel({ source: 'scan', rule: 'banned-import', message: 'M', spec: { a: 1 } })
 *       → "“[object Object]” importeren is verboden in de sandbox."
 *
 * That is not a live backend bug — `static-scan.ts` types both fields `string` and the runtime proof
 * is `backend/tests/static-scan-machine-fields.test.ts`. It is an ASYMMETRY with this branch's own
 * doctrine: the sibling workstream added `isGraphIssueDetail` to `api/graph-issues.ts` for exactly
 * this shape and this one added nothing. A truthiness test cost the same and caught less, so the
 * check is on the TYPE, and the fallback is the one this module already uses everywhere — the
 * English `message`, which is strictly more information than `[object Object]`.
 *
 * ⚠️ EMPTY STRING COUNTS AS ABSENT, matching `has()` in the sibling `graph-issue-label.ts`:
 * `“” importeren is verboden` reads as a product bug, and the English sentence still names the
 * specifier.
 */
const usable = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * Wrap ONE READABLE TOKEN in a Unicode bidi ISOLATE, so `ar`/`he` cannot mangle it.
 *
 * ⛔ MEASURED, ON `scan_finding_syntax`, WHICH IS THE ONE THAT NEEDED IT. `<bdi>` at the render site
 * gives the sentence its own base direction (`dir="auto"`), and for the Arabic and Hebrew patterns
 * that base is RTL. Bun's parser text is an English LTR run ending in `.` — a NEUTRAL, which
 * resolves to the RTL base level and migrates to the WRONG END of the line:
 *
 *     no isolate → `.Expected ")" but found "{" (2:20) :ةرفيشلا هذه ليلحت رّذعت`
 *     isolated   → `Expected ")" but found "{" (2:20). :ةرفيشلا هذه ليلحت رّذعت`
 *
 * ⚠️ AND THE HONEST HALF: on the three `{spec}` rules this is a measured NO-OP for an ordinary
 * latin specifier — `node:net` renders byte-identically with and without it, because it sits alone
 * between two RTL runs. It is applied there anyway for one reason: a module specifier is arbitrary
 * author-supplied text, so it CAN mix direction, and isolation is what keeps `llm عربي` from
 * rendering as `عربي llm`.
 *
 * ⛔⛔ THE UNIT IS THE WHOLE TOKEN, AND THAT IS NOT A DETAIL. The sibling workstream wrapped each
 * FIELD of a two-field compound separately and REVERSED it (`»rows.http-fetch«`), because per UAX#9
 * an isolate collapses to a single neutral and a run of neutrals between two RTL runs resolves RTL.
 * Nothing here joins two fields into one quoted token, so one call per field is the whole token —
 * but if a pattern ever grows a compound, it must be built BEFORE this call, not after.
 *
 * ⛔ CHARACTERS, NOT `<bdi>` MARKUP. This returns a plain string Svelte escapes into a text node;
 * emitting markup would need `{@html}` on backend-supplied text. U+2068/U+2069 are exactly what
 * `<bdi>` compiles to, are zero-width, and change nothing in the five LTR locales.
 */
const iso = (v: string): string => `⁨${v}⁩`;

/**
 * The reader's sentence for one lint finding, scan or type.
 *
 * `finding.message` is the guaranteed fallback: the backend has always shipped it and keeps
 * shipping it byte-identical, precisely so this function always has something to return.
 */
export function scanFindingLabel(finding: LintFinding): string {
	// ⛔ FIRST, BEFORE THE RULE SWITCH. A type-check finding's `message` IS tsc's diagnostic and its
	// `rule` is a `TS####` code — an unbounded vocabulary with no catalog entry and no business
	// having one. Putting this after the switch would still work today (no `case` matches `TS2345`)
	// and would silently break the day a scan rule is ever named like a TS code; putting it first
	// makes the discriminant the discriminant.
	if (finding.source === 'type') return finding.message;

	switch (finding.rule) {
		// ---- the eight AMBIENT_GLOBALS rules: no machine fields, nothing to be missing mid-roll ----
		case 'no-fetch':
			return m.scan_finding_no_fetch();
		case 'no-websocket':
			return m.scan_finding_no_websocket();
		case 'no-xhr':
			return m.scan_finding_no_xhr();
		case 'no-process':
			return m.scan_finding_no_process();
		case 'no-bun-socket':
			return m.scan_finding_no_bun_socket();
		case 'no-eval':
			return m.scan_finding_no_eval();
		// ⛔ THE TWO RULES ADDED WITH THE SAVE-TIME GATE. `new Function('…')` and
		// `globalThis['ev'+'al']` reach eval-equivalent power without the token `eval` appearing, and
		// were missed by every earlier version of the scanner. They were tolerable while the scan was
		// advisory; they are not now that `models.code_exec_outside_blocks` is classified `enforced`.
		// Like the six above they carry no machine field, so there is no mid-roll branch to write.
		case 'no-function-constructor':
			return m.scan_finding_no_function_constructor();
		case 'no-computed-global':
			return m.scan_finding_no_computed_global();
		// ---- …and the one other rule that carries no machine field ----
		case 'no-dynamic-import':
			return m.scan_finding_no_dynamic_import();

		// ---- the three import rules, which must NAME the module specifier ----
		case 'no-require':
			// ⛔ THE MID-ROLL BRANCH. `spec` arrived WITH this change; an old backend ships this rule
			// with the specifier only inside the English `message`, from which no browser can extract
			// it. A sentence about an import that cannot say WHICH import is useless to the author.
			// `usable`, not truthiness: the wire shape is unchecked, so a non-string reaches here as
			// easily as an absent one and interpolates as `[object Object]`.
			if (!usable(finding.spec)) return finding.message;
			return m.scan_finding_no_require({ spec: iso(finding.spec) });
		case 'banned-import':
			if (!usable(finding.spec)) return finding.message;
			return m.scan_finding_banned_import({ spec: iso(finding.spec) });
		case 'import-not-allowlisted':
			if (!usable(finding.spec)) return finding.message;
			return m.scan_finding_import_not_allowlisted({ spec: iso(finding.spec) });

		// ---- syntax: the catalog entry WRAPS the transpiler's own text, it does not replace it ----
		case 'syntax':
			// Bun's parser message is English and unbounded, exactly like a tsc diagnostic — but
			// unlike the `type` branch there IS a translatable frame around it ("Deze code parseert
			// niet: …"), which is the half the reader needs to understand what happened. Without
			// `detail` the frame would wrap nothing, so the English sentence stands.
			//
			// ⛔ AND IT IS ISOLATED, unlike every other interpolation on this branch was. The frame
			// is Arabic/Hebrew prose, the diagnostic is a latin LTR run, and its trailing `.` is a
			// neutral that resolves to the RTL base and jumps to the wrong end of the line. See the
			// measurement in the `iso` header.
			if (!usable(finding.detail)) return finding.message;
			return m.scan_finding_syntax({ detail: iso(finding.detail) });

		default:
			return finding.message;
	}
}
