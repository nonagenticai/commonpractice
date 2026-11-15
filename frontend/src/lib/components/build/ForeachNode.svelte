<script lang="ts">
	// Phase 5 — a bounded-loop CONTAINER node. Renders as a resizable, translucent region; loop body
	// nodes (parentId = this node's id) render as normal BlockNodes on top of it and move with it.
	// Ports mirror FOREACH_NODE_DESCRIPTOR: `in` (the rowset) on the left; item/index/results/count/
	// errors on the right. The header is the drag handle; NodeResizer lets the region be sized.
	import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/svelte';
	import type { BlockNodeData } from '$lib/stores/builder.svelte';
	import * as m from '$lib/paraglide/messages';
	import { nodeDisplayName } from '$lib/stores/block-catalog.svelte';
	import {
		FOREACH_MIN_H,
		FOREACH_MIN_W,
		FOREACH_NODE_DESCRIPTOR,
		FOREACH_RESIZE_MIN_H,
		FOREACH_RESIZE_MIN_W
	} from '$lib/stores/builder-graph';
	import { portLabel } from '$lib/i18n/port-label';
	import { num } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';

	let { data, selected, width, height }: NodeProps & { data: BlockNodeData } = $props();

	const OUT_PORTS = ['item', 'index', 'results', 'count', 'errors'] as const;
	const maxIter = $derived(data.loop?.maxIterations ?? null);
</script>

