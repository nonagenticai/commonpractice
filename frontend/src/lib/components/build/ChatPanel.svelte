<script lang="ts">
	// AI assistant panel (demo.html:2672–2720). The chat is LIVE (Retrofit §5A): it
	// streams the agent loop over SSE and the agent drives the canvas through the
	// builder store. The provider resolves per tenant (BYO/env key → real model via
	// the in-cluster inference-router; keyless dev falls back to a deterministic stub).
	// MCP tools, frontend-edit round-trip, metering + transcript are all real. The
	// conversation + orchestration live in the AgentChatStore.
	import type { AgentChatStore } from '$lib/stores/agent-chat.svelte';
	import * as m from '$lib/paraglide/messages';
	import { usdEstimated } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { renderChatMarkdown } from '$lib/utils/markdown';

	let {
		chat,
		readOnly = false,
		showCost = false
	}: {
		chat: AgentChatStore;
		/**
		 * The running LLM spend of this session. A cost figure is an administrator's concern, not a
		 * builder's, so /build passes `canSeeSessionCost(roles)` (tenant_admin and above). Defaults to
		 * HIDDEN: a new mount site that forgets the prop shows no money rather than showing it to all.
		 */
		showCost?: boolean;
		/**
		 * The canvas belongs to another author. The copilot's whole job on this screen is to EDIT the
		 * graph — it drives the same `BuilderStore` mutators the read-only gate closes — so a live
		 * composer here spends a metered turn producing tool-calls that are all silently refused, and
		 * ends with a confident summary of changes that are not on the canvas.
		 *
		 * The transcript above stays readable: a visitor arriving from a shared link may well want to
		 * see how the flow was built. Defaults to `false` for every other mount.
		 */
		readOnly?: boolean;
	} = $props();

	let draft = $state('');
	let msgsEl = $state<HTMLDivElement | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);

	/** Puts the caret in the composer — the empty canvas's "Describe it to the assistant". */
	export function focusInput(): void {
		inputEl?.focus();
	}

	function send() {
		const text = draft.trim();
		if (!text || chat.busy || readOnly) return;
		draft = '';
		void chat.send(text);
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	// Auto-scroll to the newest message as the stream arrives.
	$effect(() => {
		void chat.messages.length;
		if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
	});

	const roleLabel = (kind: string) =>
		kind === 'you' || kind === 'user' ? m.chat_role_you() : m.chat_role_assistant();
</script>

<aside class="chat">
	<div class="chat-head">
		<span class="pulse" class:live={chat.busy}></span>
		<span class="who">{m.chat_header()}</span>
		<!-- The catalog string names what this measures (LLM spend). 4 decimals stay: a single chat
		     turn on a cheap model rounds to $0.00 at two — the 0edaad5 defect.
		     ⛔ THE `~$` MOVED OUT OF THE CATALOG AND INTO THE FORMATTER, IN ALL EIGHT LOCALES. The
		     pattern used to be "~${cost} LLM this session", so the message carried BOTH the
		     approximation sign and the glyph while `cost` was a bare number. Passing a formatted
		     `usdEstimated(...)` into it would have shipped "~$$0,0041" — a double glyph — to every
		     reader, and nothing in the repo could have seen it: `svelte-check` cannot look inside a
		     message pattern and no test covered this key. The sign is also wrong in three locales
		     when hard-coded (fr writes ≃, de ≈, nl puts it after the symbol); ICU places it now. -->
		<!-- Hidden at 0: platform-paid local inference is charged $0 (#463), and "~$0,0000 AI-gebruik"
		     reads as a meter that is broken, not as "free". -->
		{#if showCost && chat.costUsd > 0}
			<span class="quota">{m.chat_session_cost({ cost: usdEstimated(chat.costUsd, locale.current, 4) })}</span>
		{/if}
	</div>
	<div class="msgs" bind:this={msgsEl}>
		{#each chat.messages as m, i (i)}
			{#if m.kind === 'tool'}
				<div class="activity">↳ {m.text}</div>
			{:else}
				<div class="msg {m.kind}">
					<div class="role">{roleLabel(m.kind)}</div>
					{#if m.kind === 'assistant'}
						<!-- Sanitised Markdown (utils/markdown.ts renderChatMarkdown): raw HTML is shown as text. -->
						<div class="md">{@html renderChatMarkdown(m.text)}</div>
					{:else}
						<p>{m.text}</p>
					{/if}
				</div>
			{/if}
		{/each}
		{#if chat.busy}
			<div class="activity thinking">
				<span>{m.chat_working()}</span>
				<button type="button" class="stop" onclick={() => chat.stop()} aria-label={m.chat_stop()}>
					{m.chat_stop()}
				</button>
			</div>
		{/if}
	</div>
	<div class="compose">
		<input
			bind:this={inputEl}
			bind:value={draft}
			onkeydown={onKey}
			disabled={chat.busy || readOnly}
			placeholder={m.chat_input_placeholder()}
			aria-label={m.chat_input_aria()}
		/>
		<button
			class="send"
			onclick={send}
			disabled={chat.busy || readOnly}
			aria-label={m.chat_send_aria()}>↑</button
		>
	</div>
</aside>

<style>
	.chat {
		background: var(--c-white);
		border-inline-start: 1px solid var(--c-border);
		display: flex;
		flex-direction: column;
		/* Fill the grid cell so the .msgs flex child scrolls internally instead of the
		   whole conversation overflowing the viewport (matches FlowCanvas/NodeConfigPanel). */
		height: 100%;
		min-height: 0;
	}
	.chat-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 13px 16px;
		border-bottom: 1px solid var(--c-border);
		font-size: 12.5px;
		font-weight: 500;
		color: var(--c-ink);
	}
	.pulse {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: linear-gradient(135deg, var(--c-teal-mid), var(--c-coral-mid));
		flex-shrink: 0;
	}
	.pulse.live {
		animation: pulse 1s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	.quota {
		margin-inline-start: auto;
		font-size: 10.5px;
		color: var(--c-faint);
	}
	.msgs {
		flex: 1;
		overflow-y: auto;
		padding: 14px 16px;
		min-height: 0;
	}
	.msg {
		margin-bottom: 14px;
		font-size: 12.5px;
		line-height: 1.5;
	}
	.msg .role {
		font-size: 10.5px;
		text-transform: uppercase;
		font-weight: 600;
		letter-spacing: 0.06em;
		margin-bottom: 3px;
	}
	.msg.assistant .role {
		color: var(--c-teal-dark);
	}
	.msg.user .role {
		color: var(--c-coral-dark);
	}
	.msg.error .role {
		color: var(--c-coral-dark);
	}
	.msg.error p {
		color: var(--c-coral-dark);
	}
	.msg p {
		margin: 0;
		color: var(--c-ink);
	}
	.md {
		color: var(--c-ink);
		overflow-wrap: anywhere;
	}
	.md :global(p),
	.md :global(ul),
	.md :global(ol) {
		margin: 0 0 6px;
	}
	.md :global(ul),
	.md :global(ol) {
		padding-left: 18px;
	}
	.md :global(:last-child) {
		margin-bottom: 0;
	}
	.md :global(code) {
		font-family: var(--f-mono, ui-monospace, monospace);
		font-size: 0.92em;
	}
	.md :global(pre) {
		white-space: pre-wrap;
		margin: 0 0 6px;
	}
	.activity {
		font-size: 11.5px;
		color: var(--c-faint);
		margin-bottom: 10px;
		font-style: italic;
	}
	.activity.thinking {
		color: var(--c-teal-dark);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.stop {
		flex-shrink: 0;
		font-style: normal;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--c-coral-dark);
		background: var(--c-white);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r-sm);
		padding: 3px 8px;
	}
	.stop:hover {
		background: var(--c-surface);
	}
	.compose {
		border-top: 1px solid var(--c-border);
		padding: 10px 12px;
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.compose input {
		flex: 1;
		font-size: 12.5px;
		padding: 8px 11px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-surface);
	}
	.compose input:disabled {
		opacity: 0.6;
	}
	.send {
		width: 32px;
		height: 32px;
		border-radius: var(--r);
		background: var(--c-midnight);
		color: #fff;
		font-size: 14px;
		flex-shrink: 0;
	}
	.send:disabled {
		opacity: 0.5;
	}
</style>
