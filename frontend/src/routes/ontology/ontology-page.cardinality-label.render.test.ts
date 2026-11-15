// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.cardinality-label.render.test.ts — the /ontology detail panel's
// relation row must be ONE language across all three of its chips.
//
// ⛔ THE DEFECT, AND IT IS THE LAST RAW VALUE ON A ROW THAT WAS OTHERWISE ALREADY FIXED. The
// relation row renders three things: the two ENDS (through `ontologyRelationEndLabel`), the
// PREDICATE (through `ontologyRelationLabel` — see `ontology-page.relation-label.render.test.ts`
// beside this file), and the CARDINALITY, which was the database column printed verbatim:
//
//     {#if r.cardinality}<span class="rel-card">{r.cardinality}</span>{/if}
//
// So a Dutch reader clicking any entity read `Schadeclaim ingediend onder Polis  many-to-one` —
// two localized chips and an English one, on the same row, on every entity click. Not an edge
// case: the shipped seeds put a cardinality on 30 relations (`many-to-one` ×18, `one-to-many` ×7,
// `one-to-one` ×3, `many-to-many` ×2), so nearly every clickable entity carries one.
//
// ⛔ WHY THIS FILE ASSERTS IN `nl` AND SAYS SO. The four seeded values are already English prose,
// so `messages/en.json` reproduces them VERBATIM by design — the fix is for the seven locales that
// had no word at all. The base locale is therefore structurally incapable of telling this fix from
// the defect, exactly as `block-edit.cost-class.render.test.ts` documents for `low`/"Low".
// `overwriteGetLocale` is the same lever `$lib/stores/locale.svelte.ts` pulls in the running app.
//
// ⛔ THE OPEN VALUE SET IS PART OF THE CONTRACT, NOT A CAVEAT. `cardinality` is
// `text NOT NULL DEFAULT ''` written through `z.string().max(20).optional()`, and the Add-relation
// modal offers a FREE-TEXT input. An admin's own "1:N" must survive to the screen; a blank chip
// where a value exists reads as data the page failed to load. Asserted below, and it is also why
// the sibling relation-label spec's `cardinality: 'n:1'` fixture keeps passing unchanged.
//
// ⛔ NOTHING IN `$lib/api/ontology` IS MOCKED — only `$lib/api/auth-fetch`, answering real
// `Response` objects, so the compiled graph travels through the client's own `unwrap` exactly as a
// browser's would. Same harness, deliberately, as the relation-label spec next door.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { CompiledOntology, MatrixData, OntologyEntity, OntologyRelation } from '$lib/types/ontology';

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
import { ontologyCardinalityLabel } from '$lib/i18n/ontology-cardinality-label';
import Page from './+page.svelte';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Labels are Dutch because the SERVER localized them; `name` is the canonical concept id. */
function entity(name: string, label: string): OntologyEntity {
	return {
		id: `ent-${name}`,
		key: `industry_dept:Insurance:Claims:${name}`,
		name,
		label,
		synonyms: [],
		description: null,
		scope: 'industry_dept',
		tenantOwned: true,
		attributes: []
	};
}

/** The variable under test; everything else on the row is held fixed. */
let cardinality: string = 'many-to-one';

