<script lang="ts">
	// Custom SvelteFlow node — the demo `.flow-node` look (demo.html:809–829) with
	// a typed Handle per descriptor input (left/target) and output (right/source).
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import type { BlockNodeData } from '$lib/stores/builder.svelte';
	import type { BlockCategory } from '$lib/types/blocks';
	import { fieldTypeLabel } from '$lib/i18n/field-type-label';
	// ⛔ NOT `runStatusLabel`. `NodeRuntimeStatus` is running|ok|error|skipped; `flow_run_status` is
	// running|ok|partial|failed. Two of four members differ, and `run-status-label.ts`'s own header
	// rejects the coercion in writing. See node-run-status-label.ts.
	import { nodeRunStatusLabel } from '$lib/i18n/node-run-status-label';
	import { nodeDisplayName } from '$lib/stores/block-catalog.svelte';
	import * as m from '$lib/paraglide/messages';
	import { BLOCK_NODE_W } from '$lib/stores/builder-graph';
	import { portLabel } from '$lib/i18n/port-label';
	import { fieldTypes } from '$lib/stores/field-types.svelte';

	let { data, selected }: NodeProps & { data: BlockNodeData } = $props();

	const inputs = $derived(Object.entries(data.descriptor?.inputs ?? {}));
	const outputs = $derived(Object.entries(data.descriptor?.outputs ?? {}));

	/**
	 * ⛔ THE NODE'S TITLE, AND THIS COMPONENT STAYS A DUMB RENDERER. The header used to be
	 * `{data.slug}` — the raw English hyphenated identifier — on the product's PRIMARY authoring
	 * surface, so a Dutch canvas was covered in `read-claim-form` / `ai-summarize` while the palette
	 * tile that created each one said "Claimformulier lezen". The whole resolution order (current
	 * catalog name → persisted label → slug) lives in `$lib/i18n/block-node-label`; the live catalog
	 * behind it lives in `$lib/stores/block-catalog.svelte`. Not here, because four other sites print
	 * the same name and this lane has already been fixed once per site.
	 *
	 * `$derived`, not a call in the markup, only so the tooltip below can reuse the result.
	 */
	const displayName = $derived(nodeDisplayName(data));
	/**
	 * ⚠️ THE SLUG STAYS REACHABLE, AND IT IS NOT A NICETY — `RunConsole.svelte` PRINTS IT.
	 * The trace lines are `→ ${ev.slug}` / `✓ ${ev.slug}`, deliberately untranslated (RunConsole:38:
	 * "a block identifier. Translating it breaks the match to the canvas node"). Once the canvas
	 * header says "Claimformulier lezen", the console line `✓ read-claim-form` has nothing on screen
	 * to match — so the identifier moves into the title attribute rather than off the node. It is
	 * also printed by `NodeConfigPanel`'s `.cfg-id` for a developer (field types on).
	 *
	 * The name is repeated in the tooltip because `.cp-node-name` ellipsises inside a fixed-width node and
	 * a translated name is routinely longer than the slug it replaced; when the two are identical
	 * (rung 4 — no catalog entry, no label) repeating it would just read as a stutter.
	 */
	const nameTitle = $derived(
		displayName === data.slug ? data.slug : `${displayName} · ${data.slug}`
	);

	/**
	 * Third of the four "Simulated" surfaces (catalogue card · build palette · THIS · run output).
	 * The node is where the reader is looking while a flow runs, so a green node that produced
	 * `ctx.mockData()` output has to say so on the canvas and not only in the console beneath it.
	 *
	 * ⚠️ `=== true`, NOT a truthiness check, and NOT `?? false` on an unresolved descriptor. A node
	 * whose descriptor could not be fetched carries `UNRESOLVED_DESCRIPTOR` (see `noPorts` below):
	 * we do not know whether it is fixture-backed, and an ABSENT badge on an unknown block is the
	 * only honest rendering — the node already declares its own unresolved state separately.
	 *
	 * ⛔ `mockData` ONLY. `capabilities.dataset` is a SEPARATE bit and must never be ORed in here: it
	 * grants `ctx.dataset` access to the tenant's REAL uploaded rows and says nothing about whether
	 * the output is invented. The two were one flag until `load-dataset` — a single
	 * `ctx.dataset(inputs.source)` over the customer's own data, and the first node of most demo
	 * flows — had to declare `mockData` just to pass the executor's gate, at which point this line
	 * would have stamped "Gesimuleerd" on the customer's real data.
	 */
	const simulated = $derived(data.descriptor?.capabilities?.mockData === true);

	/**
	 * Port rows show a human label ("Force OCR"), not the wire key (`force_ocr`); the key stays on
	 * `data-port` and, for developers who switched type chips on, in the tooltip. Type chips are
	 * hidden by default (`$lib/stores/field-types.svelte`).
	 */
	function portTitle(p: string, spec: { type: string; pii?: boolean }): string {
		const pii = spec.pii ? ` · ${m.datasets_col_pii()}` : '';
		return fieldTypes.visible ? `${p}: ${fieldTypeLabel(spec.type)}${pii}` : `${portLabel(p, spec)}${pii}`;
	}

	const HEAD = 34; // header height before the first port row
	const ROW = 22; // per-port row height
	function topFor(i: number): string {
		return `top:${HEAD + i * ROW + ROW / 2}px`;
	}
	const CAT: Record<BlockCategory, [string, string]> = {
		data: ['var(--c-teal-light)', 'var(--c-teal-dark)'],
		ai: ['var(--c-violet-light)', '#5B21B6'],
		logic: ['var(--c-amber-light)', '#92400E'],
		output: ['var(--c-coral-light)', 'var(--c-coral-dark)'],
		ui: ['var(--c-teal-light)', 'var(--c-teal-dark)']
	};
	function iconStyle(category: BlockCategory): string {
		const [bg, fg] = CAT[category];
		return `background:${bg};color:${fg}`;
	}
	const accent = $derived(CAT[data.category]?.[1] ?? 'var(--c-border)');
