// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.translation-stale-entity.render.test.ts — entity A's Dutch text,
// under entity B's name, one click away from being written to B's id.
//
// ⛔ THE DEFECT. `openEditEntity()` assigns `editor` (with `id`) SYNCHRONOUSLY and only lands
// `translations = base` AFTER the `await`. The panel's two gates are true immediately: the block
// gate is `editor.mode === 'edit' && editor.id`, and `{#if translations[txLocale]}` is true because
// `translations` still holds the PREVIOUS entity's fully-keyed map. So for the length of the fetch
// the modal shows entity B's name over entity A's Dutch label and description.
//
// ⛔ AND THE SECOND HALF: NOTHING GUARDED THE RESPONSE AGAINST A CHANGED `editor.id`. Open a slow
// entity, switch to a fast one, and the slow reply lands on whatever is on screen — A's translations
// under B, with `txLoaded` set true beside them.
//
// ⛔ THE FIX IS PAIRED WITH A DISABLE, AND THAT PAIRING IS NOT COSMETIC. Hoisting `translations` above
// the await empties the boxes while the fetch is in flight — which, on its own, hands the reader
// exactly the state `ontology-page.translation-erase.render.test.ts` exists to stop: two empty
// fields over a live Save, whose PUT the backend resolves to `deleteTranslation`. So the assertions
// below are on the WIRE (no PUT while loading) as well as on the fields.
//
// ⛔ NOTHING IN `$lib/api/ontology` IS MOCKED — only `$lib/api/auth-fetch`, which HOLDS the chosen
// GET open so the in-flight window is a real one rather than a state variable poked from a test.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { CompiledOntology, MatrixData, OntologyEntity } from '$lib/types/ontology';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

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

import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';

/** Two tenant entities with DELIBERATELY different Dutch text — the whole file turns on telling
 *  them apart in the DOM. */
const A = { id: 'ent-a', name: 'BrokerNote', label: 'Broker note' };
const B = { id: 'ent-b', name: 'ClaimLine', label: 'Claim line' };
const TX: Record<string, { label: string; description: string }> = {
	[A.id]: { label: 'Makelaarsnotitie', description: 'Notitie van de makelaar' },
	[B.id]: { label: 'Schaderegel', description: 'Regel op de schadeclaim' }
};
const txUrl = (id: string) => `/api/ontology/entities/${id}/translations`;

