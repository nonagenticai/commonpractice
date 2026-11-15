<!--
  ConfirmDialog — single app-root modal that backs the promise-based
  confirmDialog() store (lib/stores/confirm.svelte.ts). Replaces native
  window.confirm(): accessible (role=alertdialog, focus-trapped, Escape/backdrop
  cancel), styled with the Common Practice design tokens.
-->
<script lang="ts">
	import { confirmState, resolveConfirm } from '$lib/stores/confirm.svelte';
	import * as m from '$lib/paraglide/messages';

	const req = $derived(confirmState.current);

	let modalEl = $state<HTMLDivElement | null>(null);
	let confirmBtn = $state<HTMLButtonElement | null>(null);
	let prevFocus: HTMLElement | null = null;

	// On open, remember the previously-focused element and move focus to the
	// confirm button; on close, restore focus to where it was.
	$effect(() => {
		if (req) {
			prevFocus = document.activeElement as HTMLElement | null;
			queueMicrotask(() => confirmBtn?.focus());
		} else if (prevFocus) {
			prevFocus.focus();
			prevFocus = null;
		}
	});

	function onKeydown(e: KeyboardEvent) {
		if (!req) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			resolveConfirm(false);
			return;
		}
		if (e.key === 'Tab' && modalEl) {
			const focusables = Array.from(modalEl.querySelectorAll<HTMLElement>('button'));
			if (focusables.length === 0) return;
			const first = focusables[0];
			const last = focusables[focusables.length - 1];
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

{#if req}
	<!-- Backdrop click (outside the modal) cancels. -->
	<div
		class="cd-backdrop"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) resolveConfirm(false);
		}}
	>
		<div
			class="cd-modal"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="cd-title"
			aria-describedby="cd-msg"
			bind:this={modalEl}
		>
			<h2 id="cd-title" class="cd-title">{req.title ?? m.confirm_title()}</h2>
			<p id="cd-msg" class="cd-msg">{req.message}</p>
			<div class="cd-actions">
				<button type="button" class="cd-btn cd-btn-ghost" onclick={() => resolveConfirm(false)}>
					{req.cancelLabel ?? m.confirm_cancel()}
				</button>
				<button
					type="button"
					class="cd-btn {req.danger === false ? 'cd-btn-primary' : 'cd-btn-danger'}"
					bind:this={confirmBtn}
					onclick={() => resolveConfirm(true)}
				>
					{req.confirmLabel ?? m.confirm_ok()}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.cd-backdrop {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: rgba(20, 25, 40, 0.45);
	}
	.cd-modal {
		width: 100%;
		max-width: 420px;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh-lg);
		padding: 28px;
	}
	.cd-title {
		font-family: var(--font-display);
		font-size: 18px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 0 0 8px;
	}
	.cd-msg {
		color: var(--c-muted);
		font-size: 14px;
		line-height: 1.55;
		margin: 0 0 22px;
	}
	.cd-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}
	.cd-btn {
		padding: 9px 18px;
		border-radius: var(--r);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.cd-btn-ghost {
		background: var(--c-white);
		color: var(--c-ink);
		border-color: var(--c-border-strong);
	}
	.cd-btn-ghost:hover {
		background: var(--c-surface);
	}
	.cd-btn-primary {
		background: var(--c-teal);
		color: #fff;
	}
	.cd-btn-primary:hover {
		background: var(--c-teal-dark);
	}
	.cd-btn-danger {
		background: var(--c-coral-dark);
		color: #fff;
	}
	.cd-btn-danger:hover {
		filter: brightness(0.94);
	}
</style>
