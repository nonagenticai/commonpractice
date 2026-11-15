// src/lib/i18n/block-test-error-label.ts — the ONE place a block-run refusal becomes words a
// reader can read.
//
// ⛔ THE DEFECT. Two surfaces rendered the backend's English verbatim inside fully localized
// chrome, at the exact moment an author's block refuses to run:
//   • `block-edit/BlockResultView.svelte:86` — `{errorMessage}`, reached from the Test tab
//     (`BlockTesting.svelte`) and the Simulate tab (`BlockSimulate.svelte`). A Dutch author read a
//     Dutch coral pill, a Dutch explanatory paragraph, and underneath both: "output does not match
//     the declared descriptor: 'doubled' must be a finite number". The one line that says WHAT IS
//     WRONG was the only English on the panel.
//   • `build/RunConsole.svelte:107` — `{ev.error}` on every node_error line.
// `errorKind` / `ev.kind` were ALREADY localized (`error-kind-label.ts`); only the message half was
// raw. The wire now carries the RULE plus the MACHINE FIELDS and the browser owns the words —
// the same split `graph-issue-label.ts` documents at length and `notification-label.ts` uses for
// the bell.
//
// ⛔ THE ENGLISH `message` STAYS ON THE WIRE, BYTE FOR BYTE, and here that is not merely a
// fallback. Three independent readers need it:
//   1. `backend/src/ai/mcp/tools.ts` returns these strings verbatim to an LLM (`run_block_test`,
//      `simulate_block`). English is CORRECT for that reader and this module is never involved.
//   2. `block-edit/BlockFixAssistant.svelte` puts `context.errorMessage` INTO AN LLM PROMPT ("Fix
//      with AI", seeded from BlockTesting / BlockSimulate). The same string is browser-facing AND
//      machine-facing on the SAME SCREEN. Drop it from the DTO and Fix-with-AI degrades.
//   3. Nine backend assertions pin it character for character (`tests/descriptor.test.ts`,
//      `tests/flow-executor.test.ts`).
//
// ⛔⛔ THE CRUX — PRODUCT ENGLISH AND BLOCK-AUTHOR ENGLISH SHARE ONE FIELD, AND ONLY ONE THING
// SEPARATES THEM. `backend/src/exec/flow-executor.ts` `classify()` funnels EVERYTHING into
// `ev.error`: a block author's own `throw new Error('…')`, a TimeoutError, "no source for block
// version …", "foreach input 'in' must be an array", the two budget messages, three capability
// refusals, and two `.join('; ')` sites.
//
// `kind` IS NOT A SOUND DISCRIMINATOR. `block_throw` is the DEFAULT arm of `classify` for any error
// carrying no kind, so it means "unclassified", not "authored by the block" — and an author can
// `Object.assign(err, { kind: 'validation' })` and impersonate a product refusal.
//
// THE DISCRIMINATOR IS THE PRESENCE OF `rule`, which is attached ONLY by `productError()` — a
// factory in the executor's module scope that a transpiled block can never reach (a block receives
// `ctx` and nothing else). So the three branches below are not three degrees of confidence, they
// are three different FACTS:
//     rule present + detail complete → the catalog sentence          (our words, fully specified)
//     rule present + detail INCOMPLETE → the English `message`       (our words, archived/mid-roll)
//     rule ABSENT                     → the raw text                 (NOT our words — the author's)
// The third branch is simultaneously the author-text rule AND the correct backend-first fallback,
// which is why author text can never be localized BY CONSTRUCTION rather than by heuristic. A
// heuristic here would be a product that puts words in a developer's mouth.
//
// EXHAUSTIVE SWITCH, NOT A LOOKUP TABLE. Paraglide compiles ONE function per message key and
// tree-shakes on the import graph, so ``m[`blockerr_${rule}`]()`` does not resolve — there is no
// runtime object to index. The explicit switch is the house idiom (`graph-issue-label.ts`,
// `error-kind-label.ts`, `stage-label.ts`), not a workaround.
//
// ⛔ THE MID-ROLL BRANCH IS LOAD-BEARING AND IS *NOT* ONLY A ROLLING-DEPLOY WINDOW HERE.
// `flow_runs.trace` is a jsonb ARCHIVE and `block_test_results` has NO BACKFILL (migration 0072),
// so a run recorded — or a test result written — before this change replays through here with
// `message` and nothing else, forever. Interpolating anyway would render “ ” has no value, a
// localized sentence that says strictly LESS than the English it replaced. An empty string is the
// same absence wearing a different hat, so `has()` rejects it.
import * as m from '$lib/paraglide/messages';
import { llmSettingsPath } from './llm-settings-path';
import type { BlockErrorDetail, FieldIssue } from '$lib/types/trace';
import { errorKindLabel } from '$lib/i18n/error-kind-label';
import type { ErrorKind } from '$lib/types/trace';

