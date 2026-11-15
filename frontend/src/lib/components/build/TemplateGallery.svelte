<script lang="ts">
	// TemplateGallery — the "From template" create mode of the block editor. Lists seeded starter
	// templates for the chosen block category (logic / ui / ai / data), with domain + search filters,
	// and emits the picked template's full scaffold so the editor can pre-fill a NEW block. The editor
	// authors new blocks; reuse of existing blocks is stimulated elsewhere (palette/canvas).
	import { untrack } from 'svelte';
	import { templatesApi } from '$lib/api/templates';
	import type { TemplateSummary, TemplateDetail } from '$lib/types/templates';
	import type { BlockCategory } from '$lib/types/blocks';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import * as m from '$lib/paraglide/messages';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';

	let { category, onPick }: { category: BlockCategory; onPick: (t: TemplateDetail) => void } = $props();

	let items = $state<TemplateSummary[]>([]);
	let domains = $state<string[]>([]);
	let domain = $state('');
	let q = $state('');
	let loading = $state(true);
	let picking = $state('');
	let confirmRemove = $state(''); // id of the tenant template awaiting delete confirmation
	let removing = $state('');
	let error = $state<string | null>(null);

	// Reload whenever the category changes (the editor's category selector drives this) —
	// and ONLY when it changes. `load()` reads `domain` synchronously (before its first
	// await), so calling it tracked made `domain` a dependency of the very effect that
	// ASSIGNS `domain = ''`: picking a domain re-ran this effect, which wiped the selection
	// back to "all domains" and refetched unfiltered, i.e. the domain select was inert.
	// untrack() keeps the reset (a category switch must clear a stale domain, since the
	// domain list is per-category) without subscribing to what it resets.
	$effect(() => {
		void category;
		untrack(() => {
			domain = '';
			void load();
		});
	});

	// ⛔ THE CARDS ARE SERVER-LOCALIZED, SO A LANGUAGE SWITCH NEEDS A SECOND REQUEST.
	// `GET /api/templates` overlays label/description/tags from `content_translations` and picks the
	// language off `Accept-Language`, which `authFetch` already fills from the live locale rune — so
	// the WIRE was always able to answer in Dutch. What was missing was the refetch: the `$effect`
	// above tracks `category` and NOTHING else (its whole body is inside `untrack`), so switching
	// language relocalized every `m.*()` label around the gallery and left the twenty template
	// CARDS in whatever language they were first fetched in.
	//
	// ⚠️ AND IT COULD NOT HAVE FIXED ITSELF. `load()` → `templatesApi.list()` → `authFetch`, which
	// reads the locale only AFTER `await ensureFreshToken(30)` — a later microtask, outside the
	// effect's synchronous tracking window. The locale is on the wire; it was never a trigger.
	//
	// ⛔ THIS DELIBERATELY DOES NOT TOUCH AN ALREADY-APPLIED TEMPLATE. Once `onPick` fires,
	// `applyTemplate` (routes/block-edit/+page.svelte) has COPIED the label into the author's block
	// name, the description into its description and the docs into its docs — that text is the
	// AUTHOR'S now, possibly already edited, and re-localizing it would silently overwrite their
	// own words on a language switch. Only the unpicked gallery relocalizes.
	//
	// `reloadOnLocaleChange` skips its first run (the category effect already loaded), so this adds
	// no request on mount — pinned by the render test.
	//
	// ⛔ `untrack` IS LOAD-BEARING, FOR THE SAME REASON IT IS ON THE EFFECT ABOVE. Svelte re-collects
	// an effect's dependencies on EVERY run, and `load()` reads `category` and `domain`
	// synchronously (it builds the query object before its first `await`). So the first locale
	// switch would make the locale effect a second subscriber to `domain` — and from then on every
	// domain pick would fire BOTH this effect and `onDomainChange`, i.e. two identical requests,
	// which is precisely the defect template-gallery.domain-filter.render.test.ts was written
	// about. Without `untrack` this file would re-introduce it through a different door.
	reloadOnLocaleChange(() => {
		untrack(() => {
			void load();
		});
	});

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await templatesApi.list({ category, domain: domain || undefined });
			items = res.templates;
			domains = res.domains;
		} catch (e) {
			error = errorText(e, m.error_load_failed());
			items = [];
		} finally {
			loading = false;
		}
	}

	function onDomainChange() {
		void load();
	}

	// Client-side search over the loaded set (name/label/description/tags), with match-highlight.
	const filtered = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		if (!needle) return items;
		return items.filter(
			(t) =>
				t.label.toLowerCase().includes(needle) ||
				t.name.toLowerCase().includes(needle) ||
				t.description.toLowerCase().includes(needle) ||
				t.tags.some((tag) => tag.toLowerCase().includes(needle))
		);
	});

	/** Split text into [before, hit, after] segments for <mark> highlight (no @html). */
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

	async function pick(id: string) {
		picking = id;
		error = null;
		try {
			const detail = await templatesApi.get(id);
			onPick(detail);
		} catch (e) {
			error = errorText(e, m.error_load_failed());
		} finally {
			picking = '';
		}
	}

	// Remove an own-tenant template (developer-only; globals have no delete affordance).
	async function removeTemplate(id: string) {
		removing = id;
		error = null;
		try {
			await templatesApi.delete(id);
			confirmRemove = '';
			await load();
		} catch (e) {
			error = writeErrorText(e, m.error_delete_failed());
		} finally {
			removing = '';
		}
	}
