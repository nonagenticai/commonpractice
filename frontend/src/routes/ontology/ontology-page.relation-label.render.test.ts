// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.relation-label.render.test.ts — the /ontology DETAIL PANEL
// names a relation, and both of its ends, in the words the reader was given.
//
// ⛔ THE DEFECT, MEASURED. A Dutch org admin types `hoort bij` into the Add-relation modal's label
// field. It is sent (+page.svelte:511), accepted (`label: z.string().max(120).optional()`,
// backend/src/routes/ontology.ts), stored (ontology-service.ts), and even translation-overlaid for
// a non-en reader (`ONTOLOGY_RELATION_I18N`, pass 3). The panel then rendered:
//
//     {r.from} <span class="rel-pred">{r.predicate}</span> {r.to}
//
// Three raw canonical values on one row — `BrokerNote belongs_to Policy` — six pixels under a
// heading that says `Makelaarsnotitie` and beside a graph card that says `Polis`. The author's
// words were on no screen, and `from`/`to` were the only place in this product that prints an
// entity's canonical NAME where every sibling site prints `entity.label`
// (OntologyEntityNode.svelte:30, +page.svelte's detail heading, the hidden-entity chips).
//
// ⚠️ THE `from`/`to` HALF IS A REAL FINDING AND NOT A DECORATION, but it is worth stating exactly
// what was true when. Before the label fix the row was uniformly canonical English, so it was
// self-consistent and merely untranslated. The label fix makes it MIXED — `BrokerNote hoort bij
// Policy` — which is strictly worse to read than either extreme. So the two halves ship together
// or the first one degrades the row it was fixing.
//
// ⚠️ THE ENTITY `name` IS STILL ON SCREEN, DELIBERATELY, in the detail subtitle
// (+page.svelte: `{selectedEntity.name} · {ontologyScopeLabel(...)}`) — it is the agent-facing
// concept id and its own comment says so. That is why the negatives below are scoped to `.rel-edge`
// and are NOT a page-wide `not.toContain('BrokerNote')`: a guard written that wide would demand the
// deletion of a line this codebase decided on.
//
// ⛔ THE GRAPH EDGE — the other render site of the same one-line rule — is pinned separately by
// `lib/components/ontology/ontology-relation-label.render.test.ts`, because an edge is only DRAWN
// once both endpoint nodes have been measured and jsdom measures nothing. Two sites, two specs,
// named in each other's headers.
//
// ⛔ NOTHING IN `$lib/api/ontology` IS MOCKED. Only `$lib/api/auth-fetch` is, answering real
// `Response` objects, so the compiled graph travels through the client's own `unwrap` exactly as a
// browser's would. Same harness as `ontology-page.translation-erase.render.test.ts`.
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

import Page from './+page.svelte';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The two ends. Their `label` is Dutch because the SERVER localized it (`localizeEntityLabels`);
 *  their `name` is the canonical concept id and can never be Dutch. */
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

/** `label` is the variable under test; everything else is held fixed. */
let relationLabel: string | null | undefined = 'hoort bij';

function relation(): OntologyRelation {
	return {
		id: 'rel-1',
		from: 'BrokerNote',
		to: 'Policy',
		predicate: 'belongs_to',
		label: relationLabel,
		cardinality: 'n:1',
		// Left GLOBAL on purpose: a tenant-owned edge appends a "custom" chip inside `.rel-edge`,
		// and the row's exact text is what this file asserts.
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
		entities: [entity('BrokerNote', 'Makelaarsnotitie'), entity('Policy', 'Polis')],
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
	relationLabel = 'hoort bij';
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
	authFetch.mockReset();
});

