<script lang="ts">
	// The shared list pager. Extracted from the three inline copies (`/challenges`, `/sandboxes`,
	// `/datasets`) that had drifted into three near-identical blocks of markup + CSS + a four-key
	// catalog family each.
	//
	// ⛔ IT RENDERS NOTHING WHEN THERE IS ONLY ONE PAGE. That is the `/challenges` behaviour, kept
	// deliberately: a "Page 1 / 1" strip with two dead buttons under a five-row list is noise, and a
	// visible-but-inert control is exactly the affordance lie this component exists to stop.
	//
	// ⚠️ THE THREE EXISTING INLINE PAGERS ARE NOT MIGRATED YET, on purpose. Their copy genuinely
	// differs (`sandboxes_pager_showing` says "sandbox(es)"), so migrating means deleting 12 keys
	// across 8 catalogs and editing three pages that have nothing wrong with them — inside a PR whose
	// subject is that `/solutions` truncates at ten rows. One canonical implementation plus three
	// legacy copies still beats five copies. Migration is queued as follow-up work.
	import * as m from '$lib/paraglide/messages';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	let {
		page,
		totalPages,
		shown,
		total,
		onPage
	}: {
		/** 1-based current page. */
		page: number;
		totalPages: number;
		/** Rows actually rendered on this page. */
		shown: number;
		/** Rows matching the query across every page. */
		total: number;
		onPage: (page: number) => void;
	} = $props();
</script>

{#if totalPages > 1}
	<div class="pager">
		<span>{m.pager_showing({ shown: num(shown, locale.current), total: num(total, locale.current) })}</span>
		<div class="pager-btns">
			<button class="btn-sm" disabled={page <= 1} onclick={() => onPage(page - 1)}
				>{m.pager_prev()}</button
			>
			<span>{m.pager_page({ page, totalPages })}</span>
			<button class="btn-sm" disabled={page >= totalPages} onclick={() => onPage(page + 1)}
				>{m.pager_next()}</button
			>
		</div>
	</div>
{/if}

<style>
	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 14px;
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.pager-btns {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.btn-sm {
		font-size: 12px;
		font-weight: 500;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 5px 11px;
		border-radius: var(--r);
	}
	.btn-sm:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
</style>