</script>

<div class="gallery">
	<p class="hint">{m.blockedit_tpl_hint()}</p>
	{#if error}<div class="banner error">{error}</div>{/if}

	<div class="filters">
		<input class="search" type="search" placeholder={m.blockedit_tpl_search_ph()} bind:value={q} aria-label={m.blockedit_tpl_search_ph()} />
		{#if domains.length}
			<select bind:value={domain} onchange={onDomainChange} aria-label={m.blockedit_tpl_all_domains()}>
				<option value="">{m.blockedit_tpl_all_domains()}</option>
				{#each domains as d (d)}<option value={d}>{d}</option>{/each}
			</select>
		{/if}
	</div>

	{#if loading}
		<div class="cards">
			{#each Array(4) as _, i (i)}<Skeleton width="100%" height="118px" radius="var(--r-lg)" />{/each}
		</div>
	{:else if !filtered.length}
		<div class="io-empty">{m.blockedit_tpl_none()}</div>
	{:else}
		<div class="cards">
			{#each filtered as t (t.id)}
				<div class="tcard">
					<div class="tc-head">
						<span class="tc-name">{#each segs(t.label) as s, i (i)}{#if s.hit}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</span>
						<span class="tc-badges">
							{#if t.tenantOwned}<span class="tc-owned">{m.blockedit_tpl_owned()}</span>{/if}
							{#if t.domain}<span class="tc-domain">{t.domain}</span>{/if}
						</span>
					</div>
					<p class="tc-desc">{#each segs(t.description) as s, i (i)}{#if s.hit}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</p>
					{#if t.tags.length}
						<div class="tc-tags">
							{#each t.tags as tag (tag)}<span class="tc-tag">{tag}</span>{/each}
						</div>
					{/if}
					<div class="tc-actions">
						<button class="btn-primary" disabled={picking === t.id} onclick={() => pick(t.id)}>
							{picking === t.id ? m.blockedit_import_ontology_loading() : m.blockedit_tpl_use()}
						</button>
						{#if t.tenantOwned && auth.isDeveloper}
							{#if confirmRemove === t.id}
								<span class="tc-confirm">{m.blockedit_tpl_remove_q()}</span>
								<button class="tc-del danger" disabled={removing === t.id} onclick={() => removeTemplate(t.id)}>
									{removing === t.id ? m.blockedit_tpl_removing() : m.blockedit_tpl_remove_confirm()}
								</button>
								<button class="tc-del" disabled={removing === t.id} onclick={() => (confirmRemove = '')}>{m.blockedit_cancel()}</button>
							{:else}
								<button class="tc-del" aria-label={m.blockedit_tpl_remove()} title={m.blockedit_tpl_remove()} onclick={() => (confirmRemove = t.id)}>🗑</button>
							{/if}
						{/if}
					</div>
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
	.filters select { font-size: 12.5px; padding: 7px 9px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); }
	.io-empty { font-size: 12px; color: var(--c-faint); }

	.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
	.tcard { display: flex; flex-direction: column; gap: 8px; padding: 13px 14px; border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-white); transition: border-color .12s, box-shadow .12s; }
	.tcard:hover { border-color: var(--c-teal-mid); box-shadow: var(--sh-sm); }
	.tc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.tc-name { font-size: 13.5px; font-weight: 600; color: var(--c-midnight); }
	.tc-badges { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
	.tc-owned { font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--c-teal-dark); background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); padding: 1px 6px; border-radius: var(--r-sm); }
	.tc-domain { font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--c-violet); background: var(--c-violet-light); padding: 1px 6px; border-radius: var(--r-sm); }
	.tc-desc { font-size: 12px; color: var(--c-muted); margin: 0; flex: 1; line-height: 1.45; }
	.tc-tags { display: flex; flex-wrap: wrap; gap: 5px; }
	.tc-tag { font-size: 10.5px; color: var(--c-teal-dark); background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); padding: 1px 6px; border-radius: 999px; }
	.tc-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.btn-primary { font-size: 12px; font-weight: 600; color: var(--c-white); background: var(--c-teal); padding: 7px 13px; border-radius: var(--r); }
	.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
	.tc-confirm { font-size: 11.5px; color: var(--c-muted); }
	.tc-del { font-size: 11.5px; color: var(--c-muted); background: transparent; border: 1px solid var(--c-border); padding: 6px 9px; border-radius: var(--r-sm); cursor: pointer; }
	.tc-del:hover { border-color: var(--c-coral-light); color: var(--c-coral-dark); }
	.tc-del.danger { color: var(--c-coral-dark); border-color: var(--c-coral-light); background: var(--c-coral-pale); font-weight: 600; }
	.tc-del:disabled { opacity: .5; cursor: not-allowed; }
	mark { background: var(--c-amber-light); color: inherit; border-radius: 2px; padding: 0 1px; }
</style>