/** One refusal, in the shape all three call sites can assemble. */
export interface BlockError {
	/**
	 * A plain `string` (or nothing), NOT the backend's 28-value union — same reason
	 * `graph-issue-label.ts` gives: a rule shipped backend-first must degrade to its own `message`,
	 * never vanish and never render as a bare `test_output_mismatch` token.
	 */
	rule?: string | null;
	/** The backend's English. ALWAYS present; it is the guaranteed fallback. */
	message: string;
	detail?: BlockErrorDetail | null;
}

/**
 * True when `detail` carries every one of `keys` as a NON-EMPTY string.
 *
 * Three absences collapse into one test on purpose, because all three produce the same bad
 * sentence: the whole bag missing (archive / mid-roll), the individual field missing (a rule that
 * grew a field), and the field present but `''` (an empty quoted port name reads as a product bug).
 * The type predicate is what lets the call sites pass `d.field` to paraglide without a `!`.
 */
function has<K extends keyof BlockErrorDetail>(
	d: BlockErrorDetail | null | undefined,
	...keys: K[]
): d is BlockErrorDetail & Required<Pick<BlockErrorDetail, K>> {
	return !!d && keys.every((k) => typeof d[k] === 'string' && d[k] !== '');
}

/** True when `detail.options` is a non-empty array of non-empty strings. */
function hasOptions(
	d: BlockErrorDetail | null | undefined
): d is BlockErrorDetail & { options: string[] } {
	return (
		!!d &&
		Array.isArray(d.options) &&
		d.options.length > 0 &&
		d.options.every((o) => typeof o === 'string' && o !== '')
	);
}

/** True when `detail.issues` is a non-empty array of things that look like a `FieldIssue`. */
function hasIssues(
	d: BlockErrorDetail | null | undefined
): d is BlockErrorDetail & { issues: FieldIssue[] } {
	return (
		!!d &&
		Array.isArray(d.issues) &&
		d.issues.length > 0 &&
		d.issues.every((i) => !!i && typeof i.message === 'string' && i.message !== '')
	);
}

/**
 * Wrap ONE READABLE TOKEN in a Unicode bidi ISOLATE, so `ar`/`he` cannot reorder it into nonsense.
 *
 * ⛔ CHARACTERS, NOT `<bdi>` MARKUP, AND THAT IS THE POINT. This returns a plain string that Svelte
 * escapes into a text node; emitting `<bdi>` would require `{@html}` at the render site, which
 * would inject backend-supplied port names, slugs and BLOCK-AUTHOR ERROR TEXT into the DOM as HTML.
 * U+2068/U+2069 (FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE) are precisely what `<bdi>`
 * compiles down to, are zero-width, and change nothing in the five LTR locales.
 *
 * ⚠️ THE UNIT IS THE TOKEN THE READER SEES. `graph-issue-label.ts` measured what happens when a
 * compound like `node.handle` is isolated per FIELD instead of as a whole: the two halves SWAP in
 * `ar`/`he`. No sentence here joins two fields into one compound, so every call below isolates a
 * single value — but `cause` is the case that makes this more than insurance. It is ARBITRARY
 * author prose, frequently English, dropped into an Arabic sentence between two RTL runs; without
 * the isolate its trailing punctuation migrates to the wrong end of the line.
 */
const iso = (v: string): string => `⁨${v}⁩`;

/**
 * Join the recursed per-issue sentences.
 *
 * ⚠️ `' · '` AND NOT `Intl.ListFormat`. These are complete SENTENCES, not list items: "a, b and c"
 * over three full sentences reads as a grammatical error in every one of the eight, and the
 * conjunction would claim a relationship ("and"/"or") that the backend's `'; '` never asserted. A
 * middle dot is punctuation with no language attached — the same separator `RunConsole` already
 * uses between the fields of a trace line — so no message key is minted for a decision nobody made.
 */
const SEP = ' · ';

/**
 * The reader's sentence for one block-run refusal.
 *
 * `locale` is required and is NOT read from a store: `Intl.ListFormat` needs it, this module is
 * called from two components that already hold `locale.current`, and a hidden global would make the
 * enum-join branch untestable without mounting a component.
 */
