// src/lib/i18n/ops-alert-label.ts — the ONE place a /it-dash "Needs attention" alert becomes words
// a reader can read.
//
// ⛔ THE DEFECT. `AttentionItem.title` / `.detail` are composed in backend/src/host/ops-metrics.ts
// as ENGLISH sentences — "3 sandboxes in error", "24h P95 is 2.41s, above the 2.0s target." The
// server does not know, and must not know, who is reading, so those sentences can never be Dutch.
// They sat inside a fully localized Dutch frame ("Aandacht nodig") on the one screen whose job is
// to be scanned in five seconds. The wire now carries the KIND plus machine fields (`errorCount`,
// `owners`, `p95Ms`, `thresholdMs`, `slug`, `runCount`, `windowDays`); the browser owns the words.
// Same split as `stage-label.ts`, `run-status-label.ts` and `data-finding-label.ts`.
//
// EXHAUSTIVE SWITCH, NOT A LOOKUP TABLE. Paraglide compiles ONE function per message key and
// tree-shakes on the import graph, so `m[`ops_alert_${kind}_title`]()` does not resolve — there is
// no runtime object to index. The explicit switch is the house idiom, not a workaround.
//
// ⛔ THE FALLBACK IS THREE-BRANCH, AND THE MIDDLE BRANCH IS LOAD-BEARING.
// The two containers share a pod, but the browser reaches the API through the k8s SERVICE, which
// load-balances across old and new pods for the length of a rolling deploy — so a NEW frontend
// really is answered by an OLD pod. That exact hazard blanked /governance and was caught only at
// review in PR #233. Here the backend change is additive, so it has TWO shapes:
//   kind known + its machine fields present → the catalog message        (the normal path)
//   kind known, machine fields MISSING      → `item.title` / `.detail`   (old backend, mid-roll)
//   kind absent or UNRECOGNISED             → `item.title` / `.detail`   (backend-first alert)
//
// ⚠️ THE THIRD BRANCH IS PROSE, NOT THE RAW KEY — DELIBERATELY UNLIKE `complianceLabel`. There the
// panel is a fixed four-row display, so an unknown key can only be a build defect and a raw `nis2`
// is the honest way to show it. THIS IS AN ALERTING SURFACE. An alert that degrades to a bare
// `sandbox_error` token tells the operator nothing they can act on, while the English sentence
// tells them everything except in their own language. Same rule `data-finding-label.ts` follows,
// and for the same reason: worse to read, infinitely better than nothing.
//
// ⛔ EVERY PRESENCE CHECK IS `=== undefined` / `== null`, NEVER TRUTHINESS. `errorCount`,
// `runCount` and `p95Ms` are NUMBERS, and `0` is a legal value for all three — a `!item.runCount`
// guard silently drops a real alert into the English branch. (This is the one place this file
// diverges from `data-finding-label.ts`, whose `!finding.count` is correct THERE only because the
// backend emits that rule solely when `bad > 0`.)
import * as m from '$lib/paraglide/messages';
import { ms } from '$lib/utils/format';
import type { AttentionItem, AttentionItemProse } from '$lib/types/ops';

/** The alert's headline. */
export function opsAlertTitle(item: AttentionItem): string {
	switch (item.kind) {
		case 'sandbox_error':
			// ⛔ ICU PLURAL on the TRUE count — `errorCount`, never `owners.length`. The backend used
			// to headline the ≤5 SAMPLE size, so twelve broken sandboxes read "5 sandboxes in error".
			if (item.errorCount === undefined) return item.title;
			return m.ops_alert_sandbox_error_title({ count: item.errorCount });
		case 'high_latency':
			// No machine fields in the headline, so nothing here can be mid-roll-absent.
			return m.ops_alert_high_latency_title();
		case 'block_errors':
			if (item.slug === undefined) return item.title;
			// The slug is an IDENTIFIER and is interpolated verbatim — an operator matches it against
			// the block list and the deep-link, so it must never be translated.
			return m.ops_alert_block_errors_title({ slug: item.slug });
		default:
			// `item` narrows to `never`: the union is exhaustive by construction. An alert kind added
			// backend-first is nonetheless a REAL wire shape, so widen and read the prose.
			return (item as AttentionItemProse).title;
	}
}

/**
 * The alert's supporting line.
 *
 * ⛔ `locale` IS A REQUIRED PARAMETER BECAUSE `ms()` NOW NEEDS ONE, and this file must not import
 * `$lib/stores/locale.svelte`: reading a `$state` rune from a plain `.ts` module binds every
 * importer (including this file's own pure-logic spec) to the Svelte runtime. Same shape as
 * `components/marketplace/cadence-day.ts` and `$lib/utils/format`'s `num`/`decimal1` — the
 * function takes the tag, the component passes `locale.current` (AlertItem.svelte).
 * Required with no default for the same reason it is required there: a default compiles at every
 * call site that forgets, and forgetting is how the whole defect class spread.
 */
export function opsAlertDetail(item: AttentionItem, locale: string): string {
	switch (item.kind) {
		case 'sandbox_error': {
			if (item.owners === undefined || item.errorCount === undefined) return item.detail;
			// ⛔ COMPOSED IN CODE, NOT VIA A MESSAGE KEY. These are proper nouns joined by punctuation
			// — `Fatima · claims-intake; Lisa de Vries`. There is nothing to translate, and routing
			// it through the catalog would hand eight translators a list separator to get wrong.
			// Same call `dataFindingRef` makes for `dataset.column → attribute`.
			const names = item.owners
				.map((o) => (o.project == null || o.project === '' ? o.name : `${o.name} · ${o.project}`))
				.join('; ');
			// The sample is capped at 5 by the backend; say so rather than let the list quietly
			// contradict the headline count above it.
			const more = item.errorCount - item.owners.length;
			return more > 0 ? m.ops_alert_sandbox_error_more({ owners: names, more }) : names;
		}
		case 'high_latency':
			if (item.p95Ms === undefined || item.thresholdMs === undefined) return item.detail;
			// ⚠️ `ms()` — the SAME formatter the P95 stat card three sections up already uses, so the
			// two figures on one screen cannot disagree about their unit OR their punctuation. The
			// backend ships raw milliseconds precisely so this decision is made once, here. Both
			// figures carry a decimal, so both need the reader's separator: "2,47 s boven de 2,00 s"
			// in Dutch, never "2.47s above the 2.00s target" inside a Dutch sentence.
			return m.ops_alert_high_latency_detail({
				p95: ms(item.p95Ms, locale),
				threshold: ms(item.thresholdMs, locale)
			});
		case 'block_errors':
			if (item.runCount === undefined || item.windowDays === undefined) return item.detail;
			// ⚠️ The ICU plural selects on `count` (which really varies), NOT on `days`. `days` is
			// `BLOCK_ERROR_WINDOW_DAYS`, a compile-time constant currently 7, and every catalog
			// writes its noun in the plural. Changing that constant to 1 needs a copy pass; the
			// backend constant carries the same warning.
			return m.ops_alert_block_errors_detail({
				count: item.runCount,
				days: item.windowDays
			});
		default:
			return (item as AttentionItemProse).detail;
	}
}
