// src/lib/i18n/ontology-relation-label.ts — the ONE place a compiled ontology RELATION becomes the
// words a reader reads: the edge's own display label, and the two entity ends it hangs between.
//
// ⛔ THE DEFECT, MEASURED. An org admin authoring in Dutch types `hoort bij` into the "Add relation"
// modal's LABEL field. `saveRelation` (routes/ontology/+page.svelte:511) sends it, the route accepts
// it (`label: z.string().max(120).optional()`, backend/src/routes/ontology.ts:368), the service
// persists it (`label: input.label?.trim() ?? ''`, backend/src/ontology/ontology-service.ts:929),
// and `compileEffective` even OVERLAYS a seeded translation onto it for non-en readers (pass 3,
// backend/src/ontology/ontology-service.ts:513-531, namespace `ontology_relation`, field `label`).
// Both render sites then threw all of that away and printed the canonical predicate instead:
//
//     lib/components/ontology/OntologyGraph.svelte:60   label: r.predicate      → the graph edge
//     routes/ontology/+page.svelte:957   <span class="rel-pred">{r.predicate}</span>
//
// So the text the author typed was on NO screen, in any locale, and the seeded `ontology_relation`
// translation rows were dead weight: a whole server-side overlay pass with no consumer. Same
// species as `ontology-attr-type.dutch.render.test.ts` — a helper/overlay written for a call site
// that never called it — and fixed the same way.
//
// ⚠️ WHY `??` IS THE WRONG OPERATOR HERE, AND THIS IS NOT PEDANTRY. `label` IS NOT NULLABLE ON THE
// WIRE — it is a `text NOT NULL` column whose insert path writes `input.label?.trim() ?? ''`. The
// ORDINARY value for a relation whose author left the label field blank (and for every seeded
// global edge with no `label` in its JSON) is therefore the EMPTY STRING, not `null`.
// `r.label ?? r.predicate` would let `''` through and render an empty `<span>` where the predicate
// used to be — turning "shows the wrong word" into "shows no word at all", which is worse and is
// exactly the regression the `label: ''` case in the spec beside this file pins. The operator has
// to be `||` over a trimmed value, which is precisely the idiom the WRITE path already uses one
// pane away (`f.label.trim() || f.predicate.trim()`, +page.svelte:511). Read and write now agree.
//
// ⚠️ THE PREDICATE IS STILL THE IDENTITY AND MUST STAY CANONICAL. `predicate` is the agent-facing
// concept id — it is the dedup key server-side (`${from}->${to}:${r.predicate}`,
// ontology-service.ts), the `relKey` the translation overlay looks translations UP by, the `#each`
// key on the detail list, and the SvelteFlow edge `id`. None of those may move to `label`: keying
// a list by a localized string re-keys every row on a locale switch, and keying it by a value that
// can be `''` collides two edges into one. Display words move; keys do not. That is the same split
// `ontology-axis-label.ts` documents for the matrix axes (a value that is a word AND a key).

import type { CompiledOntology, OntologyEntity, OntologyRelation } from '$lib/types/ontology';

/** The narrow shape both render sites hold — a compiled relation, or anything with those fields. */
type RelationWords = Pick<OntologyRelation, 'predicate'> & { label?: string | null };

/**
 * The words to PRINT for a relation: its authored/translated `label`, or the canonical `predicate`
 * when there is no label to print.
 *
 * Total by construction: `predicate` is `z.string().min(1)` on the write path
 * (backend/src/routes/ontology.ts:367) and `predicate_required` 400s an empty one
 * (ontology-service.ts), so the fallback can never itself be blank. Nothing here can return `''`
 * unless the server broke its own contract.
 */
export function ontologyRelationLabel(r: RelationWords): string {
	return r.label?.trim() || r.predicate;
}

/**
 * The words to PRINT for one END of a relation.
 *
 * `CompiledRelation.from` / `.to` are entity NAMES (`idToName` in `compileEffective`), i.e. the
 * canonical `ontology_entities.name` — "BrokerNote", never "Makelaarsnotitie". Every other place
 * this product names an entity to a reader prints `entity.label`, which `localizeEntityLabels`
 * resolves per locale: the graph node (OntologyEntityNode.svelte:30), the detail-panel heading
 * (+page.svelte:831), the hidden-entity chips (:817). The relation row was the one site printing
 * the raw name — so a Dutch reader read `BrokerNote hoort bij Policy` on a row whose two nouns are
 * "Makelaarsnotitie" and "Polis" in the card six pixels above it.
 *
 * ⚠️ THE RAW NAME IS A REAL FALLBACK, NOT A SAFETY NET. A relation can outlive the entity lookup it
 * is resolved against: `compileEffective` drops relations whose ends are hidden or out of the final
 * entity set, but the DETAIL panel filters `ontology.relations` client-side and a future caller may
 * hold a narrower entity list. An unresolved end prints its own name — the same rule as
 * `ontologyScopeLabel`'s `default:` arm — because a canonical name reads as the name it is, while
 * an empty span reads as a bug.
 */
export function ontologyRelationEndLabel(
	name: string,
	entitiesByName: ReadonlyMap<string, OntologyEntity>
): string {
	return entitiesByName.get(name)?.label?.trim() || name;
}

/** Index a compiled graph's entities by their canonical `name` — the key `from`/`to` carry. */
export function entitiesByName(o: Pick<CompiledOntology, 'entities'>): Map<string, OntologyEntity> {
	return new Map(o.entities.map((e) => [e.name, e]));
}
