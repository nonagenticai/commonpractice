<script lang="ts">
	// A pipeline stage column (demo .kan-col). Accepts dropped cards (vanilla HTML5
	// DnD) and asks the page to move them; the page applies the move + governance gate.
	import KanbanCard from './KanbanCard.svelte';
	import type { PipelineColumn, PipelineCard, PipelinePolicy, Stage } from '$lib/types/pipeline';
	import * as m from '$lib/paraglide/messages';
	// The head reads from `column.stage` (the enum, already on the DTO), never `column.title`
	// (the backend's hard-coded English "In review / Staging · canary / Production", which the
	// board rendered verbatim in a Dutch UI). `title` stays on the wire one more deploy so an
	// OLD frontend against a NEW backend does not get four blank column heads — but nothing
	// here reads it, and no `?? column.title` fallback: that would restore the English.
	import { stageLabel } from '$lib/i18n/stage-label';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	let {
		column,
		busyId = null,
		policy,
		onMove,
		onToggleReview,
		onRollback
	}: {
		column: PipelineColumn;
		busyId?: string | null;
		/** Board-level governance policy (0062), threaded down so each card can render "N of M".
		 *  Absent when the backend has not rolled yet — the card falls back to the old copy. */
		policy?: PipelinePolicy;
		onMove: (cardId: string, fromStage: Stage, toStage: Stage) => void;
		onToggleReview: (card: PipelineCard) => void;
		onRollback?: (card: PipelineCard) => void;
	} = $props();

	let over = $state(false);

	function onDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		over = true;
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		over = false;
		const payload = e.dataTransfer?.getData('application/cp-pipeline');
		if (!payload) return;
		const [cardId, fromStage] = payload.split('|') as [string, Stage];
		if (fromStage === column.stage) return; // same column → no-op
		onMove(cardId, fromStage, column.stage);
	}
</script>

<div
	class="kan-col"
	class:over
	ondragover={onDragOver}
	ondragleave={() => (over = false)}
	ondrop={onDrop}
	role="list"
	aria-label={stageLabel(column.stage)}
>
	<div class="kan-head">
		<span class="kan-name">{stageLabel(column.stage)}</span>
		<span class="kan-count">{num(column.count, locale.current)}</span>
	</div>
	{#each column.items as card (card.id)}
		<KanbanCard {card} busy={busyId === card.id} {policy} {onToggleReview} {onRollback} />
	{/each}
	{#if column.items.length === 0}
		<div class="kan-empty">{m.ops_kanban_drop_here()}</div>
	{/if}
</div>

<style>
	.kan-col {
		background: var(--c-surface);
		border-radius: var(--r-lg);
		padding: 14px;
		min-height: 400px;
		border: 1.5px solid transparent;
		transition: border-color 0.12s, background 0.12s;
	}
	.kan-col.over {
		border-color: var(--c-teal);
		background: var(--c-teal-pale);
	}
	.kan-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	.kan-name {
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-ink);
	}
	.kan-count {
		font-size: 11px;
		color: var(--c-muted);
		background: var(--c-white);
		padding: 1px 7px;
		border-radius: 10px;
	}
	.kan-empty {
		font-size: 11.5px;
		color: var(--c-muted);
		text-align: center;
		padding: 18px 0;
		border: 1px dashed var(--c-border-strong);
		border-radius: var(--r);
	}
</style>
