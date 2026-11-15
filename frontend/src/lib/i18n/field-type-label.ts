// src/lib/i18n/field-type-label.ts — the ONE place a block port's FIELD TYPE becomes a word a
// reader can read.
//
// ⛔ THE DEFECT. /build, the product's PRIMARY authoring surface, rendered the descriptor's type
// enum verbatim on every port badge of every node:
//   • BlockNode.svelte, the input column   <span class="ptype">{typeLabel(spec.type)}</span>
//   • BlockNode.svelte, the output column  <span class="ptype">{typeLabel(spec.type)}</span>
// where `typeLabel` was a hardcoded ENGLISH abbreviator — `string[]`→"list", `dataset`→"data",
// `boolean`→"bool", `number`→"num" — with `string`, `json` and `enum` falling through RAW. A Dutch
// canvas showed 18 English tokens sitting inside fully Dutch chrome. Same class as the /ontology
// and /datasets raw-enum leaks `dataset-label.ts` was written for; a different component, and one
// that fix never reached. The wire carries the ENUM; the browser owns the words.
//
// ⚠️ THE WORDS ARE DELIBERATELY TERSE. `.ptype` is an 8.5px chip inside a 190px node whose port
// column is ~78px wide and whose port NAME shares that column behind an ellipsis, so a long word
// eats the name. Every value in every catalog is kept to at most seven characters — which is what
// the old English abbreviations bought, and what the localized labels have to keep buying.
//
// ⚠️ AND THEY REUSE THE `dataset_coltype_*` WORDS WHERE THE CONCEPT IS THE SAME. 'string',
// 'number', 'boolean' and 'json' mean here exactly what they mean on a dataset column, so the
// catalogs repeat that vocabulary verbatim rather than inventing a second Dutch word for the same
// idea. They are NOT the same KEY, for the reason `dataset-label.ts` spells out about its own two
// enums: these are independent backend vocabularies (`FieldType` in
// `backend/src/blocks/descriptor-schema.ts` vs `DatasetColumnType` in `backend/src/db/
// dataset-types.ts`) that are free to diverge, and a locale that inflects must stay free to
// distinguish "a column of text" from "a port carrying text".
//
// WHY AN EXHAUSTIVE SWITCH AND NOT A LOOKUP TABLE: paraglide compiles ONE function per message key
// and tree-shakes on the import graph, so `m[`fieldtype_${t}`]()` does not resolve — there is no
// runtime object to index. Spelled out at length in `stage-label.ts`, which this mirrors.
import * as m from '$lib/paraglide/messages';

/**
 * The reader's word for a block port's declared type.
 *
 * The value set is CLOSED and comes from `fieldTypeSchema` in
 * `backend/src/blocks/descriptor-schema.ts` (the same seven as the `FieldType` union in
 * `backend/src/db/block-types.ts`, mirrored by `$lib/types/blocks`). Pinned against those files by
 * `field-type-label.backend-contract.test.ts`, so an eighth member added server-side reds CI here
 * rather than shipping an English token onto the canvas.
 *
 * Takes `string`, not `FieldType`, and an unrecognised value returns THE RAW ENUM — which is
 * exactly what the badge rendered before this change for `string`, `json` and `enum`. A type added
 * server-side and deployed one roll ahead of the browser ships an ugly token rather than a blank
 * chip: `{''}` in a `.ptype` is a tinted rectangle with nothing in it, which reads as a port with
 * no type at all.
 */
export function fieldTypeLabel(type: string): string {
	switch (type) {
		case 'string':
			return m.fieldtype_string();
		case 'number':
			return m.fieldtype_number();
		case 'boolean':
			return m.fieldtype_boolean();
		case 'json':
			return m.fieldtype_json();
		case 'string[]':
			// The one key that cannot be named after its value — `fieldtype_string[]` is not an
			// identifier paraglide can compile. Named for the SHAPE, which is also what it reads as.
			return m.fieldtype_string_array();
		case 'enum':
			return m.fieldtype_enum();
		case 'dataset':
			return m.fieldtype_dataset();
		default:
			return type;
	}
}
