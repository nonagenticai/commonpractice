<script lang="ts">
	// Split markdown editor: source on the left, live preview on the right
	// (mirrors the demo's block-edit Documentation tab, demo.html:3729–3776).
	// Block docs are authored by one user and rendered read-only to others
	// (published/global blocks are visible across tenants), so the markdown is
	// rendered through renderMarkdown(), which DOMPurify-sanitizes the marked()
	// output to prevent stored XSS.
	import { renderMarkdown } from '$lib/utils/markdown';
	import * as m from '$lib/paraglide/messages';

	let {
		value = $bindable(''),
		readonly = false
	}: { value?: string; readonly?: boolean } = $props();

	const html = $derived(renderMarkdown(value));
</script>

<div class="md-split">
	<div class="md-pane">
		<div class="md-pane-label">{m.md_markdown_label()}</div>
		{#if readonly}
			<pre class="md-source readonly">{value}</pre>
		{:else}
			<textarea class="md-source" bind:value spellcheck="false"></textarea>
		{/if}
	</div>
	<div class="md-pane">
		<div class="md-pane-label">{m.md_preview_label()}</div>
		<div class="md-preview prose">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html html}
		</div>
	</div>
</div>

<style>
	.md-split {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 14px;
	}
	.md-pane {
		display: flex;
		flex-direction: column;
		min-height: 320px;
	}
	.md-pane-label {
		font-size: 10.5px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-faint);
		margin-bottom: 8px;
	}
	.md-source {
		flex: 1;
		font-family: var(--font-mono);
		font-size: 12.5px;
		line-height: 1.7;
		color: var(--c-ink);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 14px 16px;
		resize: vertical;
		min-height: 280px;
		white-space: pre-wrap;
	}
	.md-source.readonly {
		margin: 0;
		overflow: auto;
	}
	.md-preview {
		flex: 1;
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 14px 18px;
		background: var(--c-white);
		overflow: auto;
		font-size: 13.5px;
		line-height: 1.6;
		color: var(--c-ink);
	}
	.prose :global(h1) {
		font-family: var(--font-display);
		font-size: 20px;
		margin: 0 0 10px;
		color: var(--c-midnight);
	}
	.prose :global(h2) {
		font-size: 15px;
		margin: 16px 0 6px;
		color: var(--c-midnight);
	}
	.prose :global(p) {
		margin: 0 0 10px;
	}
	.prose :global(code) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--c-surface-2);
		padding: 1px 5px;
		border-radius: var(--r-sm);
	}
	.prose :global(strong) {
		color: var(--c-midnight);
	}
	.prose :global(ul) {
		margin: 0 0 10px;
		padding-inline-start: 18px;
	}
</style>
