// src/lib/i18n/icu-number-params.sites.test.ts — the CALL-SITE half of the ICU number fix: which
// message parameters must be grouped, which must not, and which must never be touched at all.
//
// ⛔ WHY A SOURCE GUARD AND NOT TWENTY RENDER SPECS. The fix is one line per site across twenty
// files; mounting twenty pages (each with its own API mocks, its own loading drain, its own SSE
// stub) to re-assert the same one-line property would cost more to maintain than the property is
// worth, and the pages that matter most already have render specs. The BEHAVIOUR is driven
// end-to-end in three places — `$lib/components/dataset-preview.locale-numbers.render.test.ts` (a
// real page's real Dutch sentence, plus the locale switch), `routes/connectors/
// connectors-notice.locale-numbers.render.test.ts` (the file that shipped both spellings at once)
// and `icu-number-params.test.ts` (the compiled plural messages). This file's job is different: it
// makes each INDIVIDUAL site's revert red by name, which is the thing a behavioural test on two
// pages cannot do for the other eighteen.
//
// ⛔⛔ AND IT IS THE ONLY NET UNDER A WRONG-DATA DEFECT, WHICH IS WHY IT IS PINNED THIS HARD.
// `svelte-check` structurally cannot see the mistake the PLURAL_SITES block guards: a paraglide
// message input compiles to `NonNullable<unknown>`, so putting `num()` on `m.audit_event_count`'s
// `count` — WITH the imports — passes at 2857 files / 0 errors while German renders "1 Ereignis"
// for a thousand, because `registry.plural` runs `Number("1.000")`. Measured. Nothing else in the
// repo looks at these call sites.
//
// ⛔⛔⛔ AND THE FIRST VERSION OF THIS FILE WAS DEFEATABLE BY A COMMENT. It located each call with
// `src.indexOf('m.<key>({')` — the FIRST textual occurrence, comments included — and never asserted
// how many there were. Five one-line mutations of `lib/components/ui/Pager.svelte` were run against
// it. Only the first was caught:
//
//   1. plain revert to `{ shown, total }`                                    → RED   ✅
//   2. revert PLUS an HTML comment above it holding the old good call        → GREEN, 922/922
//   3. keep the good call, add a SECOND bad `m.pager_showing({ shown, total })` below → GREEN, 922/922
//   4. `shown: String(shown) /* num( locale.current */`                      → GREEN, 922/922
//   5. `shown: num(total, locale.current)` — the WRONG VARIABLE               → GREEN, 922/922
//
// Three fixes close all five:
//   · comments are stripped before the scan          (`$lib/test/source-scan`) → kills 2 and 4
//   · the call must appear EXACTLY ONCE                                       → kills 3
//   · the argument EXPRESSION is pinned, not just probed for `num(`           → kills 5
// #5 is why `ARGS` records source text rather than a `params: string[]`: "contains `num(`" and
// "contains `locale.current`" are both true of a figure grouped from the wrong variable, and
// "showing 1.207 of 1.207" is a sentence that looks correct while stating something false.
//
// ⚠️ PINNING SOURCE TEXT MAKES A REFORMAT RED. That is the accepted cost and the failure is loud
// and obvious (the diff prints both strings); whitespace is normalized so only a real edit reds.
// The same technique as `routes/translations/translations-page.override-prefill.test.ts`, which
// already asserts on this repo's `+page.svelte` source text.
//
// ⛔ THE SECOND HALF OF THIS FILE IS THE MORE IMPORTANT ONE. Grouping the wrong number ships a NEW
// defect, and the candidates are all in these same files: `num(2026)` is "2.026" for a YEAR,
// `num(1207)` is "1.207" for a VERSION or a LINE NUMBER or a PAGE, and the reader has no way to
// tell the separator from a decimal point. Those exclusions are asserted as explicitly as the
// inclusions.
// ⛔⛔⛔⛔ AND THE LIST ITSELF WAS NEVER CHECKED — WHICH IS THE ROOT CAUSE, NOT THE INDIVIDUAL SITES.
// Every entry below is asserted. `GROUPED` was not: eighteen entries a human typed, with nothing
// anywhere claiming eighteen was all of them. Two whole classes were therefore invisible, one of
// them inside a file this change edited:
//
//   · `routes/challenges/+page.svelte:218` rendered `<span class="chip-count">{countFor(d.v)}</span>`
//     — "11774" — while :272, a line THIS FILE'S OWN COMMIT edited, rendered "11.774" through
//     `num()`. Same file, same screen, both spellings.
//   · `lib/components/build/ChallengeDataPanel.svelte:101` rendered `{it.rowCount}` raw while
//     `routes/connectors/+page.svelte:433` rendered THE SAME FIELD through `num()` — precisely the
//     same-field-different-file inconsistency this change's commit message cites as its own proof.
//
// Numbers rendered straight into markup had no guard of any kind: `GROUPED` only ever described
// numbers passed INTO messages. The final describe block closes both by checking the inventory
// against a SCAN (`$lib/test/number-sites`) rather than against a reader's memory: every numeric
// site the scan finds must be either formatted or written down below with a reason, and the
// comparison is an equality, so a stale entry reds just as loudly as a missing one.
import { describe, it, expect } from 'vitest';
import { readSource } from '$lib/test/source-scan';
import {
	isFormatted,
	messageParamSites,
	numericIdentifiers,
	numericVocabulary,
	rel,
	sourceFiles,
	textRenderSites
} from '$lib/test/number-sites';

/** Collapse runs of whitespace, so a prettier line-wrap is not a failure but an edit is. */
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * The argument object of `m.<key>({ … })`, as source text with comments already removed.
 *
 * ⛔ EXACTLY ONE OCCURRENCE. Without this, evasion 3 above — leave the good call in place and add a
 * second, raw one below it — passes every assertion in this file, because `indexOf` finds the good
 * one and stops. A key that legitimately renders twice gets its own explicit test (see
 * `home_activity_showing_of`), which is the honest way to say "two, and here is why".
 *
 * Brace-matched rather than regexed, because several of these calls are multi-line and contain
 * nested `${…}` template literals.
 */
function callArgs(src: string, key: string): string {
	const occurrences = src.split(`m.${key}({`).length - 1;
	expect(
		occurrences,
		occurrences === 0
			? `no call to m.${key}({ … }) found — the site moved, was renamed, or is now inside a comment`
			: `m.${key}({ … }) appears ${occurrences} times; a second call site is a second chance to render the raw number. Give it its own assertion.`
	).toBe(1);
	const open = src.indexOf(`m.${key}({`);
	let depth = 0;
	for (let i = src.indexOf('{', open); i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
	}
	throw new Error(`unbalanced braces in the call to m.${key}`);
}

/**
 * `count: num(x, locale.current)` — the param's VALUE, as source text.
 *
 * ⚠️ ES SHORTHAND (`{ page, totalPages }`) RESOLVES TO THE NAME ITSELF, which is the honest answer:
 * a shorthand property is by definition an unwrapped local, and three of the exclusions below are
 * written that way. Treating a missing `page:` as "the site vanished" would have turned the
 * strongest assertions in this file — the ones that stop a page NUMBER acquiring a separator — into
 * errors that get deleted rather than read.
 */
function paramValue(args: string, param: string): string {
	const at = args.indexOf(`${param}:`);
	if (at === -1) {
		const shorthand = new RegExp(`[{,]\\s*${param}\\s*[,}]`).test(args);
		expect(shorthand, `m.… has no "${param}" parameter any more`).toBe(true);
		return param;
	}
	const rest = args.slice(at + param.length + 1);
	let depth = 0;
	for (let i = 0; i < rest.length; i++) {
		const c = rest[i];
		if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') {
			if (depth === 0) return rest.slice(0, i);
			depth--;
		} else if (c === ',' && depth === 0) return rest.slice(0, i);
	}
	return rest;
}

/**
 * Every Tier-1 site: a figure that can exceed 999 in a real workspace, handed to an ICU message as
 * a parameter. `args` is the EXPECTED source expression per parameter — see the wrong-variable
 * evasion above. `cap` records WHY each one gets there, so a future reader can re-check the premise
 * rather than trust the list.
 */
