<script lang="ts">
	// Topbar notification bell + dropdown panel. Backed by stores/notifications.svelte.ts
	// (polled unread count; the list is fetched only when the panel opens).
	//
	// The first consumer is the tenant welcome-budget alerts (75 / 90 / 100 %), which is why an
	// item can carry an `href` — clicking a budget alert should land the tenant-admin straight on
	// the screen where they can act on it.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { notifications } from '$lib/stores/notifications.svelte';
	import { notificationTitle, notificationBody } from '$lib/i18n/notification-label';
	// The rune lives here, in a component, and is passed DOWN — see notification-label.ts's header.
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';

	onMount(() => {
		notifications.start();
		// A keyboard user had no way to dismiss the panel — there was no Escape handler anywhere.
		window.addEventListener('keydown', onPanelKey);
		return () => {
			notifications.stop();
			window.removeEventListener('keydown', onPanelKey);
		};
	});

	function relative(iso: string): string {
		const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
		if (mins < 1) return m.notifications_just_now();
		if (mins < 60) return m.notifications_minutes_ago({ n: mins });
		const hours = Math.round(mins / 60);
		if (hours < 24) return m.notifications_hours_ago({ n: hours });
		return m.notifications_days_ago({ n: Math.round(hours / 24) });
	}

	function activate(id: string, href: string | null) {
		// Mark-read is optimistic in the store, so do NOT await it before navigating — awaiting a
		// round trip made clicking an alert stall with no feedback.
		void notifications.markRead(id);
		if (href) {
			notifications.open = false;
			void goto(href);
		}
	}

	function onPanelKey(e: KeyboardEvent) {
		if (e.key === 'Escape') notifications.open = false;
	}
</script>

