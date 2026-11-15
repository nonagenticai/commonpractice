<script lang="ts">
	// BlockFixAssistant — the "Fix with AI" panel of the block editor (Phase 4: AI-fix loop).
	// Opened from a lint finding, a failed test, or a simulate error. It seeds the fix copilot
	// with the failing context (slug+version, current source + descriptor, the error/diffs/lint),
	// then the agent either PROPOSES a corrected source via propose_block_patch — shown as a
	// reviewable diff the developer Applies — or, with auto-iterate ON, edits the draft and
	// re-tests until green before proposing the final source.
	import { onDestroy } from 'svelte';
	import ChatPanel from '../build/ChatPanel.svelte';
	import BlockDiffView from './BlockDiffView.svelte';
	import { AgentChatStore } from '$lib/stores/agent-chat.svelte';
	import { BlockFixDriver, describeBlockFix, type BlockPatchProposal, type BlockFixContext } from '$lib/agent/block-fix-driver';
	import type { BlockDescriptor } from '$lib/types/blocks';
	import * as m from '$lib/paraglide/messages';

	let {
		slug,
		version,
		sourceTs,
		descriptor,
		context,
		onApply,
		onClose
	}: {
		slug: string;
		version: string;
		sourceTs: string;
		descriptor: BlockDescriptor;
		context: BlockFixContext;
		/** Apply the proposed source into the editor buffer (developer reviewed the diff). */
		onApply: (source: string) => void;
		onClose: () => void;
	} = $props();

	let autoIterate = $state(false);
	let started = $state(false);
	let proposed = $state<BlockPatchProposal | null>(null);
	let appliedSummary = $state<string | null>(null);

	const chat = new AgentChatStore({
		driver: new BlockFixDriver((p) => {
			proposed = p;
		}),
		mode: 'fix',
		intro: () => [{ kind: 'assistant', text: m.blockfix_intro() }],
		describe: (name) => describeBlockFix(name)
	});

	// onClose (below) unmounts this panel via the parent's {#if fixContext && canFix}.
	// Without this, closing "Fix with AI" mid auto-iterate left the SSE fetch running
	// and still metering real LLM spend against the tenant's budget, invisibly.
	onDestroy(() => chat.stop());

	function contextLine(): string {
		const parts: string[] = [];
		// `errorKind` is a BACKEND ERROR CODE (block_test_error / simulate error `kind`) and
		// `errorMessage` is the backend's own already-localized sentence — both are passed through
		// untouched. Only the "(test: …)" wrapper around the test's name is prose, so only it is
		// translated; the name itself is the author's own string.
		if (context.errorKind) parts.push(`[${context.errorKind}]`);
		if (context.errorMessage) parts.push(context.errorMessage);
		if (context.testName) parts.push(m.blockfix_ctx_test({ name: context.testName }));
		return parts.join(' ') || m.blockfix_origin_generic();
	}

	/** The origin enum ('lint' | 'test' | 'simulate') as a word, not as a wire token. */
	function originLabel(): string {
		switch (context.origin) {
			case 'lint':
				return m.blockfix_seed_origin_lint();
			case 'test':
				return m.blockfix_seed_origin_test();
			default:
				return m.blockfix_seed_origin_simulate();
		}
	}

	/**
	 * The first chat message of the fix session.
	 *
	 * ⛔ THIS IS RENDERED, NOT ONLY SENT. `chat.send()` (agent-chat.svelte.ts) pushes it into the
	 * feed as a USER message and `ChatPanel.svelte` prints it verbatim inside fully-Dutch chrome —
	 * so every English word here was English text on a primary Dutch authoring surface. The prose
	 * is now catalogued, exactly as `BlockAuthorAssistant.start()` already does with
	 * `blockauthor_seed_goal` / `_cell` / `_dataset`.
	 *
	 * ⚠️ THE MACHINE-READABLE FRAGMENTS STAY VERBATIM AND UNLOCALIZED, DELIBERATELY. The seed is
	 * also the LLM's brief, and `slug`, the version, the `descriptor` JSON, the raw diff payload,
	 * each lint finding's `rule` + `message`, and `source_ts` (both the field name and the code)
	 * are IDENTIFIERS AND DATA. Translating any of them would hand the model a name that exists
	 * nowhere in the block it is being asked to repair. Only the human sentences AROUND them move
	 * into the catalog.
	 */
	function buildSeed(): string {
		let msg = m.blockfix_seed_intro({ slug, version }) + '\n';
		msg += `${m.blockfix_seed_failure({ origin: originLabel() })} ${contextLine()}\n`;
		if (context.diffs?.length)
			msg += `${m.blockfix_seed_diffs()} ${JSON.stringify(context.diffs)}\n`;
		if (context.lint?.length)
			msg +=
				m.blockfix_seed_lint() +
				' ' +
				context.lint
					.map(
						(f) =>
							`${f.rule}: ${f.message}${f.line ? ` ${m.blockfix_seed_lint_line({ line: f.line })}` : ''}`
					)
					.join('; ') +
				'\n';
		msg += (autoIterate ? m.blockfix_seed_autoiterate_on() : m.blockfix_seed_autoiterate_off()) + '\n';
		// `descriptor:` is the descriptor object's own field name, not a sentence — verbatim.
		msg += `descriptor: ${JSON.stringify(descriptor)}\n`;
		msg += m.blockfix_seed_source() + '\n```ts\n' + sourceTs + '\n```';
		return msg;
	}

	function start() {
		if (chat.busy || started) return;
		started = true;
		void chat.send(buildSeed());
	}

	function apply() {
		if (!proposed) return;
		onApply(proposed.source_ts);
		appliedSummary = proposed.summary ?? m.blockfix_applied_generic();
		proposed = null;
	}