const GROUPED: Array<{ file: string; key: string; args: Record<string, string>; cap: string }> = [
	// The catalogue is 1682 keys × 7 target locales ≈ 11 774 jobs.
	{ file: 'routes/translations/+page.svelte', key: 'tr_queued', cap: '≈11 774 queued',
		args: { count: 'num(queued, locale.current)' } },
	{ file: 'routes/translations/+page.svelte', key: 'tr_ran', cap: 'one run walks the same set',
		args: { processed: 'num(r.processed, locale.current)', failed: 'num(r.failed, locale.current)', deferred: 'num(r.deferred, locale.current)' } },
	{ file: 'routes/translations/+page.svelte', key: 'tr_jobs_truncated', cap: 'total is the whole job table',
		args: { shown: 'num(data.jobs.length, locale.current)', total: 'num(data.jobsTotal, locale.current)' } },
	// DATASET_INJECT_ROW_CAP = 10_000 (backend/src/db/dataset-types.ts).
	{ file: 'routes/connectors/+page.svelte', key: 'connectors_sync_truncated', cap: 'row cap 10 000',
		args: { rows: 'num(n.rows ?? 0, locale.current)', truncated: 'num(n.truncated ?? 0, locale.current)' } },
	{ file: 'routes/connectors/+page.svelte', key: 'connectors_sync_ok', cap: 'row cap 10 000',
		args: { rows: 'num(n.rows ?? 0, locale.current)' } },
	{ file: 'routes/connectors/+page.svelte', key: 'connectors_reconcile_result', cap: 'per-tenant connector sweep',
		args: { checked: 'num(r.checked, locale.current)', repaired: 'num(r.repaired, locale.current)' } },
	{ file: 'routes/governance/+page.svelte', key: 'governance_export_rows', cap: 'an audit export is unbounded',
		args: { count: 'num(last.rowCount, locale.current)' } },
	{ file: 'routes/(tenant)/usage/+page.svelte', key: 'admin_usage_legacy_pricing_note', cap: 'legacy-priced CALLS over 30 days',
		args: { count: 'num(legacyCalls, locale.current)' } },
	// tokensIn/tokensOut are 4–5 digits by construction on any real LLM call.
	{ file: 'lib/components/build/RunConsole.svelte', key: 'console_trace_cost', cap: 'token counts',
		args: { calls: 'num(c.llmCalls, locale.current)', tokensIn: 'num(c.tokensIn, locale.current)', tokensOut: 'num(c.tokensOut, locale.current)' } },
	{ file: 'lib/components/block-edit/BlockSimulate.svelte', key: 'blocksim_duration', cap: 'milliseconds',
		args: { ms: 'num(result.durationMs, locale.current)' } },
	// Pager / "showing N of M" totals — M is the whole result set on every one of these screens.
	{ file: 'routes/+page.svelte', key: 'home_activity_voted_on', cap: 'lifetime votes',
		args: { count: 'num(votedOnTotal, locale.current)' } },
	{ file: 'routes/challenges/+page.svelte', key: 'challenges_pager_showing', cap: 'board total',
		args: { shown: 'num(list.items.length, locale.current)', total: 'num(list.total, locale.current)' } },
	// ⛔ THE BACK CATALOGUE BEHIND THE DEFAULT FILTER — the same board `challenges_pager_showing`
	// totals one line down, so leaving it raw would put "11774" and "11.774" on one screen for one
	// query. ⚠️ `allBoardTotal ?? 0`, NOT `list.total` and NOT `list.counts.all`: both of those are
	// computed UNDER the open filter (the route applies the `open` predicate to the counts query
	// too), so on the only board that renders this sentence they are both exactly 0 — the
	// wrong-variable evasion this file pins source text to close, in its most convincing form.
	{ file: 'routes/challenges/+page.svelte', key: 'challenges_empty_open_all', cap: 'the whole back catalogue the default filter is hiding',
		args: { count: 'num(allBoardTotal ?? 0, locale.current)' } },
	{ file: 'routes/datasets/+page.svelte', key: 'datasets_pager_showing', cap: 'dataset total',
		args: { shown: 'num(list.items.length, locale.current)', total: 'num(list.total, locale.current)' } },
	{ file: 'routes/sandboxes/+page.svelte', key: 'sandboxes_pager_showing', cap: 'sandbox total',
		args: { shown: 'num(list.items.length, locale.current)', total: 'num(list.total, locale.current)' } },
	{ file: 'lib/components/ui/Pager.svelte', key: 'pager_showing', cap: 'the shared pager',
		args: { shown: 'num(shown, locale.current)', total: 'num(total, locale.current)' } },
	{ file: 'routes/(platform)/tenants/+page.svelte', key: 'admin_pager_showing', cap: 'platform-wide tenant list',
		args: { from: 'num(offset + 1, locale.current)', to: 'num(shownTo, locale.current)', total: 'num(total, locale.current)' } },
	{ file: 'routes/solutions/+page.svelte', key: 'solutions_selector_capped', cap: 'every challenge in the workspace',
		args: { shown: 'num(challengeChoices.length, locale.current)', total: 'num(choicesTotal, locale.current)' } },
	// ⛔ `shown.length` / `total`, NOT `maxRows` / `rows.length` — and the rename is the POINT, not
	// churn. The old pair could not both be right: the server caps the array at the requested limit,
	// so `rows.length > maxRows` asked `50 > 50` and the notice never fired ANYWHERE (all five mount
	// sites). `shown.length` is the number of `<tr>`s actually above the notice, and `total` is the
	// figure the reader is being surprised by (`totalRows ?? rows.length`). Both still go through
	// `num()`, which is the only property this guard exists to protect.
	{ file: 'lib/components/DatasetPreviewTable.svelte', key: 'dataset_preview_more', cap: 'row cap 10 000',
		args: { shown: 'num(shown.length, locale.current)', total: 'num(total, locale.current)' } },
	// The SECOND site of that same sentence, added when /connectors' preview drawer stopped hiding
	// its ceiling. It renders the connector's own `rowCount` — the identical figure the row above it
	// in the same table already groups (`routes/connectors/+page.svelte`'s `<td class="num">`), so
	// leaving it raw would put "10.000" and "10000" on ONE screen for ONE number. That page has
	// shipped exactly that self-contradiction before; see connectors-notice.locale-numbers.render.test.ts.
	{ file: 'routes/connectors/+page.svelte', key: 'dataset_preview_more', cap: 'the preview ceiling on a connector, beside the grouped rowCount in the same drawer',
		args: { shown: 'num(selected.rows.length, locale.current)', total: 'num(selected.rowCount, locale.current)' } },
	// ⛔ A SAME-FILE MISS OF THE EXACT CLASS THE FIX EXISTS TO REMOVE. `routes/sandboxes/+page.svelte`
	// renders `num(s.llmCallsToday, locale.current)` in its table (:289) and detail pane (:344) and
	// shipped this one RAW two hundred lines away, so a Dutch reader saw "1.207" and
	// "LLM-aanroepen: 1207" on ONE screen — the same self-contradiction connectors/+page.svelte had.
	// It is a PLAIN message (no plural machinery), so mechanism A applies: `num()` at the call site.
	{ file: 'routes/sandboxes/+page.svelte', key: 'sandboxes_run_llm_calls', cap: 'brokered calls per run, beside a grouped figure on the same screen',
		args: { count: 'num(r.llmCalls, locale.current)' } },

	// ⛔ THE FOURTEEN THE COMPLETENESS SCAN FOUND. Not one of them is a new KIND of site — they are
	// the same "plain message, cardinal quantity, no structural bound" shape as the eighteen above,
	// and they were missed for the only reason a hand-written list ever misses anything: nobody
	// looked. They are listed here rather than merely tolerated by the scan so that each one's
	// revert reds by NAME, and so the wrong-variable evasion is closed for them too.
	{ file: 'lib/components/build/EntityDeriveBrowser.svelte', key: 'blockedit_derive_attrs', cap: 'attributes on a derived entity',
		args: { count: 'num(e.attributes.length, locale.current)' } },
	{ file: 'lib/components/build/EntityDeriveBrowser.svelte', key: 'blockedit_derive_pii', cap: 'PII attributes, same chip row as the count above',
		args: { count: 'num(piiCount(e), locale.current)' } },
	{ file: 'lib/components/build/FlowHistoryPanel.svelte', key: 'flow_history_nodes', cap: 'graph size of a saved flow',
		args: { nodes: 'num(s.node_count, locale.current)', edges: 'num(s.edge_count, locale.current)' } },
	{ file: 'lib/components/build/NodeConfigPanel.svelte', key: 'nodecfg_ontology_coverage', cap: 'DATASET COLUMNS — the same figure /datasets grouped',
		args: { mapped: 'num(cols.length, locale.current)', total: 'num(preview.columns.length, locale.current)' } },
	{ file: 'lib/components/block-edit/BlockTesting.svelte', key: 'blockedit_test_passing_count', cap: 'a block’s test suite',
		args: { pass: 'num(passCount, locale.current)', total: 'num(tests.length, locale.current)' } },
	{ file: 'routes/block-edit/+page.svelte', key: 'blockedit_import_ontology_done', cap: 'outputs imported in one go',
		args: { count: 'num(added.length, locale.current)' } },
	{ file: 'routes/block-edit/+page.svelte', key: 'blockedit_lint_issues', cap: 'lint findings on one block, uncapped',
		args: { count: 'num(lintFindings.length, locale.current)' } },
	{ file: 'routes/challenges/[id]/+page.svelte', key: 'challenge_detail_solutions_title', cap: 'every solution on a challenge',
		args: { count: 'num(data.solutions.length, locale.current)' } },
	{ file: 'routes/ontology/+page.svelte', key: 'ontology_entities_count', cap: 'a real ontology is hundreds of entities',
		args: { count: 'num(ontology.entities.length, locale.current)' } },
	{ file: 'routes/ontology/+page.svelte', key: 'ontology_relations_count', cap: 'relations outnumber entities',
		args: { count: 'num(ontology.relations.length, locale.current)' } },
	// ⚠️ THE PINNED EXPRESSION MOVED OFF `data.flow.chain.length` DELIBERATELY, AND THIS IS NOT A
	// LOOSENING. The caption counts the chips the reader can actually see, and the chip list is no
	// longer `data.flow.chain` verbatim: `normalizeChain` (lib/solutions/flow-chain.ts) drops the
	// `foreach` control-flow token the library has no row for, so the raw wire length overcounts a
	// looping flow by one chip per loop — "5 blokken" over four chips. `chainNodes` IS the rendered
	// list (`$derived(normalizeChain(...))`, :110) and is what `FlowChain` and `RunConsole`'s
	// `nodeCount` are both fed on the same screen. Grouping the PRE-filter number here would be
	// exactly the wrong-variable evasion this file pins source text to close.
	{ file: 'routes/solutions/[id]/+page.svelte', key: 'solution_detail_flow_cap', cap: 'blocks in the winning flow',
		args: { count: 'num(chainNodes.length, locale.current)' } },
	// The list row's seat cell (an uncapped tenant reads "N / unlimited" — it used to be
	// `tenant_member_count`, now unused on this screen) and the same figures on /tenants/<id>.
	{ file: 'routes/(platform)/tenants/+page.svelte', key: 'admin_tenants_seats_used_unlimited', cap: 'seats (members + pending invites) of one uncapped tenant',
		args: { used: 'num(seatsUsedOf(t), locale.current)' } },
	{ file: 'routes/(platform)/tenants/+page.svelte', key: 'admin_tenants_seats_used', cap: 'seat usage on the platform tenant list',
		args: { used: 'num(seatsUsedOf(t), locale.current)', max: 'num(t.maxMembers, locale.current)' } },
	{ file: 'routes/(platform)/tenants/[id]/+page.svelte', key: 'admin_tenants_seats_used_unlimited', cap: 'seats (members + pending invites) of one uncapped tenant, its own page',
		args: { used: 'num(seatsUsedOf(t), locale.current)' } },
	{ file: 'routes/(platform)/tenants/[id]/+page.svelte', key: 'admin_tenants_seats_used', cap: 'seat usage on the tenant page',
		args: { used: 'num(seatsUsedOf(t), locale.current)', max: 'num(t.maxMembers, locale.current)' } },
	{ file: 'routes/(tenant)/members/+page.svelte', key: 'admin_members_seats', cap: 'the same seat figures, tenant-side',
		args: { used: 'num(seats.used, locale.current)', max: 'num(seats.max, locale.current)' } },

	// ⛔ THE ONE THE `$derived` HOLE HID. `build/ForeachNode.svelte`'s `maxIter` is an un-annotated
	// `$derived(data.loop?.maxIterations ?? null)`, invisible to every declaration pattern the scan
	// had — and `?? null` also walks straight past the `?? <digit>` catch that covers un-annotated
	// arrows. Its parameter is called `count`, which is what a plural message's parameter is called,
	// so the first question is whether raw is the correct answer here. It is not:
	// `foreach_iter_badge` is a PLAIN string in the base catalog ("× up to {count}"), not one of the
	// ten plurals asserted in `icu-number-params.test.ts`, so nothing runs `Number()` over it.
	// And the figure is genuinely four digits: `HARD_MAX_ITERATIONS` is 1000 and `setMaxIter` clamps
	// to it, so the ceiling an operator can set is the exact value that needs a separator.
	{ file: 'lib/components/build/ForeachNode.svelte', key: 'foreach_iter_badge', cap: 'loop bound, clamped to HARD_MAX_ITERATIONS = 1000',
		args: { count: 'num(maxIter, locale.current)' } },
	// routes/+error.svelte — the root error boundary's status line. Not a genuine grouping need
	// (an HTTP status is at most 3 digits, so `num()` can never add a thousands separator here); it
	// is wrapped anyway so the DIGITS themselves are pinned to `latn` — the same reason every other
	// figure in this app goes through `num()` rather than a bare interpolation, and consistent with
	// this file's own `page.status` value never having a raw render site anywhere in the tree.
	{ file: 'routes/+error.svelte', key: 'error_page_status', cap: 'the HTTP status shown to a demo operator reporting "it broke"',
		args: { status: 'num(page.status, locale.current)' } }
];

