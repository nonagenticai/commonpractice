// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.translation-locale-names.render.test.ts — the translations
// picker names LANGUAGES, not BCP-47 tags.
//
// ⛔ THE DEFECT. The entity editor's translations block rendered
//
//     {#each TX_LOCALES as loc (loc)}<option value={loc}>{loc}</option>{/each}
//
// so the control whose entire job is to ask an author WHICH LANGUAGE they are writing offered
// `nl / pl / fr / es / de / ar / he`. On the same app, `Topbar.svelte` has always rendered
// `LOCALE_LABELS[l]` for the same seven values — so one screen said "Nederlands" in one control and
// "nl" in another, and `LOCALE_LABELS` had exactly two consumers: its own definition and the topbar.
//
// ⚠️ THE OPTION VALUE STAYS THE TAG, and that is asserted rather than assumed: `txLocale` keys
// `translations[txLocale]` and goes on the wire to `PUT …/translations`. Only the TEXT is a word.
// This is the same value/label split `ontology-axis-label.ts` states as the rule for every `<select>`
// on this screen's vocabulary.
//
// ⛔ NOTHING IN `$lib/api/ontology` IS MOCKED — only `$lib/api/auth-fetch`, answering real
// `Response` objects, so the payload travels through the client's own `unwrap` exactly as a
// browser's would. Same harness, deliberately, as the cardinality-label spec next door.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { CompiledOntology, MatrixData, OntologyEntity } from '$lib/types/ontology';

vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

// SvelteFlow reads both during construction; jsdom ships neither.
Object.defineProperty(window, 'matchMedia', {
	writable: true,
	value: (q: string) => ({
		matches: false,
		media: q,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false
	})
});
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as never;

import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { LOCALE_LABELS } from '$lib/stores/locale.svelte';
import Page from './+page.svelte';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The seven non-`en` editions the editor offers, in the order `TX_LOCALES` declares them. */
const TX_LOCALES = ['nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;

/** ⛔ `tenantOwned: true` — only a tenant-owned entity gets the "Bewerken" button. */
function entity(): OntologyEntity {
	return {
		id: 'ent-Claim',
		key: 'industry_dept:Insurance:Claims:Claim',
		name: 'Claim',
		label: 'Schadeclaim',
		synonyms: [],
		description: null,
		scope: 'industry_dept',
		tenantOwned: true,
		attributes: []
	};
}

const matrix = (): MatrixData =>
	({
		industries: ['Insurance'],
		departments: ['Claims'],
		cells: [{ industry: 'Insurance', department: 'Claims', hasSpecialization: true }],
		canManage: true
	}) as MatrixData;

const ontology = (): CompiledOntology =>
	({
		industry: 'Insurance',
		department: 'Claims',
		entities: [entity()],
		relations: [],
		hidden: [],
		canManage: true
	}) as CompiledOntology;

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	overwriteGetLocale(() => 'nl');
	authFetch.mockImplementation(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : String(input);
		if (url === '/api/ontology/matrix') return json(matrix());
		if (url.startsWith('/api/ontology?')) return json(ontology());
		if (url === '/api/ontology/recent-changes') return json({ items: [], unattributed: 0 });
		if (url.endsWith('/translations')) return json({ translations: {} });
		if (url.endsWith('/samples')) return json({ samples: [] });
		return json({ items: [], total: 0 });
	});
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	overwriteGetLocale(() => 'en');
	authFetch.mockReset();
});

/**
 * Mount /ontology, open the entity, and open its editor — the only path to the translations picker.
 *
 * ⛔ POSITIVE MARKERS AT EVERY STEP. This page mounts SvelteFlow and a dozen panels; the picker is
 * behind `{#if editor.mode === 'edit' && editor.id}`, so without them every assertion below would be
 * about an element that does not exist.
 */
async function openTranslationPicker(): Promise<HTMLSelectElement> {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	await settle();
	const nodes = [...host.querySelectorAll('.svelte-flow__node')];
	expect(nodes.length, 'the entity graph never rendered — nothing here is reachable').toBe(1);
	click(nodes[0]!);
	await settle();
	expect(
		squash(host.querySelector('.detail-name')?.textContent),
		'clicking the card did not open its detail panel'
	).toContain('Schadeclaim');

	const edit = [...host.querySelectorAll('.detail-actions button')].find(
		(b) => squash(b.textContent) === 'Bewerken'
	);
	expect(edit, 'the entity editor cannot be opened — is the fixture tenantOwned?').toBeTruthy();
	click(edit!);
	await settle();

	const sel = host.querySelector('select.tx-locale') as HTMLSelectElement | null;
	expect(sel, 'the translations picker never rendered — this file would prove nothing').not.toBeNull();
	return sel!;
}

describe('/ontology names the translation languages instead of tagging them', () => {
	it('⛔ THE DEFECT: the options read "Nederlands", not "nl"', async () => {
		// REVERT THAT TURNS THIS RED: `<option value={loc}>{loc}</option>`.
		const sel = await openTranslationPicker();
		const texts = [...sel.options].map((o) => squash(o.textContent));

		// ⛔ NON-VACUITY FIRST: seven editions in, seven options out.
		expect(texts, 'the picker offered the wrong number of editions').toHaveLength(7);
		expect(texts).toEqual(TX_LOCALES.map((l) => LOCALE_LABELS[l]));
		// The tags themselves must be gone from the visible text.
		for (const tag of TX_LOCALES)
			expect(texts, `the raw tag "${tag}" is still an option's text`).not.toContain(tag);
	});

	it('⛔ …AND THE VALUE IS STILL THE TAG — only the text is a word', async () => {
		// `txLocale` keys `translations[txLocale]` and goes on the wire to `PUT …/translations`.
		// Localizing the VALUE would silently write an author's Dutch text under a key called
		// "Nederlands" — a far worse defect than the one being fixed.
		const sel = await openTranslationPicker();
		expect([...sel.options].map((o) => o.value)).toEqual([...TX_LOCALES]);
		expect(sel.value, 'the picker no longer defaults to Dutch').toBe('nl');
	});

	it('the seven names are seven DIFFERENT names', async () => {
		// A lookup wired to one entry for every option — or two catalog rows pasted alike — reads as
		// "every edition is Nederlands" and would pass a per-locale `toContain`.
		const sel = await openTranslationPicker();
		expect(new Set([...sel.options].map((o) => squash(o.textContent))).size).toBe(7);
	});

	it('⚠️ the names are ENDONYMS and do not follow the reader’s own locale', async () => {
		// Stated so nobody "fixes" it into a per-locale catalog family later. `LOCALE_LABELS` is one
		// table of endonyms — "Nederlands", "Polski", "العربية" — precisely so a reader who cannot read
		// the current UI language can still find their own. The topbar relies on the same property.
		const sel = await openTranslationPicker();
		const texts = [...sel.options].map((o) => squash(o.textContent));
		expect(texts).toContain('Polski');
		expect(texts).toContain('العربية');
	});
});