let wire: { method: string; url: string; body: unknown }[] = [];
/** Entity ids whose translations GET is held open until `release(id)`. */
let held: Set<string>;
let releasers: Map<string, () => void>;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function entity(e: { id: string; name: string; label: string }): OntologyEntity {
	return {
		id: e.id,
		key: `industry_dept:Insurance:Claims:${e.name}`,
		name: e.name,
		label: e.label,
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
		entities: [entity(A), entity(B)],
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
const buttonLabelled = (label: string) =>
	[...host.querySelectorAll<HTMLButtonElement>('button')].find(
		(b) => b.textContent?.trim() === label
	);
/** The canonical `name` the modal claims to be editing — the first field in the modal body. */
const editorName = () =>
	(host.querySelector('.modal-body .field input') as HTMLInputElement | null)?.value ?? null;
const txInputs = () => [...host.querySelectorAll<HTMLInputElement>('.tx-block .tx-input')];
const txValues = () => txInputs().map((i) => i.value);
const puts = () => wire.filter((c) => c.method === 'PUT');

/** Resolve the held translations GET for one entity. */
async function release(id: string) {
	const r = releasers.get(id);
	expect(r, `no held request for ${id} — the test's own premise is wrong`).toBeTruthy();
	r!();
	releasers.delete(id);
	await settle();
	await settle();
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	wire = [];
	held = new Set();
	releasers = new Map();
	authFetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = (init.method ?? 'GET').toUpperCase();
		const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		wire.push({ method, url, body });
		for (const id of [A.id, B.id]) {
			if (url !== txUrl(id)) continue;
			if (method === 'PUT') return json({ ok: true });
			const reply = () => json({ translations: { nl: { ...TX[id]! } } });
			if (!held.has(id)) return reply();
			return new Promise<Response>((resolve) => {
				releasers.set(id, () => resolve(reply()));
			});
		}
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

async function mountPage() {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	await settle();
	const nodes = host.querySelectorAll('.svelte-flow__node');
	// ⛔ POSITIVE MARKER. Two nodes, or the whole switching premise below is untested.
	expect(nodes.length, 'the graph did not render both entities').toBe(2);
}

/** Select an entity in the graph and press Edit on its detail panel. */
async function openEditor(e: { name: string; label: string }) {
	const node = [...host.querySelectorAll('.svelte-flow__node')].find((n) =>
		n.textContent?.includes(e.label)
	);
	expect(node, `no graph node for ${e.name}`).toBeTruthy();
	click(node!);
	await settle();
	const edit = buttonLabelled(m.ontology_edit());
	expect(edit, `the detail panel for ${e.name} offered no Edit`).toBeTruthy();
	click(edit!);
	await settle();
}

describe('/ontology never shows one entity’s translations under another’s name', () => {
	it('⛔ THE DEFECT: while B’s translations load, the panel still holds A’s text', async () => {
		await mountPage();
		await openEditor(A);
		await settle();
		expect(editorName(), 'the editor did not open on A').toBe(A.name);
		expect(txValues(), 'A’s translations never loaded — the switch below proves nothing').toEqual([
			TX[A.id]!.label,
			TX[A.id]!.description
		]);

		// Now B, whose GET never answers within this window.
		held.add(B.id);
		await openEditor(B);
		await settle();

		// ⛔ The modal has ALREADY relabelled itself as B. That is the half that makes the stale text
		// a lie rather than a leftover.
		expect(editorName(), 'the editor did not switch to B').toBe(B.name);
		expect(
			txValues(),
			'entity A’s Dutch label and description are on screen under entity B’s name'
		).not.toContain(TX[A.id]!.label);

		// ⛔ AND THE WIRE: whatever is in those boxes, Save must not be able to write it to B's id
		// while the read for B is still in flight — empty boxes plus a live Save is the erase path.
		const save = buttonLabelled(m.ontology_save_translation());
		if (save) {
			expect(save.disabled, 'Save is live over fields nothing has filled for B').toBe(true);
			click(save);
			await settle();
		}
		expect(
			puts(),
			`a save was issued mid-load: ${JSON.stringify(puts().map((p) => [p.url, p.body]))}`
		).toHaveLength(0);

		// …and once B answers, B's own text arrives.
		await release(B.id);
		expect(txValues(), 'B’s translations never landed').toEqual([
			TX[B.id]!.label,
			TX[B.id]!.description
		]);
	});

	it('⛔ A SLOW REPLY FOR A CANNOT LAND ON B — the stale-response guard', async () => {
		await mountPage();
		held.add(A.id);
		await openEditor(A);
		await settle();
		expect(editorName()).toBe(A.name);

		// Switch to B while A is still in flight. B answers immediately.
		await openEditor(B);
		await settle();
		expect(editorName()).toBe(B.name);
		expect(txValues(), 'B’s own translations never loaded').toEqual([
			TX[B.id]!.label,
			TX[B.id]!.description
		]);

		// A's reply finally arrives, addressed to an entity that is no longer on screen.
		await release(A.id);

		expect(
			txValues(),
			'entity A’s reply overwrote entity B’s panel — the next Save writes A’s text to B’s id'
		).toEqual([TX[B.id]!.label, TX[B.id]!.description]);

		// And the save that follows really does carry B's values to B's id.
		const save = buttonLabelled(m.ontology_save_translation());
		expect(save, 'the Save-translation button vanished').toBeTruthy();
		expect(save!.disabled, 'B’s panel is loaded but Save is switched off').toBe(false);
		click(save!);
		await settle();
		expect(puts(), 'the save issued no write').toHaveLength(1);
		expect(puts()[0]!.url).toBe(txUrl(B.id));
		expect(puts()[0]!.body).toEqual({
			locale: 'nl',
			label: TX[B.id]!.label,
			description: TX[B.id]!.description
		});
	});

	it('THE ORDINARY OPEN STILL WORKS — the over-correction guard', async () => {
		// ⛔ Never rendering the fields, or leaving Save disabled forever, passes both cases above.
		await mountPage();
		await openEditor(A);
		await settle();
		expect(txValues()).toEqual([TX[A.id]!.label, TX[A.id]!.description]);
		const save = buttonLabelled(m.ontology_save_translation());
		expect(save!.disabled, 'a healthy open left Save disabled').toBe(false);
		click(save!);
		await settle();
		expect(puts()).toHaveLength(1);
		expect(puts()[0]!.url).toBe(txUrl(A.id));
	});
});