/** Mount /ontology, click the `BrokerNote` card, and return its relation row. */
async function relationRow(): Promise<HTMLElement> {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	await settle();
	const nodes = [...host.querySelectorAll('.svelte-flow__node')];
	// ⛔ POSITIVE MARKERS, in order. /ontology mounts SvelteFlow and a dozen panels; without these
	// every "the raw value is gone" assertion below passes for free on a page that never rendered.
	expect(nodes.length, 'the entity graph never rendered — nothing here is reachable').toBe(2);
	const card = nodes.find((n) => n.textContent?.includes('Makelaarsnotitie'));
	expect(card, 'no card is named by the localized entity label the server sent').toBeTruthy();
	click(card!);
	await settle();
	expect(
		squash(host.querySelector('.detail-name')?.textContent),
		'clicking the card did not open ITS detail panel'
	).toContain('Makelaarsnotitie');
	const row = host.querySelector('.rel-row') as HTMLElement | null;
	expect(row, 'the detail panel listed no relation for the selected entity').toBeTruthy();
	return row!;
}

describe('/ontology names a relation in the words its author (or translator) gave it', () => {
	it('⛔ THE DUTCH CASE: `hoort bij` is the text on the row, and `belongs_to` is not', async () => {
		const row = await relationRow();
		expect(squash(row.querySelector('.rel-pred')?.textContent)).toBe('hoort bij');
		// ⛔ THE ASSERTION THAT INVERTS ON A REVERT TO `{r.predicate}` — the exact token that was on
		// the live screen where the author's words should have been. Scoped to the row: the
		// predicate legitimately appears nowhere else on this page, but the row is what regressed.
		expect(
			squash(row.textContent),
			'the canonical predicate is still the row’s visible text'
		).not.toContain('belongs_to');
	});

	it('⛔ …AND BOTH ENDS ARE THE ENTITY LABELS — one row must not mix two vocabularies', async () => {
		const row = await relationRow();
		expect(squash(row.querySelector('.rel-edge')?.textContent)).toBe(
			'Makelaarsnotitie hoort bij Polis'
		);
		// The raw names, scoped to the row. `BrokerNote` is still on the PANEL (the detail subtitle
		// prints it deliberately as the agent-facing concept id) and must stay there.
		const edge = squash(row.querySelector('.rel-edge')?.textContent);
		expect(edge, 'the row still prints the canonical entity name').not.toContain('BrokerNote');
		expect(edge, 'the row still prints the canonical entity name').not.toContain('Policy');
		// Non-vacuity for those two negatives: the name really is on the panel, just not on the row.
		expect(squash(host.querySelector('.detail-sub')?.textContent)).toContain('BrokerNote');
	});

	it('AN EMPTY LABEL FALLS BACK TO THE PREDICATE — `??` would render an empty span', async () => {
		// ⛔ THE ORDINARY CASE, NOT AN EDGE CASE: `ontology_relations.label` is
		// `text NOT NULL DEFAULT ''` and the insert writes `input.label?.trim() ?? ''`, so every
		// relation whose author left the field blank arrives with `''`. Written with `??` the fix
		// would have replaced a wrong word with no word.
		relationLabel = '';
		const row = await relationRow();
		expect(squash(row.querySelector('.rel-pred')?.textContent)).toBe('belongs_to');
		expect(squash(row.querySelector('.rel-edge')?.textContent)).toBe(
			'Makelaarsnotitie belongs_to Polis'
		);
	});

	it('A MISSING LABEL FALLS BACK TOO — an older wire, or a caller that never sent one', async () => {
		relationLabel = null;
		const row = await relationRow();
		expect(squash(row.querySelector('.rel-pred')?.textContent)).toBe('belongs_to');
	});

	it('AN UNRESOLVED END KEEPS ITS OWN NAME — an empty span reads as a bug, a name reads as a name',
		async () => {
			// The panel filters `ontology.relations` client-side; an end that is not in the entity
			// list (a narrower list, a graph mid-refresh) must print the canonical name, the same
			// rule as `ontologyScopeLabel`'s `default:` arm.
			const { ontologyRelationEndLabel } = await import('$lib/i18n/ontology-relation-label');
			expect(ontologyRelationEndLabel('Policy', new Map())).toBe('Policy');
			expect(ontologyRelationEndLabel('Policy', new Map())).not.toBe('');
		});
});