</script>

<!--
  ⛔ THE PLACEHOLDER THAT LIED. A node whose descriptor could not be fetched carries
  `UNRESOLVED_DESCRIPTOR` — no inputs, no outputs — and used to render the SAME `—` a block that
  genuinely declares no ports renders. Zero `<Handle>`s is CORRECT in both cases (there are none to
  draw), but `@xyflow/svelte` then omits every edge touching this node from its RENDERED edge map
  while leaving it in the saved graph, so the author sees a disconnected node and re-draws or
  deletes an edge that was never actually broken. The node has to stop claiming to be empty.
-->
{#snippet noPorts()}
	{#if data.descriptorUnavailable}
		<div class="port empty unresolved" title={m.build_node_ports_unavailable_title()}>
			{m.build_node_ports_unavailable()}
		</div>
	{:else}
		<div class="port empty">—</div>
	{/if}
{/snippet}

<div
	class="cp-node"
	class:selected
	class:running={data.runtimeStatus === 'running'}
	class:ok={data.runtimeStatus === 'ok'}
	class:error={data.runtimeStatus === 'error'}
	class:skipped={data.runtimeStatus === 'skipped'}
	style="--accent:{accent};width:{BLOCK_NODE_W}px"
>
	<div class="cp-node-head">
		<span class="cp-node-icon" style={iconStyle(data.category)}>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
				<rect x="3" y="3" width="8" height="8" rx="1" />
				<rect x="13" y="3" width="8" height="8" rx="1" />
				<rect x="3" y="13" width="8" height="8" rx="1" />
			</svg>
		</span>
		<span class="cp-node-name" title={nameTitle}>{displayName}</span>
		{#if simulated}
			<!-- A quiet dot, not a word: the tooltip says what it means; the word stays for screen readers. -->
			<span class="cp-node-sim" title={m.build_example_data()} aria-label={m.build_example_data()}
				><span class="sr-only">{m.block_simulated_badge()}</span></span
			>
		{/if}
		<!-- ⛔ THE DOT HAS NO TEXT OF ITS OWN, so this `title` is the ONLY thing on screen that says
		     what the colour means — and it was the raw enum: `running` / `ok` / `error` / `skipped`,
		     on a canvas whose port badges two lines below already go through `fieldTypeLabel` and
		     whose header already goes through `nodeDisplayName`. The class stays the ENUM: it is a CSS
		     hook and a test selector, not copy. -->
		{#if data.runtimeStatus}
			<span class="cp-node-status {data.runtimeStatus}" title={nodeRunStatusLabel(data.runtimeStatus)}></span>
		{/if}
	</div>

	<div class="cp-node-ports">
		<div class="col in">
			{#each inputs as [p, spec] (p)}
				<!-- ⛔ THE TOOLTIP SAYS WHAT THE CHIP SAYS. This interpolated `spec.type` raw while the
				     `.ptype` span one line below rendered `fieldTypeLabel(spec.type)` — so ONE port showed
				     "tekst" and hovered `string`, on the same element, and a reader comparing the two had
				     to guess which was the product's word. `field-type-label.ts` was extracted for exactly
				     this class; this attribute was the site that fix did not reach.
				     ⚠️ THE PORT NAME STAYS VERBATIM. `p` is a wire key the flow's edges are keyed on —
				     translating it would be a different and wrong fix, and `block-node.port-types` pins it.
				     ⚠️ AND SO DOES THE `· PII` MARKER, WHICH IS NOW A CATALOG LOOKUP RATHER THAN A LITERAL.
				     Every catalog's value happens to be "PII" today (it is an initialism), so this changes
				     no pixel — but the dot below already had `title="PII"` hard-coded too, and a locale
				     that ever spells it differently must not have to find two string literals to do it. -->
				<div class="port" title={portTitle(p, spec)}>
					{#if spec.pii}<span class="pii" title={m.datasets_col_pii()}>●</span>{/if}
					<span class="pname" data-port={p}>{portLabel(p, spec)}</span>
					{#if fieldTypes.visible}<span class="ptype">{fieldTypeLabel(spec.type)}</span>{/if}
				</div>
			{/each}
			{#if inputs.length === 0}{@render noPorts()}{/if}
		</div>
		<div class="col out">
			{#each outputs as [p, spec] (p)}
				<!-- ⛔ THE TOOLTIP SAYS WHAT THE CHIP SAYS. This interpolated `spec.type` raw while the
				     `.ptype` span one line below rendered `fieldTypeLabel(spec.type)` — so ONE port showed
				     "tekst" and hovered `string`, on the same element, and a reader comparing the two had
				     to guess which was the product's word. `field-type-label.ts` was extracted for exactly
				     this class; this attribute was the site that fix did not reach.
				     ⚠️ THE PORT NAME STAYS VERBATIM. `p` is a wire key the flow's edges are keyed on —
				     translating it would be a different and wrong fix, and `block-node.port-types` pins it.
				     ⚠️ AND SO DOES THE `· PII` MARKER, WHICH IS NOW A CATALOG LOOKUP RATHER THAN A LITERAL.
				     Every catalog's value happens to be "PII" today (it is an initialism), so this changes
				     no pixel — but the dot below already had `title="PII"` hard-coded too, and a locale
				     that ever spells it differently must not have to find two string literals to do it. -->
				<div class="port" title={portTitle(p, spec)}>
					{#if fieldTypes.visible}<span class="ptype">{fieldTypeLabel(spec.type)}</span>{/if}
					<span class="pname" data-port={p}>{portLabel(p, spec)}</span>
					{#if spec.pii}<span class="pii" title={m.datasets_col_pii()}>●</span>{/if}
				</div>
			{/each}
			{#if outputs.length === 0}{@render noPorts()}{/if}
		</div>
	</div>

	{#each inputs as [p], i (p)}
		<Handle type="target" position={Position.Left} id={p} style={topFor(i)} />
	{/each}
	{#each outputs as [p], i (p)}
		<Handle type="source" position={Position.Right} id={p} style={topFor(i)} />
	{/each}
</div>

<style>
	.cp-node {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh);
		/* width: inline from BLOCK_NODE_W (stores/builder-graph.ts) — one constant, not a CSS copy. */
		font-family: var(--font-sans);
	}
	.cp-node.selected {
		border-color: var(--c-teal);
		box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.18);
	}
	/* Live run status tints (Session 3). */
	.cp-node.running {
		border-color: var(--c-amber);
		box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18);
	}
	.cp-node.ok {
		border-color: var(--c-emerald);
		box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.16);
	}
	.cp-node.error {
		border-color: var(--c-rose);
		box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.18);
	}
	.cp-node.skipped {
		opacity: 0.6;
	}
	.cp-node-status {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		/* logical: `margin-left: auto` pushed the status dot to the wrong end in RTL */
		margin-inline-start: auto;
		flex-shrink: 0;
	}
	.cp-node-status.running {
		background: var(--c-amber);
		animation: status-pulse 1.2s ease-in-out infinite;
	}
	.cp-node-status.ok {
		background: var(--c-emerald);
	}
	.cp-node-status.error {
		background: var(--c-rose);
	}
	.cp-node-status.skipped {
		background: var(--c-faint);
	}
	@keyframes status-pulse {
		50% {
			opacity: 0.3;
		}
	}
	.cp-node-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 9px 11px;
		border-bottom: 1px solid var(--c-border);
		/* The coloured block-type stripe belongs on the side the reader starts from. Physical
		   `left` puts it on the trailing edge in RTL, opposite the node icon it identifies.
		   ⚠️ NOT the same call as `.col.out` below, which stays physical on purpose. */
		border-inline-start: 3px solid var(--accent, var(--c-border));
		border-start-start-radius: var(--r-lg);
	}
	.cp-node-icon {
		width: 22px;
		height: 22px;
		border-radius: 5px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	/* ⚠️ NO `font-family` OVERRIDE ANY MORE — it inherits `.cp-node`'s `var(--font-sans)`.
	   The monospace here was correct while the header printed `data.slug`: a hyphenated identifier
	   belongs in mono, and the port names below it still are. It renders a human, translated,
	   possibly accented sentence now ("Claimformulier lezen", "Résumé par IA"), and mono makes that
	   both wider — inside a fixed-width node that ellipsises — and visually a code token. The slug
	   keeps its mono treatment where it is still shown as an identifier: `NodeConfigPanel`'s
	   `.cfg-id` (developers only). */
	.cp-node-name {
		font-size: 12px;
		font-weight: 600;
		color: var(--c-midnight);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Amber, matching the catalogue card and the palette so one badge reads as one concept. */
	.cp-node-sim {
		flex-shrink: 0;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--c-amber);
		cursor: help;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.cp-node-ports {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0 10px;
		padding: 6px 11px 10px;
	}
	.col {
		display: flex;
		flex-direction: column;
	}
	.col.out {
		/* ⛔ STAYS PHYSICAL, DELIBERATELY — do not "fix" this to `text-align: end`.
		   `FlowCanvas.svelte` computes every wire endpoint from PHYSICAL x (`BLOCK_NODE_W`,
		   `abs.x + BLOCK_NODE_W / 2`). Mirroring the ports column moves the ports visually while the
		   wire math stays put, so the edges detach from the sockets they connect. If the canvas
		   is ever made direction-aware the fix is `direction: ltr` on `.cp-node-ports` as a
		   whole, not flipping this one rule. An RTL audit flagged this as a bug; it is not. */
		text-align: right;
	}
	.port {
		height: 22px;
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: var(--c-muted);
		white-space: nowrap;
		overflow: hidden;
	}
	.col.out .port {
		justify-content: flex-end;
	}
	.pname {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ptype {
		flex-shrink: 0;
		font-size: 8.5px;
		color: var(--accent, var(--c-faint));
		background: color-mix(in srgb, var(--accent, var(--c-faint)) 12%, transparent);
		border-radius: 3px;
		padding: 0 3px;
		line-height: 14px;
	}
	.pii {
		flex-shrink: 0;
		color: var(--c-coral);
		font-size: 7px;
	}
	.port.empty {
		color: var(--c-faint);
		display: block;
		line-height: 22px;
	}
	/* "Ports unknown", not "no ports". Amber to match the canvas pill that names the same blocks,
	   and ellipsised because the node is a fixed width and the sentence is translated into eight
	   languages — the `title` carries the full explanation in every one of them. */
	.port.empty.unresolved {
		color: #92400e;
		font-weight: 600;
		text-overflow: ellipsis;
	}
	/* Handle dots tinted to the design system. */
	.cp-node :global(.svelte-flow__handle) {
		width: 9px;
		height: 9px;
		background: var(--c-white);
		border: 2px solid var(--c-teal);
	}
	.cp-node :global(.svelte-flow__handle-right) {
		border-color: var(--c-coral);
	}
</style>
