// src/lib/i18n/error-kind-label.ts — the ONE place a run's ERROR KIND becomes a word a reader can
// read.
//
// ⛔ THE DEFECT, AND IT IS A DUPLICATION DEFECT RATHER THAN A MISSING-KEY ONE. The switch below
// already existed — it lived as a private `function errorKindLabel(kind)` inside
// `lib/components/build/RunConsole.svelte`, and the nine `console_error_kind_*` keys it reaches are
// in all eight catalogs. `lib/components/block-edit/BlockResultView.svelte` renders the SAME
// `ErrorKind`, on /block-edit, and did it like this:
//
//     <span class="kind">{errorKind}</span>
//
// with `.kind { text-transform: uppercase }`, so a Dutch author who broke a block read a coral pill
// saying **BLOCK_THROW** sitting directly on top of `blockresult_errkind_block_throw` — "De code
// van het blok gooide een fout tijdens het uitvoeren…" — a fully Dutch paragraph explaining the
// English token above it. One value, two components, two mechanisms; the second one had none.
//
// ⚠️ THE TWO KEY FAMILIES ARE NOT INTERCHANGEABLE, WHICH IS THE TRAP IN FIXING THIS. `BlockResultView`
// already imports `blockresult_errkind_*` for the hint under the pill. Those are PARAGRAPHS — "The
// block ran longer than its time budget and was stopped. Look for a slow loop…" — and reusing one
// as the pill would put a sentence inside a 10.5px uppercase badge. `console_error_kind_*` are the
// SHORT NAMES ("blokfout", "time-out", "netwerk geblokkeerd") and are the right family for a chip.
// Both are needed on this component; that is why neither was folded into the other.
//
// ⛔⛔ RETRACTED 2026-08-24 — THIS FILE USED TO FALL BACK TO THE RAW KIND, AND THAT WAS AN INJECTION
// CHANNEL. The old note here read "RAW ON AN UNKNOWN KIND, NEVER BLANK", reasoning from
// `run-status-label.ts`'s precedent that a kind added backend-first should still say something. The
// reasoning was sound about kinds and wrong about WHERE THE VALUE COMES FROM. `kind` is not a
// closed enum on the wire: `flow-executor.ts` `classify()` copied ANY string off a caught error, so
// a block author wrote
//     throw Object.assign(new Error('x'), {kind: 'WAARSCHUWING: uw account wordt geblokkeerd'})
// and this function returned it VERBATIM AND UN-ISOLATED into the coral pill and into
//     [nl] "Het blok faalde met WAARSCHUWING: uw account wordt geblokkeerd: ⁨x⁩"
// — the author's sentence, in the product's chrome, in the reader's language. It was persisted, too
// (`block_test_results.error_detail.actualKind`).
//
// The backend now allowlists at BOTH entry points (`exec/flow-executor.ts` and
// `blocks/test-runner.ts`), so nothing new can arrive here off-vocabulary. This arm is the third
// line: `flow_runs.trace` is an ARCHIVE, and every row written before those allowlists existed
// replays through here with whatever it was given. A generic localized word is strictly better than
// a blank AND is the only option that cannot be authored — a genuinely new tenth kind loses a
// little precision, which is the correct price for that. `run-console.i18n.render.test.ts` pins the
// new behaviour.
//
// ⛔ NOT `mr[`console_error_kind_${kind}`]()` — the `m as unknown as Record<…>` shape
// `BlockResultView` uses for its hints. That works there only because a stray key would resolve to
// `undefined` and the component guards it with an explicit `KNOWN_KINDS` allow-list. It is not the
// house pattern: paraglide compiles ONE function per message key and tree-shakes on the IMPORT
// GRAPH, so a dynamically indexed key is a key nothing imports and is eligible to be shaken out of
// the bundle. Spelled out at length in `stage-label.ts`, which this mirrors.
import * as m from '$lib/paraglide/messages';
import type { ErrorKind } from '$lib/types/trace';

/**
 * The reader's word for why a node — or a block test, or a simulate — failed.
 *
 * The value set is CLOSED: nine members in `frontend/src/lib/types/trace.ts`, mirroring
 * `backend/src/db/trace-types.ts`. Takes `ErrorKind` (both call sites already hold one) but the
 * `default:` arm is live all the same, because a trace is an ARCHIVE — a `flow_runs.trace` row
 * written by a runner that knew a tenth kind replays through this function with a value the
 * compiler was never shown.
 */
export function errorKindLabel(kind: ErrorKind): string {
	switch (kind) {
		case 'timeout':
			return m.console_error_kind_timeout();
		case 'validation':
			return m.console_error_kind_validation();
		case 'block_throw':
			return m.console_error_kind_block_throw();
		case 'network_blocked':
			return m.console_error_kind_network_blocked();
		case 'llm_capped':
			return m.console_error_kind_llm_capped();
		case 'model_not_allowed':
			return m.console_error_kind_model_not_allowed();
		case 'budget_exhausted':
			return m.console_error_kind_budget_exhausted();
		case 'flow_error':
			return m.console_error_kind_flow_error();
		case 'internal':
			return m.console_error_kind_internal();
		default:
			// ⛔ NEVER `return kind`. See the header: this value is not guaranteed to be an enum.
			return m.console_error_kind_unknown();
	}
}
