// src/lib/i18n/work-area-label.ts — the ONE place a challenge's `work_area` becomes words a
// reader can read.
//
// ⛔ THE DEFECT. `work_area` is a backend enum — `WORK_AREAS = ['Claims', 'Sales', 'Service',
// 'Legal', 'Marketing', 'Risk', 'Ops', 'IT']` (backend/src/routes/challenges.ts:33) — and five
// render sites printed it verbatim into a Dutch UI:
//   • marketplace/LeaderboardRow.svelte      {row.workArea}          → every row on /challenges + Home → Trending
//   • challenges/[id]/+page.svelte           the work-area badge     → the chip under the title
//   • challenges/[id]/+page.svelte           `challenge_detail_posted({ workArea })` → the byline
//   • challenges/[id]/+page.svelte           MetricTile sub=         → under "Getroffen medewerkers"
//   • challenges/[id]/+page.svelte           {s.workArea}            → "Vergelijkbare uitdagingen"
// The filter chip an inch above the rows already read "Schadeclaims" (it resolves `domain_claims`
// from its own `DOMAINS` table), so the SAME value was on screen twice, in two languages, in the
// same viewport. `/submit` localizes it in its live preview too — so a reader picks "Schadeclaims",
// submits, and lands on a detail page that calls it "Claims".
//
// ⛔ DISPLAY TEXT ONLY — NEVER THE WIRE VALUE. `work_area` is a routing value as well as a word:
//   • `/challenges?work_area={encodeURIComponent(data.workArea)}` deep-links the list's domain chip
//     and is matched with `DOMAINS.some((d) => d.v === wa)` on arrival (challenges/+page.svelte:145);
//   • `list.counts[d.v]` keys the per-chip counts off the same literals;
//   • `POST /api/challenges` validates `work_area` against `z.enum(WORK_AREAS)`.
// Label the TEXT NODE and leave every `href`, query param and request body carrying the enum. A
// localized value in any of those three places breaks filtering in seven locales and turns
// submission into a 422.
//
// WHY AN EXHAUSTIVE SWITCH AND NOT A LOOKUP TABLE. Paraglide compiles one function per message key
// and tree-shakes on the import graph, so a `Record<string, () => string>` of message functions
// only works where the whole `messages` namespace is already retained (which is what the two
// `mm[labelKey]()` call sites in /challenges and /submit do, at the cost of the tree-shake). The
// explicit switch is the established idiom here — see `stageLabel` beside this file, `statusLabel`
// in routes/connectors/+page.svelte, `phaseLabel` in components/marketplace/CadenceStrip.svelte.
import * as m from '$lib/paraglide/messages';

/**
 * The eight `WORK_AREAS` values, 1:1 with backend/src/routes/challenges.ts:33, in the backend's
 * declaration order.
 *
 * ⛔ THE LIST LIVES BESIDE THE WORDS ON PURPOSE. /submit carried its own `DOMAINS:
 * {v, labelKey}[]` — the same eight values against the same eight `domain_*` keys, a second copy
 * of this vocabulary that had to be edited in lockstep with the switch below and was not covered by
 * the backend-scraping guard in work-area-label.test.ts. It now imports this. (⚠️ /challenges keeps
 * its OWN table and is NOT consolidated here: its first entry is the filter sentinel
 * `'All domains'`, which is not a work area, is never sent as one, and is explicitly refused a case
 * in `workAreaLabel` below. Folding it in would smuggle a non-value into the enum.)
 */
export const WORK_AREAS = ['Claims', 'Sales', 'Service', 'Legal', 'Marketing', 'Risk', 'Ops', 'IT'] as const;

export type WorkArea = (typeof WORK_AREAS)[number];

/**
 * The reader's word for a challenge's work area.
 *
 * Takes `string`, not `WorkArea`, because the wire type is `work_area: string`
 * (types/challenges.ts:121) and the column predates the enum: rows seeded before `z.enum` landed
 * carry off-list values, which is exactly why /challenges renders `extraDomains` chips for
 * whatever the counts contain. An unrecognised value returns THE RAW VALUE — what all five sites
 * rendered before this change — so a work area added server-side ships an untranslated word rather
 * than a blank cell, and never an English sentence.
 *
 * ⛔ NO `'All domains'` CASE. That is the /challenges filter's own sentinel, not a `work_area`; it
 * never reaches a row, a badge or a byline, and giving it a case here would invite someone to route
 * the filter chips through this function and quietly widen the enum by one non-value.
 */
export function workAreaLabel(workArea: string): string {
	switch (workArea) {
		case 'Claims':
			return m.domain_claims();
		case 'Sales':
			return m.domain_sales();
		case 'Service':
			return m.domain_service();
		case 'Legal':
			return m.domain_legal();
		case 'Marketing':
			return m.domain_marketing();
		case 'Risk':
			return m.domain_risk();
		case 'Ops':
			return m.domain_ops();
		case 'IT':
			return m.domain_it();
		default:
			return workArea;
	}
}