function relation(): OntologyRelation {
	return {
		id: 'rel-1',
		from: 'Claim',
		to: 'Policy',
		predicate: 'under',
		label: 'ingediend onder',
		cardinality,
		// Left GLOBAL on purpose: a tenant-owned edge appends a "custom" chip to the row, and the
		// row's exact text is what this file asserts.
		tenantOwned: false
	} as unknown as OntologyRelation;
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
		entities: [entity('Claim', 'Schadeclaim'), entity('Policy', 'Polis')],
		relations: [relation()],
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
	cardinality = 'many-to-one';
	overwriteGetLocale(() => 'nl');
	authFetch.mockImplementation(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : String(input);
		if (url === '/api/ontology/matrix') return json(matrix());
		if (url.startsWith('/api/ontology?')) return json(ontology());
		if (url === '/api/ontology/recent-changes') return json({ items: [], unattributed: 0 });
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

/** Mount /ontology, click the `Claim` card, and return its relation row. */
async function relationRow(): Promise<HTMLElement> {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	await settle();
	const nodes = [...host.querySelectorAll('.svelte-flow__node')];
	// ⛔ POSITIVE MARKERS, in order. /ontology mounts SvelteFlow and a dozen panels; without these
	// every "the English token is gone" assertion below passes for free on a page that never
	// rendered.
	expect(nodes.length, 'the entity graph never rendered — nothing here is reachable').toBe(2);
	const card = nodes.find((n) => n.textContent?.includes('Schadeclaim'));
	expect(card, 'no card is named by the localized entity label the server sent').toBeTruthy();
	click(card!);
	await settle();
	expect(
		squash(host.querySelector('.detail-name')?.textContent),
		'clicking the card did not open ITS detail panel'
	).toContain('Schadeclaim');
	const row = host.querySelector('.rel-row') as HTMLElement | null;
	expect(row, 'the detail panel listed no relation for the selected entity').toBeTruthy();
	return row!;
}

/** The cardinality chip's own text. */
async function chip(): Promise<string> {
	const row = await relationRow();
	return squash(row.querySelector('.rel-card')?.textContent);
}

describe('/ontology says a relation’s cardinality in the reader’s language', () => {
	it('the fixture really is Dutch, and really differs from the enum', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. Every assertion below is "the chip holds the nl word".
		// If `overwriteGetLocale` stopped working the catalog would answer English — which for this
		// key set is byte-identical to the enum — and a test written as `not.toContain('many-to-one')`
		// would pass while proving the exact opposite.
		overwriteGetLocale(() => 'nl');
		const nl = ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'].map(ontologyCardinalityLabel);
		overwriteGetLocale(() => 'en');
		const en = ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'].map(ontologyCardinalityLabel);
		expect(nl).toEqual(['één-op-één', 'één-op-veel', 'veel-op-één', 'veel-op-veel']);
		// ⚠️ THE BASE LOCALE IS DELIBERATELY THE ENUM — stated here so nobody "fixes" it later and
		// so the reason this whole file asserts in nl is written down where it is checked.
		expect(en).toEqual(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']);
		expect(nl).not.toEqual(en);
		expect(new Set(nl).size, 'two arms resolve to the same word').toBe(4);
	});

	it('⛔ the seeded `many-to-one` reads "veel-op-één" — the raw enum is off the row', async () => {
		// ⚠️ MOUNTED ONCE. `relationRow()` mounts the page into `host`; calling it twice in one test
		// leaves two graphs in the DOM and the node-count marker above (correctly) fails at 4.
		const row = await relationRow();
		expect(squash(row.querySelector('.rel-card')?.textContent)).toBe('veel-op-één');
		// ⛔ THE ASSERTION THAT INVERTS ON A REVERT TO `{r.cardinality}`. Scoped to the row: this is
		// what regressed, and a page-wide sweep would also catch the free-text `placeholder=
		// "many-to-one"` on the Add-relation modal, which is a hint about the WIRE format and is
		// correctly English.
		expect(squash(row.textContent), 'the raw enum is still the row’s visible text').not.toContain(
			'many-to-one'
		);
		// The row's other two chips are untouched — this fix must not spread to them.
		expect(squash(row.textContent)).toContain('ingediend onder');
		expect(squash(row.textContent)).toContain('Schadeclaim');
	});

	it('…and `one-to-many`, the second-commonest seeded value', async () => {
		// One value proves a wire; two prove it is not hardcoded to a single arm.
		cardinality = 'one-to-many';
		expect(await chip()).toBe('één-op-veel');
	});

	it('⛔ AN ADMIN’S OWN FREE TEXT SURVIVES — the column has no enum behind it', async () => {
		// `z.string().max(20)` behind a free-text input. An unknown value rendering blank would be a
		// worse defect than the one being fixed: a chip that exists but says nothing.
		cardinality = '1:N';
		expect(await chip()).toBe('1:N');
	});

	it('AN EMPTY CARDINALITY RENDERS NO CHIP AT ALL — the `{#if}` is load-bearing', async () => {
		// `''` is the ORDINARY value (the column is NOT NULL DEFAULT ''). A fix that dropped the
		// guard would put an empty `<span class="rel-card">` on most rows in the product.
		cardinality = '';
		const row = await relationRow();
		expect(row.querySelector('.rel-card')).toBeNull();
	});
});
