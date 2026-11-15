// src/lib/i18n/block-cost-label.ts — the ONE place a building block's COST CLASS becomes a word a
// reader can read.
//
// ⛔ THE DEFECT. /block-edit's "Details" card is a definition list whose every term is localized —
// `blockedit_meta_maintainer`, `blockedit_meta_created`, `blockedit_meta_license`,
// `blockedit_meta_region`, `blockedit_meta_cost_class` — and whose cost-class VALUE was the raw
// database column:
//
//     <dt>{m.blockedit_meta_cost_class()}</dt><dd>{detail.cost_class ?? '—'}</dd>
//
// so a Dutch reader got "Kostenklasse  low". Every block in the product carries one
// (`backend/src/db/seed.ts` seeds `cost_class` on all twelve; `seed-example-blocks.ts`,
// `seed-datasets.ts` and `ontology/data-block-derivation.ts` seed more), so this is not an edge
// case — it is on every block detail page in the catalogue. The wire carries the ENUM; the browser
// owns the words. Same shape, same reasoning, as `dataset-label.ts` beside it.
//
// ⚠️ THE VALUE SET IS NOT CLOSED BY THE SCHEMA, AND THAT IS WHY THE `default:` ARM MATTERS HERE.
// `blocks.cost_class` is a nullable bare `text` column (`backend/src/db/schema.ts:369`) and the
// authoring route accepts `z.string().optional()` (`backend/src/routes/blocks.ts:88`) — there is no
// pg enum and no zod union anywhere to pin a contract test against, which is why this module has no
// `.backend-contract.test.ts` sibling and `dataset-label.ts` does. Measured against the live
// database: `select cost_class, count(*) from building_blocks group by 1` → `low` 18, `medium` 6.
// `high` is mapped anyway because a two-rung "ladder" is not a ladder: the API already accepts the
// string, and the day an author sends it the reader gets a word rather than the English token this
// module exists to remove. Anything else falls through to itself.
//
// ⛔ RAW ON AN UNKNOWN VALUE, NEVER BLANK — and the `<dd>` is why it is not even arguable here. The
// caller distinguishes ABSENCE (`cost_class` is null → the em dash, the same one `license` and
// `region` use) from a value it does not recognise. Collapsing an unrecognised class to `''` would
// print an EMPTY `<dd>` under a populated `<dt>`, which reads as "this block has no cost class" —
// a different, and false, statement about the block.
//
// WHY AN EXHAUSTIVE SWITCH AND NOT A LOOKUP TABLE: paraglide compiles ONE function per message key
// and tree-shakes on the import graph, so `m[`blocks_cost_${c}`]()` does not resolve — there is no
// runtime object to index. Spelled out at length in `stage-label.ts`, which this mirrors.
import * as m from '$lib/paraglide/messages';

/**
 * The reader's word for a block's cost class.
 *
 * Takes `string`, not a union, because `cost_class` mirrors a free-text database column the
 * frontend does not own (see the header). An unrecognised class returns THE RAW VALUE — which is
 * exactly what the screen rendered before this change, and strictly better than the blank it would
 * otherwise leave in a `<dd>`.
 *
 * ⚠️ NULL IS THE CALLER'S PROBLEM, DELIBERATELY. `blockedit`'s meta list already renders `?? '—'`
 * for `license`, `region` and `cost_class` alike, and swallowing null in here would put ONE of
 * those three em dashes in a different place from the other two.
 */
export function costClassLabel(costClass: string): string {
	switch (costClass) {
		case 'low':
			return m.blocks_cost_low();
		case 'medium':
			return m.blocks_cost_medium();
		case 'high':
			return m.blocks_cost_high();
		default:
			return costClass;
	}
}