export function blockTestErrorLabel(err: BlockError, locale: string): string {
	const d = err.detail;
	switch (err.rule) {
		// ---- exec/descriptor.ts — per-field runtime validation ----
		case 'field_must_be_string':
			if (!has(d, 'field')) return err.message;
			return m.blockerr_field_must_be_string({ field: iso(d.field) });

		case 'field_must_be_number':
			if (!has(d, 'field')) return err.message;
			return m.blockerr_field_must_be_number({ field: iso(d.field) });

		case 'field_must_be_boolean':
			if (!has(d, 'field')) return err.message;
			return m.blockerr_field_must_be_boolean({ field: iso(d.field) });

		case 'field_must_be_string_array':
			if (!has(d, 'field')) return err.message;
			return m.blockerr_field_must_be_string_array({ field: iso(d.field) });

		case 'field_must_be_one_of':
			// ⛔ THE ENUM JOIN, WHICH IS WHY `options` IS AN ARRAY ON THE WIRE. The backend composed
			// `[a, b, c]` — an ENGLISH list: the separator and the final conjunction are both
			// language-specific, and once joined the seam is gone. `Intl.ListFormat` rebuilds it in
			// the reader's language ("a, b of c" / "a, b ou c" / "a أو b").
			//
			// ⚠️ `disjunction`, not `conjunction`: the value must be ONE of these, not all of them.
			// `style: 'short'` keeps a long enum from eating the panel.
			if (!has(d, 'field') || !hasOptions(d)) return err.message;
			return m.blockerr_field_must_be_one_of({
				field: iso(d.field),
				options: new Intl.ListFormat(locale, { style: 'short', type: 'disjunction' }).format(
					d.options.map(iso)
				)
			});

		case 'field_required':
			if (!has(d, 'field')) return err.message;
			return m.blockerr_field_required({ field: iso(d.field) });

		case 'field_must_be_dataset':
			if (!has(d, 'field')) return err.message;
			return m.blockerr_field_must_be_dataset({ field: iso(d.field) });

		case 'field_unknown_type':
			if (!has(d, 'field')) return err.message;
			return m.blockerr_field_unknown_type({ field: iso(d.field) });

		case 'input_missing_required':
			if (!has(d, 'field')) return err.message;
			return m.blockerr_input_missing_required({ field: iso(d.field) });

		case 'output_not_object':
			// The only descriptor rule with NO parameters, so it has no archived shape: an old
			// event's `output_not_object` is already complete. Never falls back.
			return m.blockerr_output_not_object();

		case 'output_missing_required':
			if (!has(d, 'field')) return err.message;
			return m.blockerr_output_missing_required({ field: iso(d.field) });

		// ---- exec/block-loader.ts — the saved module is not a block at all ----
		// ⛔ THESE THREE SHIPPED AS RAW ENGLISH UNTIL 2026-08-24, and nothing was watching: the
		// backend contract test hand-listed three files and CLAIMED they composed "EVERY product
		// English sentence that can reach `ev.error`". `BlockErrorRule` had no group for
		// `block-loader.ts` at all, so `block v0: module has no default export object` reached a
		// Dutch /block-edit panel verbatim while every assertion stayed green.
		case 'block_no_default_export':
			if (!has(d, 'blockVersion')) return err.message;
			return m.blockerr_block_no_default_export({ blockVersion: iso(d.blockVersion) });

		case 'block_no_run_function':
			if (!has(d, 'blockVersion')) return err.message;
			return m.blockerr_block_no_run_function({ blockVersion: iso(d.blockVersion) });

		case 'block_no_descriptor':
			if (!has(d, 'blockVersion')) return err.message;
			return m.blockerr_block_no_descriptor({ blockVersion: iso(d.blockVersion) });

		// ---- exec/dataset-resolver.ts — a dataset slug the host did not inject ----
		// ⚠️ TWO RULES FOR ONE SITE, DELIBERATELY. "not available here" and "not available here,
		// but these are" are two different sentences, and the union's rule is one member per
		// SENTENCE. Folding them into one rule with an optional `options` would mean falling back
		// to English whenever the workspace has no datasets at all — a real runtime state, not an
		// archive artefact, so the mid-roll branch would be doing a job it was never meant to do.
		case 'dataset_not_available':
			if (!has(d, 'dataset')) return err.message;
			return m.blockerr_dataset_not_available({ dataset: iso(d.dataset) });

		case 'dataset_not_available_alternatives':
			if (!has(d, 'dataset') || !hasOptions(d)) return err.message;
			return m.blockerr_dataset_not_available_alternatives({
				dataset: iso(d.dataset),
				// Same `Intl.ListFormat` argument as `field_must_be_one_of`, and `conjunction` here
				// rather than `disjunction`: these are ALL the datasets this workspace has, not a
				// menu of which one to pick.
				options: new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }).format(
					d.options.map(iso)
				)
			});

		// ---- host/llm-broker.ts — the TRUSTED host refused the brokered call ----
		// ⛔ THE HOST MINTS THESE RULES, NOT THE RUNNER. `runner-entry.ts` is handed only
		// `{error, kind}` on the `llm_response` frame and cannot recover the cap number or the model
		// name from the host's prose without parsing English. Until the rule rode the frame, "daily
		// LLM call cap reached (200)" and the "Add your own provider key in Administer → LLM
		// settings" paragraph — GOVERNANCE COPY, the product's own voice at its most consequential —
		// were rendered verbatim to every non-English reader.
		case 'llm_daily_cap_reached':
			if (!has(d, 'limit')) return err.message;
			return m.blockerr_llm_daily_cap_reached({ limit: iso(d.limit) });

		case 'llm_weekly_spend_reached':
			if (!has(d, 'limit')) return err.message;
			return m.blockerr_llm_weekly_spend_reached({ limit: iso(d.limit) });

		case 'llm_model_not_allowed':
			if (!has(d, 'model')) return err.message;
			return m.blockerr_llm_model_not_allowed({ model: iso(d.model) });

		case 'llm_budget_exhausted':
			// Parameterless — an archived event carrying only the rule is already complete.
			return m.blockerr_llm_budget_exhausted({ path: llmSettingsPath() });

		case 'llm_seat_required':
			// Parameterless on purpose: naming the workspace or the person would put an identity
			// into a string a block author can read, and the reader already knows which workspace
			// they are in. What they need is WHO CAN FIX IT, which the sentence says.
			return m.blockerr_llm_seat_required();

		case 'llm_host_closed':
			return m.blockerr_llm_host_closed();

		// Spend-posture refusals (backend services/byo-posture.ts). Parameterless, and their sentences are the same as the
		// API-error codes (`error_llm_*`) and tell the reader the one
		// repair: add their own provider key in LLM settings.
		case 'llm_platform_local_only':
			return m.blockerr_llm_platform_local_only({ path: llmSettingsPath() });

		case 'llm_byo_key_required':
			return m.blockerr_llm_byo_key_required({ path: llmSettingsPath() });

		// ---- exec/flow-executor.ts — the runner's own refusals ----
		case 'node_no_source':
			if (!has(d, 'blockVersion')) return err.message;
			return m.blockerr_node_no_source({ blockVersion: iso(d.blockVersion) });

		case 'node_inputs_invalid':
			if (!hasIssues(d)) return err.message;
			return m.blockerr_node_inputs_invalid({ issues: joinIssues(d.issues, locale) });

		case 'node_outputs_invalid':
			if (!hasIssues(d)) return err.message;
			return m.blockerr_node_outputs_invalid({ issues: joinIssues(d.issues, locale) });

		case 'node_timeout':
			return m.blockerr_node_timeout();

		case 'foreach_input_not_array':
			if (!has(d, 'port')) return err.message;
			return m.blockerr_foreach_input_not_array({ port: iso(d.port) });

		case 'run_wall_clock_exceeded':
			return m.blockerr_run_wall_clock_exceeded();

		case 'foreach_event_budget_exceeded':
			return m.blockerr_foreach_event_budget_exceeded();

		case 'capability_missing_llm':
			if (!has(d, 'slug')) return err.message;
			return m.blockerr_capability_missing_llm({ slug: iso(d.slug) });

		case 'capability_missing_mock_data':
			if (!has(d, 'slug')) return err.message;
			return m.blockerr_capability_missing_mock_data({ slug: iso(d.slug) });

		case 'capability_missing_dataset':
			if (!has(d, 'slug')) return err.message;
			return m.blockerr_capability_missing_dataset({ slug: iso(d.slug) });

		// ---- blocks/test-runner.ts — the block-test verdict ----
		case 'test_expected_error_but_succeeded':
			return m.blockerr_test_expected_error_but_succeeded();

		case 'test_wrong_error_kind':
			// ⛔ ONE OF THE TWO CONCATENATION SITES. The backend composed
			// `expected error kind 'X', got 'Y': <arbitrary text>` — product English glued onto
			// whatever the node produced. All three parts are separated on the wire now: the two
			// kinds go through the SHARED `errorKindLabel` (one enum, one mechanism — not a second
			// vocabulary), and `cause` is rendered UNTRANSLATED because it is not ours.
			if (!has(d, 'expectedKind', 'actualKind', 'cause')) return err.message;
			return m.blockerr_test_wrong_error_kind({
				expectedKind: errorKindLabel(d.expectedKind as ErrorKind),
				actualKind: errorKindLabel(d.actualKind as ErrorKind),
				cause: causeOf(d, locale)
			});

		case 'test_block_errored':
			if (!has(d, 'actualKind', 'cause')) return err.message;
			return m.blockerr_test_block_errored({
				actualKind: errorKindLabel(d.actualKind as ErrorKind),
				cause: causeOf(d, locale)
			});

		case 'test_no_output':
			return m.blockerr_test_no_output();

		case 'test_output_not_json_object':
			return m.blockerr_test_output_not_json_object();

		case 'test_output_not_conformant':
			// ⛔ THE JOINED-ERRORS SITE. `conform.errors.join('; ')` was unrecoverable: N English
			// sentences in one string with no seam. `detail.issues` keeps each `{rule, message,
			// detail}` intact and this RECURSES — so a single unrecognised member costs only its own
			// sentence, not the whole list.
			if (!hasIssues(d)) return err.message;
			return m.blockerr_test_output_not_conformant({ issues: joinIssues(d.issues, locale) });

		case 'test_output_mismatch':
			return m.blockerr_test_output_mismatch();

		default:
			// ⛔ BOTH TRUTHS AT ONCE, AND THIS IS THE MODULE'S WHOLE ARGUMENT.
			//   • `rule` absent  → the text belongs to the BLOCK AUTHOR. Rendering it verbatim is not
			//     a degradation, it is the only correct behaviour: it may be Dutch already, it may be
			//     a stack-trace fragment, and there is no code behind it to localize FROM.
			//   • `rule` present but UNRECOGNISED → a rule shipped backend-first. The English is a
			//     worse read than a translated sentence and an infinitely better read than a bare
			//     `nested_foreach`-style token or a blank.
			// One branch serves both because the right answer is the same: the backend's own words.
			return err.message;
	}
}

