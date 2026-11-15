<script lang="ts">
	// The upvote toggle (demo .vote-btn). Presentational: the parent owns the count +
	// voted state and the API call; this renders the pill and reports clicks.
	import * as m from '$lib/paraglide/messages';
	import { num } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';

	let {
		count,
		voted,
		variant = 'teal',
		size = 'md',
		busy = false,
		blockedReason = null,
		onToggle
	}: {
		count: number;
		voted: boolean;
		variant?: 'teal' | 'coral';
		size?: 'sm' | 'md';
		busy?: boolean;
		/**
		 * Why this reader cannot vote, or null when they can. ⛔ NOT a plain `disabled` boolean: a
		 * control that goes inert without saying why is the defect this replaces. Both challenge
		 * vote sites rendered a live-looking pill on CLOSED challenges, where
		 * `POST /api/challenges/:id/vote` answers `409 voting_closed` — so the pill invited a click,
		 * bumped the count optimistically, and then snapped back with a red banner. The reason
		 * string comes from `voteBlockedReason()` in $lib/challenges/challenge-state.
		 */
		blockedReason?: string | null;
		onToggle: () => void;
	} = $props();

	const blocked = $derived(blockedReason !== null);
</script>

<!-- The reason lives on a WRAPPER, not on the button: a disabled button fires no pointer events,
     so a `title` on it never surfaces a tooltip. It is a supplement in any case — the same fact is
     always on screen next to it (the "Closed" status badge on a leaderboard row, the vote note
     under the detail-page pill), because a tooltip alone is not reachable by keyboard. -->
<span class="vote-wrap" title={blockedReason ?? undefined}>
	<button
		class="vote {variant} {size}"
		class:voted
		class:blocked
		disabled={busy || blocked}
		onclick={(e) => {
			e.stopPropagation();
			onToggle();
		}}
		aria-pressed={voted}
		aria-disabled={blocked}
	>
		<span class="caret">▲</span>
		<span class="num">{num(count, locale.current)}</span>
		{#if size === 'md'}<span class="label">{voted ? m.mkt_vote_voted() : m.mkt_vote_up()}</span>{/if}
	</button>
</span>

<style>
	.vote-wrap {
		display: inline-flex;
	}
	.vote {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-weight: 600;
		border-radius: 999px;
		border: 1px solid var(--c-border);
		background: var(--c-white);
		color: var(--c-ink);
		cursor: pointer;
		transition: all 0.12s;
		font-variant-numeric: tabular-nums;
	}
	.vote.md {
		padding: 9px 16px;
		font-size: 14px;
	}
	.vote.sm {
		padding: 5px 11px;
		font-size: 12.5px;
	}
	.vote:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.caret {
		font-size: 10px;
		opacity: 0.7;
	}
	.label {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--c-muted);
	}
	/* teal (challenges) */
	.vote.teal:hover:not(:disabled) {
		border-color: var(--c-teal);
		color: var(--c-teal-dark);
	}
	.vote.teal.voted {
		background: var(--c-teal);
		color: #fff;
		border-color: var(--c-teal);
	}
	.vote.teal.voted .label,
	.vote.coral.voted .label {
		color: rgba(255, 255, 255, 0.85);
	}
	.vote.teal.voted .caret {
		opacity: 1;
	}
	/* coral (solutions) */
	.vote.coral:hover:not(:disabled) {
		border-color: var(--c-coral);
		color: var(--c-coral-dark);
	}
	.vote.coral.voted {
		background: var(--c-coral);
		color: #fff;
		border-color: var(--c-coral);
	}
	.vote.coral.voted .caret {
		opacity: 1;
	}
	/* BLOCKED ≠ BUSY. `busy` is transient (a request in flight) and keeps the pill's own colour;
	   `blocked` is the standing state of a closed challenge, so it flattens onto the muted surface
	   instead of reading as a control that is about to come back. Declared last, and repeated for
	   `.voted`, so it outranks the `.vote.teal.voted` / `.vote.coral.voted` fills a reader who has
	   already voted would otherwise keep. */
	.vote.blocked,
	.vote.blocked.voted {
		background: var(--c-surface);
		color: var(--c-muted);
		border-color: var(--c-border);
		opacity: 1;
	}
	.vote.blocked .label,
	.vote.blocked.voted .label {
		color: var(--c-faint);
	}
</style>
