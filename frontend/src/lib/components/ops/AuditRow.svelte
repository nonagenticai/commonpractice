<script lang="ts">
	// One audit-feed row (demo audit table). Time · actor · event badge (by category)
	// · target · result dot-status · (details). Append-only — display only.
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { timeAgo } from '$lib/utils/format';
	// The tone map lives with the category list in $lib/types/audit so the chip row and the badge
	// cannot drift: this file used to carry its own copy, which is how `data` and `tenant` — two
	// of the three busiest writers — ended up rendering as the unrecognised-category fallback.
	import { AUDIT_BADGE, type AuditItem } from '$lib/types/audit';
	// ⛔ THE ACTOR CELL IS THE ONE STRING ON THIS ROW THE SERVER USED TO WRITE FOR THE READER.
	// `item.actor` is `null` when no human wrote the row (backend/src/routes/audit.ts), and the
	// backend used to fill that hole with the English literal 'System'. The words for "no human"
	// belong here, where the reader's locale is known.
	//
	// ⚠️ TWO CELLS ARE STILL ENGLISH AND ARE DELIBERATELY LEFT ALONE — `item.action` (a raw backend
	// enum) and `item.targetId` (a UUID). That is a separate, deliberately deferred piece of work.
	//
	// ⛔ `item.result` HAS LEFT THAT LIST, BUT ONLY FOR THE ROWS THAT CARRY A CODE. It used to be
	// rendered raw and wholly deferred to the server, and that is the defect this file now fixes:
	// /build renders a flow checkpoint through `flowSummaryLabel` and read "Handmatig checkpoint"
	// to a Dutch reader while THIS row, written by the same handler in the same transaction, read
	// "Manual checkpoint". One event, two screens, two languages — on the compliance surface.
	//
	// The SAME function `FlowHistoryPanel.svelte` calls is reused here rather than a second
	// renderer, so the two surfaces cannot drift apart again, and it is called with the SAME
	// three-tier fallback it already documents: unknown code, missing params, or no code at all →
	// `item.result` verbatim. That fallback is not scaffolding here either — `audit_log` is
	// append-only with no backfill, so the ~90 other English backend sentences and every row
	// written before this change render EXACTLY as they do today, forever.
	import * as m from '$lib/paraglide/messages';
	// ⛔ THROUGH `auditResultLabel`, NOT `flowSummaryLabel` DIRECTLY, AND THAT INDIRECTION IS THE
	// POINT. `routes/audit/+page.svelte`'s `sortVal()` orders this column and has to compute the
	// SAME string this cell renders; when the row localized and the sort did not, the table filed
	// "Handmatig checkpoint" under M. One adapter, two call sites, nothing to keep in step by hand.
	import { auditResultLabel } from '$lib/i18n/audit-result-label';
	// The locale store, read the same way `FlowHistoryPanel.svelte` reads it: the label takes an
	// explicit locale because one of the nine sentences carries a date, and `fullDate` cannot read
	// the store from a module.
	import { locale } from '$lib/stores/locale.svelte';

	let { item }: { item: AuditItem } = $props();

	// `$derived` so a language switch re-renders the cell, exactly like every `m.*()` call around it.
	// `''` for a row with no result, which is falsy — so the `{#if}` below still falls through to the
	// em-dash placeholder exactly as it did when it tested `item.result`.
	const resultLabel = $derived(auditResultLabel(item, locale.current));

	const BADGE: Record<string, string> = AUDIT_BADGE;
	const toneClass = (t: string | null) => (t === 'error' ? 'error' : t === 'warn' ? 'idle' : 'running');
</script>

<tr>
	<td class="tnum">{timeAgo(item.createdAt)}</td>
	<td>
		<div class="actor">
			<Avatar initials={item.actor?.initials ?? 'SYS'} size={22} />
			<span>{item.actor ? item.actor.name : m.audit_actor_system()}</span>
		</div>
	</td>
	<td><span class="badge {BADGE[item.category] ?? 'outline'}">{item.action}</span></td>
	<td class="target">{item.targetId ?? '—'}</td>
	<td>
		{#if resultLabel}
			<span class="dot-status {toneClass(item.resultTone)}"><span class="d"></span>{resultLabel}</span>
		{:else}
			<span class="muted">—</span>
		{/if}
	</td>
</tr>

<style>
	td {
		padding: 11px 12px;
		border-bottom: 1px solid var(--c-border);
		font-size: 13px;
		color: var(--c-ink);
		vertical-align: middle;
	}
	.tnum {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--c-muted);
		white-space: nowrap;
	}
	.actor {
		display: flex;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}
	.target {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--c-ink);
	}
	.muted {
		color: var(--c-muted);
	}
	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 500;
		font-family: var(--font-mono);
		white-space: nowrap;
	}
	.badge.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.badge.coral {
		background: var(--c-coral-light);
		color: var(--c-coral-dark);
	}
	.badge.amber {
		background: var(--c-amber-light);
		color: #92400e;
	}
	.badge.violet {
		background: var(--c-violet-light);
		color: #5b21b6;
	}
	.badge.emerald {
		background: var(--c-emerald-light);
		color: #065f46;
	}
	/* `tenant` is workspace lifecycle, not a failure — deliberately NOT rose, which reads as an
	   error next to the result dot in the same row. A filled slate keeps it distinct from
	   `outline` (white + border), which stays the fallback for an unrecognised category. */
	.badge.slate {
		background: var(--c-surface-2);
		color: var(--c-ink);
	}
	.badge.outline {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		color: var(--c-muted);
	}
	.dot-status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--c-ink);
	}
	.dot-status .d {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--c-muted);
	}
	.dot-status.running .d {
		background: var(--c-emerald);
	}
	.dot-status.idle .d {
		background: var(--c-amber);
	}
	.dot-status.error .d {
		background: var(--c-rose);
	}
</style>