/**
 * ⛔ THE DIRECT-RENDER HALF — a number written straight into markup, with no message around it.
 *
 * #256 swept the message-parameter half and stopped there, so this whole class had no guard at all:
 * `<span class="chip-count">{countFor(d.v)}</span>` printed "11774" on /challenges fifty-four lines
 * above a `num()`-grouped "11.774" in the same file. The expected mustache is pinned as source text
 * for the same reason `GROUPED`'s arguments are — `.toContain('num(')` is satisfied by grouping the
 * wrong variable, and "11.774 of 11.774" is a sentence that looks right and is false.
 */
const DIRECT_RENDER: Array<{ file: string; text: string; why: string }> = [
	// Chip counts. The board is filtered by the chip you have NOT clicked, so with `Alle`/`All`
	// active these span the whole back catalogue — 11 774 translation jobs' worth of rows on the
	// biggest of them.
	{ file: 'routes/challenges/+page.svelte', why: 'domain chip, whole board',
		text: '<span class="chip-count">{num(countFor(d), locale.current)}</span>' },
	{ file: 'routes/challenges/+page.svelte', why: 'off-list domain chip, same row',
		text: '<span class="chip-count">{num(countFor(extra), locale.current)}</span>' },
	{ file: 'routes/blocks/+page.svelte', why: 'category chip over the block catalogue',
		text: '<span class="chip-count">{num(countFor(c.key), locale.current)}</span>' },
	{ file: 'routes/sandboxes/+page.svelte', why: 'status chip over every sandbox',
		text: '<span class="chip-count">{num(tabCount(t.key), locale.current)}</span>' },
	{ file: 'routes/audit/+page.svelte', why: 'category chip over an unbounded audit feed',
		text: '<span class="chip-n">{num(countFor(chip.key), locale.current)}</span>' },
	// Dataset row counts — DATASET_INJECT_ROW_CAP is 10 000, so four digits is the NORMAL case, and
	// `routes/connectors/+page.svelte` already grouped this exact field.
	{ file: 'lib/components/build/ChallengeDataPanel.svelte', why: 'rowCount, grouped by connectors/+page.svelte',
		text: '<span class="dp-meta">{num(it.rowCount, locale.current)}</span>' },
	{ file: 'lib/components/DatasetPicker.svelte', why: 'rowCount in the picker list',
		text: '<span class="picker-meta">{num(ds.rowCount, locale.current)} {m.connectors_rows_word()}</span>' },
	{ file: 'lib/components/DatasetPicker.svelte', why: 'rowCount in the single-select fallback',
		text: '{ds.name} ({num(ds.rowCount, locale.current)} {m.connectors_rows_word()})' },
	{ file: 'routes/challenges/[id]/+page.svelte', why: 'rowCount on the challenge’s datasets',
		text: '<span class="ds-meta">{num(ds.rowCount, locale.current)} {m.connectors_rows_word()}</span>' },
	{ file: 'routes/submit/+page.svelte', why: 'rowCount on the datasets being attached',
		text: '<span class="ds-pick-meta">{num(ds.rowCount, locale.current)} {m.connectors_rows_word()}</span>' },
	{ file: 'routes/ontology/+page.svelte', why: 'rowCount of a sample dataset',
		text: '<span class="sample-rows">{num(s.rowCount, locale.current)} {m.ontology_testdata_rows()}</span>' },
	// Figures that sat in the same row or the same card as an already-grouped one.
	{ file: 'routes/datasets/+page.svelte', why: 'column count, in the cell beside num(d.rowCount)',
		text: '<td class="num">{num(d.columns.length, locale.current)}</td>' },
	{ file: 'routes/block-edit/+page.svelte', why: 'version count, in the tile beside num(usageCount)',
		text: '<div class="stat-n">{num(detail!.versions.length, locale.current)}</div>' },
	{ file: 'routes/block-edit/+page.svelte', why: 'attributes on an importable entity',
		text: '{e.label} ({num(e.attributes.length, locale.current)})' },
	{ file: 'routes/winner/+page.svelte', why: 'hero stat tile, beside demoDuration()',
		text: '<span class="ws-val">{num(data.winner.solution.blocksUsed.length, locale.current)}</span>' },
	{ file: 'lib/components/ops/Sparkline.svelte', why: 'runs per hour, in the tooltip beside hourMinute()',
		text: '<b>{num(buckets[hovered].activeRuns, locale.current)}</b>' },
	{ file: 'lib/components/ops/Sparkline.svelte', why: 'LLM calls per hour, same tooltip',
		text: '<b>{num(buckets[hovered].llmCalls, locale.current)}</b>' },
	// ⛔ THE TWO AXIS LABELS THE `$derived` HOLE HID, AND THEY ARE THE SHARPEST INSTANCE OF THIS
	// WHOLE DEFECT IN THE APP. `max` is `$derived(Math.max(1, …))` in both components — no
	// annotation, so the scan could not see the local, so the site never reached a classification.
	// In `Sparkline` the raw label sat THIRTEEN LINES above the two grouped tooltip rows directly
	// above, printing the same peak: "1207" on the axis, "1.207" in the popup that explains the
	// axis. `BlockUsageTrend` is the same shape one screen away (block-edit → Usage stats), grouped
	// in its tooltip at `blockedit_usage_trend_runs` and raw on its scale.
	{ file: 'lib/components/ops/Sparkline.svelte', why: 'y-axis peak, the same figure the tooltip above already groups',
		text: '<span class="axis-max">{num(max, locale.current)}</span>' },
	{ file: 'lib/components/block-edit/BlockUsageTrend.svelte', why: 'y-axis peak, grouped in this component’s own tooltip',
		text: '<span class="axis-max">{num(max, locale.current)}</span>' },
	// ⚠️ NOT FOUND BY THE SCAN — PINNED BY HAND, AND THE HOLE IS NAMED. `HARD_MAX_ITERATIONS` is
	// `export const HARD_MAX_ITERATIONS = 1000` in `stores/builder-graph.ts`: no type annotation, and
	// IMPORTED, so it is neither a field nor a local of this file and no pattern in `number-sites.ts`
	// can reach it. It is exactly 1000 — "1.000" in nl/de — and it renders in the foreach inspector
	// while the node it configures shows the grouped `× tot 1.000` badge beside it. The general fix
	// is cross-module const inference, which is a scan of a different shape; this entry is the
	// compensating control until someone builds it.
	{ file: 'lib/components/build/NodeConfigPanel.svelte', why: 'HARD_MAX_ITERATIONS = 1000, beside the grouped foreach badge',
		text: '<span class="field-type">≤ {num(HARD_MAX_ITERATIONS, locale.current)}</span>' },
	{ file: 'lib/components/ops/KanbanColumn.svelte', why: 'cards in a pipeline column',
		text: '<span class="kan-count">{num(column.count, locale.current)}</span>' },
	// ⛔ THE NAV BADGE IS GROUPED THOUGH IT WILL USUALLY READ "3". Grouping a 3 gains the reader
	// nothing; the point is that `counts` is a `Record<string, number>` straight off `/api/me` with
	// no cap anywhere, so the day one of them reaches four digits the badge must not be the one
	// place in the app that spells it wrong. The `!` is safe: the `{#if badgeCount(item) !== null}`
	// directly above is what decides the badge renders at all.
	{ file: 'lib/layout/Sidebar.svelte', why: 'uncapped /api/me count',
		text: '{num(badgeCount(item)!, locale.current)}' },
	// Platform-wide onboarding totals: every request ever made, across every tenant.
	{ file: 'routes/(platform)/onboarding/+page.svelte', why: 'pending requests, platform-wide',
		text: '<span class="sv">{num(stats.pending, locale.current)}</span>' },
	{ file: 'routes/(platform)/onboarding/+page.svelte', why: 'approved, platform-wide',
		text: '<span class="sv">{num(stats.approved, locale.current)}</span>' },
	{ file: 'routes/(platform)/onboarding/+page.svelte', why: 'rejected, platform-wide',
		text: '<span class="sv">{num(stats.rejected, locale.current)}</span>' },
	{ file: 'routes/(platform)/onboarding/+page.svelte', why: 'the total of the three above',
		text: '<span class="sv">{num(stats.total, locale.current)}</span>' },
	// The translation coverage grid. `tr_queued` on this very page was already grouped at ≈11 774
	// queued jobs — these three columns COUNT THE SAME JOBS and were printed raw beside it.
	{ file: 'routes/translations/+page.svelte', why: 'pending jobs per locale, beside a grouped tr_queued',
		text: '<span class="num">{num(data.stats.byLocale[loc].pending, locale.current)}</span>' },
	{ file: 'routes/translations/+page.svelte', why: 'done jobs per locale',
		text: '<span class="num done">{num(data.stats.byLocale[loc].done, locale.current)}</span>' },
	{ file: 'routes/translations/+page.svelte', why: 'failed jobs per locale',
		text: '<span class="num fail">{num(data.stats.byLocale[loc].failed, locale.current)}</span>' }
];

