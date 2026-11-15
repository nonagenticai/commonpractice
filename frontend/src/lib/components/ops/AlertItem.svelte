<script lang="ts">
	import type { AttentionItem } from '$lib/types/ops';
	import { opsAlertTitle, opsAlertDetail } from '$lib/i18n/ops-alert-label';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect. Read
	// HERE, in the template's reactive graph, so the latency figures re-punctuate on a locale switch
	// exactly like the words around them.
	import { locale } from '$lib/stores/locale.svelte';
	let { item }: { item: AttentionItem } = $props();
	// tone per alert kind → icon colour.
	const TONE: Record<AttentionItem['kind'], string> = {
		sandbox_error: 'rose',
		high_latency: 'amber',
		block_errors: 'rose'
	};
	// ⚠️ `TONE[item.kind]` is an INDEX INTO A RECORD, and an unrecognised kind from a
	// backend-first deploy yields `undefined` → `class="alert-icon undefined"`, which is an
	// unstyled icon, not a throw. Left as-is deliberately: the label functions already keep the
	// WORDS readable on that wire shape, and adding a fallback tone here would be inventing a
	// severity the backend did not state.
	//
	// ⛔ These read through `$lib/i18n/ops-alert-label`, NOT `item.title` / `item.detail`. Those
	// two fields are still on the wire and are still the mid-roll fallback — the label functions
	// return them when the machine fields are absent. Do not "simplify" this back to the fields.
	const title = $derived(opsAlertTitle(item));
	const detail = $derived(opsAlertDetail(item, locale.current));
</script>

<svelte:element this={item.href ? 'a' : 'div'} class="alert" class:linked={item.href} href={item.href}>
	<span class="alert-icon {TONE[item.kind]}">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
			<path d="M12 9v4" /><path d="M12 17h.01" />
			<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
		</svg>
	</span>
	<div class="alert-body">
		<div class="alert-title">{title}</div>
		<div class="alert-desc">{detail}</div>
	</div>
	{#if item.href}<span class="alert-go cp-dir-mirror" aria-hidden="true">→</span>{/if}
</svelte:element>

<style>
	.alert {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 0;
		border-bottom: 1px solid var(--c-border);
	}
	.alert:last-child {
		border-bottom: none;
	}
	.alert-body {
		flex: 1;
		min-width: 0;
	}
	a.alert {
		text-decoration: none;
		color: inherit;
		border-radius: var(--r);
		margin: 0 -10px;
		padding: 12px 10px;
		transition: background 0.12s ease;
	}
	a.alert:hover {
		background: var(--c-surface);
	}
	.alert-go {
		flex-shrink: 0;
		font-size: 13px;
		color: var(--c-muted);
		opacity: 0;
		transition: opacity 0.12s ease;
	}
	a.alert:hover .alert-go {
		opacity: 1;
	}
	.alert-icon {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.alert-icon.rose {
		background: var(--c-rose-light, #fee2e2);
		color: var(--c-rose);
	}
	.alert-icon.amber {
		background: var(--c-amber-light);
		color: #92400e;
	}
	.alert-title {
		font-weight: 600;
		font-size: 13px;
		color: var(--c-ink);
		margin-bottom: 2px;
	}
	.alert-desc {
		font-size: 12px;
		color: var(--c-muted);
		line-height: 1.4;
	}
</style>
