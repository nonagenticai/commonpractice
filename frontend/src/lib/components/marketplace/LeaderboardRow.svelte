<script lang="ts">
	// One challenge leaderboard row (challenges + home trending). The left block is a
	// link to the detail page; the vote pill sits outside the link so it isn't nested
	// interactive. Parent owns the vote call (onVote) + busy state.
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { timeAgo } from '$lib/utils/format';
	import RankBadge from './RankBadge.svelte';
	import VoteButton from './VoteButton.svelte';
	import type { ChallengeRow } from '$lib/types/challenges';
	import type { CycleState } from '$lib/types/cycle';
	import * as m from '$lib/paraglide/messages';
	import { workAreaLabel } from '$lib/i18n/work-area-label';
	import {
		challengeState,
		challengeStatusLabel,
		challengeWeekLabel,
		voteBlockedReason
	} from '$lib/challenges/challenge-state';

	let {
		row,
		busy = false,
		cycle = null,
		onVote
	}: {
		row: ChallengeRow;
		busy?: boolean;
		/**
		 * The live weekly cycle, or null when the engine has not opened the current week. The parent
		 * owns the fetch — `/` already has it folded into `/api/home/summary`, `/challenges` reads
		 * `/api/cycle/current` — because a row rendered 20× per page must not fetch anything.
		 */
		cycle?: CycleState | null;
		onVote: (row: ChallengeRow) => void;
	} = $props();

	// The row's whole temporal story in one value. `row.week` has been on the wire since
	// routes/challenges.ts:216 and typed since types/challenges.ts:39, and this component was one of
	// the two places that fetched it and never rendered it.
	const viewState = $derived(challengeState(row, cycle));
	const blockedReason = $derived(voteBlockedReason(viewState));
	const weekLabel = $derived(challengeWeekLabel(viewState));

	// ⛔ ONLY `closed` IS MUTED. `past_cycle` used to be muted alongside it, on the reasoning that a
	// challenge whose week is behind the live cycle "is not live in voting however its `status`
	// column still reads". That reasoning died with the calendar closers: a past week no longer
	// makes a challenge dead, the vote control is live on these rows (`canVote` is `status`-only),
	// and a muted pill beside a working vote button is the colour telling a lie the button
	// contradicts. Colour is a claim like any other string here — so it now tracks the same fact
	// the button does.
	const badgeTone = $derived(
		viewState.kind === 'closed'
			? 'muted'
			: row.status === 'solution_phase'
				? 'amber'
				: 'teal'
	);
</script>

<div class="lb-row">
	<a class="lb-main" href={`/challenges/${row.id}`}>
		<RankBadge rank={row.rank} />
		<div class="lb-body">
			<div class="lb-title">{row.title}</div>
			<div class="lb-meta">
				<span class="badge {badgeTone}">{challengeStatusLabel(viewState)}</span>
				{#if weekLabel}<span class="week">{weekLabel}</span>{/if}
				<!-- The work area as a WORD, not as the backend enum. The domain chip directly above this
				     board already reads "Schadeclaims" (it resolves `domain_claims` from its own DOMAINS
				     table); this line read "Claims" an inch below it. `row.workArea` still travels
				     untouched everywhere it is a value — see the note in $lib/i18n/work-area-label.ts. -->
				<span>{workAreaLabel(row.workArea)}</span>
				<span>·</span>
				<span>{row.submitter.name}</span>
				<span>·</span>
				<span>{timeAgo(row.createdAt)}</span>
				{#if row.solutionsCount > 0}<span>·</span><span>{m.mkt_solutions_count({ count: row.solutionsCount })}</span>{/if}
			</div>
			{#if row.tags.length}
				<div class="lb-tags">
					{#each [...new Set(row.tags)] as t (t)}<span class="tag">{t}</span>{/each}
				</div>
			{/if}
		</div>
	</a>
	<div class="lb-side">
		<Avatar initials={row.submitter.initials} size={28} />
		<VoteButton variant="teal" size="sm" count={row.votesCount} voted={row.hasVoted} {busy} {blockedReason} onToggle={() => onVote(row)} />
	</div>
</div>

<style>
	.lb-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--c-border);
	}
	.lb-row:last-child {
		border-bottom: none;
	}
	.lb-main {
		display: flex;
		align-items: center;
		gap: 14px;
		flex: 1;
		min-width: 0;
		text-decoration: none;
		color: inherit;
	}
	.lb-body {
		min-width: 0;
	}
	.lb-title {
		font-size: 14.5px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.lb-main:hover .lb-title {
		color: var(--c-teal-dark);
	}
	.lb-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		font-size: 12px;
		color: var(--c-muted);
		margin-top: 4px;
	}
	/* The ISO week the challenge belongs to. Mono like the `#code` badge on the detail page: it is
	   an identifier, not prose, and it is the one field that dates the row against the live cycle. */
	.week {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--c-muted);
		background: var(--c-surface);
		border-radius: var(--r-sm);
		padding: 2px 7px;
	}
	.lb-tags {
		display: flex;
		gap: 6px;
		margin-top: 6px;
		flex-wrap: wrap;
	}
	.tag {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--c-muted);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		padding: 2px 7px;
	}
	.lb-side {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
	}
	.badge {
		font-size: 10.5px;
		font-weight: 600;
		padding: 3px 9px;
		border-radius: 999px;
	}
	.badge.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.badge.amber {
		background: var(--c-amber-light);
		color: #92400e;
	}
	.badge.muted {
		background: var(--c-surface);
		color: var(--c-muted);
	}
	@media (max-width: 640px) {
		.lb-side :global(.avatar) {
			display: none;
		}
	}
</style>