describe('the Tier-1 ICU number parameters are grouped in the reader’s locale', () => {
	for (const { file, key, args: expected, cap } of GROUPED) {
		it(`${file} → m.${key} (${cap})`, () => {
			const args = callArgs(readSource(file), key);
			for (const [p, want] of Object.entries(expected)) {
				const value = norm(paramValue(args, p));
				// These two run first so a plain revert fails with the sentence that explains itself,
				// rather than with a string diff.
				expect(value, `${key}.${p} is interpolated raw`).toContain('num(');
				// ⛔ `locale.current` READ AT THE CALL SITE, not a locale imported inside a helper.
				// That read is what puts the figure in the same reactive graph as the sentence around
				// it — see the switch test in dataset-preview.locale-numbers.render.test.ts.
				expect(value, `${key}.${p} does not read the app locale`).toContain('locale.current');
				// ⛔ …AND IT GROUPS THE RIGHT VARIABLE. `shown: num(total, locale.current)` satisfies
				// both assertions above and renders "showing 1.207 of 1.207": a sentence that looks
				// right and is false. Nothing else in the repo can see that.
				expect(value, `${key}.${p} groups the wrong expression`).toBe(want);
			}
		});
	}

	it('⛔ home_activity_showing_of is wrapped at BOTH of its call sites, not just the first', () => {
		// routes/+page.svelte renders this key twice — "submitted" and "voted on". A one-site fix
		// here is invisible: the two lists sit in adjacent columns of the same card. This is the
		// explicit exception to the exactly-once rule in `callArgs`, stated rather than tolerated.
		const src = readSource('routes/+page.svelte');
		const calls = src.split('m.home_activity_showing_of(').slice(1);
		expect(calls, 'the key is no longer rendered twice — re-check this assertion').toHaveLength(2);
		const heads = calls.map((c) => c.slice(0, c.indexOf('})') + 2));
		// One call totals the submitted list, the other the voted-on list; both `shown` and both
		// `total` figures must be grouped, or the card contradicts itself column to column.
		expect(heads[0]).toContain('num(data.yourActivity.submitted.length, locale.current)');
		expect(heads[0]).toContain('num(submittedTotal, locale.current)');
		expect(heads[1]).toContain('num(data.yourActivity.votedOn.length, locale.current)');
		expect(heads[1]).toContain('num(votedOnTotal, locale.current)');
	});
});

describe('⛔ THE TEN PLURAL MESSAGES ARE FIXED IN THE CATALOG — never at the call site', () => {
	// Passing `num()` into any of these breaks the plural selector: `registry.plural` does
	// `Number(input)`, so "1.000" becomes 1 (German singular for a thousand) and "1,207" becomes
	// NaN (Arabic's few/many unreachable, and `Intl` then prints the literal words "not a number").
	// The catalogs declare a second `countNum = count: number` local instead. Measured, with the
	// resulting strings, in `icu-number-params.test.ts` — which also asserts this list is EVERY
	// plural message in the base catalog, so a new one cannot arrive unguarded.
	//
	// The expected expression is pinned here for the same reason it is pinned above, in the
	// opposite direction: `not.toContain('num(')` is satisfied by `count: 0`, by a wrong field, and
	// by a constant.
	const PLURAL_SITES: Array<{ file: string; key: string; value: string }> = [
		{ file: 'routes/audit/+page.svelte', key: 'audit_event_count', value: 'feed.total' },
		{ file: 'routes/block-edit/+page.svelte', key: 'blockedit_impl_head', value: 'lineCount' },
		{ file: 'lib/i18n/data-finding-label.ts', key: 'data_finding_type_mismatch', value: 'finding.count' },
		{ file: 'lib/i18n/ops-alert-label.ts', key: 'ops_alert_sandbox_error_title', value: 'item.errorCount' },
		{ file: 'lib/i18n/ops-alert-label.ts', key: 'ops_alert_block_errors_detail', value: 'item.runCount' },
		// The ones that mechanism B reached only in the follow-up (`console_ready` was one, until the
		// run panel's idle line became the plain `build_result_idle`), and `mkt_solutions_count` renders on the
		// leaderboard row DIRECTLY BESIDE `num(row.votesCount, locale.current)`.
		{ file: 'routes/challenges/[id]/+page.svelte', key: 'challenge_detail_discussion', value: 'data.commentCount' },
		{ file: 'lib/components/build/RunConsole.svelte', key: 'console_trace_run_started', value: 'ev.nodeCount' },
		{ file: 'lib/components/build/StepOutput.svelte', key: 'build_output_rows', value: 'count' },
		{ file: 'lib/components/marketplace/LeaderboardRow.svelte', key: 'mkt_solutions_count', value: 'row.solutionsCount' },
		// First call site in the file is the 409 `plan_in_use` banner (`e.details.tenantCount`).
		{ file: 'routes/(platform)/plans/+page.svelte', key: 'admin_plans_in_use', value: 'n' }
	];
	for (const { file, key, value } of PLURAL_SITES) {
		it(`${file} → m.${key} still passes a raw number`, () => {
			const actual = norm(paramValue(callArgs(readSource(file), key), 'count'));
			expect(actual, `${key}.count was wrapped — this breaks the plural selector`).not.toContain(
				'num('
			);
			expect(actual, `${key}.count no longer passes the count it used to`).toBe(value);
		});
	}
});