/**
 * Render each per-field issue through this same function and join them.
 *
 * ⛔ THE RECURSION IS THE POINT. A `FieldIssue` is a complete `{rule, message, detail}` triple, so
 * every branch above — including the three-way fallback — applies to it unchanged. A nested issue
 * whose rule this bundle does not know contributes its own English and nothing else, while its
 * siblings still render in the reader's language.
 */
/**
 * The `cause` half of a test verdict: the node's OWN refusal when the node's refusal was ours,
 * and the raw text when it was the author's.
 *
 * ⛔⛔ MEASURED IN A BROWSER, AND IT IS THE HOLE `cause`'s OWN DOCTRINE LEFT OPEN. `cause` is
 * rendered UNTRANSLATED because it is normally a block author's sentence and putting words in a
 * developer's mouth is worse than showing English. But it is not always the author's: run a block
 * whose output fails its descriptor and the RUNNER refuses first, with `node_outputs_invalid` — a
 * product sentence — which `test-runner.ts` then wrapped as `test_block_errored`. A Dutch reader
 * got:
 *     Het blok faalde met validatie: ⁨'samenvatting' must be a string⁩
 * Localized frame, localized kind, English detail that nobody outside this repo wrote.
 *
 * The backend now relays such a refusal as a one-element `detail.issues` bag — the same shape this
 * module already recurses into — so the branch is simply "was there a rule behind that cause?".
 * There is no new catalog key and no new rule: `issues` present means the cause is OURS and gets
 * the catalog sentence; `issues` absent means it is the author's and gets `iso()` and nothing else.
 */
function causeOf(d: BlockErrorDetail, locale: string): string {
	return hasIssues(d) ? joinIssues(d.issues, locale) : iso(d.cause ?? '');
}

function joinIssues(issues: FieldIssue[], locale: string): string {
	return issues
		.map((i) => blockTestErrorLabel({ rule: i.rule, message: i.message, detail: i.detail }, locale))
		.join(SEP);
}
