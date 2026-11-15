<script lang="ts">
	// Read-only ontology entity node for the Ontology screen graph. Modeled on
	// BlockNode.svelte (Handle/Position/NodeProps) but renders an entity: its label,
	// the layer it came from (scope), and its typed attributes with PII badges. One
	// target handle (left) + one source handle (right) so relation edges attach.
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import * as m from '$lib/paraglide/messages';
	import { ontologyScopeLabel } from '$lib/i18n/ontology-axis-label';
	// `ontology_attributes.type` is a bare `text` column and renders in the SAME vocabulary as a
	// dataset column's type, so it uses the same labeller — whose `default:` arm returns the raw
	// value precisely because this call site's value set is not closed. See dataset-label.ts.
	import { datasetColumnTypeLabel } from '$lib/i18n/dataset-label';
	import type { OntologyEntity } from '$lib/types/ontology';

	let { data, selected }: NodeProps & { data: { entity: OntologyEntity } } = $props();

	const entity = $derived(data.entity);

	// ⛔ THE LOCAL `scopeLabel` IS GONE — it was a second mechanism for the same three words.
	// It read `if generic … if industry … return industry_dept`, i.e. an unrecognised scope fell
	// through to "Specialisatie" and asserted a layer the entity is not in. `ontologyScopeLabel`
	// returns the raw value there instead, which is the house rule for an enum→words module.
	// Same reason /submit's `DOMAINS` table was deleted: two mechanisms for one word is the defect.
</script>

<div class="onto-node" class:selected class:generic={entity.scope === 'generic'}
	class:industry={entity.scope === 'industry'} class:cell={entity.scope === 'industry_dept'}>
	<Handle type="target" position={Position.Left} />
	<div class="onto-node-head">
		<span class="onto-node-name">{entity.label}</span>
		{#if entity.tenantOwned}<span class="onto-custom">{m.ontology_custom()}</span>{/if}
		<span class="onto-scope {entity.scope}">{ontologyScopeLabel(entity.scope)}</span>
	</div>
	<div class="onto-attrs">
		{#each entity.attributes as a (a.name)}
			<div class="onto-attr">
				<span class="attr-name">{a.name}</span>
				<span class="attr-type">{datasetColumnTypeLabel(a.type)}</span>
				{#if a.pii}<span class="attr-pii">{m.ontology_pii()}</span>{/if}
			</div>
		{/each}
		{#if entity.attributes.length === 0}<div class="onto-attr empty">—</div>{/if}
	</div>
	<Handle type="source" position={Position.Right} />
</div>

<style>
	.onto-node {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh);
		width: 212px;
		font-family: var(--font-sans);
		overflow: hidden;
	}
	.onto-node.selected {
		border-color: var(--c-teal);
		box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.18);
	}
	/* A left accent bar tinted by which layer contributed the entity. */
	.onto-node-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 9px 11px;
		border-bottom: 1px solid var(--c-border);
		border-inline-start: 3px solid var(--c-border);
	}
	.onto-node.generic .onto-node-head {
		border-inline-start-color: var(--c-teal);
	}
	.onto-node.industry .onto-node-head {
		border-inline-start-color: var(--c-violet, #7c3aed);
	}
	.onto-node.cell .onto-node-head {
		border-inline-start-color: var(--c-amber, #f59e0b);
	}
	.onto-node-name {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-midnight);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.onto-scope {
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		font-weight: 600;
		padding: 2px 6px;
		border-radius: 999px;
		white-space: nowrap;
		flex-shrink: 0;
		color: var(--c-muted);
		background: var(--c-surface);
	}
	.onto-scope.generic {
		color: var(--c-teal-dark);
		background: var(--c-teal-light);
	}
	.onto-scope.industry {
		color: #5b21b6;
		background: var(--c-violet-light, #ede9fe);
	}
	.onto-scope.industry_dept {
		color: #92400e;
		background: var(--c-amber-light, #fef3c7);
	}
	.onto-custom {
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		font-weight: 700;
		padding: 2px 6px;
		border-radius: 999px;
		white-space: nowrap;
		flex-shrink: 0;
		color: #5b21b6;
		background: var(--c-violet-light, #ede9fe);
	}
	.onto-attrs {
		padding: 6px 11px 10px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 200px;
		overflow-y: auto;
	}
	.onto-attr {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		line-height: 17px;
	}
	.attr-name {
		color: var(--c-ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.attr-type {
		color: var(--c-faint);
		margin-inline-start: auto;
		flex-shrink: 0;
	}
	.attr-pii {
		flex-shrink: 0;
		font-family: var(--font-sans);
		font-size: 8.5px;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--c-coral-dark);
		background: var(--c-coral-light);
		padding: 0 4px;
		border-radius: 4px;
	}
	.onto-attr.empty {
		color: var(--c-faint);
	}
	.onto-node :global(.svelte-flow__handle) {
		width: 8px;
		height: 8px;
		background: var(--c-white);
		border: 2px solid var(--c-teal);
	}
	.onto-node :global(.svelte-flow__handle-right) {
		border-color: var(--c-coral);
	}
</style>
