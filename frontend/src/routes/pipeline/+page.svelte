<script lang="ts">
	// Platform Production pipeline — the kanban (demo.html `pipeline`). Drag a card
	// between stages → PATCH /api/pipeline/:id. Promotion into Production is gated by
	// governance (mandatory review + required reviewers); a blocked move shows the
	// policy reason and reverts the card. Entering Staging seeds the canary percent.
	import { onMount } from 'svelte';
	import { pipelineApi, ApiError } from '$lib/api/pipeline';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import type { PipelineBoard, PipelineCard, Stage } from '$lib/types/pipeline';
	import PipelineStats from '$lib/components/ops/PipelineStats.svelte';
	import KanbanColumn from '$lib/components/ops/KanbanColumn.svelte';
	import * as m from '$lib/paraglide/messages';
	import { stageLabel } from '$lib/i18n/stage-label';
	import { confirmDialog } from '$lib/stores/confirm.svelte';

	let board = $state<PipelineBoard | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let denied = $state(false);
	let busyId = $state<string | null>(null);
	let banner = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	// ──────────────────────────────────────────────────────────────────────────────────────────
	// ⛔ THE DEFECT: A FAILED RE-READ LEFT THE BOARD AFFIRMATIVELY CONTRADICTING ITSELF.
	//
	// `move()`, `toggleReview()` and `rollback()` all `flash('ok', …)` and then `await load()` to
	// pick the server's new truth up. When that re-read failed, `error` was set, `board` stayed
	// non-null — and the ONLY branch that renders `error` is `{:else if error && !board}`, which
	// cannot be reached with a board in hand. So the screen showed a green "'X' moved →
	// Staging" toast over a kanban still drawn from the PRE-action payload, with nothing anywhere
	// saying the two disagreed. An operator's next act is to read the board.
	//
	// ⛔ AND THE FIX IS NOT TO LET THE FAILURE INTO THE BLANKING CHAIN. `{:else if error && !board}`
	// is CORRECT for first paint (nothing has ever loaded, there is no board to keep) and #265 is
	// the PR that stopped eight screens from destroying loaded content to report a failed refresh.
	// A later failure goes HERE, rendered above the board, which stays on screen. Same shape, same
	// reasoning and the same two-state split as routes/audit/+page.svelte.
	//
	// ⛔ INCLUDING A 401/403 — for audit's measured reason. `denied` renders OUTSIDE the chain and
	// replaces the WHOLE page; a session expiring on the `load()` that follows a successful move
	// would take the board, the stats and every card with it, leaving one sentence and no control
	// to retry with. A refusal on a loaded board is still a failed refresh and is reported as one.
	// ──────────────────────────────────────────────────────────────────────────────────────────
	let refreshError = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		denied = false;
		try {
			board = await pipelineApi.board();
			// A recovered board must stop apologising — for either kind of failure, and for a refusal.
			refreshError = null;
		} catch (e) {
			const refused = e instanceof ApiError && (e.status === 401 || e.status === 403);
			if (board) {
				refreshError = m.pipeline_refresh_failed({
					error: refused ? m.pipeline_denied() : errorText(e, m.error_load_failed())
				});
			} else if (refused) {
				// Nothing has ever loaded, so the whole-page sentence IS the whole truth here.
				denied = true;
			} else error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function flash(kind: 'ok' | 'error', text: string) {
		banner = { kind, text };
		setTimeout(() => (banner = null), 4000);
	}

	async function move(cardId: string, _from: Stage, to: Stage) {
		busyId = cardId;
		try {
			const updated = await pipelineApi.move(cardId, { stage: to });
			// `stageLabel(to)`, not the raw `to`: the toast read "…verplaatst → hardening" in a
			// Dutch UI. The MESSAGE and its value are unchanged — only the argument is now words.
			flash('ok', m.pipeline_flash_moved({ title: updated.title, stage: stageLabel(to) }));
			await load();
		} catch (e) {
			if (e instanceof ApiError && e.status === 422) {
				flash('error', m.pipeline_flash_blocked({ message: writeErrorText(e, m.error_action_failed()) }));
			} else {
				flash('error', writeErrorText(e, m.error_action_failed()));
			}
			await load(); // re-sync (the optimistic move never persisted)
		} finally {
			busyId = null;
		}
	}

	// Add or withdraw THE CURRENT ADMIN'S OWN review.
	//
	// ⛔ This used to send `{ reviewed: true, reviewerCount: 2 }` — and that hard-coded `2` was the
	// bug. The backend gated production deploys on it, so one click by one admin satisfied "2
	// reviewers required", and because nothing could ever send a 3, setting the policy to 3 (an
	// option the Governance screen offers) deadlocked promotion permanently. The count is now
	// derived server-side from real per-reviewer rows; the client asserts nothing about it and MUST
	// NOT start again. `pipeline-page.no-reviewer-count.test.ts` guards the literal.
	async function toggleReview(card: PipelineCard) {
		busyId = card.id;
		// The direction is decided ONCE, here, so the confirmation reports the action that was
		// actually taken. Flashing "marked reviewed" in both directions told an admin who had just
		// revoked their approval that they had granted one.
		const adding = !(card.myReview ?? false);
		try {
			await pipelineApi.move(card.id, { reviewed: adding });
			flash(
				'ok',
				adding
					? m.pipeline_flash_reviewed({ title: card.title })
					: m.pipeline_flash_review_withdrawn({ title: card.title })
			);
			await load();
		} catch (e) {
			flash('error', writeErrorText(e, m.error_action_failed()));
		} finally {
			busyId = null;
		}
	}

	async function rollback(card: PipelineCard) {
		if (!(await confirmDialog({ message: m.pipeline_rollback_confirm({ title: card.title }) }))) return;
		busyId = card.id;
		try {
			await pipelineApi.rollback(card.id);
			flash('ok', m.pipeline_flash_rolled_back({ title: card.title }));
			await load();
		} catch (e) {
			flash('error', writeErrorText(e, m.error_action_failed()));
		} finally {
			busyId = null;
		}
	}
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.pipeline_eyebrow()}</div>
			<h1>{m.pipeline_title()}</h1>
			<p>{m.pipeline_subtitle()}</p>
		</div>
	</header>

	<!-- Rendered ABOVE the loading/error/board chain, never inside it: the board it is reporting on
	     must stay readable. See the block comment beside `refreshError`. -->
	{#if refreshError}
		<div class="notice error" role="alert" data-testid="pipeline-refresh-error">{refreshError}</div>
	{/if}

	{#if denied}
		<div class="notice error">{m.pipeline_denied()}</div>
	{:else if loading && !board}
		<div class="notice">{m.pipeline_loading()}</div>
	{:else if error && !board}
		<div class="notice error">{m.pipeline_load_failed({ error })}</div>
	{:else if board}
		<!-- The stat row lives in its own component so it can be render-tested: this page mounts with
		     `onMount(load)` and calls the API immediately, so it cannot be mounted cleanly in jsdom,
		     and the defect it carried ("— / none live yet" beside "in production 1") was a rendering
		     decision. See PipelineStats.svelte for what that decision now is. -->
		<PipelineStats metrics={board.metrics} />

		{#if banner}
			<div class="banner {banner.kind}">{banner.text}</div>
		{/if}

		<div class="kanban">
			{#each board.columns as column (column.stage)}
				<!-- `board.policy` is OPTIONAL: a new frontend talks to a not-yet-rolled old backend for
				     the length of every deploy, and it sends no `policy`. Passed through as-is (never
				     dereferenced here) so the card can fall back to its old copy instead of throwing. -->
				<KanbanColumn {column} {busyId} policy={board.policy} onMove={move} onToggleReview={toggleReview} onRollback={rollback} />
			{/each}
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 1280px;
	}
	.page-head {
		margin-bottom: 20px;
	}
	.eyebrow {
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-teal);
		margin-bottom: 6px;
	}
	h1 {
		font-family: var(--font-display);
		font-size: 30px;
		color: var(--c-midnight);
		margin: 0 0 4px;
	}
	.page-head p {
		color: var(--c-muted);
		font-size: 13.5px;
		margin: 0;
	}
	.banner {
		padding: 10px 16px;
		border-radius: var(--r);
		font-size: 13px;
		margin-bottom: 14px;
		font-weight: 500;
	}
	.banner.ok {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.banner.error {
		background: var(--c-coral-pale);
		color: var(--c-coral-dark);
		border: 1px solid var(--c-coral-light);
	}
	.kanban {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 14px;
	}
	.notice {
		padding: 28px;
		text-align: center;
		color: var(--c-muted);
		font-size: 13.5px;
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
	}
	.notice.error {
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border-color: var(--c-coral-light);
	}
	@media (max-width: 1000px) {
		.kanban {
			grid-template-columns: repeat(2, 1fr);
		}
	}
	/* Phone width (the shell drawer breakpoint, app.css): nothing on this page may push the screen sideways. */
	@media (max-width: 767.98px) {
		.kanban { grid-template-columns: minmax(0, 1fr); }
	}
</style>
