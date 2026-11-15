// src/lib/i18n/ontology-axis-label.ts — the ONE place an ontology MATRIX AXIS value (an industry,
// a department) or an entity SCOPE becomes words a reader can read.
//
// ⚠️ THAT "ONE PLACE" CLAIM WAS FALSE WHEN IT WAS FIRST WRITTEN, and is worth reading as a warning
// rather than a boast. The first version of this module fixed /ontology, asserted itself the single
// source of the vocabulary, and shipped with FOUR other live render sites untouched — including
// /datasets, which shows the same two chip rows under the same two translated labels and is equally
// nav-open to every tenant member (navConfig.ts:111). The guard written alongside it read exactly
// one route file, so it could not have seen them. The claim is true NOW because
// ontology-axis-label.test.ts walks every .svelte under src/ and fails on any raw axis render; it
// is not true because this comment says so. If you add a render site, that scan is what holds it.
//
// ⛔ THE DEFECT, as originally measured on /ontology (layout/navConfig.ts:122) — two chip rows plus
// a graph header, all rendered raw:
//
//     routes/ontology/+page.svelte:506   {ind}                        → the industry chips
//     routes/ontology/+page.svelte:515   {dept}                       → the department chips
//     routes/ontology/+page.svelte:526   {industry} × {department}    → the graph header
//     routes/ontology/+page.svelte:596   {selectedEntity.scope}       → the detail-panel subtitle
//
// …and the four sites the first pass missed:
//
//     routes/datasets/+page.svelte:608,614          the mapping cell picker — SAME defect, verbatim
//     routes/block-edit/+page.svelte:1000,1004      the ontology-import <select>
//     lib/components/build/EntityDeriveBrowser.svelte:135,139
//     lib/components/build/BlockAuthorAssistant.svelte:103,110
//
// The three `<select>` sites take the same treatment with one extra rule: an `<option>`'s TEXT is
// what a human reads, its `value` is what gets submitted and matched against the ontology_entities
// columns. Label the text, never the value. (`BlockAuthorAssistant` copies the axes into local
// `industries`/`departments` variables first, so it renders a BARE identifier — which is how both
// a `grep` for `.industries` and the first version of the regression scan under-reported.)
//
// The values are lowercase English slugs and English nouns straight out of
// backend/src/ontology/seed/*.json — `banking` / `healthcare` / `insurance`, and `Claims` /
// `Finance` / `HR` / `Legal` / `Marketing` / `Ops` / `Sales` / `Service`. So the Dutch graph header
// read `insurance × Claims` while the entities INSIDE the graph beneath it read "Schadeclaim" and
// "Polis", localized server-side. Same species as `workAreaLabel` beside this file, fixed the same
// way — and deliberately on the SAME `domain_*` vocabulary, because "Claims" is one word in this
// product and must not be "Schadeclaims" on /challenges and "Claims" on /ontology.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ WHY THIS IS A BROWSER-SIDE MODULE AND NOT `negotiateLocale` ON THE MATRIX ENDPOINT.
//
// The obvious reading of the asymmetry at backend/src/routes/ontology.ts is that `getMatrix` (:51)
// forgot the `negotiateLocale` call `getOntology` (:65) makes one line below, and that adding it
// fixes this. It does not. Three independent reasons, in the order they bite:
//
//  1. THE AXIS VALUES ARE ROUTING VALUES, NOT DISPLAY PROSE. `selectIndustry(ind)` stores the chip's
//     string and `loadGraph()` sends it straight back as `GET /api/ontology?industry=<v>&
//     department=<v>` (lib/api/ontology.ts:37-38), where `compileEffective` matches it against the
//     `ontology_entities.industry` / `.department` COLUMNS. A localized matrix would make the very
//     next request ask for `industry=Verzekeringen`, which matches no row: the chips would
//     translate and the graph beneath them would go empty. This is exactly the hazard already
//     written up for `work_area` in work-area-label.ts — a value that is a word AND a key.
//
//  2. THERE IS NOTHING TO TRANSLATE THEM FROM. `content_translations` has exactly four namespaces —
//     `ontology_entity`, `ontology_entity_tenant`, `ontology_attribute`, `ontology_relation`
//     (backend/src/ontology/ontology-service.ts:42-50) — every one keyed by an entity / attribute /
//     relation natural key. No namespace, no seed row (backend/src/db/seed-ontology-i18n.ts) and no
//     write path exists for a bare industry or department STRING. `negotiateLocale` on `getMatrix`
//     would compile, pass review, ship, and return byte-identical output in all eight locales: a
//     no-op wearing the shape of a fix.
//
//  3. THE ONLY BACKEND FIX THAT COULD WORK IS A WIRE NARROWING. To carry a label server-side the
//     matrix would have to return `{value,label}[]` instead of `string[]`. That breaks BOTH halves
//     of a rolling deploy (#233): a new frontend against the old backend reads `.label` off a
//     string and renders `undefined × undefined`; an old frontend against the new backend renders
//     `[object Object]`. Paying that for reason 2's no-op is not a trade.
//
// ⚠️ THE VOCABULARY IS OPEN, NOT A CLOSED ENUM — which is why `default: return the raw value` here
// is load-bearing rather than defensive. `createEntitySchema` types both axes as
// `z.string().max(80).nullish()` (backend/src/routes/ontology.ts:85-86) — FREE TEXT, no `z.enum` —
// and `listMatrix` unions tenant-owned rows into the axes it returns
// (backend/src/ontology/ontology-service.ts:463-466). So an org admin adding one custom entity can
// put a brand-new industry or department on these chips, and the raw fallback is the ORDINARY path
// for it, not an error case. A prettified guess there would be a lie about a word the tenant chose;
// the raw slug reads as the slug it is. (Same rule, same reason, as `ontologyActionLabel` beside
// this file.)
//
// WHY EXHAUSTIVE SWITCHES AND NOT LOOKUP TABLES: see the note in work-area-label.ts — paraglide
// compiles one function per key and tree-shakes on the import graph, so a `Record<string, () =>
// string>` only works where the whole `messages` namespace is already retained.
import * as m from '$lib/paraglide/messages';
import { workAreaLabel } from './work-area-label';

