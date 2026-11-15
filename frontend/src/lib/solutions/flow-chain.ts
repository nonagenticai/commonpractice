// src/lib/solutions/flow-chain.ts — the wire shape of a solution's block chain, normalised.
//
// ⛔ WHY A MODULE AND NOT A `$derived` IN THE PAGE. `SolutionDetail.flow.chain` changed shape:
// `string[]` (bare slugs) became `{ slug, name }[]`, because `FlowChain.svelte` rendered `{slug}`
// and a Dutch reader met `read-claim-form → ai-summarize` inside a fully Dutch card. The SPA's own
// slug→name store cannot repair that on this route — it is published only by `/build`'s palette
// fetch, so on `/solutions/[id]` it is empty — which is why the NAME now rides down on the DTO.
//
// ⚠️ BOTH SHAPES ARE ACCEPTED FOR ONE RELEASE, AND THIS IS THE MID-ROLL WINDOW, NOT SCAFFOLDING.
// The browser reaches the API through the Service, so a new bundle really is answered by an old pod
// for the length of a roll — and a cached old bundle really is answered by the new API. Reading
// `chain[i].slug` off a plain string yields `undefined`, and rendering an object yields
// `[object Object]`; both are worse than what either version shipped alone. Delete the string arm
// only once no pod can answer with it.
//
// ⚠️ RUNES-FREE ON PURPOSE — same split as `i18n/block-node-label.ts`: the pure rule lives here and
// is unit-testable under the node-env vitest, the reactive binding lives at the render site.

/** One chip in the chain: the LINK TARGET and the reader's word for it. */
export interface ChainNode {
	slug: string;
	name: string;
}

/** The two shapes `flow.chain` can arrive in — see the header. */
export type WireChainNode = string | ChainNode;

/** Is this a name, or an absence wearing a name's type? Same reading as `has()` in
 *  `i18n/block-node-label.ts`: a blank name renders as a chip with no title, which is strictly worse
 *  than the English identifier it would have replaced, and `??` cannot tell the two apart. */
function has(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

/**
 * The literal slug a `foreach` loop CONTAINER carries in `flows.graph`.
 *
 * `newForeachNode` (stores/builder-graph.ts) stamps it, `canvasToFlowGraph` persists it, and the
 * block library has never had a row for it — `/block-edit?slug=foreach` is a 404 by construction.
 */
const FOREACH_TOKEN = 'foreach';

/**
 * `flow.chain` off the wire → the chips to render.
 *
 * ⛔ THE `foreach` DROP APPLIES TO THE STRING ARM ONLY, AND THE ASYMMETRY IS DELIBERATE. The object
 * arm comes from a server that has already applied the AUTHORITATIVE filter — `node.kind !== 'foreach'`
 * on the persisted graph (backend/src/routes/solutions.ts), the same predicate
 * `resolveExecutableBlocks` uses. Re-guessing it here by slug would hide a tenant block that
 * legitimately owns that slug (0037 dropped global slug uniqueness, so one can exist). The string
 * arm carries no `kind` at all, so the literal token is the only signal there is — and printing it
 * as a block, linking to a 404, is the defect this drop exists for.
 *
 * Everything that is not a usable entry is dropped rather than rendered as a blank chip: a chain is
 * a list of links, and a link with no target is not a degraded link, it is a lie about one.
 */
export function normalizeChain(
	chain: readonly (WireChainNode | null | undefined)[] | null | undefined
): ChainNode[] {
	// `Array.isArray`, not a bare loop: this is fed straight from an HTTP body, and a backend one
	// roll ahead (or a proxy answering with an error page) can hand us anything at all.
	if (!Array.isArray(chain)) return [];
	const out: ChainNode[] = [];
	for (const entry of chain) {
		if (typeof entry === 'string') {
			if (!has(entry) || entry.trim() === FOREACH_TOKEN) continue;
			// No name on this wire shape. The slug is the last rung of `blockNodeLabel`'s order and it
			// is a rung, not a bug — a chip with no title is worse than an English identifier.
			out.push({ slug: entry.trim(), name: entry.trim() });
			continue;
		}
		if (!entry || typeof entry !== 'object') continue;
		const slug = (entry as ChainNode).slug;
		if (!has(slug)) continue;
		const name = (entry as ChainNode).name;
		out.push({ slug, name: has(name) ? name : slug });
	}
	return out;
}
