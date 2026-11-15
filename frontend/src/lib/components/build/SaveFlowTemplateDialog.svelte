<!--
  SaveFlowTemplateDialog — "Save as template" from /build's ⋯ menu (developer / admin only; the page
  decides who sees the entry). Saves the CURRENT, already-autosaved flow as an organisation template
  (`POST /api/flow-templates`). The page flushes the autosave before opening this, so the template is
  the graph on screen.
-->
<script lang="ts">
	import { flowTemplatesApi } from '$lib/api/flow-templates';
	import { writeErrorText } from '$lib/api/error-message';
	import * as m from '$lib/paraglide/messages';

	let {
		open,
		flowId,
		defaultName,
		onClose
	}: { open: boolean; flowId: string | null; defaultName: string; onClose: () => void } = $props();

	let name = $state('');
	let description = $state('');
	let saving = $state(false);
	let saved = $state(false);
	let error = $state<string | null>(null);
	let nameInput = $state<HTMLInputElement | null>(null);
	let modalEl = $state<HTMLDivElement | null>(null);
	let prevFocus: HTMLElement | null = null;

	$effect(() => {
		if (open) {
			prevFocus = document.activeElement as HTMLElement | null;
			name = defaultName;
			description = '';
			saved = false;
			error = null;
			queueMicrotask(() => nameInput?.focus());
		} else if (prevFocus) {
			prevFocus.focus();
			prevFocus = null;
		}
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!flowId || saving || !name.trim()) return;
		saving = true;
		error = null;
		try {
			await flowTemplatesApi.create({
				flowId,
				name: name.trim(),
				description: description.trim() || undefined
			});
			saved = true;
		} catch (err) {
			error = writeErrorText(err, m.error_load_failed());
		} finally {
			saving = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key === 'Tab' && modalEl) {
			const f = Array.from(
				modalEl.querySelectorAll<HTMLElement>('input, textarea, button:not([disabled])')
			);
			if (!f.length) return;
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
		class="sft-backdrop"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
	>
		<div
			class="sft-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="sft-title"
			data-testid="save-flow-template"
			bind:this={modalEl}
		>
			<h2 id="sft-title">{m.build_save_template()}</h2>
			{#if saved}
				<p class="sft-done" role="status">{m.build_save_template_done()}</p>
				<div class="sft-actions">
					<button type="button" class="sft-primary" onclick={onClose}>{m.build_tpl_close()}</button>
				</div>
			{:else}
				<form onsubmit={submit}>
					<p class="sft-hint">{m.build_save_template_hint()}</p>
					<label class="sft-field">
						<span>{m.build_save_template_name()}</span>
						<input bind:this={nameInput} bind:value={name} maxlength="140" required />
					</label>
					<label class="sft-field">
						<span>{m.build_save_template_desc()}</span>
						<textarea bind:value={description} maxlength="500" rows="3"></textarea>
					</label>
					{#if error}<div class="sft-error" role="alert">{error}</div>{/if}
					<div class="sft-actions">
						<button type="button" class="sft-ghost" onclick={onClose}>{m.confirm_cancel()}</button>
						<button type="submit" class="sft-primary" disabled={saving || !name.trim() || !flowId}>
							{saving ? m.build_save_template_saving() : m.build_save_template_save()}
						</button>
					</div>
				</form>
			{/if}
		</div>
	</div>
{/if}

<style>
	.sft-backdrop {
		position: fixed;
		inset: 0;
		z-index: 900;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		background: rgba(20, 25, 40, 0.45);
	}
	.sft-modal {
		width: 100%;
		max-width: 440px;
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
		margin: 0 0 6px;
	}
	.sft-hint,
	.sft-done {
		font-size: 13px;
		color: var(--c-muted);
		margin: 0 0 14px;
	}
	.sft-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 12px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.sft-field input,
	.sft-field textarea {
		font: inherit;
		font-weight: 400;
		font-size: 13px;
		padding: 7px 10px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		background: var(--c-white);
		resize: vertical;
	}
	.sft-error {
		font-size: 12.5px;
		padding: 8px 11px;
		border-radius: var(--r-sm);
		background: var(--c-coral-pale);
		color: var(--c-coral-dark);
		border: 1px solid var(--c-coral-light);
		margin-bottom: 10px;
	}
	.sft-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.sft-primary,
	.sft-ghost {
		padding: 8px 16px;
		border-radius: var(--r);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
	}
	.sft-primary {
		background: var(--c-teal);
		color: #fff;
	}
	.sft-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.sft-ghost {
		background: var(--c-white);
		color: var(--c-ink);
		border-color: var(--c-border-strong);
	}
</style>