/**
 * The reader's word for a matrix INDUSTRY axis value.
 *
 * The three shipped verticals are the top-level `industry` key of each
 * backend/src/ontology/seed/*.json overlay — lowercase slugs, which is why they read as slugs.
 * Takes `string` and returns the RAW VALUE for anything else: a tenant entity may carry any
 * industry string at all (see the header note).
 */
export function industryLabel(industry: string): string {
	switch (industry) {
		case 'banking':
			return m.industry_banking();
		case 'healthcare':
			return m.industry_healthcare();
		case 'insurance':
			return m.industry_insurance();
		default:
			return industry;
	}
}

/**
 * The reader's word for a matrix DEPARTMENT axis value.
 *
 * ⛔ DELIBERATELY THE SAME `domain_*` VOCABULARY AS `workAreaLabel`. The two enums are NOT the same
 * enum — `WORK_AREAS` (backend/src/routes/challenges.ts:33) carries `Risk` and `IT`, which no seed
 * department uses, and the ontology axis carries `Finance` and `HR`, which no work area uses — but
 * the six they share are the same six words about the same six departments. Resolving them through
 * one message family is the whole point: a reader who filters challenges by "Schadeclaims" must
 * find "Schadeclaims" on the ontology chip too. `workAreaLabel` does the shared six (and returns
 * the raw value for anything it does not know), so this function adds only the two ontology-only
 * departments on top and delegates the rest — one switch owns each word, not two.
 *
 * Returns the RAW VALUE for an unknown department, by delegation.
 */
export function departmentLabel(department: string): string {
	switch (department) {
		case 'Finance':
			return m.domain_finance();
		case 'HR':
			return m.domain_hr();
		default:
			return workAreaLabel(department);
	}
}

/**
 * The reader's word for an entity's `scope`.
 *
 * ⚠️ THE VALUES ARE `generic` / `industry` / `industry_dept` — NOT `global`. The tri-state is
 * declared twice and agrees with itself: `z.enum(['generic','industry','industry_dept'])`
 * (backend/src/routes/ontology.ts:83) and `type OntologyScope` (lib/types/ontology.ts:5). This is a
 * genuinely CLOSED enum — unlike the two axes above, `scope` is validated on write — and the three
 * `ontology_scope_*` keys it resolves already existed in all eight catalogs, authored for the
 * add-entity form's scope picker. The detail panel simply never used them.
 *
 * Still returns the raw value on a miss: a fourth scope added server-side should ship an
 * untranslated word rather than a blank subtitle.
 */
export function ontologyScopeLabel(scope: string): string {
	switch (scope) {
		case 'generic':
			return m.ontology_scope_generic();
		case 'industry':
			return m.ontology_scope_industry();
		case 'industry_dept':
			return m.ontology_scope_industry_dept();
		default:
			return scope;
	}
}
