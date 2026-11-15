<script lang="ts">
	// The block chain of a solution's flow, rendered as a mono left-to-right pipeline
	// (solution-detail "The flow X built"). Each node deep-links to that block's editor
	// so the chain is explorable; "Open in Build" loads the whole graph on the S2 canvas.
	//
	// ⛔ THE SIXTH RENDER SITE OF A BLOCK NAME, AND THE ONE THAT WAS MISSED. This printed `{slug}` —
	// `read-claim-form → group-and-count → ai-summarize` — inside a card whose heading, caption and
	// link were all localized. It could not be fixed the way the other five were: `nodeDisplayName`
	// reads a store that only `/build`'s `loadPalette()` ever publishes, so on `/solutions/[id]` it
	// is empty and would have resolved every chip straight back to its slug. The name therefore
	// arrives ON THE DTO, resolved server-side where the block catalogue and the locale negotiation
	// already live (backend/src/blocks/block-display-names.ts).
	//
	// ⚠️ THE PROP TAKES THE RAW WIRE VALUE, NOT A PRE-NORMALISED ARRAY, so the two shapes an
	// in-flight roll can produce are handled in ONE place — see `$lib/solutions/flow-chain`.
	import { normalizeChain, type WireChainNode } from '$lib/solutions/flow-chain';
	import * as m from '$lib/paraglide/messages';
	let { chain }: { chain: readonly WireChainNode[] } = $props();

	const nodes = $derived(normalizeChain(chain));
</script>

<div class="chain">
	{#each nodes as node, i (i)}
		<!-- ⚠️ THE TOOLTIP KEEPS THE SLUG WHILE THE CHIP SHOWS THE NAME, and that is not an oversight.
		     `slug` is what `?slug=` carries and what `RunConsole` prints on purpose; it is the one
		     thing on this chip a reader can paste into a bug report. The visible word is the half
		     that had to become readable. -->
		<a class="node" href={`/block-edit?slug=${encodeURIComponent(node.slug)}`} title={m.flowchain_open_block({ slug: node.slug })}>{node.name}</a>
		{#if i < nodes.length - 1}<span class="arrow cp-dir-mirror" aria-hidden="true">→</span>{/if}
	{/each}
</div>

<style>
	.chain {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		font-family: var(--font-mono);
		font-size: 12.5px;
	}
	.node {
		padding: 5px 10px;
		border-radius: var(--r);
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		color: var(--c-teal-dark);
		white-space: nowrap;
		text-decoration: none;
		transition: border-color 0.12s, background 0.12s;
	}
	.node:hover {
		border-color: var(--c-teal);
		background: var(--c-teal-light);
	}
	.arrow {
		color: var(--c-faint);
	}
</style>
