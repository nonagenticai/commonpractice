<script lang="ts">
	// ExistingBlockPicker — the "From existing block" create mode of the block editor (Phase 5C). Lists
	// the catalogue (filtered to the chosen category + a free-text search) and, on pick, fetches the
	// block's full detail so the editor can fork it into a NEW draft (code + descriptor + docs prefilled,
	// renamed). This is a fork-as-scaffold path for authoring a variant — distinct from reusing an
	// existing block as-is on the canvas.
	import { blocksApi } from '$lib/api/blocks';
	import type { BlockListItem, BlockDetail, BlockCategory } from '$lib/types/blocks';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import * as m from '$lib/paraglide/messages';
	import { errorText } from '$lib/api/error-message';

	let { category, onPick }: { category: BlockCategory; onPick: (b: BlockDetail) => void } = $props();

	let items = $state<BlockListItem[]>([]);
	let q = $state('');
	let loading = $state(true);
	let picking = $state('');
	let error = $state<string | null>(null);

	// Reload whenever the category changes (the editor's category selector drives this).
	$effect(() => {
		void category;
		void load();
	});

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await blocksApi.list({ category });
			items = res.items;
		} catch (e) {
			error = errorText(e, m.error_load_failed());
			items = [];
		} finally {
			loading = false;
		}
	}

	// Client-side search over the loaded set (name/slug/description), with match-highlight.
	const filtered = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		if (!needle) return items;
		return items.filter(
			(b) =>
				b.name.toLowerCase().includes(needle) ||
				b.slug.toLowerCase().includes(needle) ||
				b.description.toLowerCase().includes(needle)
		);
	});

	/** Split text into segments for <mark> highlight (no @html). */
	function segs(text: string): { t: string; hit: boolean }[] {
		const needle = q.trim();
		if (!needle) return [{ t: text, hit: false }];
		const i = text.toLowerCase().indexOf(needle.toLowerCase());
		if (i < 0) return [{ t: text, hit: false }];
		return [
			{ t: text.slice(0, i), hit: false },
			{ t: text.slice(i, i + needle.length), hit: true },
			{ t: text.slice(i + needle.length), hit: false }
		];
	}

	async function pick(slug: string) {
		picking = slug;
		error = null;
		try {
			const detail = await blocksApi.get(slug);
			onPick(detail);
		} catch (e) {
			error = errorText(e, m.error_load_failed());
		} finally {
			picking = '';
		}
	}
</script>

<div class="gallery">
	<p class="hint">{m.blockedit_existing_hint()}</p>
	{#if error}<div class="banner error">{error}</div>{/if}

	<div class="filters">
		<input class="search" type="search" placeholder={m.blockedit_existing_search_ph()} bind:value={q} aria-label={m.blockedit_existing_search_ph()} />
	</div>

	{#if loading}
		<div class="cards">
			{#each Array(4) as _, i (i)}<Skeleton width="100%" height="104px" radius="var(--r-lg)" />{/each}
		</div>
	{:else if !filtered.length}
		<div class="io-empty">{m.blockedit_existing_none()}</div>
	{:else}
		<div class="cards">
			{#each filtered as b (b.slug)}
				<div class="tcard">
					<div class="tc-head">
						<span class="tc-name">{#each segs(b.name) as s, i (i)}{#if s.hit}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</span>
						<span class="tc-slug">{b.slug}</span>
						<!-- ⛔ THE FIFTH SURFACE, AND THE ONE THE FABRICATION BIT PROPAGATES THROUGH.
						     The other four (catalogue card · build palette · canvas node · run output) only
						     SHOW a simulated block. This one FORKS it: picking a card here copies the whole
						     descriptor — `capabilities.mockData` included — into a brand-new draft
						     (routes/block-edit/+page.svelte). An author scaffolding "my variant of that block"
						     off an unbadged card inherits `ctx.mockData()` without ever being told, and ships
						     a second block that invents its output. Badging the source card is what makes
						     that an informed choice.
						     Same bit, same `?? false`, same catalog key as BlockPalette.svelte and
						     routes/blocks/+page.svelte — see the latter for the full note on why the
						     absent-field direction is the safe one. -->
						{#if b.mock_data ?? false}
							<span class="sim-badge" title={m.build_example_data()} aria-label={m.build_example_data()}
								><span class="sr-only">{m.block_simulated_badge()}</span></span
							>
						{/if}
					</div>
					<p class="tc-desc">{#each segs(b.description) as s, i (i)}{#if s.hit}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</p>
					<button class="btn-primary" disabled={picking === b.slug} onclick={() => pick(b.slug)}>
						{picking === b.slug ? m.blockedit_import_ontology_loading() : m.blockedit_existing_use()}
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.gallery { max-width: 920px; padding: 18px; border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-white); }
	.hint { font-size: 12.5px; color: var(--c-muted); margin: 0 0 12px; }
	.banner.error { font-size: 12.5px; padding: 8px 11px; border-radius: var(--r-sm); background: var(--c-coral-pale); color: var(--c-coral-dark); border: 1px solid var(--c-coral-light); margin-bottom: 10px; }
	.filters { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
	.search { flex: 1; min-width: 180px; font-size: 12.5px; padding: 7px 10px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); }
	.io-empty { font-size: 12px; color: var(--c-faint); }

	.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
	.tcard { display: flex; flex-direction: column; gap: 8px; padding: 13px 14px; border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-white); transition: border-color .12s, box-shadow .12s; }
	.tcard:hover { border-color: var(--c-teal-mid); box-shadow: var(--sh-sm); }
	.tc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	/* `flex: 1` so the name absorbs the slack instead of `space-between` doing it: with the badge
	   present the head has three children, and space-between would push the slug into the middle of
	   the card. With `flex: 1` the slug and the badge stay together at the end, and the no-badge
	   layout is byte-identical to what space-between produced before. */
	.tc-name { font-size: 13.5px; font-weight: 600; color: var(--c-midnight); flex: 1; min-width: 0; }
	.tc-slug { font-size: 10.5px; font-family: var(--font-mono, monospace); color: var(--c-faint); }
	/* The example-data dot: same amber dot as BlockNode/BlockPalette; the word stays for screen readers. */
	.sim-badge {
		flex-shrink: 0;
		display: inline-block;
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
	.tc-desc { font-size: 12px; color: var(--c-muted); margin: 0; flex: 1; line-height: 1.45; }
	.btn-primary { align-self: flex-start; font-size: 12px; font-weight: 600; color: var(--c-white); background: var(--c-teal); padding: 7px 13px; border-radius: var(--r); }
	.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
	mark { background: var(--c-amber-light); color: inherit; border-radius: 2px; padding: 0 1px; }
</style>