describe('⛔ THE EXCLUSIONS: numbers that must NOT acquire a thousands separator', () => {
	// Each of these lives in a file this change edited or sits one line from one that did, so
	// "while I am here" is exactly how they would have been swept up. `num(2026)` is "2.026" in
	// nl/de — a year with a decimal point in it.
	const EXCLUDED: Array<{ file: string; key: string; args: Record<string, string>; why: string }> = [
		{ file: 'lib/challenges/challenge-state.ts', key: 'challenge_period_week', why: 'a YEAR: num(2026) reads "2.026"',
			args: { year: 'p.year' } },
		{ file: 'lib/challenges/challenge-state.ts', key: 'challenge_period_quarter', why: 'a YEAR and a quarter number 1–4',
			args: { year: 'p.year', quarter: 'p.quarter' } },
		{ file: 'lib/i18n/ops-event-label.ts', key: 'ops_event_block_published', why: 'a VERSION is an identifier',
			args: { version: 'item.version' } },
		{ file: 'routes/challenges/+page.svelte', key: 'challenges_pager_page', why: 'ORDINALS, and small',
			args: { page: 'page', totalPages: 'totalPages' } },
		{ file: 'routes/datasets/+page.svelte', key: 'datasets_pager_page', why: 'ORDINALS',
			args: { page: 'page', totalPages: 'totalPages' } },
		{ file: 'lib/components/ui/Pager.svelte', key: 'pager_page', why: 'ORDINALS',
			args: { page: 'page', totalPages: 'totalPages' } },
		{ file: 'lib/i18n/ops-alert-label.ts', key: 'ops_alert_block_errors_detail', why: 'BLOCK_ERROR_WINDOW_DAYS, a compile-time 7',
			args: { days: 'item.windowDays' } }
	];
	for (const { file, key, args: expected, why } of EXCLUDED) {
		it(`${file} → m.${key}.${Object.keys(expected).join('/')} stays raw — ${why}`, () => {
			const args = callArgs(readSource(file), key);
			for (const [p, want] of Object.entries(expected)) {
				const value = norm(paramValue(args, p));
				expect(value, `${key}.${p} was grouped`).not.toContain('num(');
				expect(value, `${key}.${p} no longer passes what it used to`).toBe(want);
			}
		});
	}

	it('⛔ the usage CSV stays locale-invariant — a machine reads it, not a person', () => {
		// A ',' decimal separator inside a comma-separated file is a corrupt export, and a
		// thousands-separated integer is one a spreadsheet imports as text. `usage-csv.ts` must
		// therefore keep `toFixed`, which is the one place in this codebase where that is right.
		const src = readSource('lib/utils/usage-csv.ts');
		expect(src).toContain('toFixed(4)');
		expect(src, 'the CSV writer started formatting for a reader').not.toContain('num(');
	});
});

