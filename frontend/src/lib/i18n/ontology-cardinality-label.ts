// src/lib/i18n/ontology-cardinality-label.ts — the ONE place an ontology relation's CARDINALITY
// becomes a word a reader can read.
//
// ⛔ THE DEFECT. `/ontology`'s detail panel printed the column verbatim on every relation row of
// every entity a reader clicks:
//
//     routes/ontology/+page.svelte   {#if r.cardinality}<span class="rel-card">{r.cardinality}</span>{/if}
//
// so a Dutch reader clicking "Schadeclaim" got a relation list whose ends and predicate had both
// been localized — `ontologyRelationEndLabel` and `ontologyRelationLabel`, the module next to this
// one — and whose third chip read "many-to-one". The panel had already done the hard half. This is
// the same species as the raw `.ptype` enums `field-type-label.ts` was written for, and it survived
// that sweep because it is the one value on the row that is neither an end nor a predicate.
//
// Not an edge case: `cardinality` is seeded on 30 relations across the shipped ontology
// (`many-to-one` ×18, `one-to-many` ×7, `one-to-one` ×3, `many-to-many` ×2), so nearly every
// entity a reader can click carries at least one.
//
// ⚠️ THE VALUE SET IS OPEN, AND THAT IS WHY THE `default:` ARM MATTERS MORE HERE THAN USUAL. Unlike
// `fieldTypeSchema`, there is NO enum behind this column: it is `text('cardinality').notNull()
// .default('')` (backend/src/db/schema.ts) written through `z.string().max(20).optional()`
// (backend/src/routes/ontology.ts), and the "Add relation" modal on /ontology offers a FREE-TEXT
// `<input placeholder="many-to-one">`. An org admin can and will type "1:N", "veel op een", or a
// typo. So the four arms below are the four values the SEEDS ship, not a closed contract, and
// anything else must render AS ITSELF — an admin's own words are the best label available for them,
// and a blank chip where a value exists reads as data the page failed to load. Same rule, and the
// same reason, as `fieldTypeLabel`'s `default:` and `ontologyScopeLabel`'s.
//
// ⚠️ `en` IS DELIBERATELY IDENTICAL TO THE ENUM. The seeded values are already English prose, so
// the base catalog reproduces them verbatim rather than inventing "One to one" — the fix is for the
// seven locales that had no word at all, and changing the English chip would be an unrelated copy
// change. It does mean the base locale cannot distinguish this module from the raw render; the spec
// beside this file therefore asserts in `nl`, and says so.
//
// WHY AN EXHAUSTIVE SWITCH AND NOT A LOOKUP TABLE: paraglide compiles ONE function per message key
// and tree-shakes on the import graph, so `m[`ontology_cardinality_${v}`]()` does not resolve —
// there is no runtime object to index. Spelled out at length in `stage-label.ts`, which this
// mirrors. (The hyphens in the values could not be part of an identifier anyway.)
import * as m from '$lib/paraglide/messages';

/**
 * The reader's word for a relation's cardinality.
 *
 * Takes `string`, not a union, because the column has no enum behind it — see the header. An
 * unrecognised value returns ITSELF, which is exactly what every value rendered before this change.
 */
export function ontologyCardinalityLabel(cardinality: string): string {
	switch (cardinality) {
		case 'one-to-one':
			return m.ontology_cardinality_one_to_one();
		case 'one-to-many':
			return m.ontology_cardinality_one_to_many();
		case 'many-to-one':
			return m.ontology_cardinality_many_to_one();
		case 'many-to-many':
			return m.ontology_cardinality_many_to_many();
		default:
			return cardinality;
	}
}
