// @vitest-environment jsdom
//
// template-gallery.locale-refetch.render.test.ts — THE DEFECT, at the surface it happens on: a
// Dutch author opens /block-edit → "Vanuit sjabloon" and the 20 starter cards are in English.
//
// ⛔ WHAT WAS BROKEN, IN TWO HALVES. The BACKEND half is covered by backend/tests/template-i18n.test.ts
// (routes/templates.ts had no locale handling at all, and templates-service sorted on the English
// label). This file covers the CLIENT half, which is independently sufficient to keep the gallery
// English forever: the component's only `$effect` tracks `category`, and its whole body sits inside
// `untrack()`. Switching language in the topbar therefore relocalized every `m.*()` string AROUND
// the grid — the hint, the search placeholder, the "Use" buttons — and left the twenty template
// LABELS, DESCRIPTIONS and TAGS inside it in whatever language they were first fetched in. The
// half-translated screen is the one a demo opens.
//
// ⚠️ AND THE EFFECT COULD NOT HAVE COVERED IT. `load()` → `templatesApi.list()` → `authFetch`,
// which reads `getLocale()` only after `await ensureFreshToken(30)` — a later microtask, outside
// the effect's synchronous tracking window. The locale rides on `Accept-Language`; it was never a
// reload trigger. So the fix is a second subscriber (`reloadOnLocaleChange`), not a wider effect.
//
// ⛔ THE ANTI-VACUITY RULE. Every case asserts BOTH halves — the Dutch is on screen AND the English
// is gone. "Something rendered" is satisfied by a re-render of the same list; "the English is gone"
// is satisfied by a component that crashed and rendered nothing. So the card count is asserted in
// the same breath, and the first case pins that the two fixtures share no substring in either
// direction (otherwise "the Dutch label is present" could be satisfied by the English one still
// sitting there).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { BlockCategory } from '$lib/types/blocks';
import type { TemplateListResult, TemplateSummary } from '$lib/types/templates';
import { locale } from '$lib/stores/locale.svelte';

const list = vi.fn();
const get = vi.fn();
const del = vi.fn();

// ⛔ ALIAS module ids, never relative ones — a relative mock id resolves to a different module
// record than the component imports and silently does nothing.
vi.mock('$lib/api/templates', () => ({ templatesApi: { list, get, delete: del } }));

// The real auth store constructs a Keycloak instance at module load (browser-only).
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isDeveloper: false } }));

vi.mock('$lib/api/error-message', () => ({
	errorText: () => 'load failed',
	writeErrorText: () => 'delete failed'
}));

// Plain object, never a Proxy — a Proxy here hangs the run with no output. The CHROME is
// deliberately not the subject: this file is about the API-fetched card content, which no message
// catalog can reach.
vi.mock('$lib/paraglide/messages', () => ({
	blockedit_tpl_hint: () => 'hint',
	blockedit_tpl_search_ph: () => 'search',
	blockedit_tpl_all_domains: () => 'All domains',
	blockedit_tpl_none: () => 'none',
	blockedit_tpl_use: () => 'use',
	blockedit_tpl_owned: () => 'owned',
	blockedit_tpl_remove: () => 'remove',
	blockedit_tpl_remove_q: () => 'remove?',
	blockedit_tpl_remove_confirm: () => 'yes',
	blockedit_tpl_removing: () => 'removing',
	blockedit_cancel: () => 'cancel',
	blockedit_import_ontology_loading: () => 'loading',
	error_load_failed: () => 'load failed',
	error_delete_failed: () => 'delete failed'
}));

/**
 * ⛔ THE TWO LANGUAGES SHARE NO SUBSTRING, IN EITHER DIRECTION — pinned by the first case rather
 * than trusted. A real overlap is easy to write here by accident ("validate" survives into Dutch
 * "validatie"), and it would make every "the English is gone" assertion below unfalsifiable.
 */
const EN = {
	label: 'Validate record',
	description: 'Check an incoming record against a field schema.',
	tag: 'schema'
};
const NL = {
	label: 'Gegevens keuren',
	description: 'Toets een binnenkomend bericht aan een veldopzet.',
	tag: 'veldopzet'
};

function tpl(over: { label: string; description: string; tag: string }): TemplateSummary {
	return {
		id: 't1',
		category: 'logic',
		domain: null,
		// `name` is the slug-like IDENTIFIER and is NEVER translated — the same value in both
		// fixtures on purpose, so it cannot accidentally satisfy a language assertion.
		name: 'validate-record',
		label: over.label,
		description: over.description,
		tags: [over.tag],
		tenantOwned: false
	};
}

