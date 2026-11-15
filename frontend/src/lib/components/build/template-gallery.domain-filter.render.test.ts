// @vitest-environment jsdom
//
// Render guard for the block editor's "From template" domain filter.
//
// The gallery reloaded on category change with:
//
//     $effect(() => { void category; domain = ''; void load(); });
//
// `load()` reads `domain` synchronously (it builds the query object before its first
// `await`), so `domain` became a tracked dependency of the very effect that ASSIGNS
// `domain = ''`. Picking a domain therefore re-ran the effect, which wiped the selection
// back to "all domains" and refetched unfiltered — the <select> looked alive (it has an
// onchange, it does fire a request) but was completely inert: the list never narrowed,
// and every selection cost two round trips.
//
// A static read of the component cannot catch this — the bug is entirely in Svelte's
// dependency graph — so this mounts the real component and drives the real <select>.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { BlockCategory } from '$lib/types/blocks';
import type { TemplateListResult, TemplateSummary } from '$lib/types/templates';

const list = vi.fn();
const get = vi.fn();
const del = vi.fn();

vi.mock('$lib/api/templates', () => ({ templatesApi: { list, get, delete: del } }));

// The real auth store constructs a Keycloak instance at module load (browser-only).
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isDeveloper: false } }));

vi.mock('$lib/api/error-message', () => ({
	errorText: () => 'load failed',
	writeErrorText: () => 'delete failed'
}));

// Plain object, never a Proxy — a Proxy here hangs the run with no output.
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

function tpl(id: string, domain: string | null): TemplateSummary {
	return {
		id,
		category: 'logic',
		domain,
		name: id,
		label: `Template ${id}`,
		description: 'a starter scaffold',
		tags: [],
		tenantOwned: false
	};
}

const ALL: TemplateListResult = {
	templates: [tpl('a', 'finance'), tpl('b', 'hr')],
	categories: ['logic'],
	domains: ['finance', 'hr'],
	tags: []
};
const FINANCE_ONLY: TemplateListResult = { ...ALL, templates: [tpl('a', 'finance')] };

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

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
});

/** Let the in-flight `templatesApi.list` promise settle and the DOM re-render. */
async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await tick();
	flushSync();
}

async function render(): Promise<void> {
	const { default: TemplateGallery } = await import('./TemplateGallery.svelte');
	app = mount(TemplateGallery, {
		target: host,
		props: { category: 'logic' as BlockCategory, onPick: () => {} }
	});
	flushSync();
	await settle();
}

describe('TemplateGallery domain filter', () => {
	it('actually filters, keeps the selection, and issues exactly one request per pick', async () => {
		list.mockResolvedValueOnce(ALL).mockResolvedValueOnce(FINANCE_ONLY);

		await render();

		// Baseline: one unfiltered load for the initial category.
		expect(list).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenNthCalledWith(1, { category: 'logic', domain: undefined });

		const select = host.querySelector('select') as HTMLSelectElement;
		expect(select).toBeTruthy();
		expect([...select.options].map((o) => o.value)).toEqual(['', 'finance', 'hr']);

		// Drive the real control the way a user does.
		select.value = 'finance';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		await settle();

		// The refetch must carry the domain...
		expect(list).toHaveBeenNthCalledWith(2, { category: 'logic', domain: 'finance' });
		// ...must be the ONLY refetch (the effect must not re-run and reload unfiltered)...
		expect(list).toHaveBeenCalledTimes(2);
		// ...the <select> must still show what the user picked...
		expect(select.value).toBe('finance');
		// ...and the narrowed result must be what is on screen.
		expect(host.textContent).toContain('Template a');
		expect(host.textContent).not.toContain('Template b');
	});
});
