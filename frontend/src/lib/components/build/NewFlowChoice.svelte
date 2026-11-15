<!--
  NewFlowChoice — what "New flow" opens on /build: start blank, or from a template (which opens the
  template gallery). Same modal conventions as FlowTemplateGallery.
-->
<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	let {
		open,
		onBlank,
		onTemplate,
		onClose
	}: { open: boolean; onBlank: () => void; onTemplate: () => void; onClose: () => void } = $props();

	let firstBtn = $state<HTMLButtonElement | null>(null);
	let modalEl = $state<HTMLDivElement | null>(null);
	let prevFocus: HTMLElement | null = null;

	$effect(() => {
		if (open) {
			prevFocus = document.activeElement as HTMLElement | null;
			queueMicrotask(() => firstBtn?.focus());
		} else if (prevFocus) {
			prevFocus.focus();
			prevFocus = null;
		}
	});

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		} else if (e.key === 'Tab' && modalEl) {
			const f = Array.from(modalEl.querySelectorAll<HTMLElement>('button'));
			const first = f[0]!;
			const last = f[f.length - 1]!;
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div
		class="nfc-backdrop"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
	>
		<div class="nfc-modal" role="dialog" aria-modal="true" aria-labelledby="nfc-title" data-testid="new-flow-choice" bind:this={modalEl}>
			<h2 id="nfc-title">{m.build_new_choice_title()}</h2>
			<div class="nfc-options">
				<button type="button" class="nfc-card" bind:this={firstBtn} onclick={onBlank}>
					<span class="nfc-name">{m.build_new_blank()}</span>
					<span class="nfc-sub">{m.build_new_blank_sub()}</span>
				</button>
				<button type="button" class="nfc-card" onclick={onTemplate}>
					<span class="nfc-name">{m.build_new_from_template()}</span>
					<span class="nfc-sub">{m.build_new_from_template_sub()}</span>
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.nfc-backdrop {
		position: fixed;
		inset: 0;
		z-index: 900;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		background: rgba(20, 25, 40, 0.45);
	}
	.nfc-modal {
		width: 100%;
		max-width: 460px;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh-lg);
		padding: 22px;
	}
	h2 {
		font-family: var(--font-display);
		font-size: 18px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 0 0 14px;
	}
	.nfc-options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
		gap: 10px;
	}
	.nfc-card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		text-align: start;
		padding: 14px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		background: var(--c-white);
		cursor: pointer;
	}
	.nfc-card:hover,
	.nfc-card:focus-visible {
		border-color: var(--c-teal-mid);
	}
	.nfc-name {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--c-midnight);
	}
	.nfc-sub {
		font-size: 12px;
		color: var(--c-muted);
	}
</style>
