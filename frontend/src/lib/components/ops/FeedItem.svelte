<script lang="ts">
	import type { FeedEvent } from '$lib/types/ops';
	import { timeAgo } from '$lib/utils/format';
	import { opsEventLine } from '$lib/i18n/ops-event-label';
	let { item }: { item: FeedEvent } = $props();
	// ⛔ THE MARKUP DIFFERS BY BRANCH, AND THAT IS THE TRADE-OFF, NOT AN OVERSIGHT.
	//
	// Localized branch: the actor's name is INSIDE the catalog sentence, because Arabic and Hebrew
	// put the verb before the subject and run right-to-left — a fixed `<span>{actor}</span> {text}`
	// hands the visual order to the Unicode bidi algorithm instead of to a translator (the rule
	// stated at challenges/challenge-state.ts:161 and utils/format.ts:duration). The price is the
	// bold `.feed-actor` span: one interpolated string cannot carry markup around one of its
	// arguments, and this catalog has no rich-text message format. A sentence a translator can
	// order beats a bold name — in all eight locales, and not only the two RTL ones.
	//
	// Legacy branch: markup BYTE-IDENTICAL to what shipped before — same two nodes, same span,
	// same class. It renders when a mid-roll response carries prose and no machine fields, i.e.
	// exactly the wire shape that markup was written for, so it must not drift from it.
	const line = $derived(opsEventLine(item));
	const TONE: Record<FeedEvent['kind'], string> = {
		block_published: 'violet',
		run_finished: 'teal',
		sandbox_suspended: 'amber'
	};
	const initials = $derived(
		item.actor
			.trim()
			.split(/\s+/)
			.map((p) => p[0] ?? '')
			.slice(0, 2)
			.join('')
			.toUpperCase() || '?'
	);
</script>

<svelte:element this={item.href ? 'a' : 'div'} class="feed-item" class:linked={item.href} href={item.href}>
	<span class="feed-icon {TONE[item.kind]}">{initials}</span>
	<div class="feed-body">{#if line.localized}{line.text}{:else}<span class="feed-actor">{line.actor}</span> {line.text}{/if}</div>
	<span class="feed-time">{timeAgo(item.ts)}</span>
</svelte:element>

<style>
	a.feed-item {
		text-decoration: none;
		color: inherit;
		border-radius: var(--r);
		margin: 0 -10px;
		padding-left: 10px;
		padding-right: 10px;
		transition: background 0.12s ease;
	}
	a.feed-item:hover {
		background: var(--c-surface);
	}
	a.feed-item:hover .feed-actor {
		color: var(--c-teal-dark);
	}
	.feed-item {
		display: grid;
		grid-template-columns: 28px 1fr auto;
		gap: 12px;
		align-items: center;
		padding: 9px 0;
		border-bottom: 1px solid var(--c-border);
	}
	.feed-item:last-child {
		border-bottom: none;
	}
	.feed-icon {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
		font-weight: 700;
	}
	.feed-icon.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.feed-icon.violet {
		background: var(--c-violet-light);
		color: #5b21b6;
	}
	.feed-icon.amber {
		background: var(--c-amber-light);
		color: #92400e;
	}
	.feed-body {
		font-size: 12.5px;
		color: var(--c-muted);
		line-height: 1.4;
	}
	.feed-actor {
		font-weight: 600;
		color: var(--c-ink);
	}
	.feed-time {
		font-size: 11.5px;
		color: var(--c-faint);
		white-space: nowrap;
	}
</style>
