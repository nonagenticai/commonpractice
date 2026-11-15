<script lang="ts">
	// Read-only entity-relation graph for the Ontology screen, rendered with the
	// SvelteFlow we already own (@xyflow/svelte). Nodes are laid out deterministically
	// in columns by scope (generic | industry | specialization) since seeded entities
	// have no stored coordinates. No drag, no connect, no delete — selection only, so
	// clicking a node populates the parent's entity-detail panel.
	import {
		SvelteFlow,
		Background,
		Controls,
		BackgroundVariant,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { flowControlsAria } from '$lib/i18n/flow-controls-aria';
	// The edge's WORDS come from the relation's authored/translated `label`; its `id` stays keyed on
	// the canonical `predicate`. See $lib/i18n/ontology-relation-label.ts for why those must differ.
	import { ontologyRelationLabel } from '$lib/i18n/ontology-relation-label';
	import OntologyEntityNode from './OntologyEntityNode.svelte';
	import type { CompiledOntology, OntologyEntity, OntologyScope } from '$lib/types/ontology';

	let {
		ontology,
		onselect
	}: {
		ontology: CompiledOntology;
		onselect: (entity: OntologyEntity) => void;
	} = $props();

	const nodeTypes = { ontology: OntologyEntityNode };

	const COLUMN_X: Record<OntologyScope, number> = {
		generic: 40,
		industry: 400,
		industry_dept: 760
	};
	const Y_STEP = 190;
	const Y_TOP = 24;

	function layout(o: CompiledOntology): { nodes: Node[]; edges: Edge[] } {
		const perColumn: Record<OntologyScope, number> = {
			generic: 0,
			industry: 0,
			industry_dept: 0
		};
		const nodes: Node[] = o.entities.map((entity) => {
			const i = perColumn[entity.scope]++;
			return {
				id: entity.name,
				type: 'ontology',
				position: { x: COLUMN_X[entity.scope], y: Y_TOP + i * Y_STEP },
				data: { entity }
			};
		});
		const present = new Set(nodes.map((n) => n.id));
		const edges: Edge[] = o.relations
			.filter((r) => present.has(r.from) && present.has(r.to))
			.map((r, i) => ({
				id: `e${i}_${r.from}_${r.predicate}_${r.to}`,
				source: r.from,
				target: r.to,
				label: ontologyRelationLabel(r),
				labelStyle: 'font-size:10px;fill:var(--c-muted);',
				style: 'stroke:var(--c-border-strong, #cbd5e1);'
			}));
		return { nodes, edges };
	}

	// SvelteFlow wants bindable arrays; resync whenever the compiled graph changes.
	let nodes = $state<Node[]>([]);
	let edges = $state<Edge[]>([]);
	$effect(() => {
		const next = layout(ontology);
		nodes = next.nodes;
		edges = next.edges;
	});
</script>

<!-- Graphs are direction-neutral: force LTR so pan/zoom stays correct under RTL chrome. -->
<div class="onto-graph" dir="ltr">
	<!-- See FlowCanvas: the prop lives on the flow, and merges over the vendor's English defaults. -->
	<SvelteFlow
		bind:nodes
		bind:edges
		{nodeTypes}
		ariaLabelConfig={flowControlsAria()}
		fitView
		nodesDraggable={false}
		nodesConnectable={false}
		elementsSelectable={true}
		deleteKey={null}
		onnodeclick={({ node }) => {
			const entity = (node.data as { entity: OntologyEntity }).entity;
			onselect(entity);
		}}
	>
		<Background variant={BackgroundVariant.Dots} gap={18} size={1} bgColor="#FBFCFE" />
		<Controls position="bottom-left" showLock={false} />
	</SvelteFlow>
</div>

<style>
	.onto-graph {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
		background: #fbfcfe;
		direction: ltr;
	}
	.onto-graph :global(.svelte-flow) {
		direction: ltr;
	}
	.onto-graph :global(.svelte-flow__controls-button) {
		border-radius: var(--r-sm);
	}
</style>