</script>

<div class="fix">
	<div class="fix-head">
		<div class="fh-left">
			<span class="fh-title">{m.blockfix_title()}</span>
			<span class="fh-ctx" dir="ltr">{contextLine()}</span>
		</div>
		<button class="lnk" onclick={onClose}>{m.blockfix_close()}</button>
	</div>

	{#if !started}
		<p class="hint">{m.blockfix_start_hint()}</p>
		<label class="toggle">
			<input type="checkbox" bind:checked={autoIterate} />
			<span>
				<strong>{m.blockfix_autoiterate_label()}</strong>
				<span class="muted small">{m.blockfix_autoiterate_hint()}</span>
			</span>
		</label>
		<button class="btn-primary" onclick={start}>{m.blockfix_start()}</button>
	{:else}
		{#if appliedSummary}
			<div class="applied">{m.blockfix_applied({ summary: appliedSummary })}</div>
		{/if}
		{#if proposed}
			<BlockDiffView
				current={sourceTs}
				proposed={proposed.source_ts}
				summary={proposed.summary ?? null}
				rationale={proposed.rationale ?? null}
				onApply={apply}
				onDismiss={() => (proposed = null)}
			/>
		{/if}
		<div class="fix-chat">
			<ChatPanel {chat} />
		</div>
	{/if}
</div>

<style>
	.fix { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--c-teal-light); border-radius: var(--r-lg); background: var(--c-surface); padding: 12px; }
	.fix-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
	.fh-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.fh-title { font-size: 13px; font-weight: 600; color: var(--c-ink); }
	.fh-ctx { font-size: 11.5px; color: var(--c-coral-dark); font-family: var(--font-mono); word-break: break-word; }
	.hint { margin: 0; font-size: 12.5px; color: var(--c-muted); line-height: 1.5; }
	.toggle { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; cursor: pointer; }
	.toggle input { margin-top: 2px; }
	.toggle strong { display: block; font-weight: 600; color: var(--c-ink); }
	.muted { color: var(--c-muted); }
	.small { font-size: 11.5px; }
	.applied { font-size: 12.5px; color: var(--c-teal-dark); font-weight: 500; background: color-mix(in srgb, var(--c-teal-light) 30%, transparent); border-radius: var(--r-sm); padding: 6px 9px; }
	.btn-primary { align-self: flex-start; background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 7px 14px; border-radius: var(--r); }
	.lnk { font-size: 12.5px; color: var(--c-teal-dark); font-weight: 500; }
	.fix-chat { height: min(46vh, 460px); border: 1px solid var(--c-border); border-radius: var(--r); overflow: hidden; display: flex; background: var(--c-white); }
	.fix-chat :global(.chat) { flex: 1; border-inline-start: none; }
</style>
