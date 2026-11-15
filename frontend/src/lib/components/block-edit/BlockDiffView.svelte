<script lang="ts">
	// Phase 4 — reviewable unified diff of the current block source vs the AI's proposed fix.
	// Dependency-free (lib/blocks/line-diff). The developer reads the change, then Applies it
	// (writes the proposed source into the editor buffer) or Dismisses it.
	import { diffLines, diffStat } from '$lib/blocks/line-diff';
	import * as m from '$lib/paraglide/messages';

	let {
		current,
		proposed,
		summary = null,
		rationale = null,
		applying = false,
		onApply,
		onDismiss
	}: {
		current: string;
		proposed: string;
		summary?: string | null;
		rationale?: string | null;
		applying?: boolean;
		onApply: () => void;
		onDismiss: () => void;
	} = $props();

	const rows = $derived(diffLines(current, proposed));
	const stat = $derived(diffStat(rows));
	const unchanged = $derived(rows.every((r) => r.type === 'context'));
</script>

<div class="patch">
	<div class="patch-head">
		<span class="patch-title">{m.blockfix_patch_title()}</span>
		<span class="stat" dir="ltr"><span class="add">+{stat.added}</span> <span class="del">−{stat.removed}</span></span>
	</div>
	{#if summary}<div class="summary">{summary}</div>{/if}
	{#if rationale}<div class="rationale">{rationale}</div>{/if}

	{#if unchanged}
		<div class="muted small">{m.blockfix_patch_nochange()}</div>
	{:else}
		<pre class="diff" dir="ltr"><code>{#each rows as r, i (i)}<span class="row {r.type}">{r.type === 'add' ? '+' : r.type === 'remove' ? '-' : ' '} {r.text}
</span>{/each}</code></pre>
	{/if}

	<div class="actions">
		<button class="btn-primary sm" disabled={applying || unchanged} onclick={onApply}>
			{applying ? m.blockfix_applying() : m.blockfix_apply()}
		</button>
		<button class="lnk" disabled={applying} onclick={onDismiss}>{m.blockfix_dismiss()}</button>
	</div>
</div>

<style>
	.patch { border: 1px solid var(--c-border); border-radius: var(--r); background: var(--c-white); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
	.patch-head { display: flex; align-items: center; justify-content: space-between; }
	.patch-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-faint); }
	.stat { font-family: var(--font-mono); font-size: 11.5px; }
	.stat .add { color: var(--c-teal-dark); font-weight: 600; }
	.stat .del { color: var(--c-coral-dark); font-weight: 600; }
	.summary { font-size: 12.5px; font-weight: 500; color: var(--c-ink); }
	.rationale { font-size: 12px; color: var(--c-muted); line-height: 1.45; }
	.diff { margin: 0; max-height: 320px; overflow: auto; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-sm); padding: 6px 0; font-family: var(--font-mono); font-size: 12px; line-height: 1.5; }
	.diff code { display: block; }
	.row { display: block; padding: 0 10px; white-space: pre-wrap; word-break: break-word; }
	.row.add { background: color-mix(in srgb, var(--c-teal-light) 35%, transparent); color: var(--c-teal-dark); }
	.row.remove { background: color-mix(in srgb, var(--c-coral-light) 35%, transparent); color: var(--c-coral-dark); }
	.actions { display: flex; align-items: center; gap: 12px; margin-top: 2px; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 7px 14px; border-radius: var(--r); }
	.btn-primary.sm { padding: 6px 12px; font-size: 12.5px; }
	.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
	.lnk { font-size: 12.5px; color: var(--c-teal-dark); font-weight: 500; }
	.lnk:disabled { opacity: 0.5; cursor: not-allowed; }
	.muted { color: var(--c-muted); }
	.small { font-size: 12px; }
</style>
