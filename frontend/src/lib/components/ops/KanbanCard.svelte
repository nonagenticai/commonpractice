<script lang="ts">
	// A production-pipeline card (demo .kan-card). Draggable between columns (vanilla
	// HTML5 DnD — the BlockPalette precedent, no library). The card carries its id +
	// current stage in the drag payload so the target column can move it.
	//
	// THE REVIEW CONTROL (reworked with migration 0062). It used to render ONLY while
	// `!card.reviewed`, which is why the old behaviour was possible at all: the moment ONE admin
	// clicked Approve the button vanished, so a SECOND admin had no way to add their review and
	// nobody had any way to un-approve. The count that satisfied the gate was therefore never going
	// to come from people — it came from the literal `reviewerCount: 2` the page sent.
	//
	// It is now an ALWAYS-RENDERED control: how many of the required reviewers have approved, who
	// they were, and ONE button that adds or withdraws the CURRENT admin's own review. Disabled
	// with an explanatory title on your own card.
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import type { PipelineCard, PipelinePolicy } from '$lib/types/pipeline';
	import * as m from '$lib/paraglide/messages';
	import { periodKeyName } from '$lib/challenges/challenge-state';

	let {
		card,
		busy = false,
		policy,
		onToggleReview,
		onRollback
	}: {
		card: PipelineCard;
		busy?: boolean;
		/** Absent when the backend has not rolled yet — the card falls back to the old copy. */
		policy?: PipelinePolicy;
		onToggleReview?: (card: PipelineCard) => void;
		onRollback?: (card: PipelineCard) => void;
	} = $props();

	// ⚠️ Every one of these reads a field an OLD backend does not send. A new frontend talks to an
	// old backend for the length of every roll, so each needs its `??` fallback — an unguarded
	// `card.reviewers.length` throws and blanks the entire board.
	const reviewers = $derived(card.reviewers ?? []);
	const reviewCount = $derived(card.reviewers ? card.reviewers.length : card.reviewerCount);
	const myReview = $derived(card.myReview ?? false);
	const isAuthor = $derived(card.isAuthor ?? false);
	const reviewerNames = $derived(reviewers.map((r) => r.name).join(', '));
	// A live card's approvals are the record of why it shipped — the backend refuses to withdraw
	// them (422 `review_locked`), so the toggle is not offered at all.
	const reviewLocked = $derived(card.stage === 'production');
	// Stable per-card id so `aria-describedby` points at THIS card's note, not another's.
	// `$derived`, not a plain const: the component is reused across cards when a column re-renders,
	// and a captured `card.id` would leave the note id pointing at the previous card.
	const selfNoteId = $derived(`review-self-${card.id}`);

	function onDragStart(e: DragEvent) {
		e.dataTransfer?.setData('application/cp-pipeline', `${card.id}|${card.stage}`);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
</script>

<div
	class="kan-card"
	class:featured={card.featured}
	class:dim={busy}
	draggable="true"
	ondragstart={onDragStart}
	role="listitem"
>
	{#if card.featured && card.challengeCode}
		{#if card.challengeId}
			<a class="badge coral badge-link" href={`/challenges/${card.challengeId}`} draggable="false">★ #{card.challengeCode}</a>
		{:else}
			<span class="badge coral">★ #{card.challengeCode}</span>
		{/if}
	{/if}
	{#if card.solutionId}
		<a class="kan-card-title title-link" href={`/solutions/${card.solutionId}`} draggable="false">{card.title}</a>
	{:else}
		<div class="kan-card-title">{card.title}</div>
	{/if}
	<div class="kan-card-meta">
		{#if card.author}<Avatar initials={card.author.initials} size={18} />{/if}
		<span class="who">{card.author?.name ?? m.ops_kancard_unassigned()}{card.week ? m.ops_kancard_won({ week: periodKeyName(card.week) }) : ''}</span>
		{#if card.live}
			<span class="badge teal mlauto">{m.ops_kancard_live()}</span>
		{:else if card.stage === 'hardening' && card.progress?.ofDays}
			<span class="badge amber mlauto">{m.ops_kancard_day_progress({ day: card.progress.day ?? 0, ofDays: card.progress.ofDays ?? 0 })}</span>
		{:else if card.stage === 'staging'}
			<span class="badge teal mlauto">{m.ops_kancard_rollout({ pct: card.rolloutPct })}</span>
		{/if}
	</div>
	<div class="kan-card-foot">
		{#if policy}
			<!-- The real state: N of M distinct reviewers, and who they were. -->
			<span class="review" class:ok={reviewCount >= policy.requiredReviewers} class:pending={reviewCount < policy.requiredReviewers}>
				{policy.mandatoryReview
					? m.ops_kancard_reviewers_progress({ count: reviewCount, required: policy.requiredReviewers })
					: m.ops_kancard_reviewers_count({ count: reviewCount })}
			</span>
			{#if reviewers.length}
				<!-- The names are REAL TEXT in the DOM, not just `title=`: a title on a <span> is not
				     reliably announced by assistive tech and is unreachable by keyboard, so the
				     avatars alone would render the reviewers' identities invisible to AT users. -->
				<span class="reviewer-avatars">
					<span class="sr-only">{m.ops_kancard_reviewers_list({ names: reviewerNames })}</span>
					{#each reviewers as r (r.id)}
						<span title={r.name} aria-hidden="true"><Avatar initials={r.initials} size={18} /></span>
					{/each}
				</span>
			{/if}
			{#if onToggleReview && !reviewLocked}
				<!-- ONE button, both directions.
				     ⛔ NOT RENDERED for a Production card (`reviewLocked`): the reviews behind a live
				     card are the record of why it shipped and the backend refuses to withdraw them
				     (422 `review_locked`), so offering the control would only produce an error. Roll
				     the card back to make them withdrawable again.
				     `isAuthor` disables rather than hides, so the reason is stated rather than the
				     control silently not existing — and the reason is VISIBLE TEXT wired through
				     `aria-describedby`, because `title` on a *disabled* button reaches nobody: it is
				     out of the tab order and titles are not reliably announced. -->
				{#if isAuthor}
					<span class="review-note" id={selfNoteId}>{m.ops_kancard_review_self_note()}</span>
				{/if}
				<button
					class="approve"
					class:withdraw={myReview}
					disabled={busy || isAuthor}
					aria-describedby={isAuthor ? selfNoteId : undefined}
					title={isAuthor ? m.ops_kancard_review_self_title() : undefined}
					onclick={() => onToggleReview?.(card)}
				>
					{myReview ? m.ops_kancard_review_withdraw() : m.ops_kancard_review_add()}
				</button>
			{/if}
		{:else if card.reviewed}
			<!-- Fallback: the backend has not rolled yet and sent no `policy`. Today's copy. -->
			<span class="review ok">{card.reviewedBy ? m.ops_kancard_approved_by({ name: card.reviewedBy.name }) : m.ops_kancard_reviewed({ count: card.reviewerCount })}</span>
		{:else}
			<span class="review pending">{m.ops_kancard_needs_review()}</span>
			{#if onToggleReview}
				<button class="approve" disabled={busy} onclick={() => onToggleReview?.(card)}>{m.ops_kancard_review_add()}</button>
			{/if}
		{/if}
		{#if onRollback && card.stage === 'production'}
			<button class="rollback" disabled={busy} onclick={() => onRollback?.(card)}>{m.pipeline_rollback()}</button>
		{/if}
	</div>
</div>

<style>
	.kan-card {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 12px;
		margin-bottom: 8px;
		cursor: grab;
		box-shadow: var(--sh-sm);
	}
	.kan-card:active {
		cursor: grabbing;
	}
	.kan-card.featured {
		border-color: var(--c-coral);
		border-width: 1.5px;
	}
	.kan-card.dim {
		opacity: 0.5;
	}
	.kan-card-title {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--c-midnight);
		margin: 6px 0;
		line-height: 1.4;
	}
	.title-link {
		display: block;
		text-decoration: none;
	}
	.title-link:hover {
		color: var(--c-coral-dark);
		text-decoration: underline;
	}
	.badge-link {
		text-decoration: none;
		cursor: pointer;
	}
	.badge-link:hover {
		filter: brightness(0.95);
		text-decoration: underline;
	}
	.kan-card-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: var(--c-muted);
	}
	.who {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mlauto {
		margin-inline-start: auto;
	}
	.kan-card-foot {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
	}
	.review {
		font-size: 10.5px;
		font-weight: 600;
	}
	.review.ok {
		color: var(--c-teal-dark);
	}
	.review.pending {
		color: var(--c-amber);
	}
	.reviewer-avatars {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}
	/* Same helper as Topbar.svelte — components are style-scoped, so it is redeclared here. */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	/* The reason the Approve control is refused on your own card. Deliberately VISIBLE — a title on
	   a disabled button is announced to nobody and cannot be focused. */
	.review-note {
		margin-inline-start: auto;
		font-size: 10.5px;
		font-style: italic;
		color: var(--c-muted);
	}
	.review-note + .approve {
		margin-inline-start: 6px;
	}
	.approve {
		margin-inline-start: auto;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--c-teal-dark);
		background: var(--c-teal-light);
		border: none;
		border-radius: 4px;
		padding: 2px 8px;
		cursor: pointer;
	}
	.approve.withdraw {
		color: var(--c-muted);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
	}
	.approve:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.rollback {
		margin-inline-start: auto;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: 4px;
		padding: 2px 8px;
		cursor: pointer;
	}
	.rollback:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 7px;
		border-radius: 4px;
		font-size: 10px;
		font-weight: 500;
	}
	.badge.coral {
		background: var(--c-coral-light);
		color: var(--c-coral-dark);
	}
	.badge.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.badge.amber {
		background: var(--c-amber-light);
		color: #92400e;
	}
</style>