const EN_LIST: TemplateListResult = {
	templates: [tpl(EN)],
	categories: ['logic'],
	domains: [],
	tags: [EN.tag]
};
const NL_LIST: TemplateListResult = {
	templates: [tpl(NL)],
	categories: ['logic'],
	domains: [],
	tags: [NL.tag]
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

async function settle(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await tick();
	flushSync();
}

function cards(): HTMLElement[] {
	return [...host.querySelectorAll('.tcard')] as HTMLElement[];
}
function cardText(): string {
	return cards()
		.map((c) => c.textContent ?? '')
		.join(' ');
}

/**
 * Drive a REAL locale change, the way the topbar switcher does — minus the network.
 *
 * ⚠️ ASSIGNED DIRECTLY, NEVER VIA `locale.set()`: that method fires an `authFetch` PATCH to
 * `/api/me/locale`, unmocked here. The rune assignment IS the trigger the component reacts to —
 * `reloadOnLocaleChange` tracks `locale.current` and nothing else.
 */
async function switchToDutch(): Promise<void> {
	locale.current = 'nl';
	flushSync();
	await settle();
}

async function render(): Promise<void> {
	const { default: TemplateGallery } = await import('./TemplateGallery.svelte');
	app = mount(TemplateGallery, {
		target: host,
		props: { category: 'logic' as BlockCategory, onPick: () => {} }
	}) as Record<string, unknown>;
	flushSync();
	await settle();
	// ⛔ THE POSITIVE MARKER. Without it, "the English is gone" passes against a gallery that never
	// rendered at all.
	expect(cards(), 'the gallery never rendered, so this file tests nothing').toHaveLength(1);
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	list.mockReset();
	get.mockReset();
	del.mockReset();
});

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	locale.current = initialLocale;
	flushSync();
});

describe('TemplateGallery relocalizes its cards when the author switches language', () => {
	it('the two fixtures really are different, and neither contains the other', () => {
		for (const [a, b] of [
			[EN.label, NL.label],
			[NL.label, EN.label],
			[EN.description, NL.description],
			[NL.description, EN.description],
			[EN.tag, NL.tag],
			[NL.tag, EN.tag]
		]) {
			expect(a!.toLowerCase().includes(b!.toLowerCase()), `"${a}" must not contain "${b}"`).toBe(
				false
			);
		}
	});

	it('⛔ a locale switch re-requests the catalog and the cards are Dutch, with no English left', async () => {
		list.mockResolvedValue(EN_LIST);
		await render();

		// The English is genuinely on screen first — otherwise the "absent" half proves nothing.
		expect(cardText()).toContain(EN.label);
		expect(cardText()).toContain(EN.description);
		expect(cardText()).toContain(EN.tag);
		expect(cardText()).not.toContain(NL.label);

		list.mockResolvedValue(NL_LIST);
		await switchToDutch();

		// The request really was re-issued. (The locale rides on `Accept-Language`, not on the
		// argument, so the argument is unchanged — the COUNT is the observable.)
		expect(list, 'the locale switch did not refetch the template catalog').toHaveBeenCalledTimes(2);

		// The gallery still exists and still holds the card — not a blank pane, not a skeleton.
		expect(cards(), 'the gallery was torn down instead of re-rendered').toHaveLength(1);
		expect(cardText()).toContain(NL.label);
		expect(cardText()).toContain(NL.description);
		expect(cardText()).toContain(NL.tag);
		// …and the English is GONE. Red by deleting `reloadOnLocaleChange` from the component.
		expect(cardText()).not.toContain(EN.label);
		expect(cardText()).not.toContain(EN.description);
		expect(cardText()).not.toContain(EN.tag);
	});

	it('the mount itself is still a single request — the reload must not double the first fetch', async () => {
		// Guards the OVER-fix: `reloadOnLocaleChange` deliberately skips its first run because the
		// category effect already covers the initial load. A variant that "just uses a plain
		// $effect" doubles every gallery open, and reds here.
		list.mockResolvedValue(EN_LIST);
		await render();
		expect(list).toHaveBeenCalledTimes(1);
	});

	it('⛔ …and a domain change AFTER the switch is still ONE request, not two', async () => {
		// ⛔ THE TRAP IN THE SHARED IDIOM, and the reason `untrack` is inside the callback.
		// `reloadOnLocaleChange` calls `load()` from its own `$effect`, and `load()` reads `domain`
		// synchronously (it builds the query object before its first `await`). Svelte re-collects an
		// effect's dependencies on every run, so the FIRST locale switch would otherwise make the
		// locale effect a second subscriber to `domain` — and from then on every domain pick fires
		// both it and `onDomainChange`: two identical requests, which is exactly the defect
		// template-gallery.domain-filter.render.test.ts exists to pin.
		const withDomains = (base: TemplateListResult): TemplateListResult => ({
			...base,
			domains: ['finance', 'hr']
		});
		list.mockResolvedValue(withDomains(EN_LIST));
		await render();
		list.mockResolvedValue(withDomains(NL_LIST));
		await switchToDutch();
		expect(list).toHaveBeenCalledTimes(2);

		const select = host.querySelector('select') as HTMLSelectElement;
		expect(select, 'no domain <select> rendered — this case would pass vacuously').toBeTruthy();
		select.value = 'finance';
		// `bubbles: true` — Svelte 5 delegates `change` to the mount root.
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		await settle();

		expect(list, 'the domain change fired twice').toHaveBeenCalledTimes(3);
		expect(list).toHaveBeenLastCalledWith({ category: 'logic', domain: 'finance' });
	});
});
