// src/lib/stores/block-catalog.svelte.ts — the LIVE, language-switch-reactive slug → name lookup
// behind every node title on the /build canvas, and the one binding of it that render sites import.
//
// ⛔ WHY THIS EXISTS AT ALL. `$lib/i18n/block-node-label` owns the RESOLUTION ORDER (catalog name →
// persisted label → slug) and is deliberately runes-free so it is unit-testable under the node-env
// vitest — exactly the split `builder-graph.ts` (pure) / `builder.svelte.ts` (reactive wrapper)
// already uses. What it cannot own is the CATALOG: that is live state, it changes when the reader
// switches language, and the components that need it cannot be handed it.
//
// ⛔ AND THAT LAST CLAUSE IS THE WHOLE REASON THIS IS A MODULE-LEVEL SINGLETON RATHER THAN A FIELD
// ON `BuilderStore` OR A SVELTE CONTEXT — DO NOT "TIDY" IT INTO EITHER.
//   • `BuilderStore` is threaded to `FlowCanvas` and `NodeConfigPanel` by prop, but NOT to
//     `BlockNode.svelte`/`ForeachNode.svelte`: SvelteFlow instantiates those itself from
//     `nodeTypes` (FlowCanvas.svelte:30) and hands them `NodeProps` — `data`, `selected`, `width`,
//     `height` — and nothing else. The node components are the PRIMARY render site and they are
//     precisely the ones a prop cannot reach.
//   • `setContext` would reach them (SvelteFlow renders nodes inside the provider's tree), but a
//     context can only be read during component init, so every render test would have to mount a
//     wrapper component purely to supply it — and a node mounted WITHOUT the wrapper would silently
//     fall back to the persisted label and pass. A test harness that can accidentally test the old
//     behaviour is the failure mode this lane keeps hitting.
//
// ⚠️ SINGLETON, AND ITS ONE COST STATED HONESTLY: the catalog outlives a visit to /build, unlike
// `BuilderStore` which is deliberately per-page. That is correct for THIS data — the block library
// is workspace-global and identical for every flow — and the stale window is bounded by the fact
// that `/build`'s `onMount` calls `loadPalette()` immediately. Between the mount and the response,
// nodes render from the persisted label, which is exactly the rung `blockNodeLabel` reserves for
// "the listing has not arrived yet".
//
// ⛔ THE PALETTE LISTING IS THE ONLY THING ALLOWED TO FEED THIS, AND `blockCache` IS NOT.
// `routes/build/+page.svelte` also holds `blockCache: Map<string, BlockDetail>` (:192), which
// carries a `name` for every slug in the open flow and is far more complete than the listing. It is
// also NEVER re-fetched on a language switch — `reloadLocalizedContent()` re-runs `loadPalette()`
// and nothing else, on purpose, because re-running `openFlow()` would discard unsaved canvas edits
// (see the ⛔ block at +page.svelte:517). Publishing `blockCache` here would therefore pour
// FIRST-LOCALE names into the lookup whose entire job is to be current, and the stale English this
// module exists to remove would come back through the fix. Only `blocksApi.list()` — re-fetched by
// `reloadOnLocaleChange`, `Accept-Language`-resolved server-side (api/auth-fetch.ts:61) — feeds it.
import { blockNodeLabel, type NamedNode } from '$lib/i18n/block-node-label';

/**
 * slug → the CURRENT locale's display name for that block.
 *
 * `$state.raw` because every write replaces the whole object; there is no per-key mutation to
 * track, and a raw rune keeps the reassignment as the single, cheap invalidation signal.
 *
 * Module-level state, read through the exported functions below — a `let` that is reassigned cannot
 * be exported directly from a rune module, and a function is the right shape anyway: it is what
 * `blockNodeLabel` takes.
 */
let names = $state.raw<Record<string, string>>({});

/** The listing rows this cares about — structurally satisfied by `BlockListItem`. */
export interface CatalogEntry {
	slug: string;
	name: string;
}

/**
 * Replace the catalog with the rows a fresh `GET /api/blocks` returned.
 *
 * ⛔ REPLACE, NOT MERGE. A merge would keep a block that has since been archived out of the listing
 * alive in the lookup for the rest of the session, and — worse — would keep its name in whatever
 * locale it was last seen in after a language switch dropped it from the response. An honestly
 * empty catalog is a correct catalog: `blockNodeLabel` falls straight through to the persisted
 * label, which is what a node with no library entry should show.
 *
 * ⛔ AND THE FAILURE PATH MUST NOT CALL THIS. `loadPalette()` answers a failed listing with
 * `paletteItems = []` + an error pill; publishing that `[]` would re-anglicise every node on the
 * canvas because one request 500'd. A failed refresh leaves the last good catalog standing — the
 * same reading `NodeConfigPanel` applies to its dataset list on a failed retry.
 *
 * Rows with a blank slug or a non-string name are dropped rather than stored: `has()` in
 * `blockNodeLabel` would reject them at read time anyway, and keeping them here would make the
 * lookup's own contents a lie.
 */
export function publishBlockCatalog(items: readonly CatalogEntry[]): void {
	const next: Record<string, string> = {};
	// `Array.isArray`, not a bare loop: this is fed straight from an HTTP body, and a backend one
	// roll ahead (or a proxy returning an error page as JSON) can hand us anything. A `TypeError`
	// thrown here would surface as "the block library failed to load" — an honest-looking pill about
	// a request that actually succeeded.
	for (const item of Array.isArray(items) ? items : []) {
		if (item && typeof item.slug === 'string' && item.slug && typeof item.name === 'string') {
			next[item.slug] = item.name;
		}
	}
	names = next;
}

/**
 * The current locale's name for a slug, or `undefined` when the catalog does not hold it.
 *
 * `undefined` covers three different situations that all take the same fallback rung — the listing
 * has not arrived, the listing failed, or the block was archived between the flow's save and this
 * load. See `blockNodeLabel`.
 */
export function catalogBlockName(slug: string): string | undefined {
	return names[slug];
}

/**
 * ⛔ THE ONE FUNCTION EVERY RENDER SITE CALLS. Five places print a node's name — `BlockNode`'s
 * canvas header, `ForeachNode`'s container header, `NodeConfigPanel`'s `.cfg-title` and its
 * "add to loop" `<option>` list, and `issueNodeLabel` in `routes/build/+page.svelte` — and this lane
 * has already been fixed four times, once per site, because the resolution lived at the sites. Three
 * of them still carried their own copy of `kind === 'foreach' ? m.foreach_palette_label() : label`.
 * They now share this, so the NEXT rung added to the order reaches all five at once.
 *
 * ⚠️ REACTIVE BY CALL SITE, WITH NO `$derived` REQUIRED HERE. Reading `names` inside this function
 * registers the dependency on whatever reactive scope invoked it — a template expression, a
 * `$derived`, an `$effect` — so a language switch that re-runs `loadPalette()` and republishes
 * re-titles every node already on the canvas, with no reload and without touching `flows.graph`.
 */
export function nodeDisplayName(node: NamedNode): string {
	return blockNodeLabel(node, catalogBlockName);
}