<div class="cp-foreach" class:selected style="width:{width ?? FOREACH_MIN_W}px;height:{height ?? FOREACH_MIN_H}px">
	<NodeResizer minWidth={FOREACH_RESIZE_MIN_W} minHeight={FOREACH_RESIZE_MIN_H} isVisible={selected} />

	<div class="fe-head" data-drag-handle>
		<span class="fe-icon">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
				<path d="M17 2l4 4-4 4" />
				<path d="M3 11V9a4 4 0 0 1 4-4h14" />
				<path d="M7 22l-4-4 4-4" />
				<path d="M21 13v2a4 4 0 0 1-4 4H3" />
			</svg>
		</span>
		<!-- ⛔ THE CATALOG STRING, NOT `data.label`, AND THE FIX BELONGS **HERE** RATHER THAN IN
		     `newForeachNode`. `label` is serialized by `toGraph()` and PERSISTED into `flows.graph`,
		     so localizing at CREATION time would freeze the creator's locale into the saved flow for
		     ever — a Dutch author's flow would greet a French colleague in Dutch, and re-opening it
		     in another language would not change it back. The stored label stays `'For each row'`
		     byte-for-byte (the wire/machine half, exactly as `i18n/graph-issue-label.ts` keeps the
		     backend's English `message`); the browser owns the words.

		     ⚠️ NO `data.kind === 'foreach'` GUARD, ON PURPOSE. The DISCRIMINATOR IS THIS COMPONENT:
		     it is registered as `nodeTypes.foreach`, and `flowToCanvasNodes` derives
		     `type: n.kind === 'foreach' ? 'foreach' : 'block'` from the same field — so a node that
		     reaches this file provably has `kind: 'foreach'`. A condition that cannot be false reads
		     as a real branch and invites someone to "fix" the dead arm.

		     ⚠️ `foreach_palette_label` REUSED, NOT A NEW `foreach_node_label` SIBLING. The palette
		     tile and the node it creates are one object named twice, and the visible bug was exactly
		     that the tile was already localized while its own node was not — two keys would let that
		     divergence come back as a translation drift instead of as a missing string. Longest of
		     the eight is pl "Pętla (dla każdego wiersza)" (27 chars, narrower in the sans 12px of
		     `.fe-title` than it was in mono), inside the header `FOREACH_MIN_W` leaves after padding,
		     icon, gaps and the iteration badge — and `.fe-title` already ellipsises past that.

		     ⚠️ ROUTED THROUGH `nodeDisplayName` RATHER THAN CALLING `m.foreach_palette_label()`
		     DIRECTLY, AND THE RENDERED STRING IS UNCHANGED. Everything above still holds — it is now
		     stated once, as rung 1 of `$lib/i18n/block-node-label`, instead of five times across the
		     five sites that print a node's name. This file was the site that got it RIGHT first; it
		     joins the shared helper so the block nodes beside it cannot drift away from it again. -->
		<span class="fe-title">{nodeDisplayName(data)}</span>
		<!-- ⛔ GROUPED, NOT EXCLUDED, AND THE `count` NAME IS MISLEADING. `foreach_iter_badge` is a
		     PLAIN message ("× up to {count}"), not one of the ten plurals, so there is no selector to
		     break and mechanism A — `num()` at the call site — is the right one. And the figure really
		     does reach four digits: `HARD_MAX_ITERATIONS` is 1000 and `NodeConfigPanel.setMaxIter`
		     CLAMPS to exactly that, so "× up to 1000" is the value an operator lands on by dragging
		     the input to its ceiling, printed one panel away from the `≤ 1.000` bound itself. -->
		{#if maxIter !== null}
			<span class="fe-badge" title={m.foreach_max_iterations()}>{m.foreach_iter_badge({ count: num(maxIter, locale.current) })}</span>
		{/if}
	</div>

	<div class="fe-hint">{m.foreach_empty_hint()}</div>

	<!-- in: rowset to iterate -->
	<Handle type="target" position={Position.Left} id="in" style="top:21px" />
	<!-- outputs: per-iteration item/index + aggregates -->
	{#each OUT_PORTS as p, i (p)}
		<div class="fe-out-label" data-port={p} style="top:{36 + i * 20}px">{portLabel(p, FOREACH_NODE_DESCRIPTOR.outputs[p])}</div>
		<Handle type="source" position={Position.Right} id={p} style="top:{42 + i * 20}px" />
	{/each}
</div>

<style>
	.cp-foreach {
		box-sizing: border-box;
		background: color-mix(in srgb, var(--c-teal) 5%, transparent);
		border: 1.5px dashed var(--c-teal-light);
		border-radius: var(--r-lg);
		position: relative;
	}
	.cp-foreach.selected {
		border-color: var(--c-teal);
		box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.14);
	}
	.fe-head {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 6px 10px;
		background: color-mix(in srgb, var(--c-teal) 12%, var(--c-white));
		border-bottom: 1px solid var(--c-teal-light);
		border-radius: var(--r-lg) var(--r-lg) 0 0;
		cursor: grab;
	}
	.fe-head:active {
		cursor: grabbing;
	}
	.fe-icon {
		display: flex;
		align-items: center;
		color: var(--c-teal-dark);
		flex-shrink: 0;
	}
	.fe-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--c-teal-dark);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
		min-width: 0;
	}
	.fe-badge {
		flex-shrink: 0;
		font-size: 10px;
		font-weight: 600;
		color: var(--c-teal-dark);
		background: var(--c-white);
		border: 1px solid var(--c-teal-light);
		border-radius: 999px;
		padding: 1px 7px;
	}
	.fe-hint {
		position: absolute;
		inset: 40px 14px 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		text-align: center;
		font-size: 11.5px;
		color: var(--c-teal-dark);
		opacity: 0.5;
		pointer-events: none;
	}
	.fe-out-label {
		position: absolute;
		inset-inline-end: 12px;
		font-size: 10.5px;
		color: var(--c-teal-dark);
		pointer-events: none;
		transform: translateY(-50%);
	}
	.cp-foreach :global(.svelte-flow__handle) {
		width: 9px;
		height: 9px;
		background: var(--c-white);
		border: 2px solid var(--c-teal);
	}
	.cp-foreach :global(.svelte-flow__handle-right) {
		border-color: var(--c-coral);
	}
</style>
