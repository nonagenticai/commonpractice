<script lang="ts">
	// Challenge-detail discussion thread: a list of comments + a live reply box.
	// The parent owns the data + the API call; this renders the thread and reports a
	// new reply via onPost(body), clearing the draft on success.
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { timeAgo } from '$lib/utils/format';
	import type { CommentItem } from '$lib/types/challenges';
	import * as m from '$lib/paraglide/messages';

	let {
		items,
		busy = false,
		onPost
	}: { items: CommentItem[]; busy?: boolean; onPost: (body: string) => Promise<boolean> } = $props();

	let draft = $state('');

	async function submit() {
		const body = draft.trim();
		if (!body || busy) return;
		const ok = await onPost(body);
		if (ok) draft = '';
	}
</script>

<div class="thread">
	{#if items.length === 0}
		<p class="empty">{m.mkt_thread_empty()}</p>
	{:else}
		<ul>
			{#each items as c (c.id)}
				<li>
					<Avatar initials={c.author.initials} size={30} />
					<div class="body">
						<div class="head"><span class="who">{c.author.name}</span><span class="when">{timeAgo(c.createdAt)}</span></div>
						<p>{c.body}</p>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="reply">
		<textarea bind:value={draft} placeholder={m.mkt_thread_placeholder()} rows="2"></textarea>
		<button class="btn-primary" onclick={submit} disabled={busy || !draft.trim()}>
			{busy ? m.mkt_thread_posting() : m.mkt_thread_post()}
		</button>
	</div>
</div>

<style>
	.thread {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	li {
		display: flex;
		gap: 11px;
	}
	.body {
		flex: 1;
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.who {
		font-weight: 600;
		font-size: 13px;
		color: var(--c-ink);
	}
	.when {
		font-size: 11.5px;
		color: var(--c-muted);
	}
	.body p {
		margin: 3px 0 0;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--c-ink);
	}
	.empty {
		color: var(--c-muted);
		font-size: 13px;
		margin: 0;
	}
	.reply {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-top: 1px solid var(--c-border);
		padding-top: 14px;
	}
	textarea {
		font-family: var(--font-sans);
		font-size: 13.5px;
		color: var(--c-ink);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 10px 12px;
		resize: vertical;
		width: 100%;
		box-sizing: border-box;
	}
	.btn-primary {
		align-self: flex-end;
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 8px 16px;
		border-radius: var(--r);
		border: none;
	}
	.btn-primary:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
