<script lang="ts">
	// The center canvas: a SvelteFlow bound to the builder's nodes/edges, plus the
	// drop target for palette drags. Must live inside <SvelteFlowProvider> so
	// useSvelteFlow() (→ screenToFlowPosition) has context.
	import {
		SvelteFlow,
		Background,
		Controls,
		BackgroundVariant,
		useSvelteFlow,
		type Connection,
		type Node
	} from '@xyflow/svelte';
	import { flowControlsAria } from '$lib/i18n/flow-controls-aria';
	import BlockNode from './BlockNode.svelte';
	import ForeachNode from './ForeachNode.svelte';
	import * as m from '$lib/paraglide/messages';
	import type { BuilderStore, CpNode } from '$lib/stores/builder.svelte';
	import { BLOCK_NODE_W } from '$lib/stores/builder-graph';

	let {
		builder,
		onDropBlock,
		onDropForeach,
		fitKey = '',
		hideEmptyHint = false
	}: {
		builder: BuilderStore;
		onDropBlock: (slug: string, position: { x: number; y: number }) => void;
		onDropForeach: (position: { x: number; y: number }) => void;
		/** Changes whenever a surrounding pane opens or closes; the canvas re-fits on each change. */
		fitKey?: string;
		/** The page draws its own start cards over an empty canvas; the drag hint would show through. */
		hideEmptyHint?: boolean;
	} = $props();

	const nodeTypes = { block: BlockNode, foreach: ForeachNode };
	const { screenToFlowPosition, fitView } = useSvelteFlow();

	// ⛔ A BARE `fitView` HAS NO ZOOM CEILING, so a two- or three-node flow was framed at up to 2×
	// and every new flow opened far too close. Fit with room around the graph and never above 1:1.
	const FIT_OPTIONS = { padding: 0.3, maxZoom: 1 } as const;

	// The store's ONE effective read-only (owner gate OR narrow-screen gate) — see `BuilderStore.locked`.
	const locked = $derived(builder.locked);

	// Re-fit when the canvas is resized by a pane opening or closing. Skips the first run: the
	// initial frame is the flow's own `fitView`, which waits for the nodes to be measured.
	let lastFitKey: string | null = null;
	$effect(() => {
		const key = fitKey;
		if (lastFitKey === null) {
			lastFitKey = key;
			return;
		}
		if (key === lastFitKey) return;
		lastFitKey = key;
		// After the grid has re-laid out (the pane transition is CSS, so wait a frame).
		requestAnimationFrame(() => void fitView({ ...FIT_OPTIONS, duration: 150 }));
	});

	// Estimated body-node footprint for the drag-into-loop hit test (block nodes don't report a
	// measured size until rendered; the container reports its own width/height).
	const NODE_H = 100;

	// Drop-zone affordance: highlight the canvas only while a palette block/loop is being
	// dragged over it (ignore unrelated drags by inspecting the dataTransfer types).
	let dragActive = $state(false);
	function isBlockDrag(e: DragEvent): boolean {
		const t = e.dataTransfer?.types;
		return !!t && (t.includes('application/cp-block') || t.includes('application/cp-foreach'));
	}
	function onDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		if (isBlockDrag(e)) dragActive = true;
	}
	function onDragLeave(e: DragEvent) {
		// Only clear when the cursor actually leaves the canvas, not when crossing child nodes.
		const wrap = e.currentTarget as HTMLElement;
		if (!wrap.contains(e.relatedTarget as globalThis.Node | null)) dragActive = false;
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragActive = false;
		// The palette tiles are not draggable in read-only mode, but a drag can also originate
		// OUTSIDE the app (a slug dragged from another tab's palette), and the highlight above has
		// already fired by the time we know. `builder.addNode` refuses either way; returning here is
		// what stops the page's `onDropBlock` spending a `GET /api/blocks/:slug` to build an entry
		// nothing will accept — and, on failure, painting an add-block error pill for an add that
		// was never going to happen.
		if (locked) return;
		const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
		const slug = e.dataTransfer?.getData('application/cp-block');
		if (slug) {
			onDropBlock(slug, position);
			return;
		}
		if (e.dataTransfer?.getData('application/cp-foreach')) onDropForeach(position);
	}
	function onConnect(c: Connection) {
		// SvelteFlow appends the edge itself via bind:edges; the store renames it to this app's
		// stable id — or, on a read-only canvas, takes it back out.
		//
		// ⛔ THE REWRITE USED TO LIVE HERE, GUARDED BY NOTHING BUT `nodesConnectable` BELOW. That
		// prop is the right affordance and the wrong home for the invariant — a component's markup
		// standing in for a rule the store enforces for every other writer. `builder.adoptConnection`
		// carries the reasoning; this stays a one-liner so there is no second place to forget it.
		builder.adoptConnection(c);
	}

	/** Absolute canvas position of a node (body nodes are positioned parent-relative). */
	function absPos(n: CpNode): { x: number; y: number } {
		if (!n.data.parentId) return n.position;
		const parent = builder.nodes.find((p) => p.id === n.data.parentId);
		return parent ? { x: n.position.x + parent.position.x, y: n.position.y + parent.position.y } : n.position;
	}

	// Drag-into-loop: when a node is dropped, attach it to the foreach region under its centre, or
	// detach it if it left its loop. Foreach containers themselves carry their body with them (skip).
	function onNodeDragStop({ targetNode }: { targetNode: Node | null }) {
		if (!targetNode) return;
		if (locked) return; // `nodesDraggable={false}` means this cannot fire; belt for the agent path
		const node = builder.nodes.find((n) => n.id === targetNode.id);
		if (!node || node.data.kind === 'foreach') return;

		const abs = absPos(node);
		const cx = abs.x + BLOCK_NODE_W / 2;
		const cy = abs.y + NODE_H / 2;
		const host = builder.nodes.find(
			(fe) =>
				fe.data.kind === 'foreach' &&
				cx >= fe.position.x &&
				cx <= fe.position.x + (fe.width ?? 340) &&
				cy >= fe.position.y &&
				cy <= fe.position.y + (fe.height ?? 190)
		);

		if (host && node.data.parentId !== host.id) builder.assignToLoop(node.id, host.id);
		else if (!host && node.data.parentId) builder.removeFromLoop(node.id);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- Graphs are direction-neutral (§5B): force LTR so pan/zoom + screenToFlowPosition
     stay correct even when the surrounding chrome flips to RTL. -->
<div
	class="canvas-wrap"
	class:drag-active={dragActive}
	dir="ltr"
	data-cp-canvas
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>
	<!-- ⛔ `ariaLabelConfig` GOES ON THE FLOW, NOT ON `<Controls>`. Controls.svelte reads
	     `store.ariaLabelConfig`, which the flow builds by merging this partial over @xyflow/system's
	     English `defaultAriaLabelConfig`; without it the zoom/fit buttons carried English `title=`
	     and `aria-label=` ("Zoom In", "Fit View") on an otherwise Dutch canvas. -->
	<!-- ⛔ THE READ-ONLY TERMS GO ON THE FLOW, NOT ON `bind:nodes`. `builder.readOnly` already
	     refuses every mutator in the store, but xyflow does not go through them: it writes
	     `builder.nodes` DIRECTLY through the binding, which is how a drag, a connect and a
	     Backspace-delete each land. Gating the binding instead would also swallow the MEASURED
	     width/height xyflow writes back through that same channel, and `fitView` would then have
	     nothing to frame — a read-only visitor would open on a canvas stuck at the origin. These
	     three props stop xyflow raising a graph mutation in the first place.
	     ⚠️ THEY ARE THE AFFORDANCE, NOT THE GUARANTEE. `nodesConnectable={false}` stops the drag; it
	     does NOT stop `onconnect`. The edge it would have appended is taken back out by
	     `builder.adoptConnection` (see `onConnect` above), which is where the read-only rule for a
	     connection actually lives — do not let this prop become the only thing holding that line. -->
	<!--
	     `deleteKey={null}` is xyflow's own "no key deletes" spelling; `[]` is not (an empty list is
	     read as "unset" and falls back to the default Backspace).
	     ⚠️ THERE IS NO `edgesReconnectable` PROP AT THIS VERSION and none is needed. `@xyflow/svelte`
	     1.6.0 has no flow-level reconnect switch (`SvelteFlowProps` carries `nodesDraggable`,
	     `nodesConnectable`, `elementsSelectable`, `edgesFocusable` and no reconnect sibling);
	     dragging an edge endpoint is opt-in per edge, through an `<EdgeReconnectAnchor>` inside a
	     custom edge component. This repo declares no `edgeTypes` at all, so every edge is the stock
	     bezier and no reconnect handle exists to disable. Adding the prop type-errors:
	       Object literal may only specify known properties, and "edgesReconnectable" does not exist. -->
	<SvelteFlow
		bind:nodes={builder.nodes}
		bind:edges={builder.edges}
		{nodeTypes}
		ariaLabelConfig={flowControlsAria()}
		fitView
		fitViewOptions={FIT_OPTIONS}
		minZoom={0.2}
		maxZoom={1.5}
		nodesDraggable={!locked}
		nodesConnectable={!locked}
		deleteKey={locked ? null : ['Backspace', 'Delete']}
		onconnect={onConnect}
		onnodedragstop={onNodeDragStop}
		onnodeclick={({ node }) => (builder.selectedNodeId = node.id)}
		onpaneclick={() => (builder.selectedNodeId = null)}
	>
		<Background variant={BackgroundVariant.Dots} gap={18} size={1} bgColor="#FBFCFE" />
		<Controls position="bottom-left" showLock={false} />
	</SvelteFlow>

	{#if builder.nodes.length === 0 && !hideEmptyHint}
		<div class="empty-hint">
			<span class="empty-icon" aria-hidden="true">
				<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<rect x="3" y="3" width="7" height="7" rx="1.5" />
					<rect x="14" y="3" width="7" height="7" rx="1.5" />
					<rect x="3" y="14" width="7" height="7" rx="1.5" />
					<path d="M14 17.5h7M17.5 14v7" />
				</svg>
			</span>
			<p>{m.canvas_empty_title()}</p>
			<span>{m.canvas_empty_hint()}</span>
		</div>
	{/if}

	{#if dragActive}
		<div class="drop-overlay" aria-hidden="true">
			<span>{m.canvas_drop_here()}</span>
		</div>
	{/if}
</div>

<style>
	.canvas-wrap {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
		background: #fbfcfe;
		/* Keep the graph + all xyflow internals LTR regardless of page dir. */
		direction: ltr;
	}
	.canvas-wrap :global(.svelte-flow) {
		direction: ltr;
	}
	.empty-hint {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		pointer-events: none;
		text-align: center;
	}
	.empty-hint p {
		font-size: 14px;
		color: var(--c-muted);
		margin: 0;
		font-weight: 500;
	}
	.empty-hint span {
		font-size: 12px;
		color: var(--c-faint);
	}
	.empty-icon {
		color: var(--c-border);
		margin-bottom: 6px;
		line-height: 0;
	}
	/* Match the demo canvas: light surface + xyflow controls toned down. */
	.canvas-wrap :global(.svelte-flow__controls-button) {
		border-radius: var(--r-sm);
	}
	/* Themed edges (replace xyflow's generic gray default). */
	.canvas-wrap :global(.svelte-flow__edge-path) {
		stroke: var(--c-teal-mid);
		stroke-width: 2;
	}
	.canvas-wrap :global(.svelte-flow__edge.selected .svelte-flow__edge-path),
	.canvas-wrap :global(.svelte-flow__edge:hover .svelte-flow__edge-path) {
		stroke: var(--c-teal-dark);
	}
	.canvas-wrap :global(.svelte-flow__connectionline .svelte-flow__connection-path) {
		stroke: var(--c-teal);
		stroke-width: 2;
	}
	/* Drop-zone feedback while dragging a palette block over the canvas. */
	.canvas-wrap.drag-active {
		box-shadow: inset 0 0 0 2px var(--c-teal);
	}
	.drop-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		background: color-mix(in srgb, var(--c-teal) 7%, transparent);
		z-index: 4;
	}
	.drop-overlay span {
		font-size: 13px;
		font-weight: 600;
		color: var(--c-teal-dark);
		background: var(--c-white);
		border: 1px solid var(--c-teal);
		border-radius: var(--r);
		padding: 6px 14px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
	}
</style>
