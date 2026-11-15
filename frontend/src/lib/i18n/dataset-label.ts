// src/lib/i18n/dataset-label.ts — the ONE place a dataset's SOURCE KIND and a dataset column's
// TYPE become words a reader can read.
//
// ⛔ THE DEFECT. /datasets rendered two backend enums verbatim, on the screen an employee uses to
// load their own test data:
//   • +page.svelte, the roster's Source column   <span class="badge teal">{d.sourceType}</span>
//   • +page.svelte, the mapping drawer           <span class="map-coltype">{col.type}</span>
// so a Dutch reader got "csv · xlsx · sql · postgres · storage · http" in a Source column headed
// "Bron", and "string / number / boolean / date / json" beside every column name in a drawer whose
// every other word was Dutch. The badge sitting immediately NEXT to the first one is already
// localized (`m.connector_test_source()`), which is what makes the raw enum read as an oversight
// rather than a convention. The wire carries the ENUM; the browser owns the words.
//
// ⚠️ SOME OF THESE VALUES ARE PROPER NOUNS AND STAY PUT. 'CSV', 'JSON', 'SQL' and 'Postgres' are
// names, not English — they are spelled the same in all eight catalogs and the point of routing
// them through the catalog is not to translate them but to let a locale that writes them
// DIFFERENTLY (Arabic and Hebrew set them LTR inside RTL prose) do so, and to put the two genuinely
// translatable groups — 'text', 'storage', 'http', and every column type — in the same mechanism as
// their neighbours instead of a second one.
//
// WHY AN EXHAUSTIVE SWITCH AND NOT A LOOKUP TABLE: paraglide compiles ONE function per message key
// and tree-shakes on the import graph, so `m[`dataset_source_${t}`]()` does not resolve — there is
// no runtime object to index. Spelled out at length in `stage-label.ts`, which this mirrors.
import * as m from '$lib/paraglide/messages';

/**
 * The reader's word for a dataset's source kind.
 *
 * The value set is CLOSED and comes from `backend/src/db/dataset-types.ts`
 * (`ALL_DATASET_SOURCE_TYPES` = the five uploads + the three connector kinds), which is the same
 * list as the `dataset_source_type` pg enum in `backend/src/db/schema.ts`. Pinned against that file
 * by `dataset-label.backend-contract.test.ts`, so a ninth member added server-side reds CI here
 * rather than shipping an English word.
 *
 * Takes `string`, not `DatasetSourceType`, and an unrecognised value returns THE RAW ENUM — which
 * is exactly what the screen rendered before this change. A source kind added server-side and
 * deployed one roll ahead of the browser ships an ugly token rather than a blank badge, and never
 * a blank one: `{''}` in a `.badge` is a coloured rectangle with nothing in it, which reads as a
 * dataset with no source at all.
 */
export function datasetSourceLabel(sourceType: string): string {
	switch (sourceType) {
		case 'csv':
			return m.dataset_source_csv();
		case 'xlsx':
			return m.dataset_source_xlsx();
		case 'sql':
			return m.dataset_source_sql();
		case 'text':
			return m.dataset_source_text();
		case 'json':
			return m.dataset_source_json();
		case 'postgres':
			return m.dataset_source_postgres();
		case 'storage':
			return m.dataset_source_storage();
		case 'http':
			return m.dataset_source_http();
		default:
			return sourceType;
	}
}

/**
 * The reader's word for an inferred column type.
 *
 * `DatasetColumnType` is closed — 'string' | 'number' | 'boolean' | 'date' | 'json' in
 * `backend/src/db/dataset-types.ts` — but this takes `string` and degrades to the raw value for a
 * reason beyond deploy skew: the ONTOLOGY carries a parallel attribute type that is NOT closed
 * (`ontology_attributes.type` is a bare `text` column, schema.ts) and renders in the same
 * vocabulary. This function is fit for that call site precisely because an unknown value comes back
 * out as itself instead of disappearing.
 */
export function datasetColumnTypeLabel(type: string): string {
	switch (type) {
		case 'string':
			return m.dataset_coltype_string();
		case 'number':
			return m.dataset_coltype_number();
		case 'boolean':
			return m.dataset_coltype_boolean();
		case 'date':
			return m.dataset_coltype_date();
		case 'json':
			return m.dataset_coltype_json();
		default:
			return type;
	}
}
