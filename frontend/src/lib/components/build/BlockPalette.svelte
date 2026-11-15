<script lang="ts">
	// Left palette (demo.html:2454–2572). Lists the published block library grouped
	// by category; each tile is draggable onto the canvas (transfers the slug).
	import { categoryLabel, type BlockCategory, type BlockListItem } from '$lib/types/blocks';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		items,
		loading,
		error = null,
		onRetry,
		readOnly = false,
		onAdd,
		onAddForeach
	}: {
		items: BlockListItem[];
		loading: boolean;
		/** The palette's OWN load failure, already localized by the page. See the `{:else if error}`
		 *  arm below for why it is a prop rather than something the page paints over the panel. */
		error?: string | null;
		/** Re-run the page's `loadPalette`. Required whenever `error` can be non-null. */
		onRetry?: () => void;
		/**
		 * The canvas belongs to another author and refuses every add (`BuilderStore.readOnly`). The
		 * library itself stays fully readable — names, descriptions, provenance, the search box —
		 * because browsing what a flow is built from is most of why a visitor opened it. What is
		 * withdrawn is only the ADD: the drag, the click and the keyboard activation, all three,
		 * because the tile is a `role="button"` with a `tabindex` and dropping only the drag would
		 * leave the other two dead rather than absent (the defect the `activate` note above exists
		 * to record, arriving from the other side).
		 *
		 * Defaults to `false` so every other mount of this component is unaffected.
		 */
		readOnly?: boolean;
		/** Add this block to the canvas without a drag — see `activate` below for why that is not
		 *  a convenience. The page picks the position. */
		onAdd: (slug: string) => void;
		onAddForeach: () => void;
	} = $props();

	let query = $state('');
	const ORDER: BlockCategory[] = ['data', 'ai', 'logic', 'output', 'ui'];
	const groups = $derived.by(() => {
		const term = query.trim().toLowerCase();
		const match = (i: BlockListItem) =>
			!term ||
			i.name.toLowerCase().includes(term) ||
			i.slug.toLowerCase().includes(term) ||
			(i.description ?? '').toLowerCase().includes(term);
		return ORDER.map((cat) => ({
			cat,
			label: categoryLabel(cat),
			items: items.filter((i) => i.category === cat && match(i))
		})).filter((g) => g.items.length > 0);
	});
	const noMatches = $derived(query.trim() !== '' && groups.length === 0);

	function swatch(cat: BlockCategory): string {
		const map: Record<BlockCategory, string> = {
			data: 'var(--c-teal)',
			ai: 'var(--c-violet)',
			logic: 'var(--c-amber)',
			output: 'var(--c-coral)',
			ui: 'var(--c-teal-mid)'
		};
		return map[cat];
	}
	function onDragStart(e: DragEvent, slug: string) {
		e.dataTransfer?.setData('application/cp-block', slug);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	// Phase 5: the loop construct is not a block — it carries its own drag type so the canvas drops a
	// foreach container instead of looking up a block by slug.
	function onForeachDragStart(e: DragEvent) {
		e.dataTransfer?.setData('application/cp-foreach', '1');
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}

	// ⛔ A TILE IS NOT DRAG-ONLY. These carry `role="button"` and `tabindex="0"`, so they take focus
	// and announce themselves to assistive tech as buttons — and before this they had no `onclick`
	// and no `onkeydown`, and nothing above them delegated. Activating one did nothing: a WCAG 2.1.1
	// (Keyboard) failure on the single control this screen is built around. And it is not only an
	// accessibility defect: HTML5 `dragstart` does not fire from touch input, so on a tablet the drag
	// was not awkward, it was absent — a block could not be added to a flow at all, short of spending
	// a metered LLM turn on the chat's `add_node`. The drag stays; this is the second way in, and the
	// page places the node (see `cascadePosition`) since an activation names no drop point.
	function activate(e: KeyboardEvent, run: () => void) {
		// Space is the page-scroll key, so a handler that adds a node AND jumps the palette a
		// screenful is a worse control than the dead one it replaces.
		if (e.key !== 'Enter' && e.key !== ' ') return;
		e.preventDefault();
		// ⚠️ AFTER `preventDefault`, not before. A read-only tile must still not scroll the palette
		// on Space — the key was consumed by a control that looks activatable either way.
		if (readOnly) return;
		run();
	}

	/** The click path, refused for the same reason `activate` is. */
	function tryAdd(run: () => void) {
		if (readOnly) return;
		run();
	}

	/** Provenance tooltip for a derived data block (the entity name = last segment of its key). */
	function tileTitle(b: BlockListItem): string {
		if (b.source_entity_key) {
			return m.blocks_derived_from({ entity: b.source_entity_key.split(':').pop() ?? b.source_entity_key });
		}
		return b.description;
	}

	/** Split a label into matched / unmatched segments so the active search term is highlighted. */
	function parts(text: string): { t: string; hit: boolean }[] {
		const term = query.trim();
		if (!term) return [{ t: text, hit: false }];
		const lower = text.toLowerCase();
		const tl = term.toLowerCase();
		const out: { t: string; hit: boolean }[] = [];
		let i = 0;
		while (i < text.length) {
			const idx = lower.indexOf(tl, i);
			if (idx === -1) {
				out.push({ t: text.slice(i), hit: false });
				break;
			}
			if (idx > i) out.push({ t: text.slice(i, idx), hit: false });
			out.push({ t: text.slice(idx, idx + term.length), hit: true });
			i = idx + term.length;
		}
		return out;
	}
</script>

<aside class="palette">
	<div class="palette-head">{m.palette_head()}</div>
	{#if loading}
		<div class="palette-skeleton" aria-busy="true" aria-label={m.palette_loading()}>
			{#each Array(6) as _, i (i)}
				<div class="skeleton-tile">
					<Skeleton width="22px" height="22px" radius="5px" />
					<Skeleton width={`${55 + ((i * 13) % 35)}%`} height="11px" />
				</div>
			{/each}
		</div>
	{:else if error}
		<!-- ⛔ THE FAILURE BRANCH REPLACES THE PANEL, IT DOES NOT SIT BESIDE IT. Rendered alongside,
		     the search box and `blocks_no_match` ("No blocks match your search.") would still be on
		     screen contradicting it — telling a builder whose library never arrived that their query
		     was too narrow. Same shape and same reasoning as the delivery-load failure at
		     `routes/solutions/[id]/+page.svelte:509`. The retry is not decoration: `loadPalette` has
		     exactly one other caller (`onMount`), so without it the only way back is a page reload. -->
		<div class="palette-error" role="alert" data-testid="palette-load-error">
			<p>{error}</p>
			{#if onRetry}
				<button type="button" class="palette-retry" onclick={onRetry}>{m.error_load_retry()}</button>
			{/if}
		</div>
	{:else}
		<div class="palette-search-wrap">
			<input class="palette-search" type="search" bind:value={query} placeholder={m.blocks_search_placeholder()} aria-label={m.blocks_search_placeholder()} />
		</div>
		{#if noMatches}
			<!-- `noMatches` is only ever true with a non-empty query (see its $derived), so this is
			     by construction a no-hit SEARCH, never an empty library — `blocks_empty` ("no blocks
			     in this category yet") told a builder who mistyped a slug that the library was bare.
			     Same key and same reasoning as the /blocks grid and /solutions. -->
			<div class="palette-loading">{m.blocks_no_match()}</div>
		{/if}
		{#if !query.trim()}
		<div class="cat">
			<div class="cat-name"><span class="dot" style="background:var(--c-teal-dark)"></span>{m.palette_control_flow()}</div>
			<div
				class="tile"
				class:inert={readOnly}
				draggable={!readOnly}
				data-foreach-tile
				aria-disabled={readOnly}
				ondragstart={onForeachDragStart}
				onclick={() => tryAdd(onAddForeach)}
				onkeydown={(e) => activate(e, onAddForeach)}
				title={m.foreach_palette_hint()}
				role="button"
				tabindex="0"
			>
				<span class="tile-icon" style="background:var(--c-teal-light);color:var(--c-teal-dark)">
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
						<path d="M17 2l4 4-4 4" />
						<path d="M3 11V9a4 4 0 0 1 4-4h14" />
						<path d="M7 22l-4-4 4-4" />
						<path d="M21 13v2a4 4 0 0 1-4 4H3" />
					</svg>
				</span>
				<span class="tile-name">{m.foreach_palette_label()}</span>
			</div>
		</div>
		{/if}
		{#each groups as g (g.cat)}
			<div class="cat">
				<div class="cat-name"><span class="dot" style="background:{swatch(g.cat)}"></span>{g.label}</div>
				{#each g.items as b (b.slug)}
					<div
						class="tile"
						class:inert={readOnly}
						draggable={!readOnly}
						data-block-slug={b.slug}
						aria-disabled={readOnly}
						ondragstart={(e) => onDragStart(e, b.slug)}
						onclick={() => tryAdd(() => onAdd(b.slug))}
						onkeydown={(e) => activate(e, () => onAdd(b.slug))}
						title={tileTitle(b)}
						role="button"
						tabindex="0"
					>
						<span class="tile-icon" style="background:{swatch(g.cat)}1a;color:{swatch(g.cat)}">
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
								<rect x="3" y="3" width="8" height="8" rx="1" />
								<rect x="13" y="3" width="8" height="8" rx="1" />
								<rect x="3" y="13" width="8" height="8" rx="1" />
							</svg>
						</span>
						<span class="tile-main">
							<span class="tile-name">{#each parts(b.name) as seg}{#if seg.hit}<mark>{seg.t}</mark>{:else}{seg.t}{/if}{/each}</span>
							{#if b.source_entity_key}
								<span class="tile-prov">
									<svg class="prov-icon" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true">
										<path d="M4 4v8a4 4 0 0 0 4 4h12" />
										<path d="M16 11l4 5-4 5" />
									</svg>
									{m.palette_from_entity({ entity: b.source_entity_key.split(':').pop() ?? b.source_entity_key })}
								</span>
							{/if}
						</span>
						{#if b.owner === 'tenant'}
							<span class="owner-badge" title={m.block_owner_tenant()}>{m.block_owner_tenant()}</span>
						{/if}
						<!-- Second of the four "Simulated" surfaces (catalogue card · THIS · canvas node · run
						     output). The builder choosing a block for a flow is the reader with the most to
						     lose from not knowing: a flow assembled entirely out of fixture-backed blocks runs
						     green end to end and demonstrates nothing. Same `mock_data` bit, same catalog key.
						     See routes/blocks/+page.svelte for the full note. -->
						{#if b.mock_data ?? false}
							<!-- A quiet dot with a tooltip; the word stays for screen readers. -->
							<span class="sim-badge" title={m.build_example_data()} aria-label={m.build_example_data()}
								><span class="sr-only">{m.block_simulated_badge()}</span></span
							>
						{/if}
					</div>
				{/each}
			</div>
		{/each}
	{/if}
</aside>

<style>
	.palette {
		background: var(--c-white);
		border-inline-end: 1px solid var(--c-border);
		overflow-y: auto;
		min-height: 0;
	}
	.palette-head {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--c-faint);
		padding: 14px 16px 6px;
	}
	.palette-loading {
		padding: 16px;
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.palette-error {
		margin: 10px 12px;
		padding: 12px 14px;
		font-size: 12.5px;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r);
	}
	.palette-error p {
		margin: 0 0 8px;
	}
	.palette-retry {
		font: inherit;
		font-weight: 600;
		color: var(--c-midnight);
		background: var(--c-white);
		border: 1px solid var(--c-border-strong);
		border-radius: var(--r);
		padding: 4px 10px;
		cursor: pointer;
	}
	.palette-retry:hover {
		border-color: var(--c-teal-dark);
		color: var(--c-teal-dark);
	}
	.palette-skeleton {
		padding: 10px 18px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.skeleton-tile {
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.palette-search-wrap {
		padding: 4px 12px 8px;
	}
	.palette-search {
		width: 100%;
		font-size: 12px;
		color: var(--c-ink);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		padding: 6px 10px;
		border-radius: var(--r);
	}
	.palette-search::placeholder {
		color: var(--c-muted);
	}
	.cat {
		padding: 8px 10px;
	}
	.cat-name {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 10.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--c-muted);
		padding: 6px 6px 4px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		flex-shrink: 0;
	}
	.tile {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 8px 9px;
		border-radius: var(--r);
		border: 1px solid transparent;
		cursor: grab;
		user-select: none;
		transition:
			background 0.12s ease,
			border-color 0.12s ease,
			box-shadow 0.12s ease,
			transform 0.12s ease;
	}
	.tile:hover {
		background: var(--c-white);
		border-color: var(--c-border);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
		transform: translateY(-1px);
	}
	.tile:active {
		cursor: grabbing;
		transform: translateY(0);
		box-shadow: none;
	}
	/* Read-only: the tile is still fully READABLE (no opacity drop — the block name and its
	   description are the reason a visitor opened the palette at all). What changes is the
	   AFFORDANCE: the grab cursor and the lift-on-hover both promise a drop the canvas will refuse.
	   The rules are ordered after `:hover`/`:active` so they win without `!important`. */
	.tile.inert,
	.tile.inert:hover,
	.tile.inert:active {
		cursor: default;
		transform: none;
		box-shadow: none;
	}
	.tile-icon {
		width: 22px;
		height: 22px;
		border-radius: 5px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.tile-main {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
		min-width: 0;
	}
	.tile-name {
		font-size: 12px;
		line-height: 1.3;
		color: var(--c-ink);
		/* Two lines before ellipsis: "Claimformulier lezen" must not read "Claimformu…". */
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.tile-prov {
		display: flex;
		align-items: center;
		gap: 3px;
		font-size: 9.5px;
		color: var(--c-teal-dark);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.prov-icon {
		flex-shrink: 0;
		opacity: 0.85;
	}
	.tile-name :global(mark) {
		background: color-mix(in srgb, var(--c-amber) 38%, transparent);
		color: inherit;
		border-radius: 2px;
		padding: 0 1px;
	}
	.owner-badge {
		flex-shrink: 0;
		font-size: 9px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--c-violet);
		background: color-mix(in srgb, var(--c-violet) 12%, transparent);
		border-radius: 4px;
		padding: 1px 5px;
	}
	/* Amber, not coral/rose: a fixture-backed block is behaving as designed. Same palette choice
	   as the catalogue card's `.sim-badge`, so one badge reads as one concept across screens. */
	.sim-badge {
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
</style>