describe('⛔ every `ms()` call site passes the reader’s locale', () => {
	// `ms()` was the same hard-coded '.' defect as `demoDuration`'s — `(n / 1000).toFixed(2)` — and
	// it is imported on the same line of RunConsole.svelte that the ICU fix edited, which is how it
	// survived. `locale` is now a required parameter, so `svelte-check` reds a caller that drops it
	// entirely; this states WHICH locale, which the type cannot.
	const MS_SITES: Array<{ file: string; call: string }> = [
		{ file: 'routes/it-dash/+page.svelte', call: 'ms(data.stats.p95LatencyMs, locale.current)' },
		{ file: 'lib/components/build/RunConsole.svelte', call: 'ms(ev.durationMs, locale.current)' },
		{ file: 'lib/components/build/RunConsole.svelte', call: 'ms(ev.totalMs, locale.current)' },
		{ file: 'routes/sandboxes/+page.svelte', call: 'ms(r.totalMs, locale.current)' },
		// A plain `.ts` module cannot read the rune, so it takes the tag and AlertItem passes it —
		// the same shape `cadence-day.ts` and `$lib/utils/format` already use.
		{ file: 'lib/i18n/ops-alert-label.ts', call: 'ms(item.p95Ms, locale)' },
		{ file: 'lib/i18n/ops-alert-label.ts', call: 'ms(item.thresholdMs, locale)' },
		{ file: 'lib/components/ops/AlertItem.svelte', call: 'opsAlertDetail(item, locale.current)' },
		// ⛔ FOUND BY THE `.toFixed(` ASSERTION BELOW, NOT BY READING. `gb()` was the THIRD instance
		// of the same one-line defect, and its table cell sits DIRECTLY ABOVE the already-grouped
		// `{num(s.llmCallsToday, locale.current)}` in the same row of /sandboxes.
		{ file: 'routes/sandboxes/+page.svelte', call: 'gb(s.memCapMb, locale.current)' },
		{ file: 'routes/sandboxes/+page.svelte', call: 'gb(selected.memCapMb, locale.current)' }
	];
	for (const { file, call } of MS_SITES) {
		it(`${file} → ${call}`, () => {
			expect(readSource(file)).toContain(call);
		});
	}

	it('⛔ EVERY `.toFixed(` IN THE WHOLE TREE IS ON THE LIST — the guard used to read one file', () => {
		// ⛔⛔ WHY THIS REPLACED A `format.ts`-ONLY GREP. The assertion this supersedes read exactly
		// one file, so FIVE `.toFixed(` sites outside it were structurally invisible to a test whose
		// whole job was to find them:
		//
		//   routes/(tenant)/llm-settings/+page.svelte   a second copy of `$${n.toFixed(2)}`
		//   routes/(platform)/tenants/+page.svelte      a third copy
		//   routes/datasets/+page.svelte                fmtBytes — measured as `1.2 KB` in Dutch
		//   lib/components/build/ChatPanel.svelte       a money figure on /build
		//   lib/components/build/RunConsole.svelte      whose own comment said it WAS pinned here
		//
		// That last one is the tell. `RunConsole.svelte`'s note read "Pinned as the single permitted
		// `.toFixed(` in `$lib/utils/format.ts` … so a FOURTH one cannot slip in". Read literally the
		// clause describes format.ts and is TRUE — it is a dangling referent, not a lie — but it sat
		// above a `.toFixed(4)` that nothing checked. A reader who trusted it stopped looking.
		//
		// ⚠️ AN EXACT {file,line} LIST, NOT A COUNT, and not a per-file grep: a count passes when one
		// site is deleted and another added, and a per-file grep is what got us here.
		//
		// ⚠️ `readSource` STRIPS COMMENTS, which is load-bearing — this module carries about a dozen
		// prose mentions of `.toFixed(` (including the paragraph you are reading) and every one of
		// them would otherwise red this test.
		// ⚠️ THE CODE TEXT, NOT A LINE NUMBER. `readSource` strips comments, so its line numbering does
		// NOT match the file on disk — an assertion failure quoting `usage-csv.ts:39` would send the
		// reader to the wrong line. The text is stable under comment edits and says what it found.
		// ⚠️ `.js` IS IN THE EXTENSION LIST, and `toFixed` is matched in every spelling. Adversarial
		// review defeated the first version four ways, each measured green: `n['toFixed'](1)`,
		// `n .toFixed (0)` (space before the paren), a `.toFixed(` inside a new `.js` module, and —
		// the one that matters most — the defect RE-EXPRESSED WITHOUT `toFixed` AT ALL. See the
		// second scan below for that.
		const TO_FIXED = /(?:\.\s*toFixed\s*\(|\[\s*['"`]toFixed['"`]\s*\])/;
		const hits: string[] = [];
		let svelteFilesScanned = 0;
		for (const abs of sourceFiles(/\.(ts|js|svelte)$/)) {
			const file = rel(abs);
			if (file.endsWith('.svelte')) svelteFilesScanned++;
			for (const line of readSource(file).split('\n')) {
				if (TO_FIXED.test(line)) hits.push(`${file} :: ${norm(line)}`);
			}
		}
		// ⛔ THE NON-VACUITY ANCHOR HAD TO BE SPLIT. `hits.length > 0` was satisfied by
		// `usage-csv.ts` ALONE — a `.ts` file — so narrowing the scan to `.ts` only, deleting every
		// `.svelte` file from coverage, left it GREEN. Three of the five sites this guard exists for
		// are `.svelte`. Measured by the review; the anchor now asserts the SHAPE of the scan.
		expect(svelteFilesScanned, 'the scan read no .svelte files — its whole point').toBeGreaterThan(20);
		// ⛔ NON-VACUITY. An all-`toEqual([])` guard passes when the scan reads nothing, which is the
		// failure mode this repo has hit before. `usage-csv.ts` is a permanent, deliberate member of
		// this list, so "the scan found nothing" cannot look like "the tree is clean".

		// The ONLY legitimate `.toFixed(` left in the tree. A CSV is read by a machine: a ',' decimal
		// separator inside a comma-separated file is a corrupt export and a grouped integer imports
		// as text. Pinned by line so a new one anywhere — including inside this file — reds by name.
		expect(hits, 'a hard-coded decimal separator appeared outside the usage CSV').toEqual([
			"lib/utils/usage-csv.ts :: ['summary', `Total (${rangeDays}d)`, data.stats.calls, data.stats.spendUsd.toFixed(4)]",
			"lib/utils/usage-csv.ts :: rows.push(['model', mdl.model, mdl.calls, mdl.spendUsd.toFixed(4)].map(esc).join(','));",
			"lib/utils/usage-csv.ts :: rows.push(['member', mem.name, mem.calls, mem.spendUsd.toFixed(4)].map(esc).join(','));"
		]);
	});

	it('⛔ NOBODY HAND-BUILDS A DOLLAR FIGURE — the defect needs no `toFixed` to come back', () => {
		// ⛔⛔ THE EVASION THAT MATTERS, and the one the `.toFixed(` scan above structurally cannot
		// see. Adversarial review put this in llm-settings/+page.svelte:
		//
		//     '$' + Math.round(budget.usageUsd * 100) / 100
		//
		// and the whole file stayed 93/93 GREEN. It is the deleted `money()` arrow re-expressed:
		// hard-coded glyph, hard-coded POSITION (wrong in de/fr/es/pl), en decimal point, no
		// grouping. Banning one spelling of one method was never the property worth guarding — the
		// property is that a `$` never gets welded to a value in application code.
		//
		// Matches both shapes a person reaches for: the template `` `$${…}` `` and the concatenation
		// `'$' +`. `usage-csv.ts` is NOT exempt here and does not need to be: a CSV writes a bare
		// number and lets the spreadsheet own the currency.
		const GLYPH_WELD = /\$\$\{|['"`]\s*\$\s*['"`]\s*\+|\+\s*['"`]\s*\$\s*['"`]/;
		const welds: string[] = [];
		for (const abs of sourceFiles(/\.(ts|js|svelte)$/)) {
			const file = rel(abs);
			for (const line of readSource(file).split('\n')) {
				if (GLYPH_WELD.test(line)) welds.push(`${file} :: ${norm(line)}`);
			}
		}
		// ⚠️ EMPTY IS THE CORRECT ANSWER HERE, which makes this an all-negative assertion — the shape
		// that passes on an empty scan. The `.toFixed(` test above already anchors that the scan
		// reads real files (>20 .svelte, plus the three pinned usage-csv lines), and both walk the
		// same `sourceFiles()`, so a stripper that ate the tree would red there first.
		expect(welds, 'a dollar glyph was welded to a value in application code — use usd()').toEqual([]);
	});

	it('the superseded format.ts-only assertion is gone, and usd() no longer hard-codes anything', () => {
		// The old assertion recorded a DECISION NOT TO FIX `usd()`: "a currency question, owned by
		// whoever owns that copy — not a rider on a separator fix." That decision has been taken. The
		// replacement pins the shape rather than the omission.
		const src = readSource('lib/utils/format.ts');
		expect(src, 'the scan read a format.ts with no formatters in it').toContain('export function usd(');
		expect(src, 'usd() went back to a hard-coded glyph and separator').not.toContain('.toFixed(');
		// `narrowSymbol` is the measured choice: the DEFAULT display emits US$ / $US / USD in four
		// catalogs, a copy change nobody asked for. Dropping it is a silent regression in fr/es/pl/nl.
		expect(src, 'the currency display reverted to the default (US$ / $US / USD)').toContain(
			"currencyDisplay: 'narrowSymbol'"
		);
		// `formatRange(n, n)` is what makes the approximation sign locale-correct — fr writes U+2243,
		// de U+2248, and nl puts it AFTER the symbol. A hand-rolled '~' is wrong in three of eight.
		expect(src, "usdEstimated went back to concatenating a '~'").toContain('.formatRange(n, n)');
	});
});

describe('the numbers rendered straight into markup are grouped too', () => {
	for (const { file, text, why } of DIRECT_RENDER) {
		it(`${file} → ${text.slice(0, 64)} (${why})`, () => {
			const occurrences = readSource(file).split(text).length - 1;
			expect(
				occurrences,
				occurrences === 0
					? `the markup ${text} is gone from ${file}. If the figure moved, move this entry; if it ` +
							`went back to a raw \`{…}\`, that is the defect — a reader whose locale groups ` +
							`thousands sees "11774" beside a "11.774" that came from the same query.`
					: `${occurrences} copies of this markup in ${file}; a second one is a second chance to ` +
							`render the raw number. Give it its own entry.`
			).toBe(1);
		});
	}
});

describe('⛔ THE INVENTORY IS COMPLETE — the assertion whose absence is the whole bug', () => {
	// Everything above this line checks entries. THIS checks the LIST, which is what nothing did:
	// `$lib/test/number-sites` re-derives every numeric site from the source and from the type
	// declarations, and the two inventories below must account for every one that is still raw.
	// Equality, not containment — a stale entry reds as loudly as a missing site, because a list
	// that is allowed to describe sites that no longer exist is a list nobody trusts enough to read.
	const vocab = numericVocabulary();

	/** A raw `{expr}` in markup that is CORRECT to leave raw. `times` for a genuinely repeated one. */
	const RAW_RENDER: Array<{ file: string; expr: string; why: string; times?: number }> = [
		// ⛔ NOT NUMBERS AT ALL — a field name shared with a numeric one somewhere else in the app.
		// The scan judges a dotted expression on its FIELD, so `error: number` on one DTO makes every
		// `.error` in the app look numeric. Recorded rather than special-cased: the day one of these
		// really does become a number, this line is where someone re-reads the decision.
		{ file: 'routes/governance/+page.svelte', expr: 'last.error', why: 'a failure MESSAGE (string); collides with a numeric `error` field elsewhere' },
		// ⚠️ `routes/solutions/[id]/+page.svelte → {d.error ?? ''}` USED TO SIT HERE and is deliberately
		// GONE, not silently dropped: that markup no longer exists. The delivery row now renders
		// `{deliveryErrorLabel(d)}` — a `: string`-annotated function, invisible to this scan by
		// construction — because `d.error` was a persisted ENGLISH SENTENCE, which is a worse problem
		// than the false-positive this entry was excusing. The scan is equality, not containment, so
		// leaving the line would red just as loudly as omitting a real site.
		{ file: 'routes/translations/+page.svelte', expr: 'j.error', why: 'a translation job’s error text (string)' },
		{ file: 'routes/block-edit/+page.svelte', expr: 'mr[STATUS_LABEL_KEYS[selected!.status]]?.() ?? selected!.status', why: 'a status ENUM (string); collides with a numeric `status`' },
		// ⛔ IDENTIFIERS AND ORDINALS — grouping these SHIPS A DEFECT. `num(1207)` is "1.207" in
		// nl/de, and a reader cannot tell that separator from a decimal point.
		{ file: 'lib/components/marketplace/RankBadge.svelte', expr: 'rank', why: 'an ORDINAL — "#1.207" is not a place on a leaderboard' },
		{ file: 'routes/challenges/[id]/+page.svelte', expr: 's.rank', why: 'an ORDINAL' },
		{ file: 'routes/winner/+page.svelte', expr: 'mention.rank', why: 'an ORDINAL' },
		{ file: 'routes/block-edit/+page.svelte', expr: 'f.col', why: 'a SOURCE COLUMN in `line:col` — a position in a file, printed dir="ltr" beside the code' },
		// ⛔ BOUNDED BY SOMETHING REAL, so "it might reach four digits one day" is falsifiable here.
		{ file: 'lib/layout/NotificationBell.svelte', expr: "notifications.unread > 9 ? '9+' : notifications.unread", why: 'the expression itself caps the raw branch at 9' },
		{ file: 'routes/translations/+page.svelte', expr: 'j.attempts', why: 'retries, capped by TRANSLATION_MAX_ATTEMPTS (backend config, default 3)' },
		// ⛔ NOT A COUNT.
		// ⚠️ ONE ENTRY WAS RETRACTED HERE, AND IT IS WORTH SAYING WHY RATHER THAN JUST DELETING IT.
		// `routes/(tenant)/llm-settings/+page.svelte → {temperature ?? '—'}` sat in this list with
		// the reason "a MODEL PARAMETER (0–2, fractional), echoed in `.mono` beside the number input
		// the operator typed it into". The retraction stands, but ONE OF ITS TWO ANSWERS WAS FALSE
		// AND IS REWRITTEN HERE. Taking them in order:
		//
		//  · "`.mono`" — answered, unchanged. A typeface is not a locale. The '.' this exemption
		//    preserved is the THOUSANDS separator in five of the eight catalogs, which is the one
		//    class of raw render this whole inventory exists to catch. Nothing about a monospace
		//    span makes an en-US decimal point legible to a Dutch reader.
		//  · "echoed beside the input" — the retraction answered this by claiming `num()` "echoes
		//    0.1 as '0,1' and 1 as '1', exactly what the field holds". ⛔ THAT WAS NOT TRUE, and it
		//    was the same objection the retraction had just used to REJECT `decimal1()`, one order
		//    of magnitude further down. `num()` is `toLocaleString`, default
		//    `maximumFractionDigits: 3`. Measured at render level with the harness in
		//    llm-settings.temperature-locale.render.test.ts:
		//
		//        temperature 0.0001    → "0"      temperature 0.999999    → "1"
		//
		//    `backend/src/routes/llm-settings.ts` is `z.number().min(0).max(2)` — no decimal bound —
		//    so both are accepted and stored, and the `<input>` beside the panel shows the raw value
		//    while the panel showed a rounded one. "0" for a value that IS set also collides with
		//    that file's own "ABSENCE IS STILL ABSENCE … not '0'" invariant. So the LOCALISATION was
		//    the right call and the FORMATTER was the wrong one: the site now calls
		//    `exact(temperature, locale.current)` (21 significant digits — every double, no rounding,
		//    no invented trailing zeros), and 0.0001 / 0.999999 are pinned in that spec alongside
		//    0.1 / 0.7 / 1 / null.
		//
		// ⚠️ AND ONE SUSPICION THAT WAS UNFOUNDED, RECORDED SO IT IS NOT "FIXED" LATER: grouping is
		// genuinely unreachable here. The field is bounded at 2 by the schema AND by the page's own
		// validation, so the only separator this site can emit is the decimal one.
		{ file: 'lib/components/block-edit/BlockDiffView.svelte', expr: 'stat.added', why: 'the +N/−M header of a unified diff, in an explicitly dir="ltr" span beside monospace source' },
		{ file: 'lib/components/block-edit/BlockDiffView.svelte', expr: 'stat.removed', why: 'the other half of the same diff header' }
	];

	/** A raw message PARAMETER that is correct to leave raw. */
	const RAW_PARAM: Array<{ file: string; key: string; param: string; why: string; times?: number }> = [
		// ⛔ THE TEN PLURAL MESSAGES. `num()` here breaks the SELECTOR — see the describe block above
		// and `icu-number-params.test.ts`. The digits are grouped in the catalog via `{countNum}`.
		{ file: 'lib/i18n/data-finding-label.ts', key: 'data_finding_type_mismatch', param: 'count', why: 'plural selector' },
		{ file: 'lib/i18n/ops-alert-label.ts', key: 'ops_alert_sandbox_error_title', param: 'count', why: 'plural selector' },
		// ⛔ AN HTTP STATUS CODE, WHICH GROUPING WOULD ACTIVELY CORRUPT. `d.errorStatus` is the status
		// the delivery target answered with — three digits by definition (RFC 9110), and the reader
		// needs to recognise it as `404`, not read it as a quantity. It is `: number | null` on the
		// DTO, which is the only reason the scan sees it at all; it belongs with the years, ordinals
		// and source positions further down rather than with the counts. `0` never reaches the
		// message — the label falls back before interpolating (see delivery-error-label.ts).
		{ file: 'lib/i18n/delivery-error-label.ts', key: 'delivery_error_target_http', param: 'status', why: 'an HTTP STATUS CODE — three digits by definition, and "4.04" is not a status' },
		// The connection-TEST twin of the line above: same reason, different screen (the "Testen"
		// button on /connectors, (tenant)/llm-settings and (tenant)/delivery). Both locals are
		// explicitly annotated `: number | null` at their declaration SO THAT this scan can see them
		// at all — an inferred `const status = int(…)` is invisible to `number-sites.ts`, and an
		// exclusion nobody is asked to state is not a decision, it is a blind spot.
		{ file: 'lib/i18n/connection-test-label.ts', key: 'delivery_test_http', param: 'status', why: 'an HTTP STATUS CODE — three digits by definition, and "4.04" is not a status' },
		{ file: 'lib/i18n/ops-alert-label.ts', key: 'ops_alert_block_errors_detail', param: 'count', why: 'plural selector' },
		{ file: 'routes/audit/+page.svelte', key: 'audit_event_count', param: 'count', why: 'plural selector' },
		// ⛔ BOUNDED: a rejected signup's cleanup goes `failed` after REJECT_REPAIR_MAX_ATTEMPTS (10,
		// backend services/signup-reject-repair.ts) and a Retry restarts the count — never 4 digits.
		{ file: 'routes/(platform)/onboarding/+page.svelte', key: 'admin_onboarding_repair_failed', param: 'attempts', why: 'retries, capped by REJECT_REPAIR_MAX_ATTEMPTS (10)' },
		{ file: 'routes/challenges/[id]/+page.svelte', key: 'challenge_detail_discussion', param: 'count', why: 'plural selector' },
		{ file: 'lib/components/build/RunConsole.svelte', key: 'console_trace_run_started', param: 'count', why: 'plural selector' },
		{ file: 'lib/components/build/StepOutput.svelte', key: 'build_output_rows', param: 'count', why: 'plural selector' },
		{ file: 'lib/components/build/sample-test.ts', key: 'build_sample_finding_type', param: 'count', why: 'plural selector' },
		{ file: 'lib/components/marketplace/LeaderboardRow.svelte', key: 'mkt_solutions_count', param: 'count', why: 'plural selector' },
		{ file: 'routes/(platform)/plans/+page.svelte', key: 'admin_plans_in_use', param: 'count', why: 'plural selector' },
		// ⛔ THE TENTH, AND IT IS HERE NOW BECAUSE THE HOLE THAT HID IT IS CLOSED. This line used to
		// read "its `lineCount` is an un-annotated `$derived`, so the scan cannot see it —
		// `PLURAL_SITES` above is what holds that one": an accurate description of a real blind spot,
		// and a compensating control that only ever covered THIS site. The blind spot was not one
		// site. `number-sites.ts` now judges a bare `$derived(…)` by its body, so the scan reaches
		// `lineCount` on its own and the classification has to be stated here like every other. The
		// decision itself is unchanged and deliberately so: `blockedit_impl_head` IS a plural message,
		// raw is the only correct answer, and its digits are grouped in the catalog via `{countNum}`.
		{ file: 'routes/block-edit/+page.svelte', key: 'blockedit_impl_head', param: 'count', why: 'plural selector — the tenth, pinned in PLURAL_SITES above' },
		// ⛔ THE FIVE OTHERS THE SAME HOLE HID, none of which is a defect. Every one is a bare
		// `$derived(…)` the scan could not previously see; each is raw for a reason that was already
		// written down for a sibling site, and the guard is now the thing that says so.
		{ file: 'lib/components/ops/KanbanCard.svelte', key: 'ops_kancard_reviewers_progress', param: 'count', why: 'distinct reviewers on ONE card — the same figure as ops_kancard_reviewed below, bounded by the policy’s requirement' },
		{ file: 'lib/components/ops/KanbanCard.svelte', key: 'ops_kancard_reviewers_count', param: 'count', why: 'the same `reviewCount`, in the branch with no policy requirement to show against' },
		{ file: 'routes/build/+page.svelte', key: 'foreach_no_body_warn', param: 'count', why: 'foreach containers with an empty body on ONE canvas — hand-authored nodes, not a query result' },
		// ⛔ YEARS, WEEK NUMBERS AND ORDINALS.
		// The three route-level pagers. `Pager.svelte`'s own `totalPages` is two lines below with the
		// same reason; these three hand-roll the same control and their `totalPages` is the same
		// un-annotated `$derived(Math.max(1, Math.ceil(total / pageSize)))` in each file. (Their
		// `page` is a bare `$state(1)`, which no pattern types either — it reaches this inventory
		// only when it is declared, and grouping it would be wrong for the same reason.)
		{ file: 'routes/challenges/+page.svelte', key: 'challenges_pager_page', param: 'totalPages', why: 'the ORDINAL’s upper bound — grouping one and not the other is worse than neither' },
		{ file: 'routes/datasets/+page.svelte', key: 'datasets_pager_page', param: 'totalPages', why: 'the ORDINAL’s upper bound' },
		{ file: 'routes/sandboxes/+page.svelte', key: 'sandboxes_pager_page', param: 'totalPages', why: 'the ORDINAL’s upper bound' },
		{ file: 'lib/challenges/challenge-state.ts', key: 'challenge_period_week', param: 'year', why: 'a YEAR: num(2026) reads "2.026"' },
		{ file: 'lib/challenges/challenge-state.ts', key: 'challenge_period_week', param: 'week', why: 'an ISO WEEK NUMBER, 1–53' },
		{ file: 'lib/challenges/challenge-state.ts', key: 'challenge_period_quarter', param: 'year', why: 'a YEAR: num(2026) reads "2.026"' },
		{ file: 'lib/challenges/challenge-state.ts', key: 'challenge_period_quarter', param: 'quarter', why: 'a QUARTER NUMBER, 1–4' },
		{ file: 'lib/components/ui/Pager.svelte', key: 'pager_page', param: 'page', why: 'an ORDINAL' },
		{ file: 'lib/components/ui/Pager.svelte', key: 'pager_page', param: 'totalPages', why: 'the ordinal’s upper bound — grouping one and not the other is worse than neither' },
		{ file: 'routes/block-edit/+page.svelte', key: 'blockedit_finding_line', param: 'line', why: 'a SOURCE LINE NUMBER', times: 2 },
		// The same lint finding, one screen over: the "Fix with AI" seed repeats each finding's rule,
		// message and line into the chat. Same figure, same reason — "regel 1.024" is not a line, and
		// the seed is also read by the model, which needs the position it can jump to.
		{ file: 'lib/components/block-edit/BlockFixAssistant.svelte', key: 'blockfix_seed_lint_line', param: 'line', why: 'a SOURCE LINE NUMBER — the sibling of blockedit_finding_line above' },
		// ⛔ DAY COUNTS, PERCENTAGES AND POLICY INTEGERS — each bounded by something in the code.
		// The home strip's cycle countdown. It reaches `pipeline_dur_hour` / `pipeline_dur_day` (plain
		// `{count}u` / `{count}d` strings, not plurals) with hours-to-the-phase-boundary, and the
		// bucket switches to days at 24 — so `count` is at most 23 on this branch and a handful on the
		// other. A separator here could only ever appear in a number that never needs one.
		// ⚠️ Only the HOUR arm reaches this inventory: the day arm's argument is an inline
		// `Math.floor(hours / 24)`, which no declaration pattern types. Same bound, same reason.
		{ file: 'lib/components/marketplace/CadenceStrip.svelte', key: 'pipeline_dur_hour', param: 'count', why: 'hours to the phase boundary — the bucket switches to days at 24, so ≤ 23' },
		{ file: 'lib/i18n/ops-alert-label.ts', key: 'ops_alert_block_errors_detail', param: 'days', why: 'BLOCK_ERROR_WINDOW_DAYS, a compile-time 7' },
		// The stale-range caveat on /usage names the range the figures on screen were fetched for.
		// `loadedRange` is only ever assigned from `range`, whose domain is the compile-time
		// `RANGES = [7, 30, 90]` — no locale groups under 1000, so a formatter here could only ever
		// add a way to be wrong.
		{ file: 'routes/(tenant)/usage/+page.svelte', key: 'admin_usage_showing_previous', param: 'days', why: 'one of RANGES = [7, 30, 90], a compile-time tuple' },
		// The FAILED variant of the same caveat, rendered from the same `loadedRange` in the same
		// `{#if}` — same bound, same reason. Two sentences because the two states are different: the
		// one above says "not loaded YET", which is untrue once the fetch has already failed.
		{ file: 'routes/(tenant)/usage/+page.svelte', key: 'admin_usage_showing_previous_failed', param: 'days', why: 'one of RANGES = [7, 30, 90], a compile-time tuple' },
		{ file: 'lib/components/LicenseExpiringBanner.svelte', key: 'license_expiring_days', param: 'days', why: 'the banner only renders inside the expiry window (≤ 30 days)' },
		// The SECOND site for the same key: `/license-upgrade` renders the entitled case, and the
		// banner's Renew button is what navigates there — so the two show the same figure one click
		// apart and must agree. Same bound, same reason: `daysRemaining` comes from the licences
		// service's own expiry window and cannot reach four digits.
		{ file: 'lib/i18n/license-copy.ts', key: 'license_expiring_days', param: 'days', why: 'same expiry window as the banner (≤ 30 days); the two sites render one click apart' },
		{ file: 'lib/components/ops/KanbanCard.svelte', key: 'ops_kancard_day_progress', param: 'day', why: 'day N of a pipeline stage' },
		{ file: 'lib/components/ops/KanbanCard.svelte', key: 'ops_kancard_day_progress', param: 'ofDays', why: 'the stage’s length in days' },
		{ file: 'routes/winner/+page.svelte', key: 'winner_step_hardening', param: 'day', why: 'day N of hardening' },
		{ file: 'routes/winner/+page.svelte', key: 'winner_step_hardening', param: 'ofDays', why: 'the stage’s length in days' },
		{ file: 'lib/components/ops/KanbanCard.svelte', key: 'ops_kancard_rollout', param: 'pct', why: 'a PERCENTAGE, 0–100' },
		{ file: 'routes/winner/+page.svelte', key: 'winner_step_staging', param: 'pct', why: 'a PERCENTAGE, 0–100' },
		{ file: 'lib/components/ops/KanbanCard.svelte', key: 'ops_kancard_reviewers_progress', param: 'required', why: 'the governance policy’s reviewer requirement, a single digit' },
		{ file: 'lib/components/ops/KanbanCard.svelte', key: 'ops_kancard_reviewed', param: 'count', why: 'reviewers on ONE card, bounded by the requirement above' },
		// ⛔ NOT NUMBERS — field-name collisions again.
		// A PORT HANDLE ID on the /build canvas ("rijen", "invoer"), or the node id it falls back to.
		// The scan sees it only because `target` is a numeric field name somewhere else in the tree;
		// a thousands separator cannot even reach a handle id, and grouping an identifier would name
		// a port that does not exist. `source` in the same message is the identical decision and is
		// invisible to the scan for want of a numeric namesake.
		{ file: 'lib/i18n/agent-edit-label.ts', key: 'agent_edit_connect_nodes', param: 'target', why: 'a PORT HANDLE ID (or a node id) — an identifier, not a quantity' },
		// ⛔ AND THE COLLISION IS IN THE SAME FILE. `error_not_a_draft` names the version a block is at
		// and the status it is in; both come off `detailStr(d, …)`, which returns `string | null`. The
		// scan sees `status` only because a numeric `status` is declared elsewhere — `error-message.ts`'s
		// OWN `statusOf(err): number | undefined` is one — and neither value here is a quantity:
		// `status` is the authoring service's enum token (`draft`/`beta`/`stable`/`deprecated`), which a
		// thousands separator cannot even reach, and the `version` beside it is an IDENTIFIER that is
		// merely numeric on the wire, so grouping would print "1,0.0" for 1.0.0. That is the call
		// `error-message.ts` already records at `version_exists` ("a block version is an IDENTIFIER, not
		// a quantity") and the same one as the two HTTP-status entries at the head of this list.
		{ file: 'lib/api/error-message.ts', key: 'error_not_a_draft', param: 'status', why: 'a block-status ENUM (`draft`/`beta`/`stable`/`deprecated`), a string off `detailStr`; it collides with this module’s own numeric `statusOf(): number | undefined`' },
		{ file: 'lib/challenges/challenge-state.ts', key: 'challenge_state_voting_countdown', param: 'time', why: 'a preformatted countdown STRING (`remaining: string`)' },
		{ file: 'lib/challenges/challenge-state.ts', key: 'challenge_state_solution_countdown', param: 'time', why: 'a countdown string' },
		{ file: 'lib/challenges/challenge-state.ts', key: 'challenge_vote_note_countdown', param: 'time', why: 'a countdown string' },
		{ file: 'lib/solutions/solution-state.ts', key: 'solution_state_voting_countdown', param: 'time', why: 'a countdown string' },
		{ file: 'lib/solutions/solution-state.ts', key: 'solution_vote_note_countdown', param: 'time', why: 'a countdown string' },
		{ file: 'routes/+layout.svelte', key: 'auth_profile_load_failed', param: 'error', why: 'an error MESSAGE (string)' }
	];

	// ⛔ NON-VACUITY, IN BOTH DIRECTIONS. Two equal empty lists satisfy every `toEqual` below, and
	// this repo has shipped a guard that reported GREEN because its scan ate its own input
	// (`source-scan.ts`'s header). So: the vocabulary really was read off the declarations, it does
	// NOT contain names that merely look numeric, and the detector still answers "numeric" for the
	// exact expression the headline defect was — and "not numeric" once it is wrapped.
	it('the scan read the real codebase', () => {
		for (const field of ['rowCount', 'activeRuns', 'llmCalls', 'memberCount', 'solutionsCount', 'p95LatencyMs'])
			expect(vocab.fields.has(field), `${field} is declared \`: number\` and must be in the vocabulary`).toBe(true);
		// A name-regex would have flagged all three of these; the declarations say they are strings.
		for (const notNumeric of ['value', 'countdown', 'memIndicator'])
			expect(vocab.fields.has(notNumeric), `${notNumeric} is not declared a number anywhere`).toBe(false);
		// The helpers behind four chip counts and the nav badge — the shape the old list missed.
		expect([...(vocab.locals.get('routes/challenges/+page.svelte') ?? [])]).toContain('countFor');
		expect([...(vocab.locals.get('routes/audit/+page.svelte') ?? [])]).toContain('countFor');
		expect([...(vocab.locals.get('routes/sandboxes/+page.svelte') ?? [])]).toContain('tabCount');
		expect([...(vocab.locals.get('lib/layout/Sidebar.svelte') ?? [])]).toContain('badgeCount');
	});

	it('the detector reds on the headline defect and clears on its fix', () => {
		const file = 'routes/challenges/+page.svelte';
		expect(numericIdentifiers('countFor(d.v)', vocab, file)).toEqual(['countFor']);
		expect(numericIdentifiers('num(countFor(d.v), locale.current)', vocab, file)).toEqual([]);
		expect(numericIdentifiers('it.rowCount', vocab, 'lib/components/build/ChallengeDataPanel.svelte')).toEqual(['rowCount']);
		// …and it does not fire on the things that only LOOK numeric.
		expect(numericIdentifiers('r.text', vocab, 'lib/components/ops/FeedItem.svelte')).toEqual([]);
		expect(numericIdentifiers("v.status === 'draft' ? m.a() : m.b()", vocab, 'routes/block-edit/+page.svelte')).toEqual([]);
	});

	const expand = <T extends { times?: number }>(rows: T[]): T[] =>
		rows.flatMap((r) => Array.from({ length: r.times ?? 1 }, () => r));

	it('every number rendered straight into markup is grouped, or written down here', () => {
		const found = textRenderSites(vocab)
			.filter((s) => !isFormatted(s.expr))
			.map((s) => `${s.file} → {${s.expr}}`)
			.sort();
		const declared = expand(RAW_RENDER)
			.map((r) => `${r.file} → {${r.expr}}`)
			.sort();
		expect(
			found,
			'a raw number reached the markup that this inventory does not account for. Either wrap it ' +
				'in `num(…, locale.current)`, or add it to RAW_RENDER with the reason grouping would be ' +
				'WRONG (an ordinal, a year, a version, a source position, a percentage, an id).'
		).toEqual(declared);
	});

	it('every number handed to a message is grouped, or written down here', () => {
		const found = messageParamSites(vocab)
			.filter((s) => !isFormatted(s.expr))
			.map((s) => `${s.file} → m.${s.key}.${s.param}`)
			.sort();
		const declared = expand(RAW_PARAM)
			.map((r) => `${r.file} → m.${r.key}.${r.param}`)
			.sort();
		expect(
			found,
			'a raw number is being passed into an ICU message and this inventory does not account for ' +
				'it. Wrap it, or add it to RAW_PARAM — and if it is a PLURAL message, raw is the only ' +
				'correct answer and the digits are grouped in the catalog via `{countNum}`.'
		).toEqual(declared);
	});
});