<div class="bell-wrap">
	<button
		class="icon-btn"
		onclick={() => notifications.toggle()}
		aria-expanded={notifications.open}
		aria-label={m.notifications_title()}
		title={m.notifications_title()}
	>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
			<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
			<path d="M13.7 21a2 2 0 01-3.4 0" />
		</svg>
		{#if notifications.unread > 0}
			<span class="badge">{notifications.unread > 9 ? '9+' : notifications.unread}</span>
		{/if}
	</button>

	{#if notifications.open}
		<button
			class="backdrop"
			aria-label={m.common_dismiss()}
			onclick={() => (notifications.open = false)}
		></button>
		<div class="panel" role="dialog" aria-label={m.notifications_title()}>
			<div class="panel-head">
				<span class="panel-title">{m.notifications_title()}</span>
				{#if notifications.unread > 0}
					<button class="link" onclick={() => notifications.markAllRead()}>
						{m.notifications_mark_all_read()}
					</button>
				{/if}
			</div>
			<!--
				⛔ FOUR BRANCHES, AND THE ORDER IS THE FIX. There used to be three — loading, empty,
				list — so a load that FAILED on a first open left `items` at its initial `[]`, fell
				into the empty branch and told the reader "Nothing to catch up on." as a statement of
				fact. `refreshCount` has its own catch that (correctly) keeps the last known count, so
				the badge above still read "3": a "3" over "Geen meldingen".

				`error` is checked BEFORE `length === 0`, and only that ordering fixes it. The
				`items.length === 0` clause on the error branch is what keeps the original behaviour
				intact for a REPEAT open: if there is a previously-shown list, it is still shown, with
				the stale note below it — the list is not thrown away to report a failed refresh.
			-->
			{#if notifications.loading}
				<div class="msg">{m.notifications_loading()}</div>
			{:else if notifications.error && notifications.items.length === 0}
				<div class="msg failed" role="alert">{m.notifications_load_failed()}</div>
			{:else if notifications.items.length === 0}
				<div class="msg">{m.notifications_empty()}</div>
			{:else}
				{#if notifications.error}
					<!-- The other half of the same honesty: these rows are real, and they are OLD. -->
					<div class="msg stale" role="status">{m.notifications_stale()}</div>
				{/if}
				<ul class="list">
					{#each notifications.items as n (n.id)}
						<!-- `{@const}` must be the immediate child of the block, not of the <span> that
							 uses it — hence its distance from the two lines below. -->
						{@const title = notificationTitle(n)}
						{@const text = notificationBody(n, locale.current)}
						<li>
							<button class="item" class:unread={!n.read} onclick={() => activate(n.id, n.href)}>
								<span class="dot {n.severity}" aria-hidden="true"></span>
								<span class="body">
									<!-- ⛔ NOT `{n.title}` / `{n.body}`. Those are the backend's ENGLISH, composed
										 by budget-service.ts with no reader to negotiate for; the label module
										 rebuilds the sentence from `kind` + `data` in the reader's language and
										 returns that English only when it cannot. -->
									<span class="title">{title}</span>
									{#if text}<span class="text">{text}</span>{/if}
									<span class="when">{relative(n.createdAt)}</span>
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.bell-wrap { position: relative; display: inline-flex; }
	.icon-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: var(--r);
		border: 1px solid transparent;
		background: transparent;
		color: var(--c-muted);
		cursor: pointer;
	}
	.icon-btn:hover { background: var(--c-surface); color: var(--c-ink); }
	.badge {
		position: absolute;
		top: 2px;
		/* Logical: physical `right` put the unread badge on the bell's left
		   corner in RTL (ar/he) on every authenticated page. */
		inset-inline-end: 2px;
		min-width: 15px;
		height: 15px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--c-coral-dark);
		color: #fff;
		font-size: 9.5px;
		font-weight: 700;
		line-height: 15px;
		text-align: center;
	}
	.backdrop { position: fixed; inset: 0; z-index: 40; background: none; border: none; padding: 0; cursor: default; }
	.panel {
		position: absolute;
		top: calc(100% + 8px);
		/* Logical: in RTL the panel anchored away from the bell and
		   overflowed the viewport. */
		inset-inline-end: 0;
		z-index: 41;
		width: 340px;
		max-height: 420px;
		overflow-y: auto;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: 0 10px 30px rgb(0 0 0 / 12%);
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--c-border);
	}
	.panel-title { font-size: 12.5px; font-weight: 600; color: var(--c-ink); }
	.link { background: none; border: none; padding: 0; font-size: 11.5px; color: var(--c-teal-dark); cursor: pointer; }
	.msg { padding: 22px 14px; text-align: center; font-size: 12.5px; color: var(--c-muted); }
	/* The failed-load message is the only thing in the panel, so it keeps the roomy .msg padding
	   and only changes colour — a reader must not mistake it for a notification. */
	.msg.failed { color: var(--c-coral-dark); }
	/* The stale note sits ABOVE a real list, so it is a thin strip, not a 22px block: the rows are
	   the content and this is a caveat on them. */
	.msg.stale {
		padding: 7px 14px;
		text-align: start;
		font-size: 11.5px;
		border-bottom: 1px solid var(--c-border);
	}
	.list { list-style: none; margin: 0; padding: 0; }
	.item {
		display: flex;
		gap: 10px;
		width: 100%;
		text-align: start;
		padding: 11px 14px;
		background: none;
		border: none;
		border-bottom: 1px solid var(--c-border);
		cursor: pointer;
	}
	.item:hover { background: var(--c-surface); }
	.item.unread { background: var(--c-teal-pale); }
	.item.unread:hover { background: var(--c-teal-light); }
	.dot { flex: none; width: 7px; height: 7px; border-radius: 999px; margin-top: 5px; background: var(--c-faint); }
	.dot.warn { background: var(--c-amber-dark, #b8860b); }
	.dot.critical { background: var(--c-coral-dark); }
	.body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
	.title { font-size: 12.5px; font-weight: 600; color: var(--c-ink); }
	.text { font-size: 11.5px; color: var(--c-muted); line-height: 1.45; }
	.when { font-size: 10.5px; color: var(--c-faint); }
</style>
